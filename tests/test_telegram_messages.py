import unittest

from telegram_messages import (
    OrderLine,
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


if __name__ == "__main__":
    unittest.main()
