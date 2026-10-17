from datetime import datetime, timezone
import importlib.metadata
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from .features import build_features, baseline_features
from .labels import make_labels
from .model import ProbabilityModel, purged_partition, metrics
from .data import data_hash
from .costs import buy_position, target_price


def datestr(value):
    return str(pd.Timestamp(value).date())


def analyze(prices, settings, market=None, progress=None, compare=True, symbol=None):
    notify = progress or (lambda percent,message:None)
    market_code = (symbol or {}).get('market','KR')
    notify(5,'기술 지표와 순수익 목표 라벨 계산')
    expanded, groups = build_features(prices,market)
    original = baseline_features(prices)
    labels = make_labels(prices,settings,market_code)
    usable = expanded.notna().all(axis=1)&original.notna().all(axis=1)&labels.y.notna()
    samples = labels.loc[usable]
    full = expanded.loc[usable]
    old = original.loc[usable]
    if len(samples) < 600:
        raise ValueError(f'분석 자료 부족: 지표·목표 기간 제외 후 {len(samples)}개. 최소 600개 이상 필요합니다.')
    hold_start = int(len(samples)*.8)
    hold_idx = np.arange(hold_start,len(samples))
    if len(hold_idx) < 100:
        raise ValueError('최종 평가 자료 100개 이상 필요합니다.')
    folds = []
    for candidates,tests in TimeSeriesSplit(n_splits=5).split(samples.iloc[:hold_start]):
        if len(tests)<50:
            continue
        try:
            train,cal = purged_partition(samples,candidates,tests)
        except ValueError:
            continue
        folds.append((train,cal,tests))
    if len(folds)<2:
        raise ValueError('유효 시간순 검증 구간이 2개 미만입니다. 이력·목표·클래스 자료를 확인하세요.')
    variants = [('original',old),('full',full)]
    if compare:
        variants += [(f'without_{name}',full.drop(columns=columns)) for name,columns in groups.items()]
    results, fold_info, oos = [], [], []
    constant_y,constant_p = [],[]
    total = len(variants)*len(folds)+3
    done = 0
    for name,features in variants:
        ys, ps = [],[]
        for fold_no,(train,cal,tests) in enumerate(folds,1):
            model = ProbabilityModel().fit(features,samples,train,cal)
            probabilities = model.predict(features.iloc[tests])
            y = samples.y.iloc[tests].astype(int).to_numpy()
            ys.extend(y); ps.extend(probabilities)
            done += 1
            notify(10+int(75*done/total),f'{name} — 시간순 검증 {fold_no}/{len(folds)}')
            if name=='full':
                info = {'fold':fold_no, 'train_start':datestr(samples.index[train[0]]),
                        'train_end':datestr(samples.index[train[-1]]),
                        'train_label_end':datestr(samples.label_end.iloc[train].max()),
                        'cal_start':datestr(samples.index[cal[0]]),'cal_end':datestr(samples.index[cal[-1]]),
                        'cal_label_end':datestr(samples.label_end.iloc[cal].max()),
                        'test_start':datestr(samples.index[tests[0]]),'test_end':datestr(samples.index[tests[-1]]),
                        'train_n':len(train),'cal_n':len(cal), **metrics(y,probabilities,settings.threshold_pct)}
                fold_info.append(info)
                constant_y.extend(y)
                constant_p.extend([float(samples.y.iloc[train].mean())]*len(y))
                oos += [{'date':datestr(samples.index[i]),'probability':float(p),'actual':int(samples.y.iloc[i]),
                         'label_end':datestr(samples.label_end.iloc[i]),'segment':f'fold_{fold_no}'}
                        for i,p in zip(tests,probabilities)]
        results.append({'name':name, **metrics(ys,ps,settings.threshold_pct)})
    results.append({'name':'constant_prior',**metrics(constant_y,constant_p,settings.threshold_pct)})
    train,cal = purged_partition(samples,np.arange(hold_start),hold_idx)
    holdouts = {}
    for name,features in [('original',old),('full',full)]:
        model = ProbabilityModel().fit(features,samples,train,cal)
        p = model.predict(features.iloc[hold_idx])
        holdouts[name] = {'start':datestr(samples.index[hold_idx[0]]),'end':datestr(samples.index[hold_idx[-1]]),
                          **metrics(samples.y.iloc[hold_idx],p,settings.threshold_pct)}
        if name=='full':
            oos += [{'date':datestr(samples.index[i]),'probability':float(prob),'actual':int(samples.y.iloc[i]),
                     'label_end':datestr(samples.label_end.iloc[i]),'segment':'holdout'} for i,prob in zip(hold_idx,p)]
    # Boundary beyond all mature labels, then reserve a separate calibration tail.
    last_candidates = np.arange(len(samples))
    cut = int(len(samples)*.8)
    final_cal = last_candidates[cut:]
    final_train = np.array([i for i in last_candidates[:cut] if samples.label_end.iloc[i]<samples.index[final_cal[0]]])
    for indices in [final_train,final_cal]:
        counts = samples.y.iloc[indices].value_counts()
        if len(counts)!=2 or counts.min()<10:
            raise ValueError('최종 학습/보정 클래스별 자료 부족입니다.')
    latest = expanded.dropna().tail(1)
    if latest.index[-1] != prices.index[-1]:
        raise ValueError('최신 날짜의 지표를 계산할 수 없습니다. 시장 입력을 확인하세요.')
    notify(90,'현재 모델 보정 및 최종 평가 정리')
    model = ProbabilityModel().fit(full,samples,final_train,final_cal)
    probability = float(model.predict(latest)[0])
    importance = sorted([{'feature':k,'importance':float(v)} for k,v in zip(full.columns,model.base.feature_importances_)],
                        key=lambda r:r['importance'],reverse=True)
    estimated = buy_position(settings.capital,prices.Close.iloc[-1],settings,market_code)
    chart = [{'date':datestr(date),**{k:float(row[k]) for k in prices.columns}}
             for date,row in prices.tail(300).iterrows()]
    notify(95,'가상 매매 비교 준비')
    return {'created_at':datetime.now(timezone.utc).isoformat(),'symbol':symbol or {'code':'CSV','name':'CSV','market':market_code},
            'settings':settings.model_dump(),'data_hash':data_hash(prices),'feature_version':'50-v1-net-next-open',
            'feature_count':len(full.columns),'groups':groups,'sample_count':len(samples),
            'as_of':datestr(latest.index[-1]),'close':float(prices.Close.iloc[-1]),
            'latest_probability':probability,'selected':probability>=settings.threshold_pct/100,
            'indicative_target':target_price(estimated),'indicative_quantity':estimated['quantity'],
            'folds':fold_info,'variants':results,'holdout':holdouts['full'],'holdout_comparison':holdouts,
            'predictions':oos,'feature_importance':importance,
            'latest_features':{k:float(v) for k,v in latest.iloc[0].items()},'chart':chart,
            'versions':{k:importlib.metadata.version(k) for k in ['numpy','pandas','scikit-learn','xgboost']},
            'warnings':['확률은 모델 추정치이며 목표 호가 도달과 실제 체결은 다릅니다.',
                        '수수료·세금 초기값은 예시입니다. 실제 적용 비용을 설정하세요.',
                        '반복 설정 실험은 같은 최종 평가 자료를 재사용할 수 있습니다.']}
