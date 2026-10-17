"""Fixed forward experiment: cost-aware trade labels and causal OOF calibration.

v3 (pre-registered 2026-10-12, before any v3 outcome was observed):
  * today's signal is relative to the stock's own base rate (p >= max(50%, base + 5%p));
  * evidence is measured on non-overlapping sequential trades over three walk-forward folds;
  * a one-sided t-test p-value per stock is filtered across the scanned universe with
    Benjamini-Hochberg FDR 10% (see fdr_filter), so lucky passes among hundreds of stocks are cut.
"""
import numpy as np
import pandas as pd
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit
from xgboost import XGBClassifier
from .costs import buy_position, settle
from .data import original_frame, data_hash
from .features import build_features
from .model import logit
from .paper_cycles import CALENDAR, expiry_day

LEGACY_METHOD='trade-outcome-oof-v1'
V2_METHOD='trade-outcome-oof-v2-p52'
METHOD='trade-outcome-wf-v3-edge-fdr'
METHODS=(LEGACY_METHOD,V2_METHOD,METHOD)
PROBABILITY_FLOOR=.5
EDGE=.05
FIRST_VALIDATION_FOLD=3
MIN_TRADES=10
FDR_Q=.10


def selection_rules(method=METHOD):
    if method not in METHODS:
        raise ValueError('알 수 없는 B 전략 버전입니다.')
    if method==METHOD:
        return {'version':3,'probability_threshold':PROBABILITY_FLOOR,'edge_over_base':EDGE,
                'validation_folds':5-FIRST_VALIDATION_FOLD+1,'min_independent_trades':MIN_TRADES,
                'fdr_q':FDR_Q,'requires_hit_rate_edge':True,'requires_net_return_edge':True}
    return {'version':1 if method==LEGACY_METHOD else 2,
            'probability_threshold':.6 if method==LEGACY_METHOD else .52,
            'min_validation_signals':20,'requires_hit_rate_edge':True,'requires_net_return_edge':True}


def signal_mask(probability,base_rate):
    probability=np.asarray(probability,dtype=float);base_rate=np.asarray(base_rate,dtype=float)
    # Tolerance keeps the declared boundary (e.g. 0.50+0.05) inclusive despite float rounding.
    return (probability>=PROBABILITY_FLOOR-1e-12)&(probability>=base_rate+EDGE-1e-12)


def sequential_trades(rows):
    """Take signals in date order; a new trade starts only after the previous one exited."""
    taken=[];free=None
    for row in rows.sort_values('date').itertuples(index=False):
        if free is None or row.date>=free:
            taken.append(row);free=row.exit_date
    return pd.DataFrame(taken,columns=rows.columns)


def one_sided_p(returns):
    n=len(returns)
    if n<2:return 1.
    sd=float(np.std(returns,ddof=1));mean=float(np.mean(returns))
    if sd==0:return 0. if mean>0 else 1.
    return float(stats.t.sf(mean/(sd/np.sqrt(n)),n-1))


def validation_evidence(validation):
    """validation: date, exit_date, probability, base_rate, y, net_return_pct (walk-forward)."""
    selected=validation.loc[signal_mask(validation.probability,validation.base_rate)]
    trades=sequential_trades(selected);baseline=sequential_trades(validation)
    n=len(trades)
    hit=float(trades.y.mean()) if n else 0.
    mean_return=float(trades.net_return_pct.mean()) if n else 0.
    base_hit=float(baseline.y.mean()) if len(baseline) else 0.
    base_return=float(baseline.net_return_pct.mean()) if len(baseline) else 0.
    p_value=one_sided_p(trades.net_return_pct.to_numpy(dtype=float)) if n else 1.
    reasons=[]
    if n<MIN_TRADES:reasons.append(f'겹치지 않는 검증 거래 {n}건 · 최소 {MIN_TRADES}건 필요')
    if hit<=base_hit:reasons.append('검증 거래 적중률이 항상 매수 기준 이하')
    if mean_return<=max(0,base_return):reasons.append('검증 거래 순수익이 0 또는 항상 매수 기준 이하')
    evidence={'signal_n':int(len(selected)),'trade_n':n,'trade_hit_rate':hit,'trade_mean_return_pct':mean_return,
              'trade_sd_pct':float(trades.net_return_pct.std(ddof=1)) if n>1 else None,'p_value':p_value,
              'baseline_trade_n':int(len(baseline)),'baseline_hit_rate':base_hit,'baseline_mean_return_pct':base_return,
              # v2 field names kept so existing screens and exports keep working
              'selected_n':n,'selected_hit_rate':hit,'base_rate':base_hit,
              'selected_mean_return_pct':mean_return,'base_mean_return_pct':base_return}
    return evidence,not reasons,reasons


