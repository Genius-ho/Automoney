"""Current market-cap universe and close-event forecasts for forward paper trading."""
from datetime import datetime
from zoneinfo import ZoneInfo
import re
import numpy as np
import pandas as pd
from .data import timed_call, original_frame
from .config import Settings
from .features import expanded_features
from .model import ProbabilityModel, purged_partition

SIGNAL_THRESHOLD = .6


def rank_universe(frame,quotas=(('KOSPI',50),('KOSDAQ',50))):
    required={'Code','Name','Market','Marcap'}
    if not required.issubset(frame.columns):
        raise ValueError('시가총액 목록에 Code, Name, Market, Marcap이 필요합니다.')
    df=frame.copy()
    df['Code']=df.Code.astype(str).str.zfill(6)
    df['Marcap']=pd.to_numeric(df.Marcap,errors='coerce')
    df['Market']=df.Market.replace({'KOSDAQ GLOBAL':'KOSDAQ'})
    df=df[df.Code.str.fullmatch(r'\d{6}') & np.isfinite(df.Marcap) & (df.Marcap>0)]
    df=df.sort_values(['Marcap','Code'],ascending=[False,True]).drop_duplicates('Code')
    rows=[]
    for exchange,count in quotas:
        top=df[df.Market==exchange].head(count)
        if len(top)!=count:
            raise ValueError(f'{exchange} 시가총액 상위 {count}종목을 확보하지 못했습니다.')
        for rank,(_,row) in enumerate(top.iterrows(),1):
            rows.append({'code':row.Code,'name':str(row.Name),'market':'KR',
                         'exchange':exchange,'rank':rank,'market_cap':float(row.Marcap)})
    return rows


class UniverseProvider:
    def __init__(self,store,quotas=(('KOSPI',50),('KOSDAQ',50)),cache_key='market_cap_universe'):
        self.store,self.quotas,self.cache_key=store,tuple(quotas),cache_key

    def snapshot(self):
        try:
            import FinanceDataReader as fdr
            rows=rank_universe(timed_call(lambda:fdr.StockListing('KRX')),self.quotas)
            result={'rows':rows,'retrieved_at':datetime.now(ZoneInfo('Asia/Seoul')).isoformat(),
                    'source':'FinanceDataReader / KRX','ranking_date':None,'warning':None}
            self.store.put(self.cache_key,result)
            return result
        except Exception as exc:
            cached=self.store.get(self.cache_key)
            if not cached:
                raise ValueError(f'100종목 목록 조회 실패: {exc}') from exc
            # Do not silently use an old ranking to initiate new investment.
            return {**cached,'warning':f'목록 조회 실패: {exc}. 이전 조회 목록이며 신규 매수에 사용하지 않습니다.',
                    'cached':True}


def close_samples(raw,horizon=10,target=5):
    count=len(raw)-horizon
    if count<=0:
        raise ValueError('예측 기간보다 긴 자료가 필요합니다.')
    values=raw.Close.to_numpy(dtype=float)
    if not np.isfinite(values).all() or (values<=0).any():
        raise ValueError('정답 기간에 결측 또는 유효하지 않은 종가가 있습니다.')
    y=[int(np.max(values[i+1:i+horizon+1])>=values[i]*(1+target/100)) for i in range(count)]
    return pd.DataFrame({'y':y,'label_end':raw.index[horizon:]},index=raw.index[:count])


def forecast(raw,criterion='probability'):
    raw=original_frame(raw).sort_index()
    if raw.index.has_duplicates:
        raise ValueError('중복 일봉은 예측에 사용할 수 없습니다.')
    if criterion=='precision':
        from .original_analysis import analyze
        result=analyze(raw,Settings(feature_set='expanded',horizon=10,target_pct=5),compare=False,
                       latest_signal_threshold=SIGNAL_THRESHOLD)
        return {'as_of':result['as_of'],'precision':result['mean_precision'],
                'signal':result['latest_signal'],'signal_probability':result['signal_probability'],
                'signal_threshold':result['signal_threshold'],'probability':None,'horizon':10,'target_pct':5,
                'window_start':result['analysis_window']['start'],'feature_count':result['feature_count']}
    if criterion!='probability':
        raise ValueError('지원하지 않는 매수 기준입니다.')
    features,_,_=expanded_features(raw)
    if features.empty or features.index[-1]!=raw.index[-1]:
        raise ValueError('최신 일봉의 지표가 유효하지 않습니다.')
    features=features.loc[features.index>=raw.index[-1]-pd.DateOffset(years=5)]
    # Label on original trading bars, then align with valid feature dates:
    # a missing feature row must not elongate the target's ten-day horizon.
    samples=close_samples(raw)
    samples=samples.loc[samples.index.intersection(features.index)]
    if len(samples)<350:
        raise ValueError('학습/확률 보정 자료가 부족합니다.')
    labeled=features.loc[samples.index]
    # Latest features have no known future answer and act only as the boundary.
    boundary=pd.DataFrame({'y':[0],'label_end':[raw.index[-1]]},index=[raw.index[-1]])
    partitions=pd.concat([samples,boundary])
    train,cal=purged_partition(partitions,np.arange(len(samples)),np.array([len(samples)]))
    model=ProbabilityModel().fit(labeled,samples,train,cal)
    probability=float(model.predict(features.iloc[[-1]])[0])
    if not np.isfinite(probability):
        raise ValueError('예측 확률이 유효하지 않습니다.')
    return {'as_of':str(raw.index[-1].date()),'probability':probability,'precision':None,'signal':None,
            'horizon':10,'target_pct':5,'feature_count':len(features.columns),
            'window_start':str(features.index[0].date()),'train_n':len(train),'calibration_n':len(cal),
            'train_label_end':str(samples.label_end.iloc[train].max().date()),
            'calibration_start':str(samples.index[cal[0]].date()),
            'calibration_label_end':str(samples.label_end.iloc[cal].max().date()),
            'method':'close-10d-5pct-purged-calibrated-v1'}
