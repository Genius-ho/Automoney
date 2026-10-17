import numpy as np
import pandas as pd
import pytest
from stock_ai.analysis import analyze
from stock_ai.model import purged_partition
from stock_ai.config import Settings


def test_partition_purges_actual_label_end_dates():
    dates = pd.bdate_range('2020-01-01', periods=500)
    samples = pd.DataFrame({'y':np.arange(500)%2, 'label_end':dates+pd.offsets.BDay(10)},index=dates)
    train, cal = purged_partition(samples, np.arange(400), np.arange(400,500))
    assert samples.iloc[train].label_end.max() < samples.index[cal[0]]
    assert samples.iloc[cal].label_end.max() < samples.index[400]
    assert len(train) >= 200 and len(cal) >= 50


def test_real_xgboost_analysis_and_comparison_no_holdout_overlap(prices):
    result = analyze(prices, Settings(), compare=True)
    assert 0 <= result['latest_probability'] <= 1
    assert result['feature_count'] == 47
    assert len(result['folds']) >= 2
    assert result['holdout']['n'] >= 100
    assert len(result['variants']) == 15  # 12 groups + original/full + constant
    assert max(x['test_end'] for x in result['folds']) < result['holdout']['start']
    assert all(x['train_label_end'] < x['cal_start'] and x['cal_label_end'] < x['test_start']
               for x in result['folds'])
    assert all(0<=r['probability']<=1 for r in result['predictions'])


def test_one_class_does_not_make_up_probability(prices):
    with pytest.raises(ValueError, match='유효|클래스|자료'):
        analyze(prices, Settings(target_pct=100), compare=False)
