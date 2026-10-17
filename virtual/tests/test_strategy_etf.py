import math
import pandas as pd
import pytest
from stock_ai.comparison import MemoryStore
import exchange_calendars as xc
from stock_ai.strategy_etf import InfiniteBuyEngine, ValueRebalanceEngine, IndexValueRebalanceEngine, cents

CAL=xc.get_calendar('XNYS')

FX=1400.


class Provider:
    def __init__(self,bars):self.bars=bars
    def original_prices(self,code,market='US'):
        return self.bars.copy(),{'source':'FinanceDataReader'}
    def exchange_rates(self,years=5):
        days=pd.date_range('2025-01-01','2026-12-31')
        return pd.DataFrame({'Close':FX},index=days),{}


def bars(rows,start='2026-03-02'):
    """rows: (open, high, low, close) per NYSE session from start."""
    sessions=CAL.sessions_in_range(start,'2026-12-31')[:len(rows)]
    return pd.DataFrame([{'Open':o,'High':h,'Low':l,'Close':c,'Volume':1e6} for o,h,l,c in rows],
                        index=pd.DatetimeIndex([s.tz_localize(None) if s.tz else s for s in sessions]))


def run(engine_class,rows,start='2026-02-27'):
    frame=bars(rows)
    engine=engine_class(MemoryStore({}),Provider(frame))
    engine.start(start)
    return engine,engine.daily(str(frame.index[-1].date()))


def test_capital_is_one_billion_won_in_dollars_and_valued_back_in_won():
    engine,state=run(InfiniteBuyEngine,[(100,100,100,100)])
    assert state['capital_usd']==pytest.approx(1e9/FX) and state['fx_start']==FX
    assert state['metrics']['net_equity']==pytest.approx(state['metrics']['net_equity_usd']*FX)
    assert state['equity'][0]['value']==1e9


def test_infinite_buy_first_unit_then_split_loc_orders_in_the_first_half():
    engine,state=run(InfiniteBuyEngine,[(100,100,100,100),(99,99,97,98)])
    unit=state['book']['unit'];first,*rest=state['trades']
    assert unit==pytest.approx(1e9/FX/40)
    assert first['side']=='BUY' and first['price']==100 and first['quantity']==math.floor(unit/(100*1.0007))
    # T~1 -> star% = 10*(1-2/40) = 9.5; close 98 <= average 100 and <= star-0.01 -> both halves fill at the close
    assert [t['reason'].split(' (')[0] for t in rest]==['평단 LOC','별지점 LOC']
    assert all(t['price']==98 for t in rest)
    assert rest[0]['quantity']==math.floor(unit/2/100)


