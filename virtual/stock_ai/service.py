from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import uuid
import threading
from .original_analysis import analyze
from .config import Settings
from .data import read_original_csv
from .simulation import simulate
from .reports import save_report
from .portfolio import optimize_weights,allocation_plan
from .symbols import SAMSUNG_FIVE
import pandas as pd
from decimal import Decimal,ROUND_FLOOR
from .portfolio import half_kelly_fraction,weight_limits,convert_currency_prices
      

class JobService:
    def __init__(self,store):
        self.store=store
        self.lock=threading.RLock()
        self.closed=False
        self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='stock-ai')
        for key in store.keys('job:'):
            job=store.get(key)
            if job['status'] in ['queued','running']:
                job.update({'status':'failed','error':'서버 재시작으로 작업이 중단되었습니다. 다시 실행하세요.'})
                store.put(key,job)

    def submit(self,kind,operation,request=None):
        with self.lock:
            if self.closed:
                raise ValueError('작업 서비스가 종료되었습니다.')
            return self._submit(kind,operation,request)

    def _submit(self,kind,operation,request=None):
        active=[self.store.get(k) for k in self.store.keys('job:')]
        if sum(j['status'] in ['queued','running'] for j in active)>=3:
            raise ValueError('진행 중인 작업이 많습니다. 완료 후 다시 실행하세요.')
        identifier=uuid.uuid4().hex
        job={'id':identifier,'kind':kind,'status':'queued','progress':0,'message':'대기 중',
             'created_at':datetime.now(timezone.utc).isoformat(),'result':None,'error':None}
        if request is not None:
            job['request']=request
        self.store.put('job:'+identifier,job)
        def update(percent,message):
            current=self.get(identifier)
            current.update({'status':'running','progress':percent,'message':message})
            self.store.put('job:'+identifier,current)
        def run():
            try:
                update(1,'작업 시작')
                result=operation(update)
                current=self.get(identifier)
                current.update({'status':'done','progress':100,'message':'완료','result':result})
            except Exception as exc:
                current=self.get(identifier)
                current.update({'status':'failed','error':str(exc),'message':'작업 실패'})
            self.store.put('job:'+identifier,current)
        self.pool.submit(run)
        return identifier

    def get(self,identifier):
        return self.store.get('job:'+identifier)

    def close(self):
        with self.lock:
            self.closed=True
            self.pool.shutdown(wait=False,cancel_futures=True)


def analysis_job(payload,provider,report_dir,identifier,progress):
    settings=Settings(**payload.get('settings',{}))
    symbol=payload['symbol']
    if payload.get('csv'):
        prices=read_original_csv(payload['csv'])
        meta={'source':'사용자 CSV','last_date':str(prices.index[-1].date()),
              'warning':prices.attrs.get('price_warning')}
    else:
        progress(2,'과거 주가 조회')
        prices,meta=original_input(provider,symbol,settings)
    market=None
    if settings.feature_set=='expanded':
        market,market_meta=market_input(provider,symbol,settings)
        meta['market_data']=market_meta
    return analyze_prices(prices,settings,symbol,market,meta,report_dir,identifier,progress)


def original_input(provider,symbol,settings):
    if hasattr(provider,'original_prices'):
        return provider.original_prices(symbol['code'],symbol['market'])
    return provider.prices(symbol['code'],settings.years,symbol['market'])


def market_input(provider,symbol,settings):
    code='KS11' if symbol['market']=='KR' else 'S&P500'
    try:
        frame,meta=original_input(provider,{**symbol,'code':code},settings)
        return frame,{**meta,'code':code}
    except Exception as exc:
        return None,{'code':code,'warning':f'시장 지수 조회 실패: {exc}'}


