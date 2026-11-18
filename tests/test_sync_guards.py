import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from sqlite_to_d1 import TABLES, conflict_clause


class SyncGuardTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.executescript("""
            CREATE TABLE share_history(trade_date TEXT, code TEXT, shares REAL,
              observed_at TEXT, source TEXT, PRIMARY KEY(trade_date,code));
            CREATE TABLE daily_activity(trade_date TEXT, code TEXT, amount_yi REAL,
              volume_lots REAL, shape_json TEXT, tail_ratio REAL, complete INTEGER,
              PRIMARY KEY(trade_date,code));
            CREATE TABLE daily_snapshots(trade_date TEXT, code TEXT, payload_json TEXT,
              source_ts TEXT, source TEXT, PRIMARY KEY(trade_date,code));
            CREATE TABLE daily_closes(trade_date TEXT, code TEXT, close_price REAL,
              volume_lots REAL, turnover_yi REAL, source TEXT,
              PRIMARY KEY(trade_date,code));
            CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT);
        """)

    def tearDown(self):
        self.conn.close()

    def _insert(self, table, values):
        columns, keys = TABLES[table]
        marks = ",".join("?" for _ in values)
        self.conn.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({marks}){conflict_clause(table, columns, keys)}",
            values,
        )

    def test_quote_share_cannot_replace_exchange_share(self):
        self.conn.execute(
            "INSERT INTO share_history VALUES('20261117','159338',1000,'x','上交所 ETF 规模披露')")
        self._insert("share_history", ("20261117", "159338", 999, "y", "腾讯行情份额字段"))
        self.assertEqual(
            self.conn.execute("SELECT shares,source FROM share_history").fetchone(),
            (1000, "上交所 ETF 规模披露"),
        )
        self._insert("share_history", ("20261117", "159338", 2000, "z", "上交所 ETF 规模披露"))
        self.assertEqual(self.conn.execute("SELECT shares FROM share_history").fetchone()[0], 2000)

    def test_fallback_share_ranks_between_exchange_and_quote(self):
        self.conn.execute(
            "INSERT INTO share_history VALUES('20261117','159338',999,'x','腾讯行情份额字段')")
        self._insert("share_history", ("20261117", "159338", 1000, "y", "东方财富份额兜底"))
        self.assertEqual(
            self.conn.execute("SELECT source FROM share_history").fetchone()[0],
            "东方财富份额兜底",
        )
        self._insert("share_history", ("20261117", "159338", 2000, "z", "上交所 ETF 规模披露"))
        self._insert("share_history", ("20261117", "159338", 3000, "w", "东方财富份额兜底"))
        self.assertEqual(
            self.conn.execute("SELECT shares,source FROM share_history").fetchone(),
            (2000, "上交所 ETF 规模披露"),
        )

    def test_intraday_snapshot_cannot_replace_close_snapshot(self):
        self.conn.execute(
            "INSERT INTO daily_snapshots VALUES('20261117','159338','{\"a\":1}','x',"
            "'腾讯公开行情 + 新浪 5 分钟 K 线（收盘后）')")
        self._insert("daily_snapshots", (
            "20261117", "159338", '{"a":1}', "y", "腾讯公开行情 + 新浪 5 分钟 K 线（盘中）"))
        self.assertEqual(
            self.conn.execute("SELECT source FROM daily_snapshots").fetchone()[0],
            "腾讯公开行情 + 新浪 5 分钟 K 线（收盘后）",
        )
        self._insert("daily_snapshots", (
            "20261117", "159338", '{"larger":true}', "z", "腾讯公开行情"))
        self.assertEqual(
            self.conn.execute("SELECT payload_json FROM daily_snapshots").fetchone()[0],
            '{"larger":true}',
        )

    def test_incomplete_activity_cannot_replace_complete_activity(self):
        self.conn.execute(
            "INSERT INTO daily_activity VALUES('20261117','159338',1,1,'[]',NULL,1)")
        self._insert("daily_activity", ("20261117", "159338", 2, 2, None, None, 0))
        self.assertEqual(
            self.conn.execute("SELECT amount_yi,complete,shape_json FROM daily_activity").fetchone(),
            (1, 1, "[]"),
        )
        self._insert("daily_activity", ("20261117", "159338", 2, 2, None, None, 1))
        self.assertEqual(
            self.conn.execute("SELECT amount_yi,shape_json FROM daily_activity").fetchone(),
            (1, "[]"),
        )

    def test_first_close_wins(self):
        self.conn.execute(
            "INSERT INTO daily_closes VALUES('20261117','159338',1.0,1,1,'腾讯收盘行情')")
        self._insert("daily_closes", ("20261117", "159338", 2.0, 2, 2, "新浪 ETF 日 K 线估算"))
        self.assertEqual(self.conn.execute("SELECT close_price FROM daily_closes").fetchone()[0], 1.0)

    def test_old_meta_cannot_regress_newer_date(self):
        self.conn.execute("INSERT INTO app_meta VALUES('trade_date','20261117')")
        self._insert("app_meta", ("trade_date", "20260101"))
        self.assertEqual(self.conn.execute("SELECT value FROM app_meta").fetchone()[0], "20261117")
        self._insert("app_meta", ("trade_date", "20261118"))
        self.assertEqual(self.conn.execute("SELECT value FROM app_meta").fetchone()[0], "20261118")


if __name__ == "__main__":
    unittest.main()
