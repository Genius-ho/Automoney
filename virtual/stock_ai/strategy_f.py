"""Strategy F: a portfolio of strategies — C (Korean stocks, equal weight), D0 and D3 — monthly.

Research (docs/verification/2026-10-13/strategy-f, pre-registered rule passed):
  2016-08..2026-09 monthly: F 12.8%/yr, Sharpe 1.24, max drawdown 13.2%
  vs C 17.2% / 0.81 / 25.7%, D0 10.2% / 1.23 / 11.4%, D3 15.4% / 1.10 / 17.4%.
Sleeve weights = inverse trailing 12-month volatility of each sleeve's monthly return, recomputed
from prices at every month-end signal. One account holds the stocks and the ETFs; ETFs are
exempt from the transaction tax.
"""
import numpy as np
import pandas as pd
from .strategy_c import EqualWeightEngine, eligible_weights
from .strategy_d import ASSETS, CASH, UNIVERSE as ETF_UNIVERSE, allocation, AllocationEngine

METHOD='strategy-mix-c-d0-d3-invvol-monthly-v1'
SLEEVES=('C','D0','D3')


def month_ends(index,day,count=13):
    s=pd.Series(index[index<=pd.Timestamp(day)],index=index[index<=pd.Timestamp(day)])
    ends=pd.DatetimeIndex(s.groupby([s.index.year,s.index.month]).max().values)
    return ends[-count:]


def sleeve_returns(frames,stock_codes,day):
    """Trailing monthly returns of the three sleeves, computed from prices only (no costs)."""
    etf=frames['069500']
    ends=month_ends(etf.index,day)
    if len(ends)<4:return pd.DataFrame(columns=list(SLEEVES))
    close=pd.DataFrame({c:frames[c].Close for c in stock_codes if frames.get(c) is not None and not frames[c].empty})
    rows=[]
    for start,end in zip(ends[:-1],ends[1:]):
        a=close.reindex([start,end],method='ffill')
        stock=(a.iloc[1]/a.iloc[0]-1).dropna()
        def etf_ret(code):
            f=frames[code].Close;return float(f.loc[:end].iloc[-1]/f.loc[:start].iloc[-1]-1)
        d0=float(np.mean([etf_ret(c) for c in ASSETS]))
        cut={c:frames[c].loc[:start] for c in [*ASSETS,CASH]}
        w,_=allocation('d3',cut,str(start.date()))
        d3=float(sum(v*etf_ret(c) for c,v in w.items())) if w else 0.
        rows.append({'month':str(end.date())[:7],'C':float(stock.mean()) if len(stock) else 0.,'D0':d0,'D3':d3})
    return pd.DataFrame(rows).set_index('month')


def sleeve_weights(history):
    if len(history)<12:return pd.Series(1/3,index=list(SLEEVES))
    vol=history[list(SLEEVES)].tail(12).std()
    inv=1/vol.replace(0,np.nan)
    return (inv/inv.sum()).fillna(1/3)


class StrategyMixEngine(EqualWeightEngine):
    key='strategy_f_paper';label='F';method=METHOD;min_targets=50

    def __init__(self,store,provider):
        def universe():
            b=(store.get('paper_comparison') or {}).get('b_universe')
            if not b:return None
            return {'rows':[*b['rows'],*ETF_UNIVERSE['rows']],'label':'코스피200·코스닥150 + ETF 8종','membership_policy':'fixed'}
        super().__init__(store,provider,universe)

    def config(self):
        return {**super().config(),'tax_free_codes':[*ASSETS,CASH]}

    def default(self):
        state=super().default()
        state['message']='F 전략 분산(C·D0·D3 혼합) · 시작하면 다음 거래일 종가에 주식과 ETF를 함께 매수합니다.'
        return state

    def targets(self,frames,day):
        stock_frames={c:f for c,f in frames.items() if c not in ASSETS and c!=CASH}
        stocks,reasons=eligible_weights(stock_frames,day)
        d0,r0=allocation('d0',frames,day);d3,r3=allocation('d3',frames,day)
        if not d0 or not d3 or len(stocks)<50:
            return {},{**reasons,**r0,**r3}
        history=sleeve_returns(frames,list(stock_frames),day)
        w=sleeve_weights(history)
        out={}
        for sleeve,book in [('C',stocks),('D0',d0),('D3',d3)]:
            for code,v in book.items():out[code]=out.get(code,0.)+float(w[sleeve])*v
        self.last_sleeves={k:float(v) for k,v in w.items()}
        return out,reasons

    next_signal_day=AllocationEngine.next_signal_day

    def target_message(self,day,weights,execution):
        s=getattr(self,'last_sleeves',{})
        part=' · '.join(f'{k} {v:.0%}' for k,v in s.items())
        return f'{day} 기준 전략 배분 {part} · 보유 대상 {len(weights)}개 · {execution} 종가 재조정 예약'
