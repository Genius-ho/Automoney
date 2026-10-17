from decimal import Decimal
import pandas as pd
import pytest
from stock_ai.config import Settings
from stock_ai.costs import buy_position, target_price, settle
from stock_ai.data import clean_prices
from stock_ai.symbols import SymbolResolver


def test_expensive_shares_preserve_cash_and_net_target():
    settings = Settings(buy_fee_pct=0, sell_fee_pct=0, sell_tax_pct=0,
                        slippage_pct=0, target_pct=2)
    p = buy_position(10000000, 2100000, settings)
    assert p['quantity'] == 4
    assert p['cash_left'] == 1600000
    assert target_price(p) == 2150000  # 2% of whole capital, tick rounded up
    assert settle(p, 2150000)['cash'] == 10200000


def test_costs_require_higher_sell_price_and_unaffordable_rejected():
    p = buy_position(10000000, 2000000, Settings(slippage_pct=0))
    assert p['quantity'] == 4
    assert settle(p, target_price(p))['cash'] >= 10200000
    with pytest.raises(ValueError):
        buy_position(1000000, 2000000, Settings())


@pytest.mark.parametrize('kw', [{'horizon':0}, {'horizon':1.5}, {'target_pct':float('nan')},
                               {'sell_tax_pct':100}, {'buy_fee_pct':-1}, {'capital':0}])
def test_invalid_settings_rejected(kw):
    with pytest.raises(ValueError):
        Settings(**kw)


def test_ohlcv_validation_and_today_excluded(prices):
    cut = prices.iloc[:100].copy()
    result = clean_prices(cut, 'KR', today=cut.index[-1].date())
    assert len(result) == 99
    cut.iloc[0, cut.columns.get_loc('Low')] = -1
    with pytest.raises(ValueError):
        clean_prices(cut, 'KR')


def test_mapping_preserves_leading_zero_and_alias_and_ambiguity(tmp_path):
    resolver = SymbolResolver(tmp_path)
    assert resolver.search('Samsung')[0]['code'] == '005930'
    assert resolver.search('삼성전자')[0]['code'] == '005930'
    assert resolver.search('005930')[0]['code'] == '005930'
    assert len(resolver.search('삼성')) >= 2
    assert resolver.search('애플')[0]['code'] == 'AAPL'
