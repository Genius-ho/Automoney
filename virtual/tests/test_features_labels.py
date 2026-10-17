import numpy as np
import pandas as pd
from stock_ai.features import build_features, baseline_features
from stock_ai.labels import make_labels
from stock_ai.config import Settings


def test_feature_counts_and_future_changes_do_not_change_past(prices):
    market = prices.Close.rename('Close').to_frame()
    full, groups = build_features(prices, market)
    assert full.shape[1] == 50
    assert len(groups) == 13
    assert baseline_features(prices).shape[1] == 11
    reduced, _ = build_features(prices)
    assert reduced.shape[1] == 47
    changed = prices.copy()
    changed.iloc[1000:, :4] *= 2
    altered, _ = build_features(changed, market)
    pd.testing.assert_frame_equal(full.iloc[:1000], altered.iloc[:1000])
    assert np.isfinite(full.dropna().to_numpy()).all()


def test_flat_prices_zero_volume_produce_finite_neutral_features():
    df = pd.DataFrame({k: ([0]*100 if k == 'Volume' else [100]*100)
                       for k in ['Open','High','Low','Close','Volume']}, index=pd.bdate_range('2020-01-01', periods=100))
    f, _ = build_features(df)
    assert np.isfinite(f.iloc[-1].to_numpy()).all()
    assert f.iloc[-1]['rsi_14'] == 50
    assert f.iloc[-1]['stoch_k'] == 50


def test_labels_next_open_costs_horizon_and_unobserved_tail():
    df = pd.DataFrame({'Open':[100, 200, 200, 200], 'High':[150,201,205,201],
                       'Low':[99,199,199,199], 'Close':[100,200,200,200], 'Volume':[10]*4},
                      index=pd.bdate_range('2020-01-01', periods=4))
    s = Settings(horizon=2, capital=1000, buy_fee_pct=0, sell_fee_pct=0,
                 sell_tax_pct=0, slippage_pct=0)
    labels = make_labels(df, s)
    assert labels.iloc[0]['entry'] == 200
    assert labels.iloc[0]['target'] == 204
    assert labels.iloc[0]['y'] == 1
    assert labels.iloc[0]['label_end'] == df.index[2]
    assert labels.iloc[-2:]['y'].isna().all()
