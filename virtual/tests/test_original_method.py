from datetime import date
import numpy as np
import pandas as pd
import pytest
from stock_ai import service
from stock_ai.config import Settings
from stock_ai.data import DataProvider
from stock_ai.simulation import simulate
from original_reference import original_result


def test_default_service_engine_matches_original_function_bodies(prices):
    raw=prices.iloc[:1000].copy()
    raw['Change']=raw.Close.pct_change(fill_method=None)
    expected,features=original_result(raw)
    result=service.analyze(raw,Settings(),symbol={'code':'005930','name':'test','market':'KR'})
    assert result.get('analysis_method')=='original-close-v1'
    assert f"{result['mean_precision']*100:.2f}%" in expected
    assert bool(result['latest_signal']) == ('가능성 높음' in expected)
    assert result['feature_count']==11
    assert list(result['latest_features'])==features.columns.tolist()
    np.testing.assert_allclose(list(result['latest_features'].values()),features.iloc[-1].values)
    assert 'latest_probability' not in result
    assert result['holdout'] is None
    assert all('signal' in p and 'probability' not in p for p in result['predictions'])
    trace=features.attrs['reference_trace']
    assert result['mean_precision']==np.mean(trace['precisions'])
    assert [f['precision'] for f in result['folds'] if not f['skipped']]==trace['precisions']
    assert [p['signal'] for p in result['predictions']]==[v for fold in trace['predictions'][:-1] for v in fold]
    assert result['latest_signal']==trace['predictions'][-1][0]


def test_trading_costs_do_not_change_original_analysis(prices):
    raw=prices.iloc[:1000].copy()
    a=service.analyze(raw,Settings(),compare=False)
    assert a.get('analysis_method')=='original-close-v1'
    b=service.analyze(raw,Settings(capital=1,buy_fee_pct=4,sell_tax_pct=40,
                                  slippage_pct=4,threshold_pct=100),compare=False)
    assert a['mean_precision']==b['mean_precision']
    assert a['latest_signal']==b['latest_signal']
    assert a['predictions']==b['predictions']


def test_original_provider_keeps_source_rows_and_calls_without_start(tmp_path,monkeypatch):
    import FinanceDataReader as fdr
    raw=pd.DataFrame([[0,0,0,53000,0,.01],[31860,32159,31800,32160,185799,-.02]],
                     columns=['Open','High','Low','Close','Volume','Change'],
                     index=pd.to_datetime(['2018-04-30','2016-10-24']).rename('Date'))
    calls=[]
    def fetch(*args):
        calls.append(args)
        return raw.copy()
    monkeypatch.setattr(fdr,'DataReader',fetch)
    provider=DataProvider(tmp_path)
    assert callable(getattr(provider,'original_prices',None))
    frame,meta=provider.original_prices('005930','KR')
    assert calls==[('005930',)]
    pd.testing.assert_frame_equal(frame,raw)
    assert meta['source']=='FinanceDataReader'
    assert (tmp_path/'original_KR_005930.csv').is_file()


def test_analysis_job_does_not_fetch_market_or_use_cleaned_prices(tmp_path,prices):
    class Provider:
        def original_prices(self,code,market):
            assert code=='000660' and market=='KR'
            return prices.iloc[:1000],{'source':'fixture','last_date':'2020-10-30','warning':None}
        def prices(self,*args,**kw):
            pytest.fail('Original analysis must use raw source data and no market lookup')
    result=service.analysis_job({'symbol':{'code':'000660','name':'test','market':'KR'}},
                                Provider(),tmp_path,'a'*32,lambda *args:None)
    assert result['analysis_method']=='original-close-v1'
    assert '평균 적중률' in (tmp_path/('a'*32)/'report.md').read_text(encoding='utf-8')


def test_binary_simulation_does_not_interpret_mean_precision_as_probability(prices):
    raw=prices.iloc[:30].copy()
    result=simulate(raw,[{'date':str(raw.index[0].date()),'signal':1}],
                    Settings(threshold_pct=100),mode='touch')
    assert result['trade_count']==1
    assert result['trades'][0]['entry_signal']==1
    assert result['trades'][0]['probability'] is None


def test_original_has_visible_error_when_all_training_folds_have_one_class(prices):
    with pytest.raises(ValueError,match='유효한 검증 구간'):
        service.analyze(prices.iloc[:1000],Settings(target_pct=100))


