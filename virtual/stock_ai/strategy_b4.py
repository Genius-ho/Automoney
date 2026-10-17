"""B v4: one pooled model over the whole B universe, top-K ranking each week.

Why (2026-10-14): v3 fitted a separate model per stock and asked each stock to prove its own
edge from ~15 non-overlapping trades, then cut the passes with Benjamini-Hochberg over ~335
tests (the best stock needs p < 0.0003). The 2026-10-13 selection therefore bought nothing:
14 stocks signalled today, 34 passed their own history, 6 passed both and FDR removed all 6.

v4 learns the same cost-aware trade label (next close buy, -3%/+5%, 10 sessions, net > 0)
from every stock at once and reserves the TOP_K highest-scoring stocks outside the bottom 20%
of 20-day traded value. Each weekly scan retrains on the mature labels of the last five years.

Research (2026-10-14, B's 351 stocks, weekly signals, walk-forward semiannual retraining,
costs included). Rule declared before running: pick the variant/K with the best 2018-2022
mean excess over the liquid-universe average, then report 2023-2026.09 once.
  candidates: raw indicators / cross-sectional ranks (classifier, regressor) / 5-day reversal /
  20-day momentum / low volatility, each with K = 10, 20, 30
  chosen raw-indicator classifier, K=20 (per 10-session trade, net of costs):
    2018-2022  selected -0.12% vs universe -0.36%  excess +0.24%p (t 2.7, overlapping weeks)
    2023-2026  selected +0.30% vs universe +0.27%  excess +0.03%p (t 0.2), hit 43.3% vs 43.8%
The holdout edge is indistinguishable from buying the universe at random; v4 removes the
always-cash outcome but does not establish a forecasting edge. Survivorship: the universe is
today's index constituents.
"""
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from .data import data_hash
from .strategy_two import training_data

METHOD='pooled-rank-top-k-v4'
TOP_K=20
LIQUIDITY_CUT=.2
MIN_STOCKS=100
RESEARCH={'summary':'2018~2022 우주 평균 대비 +0.24%p/거래 → 2023~2026.09 검증 구간 +0.03%p (통계적 차이 없음)',
    'dev':{'period':'2018-01~2022-12','selected_pct':-.123,'universe_pct':-.358,'excess_pct':.235},
    'holdout':{'period':'2023-01~2026-09','selected_pct':.299,'universe_pct':.271,'excess_pct':.028}}


def selection_rules():
    return {'version':4,'top_k':TOP_K,'liquidity_cut':LIQUIDITY_CUT,'probability_threshold':0.,
            'requires_hit_rate_edge':False,'requires_net_return_edge':False,'research':RESEARCH}


def model():
    return XGBClassifier(n_estimators=300,max_depth=4,learning_rate=.03,min_child_weight=200,subsample=.7,
        colsample_bytree=.7,reg_lambda=5,n_jobs=2,random_state=42,tree_method='hist',eval_metric='logloss')


def liquid_rows(panel):
    """True outside the bottom LIQUIDITY_CUT of 20-day traded value on the same date."""
    return panel.groupby('date')['tv20'].rank(pct=True)>LIQUIDITY_CUT


def rank_filter(candidates,k=TOP_K):
    """Keep the k best-scoring eligible, affordable candidates; mutates and returns candidates."""
    ranked=sorted((c for c in candidates if c.get('eligible') and c.get('affordable')),key=lambda c:-c['score'])
    for position,c in enumerate(ranked,1):
        c['pool_rank']=position
        if position>k:
            c['eligible']=False;c['status']='기준 미달'
            c['reason']=f'통합 순위 {position}위 · 상위 {k}종목만 매수'
    return candidates


class PooledSelector:
    """predict() runs per stock during the scan; select() fits the pooled model on all of them."""

    def __init__(self,k=TOP_K):
        self.k=k;self.items={}

    def predict(self,raw,config):
        raw,features,outcomes=training_data(raw,config)
        key=data_hash(raw)
        tv20=(raw.Close*raw.Volume).rolling(20).mean().reindex(features.index)
        self.items[key]=(features,outcomes,tv20)
        base=float(outcomes.y.mean()) if len(outcomes) else None
        # Placeholder until select(): every stock is scored together after the scan.
        return {'as_of':str(raw.index[-1].date()),'probability':0.,'precision':None,'signal':0,
            'entry_allowed':False,'base_rate':base,'method':METHOD,'data_hash':key,
            'reason':'통합 모델 순위 계산 전','target':'다음 종가 매수·-3%/+5%·10거래일 만기·비용 차감 순수익 >0',
            'holding_mode':config.holding_mode,'training_start':str(features.index[0].date()),
            'training_end':str(outcomes.index[-1].date()) if len(outcomes) else None,
            'training_label_end':str(outcomes.label_end.max().date()) if len(outcomes) else None,
            'training_n':len(outcomes),'feature_count':None}

    def select(self,candidates):
        scored=[c for c in candidates if c.get('score') is not None and c.get('data_hash') in self.items]
        if len(scored)<MIN_STOCKS:
            for c in scored:c.update(reason=f'정상 분석 {len(scored)}종목 < {MIN_STOCKS}종목 · 통합 순위 보류',eligible=False,status='기준 미달')
            return candidates
        frames=[]
        for c in scored:
            features,outcomes,tv20=self.items[c['data_hash']]
            frame=features.join(outcomes[['y']],how='left').assign(tv20=tv20,code=c['code'])
            frames.append(frame.rename_axis('date').reset_index())
        panel=pd.concat(frames,ignore_index=True).dropna(subset=['tv20'])
        columns=list(self.items[scored[0]['data_hash']][0].columns)
        x=panel[columns];liquid=liquid_rows(panel)
        day=pd.Timestamp(scored[0]['as_of'])
        train=panel.y.notna()&liquid&(panel.date<day)
        y=panel.y[train].astype(int)
        fitted=model().fit(x[train],y)
        today=(panel.date==day).to_numpy()
        probability=dict(zip(panel.code[today],fitted.predict_proba(x[today])[:,1]))
        liquid_today=dict(zip(panel.code[today],liquid[today]))
        base=float(y.mean())
        for c in scored:
            p=probability.get(c['code'])
            if p is None:
                c.update(eligible=False,status='기준 미달',reason='기준일 지표 없음 · 통합 순위 제외');continue
            ok=bool(liquid_today[c['code']])
            c.update(probability=float(p),score=float(p),base_rate=base,pooled_base_rate=base,
                feature_count=x.shape[1],training_n=int(train.sum()),threshold=None,
                signal=int(ok),signal_today=ok,entry_allowed=ok,eligible=ok,
                reason=f'통합 수익 확률 {p:.1%} (전체 기본 {base:.1%})' if ok else f'20일 거래대금 하위 {LIQUIDITY_CUT:.0%} · 제외')
            if not ok:c['status']='기준 미달'
            elif c.get('affordable'):c['status']='매수 후보'
            else:c['status']='1주 예산 부족'
        rank_filter(candidates,self.k)
        for c in candidates:
            if c.get('eligible'):c['reason']=f"통합 순위 {c['pool_rank']}위 · "+c['reason']
        return candidates
