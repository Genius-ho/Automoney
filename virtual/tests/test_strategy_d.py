import numpy as np
import pandas as pd
import pytest
from stock_ai.store import Store
from stock_ai import strategy_d as d
from stock_ai.paper_cycles import CALENDAR

CODES=[*d.ASSETS,d.CASH]


def frame(end,days=300,start=10000.,drift=0.,vol=0.,seed=0):
    index=CALENDAR.sessions_in_range(CALENDAR.session_offset(end,-(days-1)),end)
    rng=np.random.default_rng(seed)
    close=start*np.exp(np.cumsum(drift+vol*rng.standard_normal(len(index))))
    return pd.DataFrame({'Open':close,'High':close,'Low':close,'Close':close,'Volume':1000.},index=index)


def frames(day,**overrides):
    out={c:frame(day,drift=.0003,vol=.01,seed=i) for i,c in enumerate(CODES)}
    out.update(overrides);return out


def test_d0_is_equal_weight_and_requires_every_close():
    day='2026-10-12'
    w,_=d.allocation('d0',frames(day),day)
    assert set(w)==set(d.ASSETS) and sum(w.values())==pytest.approx(1)
    w,reasons=d.allocation('d0',frames(day,**{'069500':frame('2026-10-08')}),day)
    assert w=={} and reasons['069500']=='기준일 종가 없음'


def test_d2_moves_downtrend_assets_to_cash_and_favours_low_volatility():
    day='2026-10-12'
    f=frames(day,**{'133690':frame(day,drift=-.003,vol=.01,seed=9),'114260':frame(day,drift=.0003,vol=.001,seed=8)})
    w,reasons=d.allocation('d2',f,day)
    assert '133690' not in w and '현금' in reasons['133690'] and w[d.CASH]>0
    assert w['114260']==max(v for c,v in w.items() if c!=d.CASH)
    assert sum(w.values())==pytest.approx(1)


def test_d3_holds_top_three_only_when_beating_cash():
    day='2026-10-12'
    f={c:frame(day,drift=-.001,seed=i) for i,c in enumerate(CODES)}
    f[d.CASH]=frame(day,drift=.0001)
    for c,r in [('133690',.002),('143850',.0015),('132030',.001)]:f[c]=frame(day,drift=r)
    w,_=d.allocation('d3',f,day)
    assert w==pytest.approx({'133690':1/3,'143850':1/3,'132030':1/3})
    f['132030']=frame(day,drift=-.0005)
    w,_=d.allocation('d3',f,day)
    assert set(w)=={'133690','143850',d.CASH} and w[d.CASH]==pytest.approx(1/3)


class Provider:
    def __init__(self):self.day='2026-10-12';self.scale=1.
    def original_prices(self,code,market='KR'):
        f=frame(self.day,drift=.0003,vol=.01,seed=CODES.index(code));f['Close']*=self.scale
        return f,{'source':'fixture'}


def test_engine_starts_monthly_with_no_tax_and_signals_at_month_end(tmp_path):
    provider=Provider();store=Store(tmp_path/'d.sqlite')
    engines=d.engines(store,provider)
    s=engines['d0'].start('2026-10-12')
    assert s['config']['sell_tax_pct']==0 and s['pending']['execution_day']=='2026-10-13'
    assert s['next_scan_day']=='2026-10-30' and len(s['pending']['targets'])==7
    provider.day='2026-10-13';s=engines['d0'].daily('2026-10-13')
    assert len(s['positions'])==7 and s['metrics']['invested_pct']>98 and s['pending'] is None
    provider.day='2026-10-30';s=engines['d0'].daily('2026-10-30')
    assert s['pending']['execution_day']=='2026-11-02' and s['next_scan_day']=='2026-11-30'
    # Accounts are independent.
    assert engines['d3'].status()['positions']=={} and store.get('strategy_c_paper') is None


def test_strategy_f_mixes_sleeves_and_exempts_etfs_from_tax(tmp_path):
    from stock_ai import strategy_f as f
    from stock_ai.strategy_c import sell_proceeds
    stocks=[f'{i:06d}' for i in range(70)]
    class Mixed:
        def __init__(self):self.day='2026-10-12'
        def original_prices(self,code,market='KR'):
            seed=CODES.index(code) if code in CODES else int(code)+20
            return frame(self.day,days=600,drift=.0003,vol=.01,seed=seed),{'source':'fixture'}
    store=Store(tmp_path/'f.sqlite')
    store.put('paper_comparison',{'b_universe':{'rows':[{'code':c,'name':'S'+c,'market':'KR','exchange':'KOSPI'} for c in stocks]}})
    engine=f.StrategyMixEngine(store,Mixed())
    s=engine.start('2026-10-12')
    targets=s['pending']['targets']
    assert sum(targets.values())==pytest.approx(1)
    sleeves=engine.last_sleeves
    assert set(sleeves)=={'C','D0','D3'} and sum(sleeves.values())==pytest.approx(1)
    stock_share=sum(v for c,v in targets.items() if c in stocks)
    assert stock_share==pytest.approx(sleeves['C'])
    cfg=s['config']
    assert sell_proceeds(100,10,cfg,'069500')>sell_proceeds(100,10,cfg,'000001')
    assert s['next_scan_day']=='2026-10-30'


def test_kospi200_hold_buys_once_and_never_rebalances(tmp_path):
    from stock_ai.strategy_k import HoldIndexEngine
    provider=Provider();engine=HoldIndexEngine(Store(tmp_path/'k.sqlite'),provider)
    s=engine.start('2026-10-12')
    assert s['pending']['targets']=={'069500':1.} and s['config']['sell_tax_pct']==0
    provider.day='2026-10-13';s=engine.daily('2026-10-13')
    assert list(s['positions'])==['069500'] and s['metrics']['invested_pct']>99
    provider.day='2026-10-30';s=engine.daily('2026-10-30')
    assert s['pending'] is None and len(s['trades'])==1
