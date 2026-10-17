import numpy as np
import pandas as pd
import pytest
from stock_ai import strategy_two as strategy
from stock_ai.universe_paper import UniverseSettings
from stock_ai.paper_cycles import CALENDAR, expiry_day
from stock_ai.costs import buy_position, settle


def validation_frame(probabilities,ys,returns,base=.4,spacing=1):
    dates=pd.bdate_range('2024-01-01',periods=len(probabilities)*spacing)[::spacing]
    return pd.DataFrame({'date':dates,'exit_date':dates+pd.Timedelta(days=spacing),
        'probability':probabilities,'base_rate':base,'y':ys,'net_return_pct':returns})


def test_v3_signal_is_relative_to_base_rate_with_a_fifty_percent_floor():
    assert list(strategy.signal_mask([.45,.5,.55,.5499],[.4,.4,.5,.5]))==[False,True,True,False]
    assert not strategy.signal_mask([.49],[.3])[0]


def test_v3_evidence_counts_only_non_overlapping_trades():
    # 30 daily signals whose trades last 10 days -> 3 independent trades, not 30.
    dates=pd.bdate_range('2024-01-01',periods=30)
    frame=pd.DataFrame({'date':dates,'exit_date':dates+pd.Timedelta(days=14),'probability':.7,'base_rate':.4,
                        'y':1,'net_return_pct':2.})
    evidence,eligible,reasons=strategy.validation_evidence(frame)
    assert evidence['signal_n']==30 and evidence['trade_n']==3 and not eligible
    assert any('겹치지 않는' in r for r in reasons)


def test_v3_evidence_requires_edge_over_always_buy_and_positive_return():
    n=40
    good=validation_frame([.7]*n,[1,1,1,0]*10,[3.,2.,1.,-2.]*10)
    evidence,eligible,_=strategy.validation_evidence(good)
    # every row signals, so the signal trades equal the always-buy trades -> no edge
    assert evidence['trade_n']==40 and not eligible
    mixed=validation_frame([.7,.3]*n,[1,0]*n,[2.,-2.]*n)
    evidence,eligible,reasons=strategy.validation_evidence(mixed)
    assert evidence['trade_n']==40 and evidence['trade_mean_return_pct']==2. and eligible and not reasons
    assert evidence['p_value']==0.
    losing=mixed.assign(net_return_pct=np.where(mixed.y==1,-.5,-2.))
    assert not strategy.validation_evidence(losing)[1]


def test_benjamini_hochberg_filter_cuts_lucky_passes_across_the_universe():
    rows=[{'code':str(i),'score':.6,'eligible':True,'status':'매수 후보','validation':{'p_value':p}}
          for i,p in enumerate([.001,.008,.039,.041,.2]+[.9]*15)]
    strategy.fdr_filter(rows,.10)
    # m=20: thresholds k*0.005 -> .001<=.005, .008<=.010, .039>.015, .041>.020
    assert [r['fdr_passed'] for r in rows[:5]]==[True,True,False,False,False]
    assert rows[2]['eligible'] is False and rows[2]['status']=='기준 미달' and 'FDR' in rows[2]['reason']
    assert rows[0]['eligible'] and rows[0]['fdr_family']==20


def bars():
    dates=CALENDAR.sessions_in_range('2023-01-02','2023-03-31')
    return pd.DataFrame({'Open':100.,'High':110.,'Low':90.,'Close':100.,'Volume':1000.},index=dates)


def test_trade_target_uses_next_close_and_first_stop_including_costs():
    raw=bars();raw.iloc[2,raw.columns.get_loc('Close')]=96
    raw.iloc[3,raw.columns.get_loc('Close')]=106
    config=UniverseSettings()
    result=strategy.trade_outcomes(raw,config).iloc[0]
    expected=settle(buy_position(config.capital/100,100,config.costs()),96*(1-config.slippage_pct/100))
    assert result.y==0
    assert result.exit_reason=='stop_loss'
    assert result.exit_date==raw.index[2]
    assert result.net_return_pct==pytest.approx(expected['net_return_pct'])
    raw.iloc[1,raw.columns.get_loc('Close')]=110
    assert strategy.trade_outcomes(raw,config).iloc[0].entry_close==110


def test_unknown_expiry_is_excluded_even_when_early_profit_is_visible():
    raw=bars();raw.iloc[2,raw.columns.get_loc('Close')]=106
    config=UniverseSettings()
    result=strategy.trade_outcomes(raw,config)
    first=result.iloc[0]
    assert first.y==1 and first.exit_reason=='take_profit'
    expiry=pd.Timestamp(expiry_day(str(raw.index[1].date())))
    assert first.label_end==expiry
    assert raw.index[0] not in strategy.trade_outcomes(raw.loc[raw.index<expiry],config).index
    assert result.label_end.max()<=raw.index[-1]


def test_missing_next_session_never_becomes_a_later_entry():
    raw=bars()
    result=strategy.trade_outcomes(raw.drop(raw.index[1]),UniverseSettings())
    assert raw.index[0] not in result.index


def test_expiry_uses_calendar_days_and_flat_price_loses_costs():
    raw=bars();result=strategy.trade_outcomes(raw,UniverseSettings()).iloc[0]
    assert result.exit_date==pd.Timestamp(expiry_day(str(raw.index[1].date())))
    assert result.exit_reason=='expiry'
    assert result.net_return_pct<0 and result.y==0


def test_future_changes_do_not_change_mature_trade_labels():
    raw=bars();cutoff=pd.Timestamp('2023-02-01')
    first=strategy.trade_outcomes(raw,UniverseSettings())
    changed=raw.copy();changed.loc[changed.index>cutoff,'Close']*=2
    second=strategy.trade_outcomes(changed,UniverseSettings())
    mature=first.index[first.label_end<=cutoff]
    pd.testing.assert_frame_equal(first.loc[mature],second.loc[mature])


def test_walk_forward_calibration_is_purged_and_final_model_uses_recent_mature_rows():
    dates=CALENDAR.sessions_in_range('2020-01-02','2026-10-08')
    rng=np.random.default_rng(56)
    close=10000*np.exp(np.cumsum(rng.normal(0,.025,len(dates))))
    raw=pd.DataFrame({'Open':close,'High':close*1.02,'Low':close*.98,'Close':close,
                      'Volume':rng.integers(100,10000,len(dates))},index=dates)
    result=strategy.forecast(raw,UniverseSettings())
    assert 0<=result['probability']<=1
    assert result['training_start']>='2021-10-08'
    assert result['training_end']>='2026-09-01'
    assert result['training_label_end']<=result['as_of']
    assert result['method']==strategy.METHOD
    assert len(result['validation']['folds'])==3
    for fold in result['validation']['folds']:
        assert fold['train_label_end']<fold['test_start']
        assert fold['calibration_label_end']<fold['test_start']
    v=result['validation']
    assert v['trade_n']<=v['signal_n'] and 0<=v['p_value']<=1
    assert result['required_probability']==pytest.approx(max(.5,result['base_rate']+.05))
    assert result['signal_today']==(result['probability']>=result['required_probability'])
    assert result['entry_allowed']==(result['signal_today'] and result['evidence_passed'])
