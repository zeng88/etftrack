#!/usr/bin/env python3
"""Export the local SQLite database as idempotent D1-compatible SQL."""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "etf_tracker.sqlite3"
TABLES = {
    "etfs": ("code,tcode,name,index_name,group_name,huijin_yi", "code"),
    "share_history": ("trade_date,code,shares,observed_at,source", "trade_date,code"),
    "daily_activity": ("trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete", "trade_date,code"),
    "daily_closes": ("trade_date,code,close_price,volume_lots,turnover_yi,source", "trade_date,code"),
    "daily_snapshots": ("trade_date,code,payload_json,source_ts,source", "trade_date,code"),
    "collection_runs": ("id,started_at,finished_at,status,trade_date,message,source", "id"),
    "app_meta": ("key,value", "key"),
}


def quote(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def export(database: Path, output: Path) -> dict[str, int]:
    conn = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    counts: dict[str, int] = {}
    try:
        with output.open("w", encoding="utf-8") as stream:
            for table, (columns, key_columns) in TABLES.items():
                names = columns.split(",")
                keys = key_columns.split(",")
                updates = ",".join(f"{name}=excluded.{name}" for name in names if name not in keys)
                conflict = f" ON CONFLICT({key_columns}) DO UPDATE SET {updates}" if updates else " ON CONFLICT DO NOTHING"
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
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"SQLite 数据库不存在：{args.db}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    counts = export(args.db, args.output)
    print(f"已生成 {args.output}（{args.output.stat().st_size:,} bytes）")
    for table, count in counts.items():
        print(f"{table}: {count}")


if __name__ == "__main__":
    main()
