import unittest
from datetime import date
from decimal import Decimal

from corporate_actions import ShareSplit, split_is_reflected


class ShareSplitTests(unittest.TestCase):
    def test_detects_koru_twenty_for_one_split(self):
        split = ShareSplit("KORU", date(2026, 7, 15), Decimal("20"))

        self.assertTrue(
            split_is_reflected(
                split,
                old_quantity=Decimal("7"),
                old_average=Decimal("400"),
                new_quantity=Decimal("140"),
                new_average=Decimal("20"),
            )
        )

    def test_rejects_an_unadjusted_holding(self):
        split = ShareSplit("KORU", date(2026, 7, 15), Decimal("20"))

        self.assertFalse(
            split_is_reflected(
                split,
                old_quantity=Decimal("7"),
                old_average=Decimal("400"),
                new_quantity=Decimal("7"),
                new_average=Decimal("400"),
            )
        )


if __name__ == "__main__":
    unittest.main()
