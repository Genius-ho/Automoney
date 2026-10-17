import numpy as np
import pandas as pd
from .costs import buy_position, target_price


def make_labels(df, settings, market='KR'):
    rows = []
    for i, date in enumerate(df.index):
        row = {'y':np.nan, 'label_end':pd.NaT, 'entry':np.nan, 'target':np.nan}
        if i+settings.horizon < len(df):
            try:
                position = buy_position(settings.capital,df.Open.iloc[i+1],settings,market)
                target = target_price(position)
                high = df.High.iloc[i+1:i+settings.horizon+1].max()
                row = {'y':int(high >= target), 'label_end':df.index[i+settings.horizon],
                       'entry':position['entry_price'], 'target':target}
            except ValueError:
                pass
        rows.append(row)
    return pd.DataFrame(rows,index=df.index)
