import numpy as np
import pandas as pd
import pytest
from stock_ai.service import portfolio_job


SYMBOLS=[{'code':'005930','name':'Samsung','market':'KR'},
         {'code':'000660','name':'SK','market':'KR'}]


class Quotes:
    def __init__(self):self.calls=[]
    def prices(self,code,years,market):
        self.calls.append((code,years,market))
        dates=pd.bdate_range('2025-01-02',periods=100)
        values=100000*np.exp(np.cumsum(.001+np.sin(np.arange(100)/(3 if code=='005930' else 5))*.01))
        frame=pd.DataFrame({'Close':values},index=dates)
        if code=='000660':frame=frame.iloc[:-2]
        return frame,{'source':'fixture','last_date':str(frame.index[-1].date()),'warning':'fixture cache'}


def test_portfolio_returns_allocation_and_integer_share_plan_on_common_price_date():
    provider=Quotes()
    result=portfolio_job({'symbols':SYMBOLS,'capital':1000000,'years':5,
                          'buy_fee_pct':.015,'slippage_pct':.05},provider,lambda *_:None)
    assert len(result['allocations'])==2
    assert result['currency']=='KRW' and result['capital']==1000000
    assert result['common_rows']==98 and result['as_of']=='2025-05-19'
    assert sum(r['weight'] for r in result['allocations'])==pytest.approx(.5)
    assert sum(r['allocation'] for r in result['allocations'])==pytest.approx(500000)
    assert result['reserve_cash']==500000
    assert result['cash_weight']==pytest.approx(.5)
    assert result['sizing']['half_fraction']==pytest.approx(.5)
    assert all(r['mix_weight']==pytest.approx(.5) for r in result['allocations'])
    assert result['total_purchase_cost']+result['remaining_cash']==pytest.approx(1000000)
    for row in result['allocations']:
        assert isinstance(row['quantity'],int) and row['quantity']>=0
        assert row['purchase_cost']<=row['allocation']
        assert row['entry_price']==pytest.approx(row['close']*1.0005)
    assert all(years==5 for _,years,_ in provider.calls)
    assert result['warnings'] and result['symbols']==SYMBOLS


def test_small_us_budget_remains_cash_instead_of_forcing_fractional_shares():
    symbols=[{**s,'market':'US','code':c} for s,c in zip(SYMBOLS,['AAPL','AMD'])]
    result=portfolio_job({'symbols':symbols,'capital':1,'years':5},Quotes(),lambda *_:None)
    assert result['currency']=='USD' and result['total_purchase_cost']==0
    assert result['remaining_cash']==1
    assert all(r['quantity']==0 for r in result['allocations'])


def test_portfolio_rejects_duplicates_before_fetch():
    provider=Quotes()
    with pytest.raises(ValueError):
        portfolio_job({'symbols':[SYMBOLS[0],SYMBOLS[0]]},provider,lambda *_:None)
    assert not provider.calls


def test_mixed_portfolio_uses_krw_history_for_weights_and_keeps_budget_accounting():
    class Mixed(Quotes):
        def exchange_rates(self,years):
            dates=pd.bdate_range('2025-01-02',periods=100)
            return pd.DataFrame({'Close':np.linspace(1200,1400,100)},index=dates),{'source':'fixture'}
    provider=Mixed()
    symbols=[SYMBOLS[0],{'code':'GLD','name':'Gold','market':'US'}]
    result=portfolio_job({'symbols':symbols,'capital':10000000,'years':5,'currency':'KRW'},provider,lambda *_:None)
    assert result['currency']=='KRW' and result['exchange_rate']['rate']==1400
    assert result['settings']['currency']=='KRW'
    gold=result['allocations'][1]
    raw,_=provider.prices('GLD',5,'US')
    assert gold['close']==pytest.approx(raw.Close.iloc[-1]*1400)
    assert gold['native_close']==pytest.approx(raw.Close.iloc[-1]) and gold['quote_currency']=='USD'
    assert result['total_purchase_cost']+result['remaining_cash']==pytest.approx(10000000)
    assert all(r['purchase_cost']<=r['allocation'] for r in result['allocations'])
    assert result['reserve_cash']>=5000000
    kr,_=provider.prices('005930',5,'KR')
    expected=np.column_stack([kr.Close.pct_change().iloc[1:],(raw.Close*np.linspace(1200,1400,100)).pct_change().iloc[1:]]).mean(axis=1).mean()*252
    assert result['basket_metrics']['annual_return']==pytest.approx(expected)


def test_portfolio_excludes_older_cached_prices_from_selected_year_window():
    class LongQuotes:
        def prices(self,code,years,market):
            dates=pd.bdate_range('2018-01-01','2026-10-08')
            values=100*np.exp(np.cumsum(.0001+np.sin(np.arange(len(dates))/(3 if code=='005930' else 5))*.01))
            frame=pd.DataFrame({'Close':values},index=dates)
            return frame,{}
    result=portfolio_job({'symbols':SYMBOLS,'years':5},LongQuotes(),lambda *_:None)
    assert result['start']=='2021-10-08'
    assert result['as_of']=='2026-10-08'
    assert result['common_rows']==len(pd.bdate_range('2021-10-08','2026-10-08'))


def test_negative_edge_portfolio_keeps_all_capital_as_cash():
    class LosingQuotes:
        def prices(self,code,years,market):
            day=np.arange(100)
            return pd.DataFrame({'Close':100*np.cumprod(1-.004+.001*np.sin(day/3))},
                                index=pd.bdate_range('2025-01-02',periods=100)),{}
    result=portfolio_job({'symbols':SYMBOLS,'capital':1000000},LosingQuotes(),lambda *_:None)
    assert result['sizing']['half_fraction']==0
    assert result['remaining_cash']==1000000 and result['reserve_cash']==1000000
    assert result['total_purchase_cost']==0 and result['sharpe'] is None
    assert all(r['allocation']==0 and r['quantity']==0 for r in result['allocations'])


def test_exact_share_cost_budget_buys_one_share_without_float_rounding_loss():
    from stock_ai.portfolio import allocation_plan
    from stock_ai.config import Settings
    symbols=[{'code':'A','name':'First','market':'US'},{'code':'B','name':'Second','market':'US'}]
    weights={'First (A)':.5,'Second (B)':.5}
    closes=pd.Series({'First (A)':200,'Second (B)':200})
    rows=allocation_plan(weights,closes,symbols,400.06,Settings(buy_fee_pct=.015,slippage_pct=0))
    assert [r['allocation'] for r in rows]==[200.03,200.03]
    assert [r['quantity'] for r in rows]==[1,1]
    assert sum(r['cash_left'] for r in rows)==0
