import numpy as np
import pandas as pd
import pytest
from stock_ai.store import Store
from stock_ai import strategy_c as c
from stock_ai.paper_cycles import CALENDAR


def frame(end,days=300,close=10000.,volume=1000.):
    index=CALENDAR.sessions_in_range(CALENDAR.session_offset(end,-(days-1)),end)
    return pd.DataFrame({'Open':close,'High':close,'Low':close,'Close':close,'Volume':volume},index=index)


def test_eligibility_requires_history_todays_bar_and_liquidity():
    day='2026-10-08'
    frames={f'{i:06d}':frame(day,volume=1000+i) for i in range(10)}
    frames['short']=frame(day,days=100)
    frames['stale']=frame('2026-10-07')
    frames['none']=None
    w,reasons=c.eligible_weights(frames,day)
    # bottom 20% traded value (codes 0,1) excluded; equal weights sum to 1
    assert sorted(w)==[f'{i:06d}' for i in range(2,10)]
    assert sum(w.values())==pytest.approx(1)
    assert reasons['000000']=='거래대금 하위 20%' and '이력' in reasons['short']
    assert reasons['stale']=='기준일 일봉 없음' and reasons['none']=='가격 없음'


def state(cash=1_000_000_000.):
    cfg={'capital':cash,'buy_fee_pct':.015,'sell_fee_pct':.015,'sell_tax_pct':.2,'slippage_pct':.05}
    return {'config':cfg,'cash':cash,'positions':{},'symbols':{k:{'code':k,'name':k} for k in 'abc'}}


def test_rebalance_uses_integer_shares_never_overdraws_and_conserves_cash():
    s=state()
    trades=c.rebalance(s,{'a':.5,'b':.5},{'a':10000.,'b':333.},'2026-10-12')
    assert s['cash']>=0 and all(isinstance(p['quantity'],int) for p in s['positions'].values())
    spent=-sum(t['amount'] for t in trades)
    assert s['cash']==pytest.approx(1_000_000_000-spent)
    value=s['positions']['a']['quantity']*10000
    assert value/1e9==pytest.approx(.5,abs=.005)
    # Next week 'a' drops out, 'c' enters; sells happen first and fund the buy.
    trades=c.rebalance(s,{'b':.5,'c':.5},{'a':11000.,'b':333.,'c':5000.},'2026-10-19')
    assert 'a' not in s['positions'] and trades[0]['side']=='SELL' and trades[0]['realized_profit']>0
    assert s['cash']>=0 and s['positions']['c']['quantity']>0


def test_rebalance_leaves_codes_without_a_close_untouched():
    s=state();c.rebalance(s,{'a':.5,'b':.5},{'a':100.,'b':100.},'d1')
    held=s['positions']['a']['quantity']
    c.rebalance(s,{'b':1.},{'b':100.},'d2')
    assert s['positions']['a']['quantity']==held


class Provider:
    def __init__(self,codes):
        self.codes=codes;self.day='2026-10-08';self.price={k:10000. for k in codes};self.missing=set()
    def original_prices(self,code,market='KR'):
        if code in self.missing:raise ValueError('unavailable')
        return frame(self.day,close=self.price[code],volume=1000.+int(code)),{'source':'fixture'}


def setup(tmp_path,n=70):
    codes=[f'{i:06d}' for i in range(n)]
    universe={'rows':[{'code':k,'name':'S'+k,'market':'KR','exchange':'KOSPI'} for k in codes]}
    provider=Provider(codes)
    return c.EqualWeightEngine(Store(tmp_path/'c.sqlite'),provider,lambda:universe),provider


def test_engine_signals_then_fills_next_close_and_values_net_of_exit_costs(tmp_path):
    engine,provider=setup(tmp_path)
    s=engine.start('2026-10-08')
    assert s['pending']['execution_day']=='2026-10-12' and s['pending']['eligible_n']==56
    assert not s['positions'] and s['metrics']['return_pct']==0
    provider.day='2026-10-12';s=engine.daily('2026-10-12')
    assert len(s['positions'])==56 and s['pending'] is None and s['rebalances'][-1]['status']=='filled'
    assert s['cash']>=0 and s['metrics']['invested_pct']>98
    # Immediately after buying, net equity reflects buy and expected sell costs (< 0 return).
    assert -1<s['metrics']['return_pct']<0
    assert s['next_scan_day']=='2026-10-19'
    provider.day='2026-10-13';provider.price={k:11000. for k in provider.codes};provider.missing={'000069'}
    s=engine.daily('2026-10-13')
    assert s['metrics']['return_pct']>8 and s['pending'] is None and s['errors'][0]['code']=='000069'
    provider.day='2026-10-19';provider.missing=set();s=engine.daily('2026-10-19')
    assert s['pending']['execution_day']=='2026-10-20' and s['next_scan_day']=='2026-10-26'


def test_missed_execution_expires_and_stop_cancels(tmp_path):
    engine,provider=setup(tmp_path)
    engine.start('2026-10-08')
    provider.day='2026-10-13';s=engine.daily('2026-10-13')
    assert s['rebalances'][-1]['status']=='expired' and not s['positions']
    s=engine.stop()
    assert not s['enabled'] and s['pending'] is None
    with pytest.raises(ValueError,match='이전'):engine.daily('2026-10-12')
