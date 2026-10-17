"""Persistent multi-stock forward paper ledger, using completed closing prices."""
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Literal
import math
import uuid
import pandas as pd
import exchange_calendars as xc
from pydantic import BaseModel, ConfigDict, Field
from .config import Settings
from .costs import buy_position, settle
from .universe import UniverseProvider, forecast, SIGNAL_THRESHOLD
from .paper_cycles import expiry_day,next_scan_day,upgrade_cycles,cycle_summaries
from copy import deepcopy

SEOUL=ZoneInfo('Asia/Seoul')
KEY='universe_paper'
# 2026-10-17 (user request): a weekly cohort that is stopped out early left the account in cash until the
# next weekly scan. refill_slots() counts the positions closed since the last selection, and the next settlement
# selects that many stocks again (per-position re-entry, buy at the following close) before the weekly scan.
# Stopped stocks are deliberately NOT excluded: in a broad sell-off every signal may fall, and the rules must keep running as-is.


class UniverseSettings(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    capital:float=Field(1000000000,gt=0,le=1e12)
    criterion:Literal['probability','precision']='probability'
    holding_mode:Literal['calendar_days','trading_sessions']='calendar_days'
    buy_fee_pct:float=Field(.015,ge=0,le=5)
    sell_fee_pct:float=Field(.015,ge=0,le=5)
    sell_tax_pct:float=Field(.2,ge=0,le=50)
    slippage_pct:float=Field(.05,ge=0,le=5)

    def costs(self):
        return Settings(**self.model_dump(exclude={'criterion','holding_mode'}),horizon=10,target_pct=5,feature_set='expanded')


class UniversePaperEngine:
    def __init__(self,store,provider,universe=None,predictor=None,*,state_key=KEY,selection_threshold=.6,expected_universe_size=100,selection_filter=None):
        self.store,self.provider=store,provider
        self.key=state_key
        if not math.isfinite(selection_threshold) or not 0<=selection_threshold<=1:
            raise ValueError('선정 확률 기준은 0~1이어야 합니다.')
        self.selection_threshold=selection_threshold
        self.expected_universe_size=expected_universe_size
        # Optional cross-sectional step (e.g. B's multiple-testing filter) applied after every stock is analyzed.
        self.selection_filter=selection_filter
        self.scan_prefix='universe_scan:' if state_key==KEY else state_key+':scan:'
        self.universe=universe or UniverseProvider(store)
        self.predictor=predictor or forecast
        self.calendar=xc.get_calendar('XKRX')
        legacy=self.store.get(self.key)
        archives=[self.store.get(k) for k in self.store.keys(self.scan_prefix)] if legacy and legacy.get('cycle_version')!=1 else []
        with self.store.transaction() as con:
            state=self.store.get(self.key,connection=con)
            if state is not None and upgrade_cycles(state,archives):
                self.store.put(self.key,state,con)

    def status(self,*,include_activity=False):
        cfg=UniverseSettings().model_dump()
        state=self.store.get(self.key,{'enabled':False,'config':cfg,'revision':'initial',
            'cash':cfg['capital'],'positions':{},'pending':{},'orders':[],'trades':[],
            'candidates':[],'equity':[],'scan':None,'errors':[],
            'cycle_version':1,'cycles':[],'weekly_anchor':None,'next_scan_day':None,
            'message':'100종목 분석 후 가상 투자를 시작할 수 있습니다.'})
        state['budget']=state['config']['capital']/100
        state['mark_equity']=state['cash']+sum(p['quantity']*p['last_close'] for p in state['positions'].values())
        state['return_pct']=(state['mark_equity']/state['config']['capital']-1)*100
        if include_activity:
            state['activity']=self.activity_rows(state)
            state['cycle_summary']=cycle_summaries(state)
        return state

    def activity_rows(self,state):
        """Read-only presentation of reservations, open holdings and closed trades."""
        candidates={p['code']:p for p in state['candidates']}
        rows=[]
        for pending in state['pending'].values():
            quote=candidates.get(pending['symbol']['code'],{})
            rows.append({'symbol':pending['symbol'],'status':'reserved',
                'buy_date':pending['execution_day'],
                'sell_date':pending.get('expiry_date') or expiry_day(pending['execution_day'],pending.get('holding_mode','trading_sessions')),
                'cycle_id':pending.get('cycle_id'),
                'quantity':None,'average_price':None,'current_price':pending.get('quote_close',quote.get('close')),
                'price_date':pending.get('quote_date',quote.get('as_of')),'sell_price':None,'profit':None,'return_pct':None})
        for position in state['positions'].values():
            execution=position['last_close']*(1-position['costs']['slippage_pct']/100)
            estimate=settle(position,execution)
            rows.append({'symbol':position['symbol'],'status':'held','buy_date':position['buy_date'],
                'sell_date':position.get('expiry_date') or expiry_day(position['buy_date'],position.get('holding_mode','trading_sessions')),
                'cycle_id':position.get('cycle_id'),
                'quantity':position['quantity'],'average_price':position['entry_price'],
                'current_price':position['last_close'],'price_date':position['last_price_date'],
                'sell_price':None,'profit':estimate['profit'],'return_pct':estimate['net_return_pct']})
        for trade in reversed(state['trades']):
            rows.append({'symbol':trade['symbol'],'status':'sold','buy_date':trade['buy_date'],
                'cycle_id':trade.get('cycle_id'),
                'sell_date':trade['sell_date'],'quantity':trade['quantity'],
                'average_price':trade['entry_price'],'current_price':None,'price_date':None,
                'sell_price':trade['sell_price'],'profit':trade['profit'],'return_pct':trade['net_return_pct']})
        return rows

    def configure(self,values,enabled):
        config=UniverseSettings(**values).model_dump()
        with self.store.transaction() as con:
            state=self.store.get(self.key,self.status(),con)
            if config['capital']!=state['config']['capital'] and (state['positions'] or state['trades']):
                raise ValueError('체결 이후에는 초기자금을 바꿀 수 없습니다. 보유와 거래 기록을 보존합니다.')
            changed=state['config']!=config or state['enabled']!=enabled
            if changed:
                for order in state['orders']:
                    if order['status']=='reserved':
                        order['status']='cancelled'
                state['pending']={}
                state['revision']=uuid.uuid4().hex
                if not state['positions'] and not state['trades']:
                    state['cash']=config['capital']
            state.update(config=config,enabled=enabled)
            state['message']=f'신규 매수 켜짐: {self.expected_universe_size}종목 분석으로 다음 거래일 종가 매수를 예약합니다.' if enabled else '신규 매수 중지. 기존 보유분의 종가 손절·익절·만기 정산은 계속합니다.'
            self.store.put(self.key,state,con)
        return self.status()

    def completed_day(self,now=None):
        now=now or datetime.now(SEOUL)
        day=pd.Timestamp(now.date())
        if now.hour<18:
            day-=pd.Timedelta(days=1)
        return str(self.calendar.date_to_session(day,direction='previous').date())

    def _prices(self,code,day):
        raw,meta=self.provider.original_prices(code,'KR')
        if meta.get('from_cache') or meta.get('source') in {'원본 가격 캐시','가격 캐시'}:
            raise ValueError('캐시는 장중 저장되었을 수 있어 완료 종가를 확인할 수 없습니다. 신규 조회 후 다시 정산하세요.')
        raw=raw.loc[raw.index<=pd.Timestamp(day)].sort_index()
        if raw.empty or str(raw.index[-1].date())!=day:
            raise ValueError(f'{day} 완료 일봉이 없습니다. 이전 가격으로 체결하지 않습니다.')
        row=raw.iloc[-1]
        if not math.isfinite(float(row.Close)) or row.Close<=0 or not math.isfinite(float(row.Volume)) or row.Volume<=0:
            raise ValueError('거래 가능한 종가·거래량이 없습니다.')
        return raw,meta

    def refill_slots(self,day):
        """Positions closed since the last selection, before the next weekly scan: each frees one slot."""
        state=self.status()
        cycles=state.get('cycles') or []
        if not (state['enabled'] and state.get('next_scan_day') and day<state['next_scan_day'] and cycles):
            return 0
        since=cycles[-1]['signal_date']
        return sum(since<t['sell_date']<=day for t in state['trades'])

    def refill_due(self,day):
        return self.refill_slots(day)>0

    def scan(self,day=None,progress=None,refill=False,max_new=None):
        day=day or self.completed_day()
        progress=progress or (lambda percent,message:None)
        if not self.calendar.is_session(day):
            raise ValueError('한국 거래일을 선택하세요.')
        snapshot=self.status()
        if snapshot['enabled'] and snapshot.get('next_scan_day') and day<snapshot['next_scan_day'] and not refill:
            message='이번 차수는 이미 선정했습니다 · 새 주가 조회·재학습 생략 · 다음 재계산 '+snapshot['next_scan_day']
            progress(100,message)
            return {**snapshot,'scan_execution':{'status':'skipped','reason':'already_selected',
                    'next_scan_day':snapshot['next_scan_day'],'message':message}}
        progress(1,f'분석 대상 {self.expected_universe_size}종목 목록 확인')
        universe=self.universe.snapshot()
        if universe.get('cached'):
            raise ValueError(universe['warning'])
        rows=universe['rows']
        count=self.expected_universe_size
        if count<1 or len(rows)!=count or len({r['code'] for r in rows})!=count:
            raise ValueError(f'서로 다른 {count}종목이 필요합니다.')
        config=UniverseSettings(**snapshot['config'])
        candidates=[]
        execution_day=str(self.calendar.next_session(day).date())
        for i,symbol in enumerate(rows):
            # Configuration/pausing during a long scan must not create old orders.
            if self.status()['revision']!=snapshot['revision']:
                return self.status()
            item={**symbol,'as_of':day,'eligible':False,'score':None,'probability':None,'precision':None,'error':None}
            try:
                step=2+int(i*96/count)
                label=f"{i+1}/{count} · {symbol['name']} ({symbol['code']})"
                progress(step,label+' · 완료 일봉 조회')
                raw,meta=self._prices(symbol['code'],day)
                progress(step,label+' · 지표 계산·모델 학습')
                prediction=self.predictor(raw,config.criterion)
                if prediction.get('as_of')!=day:
                    raise ValueError('예측 날짜와 완료 일봉 날짜가 다릅니다.')
                score=prediction.get('probability' if config.criterion=='probability' else 'precision')
                if score is None or not math.isfinite(float(score)) or not 0<=float(score)<=1:
                    raise ValueError('유효한 확률/적중률을 계산하지 못했습니다.')
                eligible=float(score)>=self.selection_threshold and (config.criterion=='probability' or prediction.get('signal')==1) and prediction.get('entry_allowed',True)
                item.update(prediction,close=float(raw.Close.iloc[-1]),score=float(score),eligible=eligible,source=meta)
                try:
                    buy_position(config.capital/100,item['close'],config.costs())
                    item['affordable']=True
                except ValueError:
                    item['affordable']=False
                item['status']='매수 후보' if eligible and item['affordable'] else ('1주 예산 부족' if eligible else '기준 미달')
            except Exception as exc:
                item.update(error=str(exc),status='분석 제외')
            candidates.append(item)
            progress(2+int((i+1)*96/count),f"{i+1}/{count} · {symbol['name']} · {item['status']}")
        if self.selection_filter:
            self.selection_filter(candidates)
        with self.store.transaction() as con:
            state=self.store.get(self.key,self.status(),con)
            if state['revision']!=snapshot['revision']:
                return self.status()
            if state['enabled'] and state.get('next_scan_day') and day<state['next_scan_day'] and not refill:
                return self.status()
            identifier=len(state.get('cycles',[]))+1 if state['enabled'] else None
            analysis_errors=sum(c['status']=='분석 제외' for c in candidates)
            for candidate in candidates:
                if candidate['eligible'] and candidate.get('affordable') and (
                        candidate['code'] in state['positions'] or candidate['code'] in state['pending']):
                    candidate['status']='중복 제외'
                    candidate['error']='이전 차수에서 보유 또는 매수 예약 중'
                candidate['cycle_id']=identifier
            state['candidates']=candidates
            state['scan']={'as_of':day,'execution_day':execution_day,'criterion':config.criterion,
                'selection_threshold':self.selection_threshold,
                'signal_threshold':SIGNAL_THRESHOLD if config.criterion=='precision' else None,
                'universe':universe,'analyzed':len(candidates)-analysis_errors,
                'errors':analysis_errors,
                'eligible':sum(c['eligible'] for c in candidates),'created_at':datetime.now(SEOUL).isoformat()}
            if state['enabled']:
                available_cash=state['cash']-sum(p['config']['capital']/100 for p in state['pending'].values())
                reserved=0
                for candidate in sorted(candidates,key=lambda c:-(c['score'] or 0)):
                    code=candidate['code']
                    if candidate['status']=='매수 후보':
                        if max_new is not None and reserved>=max_new:
                            candidate['status']='재진입 슬롯 초과'
                            candidate['error']=f'청산으로 풀린 {max_new}종목 자금만 재진입'
                            continue
                        budget=config.capital/100
                        if available_cash+1e-6<budget:
                            candidate['status']='가용 현금 부족'
                            candidate['error']='기존 매수 예약의 예산을 제외한 가용 현금 부족'
                            continue
                        state['pending'][code]={'symbol':{k:candidate[k] for k in ['code','name','market','exchange','rank']},
                            'signal_date':day,'execution_day':execution_day,'score':candidate['score'],
                            'criterion':config.criterion,'config':config.model_dump(),'cycle_id':identifier,
                            'holding_mode':config.holding_mode,'expiry_date':expiry_day(execution_day,config.holding_mode),
                            'quote_close':candidate['close'],'quote_date':day}
                        state['orders'].append({'code':code,'name':candidate['name'],'signal_date':day,
                            'day':execution_day,'type':'BUY_NEXT_CLOSE','status':'reserved','cycle_id':identifier})
                        available_cash-=budget
                        reserved+=1
                cycle={'id':identifier,'signal_date':day,'execution_day':execution_day,
                    'expiry_date':expiry_day(execution_day,config.holding_mode),'criterion':config.criterion,
                    'config':config.model_dump(),'candidates':deepcopy(candidates),
                    'reserved_count':sum(p.get('cycle_id')==identifier for p in state['pending'].values()),
                    'skipped_duplicate_count':sum(c['status']=='중복 제외' for c in candidates)}
                if refill:cycle.update(refill=True,reentry_slots=max_new)
                state.setdefault('cycles',[]).append(cycle)
                state['weekly_anchor']=state.get('weekly_anchor') or execution_day
                state['next_scan_day']=next_scan_day(state['weekly_anchor'],day)
            state['message']=(f'종목별 재진입 · 풀린 자금 {max_new}종목 · ' if refill and max_new is not None else '재선정 · ' if refill else '')+f"{day} · {state['scan']['analyzed']}/{count} 분석 완료 · 기준 통과 {state['scan']['eligible']} · 제외 {state['scan']['errors']} · 다음 거래일 {execution_day}"
            self.store.put(self.scan_prefix+day+':'+state['revision'],{'scan':state['scan'],'candidates':candidates},con)
            self.store.put(self.key,state,con)
        return {**self.status(),'scan_execution':{'status':'completed','message':state['message']}}

    def reconcile(self,day=None,progress=None):
        day=day or self.completed_day()
        progress=progress or (lambda percent,message:None)
        if not self.calendar.is_session(day):
            return self.status()
        snapshot=self.status()
        symbols={**{code:p['symbol'] for code,p in snapshot['positions'].items()},
                 **{code:p['symbol'] for code,p in snapshot['pending'].items() if p['execution_day']==day}}
        quotes,errors={},[]
        for i,(code,symbol) in enumerate(symbols.items()):
            try:
                raw,meta=self._prices(code,day)
                quotes[code]=float(raw.Close.iloc[-1])
            except Exception as exc:
                errors.append({'code':code,'name':symbol['name'],'error':str(exc)})
            progress(int((i+1)*95/max(1,len(symbols))),f"종가 정산 {i+1}/{len(symbols)} · {symbol['name']}")
        with self.store.transaction() as con:
            state=self.store.get(self.key,self.status(),con)
            sold=set()
            for code,position in list(state['positions'].items()):
                if code not in quotes or position['buy_date']>=day or position.get('last_processed_day','')>=day:
                    continue
                close=quotes[code]
                elapsed=len(self.calendar.sessions_in_range(position['buy_date'],day))-1
                change=(close/position['entry_close']-1)*100
                position.update(last_close=close,last_price_date=day,holding_days=elapsed,last_processed_day=day)
                expiry=position.get('expiry_date') or expiry_day(position['buy_date'],position.get('holding_mode','trading_sessions'))
                reason='stop_loss' if change<=-3 else 'take_profit' if change>=5 else 'expiry' if day>=expiry else None
                if reason:
                    costs=Settings(**position['costs'])
                    execution=close*(1-costs.slippage_pct/100)
                    settlement=settle(position,execution)
                    # Unspent entry allocation is already in global account cash.
                    state['cash']+=settlement['cash']-position['cash_left']
                    state['trades'].append({**position,**settlement,'sell_date':day,'sell_close':close,
                        'sell_price':execution,'reason':reason,'close_return_pct':change,'cash_after':state['cash']})
                    state['orders'].append({'code':code,'name':position['symbol']['name'],'day':day,
                        'type':'SELL_CLOSE','status':'filled','reason':reason,'price':execution,'cycle_id':position.get('cycle_id')})
                    del state['positions'][code]
                    sold.add(code)
            for code,pending in list(state['pending'].items()):
                due=pending['execution_day']
                if due>day:
                    continue
                status=None
                if due<day:
                    status='expired'
                elif not state['enabled']:
                    status='cancelled'
                elif code in quotes and code not in state['positions'] and code not in sold:
                    cfg=UniverseSettings(**pending['config'])
                    budget=cfg.capital/100
                    if state['cash']+1e-6<budget:
                        status='insufficient_cash'
                    else:
                        try:
                            position=buy_position(budget,quotes[code],cfg.costs())
                        except ValueError:
                            status='unaffordable'
                        else:
                            position.update(symbol=pending['symbol'],buy_date=day,entry_close=quotes[code],
                                last_close=quotes[code],last_price_date=day,holding_days=0,last_processed_day=day,
                                signal_date=pending['signal_date'],score=pending['score'],criterion=pending['criterion'])
                            position.update(cycle_id=pending.get('cycle_id'),holding_mode=pending.get('holding_mode',cfg.holding_mode),
                                expiry_date=pending.get('expiry_date') or expiry_day(day,cfg.holding_mode))
                            state['cash']-=budget-position['cash_left']
                            state['positions'][code]=position
                            status='filled'
                if status:
                    for order in reversed(state['orders']):
                        if order['code']==code and order['day']==due and order['status']=='reserved':
                            order['status']=status
                            if status=='filled':
                                order['price']=state['positions'][code]['entry_price']
                            break
                    del state['pending'][code]
            state['errors']=errors
            equity=state['cash']+sum(p['quantity']*p['last_close'] for p in state['positions'].values())
            point={'date':day,'value':equity,'cash':state['cash'],'positions':len(state['positions']),
                   'stale_positions':sum(p['last_price_date']!=day for p in state['positions'].values())}
            state['equity']=[p for p in state['equity'] if p['date']!=day]+[point]
            state['message']=f"{day} 정산 · 보유 {len(state['positions'])}종목 · 누적 청산 {len(state['trades'])} · 가격 누락 {len(errors)}"
            self.store.put(self.key,state,con)
        return self.status()

    def daily(self,progress=None):
        day=self.completed_day()
        self.reconcile(day,progress)
        state=self.status()
        if state['enabled'] and (not state.get('next_scan_day') or day>=state['next_scan_day']):
            return self.scan(day,progress)
        return self.status()
