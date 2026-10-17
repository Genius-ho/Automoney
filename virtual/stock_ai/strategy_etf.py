"""Single-ETF paper accounts for the user's own methods: G, H (US, added 2026-10-14) and I (KR).

G · SOXL 무한매수법 V3.0 rules with the user's settings (40 splits, +10% target):
  cycle seed = all cash when the cycle starts, one unit = seed / 40
  T = cost basis of the shares held / unit;  star% = target * (1 - 2T/40)  (10% at T=0, 0% at T=20)
  star price = average * (1 + star%),  target price = average * 1.10
  no shares   : buy one unit at the close (LOC at a high price)
  first half  : T < 20 -> half a unit LOC at the average, half a unit LOC at star - $0.01
  second half : T >= 20 -> one unit LOC at star - $0.01
  sells       : 1/4 of the shares LOC at the star price, the other 3/4 limit at the target price
  exhausted   : when cash is below one unit, sell 1/4 at the close (quarter stop) instead of buying
  all shares sold -> the next session starts a new cycle with the whole cash re-split by 40.
  The original V3.0 SOXL default is 20 splits / +20%; the user chose 40 splits / +10%, and the
  star% formula target*(1-2T/N) reproduces the published V2.2/V3.0 lines for both settings.

H (TQQQ) and I (KODEX 200) · 밸류 리밸런싱, mirroring the user's own engine (vr_formula.py,
vr_engine.py, vr_execution_policy.py in the main repo):
  start: buy the initial share of cash at the close; V = value of those shares; Pool = cash
  cycles end on a Friday anchor (first Friday on/after the first session) and every 14 days after,
  on the last session on or before that Friday; at that close
      V <- V + Pool/G + (E - V) / (2*sqrt(G)),  bands = V * (1 -/+ band)
  then a fixed ladder is armed from the share count Q0 at that moment, one share per rung:
      buy  rung n = lower / (Q0 + n - 1), as many rungs as bring the spend closest to Pool * 75%
      sell rung n = upper / (Q0 - n + 1), up to Q0 rungs
  rungs rest as limit orders through the cycle: a buy fills when the low reaches it (at the open if
  the session gaps below), a sell when the high reaches it; a filled rung is not re-armed.

Orders come from the state after the previous close and fill from that session's OHLC, so missed
sessions are replayed in order. Capital is 1,000,000,000 KRW (converted to USD at the start
date's USD/KRW for US accounts, which are valued back in KRW at each session's rate).
"""
from datetime import datetime
import math
import uuid
import pandas as pd
import exchange_calendars as xc
from .universe_paper import SEOUL

KRW_CAPITAL=1e9
US_COSTS={'buy_fee_pct':.07,'sell_fee_pct':.07,'sell_tax_pct':0.,'slippage_pct':0.}
KR_ETF_COSTS={'buy_fee_pct':.015,'sell_fee_pct':.015,'sell_tax_pct':0.,'slippage_pct':0.}
FRIDAY=4


def cents(value):
    return math.floor(value*100+1e-9)/100


