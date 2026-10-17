"""Paired forward accounts: identical data, independent selection, atomic ledgers."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
import threading
import uuid
import pandas as pd
from .universe import UniverseProvider, forecast
from .universe_paper import UniversePaperEngine, UniverseSettings, SEOUL
from .strategy_two import (forecast as improved_forecast, METHOD as V3_METHOD, LEGACY_METHOD, V2_METHOD,
    selection_rules as per_stock_rules, fdr_filter)
from .strategy_b4 import METHOD, PooledSelector, rank_filter, selection_rules as pooled_rules
from .costs import settle

KEY='paper_comparison'
ACCOUNTS={'a':'comparison_paper_a','b':'comparison_paper_b'}


class ComparisonCancelled(Exception):
    pass


def selection_rules(method):
    return pooled_rules() if method==METHOD else per_stock_rules(method)


class MemoryStore:
    """Stage both accounts together; no pending order is published mid-comparison."""
    def __init__(self,values):self.values=deepcopy(values)
    def get(self,key,default=None,connection=None):return deepcopy(self.values.get(key,default))
    def put(self,key,value,connection=None):self.values[key]=deepcopy(value)
    def keys(self,prefix):return [k for k in self.values if k.startswith(prefix)]
    @contextmanager
    def transaction(self):yield self


class SharedPrices:
    def __init__(self,provider):self.provider=provider;self.cache={}
    def original_prices(self,code,market='KR'):
        key=(code,market)
        if key not in self.cache:
            try:self.cache[key]=self.provider.original_prices(code,market)
            except Exception as exc:self.cache[key]=exc
        result=self.cache[key]
        if isinstance(result,Exception):raise ValueError(str(result))
        raw,meta=result
        return raw.copy(deep=True),deepcopy(meta)


class FrozenUniverse:
    def __init__(self,snapshot):self.value=snapshot
    def snapshot(self):return deepcopy(self.value)


def net_equity(state):
    return state['cash']+sum(settle(p,p['last_close']*(1-p['costs']['slippage_pct']/100))['cash']-p['cash_left']
        for p in state['positions'].values())


def account_metrics(state):
    initial=state['config']['capital'];value=net_equity(state)
    peak=initial;drawdown=0.
    for point in sorted(state['equity'],key=lambda r:r['date']):
        peak=max(peak,point['value']);drawdown=max(drawdown,(1-point['value']/peak)*100)
    peak=max(peak,value);drawdown=max(drawdown,(1-value/peak)*100)
    trades=state['trades'];date=state['equity'][-1]['date'] if state['equity'] else None
    stale=sum(p['last_price_date']!=date for p in state['positions'].values())
    return {'net_equity':value,'return_pct':(value/initial-1)*100,'profit':value-initial,
        'realized_profit':sum(t['profit'] for t in trades),'max_drawdown_pct':drawdown,
        'trade_count':len(trades),'win_rate':sum(t['profit']>0 for t in trades)/len(trades) if trades else None,
        'holding_count':len(state['positions']),'pending_count':len(state['pending']),
        'invested_pct':sum(p['quantity']*p['last_close'] for p in state['positions'].values())/initial*100,
        'valuation_date':date,'stale_positions':stale}


class ComparisonEngine:
    def __init__(self,store,provider,universe=None,baseline=None,improved=None):
        self.store,self.provider=store,provider
        # A (2026-10-13, user request): KOSPI top 100 by market cap only, no KOSDAQ.
        self.universe=universe or UniverseProvider(store,(('KOSPI',100),),'market_cap_universe_kospi100')
        self.baseline=baseline or forecast
        # None = production B: v4 pools every stock; v1-v3 records still use the per-stock forecast.
        self.improved=improved
        self.work_lock=threading.Lock()

    def engine(self,side,store=None,provider=None,universe=None,config=None):
        meta=self.metadata()
        cfg=config or self.account_config(side,meta)
        scope=meta.get('b_universe') if side=='b' else None
        universe=universe or (FrozenUniverse(scope) if scope else self.universe)
        method=meta['improved_method'];rules=selection_rules(method)
        selection_filter=None;threshold=.6
        if side=='a':predictor=self.baseline
        elif method==METHOD:
            threshold=rules['probability_threshold']
            if self.improved is None:
                selector=PooledSelector(rules['top_k'])
                predictor=lambda raw,criterion:selector.predict(raw,UniverseSettings(**cfg))
                selection_filter=selector.select
            else:
                predictor=lambda raw,criterion:self.improved(raw,UniverseSettings(**cfg))
                selection_filter=lambda rows:rank_filter(rows,rules['top_k'])
        else:
            threshold=rules['probability_threshold']
            improved=self.improved or improved_forecast
            predictor=lambda raw,criterion:improved(raw,UniverseSettings(**cfg))
            if rules.get('fdr_q'):selection_filter=lambda rows:fdr_filter(rows,rules['fdr_q'])
        return UniversePaperEngine(store or self.store,provider or self.provider,universe,
                                   predictor,state_key=ACCOUNTS[side],selection_threshold=threshold,
                                   expected_universe_size=len(scope['rows']) if scope else 100,selection_filter=selection_filter)

    def account_config(self,side,meta=None):
        meta=meta or self.metadata()
        return {**meta['config'],**(meta.get('b_config',{}) if side=='b' else {}),
                'criterion':'precision' if side=='a' else 'probability'}

    def metadata(self):
        return self.store.get(KEY,{'enabled':False,'revision':'initial','started_day':None,
            'last_settled_day':None,'config':UniverseSettings(criterion='precision').model_dump(),
            'baseline_method':'original-close-60-v1','improved_method':METHOD})

    def status(self):
        # One snapshot prevents a reader seeing A before a paired commit and B after it.
        with self.store.transaction() as con:
            meta=self.store.get(KEY,self.metadata(),con)
            memory=MemoryStore({k:self.store.get(k,connection=con) for k in ACCOUNTS.values()
                                if self.store.get(k,connection=con) is not None})
        accounts={}
        for side in ACCOUNTS:
            state=self.engine(side,store=memory,config=self.account_config(side,meta)).status(include_activity=True)
            metrics=account_metrics(state)
            state.update(metrics=metrics,mark_equity=metrics['net_equity'],return_pct=metrics['return_pct'])
            accounts[side]=state
        a,b=[accounts[s]['metrics'] for s in ACCOUNTS]
        comparable=bool(meta['started_day'] and a['valuation_date'] and a['valuation_date']==b['valuation_date']
            and not a['stale_positions'] and not b['stale_positions'] and not meta.get('incomplete_day'))
        difference=b['return_pct']-a['return_pct'] if comparable else None
        message='비교 시작 후 같은 날짜의 성과를 표시합니다.' if not meta['started_day'] else (
            '가격 누락 또는 평가 날짜 차이로 우열 비교를 보류합니다.' if not comparable else
            '체결·청산 기록이 쌓이면 성과를 비교할 수 있습니다.' if not (a['trade_count'] or b['trade_count']) else
            '같은 날짜의 비용 차감 평가액 기준입니다. 누적 성과이며 통계적 우위를 확정하지 않습니다.')
        return {**meta,'selection_rules':selection_rules(meta['improved_method']),'accounts':accounts,'comparison':{'comparable':comparable,
            'return_difference_pct':difference,'message':message}}

    def revise_untraded_b(self,progress=None):
        """Explicit pre-fill v1 -> v2 revision; publish only after a full B scan.

        A's frozen universe/ledger and every old B selection are retained.
        The first experiment cannot be revised after either account has traded.
        """
        if not self.work_lock.acquire(blocking=False):raise ValueError('전략 비교가 이미 진행 중입니다.')
        progress=progress or (lambda *args:None)
        try:
            with self.store.transaction() as con:
                before={key:self.store.get(key,connection=con) for key in [KEY,*ACCOUNTS.values()]}
            meta=deepcopy(before[KEY]);a=before[ACCOUNTS['a']];b=before[ACCOUNTS['b']]
            if not meta or not a or not b:raise ValueError('최초 비교 분석 기록이 필요합니다.')
            if meta['improved_method']!=LEGACY_METHOD:raise ValueError('이미 새 기준이거나 변경할 수 없는 전략 버전입니다.')
            if any(s['positions'] or s['trades'] or any(o['status']=='filled' for o in s['orders']) for s in [a,b]):
                raise ValueError('체결 이후에는 동일 실험의 기준을 변경할 수 없습니다.')
            if b['pending']:raise ValueError('기존 B 매수 예약이 있어 기준을 변경할 수 없습니다.')
            day=meta['started_day']
            if not meta['enabled'] or meta.get('incomplete_day') or meta['last_settled_day']!=day:
                raise ValueError('체결 전 최초 선정일에서만 B 기준을 변경할 수 있습니다.')
            if any(not s['scan'] or s['scan']['as_of']!=day for s in [a,b]):
                raise ValueError('두 계좌의 최초 선정 날짜가 일치해야 합니다.')
            revision=uuid.uuid4().hex
            archive_key=KEY+':revision:'+revision
            meta.update(improved_method=V2_METHOD,revision=revision)
            meta.setdefault('selection_revisions',[]).append({
                'from_method':LEGACY_METHOD,'to_method':V2_METHOD,'as_of':day,
                'changed_at':datetime.now(SEOUL).isoformat(),'archive_key':archive_key,
                'from_rules':selection_rules(LEGACY_METHOD),'to_rules':selection_rules(V2_METHOD),
                'reason':'사용자 요청: 현재 약 5종목을 선정하도록 확률 기준 60% → 52% 완화. 과거 검증 조건 유지. 현재 후보 수를 보고 조정한 실험 기준.'})
            memory=MemoryStore({**before,KEY:meta})
            revised=deepcopy(b);revised.update(revision=revision,next_scan_day=None)
            memory.put(ACCOUNTS['b'],revised)
            staged=ComparisonEngine(memory,self.provider,FrozenUniverse(a['scan']['universe']),self.baseline,self.improved)
            def guarded(percent,message):
                if self.metadata()['revision']!=before[KEY]['revision']:raise ComparisonCancelled()
                progress(percent,message)
            result=staged.engine('b').scan(day,guarded)
            if not result['scan']['analyzed']:raise ValueError('유효한 B 분석 결과가 없어 이전 기준을 유지합니다.')
            fresh={c['code']:c for c in result['candidates']}
            for old in b['candidates']:
                new=fresh.get(old['code'])
                if old.get('score') is not None and (not new or new.get('score') is None):
                    raise ValueError('기존에 분석한 종목의 재분석이 실패해 기준 변경을 보류합니다.')
                if old.get('data_hash') and new.get('data_hash')!=old['data_hash']:
                    raise ValueError('주가 자료가 최초 비교와 달라 기준 변경을 보류합니다.')
            with self.store.transaction() as con:
                if any(self.store.get(k,connection=con)!=v for k,v in before.items()):raise ComparisonCancelled()
                self.store.put(archive_key,before,con)
                for key in memory.keys(ACCOUNTS['b']):self.store.put(key,memory.get(key),con)
                self.store.put(KEY,meta,con)
            return self.status()
        finally:self.work_lock.release()

    def upgrade_b_method(self,reason,rescan_now=False):
        """Record a B version switch effective from B's next selection.

        Existing B reservations, holdings, trades and cycles keep the version that
        selected them; A is untouched. The pre-change snapshot is archived.
        rescan_now lets an empty B (no reservation) select at the next settlement
        instead of waiting for its weekly slot.
        """
        if not self.work_lock.acquire(blocking=False):raise ValueError('전략 비교가 이미 진행 중입니다.')
        try:
            with self.store.transaction() as con:
                meta=self.store.get(KEY,None,con)
                if not meta:raise ValueError('비교 기록이 없습니다.')
                current=meta['improved_method']==METHOD
                previous=meta['improved_method']
                if not current and previous not in (V2_METHOD,V3_METHOD):raise ValueError('v2·v3에서만 현재 B 버전으로 전환할 수 있습니다.')
                before={k:self.store.get(k,connection=con) for k in [KEY,*ACCOUNTS.values()]}
            if current:return self.status()
            with self.store.transaction() as con:
                if self.store.get(KEY,None,con)!=before[KEY]:raise ComparisonCancelled()
                revision=uuid.uuid4().hex;archive_key=KEY+':revision:'+revision
                b=before[ACCOUNTS['b']] or {}
                rescan=bool(rescan_now and b and not b.get('pending'))
                meta=deepcopy(meta)
                meta.setdefault('selection_revisions',[]).append({
                    'from_method':previous,'to_method':METHOD,'as_of':meta.get('last_settled_day'),
                    'changed_at':datetime.now(SEOUL).isoformat(),'archive_key':archive_key,
                    'effective':'다음 B 선정부터 ('+('다음 정산' if rescan else str(b.get('next_scan_day') or '다음 정산'))+')',
                    'from_rules':selection_rules(previous),'to_rules':selection_rules(METHOD),
                    'kept_pending':sorted((b.get('pending') or {}).keys()),'reason':reason})
                meta.update(improved_method=METHOD,revision=revision,b_selection_blocked=None)
                self.store.put(archive_key,before,con)
                if rescan:self.store.put(ACCOUNTS['b'],{**b,'next_scan_day':None},con)
                self.store.put(KEY,meta,con)
            return self.status()
        finally:self.work_lock.release()

    def enable(self,day=None):
        day=day or self.engine('a').completed_day()
        with self.store.transaction() as con:
            meta=self.store.get(KEY,self.metadata(),con)
            if meta['enabled']:return meta['revision']
            meta.update(enabled=True,revision=uuid.uuid4().hex,started_day=meta['started_day'] or day)
            meta.setdefault('started_at',datetime.now(SEOUL).isoformat())
            memory=MemoryStore({k:self.store.get(k,connection=con) for k in ACCOUNTS.values()
                                if self.store.get(k,connection=con) is not None})
            for side,key in ACCOUNTS.items():
                cfg=self.account_config(side,meta)
                self.engine(side,store=memory,config=cfg).configure(cfg,True)
                self.store.put(key,memory.get(key),con)
            self.store.put(KEY,meta,con)
        return meta['revision']

    def stop(self):
        with self.store.transaction() as con:
            meta=self.store.get(KEY,self.metadata(),con)
            memory=MemoryStore({k:self.store.get(k,connection=con) for k in ACCOUNTS.values()
                                if self.store.get(k,connection=con) is not None})
            for side,key in ACCOUNTS.items():
                engine=self.engine(side,store=memory)
                engine.configure(engine.status()['config'],False)
                self.store.put(key,memory.get(key),con)
            meta.update(enabled=False,revision=uuid.uuid4().hex)
            self.store.put(KEY,meta,con)
        return self.status()

    def start(self,day=None,progress=None):
        revision=self.enable(day)
        return self.run(day,progress,expected_revision=revision)

    def daily(self,day=None,progress=None):return self.run(day,progress)

    def run(self,day=None,progress=None,expected_revision=None):
        progress=progress or (lambda *args:None)
        if not self.work_lock.acquire(blocking=False):raise ValueError('전략 비교가 이미 진행 중입니다.')
        revision=self.metadata()['revision']
        def guarded_progress(percent,message):
            if self.metadata()['revision']!=revision:raise ComparisonCancelled()
            progress(percent,message)
        try:return self._run(day,guarded_progress,expected_revision)
        except ComparisonCancelled:
            progress(100,'중지 요청으로 이번 분석의 예약을 저장하지 않았습니다.')
            return self.status()
        finally:self.work_lock.release()

    def _run(self,day,progress,expected_revision):
        meta=self.metadata();revision=meta['revision']
        if expected_revision is not None and (revision!=expected_revision or not meta['enabled']):
            return self.status()
        # A stored B version that differs from the code never blocks settlement or A;
        # only B's new selection waits for an explicit, recorded upgrade.
        b_blocked=meta.get('improved_method')!=METHOD
        day=day or self.engine('a').completed_day()
        calendar=self.engine('a').calendar
        if not calendar.is_session(day):raise ValueError('한국 거래일을 선택하세요.')
        memory=MemoryStore({key:self.engine(side).status() for side,key in ACCOUNTS.items()})
        shared=SharedPrices(self.provider)
        engines={s:self.engine(s,store=memory,provider=shared) for s in ACCOUNTS}
        since=meta['last_settled_day'] or meta['started_day'] or day
        if day<since:raise ValueError('마지막 정산일 이전으로 되돌릴 수 없습니다.')
        days=[str(d.date()) for d in calendar.sessions_in_range(since,day)
              if not meta['last_settled_day'] or str(d.date())>meta['last_settled_day']]
        for settle_day in days:
            for side,engine in engines.items():
                engine.reconcile(settle_day,lambda p,m:progress(min(9,p//10),side.upper()+' · '+m))
                state=memory.get(ACCOUNTS[side])
                if state['errors']:
                    # Discard ALL staged days/accounts. Replaying from the old watermark
                    # must still see an earlier stop even if a later close has recovered.
                    with self.store.transaction() as con:
                        if self.store.get(KEY,self.metadata(),con)['revision']!=revision:
                            raise ComparisonCancelled()
                        meta.update(incomplete_day=settle_day,settlement_errors=state['errors'])
                        self.store.put(KEY,meta,con)
                    progress(100,f'{settle_day} 가격 누락 · 두 계좌 정산과 신규 선정을 보류했습니다. 종가 정산으로 재시도하세요.')
                    return self.status()
                state['equity'][-1]['value']=net_equity(state)
                memory.put(ACCOUNTS[side],state)
        if meta['enabled']:
            if b_blocked:engines_to_scan={'a':engines['a']}
            else:engines_to_scan=engines
            due=any(not e.status().get('next_scan_day') or day>=e.status()['next_scan_day'] or e.refill_due(day)
                    for e in engines_to_scan.values())
            if due:
                progress(10,'A·B 전략별 분석 대상 목록을 확정합니다.')
                universe=FrozenUniverse(self.universe.snapshot())
                for index,(side,engine) in enumerate(engines_to_scan.items()):
                    engine.universe=FrozenUniverse(meta['b_universe']) if side=='b' and meta.get('b_universe') else universe
                    engine.scan(day,lambda p,m,index=index,side=side:progress(10+index*44+int(p*.44),side.upper()+' · '+m),
                                refill=engine.refill_due(day),max_new=engine.refill_slots(day) or None)
                    if self.metadata()['revision']!=revision:
                        progress(100,'중지 요청으로 이번 분석의 예약을 저장하지 않았습니다.')
                        return self.status()
            else:progress(98,'이번 차수는 이미 선정했습니다. 다음 주 재계산을 기다립니다.')
        with self.store.transaction() as con:
            if self.store.get(KEY,self.metadata(),con)['revision']!=revision:raise ComparisonCancelled()
            for key,value in memory.values.items():self.store.put(key,value,con)
            meta.update(last_settled_day=day,incomplete_day=None,settlement_errors=[],
                        b_selection_blocked=f"B 저장 버전 {meta.get('improved_method')} ≠ 코드 버전 {METHOD}: 정산은 계속하고 B 신규 선정은 버전 전환 후 재개합니다." if b_blocked else None)
            self.store.put(KEY,meta,con)
        progress(100,'A·B 동일 날짜 정산·선정 완료')
        return self.status()
