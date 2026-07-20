import unittest

from etf_info import ETF_INFO
from volatility import ETF_UNIVERSE


class EtfInfoTests(unittest.TestCase):
    def test_every_supported_product_has_offline_reference_data(self):
        self.assertEqual(set(ETF_INFO), set(ETF_UNIVERSE))
        for symbol, (name, product_type, description, holdings) in ETF_INFO.items():
            self.assertTrue(name, symbol)
            self.assertIn("3배", product_type)
            self.assertTrue(description)
            self.assertGreaterEqual(len(holdings), 5)


if __name__ == "__main__":
    unittest.main()