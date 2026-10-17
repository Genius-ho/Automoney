from stock_ai import service
from stock_ai.config import Settings


def lightweight_analysis(prices, settings, market=None, progress=None, compare=True, symbol=None):
    # The expensive model is exercised by test_analysis and the real CSV API test.
    # This complete boundary response lets the batch test exercise alignment,
    # simulations, reports, and partial failures without five duplicate fits.
    return {
        'symbol': symbol, 'settings': settings.model_dump(),
        'as_of': str(prices.index[-1].date()), 'close': float(prices.Close.iloc[-1]),
        'latest_probability': .7, 'selected': True,
        'feature_count': 50 if market is not None else 47,
        'sample_count': len(prices), 'data_hash': 'batch-test-data',
        'holdout': {'brier': .2, 'selected_n': 100},
        'predictions': [], 'variants': [], 'folds': [], 'warnings': [],
    }


def test_batch_fallback_aligns_available_dates_without_market_input(tmp_path, prices, monkeypatch):
    class Provider:
        def prices(self, code, years, market, **kw):
            frame = prices.iloc[20:] if code == '207940' else prices.iloc[:-10]
            return frame.copy(), {'source': 'synthetic test fixture', 'last_date': str(frame.index[-1].date()), 'warning': None}
    monkeypatch.setattr(service, 'analyze', lightweight_analysis)
    settings = Settings(target_pct=3, buy_fee_pct=.03)
    result = service.batch_job(settings, Provider(), tmp_path, 'a'*32, lambda p, m: None)
    assert len(result['ranking']) == 5
    assert result['errors'] == []
    assert result['comparison_complete'] is True
    assert result['comparable_as_of'] is True
    assert result['comparison_window'] == {
        'start': str(prices.index[20].date()),
        'end': str(prices.index[-11].date()), 'rows': 1770,
    }
    for item in result['ranking']:
        assert item['settings']['target_pct'] == 3
        assert item['settings']['buy_fee_pct'] == .03
        assert item['sample_count'] == 1770
        assert item['feature_count'] == 47
        assert item['simulations']['buffer']['trade_count'] == 0
        assert (tmp_path/item['report_id']/'result.json').is_file()


def test_partial_batch_identifies_missing_stock_and_is_not_complete(tmp_path, prices, monkeypatch):
    class Provider:
        def prices(self, code, years, market, **kw):
            if code == '207940':
                raise ValueError('source unavailable')
            return prices, {'source': 'synthetic test fixture', 'last_date': str(prices.index[-1].date()), 'warning': None}
    monkeypatch.setattr(service, 'analyze', lightweight_analysis)
    result = service.batch_job(Settings(), Provider(), tmp_path, 'b'*32, lambda p, m: None)
    assert len(result['ranking']) == 4
    assert result['comparison_complete'] is False
    assert result['errors'][0]['symbol']['code'] == '207940'
    assert 'source unavailable' in result['errors'][0]['error']


def test_failed_batch_does_not_claim_a_comparable_ranking(tmp_path):
    class Provider:
        def prices(self, *args, **kw):
            raise ValueError('source unavailable')
    result = service.batch_job(Settings(), Provider(), tmp_path, 'c'*32, lambda p, m: None)
    assert result['ranking'] == []
    assert len(result['errors']) == 5
    assert result['comparable_as_of'] is False
    assert result['comparison_complete'] is False
    assert result['comparison_window'] is None
