import numpy as np
import pandas as pd
from decimal import Decimal,ROUND_FLOOR
from .costs import buy_position


def convert_currency_prices(closes,symbols,currency,rates):
    """Use only historical FX observations available on or before each price date."""
    if currency not in ('KRW','USD'):raise ValueError('지원하지 않는 기준 통화입니다.')
    if rates.empty or 'Close' not in rates:raise ValueError('환율 자료가 없습니다.')
    fx=rates.Close.sort_index()
    if not isinstance(fx.index,pd.DatetimeIndex) or fx.index.has_duplicates or fx.index.isna().any():
        raise ValueError('환율 날짜가 잘못되었습니다.')
    if not np.isfinite(fx.to_numpy()).all() or (fx<=0).any():raise ValueError('환율은 유효한 양수여야 합니다.')
    matched=fx.reindex(closes.index,method='ffill')
    observed=pd.Series(fx.index,index=fx.index).reindex(closes.index,method='ffill')
    if matched.isna().any() or ((closes.index-observed)>pd.Timedelta(days=7)).any():
        raise ValueError('동일 날짜 또는 7일 이내 과거 환율이 필요합니다. 미래 환율로 채울 수 없습니다.')
    converted=closes.copy()
    for symbol in symbols:
        label=symbol['name']+' ('+symbol['code']+')'
        if currency=='KRW' and symbol['market']=='US':converted[label]*=matched
        elif currency=='USD' and symbol['market']=='KR':converted[label]/=matched
    return converted,{'pair':'USD/KRW','rate':float(matched.iloc[-1]),
        'date':str(observed.iloc[-1].date()),'price_date':str(closes.index[-1].date()),
        'note':'일별 환율 변동 반영 · 미래 환율 사용 없음 · 환전 수수료 제외'}


def weight_limits(count,minimum,maximum):
    if not np.isfinite([minimum,maximum]).all() or not 0<=minimum<=maximum<=1:
        raise ValueError('최소·최대 비중은 0~100%이며 최소가 최대보다 클 수 없습니다.')
    upper=.5 if count==2 and maximum<.5 else maximum
    if count*minimum>1+1e-12 or count*upper<1-1e-12:
        raise ValueError('선택한 종목 수와 최소·최대 비중으로 합계 100%를 만들 수 없습니다.')
    return minimum,upper


def bounded_weights(weights,minimum,maximum):
    """Project independent random proposals onto the bounded unit simplex."""
    count=weights.shape[1]
    if abs(count*minimum-1)<=1e-12 or abs(count*maximum-1)<=1e-12:
        return np.full_like(weights,1/count)
    low=(weights-maximum).min(axis=1);high=(weights-minimum).max(axis=1)
    for _ in range(60):
        midpoint=(low+high)/2
        above=np.clip(weights-midpoint[:,None],minimum,maximum).sum(axis=1)>1
        low=np.where(above,midpoint,low);high=np.where(above,high,midpoint)
    return np.clip(weights-((low+high)/2)[:,None],minimum,maximum)


def optimize_weights(close_table, simulations=20000, seed=42, risk_free=.02,
                     min_weight=0,max_weight=1):
    if not 2<=close_table.shape[1]<=10 or not 100<=simulations<=100000:
        raise ValueError('종목 2~10개와 시뮬레이션 100~100000회가 필요합니다.')
    minimum,maximum=weight_limits(close_table.shape[1],min_weight,max_weight)
    df=close_table.dropna()
    if len(df)<60 or not np.isfinite(df.to_numpy()).all() or (df<=0).any().any():
        raise ValueError('동일 날짜의 유효 종가 60개 이상 필요합니다.')
    returns=df.pct_change(fill_method=None).dropna()
    if (returns.std()<=1e-12).any():
        raise ValueError('가격 변동이 없는 종목은 위험 계산에서 제외하세요.')
    mean=returns.mean().to_numpy()*252
    cov=returns.cov().to_numpy()*252
    rng=np.random.default_rng(seed)
    weights=rng.random((simulations,df.shape[1]))
    weights/=weights.sum(axis=1,keepdims=True)
    if minimum>0 or maximum<1:
        weights=bounded_weights(weights,minimum,maximum)
    expected=weights@mean
    volatility=np.sqrt(np.maximum(np.einsum('ij,jk,ik->i',weights,cov,weights),0))
    sharpe=np.divide(expected-risk_free,volatility,out=np.full(simulations,-np.inf),where=volatility>1e-12)
    best=int(np.argmax(sharpe))
    if not np.isfinite(sharpe[best]):
        raise ValueError('포트폴리오 위험 계산이 불가능합니다.')
    return {'weights':{str(c):float(w) for c,w in zip(df.columns,weights[best])},
            'annual_return':float(expected[best]),'annual_volatility':float(volatility[best]),
            'sharpe':float(sharpe[best]),'samples':simulations,'seed':seed,
            'common_rows':len(df),'risk_free':risk_free,
            'constraints':{'min_weight_pct':min_weight*100,'max_weight_pct':max_weight*100,
                           'effective_max_weight_pct':maximum*100},
            'note':'표본 중 최대 샤프 비중이며 전역 최적 또는 미래 수익 보장이 아닙니다.'}


