#!/usr/bin/env python3
"""Merge supported tables from a Wrangler D1 SQL export into local SQLite."""
from __future__ import annotations
import argparse
import sqlite3
import tempfile
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import DB_PATH, initialize_db, connect

TABLES={
    "etfs":("code,tcode,name,index_name,group_name,huijin_yi","code"),
    "share_history":("trade_date,code,shares,observed_at,source","trade_date,code"),
    "daily_activity":("trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete","trade_date,code"),
    "daily_closes":("trade_date,code,close_price,volume_lots,turnover_yi,source","trade_date,code"),
    "daily_snapshots":("trade_date,code,payload_json,source_ts,source","trade_date,code"),
    "collection_runs":("id,started_at,finished_at,status,trade_date,message,source","id"),
    "app_meta":("key,value","key"),
}

def main():
    parser=argparse.ArgumentParser();parser.add_argument("export",type=Path);args=parser.parse_args()
    if not args.export.is_file():raise SystemExit(f"导出文件不存在：{args.export}")
    initialize_db()
    with tempfile.TemporaryDirectory() as temp:
        source=sqlite3.connect(Path(temp)/"d1-export.sqlite3")
        try:
            source.executescript(args.export.read_text(encoding="utf-8"))
            target=connect();counts={}
            try:
                target.execute("BEGIN IMMEDIATE")
                for table,(columns,key_columns) in TABLES.items():
                    try: rows=source.execute(f"SELECT {columns} FROM {table}").fetchall()
                    except sqlite3.OperationalError: continue
                    names=columns.split(",");marks=",".join("?" for _ in names)
                    keys=key_columns.split(",");updates=",".join(f"{name}=excluded.{name}" for name in names if name not in keys)
                    conflict=f" ON CONFLICT({key_columns}) DO UPDATE SET {updates}" if updates else " ON CONFLICT DO NOTHING"
                    target.executemany(f"INSERT INTO {table} ({columns}) VALUES ({marks}){conflict}",rows)
                    counts[table]=len(rows)
                target.commit()
            except Exception:target.rollback();raise
            finally:target.close()
        finally:source.close()
    print("远端数据已合并到本地 SQLite（未删除本地或未知表记录）：")
    for table,count in counts.items():print(f"{table}: {count}")

if __name__=="__main__":main()
