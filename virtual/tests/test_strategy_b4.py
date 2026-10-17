import numpy as np
import pandas as pd
from stock_ai import strategy_b4 as b4


def selector_with(n_stocks=120,n_days=260,seed=0):
    """Synthetic universe where a high cross-sectional `edge` predicts a profitable trade."""
    rng=np.random.default_rng(seed)
    dates=pd.bdate_range('2025-01-01',periods=n_days)
    selector=b4.PooledSelector();candidates=[]
    for i in range(n_stocks):
        edge=rng.normal(size=n_days)
        features=pd.DataFrame({'edge':edge,'return_5':rng.normal(size=n_days),'return_20':rng.normal(size=n_days),
            'realized_vol_20':rng.random(n_days),'rsi_14':rng.random(n_days)*100},index=dates)
        y=(edge+rng.normal(scale=.5,size=n_days)>0).astype(float)
        outcomes=pd.DataFrame({'y':y[:-10]},index=dates[:-10])
        # stock 0..11 are the least liquid tenth -> always excluded
        tv20=pd.Series(float(i+1),index=dates)
        key=f'h{i}';selector.items[key]=(features,outcomes,tv20)
        candidates.append({'code':str(i).zfill(6),'as_of':str(dates[-1].date()),'score':0.,'data_hash':key,
                           'eligible':False,'affordable':True,'status':'기준 미달'})
    return selector,candidates


def test_pooled_selector_buys_exactly_top_k_liquid_stocks_by_learned_score():
    selector,candidates=selector_with()
    selector.select(candidates)
    chosen=[c for c in candidates if c['eligible']]
    assert len(chosen)==b4.TOP_K and all(c['status']=='매수 후보' for c in chosen)
    assert sorted(c['pool_rank'] for c in chosen)==list(range(1,b4.TOP_K+1))
    illiquid=[c for c in candidates if int(c['code'])<int(len(candidates)*b4.LIQUIDITY_CUT)]
    assert not any(c['eligible'] for c in illiquid) and all('거래대금' in c['reason'] for c in illiquid)
    # the learned score should follow today's edge: chosen stocks have a clearly higher edge
    today={c['code']:selector.items[c['data_hash']][0].edge.iloc[-1] for c in candidates}
    assert np.mean([today[c['code']] for c in chosen])>np.mean(list(today.values()))+.5
    assert all(0<=c['probability']<=1 and c['score']==c['probability'] for c in candidates)


def test_pooled_selector_refuses_to_rank_a_small_universe():
    selector,candidates=selector_with(n_stocks=b4.MIN_STOCKS-1)
    selector.select(candidates)
    assert not any(c['eligible'] for c in candidates)
    assert all('통합 순위 보류' in c['reason'] for c in candidates)


def test_rank_filter_keeps_unaffordable_and_ineligible_out_of_the_ranking():
    rows=[{'code':str(i),'score':i/10,'eligible':True,'affordable':i!=9,'status':'매수 후보'} for i in range(10)]
    rows.append({'code':'x','score':.99,'eligible':False,'affordable':True,'status':'기준 미달'})
    b4.rank_filter(rows,3)
    assert [r['code'] for r in rows if r['eligible'] and r.get('pool_rank',99)<=3]==['6','7','8']
    assert rows[5]['status']=='기준 미달' and '상위 3종목' in rows[5]['reason']
    assert 'pool_rank' not in rows[-1]
