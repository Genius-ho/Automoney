"""Analysis following decompiled_AI_recovered.py, independently of trade execution."""
from datetime import datetime, timezone
import numpy as np
import pandas as pd
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import precision_score
from xgboost import XGBClassifier
from .data import data_hash, original_frame
from .config import TRAINING_VERSION

METHOD = 'original-close-v1'


def original_features(prices):
    df = original_frame(prices)
    delta = df.Close.diff(1)
    up = delta.where(delta > 0, 0)
    down = -delta.where(delta < 0, 0)
    au = up.ewm(com=13, min_periods=14, adjust=False).mean()
    ad = down.ewm(com=13, min_periods=14, adjust=False).mean()
    df['RSI'] = 100 - 100 / (1 + au / ad)
    ema = df.Close.ewm(span=20, adjust=False, min_periods=20).mean()
    df['Disparity'] = df.Close / ema * 100
    df['MA20'] = df.Close.rolling(window=20).mean()
    std = df.Close.rolling(window=20).std()
    df['Upper'] = df.MA20 + std * 2
    df['Lower'] = df.MA20 - std * 2
    return df.dropna()


def labeled_block(block, horizon, target):
    values = block.values
    x, y = [], []
    for i in range(len(values) - horizon):
        before = values[i, 3]
        after = values[i + 1:i + 1 + horizon, 3]
        x.append(values[i])
        y.append(int(any((after - before) / before * 100 >= target)))
    return np.array(x), np.array(y)


def analyze(prices, settings, market=None, progress=None, compare=True, symbol=None, latest_signal_threshold=None):
    progress = progress or (lambda *args: None)
    raw = original_frame(prices)
    if not raw.index.is_monotonic_increasing or raw.index.has_duplicates:
        raise ValueError('원본 분석에는 날짜가 오름차순이고 중복이 없는 데이터가 필요합니다.')
    if settings.feature_set == 'expanded':
        from .features import expanded_features
        df,groups,notes = expanded_features(raw,market)
    else:
        df = original_features(raw)
        groups,notes = {'original':list(df.columns)},[]
    # Earlier prices are only indicator warmup; no old rows enter a model.
    cutoff = (df.index[-1] if not df.empty else raw.index[-1]) - pd.DateOffset(years=5)
    df = df.loc[df.index >= cutoff]
    recent_raw = raw.loc[(raw.index >= cutoff) & (raw.index <= df.index[-1])] if not df.empty else raw.iloc[:0]
    result = analyze_frame(recent_raw,df,settings,progress,symbol,latest_signal_threshold)
    result.update(feature_set=settings.feature_set,groups=groups,training_version=TRAINING_VERSION,
                  feature_version='original-plus-researched-5y-v1' if settings.feature_set=='expanded' else 'original-close-5y-v1',
                  analysis_window={'years':5,'cutoff':str(cutoff.date()),'start':str(df.index[0].date()),
                                   'end':str(df.index[-1].date()),'rows':len(df)})
    result['warnings'].extend(notes)
    result['warnings'].append('학습·검증과 별도 가상 매매는 분석 기준일 이전 최근 5년으로 제한합니다. 그 이전 가격은 지표 초기 계산에만 사용합니다.')
    if settings.feature_set == 'expanded':
        result['warnings'].append('원본의 정답·5구간 검증·이진 신호 계산을 유지하고 조사한 지표 입력을 확장했습니다.')
        if compare:
            baseline = original_features(raw).loc[df.index]
            reference = analyze_frame(recent_raw,baseline,settings,lambda *args:None,symbol)
            def summary(value,name):
                return {key:value[key] for key in ['feature_count','mean_precision','latest_signal','folds','sample_count']} | {
                    'name':name,'actual_labels':[p['actual'] for p in value['predictions']]}
            result['input_comparison'] = {'same_dates':True,'start':str(df.index[0].date()),
                    'end':str(df.index[-1].date()),'rows':len(df),
                    'models':[summary(reference,'원본 입력 · 공통 날짜'),summary(result,'조사 지표 추가')],
                    'precision_difference':result['mean_precision']-reference['mean_precision']}
    progress(95,'입력 구성별 검증 완료')
    return result


