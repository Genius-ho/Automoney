import numpy as np
import pandas as pd
import pytest
from stock_ai.config import Settings
from stock_ai.original_analysis import analyze,original_features
from original_reference import original_result


def raw_prices(prices):
    raw=prices.iloc[:1000].copy()
    raw['Change']=raw.Close.pct_change(fill_method=None)
    return raw


def test_expanded_inputs_retain_original_features_and_use_researched_groups(prices):
    from stock_ai.features import expanded_features
    raw=raw_prices(prices)
    features,groups,notes=expanded_features(raw)
    original=original_features(raw)
    assert len(features.columns)==55
    pd.testing.assert_frame_equal(features[original.columns],original.loc[features.index])
    assert {'macd','directional','oscillators','money_flow','donchian'}<=set(groups)
    assert {'RSI','Disparity','MA20','Upper','Lower','stoch_k','macd_relative','adx_14','volume_ratio_20'}<=set(features.columns)
    assert not {'rsi_14','ema_gap_20','return_1'}&set(features.columns)
    changed=raw.copy();changed.iloc[700:,:5]*=2
    altered,_,_=expanded_features(changed)
    pd.testing.assert_frame_equal(features.loc[:raw.index[699]],altered.loc[:raw.index[699]])
    assert np.isfinite(features.to_numpy()).all()


def test_extended_model_keeps_source_label_training_and_precision_procedure(prices):
    from stock_ai.features import expanded_features
    raw=raw_prices(prices)
    features,_,_=expanded_features(raw)
    _,reference=original_result(features,prepared=True)
    result=analyze(raw,Settings(feature_set='expanded'),compare=True)
    trace=reference.attrs['reference_trace']
    assert result['analysis_method']=='original-close-v1'
    assert result['feature_set']=='expanded' and result['feature_count']==55
    assert result['mean_precision']==np.mean(trace['precisions'])
    assert [p['signal'] for p in result['predictions']]==[v for fold in trace['predictions'][:-1] for v in fold]
    assert result['latest_signal']==trace['predictions'][-1][0]
    assert 'latest_probability' not in result
    comparison=result['input_comparison']
    assert comparison['same_dates'] is True
    a,b=comparison['models']
    assert a['feature_count']==11 and b['feature_count']==55
    assert [(f['test_start'],f['test_end'],f['n']) for f in a['folds']]==[(f['test_start'],f['test_end'],f['n']) for f in b['folds']]
    assert a['actual_labels']==b['actual_labels']==[p['actual'] for p in result['predictions']]


def test_missing_and_stale_market_omit_market_inputs_without_using_future(prices):
    from stock_ai.features import expanded_features
    raw=raw_prices(prices)
    stale=raw.iloc[:-1]
    f,g,w=expanded_features(raw,stale)
    assert f.shape[1]==55 and 'market' not in g
    assert any('시장' in note for note in w)
    fresh=raw.copy()
    f,g,w=expanded_features(raw,fresh)
    assert f.shape[1]==58 and len(g['market'])==3
    changed=fresh.copy();changed.iloc[700:,:4]*=2
    altered,_,_=expanded_features(raw,changed)
    pd.testing.assert_frame_equal(f.loc[:raw.index[699]],altered.loc[:raw.index[699]])


def test_original_mode_is_still_available_with_unchanged_source_calculation(prices):
    raw=raw_prices(prices)
    expected,reference=original_result(raw)
    result=analyze(raw,Settings(feature_set='original'))
    assert result['feature_count']==11
    assert result['mean_precision']==np.mean(reference.attrs['reference_trace']['precisions'])


def test_expanded_csv_api_reports_and_settings_survive_restart(tmp_path,prices):
    from fastapi.testclient import TestClient
    from stock_ai.web import create_app
    from test_paper_service import FakeProvider
    from test_web import wait_for_job
    with TestClient(create_app(tmp_path,FakeProvider(),scheduler=False)) as client:
        settings=Settings(feature_set='expanded').model_dump()
        assert client.put('/api/settings',json=settings).status_code==200
        response=client.post('/api/analyze',json={'symbol':{'code':'068270','name':'셀트리온','market':'KR'},
                                                'settings':settings,'csv':raw_prices(prices).to_csv()})
        job=wait_for_job(client,response.json()['id'])
        assert job['status']=='done',job['error']
        r=job['result']
        assert r['feature_set']=='expanded' and r['feature_count']==55
        assert len(r['input_comparison']['models'])==2
        assert client.get('/api/reports/'+r['report_id']+'/comparison.csv').text.count('mean_precision')==1
    with TestClient(create_app(tmp_path,FakeProvider(),scheduler=False)) as client:
        assert client.get('/api/settings').json()['feature_set']=='expanded'
        assert client.get('/api/latest').json()['report_id']==r['report_id']
