import importlib
import pandas as pd
import pytest
from stock_ai.store import Store


class Universe:
    def snapshot(self):
        return {'rows':[dict(code=str(i+1).zfill(6),name=str(i),market='KR',exchange='KOSPI' if i<50 else 'KOSDAQ',rank=i%50+1) for i in range(100)],'source':'fixture','retrieved_at':'2026-09-01','warning':None}


class Quotes:
    def __init__(self):
        self.day='2026-09-01'
        self.price=100
        self.missing=set()
    def original_prices(self,code,market='KR'):
        if code in self.missing:
            raise ValueError('unavailable')
        df=pd.DataFrame(dict(Open=[self.price],High=[self.price*2],Low=[self.price*.5],Close=[self.price],Volume=[100],Change=[0]),index=pd.to_datetime([self.day]))
        return df,{'source':'fixture','last_date':self.day}


def engine(tmp_path):
    cls=importlib.import_module('stock_ai.universe_paper').UniversePaperEngine
    quotes=Quotes()
    def predict(raw,criterion):
        return {'as_of':str(raw.index[-1].date()),'probability':.7,'precision':.7,'signal':1}
    return cls(Store(tmp_path/'book.sqlite'),quotes,Universe(),predictor=predict),quotes


def test_repeat_scan_reports_skip_without_prices_training_or_ledger_change(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    book.scan(day=quotes.day)
    before=book.store.get('universe_paper')
    def forbidden(*args,**kwargs):
        raise AssertionError('Repeated cycle must not fetch or train')
    book._prices=forbidden
    book.predictor=forbidden
    result=book.scan(day=quotes.day)
    assert result['scan_execution']['status']=='skipped'
    assert result['scan_execution']['next_scan_day']=='2026-09-09'
    assert '재학습' in result['scan_execution']['message']
    assert book.store.get('universe_paper')==before


def test_scan_progress_identifies_current_stock_before_fetch_and_training(tmp_path):
    book,quotes=engine(tmp_path)
    events=[]
    original_prices=book._prices
    original_predict=book.predictor
    def prices(*args):
        assert '완료 일봉 조회' in events[-1][1]
        assert args[0] in events[-1][1]
        return original_prices(*args)
    def predict(*args):
        assert '지표 계산·모델 학습' in events[-1][1]
        return original_predict(*args)
    book._prices=prices
    book.predictor=predict
    result=book.scan(day=quotes.day,progress=lambda p,m:events.append((p,m)))
    assert result['scan']['analyzed']==100
    assert result['scan_execution']['status']=='completed'


def started(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    result=book.scan(day='2026-09-01')
    assert len(result['pending'])==100 and result['positions']=={}
    quotes.day='2026-09-02'
    bought=book.reconcile(day=quotes.day)
    assert len(bought['positions'])==100
    return book,quotes


def test_activity_rows_follow_reservation_holding_and_sale_without_writing(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000,'buy_fee_pct':1,'sell_fee_pct':2,
                    'sell_tax_pct':3,'slippage_pct':0},True)
    book.scan(day=quotes.day)
    before=book.store.get('universe_paper')
    row=book.status(include_activity=True)['activity'][0]
    assert book.store.get('universe_paper')==before
    assert row['status']=='reserved'
    assert row['buy_date']=='2026-09-02' and row['sell_date']=='2026-09-16'
    assert row['current_price']==100 and row['price_date']=='2026-09-01'
    assert row['average_price'] is None and row['sell_price'] is None
    assert row['profit'] is None and row['return_pct'] is None
    quotes.day='2026-09-02'
    book.reconcile(day=quotes.day)
    quotes.day='2026-09-03';quotes.price=104
    book.reconcile(day=quotes.day)
    row=book.status(include_activity=True)['activity'][0]
    assert row['status']=='held' and row['quantity']==9
    assert row['average_price']==100 and row['current_price']==104
    assert row['sell_price'] is None
    assert row['profit']==pytest.approx(-19.8)
    assert row['return_pct']==pytest.approx(-1.98)
    quotes.day='2026-09-04';quotes.price=110
    book.reconcile(day=quotes.day)
    row=book.status(include_activity=True)['activity'][0]
    assert row['status']=='sold' and row['sell_date']=='2026-09-04'
    assert row['sell_price']==110 and row['current_price'] is None
    assert row['profit']==pytest.approx(31.5) and row['return_pct']==pytest.approx(3.15)
    assert 'activity' not in book.store.get('universe_paper')


def test_activity_expiry_uses_exchange_sessions_after_october_holidays(tmp_path):
    book,quotes=engine(tmp_path)
    quotes.day='2026-10-08'
    book.configure({'capital':100000000},True)
    book.scan(day=quotes.day)
    row=book.status(include_activity=True)['activity'][0]
    assert row['buy_date']=='2026-10-12' and row['sell_date']=='2026-10-26'


def test_equal_budget_next_close_persistence_idempotence(tmp_path):
    book,quotes=started(tmp_path)
    state=book.status()
    assert {p['capital'] for p in state['positions'].values()}=={1000000}
    assert {p['buy_date'] for p in state['positions'].values()}=={'2026-09-02'}
    assert state['cash']>=0
    again=book.reconcile(day=quotes.day)
    assert again['orders']==state['orders'] and again['cash']==state['cash']
    assert book.store.get('paper') is None
    with pytest.raises(ValueError):
        book.configure({'capital':200000000,'criterion':'probability'},True)


def test_weekly_cycles_skip_held_and_reserved_symbols_and_allow_sold_symbols_later(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'holding_mode':'calendar_days'},True)
    first=book.scan(day=quotes.day)
    assert len(first['cycles'])==1 and first['next_scan_day']=='2026-09-09'
    assert {p['cycle_id'] for p in first['pending'].values()}=={1}
    assert book.scan(day=quotes.day)['orders']==first['orders']
    quotes.day='2026-09-02';book.reconcile(day=quotes.day)
    quotes.day='2026-09-08'
    assert len(book.scan(day=quotes.day)['cycles'])==1
    class Replacement(Universe):
        def snapshot(self):
            value=super().snapshot();value['rows'][0].update(code='000999',name='new')
            return value
    book.universe=Replacement();quotes.day='2026-09-09'
    second=book.scan(day=quotes.day)
    assert len(second['cycles'])==2 and not second['pending']
    assert next(c for c in second['candidates'] if c['code']=='000999')['status']=='가용 현금 부족'
    assert sum(c['status']=='중복 제외' for c in second['cycles'][1]['candidates'])==99
    assert second['scan']['analyzed']==100 and second['scan']['errors']==0
    assert len(book.scan(day=quotes.day)['cycles'])==2
    quotes.day='2026-09-10';book.reconcile(day=quotes.day)
    assert len(book.status()['positions'])==100 # no unfunded extra reservation
    quotes.day='2026-09-16';book.reconcile(day=quotes.day)
    third=book.scan(day=quotes.day)
    assert len(third['cycles'])==3
    assert '000002' in third['pending'] # old sold holding is eligible again
    assert third['pending']['000002']['cycle_id']==3


