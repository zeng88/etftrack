import json
import unittest
from unittest.mock import patch
import collector


class ShanghaiIndexTests(unittest.TestCase):
    def setUp(self):
        self.old_cache = collector._INDEX_CACHE
        collector._INDEX_CACHE = None

    def tearDown(self):
        collector._INDEX_CACHE = self.old_cache

    def test_uses_fallback_and_caches_valid_daily_rows(self):
        bad = json.dumps({"data": {}}).encode()
        good = json.dumps([{"day": "2026-11-18", "open": "3500", "close": "3500", "high": "3520", "low": "3480"}, {"day": "2026-11-19", "open": "3527.30", "close": "3533.79", "high": "3540", "low": "3500"}]).encode()
        with patch.object(collector, "_https_get", side_effect=[bad, good]) as fetch:
            first = collector.fetch_shanghai_index()
            self.assertEqual(first, {"source": "新浪财经", "rows": [{"date": "20261118", "open": 3500, "close": 3500, "high": 3520, "low": 3480, "prev_close": None}, {"date": "20261119", "open": 3527.3, "close": 3533.79, "high": 3540, "low": 3500, "prev_close": 3500}]})
            self.assertEqual(collector.fetch_shanghai_index(), first)
            self.assertEqual(fetch.call_count, 2)

    def test_all_sources_failing_is_reported(self):
        with patch.object(collector, "_https_get", return_value=b"[]"):
            with self.assertRaises(RuntimeError):
                collector.fetch_shanghai_index()


if __name__ == "__main__":
    unittest.main()
