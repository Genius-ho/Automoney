"""Strategy C: equal-weight diversified book on the fixed B universe, rebalanced weekly.

Chosen by the 2026-10-12 research (docs/verification/2026-10-12/strategy-c): seven price
factors and twelve overlay/selection variants were tested on 2016-2026 weekly data with costs;
none beat the equal-weight book on both Sharpe and drawdown in both halves, so the
pre-declared fallback (equal weight) is used. It also serves as the A/B benchmark.

Rules: signal on a completed close; stocks with >= 260 sessions of history, a valid close and
volume on that day, and 20-day traded value outside the bottom 20% are held at equal weight.
Rebalance trades execute at the next session close (sells first), integer shares, with the
same fee/tax/slippage settings as A and B.
"""
from copy import deepcopy
from datetime import datetime
import math
import uuid
import numpy as np
import pandas as pd
from .paper_cycles import CALENDAR, next_scan_day
from .universe_paper import SEOUL, UniverseSettings

KEY='strategy_c_paper'
METHOD='equal-weight-351-weekly-v1'
MIN_HISTORY=260
LIQUIDITY_CUT=.2


def eligible_weights(frames,day):
    """frames: code -> completed daily bars (index <= day). Returns weights and per-code reasons."""
    stats={};reasons={}
    for code,raw in frames.items():
        if raw is None or raw.empty:
            reasons[code]='가격 없음';continue
        bars=raw.loc[raw.index<=pd.Timestamp(day)]
        if bars.empty or str(bars.index[-1].date())!=day:
            reasons[code]='기준일 일봉 없음';continue
        last=bars.iloc[-1]
        if not (math.isfinite(float(last.Close)) and last.Close>0 and math.isfinite(float(last.Volume)) and last.Volume>0):
            reasons[code]='기준일 거래 없음';continue
        if len(bars)<MIN_HISTORY:
            reasons[code]=f'상장 이력 {len(bars)}일 < {MIN_HISTORY}일';continue
        value=(bars.Close*bars.Volume).tail(20)
        stats[code]=float(value.mean())
    if not stats:return {},reasons
    cut=float(np.quantile(list(stats.values()),LIQUIDITY_CUT))
    chosen=[c for c,v in stats.items() if v>=cut]
    for c,v in stats.items():
        if v<cut:reasons[c]='거래대금 하위 20%'
    return {c:1/len(chosen) for c in sorted(chosen)},reasons


def buy_cost(price,quantity,cfg):
    gross=price*(1+cfg['slippage_pct']/100)*quantity
    return gross*(1+cfg['buy_fee_pct']/100)


def sell_proceeds(price,quantity,cfg,code=None):
    gross=price*(1-cfg['slippage_pct']/100)*quantity
    # ETFs held next to stocks (strategy F) are exempt from the transaction tax.
    tax=0. if code is not None and code in cfg.get('tax_free_codes',()) else cfg['sell_tax_pct']
    return gross*(1-(cfg['sell_fee_pct']+tax)/100)


def net_equity(state):
    cfg=state['config']
    return state['cash']+sum(sell_proceeds(p['last_close'],p['quantity'],cfg,c) for c,p in state['positions'].items())