def test_daily_only_forecasts_on_weekly_due_day(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000},True)
    book.scan(day=quotes.day)
    calls=[]
    previous=book.predictor
    book.predictor=lambda raw,criterion:(calls.append(1) or previous(raw,criterion))
    book.completed_day=lambda:'2026-09-02';quotes.day='2026-09-02'
    book.daily()
    assert not calls and len(book.status()['positions'])==100
    book.completed_day=lambda:'2026-09-09';quotes.day='2026-09-09'
    book.daily()
    assert len(calls)==100 and len(book.status()['cycles'])==2


def test_rotating_universe_can_overlap_more_than_100_holdings_with_available_cash(tmp_path):
    book,quotes=engine(tmp_path)
    quotes.price=6000000
    book.configure({'capital':1000000000},True)
    book.scan(day=quotes.day)
    quotes.day='2026-09-02';book.reconcile(day=quotes.day)
    assert len(book.status()['positions'])==100 and book.status()['cash']>10000000
    class Replacement(Universe):
        def snapshot(self):
            value=super().snapshot();value['rows'][0].update(code='000999',name='new')
            return value
    book.universe=Replacement();quotes.day='2026-09-09'
    assert len(book.scan(day=quotes.day)['pending'])==1
    quotes.day='2026-09-10'
    state=book.reconcile(day=quotes.day)
    assert len(state['positions'])==101 and state['cash']>=0
    assert state['positions']['000999']['cycle_id']==2


