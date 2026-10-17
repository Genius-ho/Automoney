"""Strategy K: buy KODEX 200 (KOSPI200 ETF) once and hold — the passive benchmark.

Added 2026-10-13 at the user's request after the 3-year comparison showed KOSPI200 buy-and-hold
had the highest raw return (with a 41% drawdown). No rebalancing after the first purchase.
ETF price excludes distributions (dividends are not credited); ETFs pay no transaction tax.
"""
from .strategy_c import EqualWeightEngine

CODE='069500'
UNIVERSE={'rows':[{'code':CODE,'name':'KODEX 200','market':'KR','exchange':'ETF'}],
          'label':'KODEX 200 (코스피200) 단순 보유','membership_policy':'fixed'}


class HoldIndexEngine(EqualWeightEngine):
    key='strategy_k_paper';label='K';method='kospi200-buy-and-hold-v1';min_targets=1

    def __init__(self,store,provider):
        super().__init__(store,provider,lambda:UNIVERSE)

    def config(self):
        return {**super().config(),'sell_tax_pct':0.}

    def default(self):
        state=super().default()
        state['message']='K 코스피200 단순 보유 · 시작하면 다음 거래일 종가에 KODEX 200을 매수하고 계속 보유합니다.'
        return state

    def targets(self,frames,day):
        f=frames.get(CODE)
        if f is None or f.empty or str(f.index[-1].date())!=day:return {},{CODE:'기준일 종가 없음'}
        return {CODE:1.},{}

    def next_signal_day(self,state,day,execution):
        # Buy once; never rebalance afterwards.
        return '9999-12-31'

    def target_message(self,day,weights,execution):
        return f'{day} 기준 KODEX 200 100% · {execution} 종가 매수 예약 후 계속 보유'
