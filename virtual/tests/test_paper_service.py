from datetime import datetime
from zoneinfo import ZoneInfo
import time
import pandas as pd
import pytest
from stock_ai.config import Settings
from stock_ai.store import Store
from stock_ai.paper import PaperEngine
from stock_ai.service import JobService


class FakeProvider:
    def prices(self, code, years=10, market='KR', **kw):
        df=pd.DataFrame({'Open':[100]*3,'High':[100,104,104],'Low':[99]*3,
                         'Close':[100]*3,'Volume':[1000]*3},index=pd.bdate_range('2020-01-02',periods=3))
        return df,{'source':'test','last_date':'2020-01-06','warning':None}


def test_paper_restart_idempotence_and_frozen_position_settings(tmp_path):
    path=tmp_path/'db.sqlite'
    store=Store(path)
    engine=PaperEngine(store,FakeProvider(),predictor=lambda df,s,symbol:{'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1,'as_of':'2020-01-02'})
    s=Settings(buy_fee_pct=0,sell_fee_pct=0,sell_tax_pct=0,slippage_pct=0,fill_buffer_pct=0)
    engine.configure({'code':'005930','name':'삼성전자','market':'KR'},s,True)
    engine.set_signal({'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1,'as_of':'2020-01-02'})
    morning=datetime(2020,1,3,8,tzinfo=ZoneInfo('Asia/Seoul'))
    assert engine.reserve('2020-01-03',now=morning)['pending'] is not None
    restarted=PaperEngine(Store(path),FakeProvider(),predictor=engine.predictor)
    restarted.reconcile('2020-01-03')
    restarted.reconcile('2020-01-03')
    state=restarted.status()
    assert len(state['trades'])==1
    assert state['cash']==10200000
    assert state['position'] is None


def test_holiday_and_late_reservation_do_not_backdate_buys(tmp_path):
    engine=PaperEngine(Store(tmp_path/'db'),FakeProvider())
    engine.configure({'code':'005930','market':'KR','name':'삼성전자'},Settings(),True)
    engine.set_signal({'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1,'as_of':'2020-01-02'})
    assert engine.reserve('2020-01-04')['pending'] is None
    late=datetime(2020,1,3,10,tzinfo=ZoneInfo('Asia/Seoul'))
    assert engine.reserve('2020-01-03',now=late)['pending'] is None


def test_job_failure_is_persistent_and_does_not_block_other_jobs(tmp_path):
    store=Store(tmp_path/'db')
    service=JobService(store)
    def fail(progress):
        raise ValueError('price unavailable')
    job=service.submit('test',fail)
    for _ in range(100):
        if service.get(job)['status']=='failed':break
        time.sleep(.01)
    assert service.get(job)['status']=='failed'
    assert 'price unavailable' in service.get(job)['error']
    assert Store(tmp_path/'db').get('job:'+job)['status']=='failed'
    service.close()


def quiet_settings(**changes):
    return Settings(buy_fee_pct=0, sell_fee_pct=0, sell_tax_pct=0,
                    slippage_pct=0, fill_buffer_pct=0, **changes)


def morning(day):
    return datetime.fromisoformat(day + 'T08:00:00').replace(tzinfo=ZoneInfo('Asia/Seoul'))


def configured_engine(tmp_path, provider=None, predictor=None):
    engine = PaperEngine(Store(tmp_path/'paper.sqlite'), provider or FakeProvider(),
                         predictor=predictor or (lambda df, s, symbol:
                         {'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1, 'as_of': str(df.index[-1].date())}))
    engine.configure({'code': '005930', 'name': '삼성전자', 'market': 'KR'}, quiet_settings(), True)
    engine.set_signal({'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1, 'as_of': '2020-01-02'})
    engine.reserve('2020-01-03', now=morning('2020-01-03'))
    return engine


def test_position_survives_restart_and_keeps_entry_costs_after_setting_change(tmp_path):
    class Provider(FakeProvider):
        def prices(self, *args, **kw):
            df, meta = super().prices(*args, **kw)
            df.loc['2020-01-03', 'High'] = 100
            return df, meta
    engine = configured_engine(tmp_path, Provider())
    engine.reconcile('2020-01-03')
    assert engine.status()['position']['quantity'] == 100000
    assert engine.status()['position']['target'] == 102
    restarted = PaperEngine(Store(tmp_path/'paper.sqlite'), Provider(), engine.predictor)
    restarted.configure(engine.status()['symbol'],
                         Settings(target_pct=20, sell_tax_pct=10, horizon=1), True)
    assert restarted.status()['position']['target'] == 102
    assert restarted.status()['position']['costs']['sell_tax_pct'] == 0
    restarted.reserve('2020-01-06', now=morning('2020-01-06'))
    restarted.reconcile('2020-01-06')
    assert restarted.status()['cash'] == 10200000
    assert restarted.status()['trades'][0]['sell_tax'] == 0


def test_changing_symbol_cancels_unfilled_reservation(tmp_path):
    engine = configured_engine(tmp_path)
    engine.configure({'code': '009150', 'name': '삼성전기', 'market': 'KR'}, quiet_settings(), True)
    assert engine.status()['pending'] is None
    engine.reconcile('2020-01-03')
    assert engine.status()['trades'] == []
    assert engine.status()['cash'] == 10000000
    assert engine.status()['orders'][0]['status'] == 'cancelled'


def test_symbol_switch_liquidates_old_position_before_new_symbol_buys(tmp_path):
    class Provider(FakeProvider):
        def prices(self, code, *args, **kw):
            df, meta = super().prices(code, *args, **kw)
            df.High = 100
            if code == '005930':
                df.loc['2020-01-06', ['Open', 'High', 'Low', 'Close']] = [90, 100, 89, 95]
            return df, meta
    engine = configured_engine(tmp_path, Provider())
    engine.reconcile('2020-01-03')
    engine.configure({'code': '009150', 'name': '삼성전기', 'market': 'KR'}, quiet_settings(), True)
    engine.reserve('2020-01-06', now=morning('2020-01-06'))
    engine.reconcile('2020-01-06')
    state = engine.status()
    assert state['position'] is None
    assert state['cash'] == 9000000
    assert len(state['trades']) == 1
    assert state['trades'][0]['reason'] == 'switch'
    assert state['trades'][0]['symbol']['code'] == '005930'
    assert state['signal']['code'] == '009150'


def test_setting_change_during_prediction_does_not_attach_old_signal_to_new_settings(tmp_path):
    engine = configured_engine(tmp_path)
    def changed_prediction(df, settings, symbol):
        engine.configure({'code': '009150', 'name': '삼성전기', 'market': 'KR'},
                         quiet_settings(target_pct=5), True)
        return {'analysis_method':'original-close-v1','training_version':'recent-5y-v1','latest_signal':1, 'as_of': '2020-01-03'}
    engine.predictor = changed_prediction
    engine.reconcile('2020-01-03')
    assert engine.status()['symbol']['code'] == '009150'
    assert engine.status()['signal'] is None


def test_no_completed_bar_leaves_trade_unprocessed_and_retryable(tmp_path):
    class StaleProvider(FakeProvider):
        def prices(self, *args, **kw):
            df, meta = super().prices(*args, **kw)
            return df.iloc[:1], meta
    engine = configured_engine(tmp_path, StaleProvider())
    state = engine.reconcile('2020-01-03')
    assert state['cash'] == 10000000 and not state['trades']
    assert '2020-01-03' not in state['processed']
    engine.provider = FakeProvider()
    assert len(engine.reconcile('2020-01-03')['trades']) == 1


def test_closed_job_service_does_not_persist_an_unrunnable_job(tmp_path):
    store = Store(tmp_path/'db')
    service = JobService(store)
    service.close()
    with pytest.raises(ValueError, match='종료'):
        service.submit('test', lambda progress: {'ok': True})
    assert store.keys('job:') == []


def test_job_admission_limit_is_atomic_across_submitters(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier, Event
    service = JobService(Store(tmp_path/'db'))
    barrier, release = Barrier(8), Event()
    def submit_one():
        barrier.wait()
        try:
            return service.submit('test', lambda progress: release.wait(10))
        except ValueError:
            return None
    try:
        with ThreadPoolExecutor(max_workers=8) as clients:
            admitted = list(clients.map(lambda _: submit_one(), range(8)))
        assert sum(identifier is not None for identifier in admitted) == 3
    finally:
        release.set()
        service.close()


def test_display_metadata_refresh_preserves_reserved_buy_and_signal_identity(tmp_path):
    engine = configured_engine(tmp_path)
    old_symbol = engine.status()['symbol'].copy()
    pending = engine.status()['pending'].copy()
    refreshed = {**old_symbol, 'name': '???? ? ???', 'asset_type': 'stock', 'industry': '???'}
    state = engine.configure(refreshed, quiet_settings(), True)
    assert state['pending'] == pending
    assert state['orders'][0]['status'] == 'reserved'
    assert engine.set_signal({'latest_signal': 1}, expected_symbol=old_symbol,
                             expected_settings=quiet_settings().model_dump())
