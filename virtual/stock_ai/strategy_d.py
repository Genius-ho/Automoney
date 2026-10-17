"""Strategy D: multi-asset allocation with Korean-listed ETFs, rebalanced monthly.

Research: docs/verification/2026-10-13/strategy-d (2015-07..2026-10, costs, no distributions).
  D0 equal weight of 7 assets                    : 10.1%/yr, max drawdown 11.4%
  D2 inverse-volatility + 200-day trend -> cash  :  3.7%/yr, max drawdown 2.6% (pre-declared winner)
  D3 dual momentum, top 3 by 12m above cash      : 13.6%/yr, max drawdown 17.4%
The user chose to run all three side by side (2026-10-13).
Signal at the last session of each month (and on start); trade at the next session close.
ETFs pay no securities transaction tax; distributions are not credited (prices only).
"""
import numpy as np
import pandas as pd
from .strategy_c import EqualWeightEngine
from .universe_paper import UniverseSettings

ASSETS={'069500':'KODEX 200 (한국 주식)','143850':'TIGER 미국S&P500선물(H)','133690':'TIGER 미국나스닥100',
        '148070':'KOSEF 국고채10년','114260':'KODEX 국고채3년','132030':'KODEX 골드선물(H)','138230':'KOSEF 미국달러선물'}
CASH='153130'
CASH_NAME='KODEX 단기채권 (현금 대용)'
VARIANTS={
    'd0':{'label':'D0','name':'균등 자산배분','method':'etf-equal-weight-7-monthly-v1',
          'summary':'7개 자산 각 1/7 · 매월 재조정'},
    'd2':{'label':'D2','name':'위험균형 + 추세','method':'etf-inverse-vol-trend-monthly-v1',
          'summary':'변동성 낮은 자산 비중↑ · 200일선 아래 자산은 현금'},
    'd3':{'label':'D3','name':'듀얼 모멘텀','method':'etf-dual-momentum-top3-monthly-v1',
          'summary':'12개월 수익 상위 3개 자산 · 현금보다 약하면 현금'},
}
UNIVERSE={'rows':[{'code':c,'name':n,'market':'KR','exchange':'ETF'} for c,n in [*ASSETS.items(),(CASH,CASH_NAME)]],
          'label':'국내 상장 ETF 8종(주식·채권·금·달러·현금)','membership_policy':'fixed'}


def closes(frames,day):
    px=pd.DataFrame({c:f.Close for c,f in frames.items() if f is not None and not f.empty})
    px=px.loc[px.index<=pd.Timestamp(day)].sort_index().ffill(limit=3)
    return px


def allocation(variant,frames,day):
    """Return (weights, reasons). Requires today's close for every ETF and 260 sessions of history."""
    reasons={}
    for code in [*ASSETS,CASH]:
        f=frames.get(code)
        if f is None or f.empty or str(f.index[-1].date())!=day:reasons[code]='기준일 종가 없음'
        elif len(f.loc[f.index<=pd.Timestamp(day)])<260:reasons[code]='이력 260일 미만'
    if reasons:return {},reasons
    px=closes(frames,day);risky=list(ASSETS)
    if variant=='d0':
        return {c:1/len(risky) for c in risky},{}
    if variant=='d2':
        vol=px[risky].pct_change(fill_method=None).tail(60).std()
        inv=(1/vol)/(1/vol).sum()
        above=px[risky].iloc[-1]>px[risky].tail(200).mean()
        w={c:float(inv[c]) for c in risky if above[c]}
        for c in risky:
            if not above[c]:reasons[c]='200일 평균 아래 → 현금'
        w[CASH]=1-sum(w.values())
        return {c:v for c,v in w.items() if v>1e-9},reasons
    if variant=='d3':
        mom=px.iloc[-1]/px.iloc[-253]-1
        top=mom[risky].sort_values(ascending=False).head(3)
        chosen=[c for c in top.index if top[c]>mom[CASH]]
        for c in risky:
            if c not in chosen:reasons[c]=f'12개월 {mom[c]:+.1%} · 상위 3 아님' if c not in top.index else f'12개월 {mom[c]:+.1%} · 현금보다 약함'
        w={c:1/3 for c in chosen}
        if len(chosen)<3:w[CASH]=1-len(chosen)/3
        return w,reasons
    raise ValueError('알 수 없는 D 전략입니다.')


class AllocationEngine(EqualWeightEngine):
    min_targets=1

    def __init__(self,store,provider,variant):
        if variant not in VARIANTS:raise ValueError('알 수 없는 D 전략입니다.')
        super().__init__(store,provider,lambda:UNIVERSE)
        self.variant=variant;spec=VARIANTS[variant]
        self.key='strategy_'+variant+'_paper';self.label=spec['label'];self.method=spec['method']

    def config(self):
        # ETFs are exempt from the securities transaction tax.
        return {**super().config(),'sell_tax_pct':0.}

    def default(self):
        state=super().default()
        state['message']=f"{self.label} {VARIANTS[self.variant]['name']} · 시작하면 다음 거래일 종가에 ETF를 매수합니다."
        return state

    def targets(self,frames,day):
        return allocation(self.variant,frames,day)

    def next_signal_day(self,state,day,execution):
        # This month's last session; if today is it, next month's.
        last=self.calendar.date_to_session(pd.Timestamp(day)+pd.offsets.MonthEnd(0),direction='previous')
        if str(last.date())<=day:
            last=self.calendar.date_to_session(pd.Timestamp(day)+pd.offsets.MonthBegin(1)+pd.offsets.MonthEnd(0),direction='previous')
        return str(last.date())

    def target_message(self,day,weights,execution):
        names={r['code']:r['name'] for r in UNIVERSE['rows']}
        parts=' · '.join(f"{names[c].split(' (')[0]} {w:.0%}" for c,w in sorted(weights.items(),key=lambda x:-x[1]))
        return f'{day} 기준 목표 비중: {parts} · {execution} 종가 재조정 예약'


def engines(store,provider):
    return {v:AllocationEngine(store,provider,v) for v in VARIANTS}
