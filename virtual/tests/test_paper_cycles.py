from copy import deepcopy
import importlib


def cycles():
    return importlib.import_module('stock_ai.paper_cycles')


def test_calendar_expiry_and_weekly_anchor_do_not_drift_through_holidays():
    helper=cycles()
    assert helper.expiry_day('2026-09-11','calendar_days')=='2026-09-23'
    assert helper.expiry_day('2026-10-12','calendar_days')=='2026-10-26'
    assert helper.expiry_day('2026-09-02','trading_sessions')=='2026-09-16'
    assert helper.next_scan_day('2026-09-18','2026-09-18')=='2026-09-28'
    assert helper.next_scan_day('2026-09-18','2026-09-28')=='2026-10-02'


def test_upgrade_preserves_legacy_cash_and_reservations_and_is_idempotent():
    helper=cycles()
    symbol={'code':'005930','name':'Samsung','market':'KR'}
    state={'enabled':True,'config':{'capital':1000000000,'criterion':'precision'},
        'cash':1000000000,'positions':{},'trades':[],
        'pending':{'005930':{'symbol':symbol,'execution_day':'2026-10-12',
                           'signal_date':'2026-10-08','config':{'capital':1000000000},'score':.7}},
        'orders':[{'code':'005930','day':'2026-10-12','signal_date':'2026-10-08','type':'BUY_NEXT_CLOSE','status':'reserved'}],
        'candidates':[{'code':'005930','as_of':'2026-10-08','close':70000,'status':'매수 후보'}],
        'scan':{'as_of':'2026-10-08','execution_day':'2026-10-12','criterion':'precision'}}
    before=deepcopy(state)
    assert helper.upgrade_cycles(state)
    assert state['cash']==before['cash'] and state['enabled']==before['enabled']
    assert state['pending']['005930']['execution_day']=='2026-10-12'
    assert state['pending']['005930']['cycle_id']==1
    assert state['pending']['005930']['expiry_date']=='2026-10-26'
    assert state['orders'][0]['cycle_id']==1
    assert state['cycles'][0]['candidates']==before['candidates']
    assert state['next_scan_day']=='2026-10-19'
    upgraded=deepcopy(state)
    assert not helper.upgrade_cycles(state)
    assert state==upgraded


def test_legacy_filled_cycle_summary_keeps_its_original_exchange_day_expiry():
    state={'enabled':True,'config':{'capital':1000000000,'criterion':'precision'},'cash':900000000,
        'positions':{'005930':{'symbol':{'code':'005930'},'buy_date':'2026-09-11','signal_date':'2026-09-10'}},
        'pending':{},'trades':[],'orders':[],'candidates':[],'scan':None}
    cycles().upgrade_cycles(state)
    assert state['positions']['005930']['expiry_date']=='2026-09-29'
    assert state['cycles'][0]['expiry_date']=='2026-09-29'
    assert state['cycles'][0]['config']['holding_mode']=='trading_sessions'


def test_upgrade_includes_cancelled_order_only_cohorts_and_saved_selection_history():
    state={'enabled':True,'config':{'capital':1000000000,'criterion':'precision'},'cash':1000000000,
        'positions':{},'pending':{},'trades':[],'candidates':[],'scan':None,
        'orders':[{'code':'000001','signal_date':'2026-09-10','day':'2026-09-11',
                   'type':'BUY_NEXT_CLOSE','status':'cancelled'}]}
    history=[{'scan':{'as_of':'2026-09-10','execution_day':'2026-09-11','criterion':'precision'},
              'candidates':[{'code':'000001','status':'매수 후보'}]}]
    cycles().upgrade_cycles(state,history)
    assert state['orders'][0]['cycle_id']==1 and len(state['cycles'])==1
    assert state['cycles'][0]['reserved_count']==1
    assert state['cycles'][0]['candidates']==history[0]['candidates']
    assert cycles().cycle_summaries(state)[0]['cancelled']==1
