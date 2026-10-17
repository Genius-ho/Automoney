from datetime import date
import numpy as np
import pandas as pd
import pytest
from stock_ai.data import DataProvider
from stock_ai import portfolio


def test_historical_fx_is_applied_before_returns_and_never_uses_future_rates():
    dates=pd.to_datetime(['2026-10-05','2026-10-06','2026-10-07'])
    closes=pd.DataFrame({'K (005930)':[100,101,102],'U (GLD)':[10,10,11]},index=dates)
    symbols=[{'code':'005930','name':'K','market':'KR'},{'code':'GLD','name':'U','market':'US'}]
    fx=pd.DataFrame({'Close':[1200,1300,9999]},index=pd.to_datetime(['2026-10-05','2026-10-07','2026-10-08']))
    converted,meta=portfolio.convert_currency_prices(closes,symbols,'KRW',fx)
    assert converted['K (005930)'].tolist()==[100,101,102]
    assert converted['U (GLD)'].tolist()==[12000,12000,14300]
    assert meta['rate']==1300 and meta['date']=='2026-10-07'
    dollar,_=portfolio.convert_currency_prices(closes,symbols,'USD',fx)
    assert dollar['K (005930)'].tolist()==pytest.approx([100/1200,101/1200,102/1300])
    assert dollar['U (GLD)'].tolist()==[10,10,11]


@pytest.mark.parametrize('dates,values', [(['2026-10-08'],[1300]),
                                         (['2026-09-01'],[1300]),
                                         (['2026-10-05'],[0]),
                                         (['2026-10-05'],[np.inf])])
def test_missing_future_stale_or_invalid_fx_cannot_produce_an_allocation(dates,values):
    closes=pd.DataFrame({'U (GLD)':[10]},index=pd.to_datetime(['2026-10-07']))
    symbols=[{'code':'GLD','name':'U','market':'US'}]
    fx=pd.DataFrame({'Close':values},index=pd.to_datetime(dates))
    with pytest.raises(ValueError,match='환율'):
        portfolio.convert_currency_prices(closes,symbols,'KRW',fx)


def test_fx_cleaner_excludes_unfinished_days_and_reports_missing_quotes():
    from stock_ai.data import clean_exchange_rates
    raw=pd.DataFrame({'Close':[1200,np.nan,1300]},index=pd.to_datetime(['2026-10-07','2026-10-08','2026-10-09']))
    frame=clean_exchange_rates(raw,today=date(2026,10,9))
    assert frame.Close.tolist()==[1200]
    assert '1' in frame.attrs['rate_warning']
    with pytest.raises(ValueError,match='환율'):
        clean_exchange_rates(pd.DataFrame({'Close':[-1]},index=pd.to_datetime(['2026-10-07'])),today=date(2026,10,9))


def test_provider_saves_fx_cache_and_discloses_network_fallback(tmp_path,monkeypatch):
    import FinanceDataReader as fdr
    calls=[]
    def fetch(code,start):
        calls.append(code)
        return pd.DataFrame({'Close':[1300,1310]},index=pd.to_datetime(['2026-10-06','2026-10-07']))
    monkeypatch.setattr(fdr,'DataReader',fetch)
    provider=DataProvider(tmp_path)
    frame,meta=provider.exchange_rates(5)
    assert calls==['USD/KRW'] and frame.Close.tolist()==[1300,1310]
    assert meta['source']=='FinanceDataReader'
    def offline(*args):raise RuntimeError('offline')
    monkeypatch.setattr(fdr,'DataReader',offline)
    cached,meta=provider.exchange_rates(5)
    assert cached.Close.tolist()==[1300,1310] and 'offline' in meta['warning']
    assert meta['source']=='환율 캐시'