def analyze_prices(prices,settings,symbol,market,meta,report_dir,identifier,progress):
    result=analyze(prices,settings,market=market,progress=progress,compare=True,symbol=symbol)
    result['data_source']=meta
    window=result.get('analysis_window')
    simulation_prices=prices.loc[(prices.index>=pd.Timestamp(window['cutoff'])) &
                                 (prices.index<=pd.Timestamp(window['end']))] if window else prices
    result['simulations']={mode:simulate(simulation_prices,result['predictions'],settings,mode,symbol['market'])
                           for mode in ['touch','buffer','stress']}
    if market is None and result.get('analysis_method') != 'original-close-v1':
        result['warnings'].append('시장 지수 입력이 없어 47특성 별도 구성으로 분석했습니다.')
    if meta.get('warning'):
        result['warnings'].append(meta['warning'])
    if (meta.get('market_data') or {}).get('warning'):
        result['warnings'].append(meta['market_data']['warning'])
    try:
        result['report_id']=identifier
        save_report(result,report_dir,identifier)
    except OSError as exc:
        result['warnings'].append(f'보고서 저장 실패: {exc}')
    return result


def batch_job(settings,provider,report_dir,identifier,progress):
    loaded, errors = [], []
    for i, symbol in enumerate(SAMSUNG_FIVE):
        progress(i*4, symbol['name']+': 완료 일봉 조회')
        try:
            prices, meta = original_input(provider,symbol,settings)
            loaded.append((symbol, prices, meta))
        except Exception as exc:
            errors.append({'symbol':symbol,'error':str(exc)})
    common = loaded[0][1].index if loaded else pd.DatetimeIndex([])
    for _, prices, _ in loaded[1:]:
        common = common.intersection(prices.index)
    common = common.sort_values()
    window = ({'start':str(common[0].date()),'end':str(common[-1].date()),'rows':len(common)}
              if len(common) else None)
    market = None
    market_meta=None
    if loaded and settings.feature_set=='expanded':
        market,market_meta=market_input(provider,loaded[0][0],settings)
    results = []
    for i, (symbol, prices, meta) in enumerate(loaded):
        try:
            if not window and not hasattr(provider,'original_prices'):
                raise ValueError('비교할 공통 거래일이 없습니다.')
            original = hasattr(provider,'original_prices')
            result = analyze_prices(prices if original else prices.loc[common], settings, symbol, market,
                                    {**meta,'market_data':market_meta,'comparison_window':None if original else window}, report_dir,
                                    identifier+'_'+symbol['code'],
                                    lambda p,m,i=i:progress(20+int((i*100+p)*80/(len(loaded)*100)),symbol['name']+': '+m))
            results.append(result)
        except Exception as exc:
            errors.append({'symbol':symbol,'error':str(exc)})
    ranking = sorted(results,key=lambda result:result.get('mean_precision',result.get('latest_probability',0)),reverse=True)
    return {'ranking':ranking,'errors':errors,'settings':settings.model_dump(),
            'comparison_window':None if hasattr(provider,'original_prices') else window,'comparison_complete':len(ranking)==len(SAMSUNG_FIVE),
            'comparable_as_of':len(ranking)>=2 and len({result['as_of'] for result in ranking})==1,
            'note':'최근 5년의 검증 구간 평균 적중률 순서입니다. 종목별 조회 기준일과 결측에 따라 평가 날짜와 표본 수가 다를 수 있습니다. 누락 종목은 오류로 표시합니다.'}


