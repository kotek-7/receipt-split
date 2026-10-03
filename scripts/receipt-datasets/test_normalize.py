import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("receipt_datasets", Path(__file__).with_name("download.py"))
datasets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(datasets)


class GroundTruthNormalizationTests(unittest.TestCase):
    def test_yen_accepts_only_integer_or_three_digit_grouping(self):
        for printed, expected in [("¥3.890", 3890), ("￥１２，３４５", 12345), ("2,000円", 2000), ("-1,200", -1200), ("▲200", -200), ("0", 0)]:
            with self.subTest(printed=printed):
                self.assertEqual(datasets.normalize_yen(printed), expected)
        for invalid in [None, "", "¥3.89", "1.234.56", "1,23", "合計1200", 1.5, True]:
            with self.subTest(invalid=invalid):
                self.assertIsNone(datasets.normalize_yen(invalid))

    def test_quantities_distinguish_absent_and_unreadable(self):
        for printed, expected in [(None, 1), ("", 1), ("２ｺ", 2), ("3杯", 3), ("1点", 1), ("2 x", 2)]:
            self.assertEqual(datasets.normalize_quantity(printed), expected)
        for invalid in ["不明", "2.5", "0", -2, True]:
            self.assertIsNone(datasets.normalize_quantity(invalid))

    def test_row_totals_are_not_multiplied_or_inferred_from_tax(self):
        source = {"totals": {"total_yen": 1320}, "items": [{"name": "ビール", "quantity": 2, "amount_yen": 1200}, {"name": "氷なし", "quantity": 1, "amount_yen": 0}, {"name": "値引き", "quantity": 1, "amount_yen": -100}]}
        expected, excluded, skipped = datasets.normalize_ground_truth("jomb-alpha10", source, "fixture")
        self.assertEqual(expected, {"total": 1320, "items": [{"name": "ビール", "quantity": 2, "amount": 1200}]})
        self.assertEqual(excluded["zeroAmountItems"], 1)
        self.assertEqual(excluded["negativeAmountItems"], 1)
        self.assertEqual(skipped, [])

    def test_incomplete_item_ground_truth_excludes_receipt(self):
        source = {"totals": {"total_yen": 1200}, "items": [{"name": "読める商品", "quantity": 1, "amount_yen": 600}, {"name": "金額不明", "quantity": 1, "amount_yen": None}]}
        expected, excluded, skipped = datasets.normalize_ground_truth("jomb-alpha10", source, "fixture")
        self.assertIsNone(expected)
        self.assertEqual(excluded["unreadableItems"], 1)
        self.assertEqual(skipped[-1]["reason"], "incomplete_line_item_ground_truth")

    def test_bad_cache_checksum_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.txt"
            path.write_text("modified")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                datasets.verify(path, "0" * 64)


if __name__ == "__main__":
    unittest.main()
