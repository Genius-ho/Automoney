"""Exchange-aware weekly cohort metadata; no price fetching or account resets."""
from copy import deepcopy
import pandas as pd
import exchange_calendars as xc

CALENDAR=xc.get_calendar('XKRX')


def expiry_day(entry,mode='calendar_days'):
    if mode=='trading_sessions':
        return str(CALENDAR.session_offset(entry,10).date())
    limit=pd.Timestamp(entry)+pd.Timedelta(days=14)
    return str(CALENDAR.date_to_session(limit,direction='previous').date())


def next_scan_day(anchor,after):
    anchor,after=pd.Timestamp(anchor),pd.Timestamp(after)
    slot=max(1,(after-anchor).days//7+1)
    target=anchor+pd.Timedelta(days=7*slot)
    return str(CALENDAR.date_to_session(target,direction='next').date())


def upgrade_cycles(state,archives=()):
    """Add legacy cohort IDs once, retaining existing filled trade economics."""
    if state.get('cycle_version')==1:
        return False
    state.update(cycle_version=1,cycles=[],weekly_anchor=None,next_scan_day=None)
    state['config'].setdefault('holding_mode','calendar_days')
    groups={}
    pending=list(state.get('pending',{}).values())
    filled=list(state.get('positions',{}).values())+state.get('trades',[])
    for row in pending+filled:
        entry=row.get('execution_day',row.get('buy_date'))
        signal=row.get('signal_date',entry)
        groups.setdefault((signal,entry),[]).append(row)
    for order in state.get('orders',[]):
        if order.get('type')=='BUY_NEXT_CLOSE':
            entry=order['day']
            signal=order.get('signal_date') or next((s for s,e in groups if e==entry),entry)
            groups.setdefault((signal,entry),[])
    scan=state.get('scan') or {}
    if not groups and state.get('enabled') and scan.get('execution_day'):
        groups[(scan['as_of'],scan['execution_day'])]=[]
    candidates={c['code']:c for c in state.get('candidates',[])}
    for identifier,((signal,entry),records) in enumerate(sorted(groups.items()),1):
        archive=next((a for a in archives if (a.get('scan') or {}).get('as_of')==signal and
                      a['scan'].get('execution_day')==entry),None)
        selection=deepcopy(state.get('candidates',[])) if signal==scan.get('as_of') else deepcopy((archive or {}).get('candidates',[]))
        buy_orders=[o for o in state.get('orders',[]) if o.get('type')=='BUY_NEXT_CLOSE' and o.get('day')==entry]
        cycle={'id':identifier,'signal_date':signal,'execution_day':entry,
            'expiry_date':expiry_day(entry),'criterion':state['config']['criterion'],
            'config':deepcopy(state['config']),'candidates':selection,
            'reserved_count':max(len(records),len(buy_orders)),'skipped_duplicate_count':0,'legacy':True}
        if archive:
            cycle['criterion']=archive['scan'].get('criterion',cycle['criterion'])
        state['cycles'].append(cycle)
        for row in records:
            row['cycle_id']=identifier
            row['holding_mode']='calendar_days' if row in pending else row.get('holding_mode','trading_sessions')
            row['expiry_date']=expiry_day(entry,row['holding_mode'])
            if row in pending:
                row['config'].setdefault('holding_mode',row['holding_mode'])
                quote=candidates.get(row['symbol']['code'],{})
                row['quote_close']=quote.get('close');row['quote_date']=quote.get('as_of')
        if records:
            cycle['expiry_date']=max(r['expiry_date'] for r in records)
            cycle['config']['holding_mode']=records[0]['holding_mode']
        for order in state.get('orders',[]):
            if order.get('type')=='BUY_NEXT_CLOSE' and order.get('day')==entry:
                order['cycle_id']=identifier
            elif order.get('type')=='SELL_CLOSE':
                if any(r.get('sell_date')==order.get('day') and r['symbol']['code']==order['code'] for r in records):
                    order['cycle_id']=identifier
    if state['cycles']:
        state['weekly_anchor']=state['cycles'][0]['execution_day']
        state['next_scan_day']=next_scan_day(state['weekly_anchor'],state['cycles'][-1]['signal_date'])
    return True


def cycle_summaries(state):
    result=[]
    for cycle in state.get('cycles',[]):
        identifier=cycle['id']
        pending=sum(p.get('cycle_id')==identifier for p in state.get('pending',{}).values())
        held=sum(p.get('cycle_id')==identifier for p in state.get('positions',{}).values())
        trades=[p for p in state.get('trades',[]) if p.get('cycle_id')==identifier]
        cancelled=sum(o.get('cycle_id')==identifier and o.get('type')=='BUY_NEXT_CLOSE' and
                      o.get('status') not in {'reserved','filled'} for o in state.get('orders',[]))
        result.append({**{k:v for k,v in cycle.items() if k not in {'candidates','config'}},
            'pending':pending,'held':held,'sold':len(trades),'cancelled':cancelled,
            'realized_profit':sum(t['profit'] for t in trades),
            'status':'진행 중' if pending or held else '종료'})
    return result