def analyze_frame(raw, df, settings, progress, symbol, latest_signal_threshold=None):
    """Identical recovered-source label/model/fold procedure for a supplied matrix."""
    if len(df) < 6 * (settings.horizon + 1):
        raise ValueError('원본의 5개 검증 구간을 구성할 과거 데이터가 부족합니다.')
    if not np.isfinite(df.to_numpy()).all():
        raise ValueError('모델 입력에 무한값이 있습니다.')
    folds, predictions, precisions = [], [], []
    model = None
    for fold, (train_idx, test_idx) in enumerate(TimeSeriesSplit(n_splits=5).split(df), 1):
        train, test = df.iloc[train_idx], df.iloc[test_idx]
        train_x, train_y = labeled_block(train, settings.horizon, settings.target_pct)
        test_x, test_y = labeled_block(test, settings.horizon, settings.target_pct)
        item = {'fold': fold, 'train_start': str(train.index[0].date()),
                'train_end': str(train.index[-1].date()),
                'test_start': str(test.index[0].date()), 'test_end': str(test.index[-1].date()),
                'train_n': len(train_y), 'n': len(test_y), 'precision': None,
                'selected_n': 0, 'hits': 0, 'skipped': len(set(train_y)) < 2}
        progress(10 + fold * 15, f'원본 방식 검증 {fold}/5')
        if item['skipped']:
            item['reason'] = '학습 정답이 한 종류여서 원본처럼 건너뜁니다.'
            folds.append(item)
            continue
        # Keep the recovered source's model defaults, parameters and fold order.
        model = XGBClassifier(n_estimators=100, max_depth=3, learning_rate=0.1)
        model.fit(train_x, train_y)
        pred = model.predict(test_x)
        precision = float(precision_score(test_y, pred, zero_division=0))
        precisions.append(precision)
        item.update(precision=precision, selected_n=int(pred.sum()),
                    hits=int(((pred == 1) & (test_y == 1)).sum()))
        folds.append(item)
        for i, (signal, actual) in enumerate(zip(pred, test_y)):
            predictions.append({'date': str(test.index[i].date()), 'signal': int(signal),
                                'actual': int(actual), 'fold': fold,
                                'label_end': str(test.index[i + settings.horizon].date())})
    if not precisions:
        raise ValueError('학습 데이터가 부족하거나 설정값이 너무 극단적입니다. 원본처럼 유효한 검증 구간이 없습니다.')
    latest = int(model.predict(df.tail(1).values)[0])
    signal_metadata = {}
    if latest_signal_threshold is not None:
        if not np.isfinite(latest_signal_threshold) or not 0 <= latest_signal_threshold <= 1:
            raise ValueError('신호 기준 확률은 0~1 사이여야 합니다.')
        probability = float(model.predict_proba(df.tail(1).values)[0, 1])
        if not np.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError('최신 신호 확률이 유효하지 않습니다.')
        # Operating entry filter only; recovered historical fold scores stay unchanged.
        latest = int(probability >= latest_signal_threshold)
        signal_metadata = {'signal_probability': probability, 'signal_threshold': latest_signal_threshold}
    close = float(df.Close.iloc[-1])
    warnings = ['평균 적중률은 유효한 검증 구간 precision의 단순 평균입니다. 최신 상승 확률이 아닙니다.',
                '정답은 기준 종가 대비 다음 기간의 종가 중 목표 상승률 도달 여부입니다.',
                '최신 0/1 신호는 마지막 유효 검증 구간에서 학습한 모델을 사용합니다.',
                '원본처럼 조회된 당일 데이터도 포함합니다. 장중 값은 변할 수 있습니다.',
                '가상 매매는 별도 실행 모델입니다. 비용과 고가 체결 여부는 AI 정답에 반영하지 않습니다.',
                '복원한 원본 소스를 기준으로 계산합니다. 실행 파일 복원 과정의 모델 대입 보완이 포함됩니다.']
    progress(95, '원본 평균 적중률 및 최신 신호 계산 완료')
    return {**signal_metadata, 'analysis_method': METHOD, 'created_at': datetime.now(timezone.utc).isoformat(),
            'symbol': symbol or {'code': 'CSV', 'name': 'CSV', 'market': 'KR'},
            'settings': settings.model_dump(), 'data_hash': data_hash(raw),
            'feature_version': METHOD, 'feature_count': len(df.columns),
            'sample_count': len(df), 'as_of': str(df.index[-1].date()), 'close': close,
            'mean_precision': float(np.mean(precisions)), 'latest_signal': latest,
            'selected': latest == 1, 'indicative_target': close * (1 + settings.target_pct / 100),
            'folds': folds, 'valid_folds': len(precisions), 'variants': [], 'holdout': None,
            'predictions': predictions, 'groups': {'original': list(df.columns)},
            'feature_importance': [{'feature': name, 'importance': float(value)}
                                   for name, value in zip(df.columns, model.feature_importances_)],
            'latest_features': {name: float(value) for name, value in df.iloc[-1].items()},
            'chart': [{'date': str(day.date()), 'Close': float(row.Close)}
                      for day, row in raw.tail(500).iterrows() if np.isfinite(row.Close)], 'warnings': warnings}