def test_paper_binary_signal_ignores_probability_threshold(tmp_path):
    from stock_ai.paper import PaperEngine
    from stock_ai.store import Store
    from test_paper_service import FakeProvider,morning
    engine=PaperEngine(Store(tmp_path/'paper.sqlite'),FakeProvider())
    engine.configure({'code':'000660','name':'test','market':'KR'},Settings(threshold_pct=100),True)
    engine.set_signal({'latest_signal':1,'analysis_method':'original-close-v1','training_version':'recent-5y-v1','as_of':'2020-01-02'})
    state=engine.reserve('2020-01-03',now=morning('2020-01-03'))
    assert state['pending']['entry_signal']==1
    assert state['pending']['probability'] is None


def test_paper_api_configure_and_prepare_use_binary_original_signal(tmp_path,monkeypatch):
    from fastapi.testclient import TestClient
    from stock_ai.web import create_app
    from test_paper_service import FakeProvider
    symbol={'code':'000660','name':'test','market':'KR'}
    settings=Settings().model_dump()
    app=create_app(tmp_path,FakeProvider(),scheduler=False)
    prediction={'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1,'as_of':'2020-01-02',
                'symbol':symbol,'settings':settings,'mean_precision':0,'analysis_window':{'years':5}}
    app.state.store.put('latest_analysis',prediction)
    app.state.paper.predictor=lambda *args:prediction
    with TestClient(app) as client:
        response=client.post('/api/paper/configure',json={'symbol':symbol,'settings':settings,'enabled':True})
        assert response.status_code==200
        assert response.json()['signal']['latest_signal']==1
        assert response.json()['signal']['training_version']=='recent-5y-v1'
        assert 'probability' not in response.json()['signal']
        from test_web import wait_for_job
        job=wait_for_job(client,client.post('/api/paper/prepare').json()['id'])
        assert job['status']=='done',job['error']
        assert job['result']['signal']['latest_signal']==1
        assert job['result']['signal']['training_version']=='recent-5y-v1'


def test_batch_raw_input_preserves_each_stocks_full_history(tmp_path,prices,monkeypatch):
    seen=[]
    class Provider:
        def original_prices(self,code,market):
            raw=prices.iloc[100:] if code=='207940' else prices
            return raw,{'source':'raw','warning':None}
        def prices(self,*args):
            pytest.fail('No cleaned or market data in original batch')
    def capture(raw,settings,symbol,market,meta,*args):
        seen.append((symbol['code'],len(raw),market))
        return {'analysis_method':'original-close-v1','training_version':'recent-5y-v1','as_of':str(raw.index[-1].date()),
                'mean_precision':.1 if symbol['code']=='207940' else .2}
    monkeypatch.setattr(service,'analyze_prices',capture)
    result=service.batch_job(Settings(),Provider(),tmp_path,'b'*32,lambda *args:None)
    assert result['errors']==[]
    assert len(seen)==5
    assert all(n==(len(prices)-100 if code=='207940' else len(prices)) and market is None
               for code,n,market in seen)
    assert result['ranking'][-1]['mean_precision']==.1
    assert result['comparison_window'] is None


def test_persisted_expanded_signal_cannot_create_new_paper_buy(tmp_path):
    from stock_ai.paper import PaperEngine
    from stock_ai.store import Store
    from test_paper_service import FakeProvider,morning
    engine=PaperEngine(Store(tmp_path/'paper.sqlite'),FakeProvider())
    engine.configure({'code':'000660','name':'test','market':'KR'},Settings(),True)
    engine.set_signal({'probability':.99,'as_of':'2020-01-02'})
    state=engine.reserve('2020-01-03',now=morning('2020-01-03'))
    assert state['pending'] is None
    assert not state['orders']


def test_raw_source_without_change_matches_original_source_columns(prices):
    raw=prices.iloc[:1000].copy()
    expected,features=original_result(raw)
    result=service.analyze(raw,Settings())
    assert list(result['latest_features'])==list(features.columns)
    assert result['mean_precision']==np.mean(features.attrs['reference_trace']['precisions'])


def test_original_dropna_result_remains_json_serializable(prices):
    import json
    raw=prices.iloc[:1000].copy()
    raw.loc[raw.index[-10],'Close']=np.nan
    result=service.analyze(raw,Settings())
    json.dumps(result,allow_nan=False)


def test_raw_batch_does_not_require_common_history(tmp_path,prices,monkeypatch):
    class Provider:
        def original_prices(self,code,market):
            raw=prices.iloc[:900] if code=='207940' else prices.iloc[900:]
            return raw,{'source':'raw','warning':None}
    monkeypatch.setattr(service,'analyze_prices',lambda raw,*args:
                        {'mean_precision':.2,'as_of':str(raw.index[-1].date())})
    result=service.batch_job(Settings(),Provider(),tmp_path,'b'*32,lambda *args:None)
    assert len(result['ranking'])==5
    assert result['errors']==[]
