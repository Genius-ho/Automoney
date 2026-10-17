import pandas as pd
import pytest
from stock_ai.config import Settings
from stock_ai.simulation import simulate
from stock_ai.portfolio import optimize_weights, kelly


def sample():
    return pd.DataFrame({'Open':[100]*6,'High':[100,104,104,104,104,104],
                         'Low':[99]*6,'Close':[100]*6,'Volume':[1000]*6},
                        index=pd.bdate_range('2020-01-01',periods=6))


def zero_settings(**kw):
    return Settings(buy_fee_pct=0,sell_fee_pct=0,sell_tax_pct=0,slippage_pct=0,**kw)


def test_compound_integer_shares_and_no_same_day_reentry():
    df=sample()
    predictions=[{'date':str(date.date()),'probability':.9} for date in df.index]
    result=simulate(df,predictions,zero_settings(),mode='touch')
    assert len(result['trades']) == 5
    assert result['trades'][0]['cash_after'] == 10200000
    assert result['trades'][1]['cash_after'] == 10404000
    assert all(t['buy_date'] == t['sell_date'] for t in result['trades'])


def test_buffer_avoids_touch_fill_and_expiry_can_lose():
    df=sample()
    df.loc[df.index[1],'High']=102
    df.loc[df.index[2]:,'High']=100
    df.loc[df.index[2]:,'Close']=99
    preds=[{'date':str(df.index[0].date()),'probability':.9}]
    result=simulate(df,preds,zero_settings(horizon=2,fill_buffer_pct=.1),mode='buffer')
    assert result['trades'][0]['reason']=='expiry'
    assert result['trades'][0]['cash_after']==9900000
    assert result['max_drawdown_pct'] >= 1


def test_unclosed_position_separate_from_realized_cash():
    df=sample();df.High=100
    result=simulate(df,[{'date':str(df.index[0].date()),'probability':.9}],zero_settings(),mode='buffer')
    assert result['open_position'] is not None
    assert not result['trades']


def test_portfolio_seed_weights_and_kelly(prices):
    closes=pd.DataFrame({'a':prices.Close,'b':prices.Close.shift(3)}).dropna()
    a=optimize_weights(closes,simulations=100,seed=42)
    b=optimize_weights(closes,simulations=100,seed=42)
    assert a==b
    assert sum(a['weights'].values())==pytest.approx(1)
    assert kelly(.6,2)==pytest.approx(.4)
    with pytest.raises(ValueError):
        optimize_weights(closes.assign(b=100))
