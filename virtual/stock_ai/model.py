import numpy as np
from xgboost import XGBClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss


def purged_partition(samples, candidates, tests):
    boundary = samples.index[tests[0]]
    candidates = np.asarray([i for i in candidates if samples.label_end.iloc[i] < boundary], dtype=int)
    split = int(len(candidates)*.8)
    cal = candidates[split:]
    if len(cal) < 50:
        raise ValueError('확률 보정 자료 50개 이상이 필요합니다.')
    train = np.asarray([i for i in candidates[:split] if samples.label_end.iloc[i] < samples.index[cal[0]]],dtype=int)
    if len(train) < 200:
        raise ValueError('학습 자료 200개 이상이 필요합니다.')
    for indices in [train,cal]:
        counts = samples.y.iloc[indices].value_counts()
        if len(counts)!=2 or counts.min()<10:
            raise ValueError('학습/보정 클래스별 자료 10개 이상이 필요합니다.')
    return train, cal


def logit(probability):
    p = np.clip(np.asarray(probability),1e-6,1-1e-6)
    return np.log(p/(1-p)).reshape(-1,1)


class ProbabilityModel:
    def fit(self, features, samples, train, cal):
        self.base = XGBClassifier(n_estimators=100,max_depth=3,learning_rate=.1,
                                  random_state=42,n_jobs=2,eval_metric='logloss')
        self.base.fit(features.iloc[train],samples.y.iloc[train].astype(int))
        self.calibrator = LogisticRegression(random_state=42)
        self.calibrator.fit(logit(self.base.predict_proba(features.iloc[cal])[:,1]),
                            samples.y.iloc[cal].astype(int))
        return self

    def predict(self, features):
        return self.calibrator.predict_proba(logit(self.base.predict_proba(features)[:,1]))[:,1]


def metrics(y, p, threshold):
    y,p = np.asarray(y,dtype=int), np.asarray(p,dtype=float)
    selected = p >= threshold/100
    bins = []
    for lo in np.arange(0,1,.1):
        mask = (p>=lo)&(p<lo+.1 if lo<.9 else p<=1)
        count = int(mask.sum())
        bins.append({'low':round(float(lo),1),'high':round(float(lo+.1),1),'n':count,
                     'actual_rate':float(y[mask].mean()) if count else None,'small_sample':count<20})
    return {'n':len(y), 'base_rate':float(y.mean()), 'brier':float(brier_score_loss(y,p)),
            'log_loss':float(log_loss(y,np.clip(p,1e-6,1-1e-6),labels=[0,1])),
            'selected_n':int(selected.sum()),
            'selected_hit_rate':float(y[selected].mean()) if selected.any() else None,'bins':bins}
