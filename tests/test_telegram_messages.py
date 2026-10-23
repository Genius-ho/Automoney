import unittest

from decimal import Decimal as D

from telegram_messages import (
    OrderLine,
    Standing,
    auto_failure_message,
    auto_result_message,
    retry_failure_message,
    retry_success_message,
)


def line(status="PENDING", confirmed=True, order_id="soxl-b-1", side="buy", kind="CLOSE_AUCTION"):
    return OrderLine(order_id, side, 12, "45.20", kind, status, confirmed)


class AutoResultMessageTests(unittest.TestCase):
    def test_success_block_has_side_size_price_kind_status_and_id(self):
        text = auto_result_message("SOXL", [line()], [], [])

        self.assertIn("🤖 <b>SOXL</b> 자동주문", text)
        self.assertIn("🔴 <b>매수</b>  12주 × $45.20", text)
        self.assertIn("✅ 종가(LOC) · 접수 완료", text)
        self.assertIn("<code>soxl-b-1</code>", text)
        self.assertIn("접수 성공 1건", text)
        self.assertNotIn("실패", text)

    def test_rejected_order_explains_missing_reason_and_offers_retry(self):
        text = auto_result_message(
            "SOXL", [line("REJECTED", False, side="sell")], [], ["soxl-b-1"], rejected_seen=True,
        )

        self.assertIn("🔵 <b>매도</b>", text)
        self.assertIn("❌ 종가(LOC) · 거절됨", text)
        self.assertIn("실패 1건", text)
        self.assertIn("상세 거절 사유", text)
        self.assertIn("토스 앱", text)
        self.assertIn("↻ /retry soxl-b-1", text)

    def test_unconfirmed_order_is_waiting_not_failed_icon(self):
        text = auto_result_message("SOXL", [line("UNCONFIRMED", False)], [], [])

        self.assertIn("⏳ 종가(LOC) · 접수 확인 대기", text)
        self.assertIn("⏳ 확인 대기 1건", text)
        self.assertNotIn("실패", text)

    def test_errors_and_user_text_are_escaped(self):
        text = auto_result_message("A<B>", [], ["bad <order> & more"], ["id<1>"])

        self.assertIn("<b>A&lt;B&gt;</b>", text)
        self.assertIn("⚠️ bad &lt;order&gt; &amp; more", text)
        self.assertIn("/retry id&lt;1&gt;", text)
        self.assertIn("실패 1건", text)

    def test_unknown_side_and_status_fall_back_to_raw_text(self):
        text = auto_result_message("SOXL", [OrderLine("x", "", 1, "1", "", "WEIRD", False)], [], [])

        self.assertIn("▫️", text)
        self.assertIn("WEIRD", text)


class OtherMessageTests(unittest.TestCase):
    def test_failure_message_quotes_the_error_and_lists_retries(self):
        text = auto_failure_message("SOXL", "연결 <실패>", ["a", "b"])

        self.assertIn("🚨 <b>SOXL</b> 자동주문 실패", text)
        self.assertIn("<blockquote>연결 &lt;실패&gt;</blockquote>", text)
        self.assertIn("↻ /retry a", text)
        self.assertIn("↻ /retry b", text)

    def test_retry_success_variants(self):
        self.assertIn("재시도 접수 성공", retry_success_message("id"))
        self.assertIn("가격 수정 후 재시도 접수 성공", retry_success_message("id", price="44.10"))
        self.assertIn("새 지정가  <b>$44.10</b>", retry_success_message("id", price="44.10"))
        self.assertIn("새 수량  <b>5주</b>", retry_success_message("id", quantity="5"))

    def test_retry_failure_message(self):
        text = retry_failure_message("id", "거부 & 사유")

        self.assertIn("재시도 실패", text)
        self.assertIn("<blockquote>거부 &amp; 사유</blockquote>", text)


def standing(**overrides):
    base = dict(
        current_price=D("112.40"), previous_close=D("111.05"), avg_cost=D("105.178958"),
        position_qty=144, t_value=D("5.5"), split_count=40, mode="GENERAL", cash_usd=D("31.76"),
        star_price=D("108.52"), take_profit_price=D("120.95"), take_profit_pct=D("15"),
    )
    base.update(overrides)
    return Standing(**base)


class StandingTests(unittest.TestCase):
    def test_header_shows_price_and_daily_change(self):
        text = auto_result_message("SOXL", [line()], [], [], standing=standing())

        self.assertIn("💵 현재가 <b>$112.40</b>  (전일 대비 ▲1.2%)", text)

    def test_status_block_has_average_pnl_progress_and_targets(self):
        text = auto_result_message("SOXL", [line()], [], [], standing=standing())

        self.assertIn("평단가 <b>$105.18</b>  ·  평단 대비 ▲6.9%", text)
        self.assertIn("보유 144주  ·  평가손익 +$1,039.83", text)
        self.assertIn("진행 T <b>5.5</b> / 40회  ▰▱▱▱▱▱▱▱▱▱ 13.8%  ·  일반 모드", text)
        self.assertIn("별가격 $108.52  ·  익절 목표 $120.95 (+15%)", text)
        self.assertIn("잔여 현금 $31.76", text)

    def test_loss_and_reverse_mode_render_with_down_arrow(self):
        text = auto_result_message(
            "SOXL", [line()], [], [],
            standing=standing(current_price=D("94.66"), mode="REVERSE", t_value=D("40")),
        )

        self.assertIn("평단 대비 ▼10.0%", text)
        self.assertIn("평가손익 -$1,514.73", text.replace("\u2212", "-"))
        self.assertIn("리버스 모드", text)
        self.assertIn("▰▰▰▰▰▰▰▰▰▰ 100.0%", text)

    def test_empty_position_says_waiting_and_hides_average(self):
        text = auto_result_message(
            "TQQQ", [line()], [], [],
            standing=standing(position_qty=0, avg_cost=D("0"), t_value=D("0"), star_price=None, take_profit_price=None),
        )

        self.assertIn("보유 없음 · 첫 매수 대기", text)
        self.assertNotIn("평단가", text)
        self.assertNotIn("익절 목표", text)

    def test_missing_quote_omits_price_but_keeps_status(self):
        text = auto_result_message(
            "SOXL", [line()], [], [], standing=standing(current_price=None, previous_close=None),
        )

        self.assertNotIn("현재가", text)
        self.assertNotIn("평단 대비", text)
        self.assertIn("평단가 <b>$105.18</b>", text)

    def test_no_standing_matches_the_plain_layout(self):
        text = auto_result_message("SOXL", [line()], [], [])

        self.assertNotIn("현재 상태", text)
        self.assertNotIn("현재가", text)

    def test_failure_message_also_carries_status(self):
        text = auto_failure_message("SOXL", "timeout", ["a"], standing=standing())

        self.assertIn("💵 현재가 <b>$112.40</b>", text)
        self.assertIn("📊 <b>현재 상태</b>", text)


if __name__ == "__main__":
    unittest.main()
