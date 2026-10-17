"""Explicit, atomic replacement of an unfilled B selection with an audited screen."""
from copy import deepcopy
from datetime import datetime
import uuid
from .comparison import KEY, ACCOUNTS, MemoryStore, ComparisonEngine, ComparisonCancelled
from .universe_paper import SEOUL, UniverseSettings


def apply_b_selection(engine,*,universe,provider,predictor,as_of,expected_codes,provenance,progress=None,expected_analyzed=None):
    if not engine.work_lock.acquire(blocking=False):raise ValueError('전략 비교가 이미 진행 중입니다.')
    progress=progress or (lambda *args:None)
    try:
        with engine.store.transaction() as con:
            before={k:engine.store.get(k,connection=con) for k in [KEY,*ACCOUNTS.values()]}
        meta,a,b=[deepcopy(before[k]) for k in [KEY,ACCOUNTS['a'],ACCOUNTS['b']]]
        if not all([meta,a,b]):raise ValueError('기존 비교 계좌가 필요합니다.')
        if meta.get('b_selection_source')==provenance:return engine.status()
        if any(s['positions'] or s['trades'] or any(o['status']=='filled' for o in s['orders']) for s in [a,b]):
            raise ValueError('체결 이후에는 기존 실험의 선정 결과를 바꿀 수 없습니다.')
        if not meta['enabled'] or meta.get('incomplete_day') or meta['last_settled_day']!=as_of:
            raise ValueError('체결 전 기존 정산 기준일과 연구 기준일이 같아야 합니다.')
        if b['scan']['as_of']!=as_of:raise ValueError('B 선정 기준일이 다릅니다.')
        revision=uuid.uuid4().hex;archive_key=KEY+':revision:'+revision
        cfg=UniverseSettings(**{**b['config'],'criterion':'probability','holding_mode':'trading_sessions'}).model_dump()
        meta.update(revision=revision,b_config=cfg,b_universe=deepcopy(universe),b_selection_source=deepcopy(provenance))
        meta.setdefault('selection_revisions',[]).append({
            'from_method':meta['improved_method'],'to_method':meta['improved_method'],
            'as_of':as_of,'changed_at':datetime.now(SEOUL).isoformat(),'archive_key':archive_key,
            'reason':f"마지막 분석 적용: B {len(universe['rows'])}종목 고정 구성목록·매수 후 10거래일. 기존 미체결 예약을 교체하고 A와 이전 B 기록은 보존.",
            'from_config':b['config'],'to_config':cfg,'source':deepcopy(provenance)})
        for order in b['orders']:
            if order['status']=='reserved':order.update(status='cancelled',reason='최신 분석 결과로 교체',replacement_revision=revision)
        b.update(pending={},config=cfg,revision=revision,next_scan_day=None)
        memory=MemoryStore({**before,KEY:meta,ACCOUNTS['b']:b})
        staged=ComparisonEngine(memory,provider,improved=lambda raw,cfg:predictor(raw,cfg))
        result=staged.engine('b').scan(as_of,progress)
        if set(result['pending'])!=set(expected_codes):raise ValueError('연구의 최종 후보와 새 예약 종목이 다릅니다. 변경을 저장하지 않았습니다.')
        if expected_analyzed is not None and result['scan']['analyzed']!=expected_analyzed:
            raise ValueError('연구의 정상 분석 종목 수가 다릅니다. 변경을 저장하지 않았습니다.')
        with engine.store.transaction() as con:
            if any(engine.store.get(k,connection=con)!=v for k,v in before.items()):raise ComparisonCancelled()
            engine.store.put(archive_key,before,con)
            for key in memory.keys(ACCOUNTS['b']):engine.store.put(key,memory.get(key),con)
            engine.store.put(KEY,meta,con)
        return engine.status()
    finally:engine.work_lock.release()