def fdr_filter(candidates,q=FDR_Q):
    """Benjamini-Hochberg across every analyzed stock of one scan; mutates candidates."""
    tested=[c for c in candidates if c.get('score') is not None and (c.get('validation') or {}).get('p_value') is not None]
    ranked=sorted(tested,key=lambda c:c['validation']['p_value'])
    m=len(ranked);cutoff=0
    for k,c in enumerate(ranked,1):
        if c['validation']['p_value']<=k/m*q:cutoff=k
    passed={c['code'] for c in ranked[:cutoff]}
    for c in tested:
        c['fdr_passed']=c['code'] in passed
        c['fdr_family']=m
        if c.get('eligible') and not c['fdr_passed']:
            c['eligible']=False
            c['reason']=(c['reason']+' / ' if c.get('reason') else '')+f'다중검정(FDR {q:.0%}) 미통과'
            if c.get('status')=='매수 후보':c['status']='기준 미달'
    return candidates


def trade_outcomes(raw,config):
    """Label before feature filtering; require the complete planned holding window."""
    rows=[]
    costs=config.costs()
    locations={day:i for i,day in enumerate(raw.index)}
    closes=raw.Close.to_numpy(dtype=float);volumes=raw.Volume.to_numpy(dtype=float)
    tradable=np.isfinite(closes)&np.isfinite(volumes)&(closes>0)&(volumes>0)
    for day in raw.index:
        entry=CALENDAR.next_session(day)
        expiry=pd.Timestamp(expiry_day(str(entry.date()),config.holding_mode))
        if expiry>raw.index[-1] or entry not in raw.index:
            continue
        entry_index=locations[entry]
        entry_close=closes[entry_index]
        if not tradable[entry_index]:
            continue
        try:
            position=buy_position(config.capital/100,float(entry_close),costs)
        except ValueError:
            continue
        for exit_index in range(entry_index+1,len(raw)):
            if not tradable[exit_index]:
                continue
            exit_date=raw.index[exit_index]
            change=(closes[exit_index]/entry_close-1)*100
            reason='stop_loss' if change<=-3 else 'take_profit' if change>=5 else 'expiry' if exit_date>=expiry else None
            if reason:
                net=settle(position,float(closes[exit_index])*(1-costs.slippage_pct/100))['net_return_pct']
                rows.append({'date':day,'y':int(net>0),'net_return_pct':net,
                    'entry_close':float(entry_close),'entry_date':entry,'exit_date':exit_date,
                    'exit_reason':reason,'label_end':max(expiry,exit_date)})
                break
    columns=['y','net_return_pct','entry_close','entry_date','exit_date','exit_reason','label_end']
    return pd.DataFrame(rows).set_index('date')[columns] if rows else pd.DataFrame(columns=columns,index=pd.DatetimeIndex([]))


def training_data(raw,config):
    raw=original_frame(raw).sort_index()
    if raw.index.has_duplicates:
        raise ValueError('중복 날짜는 비교 모델에 사용할 수 없습니다.')
    cutoff=raw.index[-1]-pd.DateOffset(years=5)
    raw=raw.loc[raw.index>=cutoff-pd.Timedelta(days=180)]
    # B compares relative signals across regimes rather than memorizing price levels.
    features,_=build_features(raw)
    features=features.drop(columns=['atr_14','traded_value']).replace([np.inf,-np.inf],np.nan).dropna()
    features=features.loc[features.index>=cutoff]
    if features.empty or features.index[-1]!=raw.index[-1]:
        raise ValueError('최신 일봉의 개선 지표가 유효하지 않습니다.')
    outcomes=trade_outcomes(raw.loc[raw.index>=cutoff],config)
    outcomes=outcomes.loc[outcomes.index.intersection(features.index)]
    return raw,features,outcomes


def fit_model(features,y):
    if len(y)<100 or y.nunique()!=2 or y.value_counts().min()<5:
        raise ValueError('개선 모델의 학습 기간 또는 두 정답 종류의 자료가 부족합니다.')
    model=XGBClassifier(n_estimators=100,max_depth=3,learning_rate=.05,min_child_weight=10,
        reg_lambda=5,subsample=.8,colsample_bytree=.8,random_state=42,n_jobs=2,eval_metric='logloss')
    model.fit(features,y.astype(int))
    return model


