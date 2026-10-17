import importlib
import numpy as np
import pandas as pd
import pytest


def module():
    return importlib.import_module('stock_ai.universe')


def test_market_rank_includes_global_and_is_independent():
    rows=[]
    for market,offset in [('KOSPI',100),('KOSDAQ',200)]:
        for i in range(55):
            rows.append(dict(Code=str(offset+i).zfill(6),Name=str(i),Market=market,Marcap=1000-i))
    rows[55]['Market']='KOSDAQ GLOBAL'
    result=module().rank_universe(pd.DataFrame(rows))
    assert len(result)==100 and len({r['code'] for r in result})==100
    assert result[50]['exchange']=='KOSDAQ' and result[50]['rank']==1
    assert result[0]['rank']==1 and result[49]['rank']==50


def test_incomplete_universe_rejected():
    with pytest.raises(ValueError,match='50'):
        module().rank_universe(pd.DataFrame([dict(Code='005930',Name='a',Market='KOSPI',Marcap=10)]))


def test_labels_use_future_close_not_high_and_unknown_tail():
    df=pd.DataFrame({'Close':[100,101,106,100,100], 'High':[200]*5},index=pd.bdate_range('2024-01-01',periods=5))
    sample=module().close_samples(df,horizon=2,target=5)
    assert sample.y.tolist()==[1,0,0]
    assert sample.label_end.tolist()==list(df.index[2:])


def test_unknown_future_close_is_not_a_negative_label():
    df=pd.DataFrame({'Close':[100,101,float('nan'),100,100]},index=pd.bdate_range('2024-01-01',periods=5))
    with pytest.raises(ValueError,match='종가'):
        module().close_samples(df,horizon=2,target=5)


def test_probability_forecast_recent_window_and_purge():
    dates=pd.bdate_range('2017-01-01','2026-10-07')
    rng=np.random.default_rng(7)
    close=100*np.exp(np.cumsum(rng.normal(0,.025,len(dates))))
    raw=pd.DataFrame(dict(Open=close,High=close*1.02,Low=close*.98,Close=close,Volume=rng.integers(100,500,len(dates)),Change=pd.Series(close).pct_change().to_numpy()),index=dates)
    result=module().forecast(raw,'probability')
    assert 0<=result['probability']<=1
    assert result['window_start']>='2021-10-07'
    assert result['train_label_end']<result['calibration_start']
    assert result['calibration_label_end']<result['as_of']
    assert result['horizon']==10 and result['target_pct']==5


@pytest.mark.parametrize('probability,signal',[(.51,0),(.5999,0),(.6,1),(.6001,1)])
def test_precision_entry_signal_requires_sixty_percent(prices,monkeypatch,probability,signal):
    from stock_ai import original_analysis
    class Model:
        def __init__(self,**kwargs):
            pass
        def fit(self,x,y):
            self.feature_importances_=np.zeros(x.shape[1])
        def predict(self,x):
            return np.ones(len(x),dtype=int)
        def predict_proba(self,x):
            return np.tile([1-probability,probability],(len(x),1))
    monkeypatch.setattr(original_analysis,'XGBClassifier',Model)
    result=module().forecast(prices,'precision')
    assert result['signal']==signal
    assert result['signal_probability']==probability
    assert result['signal_threshold']==.6
    assert result['probability'] is None
    reference=original_analysis.analyze(prices,module().Settings(feature_set='expanded',horizon=10,target_pct=5),compare=False)
    assert result['precision']==reference['mean_precision']
    assert reference['latest_signal']==1


def test_kospi_only_quota_for_comparison_a():
    rows=[dict(Code=str(i).zfill(6),Name=str(i),Market='KOSPI' if i<120 else 'KOSDAQ',Marcap=1000-i) for i in range(200)]
    result=module().rank_universe(pd.DataFrame(rows),(('KOSPI',100),))
    assert len(result)==100 and {r['exchange'] for r in result}=={'KOSPI'} and result[0]['rank']==1
