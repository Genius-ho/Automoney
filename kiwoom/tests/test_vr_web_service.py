import tempfile
import unittest

from kiwoom.web.service import VrWebService


class VrWebServiceTests(unittest.TestCase):
    def test_list_profiles_is_empty_when_data_dir_is_missing(self):
        service = VrWebService(data_dir="/nonexistent/path/for/sure")
        self.assertEqual(service.list_profiles(), [])

    def test_create_and_list_two_independent_profiles(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            service.create_profile("child1", "TQQQ", price=65.0, cash=10_000.0)
            service.create_profile("child2", "SOXL", price=22.0, cash=10_000.0)

            self.assertEqual(service.list_profiles(), ["child1", "child2"])
            self.assertEqual(service.status("child1")["symbol"], "TQQQ")
            self.assertEqual(service.status("child2")["symbol"], "SOXL")

    def test_create_profile_rejects_a_duplicate_name(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            service.create_profile("child1", "TQQQ", price=65.0, cash=10_000.0)

            with self.assertRaises(ValueError):
                service.create_profile("child1", "TQQQ", price=65.0, cash=10_000.0)

    def test_create_profile_rejects_non_positive_price_or_cash(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            with self.assertRaises(ValueError):
                service.create_profile("child1", "TQQQ", price=0, cash=10_000.0)

    def test_status_of_unknown_profile_raises(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            with self.assertRaises(ValueError):
                service.status("nope")

    def test_plan_without_apply_does_not_persist_the_trade(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            service.create_profile("child1", "TQQQ", price=100.0, cash=10_000.0)

            result = service.plan("child1", price=200.0, apply=False)

            self.assertIsNotNone(result["plan"])
            self.assertEqual(result["plan"]["side"], "SELL")
            # Reload from disk: shares should be unchanged since apply=False.
            reloaded = service.status("child1")
            self.assertEqual(reloaded["shares"], result["status"]["shares"])
            self.assertEqual(result["status"]["shares"] - result["plan"]["shares"], result["plan"]["resulting_shares"])

    def test_plan_with_apply_persists_the_trade(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            service.create_profile("child1", "TQQQ", price=100.0, cash=10_000.0)
            before = service.status("child1")

            result = service.plan("child1", price=200.0, apply=True)

            after = service.status("child1")
            self.assertLess(after["shares"], before["shares"])
            self.assertEqual(after["shares"], result["status"]["shares"])

    def test_plan_rejects_non_positive_price(self):
        with tempfile.TemporaryDirectory() as temp:
            service = VrWebService(data_dir=temp)
            service.create_profile("child1", "TQQQ", price=100.0, cash=10_000.0)
            with self.assertRaises(ValueError):
                service.plan("child1", price=0, apply=False)


if __name__ == "__main__":
    unittest.main()
