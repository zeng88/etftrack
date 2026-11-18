#!/usr/bin/env python3
"""Export the local SQLite database as D1-compatible, non-regressing SQL."""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "etf_tracker.sqlite3"
TIME_SERIES = {"share_history", "daily_activity", "daily_closes", "daily_snapshots"}
TABLES = {
    "etfs": ("code,tcode,name,index_name,group_name,huijin_yi", "code"),
    "share_history": ("trade_date,code,shares,observed_at,source", "trade_date,code"),
    "daily_activity": ("trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete", "trade_date,code"),
    "daily_closes": ("trade_date,code,close_price,volume_lots,turnover_yi,source", "trade_date,code"),
    "daily_snapshots": ("trade_date,code,payload_json,source_ts,source", "trade_date,code"),
    "app_meta": ("key,value", "key"),
}
# Local sync must never downgrade D1. The newest local export can be older
# than what the Worker has already collected, so writes are ranked by source.
SHARE_RANK = """CASE
  WHEN {col}.source IN ('上交所 ETF 规模披露','深交所 ETF 规模披露') THEN 2
  WHEN {col}.source LIKE '%参考%' OR {col}.source LIKE '%兜底%' THEN 1
  ELSE 0 END"""
SNAPSHOT_RANK = """CASE
  WHEN {col}.source LIKE '%盘中%' THEN 0
  WHEN {col}.source LIKE '%收盘后%' OR {col}.source='腾讯公开行情' OR {col}.source LIKE '参考网站%' THEN 2
  ELSE 1 END"""


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def conflict_clause(table: str, columns: str, key_columns: str) -> str:
    names = columns.split(",")
    keys = key_columns.split(",")
    updates = ", ".join(f"{name}=excluded.{name}" for name in names if name not in keys)
    if table == "share_history":
        return (f" ON CONFLICT(trade_date,code) DO UPDATE SET {updates}"
                f" WHERE ({SHARE_RANK.format(col='share_history')}) <= ({SHARE_RANK.format(col='excluded')})")
    if table == "daily_snapshots":
        return (f" ON CONFLICT(trade_date,code) DO UPDATE SET {updates}"
                f" WHERE ({SNAPSHOT_RANK.format(col='daily_snapshots')}) <= ({SNAPSHOT_RANK.format(col='excluded')})"
                " AND length(excluded.payload_json) >= length(daily_snapshots.payload_json)")
    if table == "daily_activity":
        return (f" ON CONFLICT(trade_date,code) DO UPDATE SET {updates}"
                " WHERE daily_activity.complete <= excluded.complete"
                " AND (daily_activity.shape_json IS NULL OR excluded.shape_json IS NOT NULL)")
    if table == "daily_closes":
        # First writer wins; a local Sina estimate should not replace a
        # Worker-collected post-close price (or vice versa).
        return " ON CONFLICT(trade_date,code) DO NOTHING"
    if table == "app_meta":
        # Never let a stale local date or a deleted bootstrap marker go back.
        return (" ON CONFLICT(key) DO UPDATE SET value=excluded.value"
                " WHERE app_meta.key IN ('source','huijin_basis','bootstrap_loaded')"
                " OR excluded.value >= app_meta.value")
    return f" ON CONFLICT({key_columns}) DO UPDATE SET {updates}"


def recent_trade_dates(conn: sqlite3.Connection, limit: int) -> list[str]:
    if limit <= 0:
        return []
    rows = conn.execute(
        """SELECT DISTINCT trade_date FROM (
             SELECT trade_date FROM share_history
             UNION SELECT trade_date FROM daily_activity
             UNION SELECT trade_date FROM daily_closes
             UNION SELECT trade_date FROM daily_snapshots
           ) ORDER BY trade_date DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [str(row[0]) for row in rows]


def export(database: Path, output: Path, recent_days: int = 0) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    counts: dict[str, int] = {}
    try:
        dates = recent_trade_dates(conn, recent_days)
        with output.open("w", encoding="utf-8") as stream:
            for table, (columns, key_columns) in TABLES.items():
                names = columns.split(",")
                conflict = conflict_clause(table, columns, key_columns)
                if table in TIME_SERIES and recent_days > 0:
                    if not dates:
                        rows = []
                    else:
                        marks = ",".join("?" for _ in dates)
                        rows = conn.execute(
                            f"SELECT {columns} FROM {table} WHERE trade_date IN ({marks}) ORDER BY trade_date,code",
                            dates,
                        )
                elif table == "app_meta":
                    rows = [
                        row for row in conn.execute(f"SELECT {columns} FROM {table} ORDER BY 1")
                        if row["key"] not in ("data_revision", "bootstrap_reference_date")
                    ]
                else:
                    rows = conn.execute(f"SELECT {columns} FROM {table} ORDER BY 1")
                count = 0
                for row in rows:
                    values = ",".join(quote(row[name]) for name in names)
                    stream.write(f"INSERT INTO {table} ({columns}) VALUES ({values}){conflict};\n")
                    count += 1
                counts[table] = count
    finally:
        conn.close()
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "d1-import.sql")
    parser.add_argument("--recent-days", type=int, default=0,
                        help="只导出最近 N 个交易日；0 表示导出全部历史")
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"SQLite 数据库不存在：{args.db}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    counts = export(args.db, args.output, args.recent_days)
    label = f"最近 {args.recent_days} 个交易日" if args.recent_days > 0 else "全部历史"
    print(f"已生成 {args.output}（{label}，{args.output.stat().st_size:,} bytes）")
    for table, count in counts.items():
        print(f"{table}: {count}")


if __name__ == "__main__":
    main()
