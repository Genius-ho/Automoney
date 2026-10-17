"""Causal feature families; no future values or back-filling."""
import numpy as np
import pandas as pd


def ratio(a, b, neutral=0):
    out = a / b.replace(0, np.nan)
    return out.mask((b == 0) & a.notna(), neutral)


def wilder(series, n=14):
    return series.ewm(alpha=1/n, adjust=False, min_periods=n).mean()


def rsi(close, n):
    delta = close.diff()
    up, down = wilder(delta.clip(lower=0), n), wilder(-delta.clip(upper=0), n)
    result = 100 - 100 / (1 + up / down)
    return result.mask((up == 0) & (down == 0), 50).mask((up > 0) & (down == 0), 100)


def build_features(df, market=None):
    c, h, l, o, v = (df[k].astype(float) for k in ['Close','High','Low','Open','Volume'])
    features, groups = {}, {}
    def add(group, values):
        groups[group] = list(values)
        features.update(values)
    returns = {f'return_{n}': c.pct_change(n, fill_method=None) for n in [1,3,5,10,20]}
    add('returns', returns)
    sma = {n:c.rolling(n).mean() for n in [5,20,60]}
    ema = {n:c.ewm(span=n, adjust=False, min_periods=n).mean() for n in [5,20,60]}
    add('averages', {**{f'sma_gap_{n}':c/sma[n]-1 for n in sma},
                     **{f'ema_gap_{n}':c/ema[n]-1 for n in ema},
                     'sma_ratio_5_20':sma[5]/sma[20]-1, 'sma_ratio_20_60':sma[20]/sma[60]-1})
    add('rsi', {f'rsi_{n}':rsi(c,n) for n in [7,14]})
    tr = pd.concat([h-l, (h-c.shift()).abs(), (l-c.shift()).abs()], axis=1).max(axis=1)
    atr = wilder(tr)
    add('volatility', {'atr_14':atr, 'natr_14':atr/c*100,
                       'realized_vol_10':returns['return_1'].rolling(10).std(),
                       'realized_vol_20':returns['return_1'].rolling(20).std()})
    std = c.rolling(20).std()
    add('bollinger', {'bb_pct_b':ratio(c-(sma[20]-2*std), 4*std, .5), 'bb_width':4*std/sma[20]})
    traded = c*v
    add('volume', {'volume_ratio_5':ratio(v,v.rolling(5).mean(),1),
                   'volume_ratio_20':ratio(v,v.rolling(20).mean(),1),
                   'traded_value':traded, 'traded_value_ratio_20':ratio(traded,traded.rolling(20).mean(),1)})
    obv = (np.sign(c.diff()).fillna(0)*v).cumsum()
    tp = (h+l+c)/3
    flow = tp*v
    positive = flow.where(tp.diff() > 0,0).rolling(14).sum()
    negative = flow.where(tp.diff() < 0,0).rolling(14).sum()
    mfi = (100-100/(1+positive/negative)).mask((positive==0)&(negative==0),50).mask((positive>0)&(negative==0),100)
    money_mult = ratio(2*c-h-l,h-l,0)
    add('money_flow', {'obv_change_5_scaled':ratio(obv.diff(5),v.rolling(5).sum()),
                      'obv_change_20_scaled':ratio(obv.diff(20),v.rolling(20).sum()),
                      'mfi_14':mfi, 'cmf_20':ratio((money_mult*v).rolling(20).sum(),v.rolling(20).sum())})
    macd = c.ewm(span=12,adjust=False,min_periods=12).mean()-c.ewm(span=26,adjust=False,min_periods=26).mean()
    signal = macd.ewm(span=9,adjust=False,min_periods=9).mean()
    add('macd', {'macd_relative':macd/c, 'macd_signal_relative':signal/c, 'macd_hist_relative':(macd-signal)/c})
    up, down = h.diff(), -l.diff()
    plus = ratio(100*wilder(up.where((up>down)&(up>0),0)),atr)
    minus = ratio(100*wilder(down.where((down>up)&(down>0),0)),atr)
    adx = wilder(ratio(100*(plus-minus).abs(),plus+minus))
    add('directional', {'adx_14':adx,'plus_di_14':plus,'minus_di_14':minus,'di_difference_14':plus-minus})
    hh, ll = h.rolling(14).max(), l.rolling(14).min()
    k = ratio(100*(c-ll),hh-ll,50).rolling(3).mean()
    d = k.rolling(3).mean()
    deviation = tp.rolling(20).apply(lambda a:np.mean(np.abs(a-a.mean())),raw=True)
    add('oscillators', {'stoch_k':k, 'stoch_d':d, 'stoch_k_minus_d':k-d,
                        'cci_20':ratio(tp-tp.rolling(20).mean(),.015*deviation),
                        'williams_r_14':ratio(-100*(hh-c),hh-ll,-50)})
    hh20, ll20 = h.rolling(20).max(), l.rolling(20).min()
    add('donchian', {'donchian_position_20':ratio(c-ll20,hh20-ll20,.5),
                    'donchian_width_20':(hh20-ll20)/c,
                    'previous_high_gap_20':c/hh20.shift()-1, 'previous_low_gap_20':c/ll20.shift()-1})
    if market is not None and not market.empty:
        mc = market['Close'] if isinstance(market,pd.DataFrame) else market
        mc = mc.reindex(df.index,method='ffill')
        mr5, mr20 = mc.pct_change(5,fill_method=None),mc.pct_change(20,fill_method=None)
        add('market', {'market_return_5':mr5,'market_return_20':mr20,'relative_return_20':returns['return_20']-mr20})
    add('bar_shape', {'intraday_range':(h-l)/c,'open_close_return':c/o-1})
    return pd.DataFrame(features,index=df.index).replace([np.inf,-np.inf],np.nan), groups