def rebalance(state,targets,closes,day):
    """Trade toward target weights at today's closes. Codes without a close are left untouched."""
    cfg=state['config'];trades=[]
    gross_value=state['cash']+sum(p['quantity']*closes.get(c,p['last_close']) for c,p in state['positions'].items())
    # Size on equity net of a full round-trip estimate so buys never overdraw cash.
    budget=gross_value*(1-(cfg['slippage_pct']*2+cfg['buy_fee_pct']+cfg['sell_fee_pct']+cfg['sell_tax_pct'])/100)
    desired={}
    for code in set(targets)|set(state['positions']):
        if code not in closes:continue
        unit=buy_cost(closes[code],1,cfg)
        desired[code]=int(math.floor(targets.get(code,0)*budget/unit)) if targets.get(code) else 0
    for code,want in sorted(desired.items()):
        held=state['positions'].get(code,{}).get('quantity',0)
        if want<held:
            qty=held-want;cash=sell_proceeds(closes[code],qty,cfg,code)
            state['cash']+=cash
            p=state['positions'][code]
            trades.append({'date':day,'code':code,'name':p['symbol']['name'],'side':'SELL','quantity':qty,'close':closes[code],
                           'amount':cash,'realized_profit':cash-p['avg_cost']*qty})
            if want==0:del state['positions'][code]
            else:p['quantity']=want
    for code,want in sorted(desired.items()):
        held=state['positions'].get(code,{}).get('quantity',0)
        if want>held:
            qty=want-held;unit=buy_cost(closes[code],1,cfg)
            qty=min(qty,int(state['cash']//unit))
            if qty<1:continue
            cost=buy_cost(closes[code],qty,cfg);state['cash']-=cost
            p=state['positions'].setdefault(code,{'symbol':state['symbols'][code],'quantity':0,'avg_cost':0.,
                                                   'last_close':closes[code],'last_price_date':day})
            p['avg_cost']=(p['avg_cost']*p['quantity']+cost)/(p['quantity']+qty);p['quantity']+=qty
            trades.append({'date':day,'code':code,'name':p['symbol']['name'],'side':'BUY','quantity':qty,'close':closes[code],
                           'amount':-cost,'realized_profit':None})
    return trades


class EqualWeightEngine:
    key=KEY;label='C';method=METHOD;min_targets=50

    def __init__(self,store,provider,universe_source=None):
        self.store,self.provider=store,provider
        self.universe_source=universe_source or (lambda:(store.get('paper_comparison') or {}).get('b_universe'))
        self.calendar=CALENDAR

    def config(self):
        return UniverseSettings(holding_mode='trading_sessions').model_dump(exclude={'criterion','holding_mode'})

    def targets(self,frames,day):
        return eligible_weights(frames,day)

    def next_signal_day(self,state,day,execution):
        state['weekly_anchor']=state['weekly_anchor'] or execution
        return next_scan_day(state['weekly_anchor'],day)

    def target_message(self,day,weights,execution):
        return f'{day} 기준 {len(weights)}종목 동일가중 목표 · {execution} 종가 재조정 예약'

    def default(self):
        cfg=self.config()
        return {'enabled':False,'method':self.method,'config':cfg,'cash':cfg['capital'],'positions':{},'pending':None,
                'trades':[],'equity':[],'rebalances':[],'universe':None,'symbols':{},'weekly_anchor':None,
                'next_scan_day':None,'last_settled_day':None,'started_day':None,'errors':[],'revision':'initial',
                'message':'C는 351종목 동일가중 포트폴리오입니다. 시작하면 다음 거래일 종가에 분산 매수합니다.'}

    def status(self):
        state=self.store.get(self.key) or self.default()
        state['metrics']=metrics(state)
        return state

    def completed_day(self,now=None):
        now=now or datetime.now(SEOUL)
        day=pd.Timestamp(now.date())
        if now.hour<18:day-=pd.Timedelta(days=1)
        return str(self.calendar.date_to_session(day,direction='previous').date())

    def _price(self,code,day):
        raw,meta=self.provider.original_prices(code,'KR')
        if meta.get('from_cache') or meta.get('source') in {'원본 가격 캐시','가격 캐시'}:
            raise ValueError('캐시 가격은 완료 종가로 확인할 수 없습니다.')
        return raw.loc[raw.index<=pd.Timestamp(day)].sort_index()

    def start(self,day=None,progress=None):
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            if state['enabled']:return self.status()
            universe=state['universe'] or deepcopy(self.universe_source())
            if not universe or not universe.get('rows'):raise ValueError('B의 고정 종목 목록(351종목)이 필요합니다.')
            state.update(enabled=True,universe=universe,revision=uuid.uuid4().hex,
                         symbols={r['code']:{k:r.get(k) for k in ['code','name','market','exchange']} for r in universe['rows']},
                         started_day=state['started_day'] or (day or self.completed_day()))
            self.store.put(self.key,state,con)
        return self.daily(day,progress)

    def stop(self):
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            state.update(enabled=False,pending=None,revision=uuid.uuid4().hex,
                         message=f'{self.label} 신규 재조정 중지. 보유 종목 평가는 계속합니다.')
            self.store.put(self.key,state,con)
        return self.status()

    def daily(self,day=None,progress=None):
        progress=progress or (lambda *a:None)
        day=day or self.completed_day()
        if not self.calendar.is_session(day):raise ValueError('한국 거래일을 선택하세요.')
        snapshot=self.store.get(self.key) or self.default()
        if not snapshot['universe']:raise ValueError(f'{self.label}를 먼저 시작하세요.')
        if snapshot['last_settled_day'] and day<snapshot['last_settled_day']:
            raise ValueError('마지막 정산일 이전으로 되돌릴 수 없습니다.')
        rows=snapshot['universe']['rows'];frames={};errors=[]
        for i,row in enumerate(rows):
            try:frames[row['code']]=self._price(row['code'],day)
            except Exception as exc:
                frames[row['code']]=None;errors.append({'code':row['code'],'name':row['name'],'error':str(exc)})
            progress(int((i+1)*90/len(rows)),f"{self.label} · 종가 확인 {i+1}/{len(rows)} · {row['name']}")
        closes={c:float(f.Close.iloc[-1]) for c,f in frames.items()
                if f is not None and not f.empty and str(f.index[-1].date())==day and f.Close.iloc[-1]>0}
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            if state['revision']!=snapshot['revision']:return self.status()
            executed=[]
            pending=state['pending']
            if pending and pending['execution_day']<day:
                state['rebalances'].append({**{k:v for k,v in pending.items() if k!='targets'},'status':'expired'});state['pending']=None
            elif pending and pending['execution_day']==day:
                executed=rebalance(state,pending['targets'],closes,day)
                state['trades'].extend(executed)
                missing=sorted(set(pending['targets'])-set(closes))
                state['rebalances'].append({**{k:v for k,v in pending.items() if k!='targets'},'status':'filled',
                    'trades':len(executed),'missing_prices':missing,'holdings_after':len(state['positions'])})
                state['pending']=None
            for code,p in state['positions'].items():
                if code in closes:p.update(last_close=closes[code],last_price_date=day)
            point={'date':day,'value':net_equity(state),'cash':state['cash'],'positions':len(state['positions']),
                   'stale_positions':sum(p['last_price_date']!=day for p in state['positions'].values())}
            state['equity']=[p for p in state['equity'] if p['date']!=day]+[point]
            if state['enabled'] and state['pending'] is None and (not state['next_scan_day'] or day>=state['next_scan_day']):
                weights,reasons=self.targets(frames,day)
                if len(weights)>=self.min_targets:
                    execution=str(self.calendar.next_session(day).date())
                    state['pending']={'signal_date':day,'execution_day':execution,'targets':weights,'eligible_n':len(weights),
                                      'excluded':len(reasons),'price_errors':len(errors),'method':self.method}
                    state['next_scan_day']=self.next_signal_day(state,day,execution)
                    state['message']=self.target_message(day,weights,execution)
                else:
                    state['message']=f'{day} 대상 {len(weights)}개 · 최소 {self.min_targets}개 미만이라 재조정을 보류합니다.'
            else:
                state['message']=f"{day} 정산 · 보유 {len(state['positions'])}종목 · 재조정 체결 {len(executed)}건 · 가격 누락 {len(errors)}"
            state['errors']=errors;state['last_settled_day']=day
            self.store.put(self.key,state,con)
        progress(100,state['message'])
        return self.status()


def metrics(state):
    initial=state['config']['capital'];value=net_equity(state)
    peak=initial;drawdown=0.
    for point in sorted(state['equity'],key=lambda r:r['date']):
        peak=max(peak,point['value']);drawdown=max(drawdown,(1-point['value']/peak)*100)
    invested=sum(p['quantity']*p['last_close'] for p in state['positions'].values())
    return {'net_equity':value,'return_pct':(value/initial-1)*100,'profit':value-initial,'max_drawdown_pct':drawdown,
            'holding_count':len(state['positions']),'invested_pct':invested/max(value,1)*100,
            'trade_count':len(state['trades']),'rebalance_count':sum(r['status']=='filled' for r in state['rebalances']),
            'valuation_date':state['equity'][-1]['date'] if state['equity'] else None,
            'stale_positions':sum(p['last_price_date']!=(state['equity'][-1]['date'] if state['equity'] else None)
                                  for p in state['positions'].values())}