@pytest.mark.parametrize('price,reason',[(106,'take_profit'),(96,'stop_loss')])
def test_daily_close_exit_ignores_high_low(tmp_path,price,reason):
    book,quotes=started(tmp_path)
    quotes.day='2026-09-03'
    quotes.price=price
    state=book.reconcile(day=quotes.day)
    assert len(state['trades'])==100 and not state['positions']
    assert {t['reason'] for t in state['trades']}=={reason}
    cash=state['cash']
    assert book.reconcile(day=quotes.day)['cash']==cash
    assert cash==pytest.approx(sum(t['cash'] for t in state['trades']))


def test_tenth_exchange_day_expires_and_pause_still_exits(tmp_path):
    book,quotes=started(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},False)
    quotes.day='2026-09-16' # tenth XKRX session after September 2
    state=book.reconcile(day=quotes.day)
    assert len(state['trades'])==100
    assert {t['reason'] for t in state['trades']}=={'expiry'}
    assert not state['pending']


def test_stale_or_missing_data_cannot_fill_and_can_retry(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    book.scan(day=quotes.day)
    quotes.missing={'000001'}
    state=book.reconcile(day='2026-09-02') # all quotes stale
    assert not state['positions'] and len(state['pending'])==100
    quotes.day='2026-09-02'
    state=book.reconcile(day=quotes.day)
    assert len(state['positions'])==99 and len(state['pending'])==1
    quotes.missing.clear()
    assert len(book.reconcile(day=quotes.day)['positions'])==100


def test_missed_entry_is_cancelled_not_backdated(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    book.scan(day=quotes.day)
    quotes.day='2026-09-03'
    state=book.reconcile(day=quotes.day)
    assert not state['positions'] and not state['pending']
    assert all(o['status']=='expired' for o in state['orders'])


def test_pause_during_scan_discards_new_buys(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    def predict(raw,criterion):
        book.configure({'capital':100000000,'criterion':'probability'},False)
        return {'as_of':str(raw.index[-1].date()),'probability':.8}
    book.predictor=predict
    result=book.scan(day=quotes.day)
    assert not result['enabled'] and not result['pending']


def test_precision_requires_latest_binary_signal_and_held_stock_leaving_universe(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'precision'},True)
    book.predictor=lambda raw,criterion:{'as_of':quotes.day,'precision':.8,'signal':0}
    result=book.scan(day=quotes.day)
    assert result['scan']['eligible']==0 and not result['pending']
    quotes.day='2026-09-09' # next weekly slot
    book.predictor=lambda raw,criterion:{'as_of':quotes.day,'precision':.6,'signal':1}
    result=book.scan(day=quotes.day)
    assert result['scan']['eligible']==100
    quotes.day='2026-09-10'
    book.reconcile(day=quotes.day)
    class Replacement(Universe):
        def snapshot(self):
            result=super().snapshot()
            result['rows'][0].update(code='000999',name='replacement')
            return result
    book.universe=Replacement()
    book.scan(day=quotes.day)
    assert '000001' in book.status()['positions']
    quotes.day='2026-09-11';quotes.price=96
    result=book.reconcile(day=quotes.day)
    assert any(t['symbol']['code']=='000001' and t['reason']=='stop_loss' for t in result['trades'])


def test_nan_probability_and_insufficient_share_budget_are_not_orders(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':1000,'criterion':'probability'},True)
    book.predictor=lambda raw,criterion:{'as_of':quotes.day,'probability':float('nan')}
    result=book.scan(day=quotes.day)
    assert result['scan']['errors']==100 and not result['pending']
    quotes.day='2026-09-09'
    book.predictor=lambda raw,criterion:{'as_of':quotes.day,'probability':.7}
    result=book.scan(day=quotes.day)
    assert result['scan']['eligible']==100 and not result['pending']
    assert all(c['status']=='1주 예산 부족' for c in result['candidates'])


def test_original_cache_with_today_date_is_not_proof_of_final_close(tmp_path):
    book,quotes=engine(tmp_path)
    book.configure({'capital':100000000,'criterion':'probability'},True)
    book.scan(day=quotes.day)
    original=quotes.original_prices
    quotes.day='2026-09-02'
    def cached(code,market='KR'):
        raw,meta=original(code,market)
        return raw,{**meta,'source':'원본 가격 캐시','warning':'조회 실패'}
    quotes.original_prices=cached
    state=book.reconcile(day=quotes.day)
    assert not state['positions'] and len(state['errors'])==100
    quotes.day='2026-09-09' # fresh selection is only allowed at the weekly slot
    state=book.scan(day=quotes.day)
    assert state['scan']['errors']==100