def half_kelly_fraction(returns):
    """Size a fixed stock basket by empirical log growth, without leverage."""
    values=np.asarray(returns,dtype=float)
    if values.ndim!=1 or not len(values) or not np.isfinite(values).all() or (values<=-1).any():
        raise ValueError('켈리 계산에는 -100% 초과의 유효 수익률 자료가 필요합니다.')
    def slope(fraction):return float(np.mean(values/(1+fraction*values)))
    if slope(0)<=0:full=0.
    elif slope(1)>=0:full=1.
    else:
        low,high=0.,1.
        for _ in range(60):
            middle=(low+high)/2
            if slope(middle)>0:low=middle
            else:high=middle
        full=(low+high)/2
    half=full*.5
    return {'method':'historical-basket-log-growth','full_fraction':full,'half_fraction':half,
            'observations':len(values),'win_rate':float(np.mean(values>0)),
            'full_log_growth':float(np.mean(np.log1p(full*values))),
            'half_log_growth':float(np.mean(np.log1p(half*values))),
            'note':'선정된 주식 조합의 과거 일별 수익률로 로그 성장률을 최대화한 투자 비율을 추정합니다(일별 고정 비중 가정). '
                    '레버리지 없이 풀 켈리 0~100%의 절반만 투자하고 나머지는 현금으로 유지합니다. '
                    '매매 비용과 현금 이자는 켈리 추정에 반영하지 않습니다.'}


def kelly(probability, payoff, loss=None):
    if not 0<=probability<=1 or payoff<=0 or (loss is not None and loss<=0):
        raise ValueError('승률 0~1, 이익/손실 비율은 양수여야 합니다.')
    return probability-(1-probability)/payoff if loss is None else probability/loss-(1-probability)/payoff


def allocation_plan(weights,closes,symbols,capital,costs,currency=None):
    """Convert target weights into whole shares without exceeding each allocation."""
    currency=currency or ('KRW' if symbols[0]['market']=='KR' else 'USD')
    remaining=Decimal(str(capital));unit=Decimal('1') if currency=='KRW' else Decimal('.01')
    rows=[]
    for index,symbol in enumerate(symbols):
        label=symbol['name']+' ('+symbol['code']+')'
        amount=(Decimal(str(capital))*Decimal(str(weights[label]))).quantize(unit,rounding=ROUND_FLOOR)
        if index==len(symbols)-1:amount=remaining
        remaining-=amount
        price=float(closes[label])
        exact_entry=Decimal(str(price))*(1+Decimal(str(costs.slippage_pct))/100)
        entry=float(exact_entry)
        if amount<exact_entry*(1+Decimal(str(costs.buy_fee_pct))/100):
            position={'quantity':0,'entry_price':entry,'buy_fee':0,'cash_left':float(amount)}
        else:
            position=buy_position(float(amount),price,costs,symbol['market'])
        rows.append({'symbol':symbol,'weight':weights[label],'allocation':float(amount),'close':price,
            'entry_price':position['entry_price'],'quantity':position['quantity'],'buy_fee':position['buy_fee'],
            'purchase_cost':float(amount)-position['cash_left'],'cash_left':position['cash_left']})
    return rows