def calibrator(history):
    y=history.y.astype(int)
    if len(y)<50 or y.nunique()!=2 or y.value_counts().min()<10:
        raise ValueError('학습 외 확률 보정을 위한 두 정답 종류의 자료가 부족합니다.')
    return LogisticRegression(random_state=42).fit(logit(history.raw_probability),y)


def forecast(raw,config):
    raw,features,samples=training_data(raw,config)
    if len(samples)<600:
        raise ValueError('매매 정답·지표 정렬 후 최근 5년 자료가 600개 미만입니다.')
    x=features.loc[samples.index]
    history=[];validation=[];folds=[]
    for fold,(candidates,tests) in enumerate(TimeSeriesSplit(n_splits=5).split(samples),1):
        boundary=samples.index[tests[0]]
        train=np.asarray([i for i in candidates if samples.label_end.iloc[i]<boundary],dtype=int)
        model=fit_model(x.iloc[train],samples.y.iloc[train])
        p=model.predict_proba(x.iloc[tests])[:,1]
        if fold>=FIRST_VALIDATION_FOLD:
            previous=pd.DataFrame(history)
            previous=previous.loc[previous.label_end<boundary]
            calibration=calibrator(previous)
            corrected=calibration.predict_proba(logit(p))[:,1]
            # The base rate a trader could know at that time: mature training labels only.
            base=float(samples.y.iloc[train].mean())
            validation.extend({'date':samples.index[i],'exit_date':samples.exit_date.iloc[i],'probability':float(prob),
                'base_rate':base,'y':int(samples.y.iloc[i]),'net_return_pct':float(samples.net_return_pct.iloc[i])}
                for i,prob in zip(tests,corrected))
            folds.append({'fold':fold,'test_start':str(boundary.date()),
                'test_end':str(samples.index[tests[-1]].date()),
                'train_label_end':str(samples.label_end.iloc[train].max().date()),
                'calibration_label_end':str(previous.label_end.max().date()),'n':len(tests),'base_rate':base})
        history.extend({'raw_probability':float(prob),'y':int(samples.y.iloc[i]),
            'label_end':samples.label_end.iloc[i]} for i,prob in zip(tests,p))
    validation=pd.DataFrame(validation)
    evidence,eligible,reasons=validation_evidence(validation)
    # Once evaluation is fixed, refit the operating model on every mature row.
    final=fit_model(x,samples.y)
    calibration=calibrator(pd.DataFrame(history))
    p=final.predict_proba(features.tail(1))[:,1]
    probability=float(calibration.predict_proba(logit(p))[0,1])
    if not np.isfinite(probability):
        raise ValueError('개선 모델 확률이 유효하지 않습니다.')
    base_rate=float(samples.y.mean())
    required=max(PROBABILITY_FLOOR,base_rate+EDGE)
    signal=bool(signal_mask([probability],[base_rate])[0])
    if not signal:
        reasons=[f'수익 확률 {probability:.1%} < 필요 {required:.1%} (기본 발생률 {base_rate:.1%} + {EDGE*100:.0f}%p, 최소 {PROBABILITY_FLOOR:.0%})',*reasons]
    return {'as_of':str(raw.index[-1].date()),'probability':probability,'precision':None,'signal':int(signal),
        'base_rate':base_rate,'required_probability':required,'signal_today':signal,'evidence_passed':bool(eligible),
        'entry_allowed':bool(eligible and signal),
        'reason':' / '.join(reasons) if reasons else '상대 수익 확률·비중복 검증 거래 우위 통과 (다중검정은 전체 종목 비교 후 적용)',
        'method':METHOD,'target':'다음 종가 매수·-3%/+5%·'+('10거래일' if config.holding_mode=='trading_sessions' else '14일')+' 만기·비용 차감 순수익 >0',
        'holding_mode':config.holding_mode,
        'threshold':required,'feature_count':len(x.columns),'features':list(x.columns),
        'training_start':str(x.index[0].date()),'training_end':str(x.index[-1].date()),
        'training_label_end':str(samples.label_end.max().date()),'training_n':len(x),
        'data_hash':data_hash(raw),'validation':{'start':str(validation.date.min().date()),
            'end':str(validation.date.max().date()),'n':len(validation),**evidence,'folds':folds,
            'note':'시간순 학습 외 예측. 검증 거래는 이전 거래 청산 후에만 다음 신호를 잡아 서로 겹치지 않습니다.'}}