def portfolio_job(payload,provider,progress):
    symbols=payload['symbols']
    currency=payload.get('currency') or ('USD' if all(s['market']=='US' for s in symbols) else 'KRW')
    if currency not in ('KRW','USD'):raise ValueError('지원하지 않는 기준 통화입니다.')
    if len({(s['market'],s['code'].upper()) for s in symbols})!=len(symbols):
        raise ValueError('중복 종목을 제거하세요.')
    min_weight=payload.get('min_weight_pct',5)/100
    max_weight=payload.get('max_weight_pct',40)/100
    weight_limits(len(symbols),min_weight,max_weight)
    series=[];warnings=[]
    for i,symbol in enumerate(symbols):
        progress(int(i/len(symbols)*80),'종가 조회: '+symbol['name'])
        df,meta=provider.prices(symbol['code'],payload.get('years',5),symbol['market'])
        if meta.get('warning'):warnings.append(symbol['name']+': '+meta['warning'])
        series.append(df.Close.rename(symbol['name']+' ('+symbol['code']+')'))
    closes=pd.concat(series,axis=1).dropna().sort_index()
    if not closes.empty:
        cutoff=closes.index[-1]-pd.DateOffset(years=payload.get('years',5))
        closes=closes.loc[closes.index>=cutoff]
    native_closes=closes.copy();exchange_rate=None
    if not closes.empty and any(('KRW' if s['market']=='KR' else 'USD')!=currency for s in symbols):
        progress(82,'환율 조회 및 일별 기준 통화 환산')
        rates,meta=provider.exchange_rates(payload.get('years',5))
        if meta.get('warning'):warnings.append(meta['warning'])
        closes,exchange_rate=convert_currency_prices(closes,symbols,currency,rates)
        exchange_rate['source']=meta.get('source','')
    progress(85,'공통 거래일로 20,000개 비중 조합 비교')
    result=optimize_weights(closes,seed=42,min_weight=min_weight,max_weight=max_weight)
    mix_weights=result['weights'].copy()
    basket=closes.pct_change(fill_method=None).dropna().to_numpy() @ list(mix_weights.values())
    sizing=half_kelly_fraction(basket)
    fraction=sizing['half_fraction']
    basket_metrics={key:result[key] for key in ('annual_return','annual_volatility','sharpe')}
    result['weights']={key:value*fraction for key,value in mix_weights.items()}
    result['annual_return']*=fraction;result['annual_volatility']*=fraction
    result['sharpe']=((result['annual_return']-result['risk_free'])/result['annual_volatility']
                      if result['annual_volatility']>1e-12 else None)
    capital=payload.get('capital',100000000)
    costs=Settings(capital=capital,buy_fee_pct=payload.get('buy_fee_pct',.015),
                   slippage_pct=payload.get('slippage_pct',.05))
    unit=Decimal('1') if currency=='KRW' else Decimal('.01')
    invested=(Decimal(str(capital))*Decimal(str(fraction))).quantize(unit,rounding=ROUND_FLOOR)
    reserve=float(Decimal(str(capital))-invested)
    allocations=allocation_plan(mix_weights,closes.iloc[-1],symbols,float(invested),costs,currency)
    for row in allocations:
        label=row['symbol']['name']+' ('+row['symbol']['code']+')'
        row['native_close']=float(native_closes[label].iloc[-1])
        row['quote_currency']='KRW' if row['symbol']['market']=='KR' else 'USD'
        row['mix_weight']=row['weight'];row['weight']*=fraction
        if not row['quantity']:warnings.append(row['symbol']['name']+': 배정 예산이 1주 가격보다 작아 현금으로 유지합니다.')
    if fraction==0:warnings.append('선정 조합의 과거 평균 수익률이 양수가 아니어서 하프 켈리 투자액은 0이며 전액 현금입니다.')
    result.update(allocations=allocations,capital=capital,currency=currency,exchange_rate=exchange_rate,
        symbols=symbols,start=str(closes.index[0].date()),as_of=str(closes.index[-1].date()),warnings=warnings,
        total_purchase_cost=sum(r['purchase_cost'] for r in allocations),
          remaining_cash=reserve+sum(r['cash_left'] for r in allocations),reserve_cash=reserve,
          cash_weight=1-fraction,sizing=sizing,mix_weights=mix_weights,basket_metrics=basket_metrics,
          portfolio_strategy='half-kelly-v1',
          settings={'years':payload.get('years',5),'capital':capital,'buy_fee_pct':costs.buy_fee_pct,
                    'currency':currency,
                    'slippage_pct':costs.slippage_pct,'min_weight_pct':min_weight*100,'max_weight_pct':max_weight*100})
    return result
