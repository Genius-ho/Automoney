import numpy as np
import pandas as pd
import pytest
from stock_ai.config import Settings
from stock_ai.original_analysis import analyze,original_features
from stock_ai.features import expanded_features
from stock_ai.service import analyze_prices
from original_reference import original_result


@pytest.mark.parametrize('feature_set',['original','expanded'])
def test_only_last_five_calendar_years_are_used_for_training_and_validation(prices,feature_set):
    # Fixture ends 2023-11-24, so the five-year boundary is 2018-11-24.
    settings=Settings(feature_set=feature_set)
    r=analyze(prices,settings)
    assert all(f['train_start']>='2018-11-24' for f in r['folds'])
    assert all(p['date']>='2018-11-24' for p in r['predictions'])
    features=expanded_features(prices)[0] if feature_set=='expanded' else original_features(prices)
    recent=features.loc['2018-11-24':]
    _,reference=original_result(recent,prepared=True)
    trace=reference.attrs['reference_trace']
    assert r['sample_count']==len(recent)
    assert r['mean_precision']==np.mean(trace['precisions'])
    assert [p['signal'] for p in r['predictions']]==[v for fold in trace['predictions'][:-1] for v in fold]
    assert r['latest_signal']==trace['predictions'][-1][0]
    assert r['analysis_window']['cutoff']=='2018-11-24'
    assert r['analysis_window']['end']=='2023-11-24'
    if feature_set=='expanded':
        assert r['input_comparison']['start']>='2018-11-24'
        assert r['input_comparison']['models'][0]['actual_labels']==r['input_comparison']['models'][1]['actual_labels']


def test_report_and_simulations_use_the_same_recent_window(tmp_path,prices):
    r=analyze_prices(prices,Settings(feature_set='expanded'),{'code':'AMD','name':'AMD','market':'US'},
                     None,{'source':'fixture'},tmp_path,'d'*32,lambda *args:None)
    assert all(sim['equity'][0]['date']>='2018-11-24' for sim in r['simulations'].values())
    assert all(t['buy_date']>='2018-11-24' for sim in r['simulations'].values() for t in sim['trades'])
    assert '2018-11-24' in (tmp_path/('d'*32)/'report.md').read_text(encoding='utf-8')


def test_insufficient_indicator_history_remains_an_explicit_analysis_error(prices):
    with pytest.raises(ValueError,match='부족'):
        analyze(prices.iloc[:5],Settings())


def test_simulation_does_not_extend_beyond_latest_valid_analysis_day(tmp_path,prices):
    raw=prices.copy()
    raw.loc[raw.index[-1],'Volume']=np.nan
    r=analyze_prices(raw,Settings(),{'code':'AMD','name':'AMD','market':'US'},None,
                     {'source':'fixture'},tmp_path,'e'*32,lambda *args:None)
    assert r['as_of']=='2023-11-23'
    assert all(sim['equity'][-1]['date']=='2023-11-23' for sim in r['simulations'].values())
    assert r['chart'][-1]['date']=='2023-11-23'


def test_persisted_full_history_signal_cannot_reserve_new_paper_buy(tmp_path):
    from stock_ai.paper import PaperEngine
    from stock_ai.store import Store
    from test_paper_service import FakeProvider,morning
    engine=PaperEngine(Store(tmp_path/'paper.sqlite'),FakeProvider())
    engine.configure({'code':'000660','name':'test','market':'KR'},Settings(),True)
    engine.set_signal({'analysis_method':'original-close-v1','latest_signal':1,'as_of':'2020-01-02'})
    state=engine.reserve('2020-01-03',now=morning('2020-01-03'))
    assert state['pending'] is None
    assert state['orders']==[]


def test_configure_does_not_reuse_saved_full_history_analysis(tmp_path):
    from fastapi.testclient import TestClient
    from stock_ai.web import create_app
    from test_paper_service import FakeProvider
    symbol={'code':'000660','name':'test','market':'KR'}
    settings=Settings().model_dump()
    app=create_app(tmp_path,FakeProvider(),scheduler=False)
    app.state.store.put('latest_analysis',{'analysis_method':'original-close-v1','latest_signal':1,
                       'as_of':'2020-01-02','symbol':symbol,'settings':settings,'mean_precision':.8})
    with TestClient(app) as client:
        state=client.post('/api/paper/configure',json={'symbol':symbol,'settings':settings,'enabled':True}).json()
        assert state['signal'] is None
