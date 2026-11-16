#!/usr/bin/env python3
"""Backfill one year of official ETF share history and daily market bars."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from collector import _https_get, backfill_exchange_shares, fetch_sina_daily
from storage import DB_PATH, connect, initialize_db


def main() -> int:
    today = date.today()
    parser = argparse.ArgumentParser(description="补齐核心 34 只 ETF 近一年份额与日 K 线数据")
    parser.add_argument("--start", default=(today - timedelta(days=365)).isoformat(), help="开始日期 YYYY-MM-DD")
    parser.add_argument("--end", default=(today - timedelta(days=1)).isoformat(), help="结束日期 YYYY-MM-DD")
    args = parser.parse_args()
    date.fromisoformat(args.start)
    date.fromisoformat(args.end)

    initialize_db()
    conn = connect(DB_PATH)
    etfs = [dict(row) for row in conn.execute(
        "SELECT code,tcode,name FROM etfs WHERE group_name='core' ORDER BY code"
    )]
    conn.close()
    if len(etfs) != 34:
        raise SystemExit(f"核心篮子应为 34 只，当前读取到 {len(etfs)} 只；请先应用数据库迁移")

    print(f"开始回填 {args.start} 至 {args.end}：{len(etfs)} 只 ETF")
    # The reference page publishes its underlying share cache and includes the recent
    # rescue ETFs that are absent from older exchange query windows.
    reference_cache = json.loads(_https_get(
        "https://raw.githubusercontent.com/wwww1998/national-team-etf-flow/main/_etf_shares_cache.json"
    ).decode("utf-8"))
    wanted_codes = {item["code"] for item in etfs}
    start_key, end_key = args.start.replace("-", ""), args.end.replace("-", "")
    reference_rows = [
        (day, code, float(shares), "参考页公开份额历史缓存")
        for day, values in reference_cache.get("shares", {}).items()
        if start_key <= day <= end_key
        for code, shares in values.items()
        if code in wanted_codes and float(shares or 0) > 0
    ]
    exchange_rows, share_errors = backfill_exchange_shares(etfs, args.start, args.end)
    # Prefer the supplied reference cache where it has a value, and fill older
    # cache gaps from exchange disclosures (notably the SSE funds omitted there).
    merged_shares = {(day, code): (day, code, shares, source)
                     for day, code, shares, source in exchange_rows}
    for row in reference_rows:
        merged_shares[(row[0], row[1])] = row
    share_rows = list(merged_shares.values())
    covered_by_date: dict[str, set[str]] = {}
    for day, code, _, _ in share_rows:
        covered_by_date.setdefault(day, set()).add(code)
    complete_days = sorted(day for day, codes in covered_by_date.items() if wanted_codes.issubset(codes))
    if not complete_days:
        raise SystemExit("交易所披露与参考缓存都没有提供完整核心 ETF 交易日")
    close_rows, close_errors = fetch_sina_daily(etfs, 1023)

    conn = connect(DB_PATH)
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            """INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source)
               VALUES(?,?,?,?,?)""",
            [(day, code, shares, date.today().isoformat(), source) for day, code, shares, source in share_rows],
        )
        for code, records in close_rows.items():
            for row in records:
                if row["date"] > args.end.replace("-", ""):
                    continue
                conn.execute(
                    """INSERT OR REPLACE INTO daily_closes
                       (trade_date,code,close_price,volume_lots,turnover_yi,source) VALUES(?,?,?,?,?,?)""",
                    (row["date"], code, row["close"], row["volume_lots"], row["turnover_yi"], "新浪 ETF 日 K 线估算"),
                )
                conn.execute(
                    """INSERT INTO daily_activity(trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete)
                       VALUES(?,?,?,?,NULL,NULL,1) ON CONFLICT(trade_date,code) DO UPDATE SET
                       amount_yi=COALESCE(daily_activity.amount_yi,excluded.amount_yi),
                       volume_lots=COALESCE(daily_activity.volume_lots,excluded.volume_lots)""",
                    (row["date"], code, row["turnover_yi"], row["volume_lots"]),
                )
        conn.execute("DELETE FROM app_meta WHERE key='daily_closes_checked_for'")
        conn.commit()
        print(f"历史份额写入 {len(share_rows)} 行；34 只齐全 {len(complete_days)} 个交易日；日 K 线覆盖 {len(close_rows)}/{len(etfs)} 只")
        for row in conn.execute(
            """SELECT e.code,e.name,COUNT(h.trade_date) AS n,MIN(h.trade_date) AS first,MAX(h.trade_date) AS last
               FROM etfs e LEFT JOIN share_history h ON h.code=e.code AND h.source IN
                 ('上交所 ETF 规模披露','深交所 ETF 规模披露','参考页公开份额历史缓存')
               WHERE e.group_name='core' GROUP BY e.code ORDER BY e.code"""
        ):
            print(f"{row['code']} {row['name']}: {row['n']} 日 {row['first'] or '无'} → {row['last'] or '无'}")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    if share_errors:
        print("份额数据源错误：" + "；".join(share_errors[:12]))
    if close_errors:
        print("日 K 线数据源错误：" + "；".join(f"{code} {error}" for code, error in list(close_errors.items())[:12]))
    return 0 if not share_errors and len(close_rows) == len(etfs) and len(complete_days) > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