def test_infinite_buy_target_sells_three_quarters_and_star_quarter_then_restarts_the_cycle():
    engine,state=run(InfiniteBuyEngine,[(100,100,100,100),(105,112,104,111),(111,111,111,111)])
    held=state['trades'][0]['quantity']
    sells=[t for t in state['trades'] if t['side']=='SELL']
    assert [t['quantity'] for t in sells]==[held-held//4,held//4]
    assert sells[0]['price']==cents(100*1.10) and sells[1]['price']==111
    # next session: whole cash re-split by 40 and one unit bought
    book=state['book']
    assert book['cycle']==2 and book['history'][0]['return_pct']>0
    assert book['unit']==pytest.approx(book['seed']/40) and state['trades'][-1]['reason'].startswith('2사이클 첫 매수')


def test_infinite_buy_quarter_stop_when_forty_units_are_spent():
    engine=InfiniteBuyEngine(MemoryStore({}),Provider(bars([(100,100,100,100)])))
    state=engine.default();state.update(cash=50.,shares=400,avg=100.,avg_cost=100.07,last_close=90.,fx=FX,
        book={'cycle':1,'cycle_open':True,'cycle_start':'2026-03-02','seed':40000.,'unit':1000.})
    # T = 40 -> star% = -10 -> star $90; the close of 85 misses it, so the quarter stop sells instead
    engine.trade(state,pd.Series({'Open':86.,'High':87.,'Low':84.,'Close':85.}),'2026-03-03',FX)
    assert [(t['side'],t['quantity']) for t in state['trades']]==[('SELL',100)]
    assert '쿼터손절' in state['trades'][0]['reason'] and state['shares']==300


def test_second_half_buys_one_unit_only_below_the_star_price():
    engine=InfiniteBuyEngine(MemoryStore({}),Provider(bars([(100,100,100,100)])))
    state=engine.default();state.update(cash=20000.,shares=250,avg=100.,avg_cost=100.,last_close=95.,fx=FX,
        book={'cycle':1,'cycle_open':True,'cycle_start':'2026-03-02','seed':40000.,'unit':1000.})
    # T = 25 -> star% = 10*(1-50/40) = -2.5 -> star 97.50; close 97 buys one unit at the close, no 1/4 sale
    engine.trade(state,pd.Series({'Open':96.,'High':98.,'Low':96.,'Close':97.}),'2026-03-03',FX)
    assert [(t['side'],t['quantity']) for t in state['trades']]==[('BUY',math.floor(1000/97.49))]


def test_value_rebalancing_starts_half_invested_and_arms_the_book_ladder():
    # 2026-03-02 is a Monday: the first cycle ends on Friday 03-06
    engine,state=run(ValueRebalanceEngine,[(100,100,100,100)])
    book=state['book'];first=state['trades'][0]
    assert first['quantity']==math.floor(1e9/FX*.5/(100*1.0007))
    q0=first['quantity'];low=book['v']*.85
    assert book['anchor']=='2026-03-06' and book['cycle_end']=='2026-03-06' and book['q0']==q0
    # buy rungs: one share each at low/(Q0+n-1), as many as land closest to 75% of the Pool
    spent=sum(round(low/(q0+i),2) for i in range(book['buy_rungs']))
    assert abs(spent-state['cash']*.75)<=round(low/(q0+book['buy_rungs']),2)
    assert book['sell_rungs']==q0 and state['levels']['next_buy']==round(low/q0,2)


def test_ladder_fills_every_rung_the_low_reaches_and_never_rearms_them():
    engine,state=run(ValueRebalanceEngine,[(100,100,100,100),(90,90,80,88),(86,86,80,86)])
    book=state['book'];q0=book['q0'];low=book['low']
    reached=sum(1 for i in range(book['buy_rungs']) if round(low/(q0+i),2)>=80)
    buy=state['trades'][1]
    assert buy['side']=='BUY' and buy['quantity']==reached==book['buy_filled']
    assert len(state['trades'])==2  # the same low the next day fills nothing new
    assert buy['price']==pytest.approx(sum(min(90,round(low/(q0+i),2)) for i in range(reached))/reached)


def test_value_is_updated_on_the_friday_close_with_the_vr_formula():
    engine,state=run(ValueRebalanceEngine,[(100,100,100,100)]*6)
    history=state['book']['history']
    assert [h['end'] for h in history]==['2026-03-06']
    h=history[0];g=10
    assert h['v_after']==pytest.approx(h['v_before']+h['pool']/g+(h['evaluation']-h['v_before'])/(2*math.sqrt(g)))
    assert state['book']['cycle_end']=='2026-03-20' and state['book']['pool_start']==pytest.approx(h['pool'])


def test_kodex200_index_vr_runs_in_won_on_the_korean_calendar():
    frame=bars([(80000,80000,80000,80000),(79000,79500,78500,79000)])
    frame.index=pd.DatetimeIndex(['2026-03-03','2026-03-04'])
    engine=IndexValueRebalanceEngine(MemoryStore({}),Provider(frame))
    engine.start('2026-02-27');state=engine.daily('2026-03-04')
    assert state['capital_usd']==1e9 and state['fx']==1 and state['config']['sell_tax_pct']==0
    assert state['trades'][0]['quantity']==math.floor(1e9*.5/(80000*1.00015))
    assert state['metrics']['net_equity']==pytest.approx(state['metrics']['net_equity_usd'])
    assert engine.completed_day(pd.Timestamp('2026-03-04 17:00',tz='Asia/Seoul'))=='2026-03-03'
    assert engine.completed_day(pd.Timestamp('2026-03-04 18:05',tz='Asia/Seoul'))=='2026-03-04'


def test_missing_bar_stops_the_replay_and_the_next_run_resumes():
    frame=bars([(100,100,100,100),(99,99,99,99),(98,98,98,98)])
    provider=Provider(frame.drop(frame.index[1]))
    engine=InfiniteBuyEngine(MemoryStore({}),provider)
    engine.start('2026-02-27')
    state=engine.daily(str(frame.index[-1].date()))
    assert state['last_settled_day']==str(frame.index[0].date()) and '일봉 없음' in state['errors'][0]['error']
    provider.bars=frame
    state=engine.daily(str(frame.index[-1].date()))
    assert state['last_settled_day']==str(frame.index[-1].date()) and not state['errors']


def test_stopped_account_places_no_orders_but_keeps_valuing():
    frame=bars([(100,100,100,100),(90,90,90,90)])
    engine=InfiniteBuyEngine(MemoryStore({}),Provider(frame.iloc[:1]))
    engine.start('2026-02-27');engine.stop()
    engine.provider.bars=frame
    state=engine.daily(str(frame.index[-1].date()))
    assert len(state['trades'])==1 and state['last_close']==90


def test_completed_day_waits_for_the_new_york_close():
    engine=InfiniteBuyEngine(MemoryStore({}),None)
    assert engine.completed_day(pd.Timestamp('2026-10-14 02:00',tz='Asia/Seoul'))=='2026-10-12'
    assert engine.completed_day(pd.Timestamp('2026-10-14 06:00',tz='Asia/Seoul'))=='2026-10-13'
