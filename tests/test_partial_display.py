import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import storage

ROOT = Path(__file__).resolve().parents[1]


class PartialShareDisplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "partial.sqlite3"
        conn = sqlite3.connect(self.db)
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        conn.executescript("""
            INSERT INTO etfs VALUES('510300','sh510300','沪深300ETF','沪深300','core',NULL);
            INSERT INTO etfs VALUES('159919','sz159919','沪深300ETF嘉实','沪深300','core',NULL);
            INSERT INTO share_history VALUES('20261116','510300',1000,'x','上交所 ETF 规模披露');
            INSERT INTO share_history VALUES('20261116','159919',2000,'x','深交所 ETF 规模披露');
            INSERT INTO share_history VALUES('20261117','510300',1010,'y','上交所 ETF 规模披露');
            INSERT INTO daily_activity VALUES('20261116','510300',10,10,NULL,NULL,1);
            INSERT INTO daily_activity VALUES('20261116','159919',20,20,NULL,NULL,1);
            INSERT INTO daily_activity VALUES('20261117','510300',11,11,NULL,NULL,1);
            INSERT INTO daily_activity VALUES('20261117','159919',21,21,NULL,NULL,1);
            INSERT INTO daily_closes VALUES('20261116','510300',4.0,10,10,'新浪 ETF 日 K 线估算');
            INSERT INTO daily_closes VALUES('20261116','159919',4.0,20,20,'新浪 ETF 日 K 线估算');
            INSERT INTO daily_closes VALUES('20261117','510300',4.1,11,11,'新浪 ETF 日 K 线估算');
            INSERT INTO daily_closes VALUES('20261117','159919',4.1,21,21,'新浪 ETF 日 K 线估算');
        """)
        for code, name in (("510300", "沪深300ETF"), ("159919", "沪深300ETF嘉实")):
            payload = json.dumps({"code": code, "name": name, "price": 4.1, "shares": 1010,
                                  "amount_yi": 11, "avg20_yi": 10, "mktcap_yi": 1000,
                                  "pct": 1, "day_progress": 1})
            conn.execute("INSERT INTO daily_snapshots VALUES('20261117',?,?, 'x','测试')",
                         (code, payload))
        conn.commit()
        conn.close()
        self.original_connect = storage.connect

        def connect(path=None):
            value = sqlite3.connect(self.db, timeout=10, isolation_level=None)
            value.row_factory = sqlite3.Row
            value.execute("PRAGMA foreign_keys = ON")
            return value

        storage.connect = connect

    def tearDown(self):
        storage.connect = self.original_connect
        self.temp.cleanup()

    def test_one_disclosed_fund_still_renders_every_view(self):
        dashboard = storage.load_dashboard()
        self.assertEqual(dashboard["latest_share_coverage"]["covered"], 1)
        self.assertEqual(dashboard["latest_share_coverage"]["basket"], 2)
        latest = [row for row in dashboard["history"]["pool"] if row["date"] == "20261117"]
        self.assertEqual(latest[0]["core_count"], 1)
        self.assertEqual(latest[0]["basket_count"], 2)

        stats = storage.load_pool_statistics(5)
        latest_stat = [row for row in stats if row["date"] == "20261117"][0]
        self.assertEqual(latest_stat["coverage_count"], 1)
        self.assertEqual(latest_stat["basket_count"], 2)

        overview = storage.load_flow_overview()
        self.assertEqual(overview["as_of_date"], "20261117")
        self.assertEqual(overview["coverage_count"], 1)
        self.assertEqual(overview["basket_count"], 2)
        self.assertEqual(len(overview["daily_matrix"]), 2)

        detail = storage.load_flow_detail("20261117")
        self.assertEqual(detail["core_count"], 1)
        self.assertEqual(detail["basket_count"], 2)
        self.assertEqual(len(detail["items"]), 1)


if __name__ == "__main__":
    unittest.main()