def baseline_features(df):
    c = df.Close
    sma, std = c.rolling(20).mean(), c.rolling(20).std()
    result = df[['Open','High','Low','Close','Volume']].copy()
    result['return_1'] = c.pct_change(fill_method=None)
    result['RSI14'] = rsi(c,14)
    result['EMA20_disparity'] = c/c.ewm(span=20,adjust=False,min_periods=20).mean()*100
    result['MA20'], result['Upper'], result['Lower'] = sma,sma+2*std,sma-2*std
    return result


def expanded_features(prices, market=None):
    """Append researched inputs while preserving the recovered original columns."""
    from .original_analysis import original_features
    original = original_features(prices)
    notes = []
    if market is not None and not market.empty:
        # A stale tail must not masquerade as a current market observation.
        close = market.Close if isinstance(market,pd.DataFrame) else market
        valid = close.dropna()
        if valid.empty or not np.isfinite(valid.to_numpy()).all() or (valid <= 0).any() or prices.index[-1] not in valid.index:
            notes.append('시장 지수의 최신 날짜 또는 가격이 유효하지 않아 시장 입력 3개를 제외했습니다.')
            market = None
    else:
        notes.append('시장 지수 자료가 없어 시장 입력 3개를 제외했습니다.')
    extra, groups = build_features(prices,market)
    redundant = {'rsi_14','ema_gap_20'}
    if 'Change' in prices:
        redundant.add('return_1')
    extra = extra.drop(columns=list(redundant),errors='ignore')
    groups = {'original':list(original.columns), **{name:[column for column in columns if column in extra]
              for name,columns in groups.items()}}
    combined = original.join(extra).replace([np.inf,-np.inf],np.nan).dropna()
    if combined.empty or combined.index[-1] != prices.index[-1]:
        raise ValueError('최신 일봉의 추가 지표를 계산할 수 없습니다. 충분한 이력과 유효한 가격을 확인하세요.')
    dropped = len(original)-len(combined)
    notes.append(f'추가 지표의 초기 계산 기간·결측으로 원본 입력 가능 행 중 {dropped}개를 제외했습니다. 비교 모델은 같은 날짜를 사용합니다.')
    return combined,groups,notes
