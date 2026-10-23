import unittest
from datetime import datetime
from decimal import Decimal as D

import holdings_report as hr


def item(symbol, name, country, qty, last, avg, value, cost, pl, pl_rate, day, day_rate):
    return {
        "symbol": symbol, "name": name, "marketCountry": country,
        "currency": "KRW" if country == "KR" else "USD",
        "quantity": qty, "lastPrice": last, "averagePurchasePrice": avg,
        "marketValue": {"amount": value, "purchaseAmount": cost},
        "profitLoss": {"amount": pl, "rate": pl_rate},
        "dailyProfitLoss": {"amount": day, "rate": day_rate},
    }


RAW = {"result": {"items": [
    item("005930", "삼성전자", "KR", "10", "200000", "250000", "2000000", "2500000", "-500000", "-0.2", "20000", "0.01"),
    item("SOXL", "Direxion <SOXL>", "US", "100", "80", "100", "8000", "10000", "-2000", "-0.2", "-80", "-0.01"),
    item("RXRX", "R", "US", "0.5", "3.5", "3.6", "1.75", "1.8", "-0.05", "-0.0278", "0", "0"),
    item("GONE", "청산됨", "US", "0", "1", "1", "0", "0", "0", "0", "0", "0"),
]}}
NOW = datetime(2026, 10, 23, 16, 0, tzinfo=hr.KST)


class BuildMessagesTests(unittest.TestCase):
    def test_overview_keeps_each_currency_separate(self):
        first = hr.build_messages(RAW, now=NOW)[0]

        self.assertIn("📒 <b>보유 종목 현황</b>  ·  10/23(금) 16:00", first)
        self.assertIn("🇰🇷 국내  <b>₩2,000,000</b>  (▼20.0%)", first)
        self.assertIn("🇺🇸 미국  <b>$8,001.75</b>  (▼20.0%)", first)
        # 환율 환산 합계는 만들지 않는다.
        self.assertNotIn("≈", first)
        self.assertNotIn("환율", first)
        self.assertNotIn("총 평가", first)

    def test_kr_section_in_first_message_and_us_section_second(self):
        messages = hr.build_messages(RAW, now=NOW)

        self.assertEqual(len(messages), 2)
        self.assertIn("<b>삼성전자</b>  10주 · ₩2,000,000", messages[0])
        self.assertIn("평단 ₩250,000 → 현재 ₩200,000  ▼20.0%  ·  오늘 ▲1.0%", messages[0])
        self.assertIn("🇺🇸 <b>미국 주식</b>  ·  2종목  ·  평가 $8,001.75", messages[1])
        self.assertNotIn("삼성전자", messages[1])

    def test_section_totals_use_their_own_currency(self):
        kr, us = hr.build_messages(RAW, now=NOW)

        self.assertIn("손익 -₩500,000 (▼20.0%)  ·  오늘 +₩20,000 (▲1.0%)", kr)
        self.assertIn("손익 -$2,000.05 (▼20.0%)  ·  오늘 -$80.00 (▼1.0%)", us)

    def test_us_items_use_ticker_fractional_quantity_and_sort_by_value(self):
        us = hr.build_messages(RAW, now=NOW)[1]

        self.assertLess(us.index("<b>SOXL</b>"), us.index("<b>RXRX</b>"))
        self.assertIn("0.5주", us)
        self.assertIn("평단 $100.00 → 현재 $80.00", us)
        self.assertIn("오늘 0.0%", us)  # no dash for a flat day
        self.assertNotIn("GONE", us)  # zero-quantity rows are not holdings

    def test_cycle_label_marks_infinite_buy_symbols(self):
        us = hr.build_messages(RAW, now=NOW, cycles={"SOXL": "T 5.5/40"})[1]

        self.assertIn("<b>SOXL</b>  100주 · $8,000.00  ♾️ T 5.5/40", us)

    def test_names_are_html_escaped(self):
        raw = {"result": {"items": [item("X", "A&B<C>", "KR", "1", "1", "1", "1", "1", "0", "0", "0", "0")]}}

        self.assertIn("<b>A&amp;B&lt;C&gt;</b>", hr.build_messages(raw, now=NOW)[0])

    def test_only_one_market_held_gives_a_single_message(self):
        raw = {"result": {"items": [RAW["result"]["items"][0]]}}

        messages = hr.build_messages(raw, now=NOW)
        self.assertEqual(len(messages), 1)
        self.assertIn("🇺🇸 미국  <b>$0.00</b>", messages[0])

    def test_no_holdings_message(self):
        message = hr.build_messages({"result": {"items": []}}, now=NOW)

        self.assertEqual(len(message), 1)
        self.assertIn("보유 중인 종목이 없습니다", message[0])


class MainTests(unittest.TestCase):
    def test_weekend_runs_are_skipped_unless_forced(self):
        class Saturday(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 10, 24, 16, 0, tzinfo=tz)

        original = hr.datetime
        hr.datetime = Saturday
        try:
            self.assertEqual(hr.main(["--dry-run"]), 0)
        finally:
            hr.datetime = original


if __name__ == "__main__":
    unittest.main()
