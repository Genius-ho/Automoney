import numpy as np
import pandas as pd
import pytest
from stock_ai.portfolio import optimize_weights


def dominant_stock(count=4):
    day=np.arange(180)
    changes=[.004+.012*np.sin(day/3)]
    changes.extend(-.002+.006*np.sin(day/3) for i in range(count-1))
    return pd.DataFrame({str(i):100*np.cumprod(1+r) for i,r in enumerate(changes)})


def test_constrained_portfolio_limits_a_dominant_stock_and_keeps_all_selected_stocks():
    closes=dominant_stock()
    original=optimize_weights(closes)
    assert original['weights']['0']>.8
    result=optimize_weights(closes,min_weight=.05,max_weight=.4)
    weights=np.array(list(result['weights'].values()))
    assert weights.sum()==pytest.approx(1)
    assert (weights>=.05-1e-12).all() and (weights<=.4+1e-12).all()
    assert result['samples']==20000
    assert result['weights']==optimize_weights(closes,min_weight=.05,max_weight=.4)['weights']


@pytest.mark.parametrize('count,minimum,maximum',[(3,.05,.4),(4,.2499,.2501),(10,.09,.11)])
def test_tight_feasible_constraints_still_produce_a_valid_portfolio(count,minimum,maximum):
    result=optimize_weights(dominant_stock(count),min_weight=minimum,max_weight=maximum)
    weights=list(result['weights'].values())
    assert sum(weights)==pytest.approx(1)
    assert min(weights)>=minimum-1e-12 and max(weights)<=maximum+1e-12


def test_two_stock_diversification_uses_equal_weights_for_a_forty_percent_setting():
    result=optimize_weights(dominant_stock(2),min_weight=.05,max_weight=.4)
    assert list(result['weights'].values())==pytest.approx([.5,.5])
    assert result['constraints']['effective_max_weight_pct']==50


@pytest.mark.parametrize('minimum,maximum',[(.3,.4),(.05,.2),(.4,.3),(float('nan'),.4),(.05,float('inf'))])
def test_impossible_or_nonfinite_weight_limits_are_rejected(minimum,maximum):
    with pytest.raises(ValueError):
        optimize_weights(dominant_stock(),min_weight=minimum,max_weight=maximum)


def test_half_kelly_matches_a_known_two_outcome_solution():
    from stock_ai.portfolio import half_kelly_fraction
    # p=.6, gain=1, loss=.5: full Kelly=.6/.5-.4/1=.8.
    result=half_kelly_fraction([1,1,1,-.5,-.5])
    assert result['full_fraction']==pytest.approx(.8)
    assert result['half_fraction']==pytest.approx(.4)
    assert result['observations']==5


@pytest.mark.parametrize('returns,full,half',[
    ([-.1,.1],0,0),([-.1,-.2],0,0),([.02,-.01],1,.5)])
def test_half_kelly_retains_cash_and_never_leverages(returns,full,half):
    from stock_ai.portfolio import half_kelly_fraction
    result=half_kelly_fraction(returns)
    assert result['full_fraction']==pytest.approx(full)
    assert result['half_fraction']==pytest.approx(half)


@pytest.mark.parametrize('returns',[[],[float('nan')],[float('inf')],[-1,.1]])
def test_half_kelly_rejects_undefined_price_returns(returns):
    from stock_ai.portfolio import half_kelly_fraction
    with pytest.raises(ValueError):half_kelly_fraction(returns)
