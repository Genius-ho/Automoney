from datetime import date

import numpy as np
import pandas as pd
import pytest

from stock_ai.data import DataProvider, clean_prices
from stock_ai.service import analysis_job


@pytest.fixture
def naver_nontrading_prices():
    # The three zero-OHL rows are copied from the user's FDR response.
    # Neighbouring valid rows are controlled test inputs, not market quotes.
    return pd.DataFrame(
        [[53000, 54000, 52000, 53000, 100],
         [0, 0, 0, 53000, 0],
         [0, 0, 0, 53000, 0],
         [0, 0, 0, 53000, 0],
         [53000, 54000, 52000, 53000, 100]],
        columns=['Open', 'High', 'Low', 'Close', 'Volume'],
        index=pd.to_datetime(['2018-04-27', '2018-04-30', '2018-05-02',
                              '2018-05-03', '2018-05-04']).rename('Date'),
    )


def test_kr_nontrading_rows_excluded_without_inventing_prices(naver_nontrading_prices):
    raw = naver_nontrading_prices
    result = clean_prices(raw, today=date(2018, 5, 5))
    assert result.index.strftime('%Y-%m-%d').tolist() == ['2018-04-27', '2018-05-04']
    assert result.Close.tolist() == [53000, 53000]
    assert raw.loc['2018-04-30', 'Open'] == 0
    for day in ['2018-04-30', '2018-05-02', '2018-05-03']:
        assert day in result.attrs['price_warning']


@pytest.mark.parametrize('column,value', [
    ('Open', 1), ('Volume', 1), ('Close', 0), ('Close', -1),
    ('Close', np.nan), ('Close', np.inf), ('Volume', -1),
])
def test_similar_but_invalid_rows_still_rejected(naver_nontrading_prices, column, value):
    raw = naver_nontrading_prices.astype(float)
    raw.loc['2018-04-30', column] = value
    with pytest.raises(ValueError):
        clean_prices(raw, today=date(2018, 5, 5))


def test_zero_volume_with_valid_ohlc_is_preserved(naver_nontrading_prices):
    raw = naver_nontrading_prices.iloc[[0, 4]].copy()
    raw['Volume'] = 0
    result = clean_prices(raw, today=date(2018, 5, 5))
    assert len(result) == 2


def test_us_zero_ohl_rows_are_not_silently_removed(naver_nontrading_prices):
    with pytest.raises(ValueError):
        clean_prices(naver_nontrading_prices, market='US', today=date(2018, 5, 5))


def test_only_nontrading_rows_cannot_be_analyzed(naver_nontrading_prices):
    with pytest.raises(ValueError):
        clean_prices(naver_nontrading_prices.iloc[1:4], today=date(2018, 5, 5))


def test_provider_saves_valid_cache_and_reports_exclusions(tmp_path, monkeypatch, naver_nontrading_prices):
    import FinanceDataReader as fdr
    monkeypatch.setattr(fdr, 'DataReader', lambda *args: naver_nontrading_prices.copy())
    result, meta = DataProvider(tmp_path).prices('005930', years=20)
    assert len(result) == 2
    assert meta['source'] == 'FinanceDataReader'
    assert '2018-04-30' in meta['warning']
    saved = pd.read_csv(tmp_path / 'KR_005930.csv')
    assert saved.Date.tolist() == ['2018-04-27', '2018-05-04']
    assert (saved[['Open', 'High', 'Low', 'Close']] > 0).all().all()


def test_original_csv_analysis_preserves_nontrading_rows(monkeypatch, naver_nontrading_prices):
    # Model training is irrelevant to the ingestion boundary under test.
    import stock_ai.service as service
    def capture(prices, settings, symbol, market, meta, *args):
        assert len(prices)==len(naver_nontrading_prices)
        assert prices.loc['2018-05-03','Open']==0
        return meta
    monkeypatch.setattr(service, 'analyze_prices',capture)
    result = analysis_job(
        {'symbol': {'code': '005930', 'market': 'KR'},
         'csv': naver_nontrading_prices.to_csv()},
        None, None, 'test', lambda *args: None,
    )
    assert result['source'] == '사용자 CSV'
    assert result['warning'] is None


@pytest.mark.parametrize('ohlc,expected', [
    ([31860, 32159, 31800, 32160], [31860, 32160, 31800, 32160]),
    ([31860, 32160, 31861, 32160], [31860, 32160, 31860, 32160]),
])
def test_kr_one_won_boundary_discrepancy_corrected_and_disclosed(ohlc, expected):
    # First case is the actual 2016-10-24 Samsung row from the saved FDR CSV.
    raw = pd.DataFrame([ohlc + [185799]],
                       columns=['Open', 'High', 'Low', 'Close', 'Volume'],
                       index=pd.to_datetime(['2016-10-24']).rename('Date'))
    result = clean_prices(raw, today=date(2016, 10, 25))
    assert result.iloc[0].tolist() == expected + [185799]
    assert raw.iloc[0].tolist() == ohlc + [185799]
    assert '2016-10-24' in result.attrs['price_warning']
    assert '1원' in result.attrs['price_warning']


@pytest.mark.parametrize('ohlc,market', [
    ([31860, 32158, 31800, 32160], 'KR'),
    ([31860, 32160, 31862, 32160], 'KR'),
    ([31860, 31859, 31860, 31860], 'KR'),
    ([31860.5, 32159.5, 31800, 32160], 'KR'),
    ([31860, 32159, 31800, 32160], 'US'),
])
def test_other_ohlc_discrepancies_still_rejected(ohlc, market):
    raw = pd.DataFrame([ohlc + [185799]],
                       columns=['Open', 'High', 'Low', 'Close', 'Volume'],
                       index=pd.to_datetime(['2016-10-24']).rename('Date'))
    with pytest.raises(ValueError):
        clean_prices(raw, market, today=date(2016, 10, 25))