class EtfEngine:
    key=label=code=name=method=None
    market='US'

    def __init__(self,store,provider):
        self.store,self.provider=store,provider
        self.calendar=xc.get_calendar('XNYS' if self.market=='US' else 'XKRX')

    def params(self):return {}

    def costs(self):return US_COSTS if self.market=='US' else KR_ETF_COSTS

    def config(self):
        return {'capital':KRW_CAPITAL,'currency':'USD' if self.market=='US' else 'KRW','code':self.code,
                **self.costs(),**self.params()}

    def price(self,value):
        """Order prices: cents for USD, whole won for KRW."""
        return round(value,2) if self.market=='US' else float(round(value))

    def default(self):
        return {'enabled':False,'method':self.method,'config':self.config(),'code':self.code,'started_day':None,
                'last_settled_day':None,'fx_start':None,'capital_usd':None,'cash':None,'shares':0,'avg':0.,
                'avg_cost':0.,'last_close':None,'fx':None,'positions':{},'trades':[],'equity':[],'book':{},
                'errors':[],'revision':'initial','message':self.intro()}

    def intro(self):return ''

    def completed_day(self,now=None):
        """Latest session whose bar is final: 30 minutes after a NYSE close, 18:00 KST in Korea."""
        now=pd.Timestamp(now or datetime.now(SEOUL)).tz_convert('UTC')
        wait=pd.Timedelta(minutes=30) if self.market=='US' else pd.Timedelta(hours=2,minutes=30)
        day=self.calendar.date_to_session(pd.Timestamp(now.date()),direction='previous')
        while self.calendar.session_close(day)+wait>now:day=self.calendar.previous_session(day)
        return str(day.date())

    def status(self):
        state=self.store.get(self.key) or self.default()
        state['metrics']=metrics(state)
        return state

    def _rates(self):
        if self.market!='US':return None
        rates,_=self.provider.exchange_rates(1)
        return rates.Close.dropna()

    def rate_on(self,rates,day):
        if rates is None:return 1.
        known=rates.loc[rates.index<=pd.Timestamp(day)]
        if known.empty or pd.Timestamp(day)-known.index[-1]>pd.Timedelta(days=7):
            raise ValueError(f'{day} 원/달러 환율이 없습니다.')
        return float(known.iloc[-1])

    def start(self,day=None,progress=None):
        day=day or self.completed_day()
        rate=self.rate_on(self._rates(),day)
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            if state['enabled']:return self.status()
            if not state['started_day']:
                capital=KRW_CAPITAL/rate
                state.update(started_day=day,last_settled_day=day,fx_start=rate,fx=rate,capital_usd=capital,cash=capital,
                             equity=[{'date':day,'value':KRW_CAPITAL,'value_usd':capital,'fx':rate}])
            state.update(enabled=True,revision=uuid.uuid4().hex,
                         message=f'{day} 종가 기준 시작 · 첫 주문은 다음 거래일 종가에 체결합니다.')
            self.store.put(self.key,state,con)
        return self.daily(progress=progress)

    def stop(self):
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            state.update(enabled=False,revision=uuid.uuid4().hex,
                         message=f'{self.label} 주문 중지 · 보유분 평가는 계속합니다.')
            self.store.put(self.key,state,con)
        return self.status()

    def daily(self,day=None,progress=None):
        progress=progress or (lambda *a:None)
        day=day or self.completed_day()
        snapshot=self.store.get(self.key) or self.default()
        if not snapshot['started_day']:raise ValueError(f'{self.label}를 먼저 시작하세요.')
        if day<=snapshot['last_settled_day']:
            progress(100,f"{snapshot['last_settled_day']} 까지 정산 완료");return self.status()
        progress(20,f'{self.label} · {self.code} 일봉'+(' 과 환율' if self.market=='US' else '')+' 확인')
        raw,meta=self.provider.original_prices(self.code,self.market)
        if meta.get('source')!='FinanceDataReader':raise ValueError('캐시 가격은 완료 종가로 확인할 수 없습니다.')
        rates=self._rates()
        sessions=[str(s.date()) for s in self.calendar.sessions_in_range(snapshot['last_settled_day'],day)
                  if str(s.date())>snapshot['last_settled_day']]
        with self.store.transaction() as con:
            state=self.store.get(self.key,None,con) or self.default()
            if state['revision']!=snapshot['revision']:return self.status()
            state['errors']=[]
            self._split_check(state,raw)
            for session in sessions:
                stamp=pd.Timestamp(session)
                if stamp not in raw.index or not raw.loc[stamp].Close>0:
                    state['errors'].append({'code':self.code,'name':self.name,'error':f'{session} 일봉 없음 · 다음 정산에서 재시도'});break
                bar=raw.loc[stamp]
                try:rate=self.rate_on(rates,session)
                except ValueError as exc:
                    state['errors'].append({'code':self.code,'name':self.name,'error':str(exc)});break
                if state['enabled']:self.trade(state,bar,session,rate)
                state.update(last_close=float(bar.Close),fx=rate,last_settled_day=session)
                self._mark(state,session)
            if not state['errors']:state['message']=self.summary(state)
            self.store.put(self.key,state,con)
        progress(100,state['message'])
        return self.status()

    def _split_check(self,state,raw):
        """Rescale shares if the provider's history was split-adjusted since the last settlement."""
        day=pd.Timestamp(state['last_settled_day'])
        if not state['shares'] or not state['last_close'] or day not in raw.index:return
        ratio=state['last_close']/float(raw.loc[day].Close)
        if 0.7<=ratio<=1.4:return
        state['shares']=int(round(state['shares']*ratio))
        for k in ('avg','avg_cost'):state[k]/=ratio
        state['last_close']/=ratio
        self.rescale(state,ratio)
        state.setdefault('splits',[]).append({'date':state['last_settled_day'],'ratio':ratio})

    def rescale(self,state,ratio):pass

    def _mark(self,state,day):
        value=net_value(state)
        state['positions']={self.code:{'symbol':{'code':self.code,'name':self.name,'market':self.market},'quantity':state['shares'],
            'avg_cost':state['avg_cost']*state['fx'],'avg_cost_usd':state['avg_cost'],'last_close':state['last_close']*state['fx'],
            'last_close_usd':state['last_close'],'last_price_date':day}} if state['shares'] else {}
        point={'date':day,'value':value*state['fx'],'value_usd':value,'fx':state['fx'],'shares':state['shares'],'cash_usd':state['cash']}
        state['equity']=[p for p in state['equity'] if p['date']!=day]+[point]

    def buy(self,state,day,price,quantity,rate,reason):
        fee=state['config']['buy_fee_pct']/100
        quantity=min(int(quantity),int(state['cash']//(price*(1+fee))))
        if quantity<1:return 0
        cost=price*quantity*(1+fee)
        state['avg']=(state['avg']*state['shares']+price*quantity)/(state['shares']+quantity)
        state['avg_cost']=(state['avg_cost']*state['shares']+cost)/(state['shares']+quantity)
        state['shares']+=quantity;state['cash']-=cost
        state['trades'].append({'date':day,'code':self.code,'name':self.name,'side':'BUY','quantity':quantity,'price':price,
            'amount_usd':-cost,'amount':-cost*rate,'fx':rate,'realized_profit':None,'realized_profit_usd':None,'reason':reason})
        return quantity

    def sell(self,state,day,price,quantity,rate,reason):
        quantity=min(int(quantity),state['shares'])
        if quantity<1:return 0
        cfg=state['config']
        proceeds=price*quantity*(1-(cfg['sell_fee_pct']+cfg['sell_tax_pct'])/100)
        profit=proceeds-state['avg_cost']*quantity
        state['shares']-=quantity;state['cash']+=proceeds
        if not state['shares']:state['avg']=state['avg_cost']=0.
        state['trades'].append({'date':day,'code':self.code,'name':self.name,'side':'SELL','quantity':quantity,'price':price,
            'amount_usd':proceeds,'amount':proceeds*rate,'fx':rate,'realized_profit_usd':profit,
            'realized_profit':profit*rate,'reason':reason})
        return quantity


class InfiniteBuyEngine(EtfEngine):
    key='strategy_g_paper';label='G';code='SOXL';name='SOXL (반도체 3배)';method='infinite-buy-v3-soxl-40-10-v1'

    def params(self):return {'splits':40,'target_pct':10.}

    def intro(self):
        return 'G는 SOXL 무한매수법(V3.0 규칙 · 40분할 · +10% 익절)입니다. 시작하면 다음 미국 거래일 종가에 1회분을 매수합니다.'

    @staticmethod
    def levels(book,avg,shares,splits,target):
        t=avg*shares/book['unit'] if book.get('unit') else 0.
        star_pct=target*(1-2*t/splits)
        return {'t':t,'star_pct':star_pct,'star_price':cents(avg*(1+star_pct/100)),'target_price':cents(avg*(1+target/100))}

    def trade(self,state,bar,day,rate):
        cfg=state['config'];book=state['book'];n=cfg['splits'];target=cfg['target_pct']
        close,high,open_=float(bar.Close),float(bar.High),float(bar.Open)
        fee=cfg['buy_fee_pct']/100
        if not state['shares']:
            # an open cycle without shares means yesterday's first buy did not fill: retry it
            book.update(cycle=book.get('cycle',0)+(0 if book.get('cycle_open') else 1),cycle_open=True,
                        cycle_start=day,seed=state['cash'],unit=state['cash']/n)
            self.buy(state,day,close,math.floor(book['unit']/(close*(1+fee))),rate,f"{book['cycle']}사이클 첫 매수 (큰수 LOC)")
            return
        level=self.levels(book,state['avg'],state['shares'],n,target)
        # every order below was placed before the open from yesterday's average
        average=cents(state['avg'])
        shares=state['shares'];quarter=shares//4;rest=shares-quarter
        star,tp=level['star_price'],level['target_price']
        exhausted=state['cash']<book['unit']*(1+fee)
        if high>=tp:self.sell(state,day,max(open_,tp),rest,rate,f'목표 +{target:g}% 지정가 3/4')
        sold_quarter=False
        if quarter and close>=star:
            sold_quarter=bool(self.sell(state,day,close,quarter,rate,f"별지점 LOC 1/4 (T {level['t']:.1f}, 별 {level['star_pct']:.2f}%)"))
        if exhausted:
            if not sold_quarter and quarter and state['shares']:
                self.sell(state,day,close,min(quarter,state['shares']),rate,f"40회 소진 · 쿼터손절 1/4 (T {level['t']:.1f})")
        else:
            below=round(star-.01,2)
            orders=[(book['unit']/2,average,'평단 LOC'),(book['unit']/2,below,'별지점 LOC')] if level['t']<n/2 else [(book['unit'],below,'별지점 LOC')]
            for amount,limit,reason in orders:
                if limit>0 and close<=limit:
                    self.buy(state,day,close,math.floor(amount/limit),rate,f"{reason} (T {level['t']:.1f})")
        if not state['shares']:
            book['cycles_done']=book.get('cycles_done',0)+1;book['cycle_open']=False
            book['last_cycle']={'cycle':book['cycle'],'start':book['cycle_start'],'end':day,'seed':book['seed'],'end_cash':state['cash'],
                                'return_pct':(state['cash']/book['seed']-1)*100}
            book.setdefault('history',[]).append(book['last_cycle'])

    def summary(self,state):
        book=state['book']
        if not state['shares']:
            return f"{state['last_settled_day']} 정산 · 보유 없음 · 다음 거래일 종가에 새 사이클 1회분 매수"
        level=self.levels(book,state['avg'],state['shares'],state['config']['splits'],state['config']['target_pct'])
        return (f"{state['last_settled_day']} 정산 · {book['cycle']}사이클 T {level['t']:.1f}/40 · 평단 ${state['avg']:.2f} · "
                f"별지점 ${level['star_price']:.2f} ({level['star_pct']:.2f}%) · 목표 ${level['target_price']:.2f}")

    def status(self):
        state=super().status()
        if state['shares'] and state['book'].get('unit'):
            cfg=state['config'];state['levels']=self.levels(state['book'],state['avg'],state['shares'],cfg['splits'],cfg['target_pct'])
        return state


class ValueRebalanceEngine(EtfEngine):
    key='strategy_h_paper';label='H';code='TQQQ';name='TQQQ (나스닥100 3배)';method='value-rebalancing-ladder-tqqq-g10-b15-v2'

    def params(self):return {'initial_pct':50.,'g':10.,'band_pct':15.,'cycle_days':14,'pool_limit_pct':75.}

    def intro(self):
        return 'H는 TQQQ 밸류 리밸런싱(VR · 거치식 · G=10 · 밴드 ±15% · 금요일 기준 2주 · 1주 단위 사다리 주문)입니다. 시작하면 다음 거래일 종가에 자금의 50%를 매수합니다.'

    def cycle_end(self,anchor,cycle,cfg):
        target=pd.Timestamp(anchor)+pd.Timedelta(days=cfg['cycle_days']*(cycle-1))
        return str(self.calendar.date_to_session(target,direction='previous').date())

    def arm(self,state,day):
        """Fix this cycle's ladder from the share count now (Q0) and the Pool now."""
        cfg=state['config'];book=state['book'];q0=state['shares'];pool=state['cash']
        low,high=book['v']*(1-cfg['band_pct']/100),book['v']*(1+cfg['band_pct']/100)
        target=pool*cfg['pool_limit_pct']/100;spent=0.;best=(0,abs(target));n=0
        while q0 and spent+self.price(low/(q0+n))<=pool:
            spent+=self.price(low/(q0+n));n+=1
            if abs(spent-target)<best[1]:best=(n,abs(spent-target))
            if spent>target:break
        book.update(q0=q0,low=low,high=high,pool_start=pool,buy_rungs=best[0],buy_filled=0,sell_rungs=q0,sell_filled=0,armed=day)

    def fill_ladders(self,state,bar,day,rate):
        """Fill the resting one-share rungs this session reached; book one line per side."""
        book=state['book'];open_,high,low=float(bar.Open),float(bar.High),float(bar.Low)
        fee=state['config']['buy_fee_pct']/100;prices=[];cash=state['cash']
        while book['buy_filled']+len(prices)<book['buy_rungs']:
            rung=self.price(book['low']/(book['q0']+book['buy_filled']+len(prices)))
            fill=min(open_,rung)
            if low>rung or cash<fill*(1+fee):break
            prices.append(fill);cash-=fill*(1+fee)
        if prices and self.buy(state,day,sum(prices)/len(prices),len(prices),rate,''):
            book['buy_filled']+=len(prices)
            state['trades'][-1]['reason']=f"하단 사다리 {len(prices)}칸 체결 (누적 {book['buy_filled']}/{book['buy_rungs']})"
        prices=[]
        while len(prices)<min(book['sell_rungs']-book['sell_filled'],state['shares']):
            rung=self.price(book['high']/(book['q0']-book['sell_filled']-len(prices)))
            if high<rung:break
            prices.append(max(open_,rung))
        if prices and self.sell(state,day,sum(prices)/len(prices),len(prices),rate,''):
            book['sell_filled']+=len(prices)
            state['trades'][-1]['reason']=f"상단 사다리 {len(prices)}칸 체결 (누적 {book['sell_filled']}/{book['sell_rungs']})"

    def transition(self,state,day,close):
        cfg=state['config'];book=state['book'];g=cfg['g']
        e=state['shares']*close;old=book['v']
        book['v']=old+state['cash']/g+(e-old)/(2*math.sqrt(g))
        book['history'].append({'cycle':book['cycle'],'start':book['cycle_start'],'end':day,'v_before':old,'v_after':book['v'],
            'evaluation':e,'pool':state['cash'],'bought':book['buy_filled'],'sold':book['sell_filled']})
        book.update(cycle=book['cycle']+1,cycle_start=day)
        book['cycle_end']=self.cycle_end(book['anchor'],book['cycle'],cfg)
        self.arm(state,day)

    def trade(self,state,bar,day,rate):
        cfg=state['config'];book=state['book'];close=float(bar.Close);fee=cfg['buy_fee_pct']/100
        if book.get('v') is None:
            self.buy(state,day,close,math.floor(state['cash']*cfg['initial_pct']/100/(close*(1+fee))),rate,f"최초 {cfg['initial_pct']:g}% 매수")
            start=pd.Timestamp(day);anchor=start+pd.Timedelta(days=(FRIDAY-start.weekday())%7)
            book.update(v=state['shares']*close,cycle=1,cycle_start=day,anchor=str(anchor.date()),history=[])
            book['cycle_end']=self.cycle_end(book['anchor'],1,cfg)
            self.arm(state,day)
            if day>=book['cycle_end']:self.transition(state,day,close)
            return
        self.fill_ladders(state,bar,day,rate)
        if day>=book['cycle_end']:self.transition(state,day,close)

    def rescale(self,state,ratio):
        book=state['book']
        if book.get('q0'):book['q0']=int(round(book['q0']*ratio));book['sell_rungs']=book['q0']

    def unit(self):return '$' if self.market=='US' else '₩'

    def summary(self,state):
        book=state['book'];u=self.unit()
        if book.get('v') is None:return f"{state['last_settled_day']} 정산 · 다음 거래일 종가에 최초 매수"
        return (f"{state['last_settled_day']} 정산 · {book['cycle']}주기 V {u}{book['v']:,.0f} · 밴드 {u}{book['low']:,.0f}~{u}{book['high']:,.0f} · "
                f"평가 {u}{state['shares']*state['last_close']:,.0f} · Pool {u}{state['cash']:,.0f} · 다음 V 갱신 {book['cycle_end']} 종가")

    def status(self):
        state=super().status();book=state['book']
        if book.get('v') is not None:
            q0=book['q0']
            state['levels']={'v':book['v'],'low':book['low'],'high':book['high'],'pool':state['cash'],
                'next_buy':self.price(book['low']/(q0+book['buy_filled'])) if q0 and book['buy_filled']<book['buy_rungs'] else None,
                'next_sell':self.price(book['high']/(q0-book['sell_filled'])) if q0 and book['sell_filled']<book['sell_rungs'] else None,
                'buy_left':book['buy_rungs']-book['buy_filled'],'sell_left':book['sell_rungs']-book['sell_filled']}
        return state


class IndexValueRebalanceEngine(ValueRebalanceEngine):
    key='strategy_i_paper';label='I';code='069500';name='KODEX 200';market='KR'
    method='value-rebalancing-ladder-kodex200-v1'

    def intro(self):
        return 'I는 KODEX 200(코스피200) 밸류 리밸런싱입니다. 박스권 지수를 아래에서 사고 위에서 파는 방식으로, 시작하면 다음 거래일 종가에 자금의 50%를 매수합니다.'


def net_value(state):
    if state['cash'] is None:return 0.
    cfg=state['config']
    held=state['shares']*(state['last_close'] or 0)*(1-(cfg['sell_fee_pct']+cfg['sell_tax_pct'])/100)
    return state['cash']+held


def metrics(state):
    initial=state['config']['capital']
    points=sorted(state['equity'],key=lambda p:p['date'])
    value=points[-1]['value'] if points else initial
    native=net_value(state) if state['cash'] is not None else None
    peak=initial;drawdown=0.
    for p in points:peak=max(peak,p['value']);drawdown=max(drawdown,(1-p['value']/peak)*100)
    invested=state['shares']*(state['last_close'] or 0)
    return {'net_equity':value,'return_pct':(value/initial-1)*100,'profit':value-initial,'max_drawdown_pct':drawdown,
            'net_equity_usd':native,'return_usd_pct':(native/state['capital_usd']-1)*100 if native is not None and state['capital_usd'] else None,
            'holding_count':1 if state['shares'] else 0,'invested_pct':invested/native*100 if native else 0.,
            'trade_count':len(state['trades']),'valuation_date':points[-1]['date'] if points else None,'stale_positions':0}
