"""SQLite persistence and dashboard read models for the local prototype."""

from __future__ import annotations

import json
import calendar
import sqlite3
from datetime import date as calendar_date, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "etf_tracker.sqlite3"
BOOTSTRAP_PATH = DATA_DIR / "bootstrap.json"
MAX_PARTIAL_SHARE_GAPS = 2


def has_usable_share_coverage(expected: int, received: int) -> bool:
    """Permit a labelled estimate when at most two funds lag disclosure."""
    return expected > 0 and received >= max(1, expected - MAX_PARTIAL_SHARE_GAPS)


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def initialize_db(path: Path | str = DB_PATH) -> bool:
    conn = connect(path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
        migrations_dir = ROOT / "migrations"
        if migrations_dir.is_dir():
            for migration in sorted(migrations_dir.glob("*.sql")):
                applied = conn.execute("SELECT 1 FROM schema_migrations WHERE name=?", (migration.name,)).fetchone()
                if applied:
                    continue
                conn.executescript("BEGIN IMMEDIATE;\n" + migration.read_text(encoding="utf-8") +
                                   f"\nINSERT INTO schema_migrations(name,applied_at) VALUES('{migration.name}',datetime('now'));\nCOMMIT;")
        # Keep the original schema as an idempotent compatibility check for local databases.
        conn.executescript((ROOT / "schema.sql").read_text(encoding="utf-8"))
        conn.execute("PRAGMA journal_mode = WAL")
        seeded = conn.execute("SELECT value FROM app_meta WHERE key='bootstrap_loaded'").fetchone()
        # The reference page serialized its historical `shares` values in 100M-share units,
        # while live snapshots and the DB model store raw shares. Normalize old imports once.
        conn.execute(
            "UPDATE share_history SET shares=shares*100000000 WHERE source='参考快照历史' AND shares>0 AND shares<1000000"
        )
        if seeded:
            return False

        bootstrap = json.loads(BOOTSTRAP_PATH.read_text(encoding="utf-8"))
        generated_at = bootstrap["meta"].get("generated_at") or datetime.now().isoformat(timespec="seconds")
        trade_date = bootstrap["snapshot_date"]
        conn.execute("BEGIN IMMEDIATE")
        try:
            for etf in bootstrap["etfs"]:
                conn.execute(
                    """INSERT OR REPLACE INTO etfs(code,tcode,name,index_name,group_name,huijin_yi)
                       VALUES(?,?,?,?,?,?)""",
                    (etf["code"], etf["tcode"], etf["name"], etf["index"], etf["group"], etf.get("huijin_yi")),
                )

            conn.executemany(
                """INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source)
                   VALUES(?,?,?,?,?)""",
                [
                    (row["date"], row["code"], float(row["shares"]) * 1e8, generated_at, "参考快照历史")
                    for row in bootstrap["share_history"]
                ],
            )

            for item in bootstrap["snapshots"]:
                code = item["code"]
                payload = dict(item)
                payload["prev_share_date"] = bootstrap["meta"].get("prev_share_date")
                conn.execute(
                    """INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source)
                       VALUES(?,?,?,?,?)""",
                    (trade_date, code, float(item.get("shares") or 0), generated_at, "参考快照")
                )
                conn.execute(
                    """INSERT OR REPLACE INTO daily_snapshots(trade_date,code,payload_json,source_ts,source)
                       VALUES(?,?,?,?,?)""",
                    (trade_date, code, json.dumps(payload, ensure_ascii=False), item.get("ts") or generated_at,
                     "参考网站 2026-11-06 快照"),
                )
                for hist in item.get("hist") or []:
                    date = str(hist.get("date", "")).replace("-", "")
                    if len(date) != 8:
                        continue
                    conn.execute(
                        """INSERT OR REPLACE INTO daily_activity
                           (trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete)
                           VALUES(?,?,?,?,?,?,?)""",
                        (date, code, hist.get("amount_yi"), hist.get("volume_lots"), None, None, 1),
                    )
                conn.execute(
                    """INSERT OR REPLACE INTO daily_activity
                       (trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete)
                       VALUES(?,?,?,?,?,?,?)""",
                    (trade_date, code, item.get("amount_yi"), item.get("volume_lots"),
                     json.dumps(item.get("shape") or [], ensure_ascii=False), item.get("tail_ratio"), 1),
                )

            conn.execute(
                "INSERT INTO collection_runs(started_at,finished_at,status,trade_date,message,source) VALUES(?,?,?,?,?,?)",
                (generated_at, generated_at, "success", trade_date, "已导入参考页历史快照", "用户提供的参考页"),
            )
            for key, value in bootstrap["meta"].items():
                conn.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES(?,?)", (key, str(value)))
            conn.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES('bootstrap_reference_date',?)", (trade_date,))
            conn.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES('bootstrap_loaded','1')")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return True
    finally:
        conn.close()


def _latest_run(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT id,started_at,finished_at,status,trade_date,message,source FROM collection_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return dict(row) if row else None


def load_dashboard(code: str = "510300", days: int = 30) -> dict[str, Any]:
    conn = connect()
    try:
        latest = conn.execute("SELECT MAX(trade_date) AS d FROM daily_snapshots").fetchone()["d"]
        rows = []
        if latest:
            raw_rows = conn.execute(
                """SELECT e.code,e.tcode,e.name,e.index_name,e.group_name,e.huijin_yi,
                          s.payload_json,s.source_ts,s.source
                   FROM daily_snapshots s JOIN etfs e ON e.code=s.code
                   WHERE s.trade_date=? ORDER BY CASE e.group_name WHEN 'core' THEN 0 ELSE 1 END,
                     COALESCE(e.huijin_yi,0) DESC,e.code""", (latest,)
            ).fetchall()
            for row in raw_rows:
                item = json.loads(row["payload_json"])
                item.update({
                    "code": row["code"], "tcode": row["tcode"], "name": row["name"],
                    "index": row["index_name"], "group": row["group_name"],
                    "huijin_yi": row["huijin_yi"], "source_ts": row["source_ts"],
                    "source_name": row["source"],
                })
                if item.get("price") and item.get("shares") and item.get("prev_shares"):
                    item["subscr_net_yi"] = round(
                        (float(item["shares"]) - float(item["prev_shares"])) * float(item["price"]) / 1e8, 2
                    )
                rows.append(item)

        core = [item for item in rows if item.get("group") == "core"]
        amount = sum(float(i.get("amount_yi") or 0) for i in core)
        avg20 = sum(float(i.get("avg20_yi") or 0) for i in core)
        estimated_flow = sum(float(i.get("subscr_net_yi") or 0) for i in core)
        cap = sum(float(i.get("mktcap_yi") or 0) for i in core)
        weighted_change = (
            sum(float(i.get("pct") or 0) * float(i.get("mktcap_yi") or 0) for i in core) / cap
            if cap else 0
        )
        flow_signed = sum(
            (
                float(i.get("outer_lots") or 0) - float(i.get("inner_lots") or 0)
            ) / max(float(i.get("outer_lots") or 0) + float(i.get("inner_lots") or 0), 1)
            * float(i.get("amount_yi") or 0)
            for i in core
        )
        progress = min([float(i.get("day_progress") or 1) for i in core] or [1])
        base_comparable = avg20 * progress
        ratio = amount / base_comparable if base_comparable else 0
        if ratio >= 1.8 and estimated_flow > 0:
            verdict = "成交放量，份额估算偏流入"
        elif ratio >= 1.3:
            verdict = "成交较活跃，方向仍需观察"
        else:
            verdict = "暂未看到明显放量"

        core_codes = [item["code"] for item in rows if item.get("group") == "core"]
        aggregate_rows = conn.execute(
            """SELECT h.trade_date,h.code,h.shares,h.source
               FROM share_history h
               WHERE h.code IN (SELECT code FROM etfs WHERE group_name='core') AND h.source <> '腾讯行情份额字段'
               ORDER BY h.trade_date,h.code"""
        ).fetchall()
        by_date: dict[str, dict[str, float]] = {}
        share_deltas: dict[str, dict[str, float]] = {}
        unconfirmed_dates: set[str] = set()
        first_seen: dict[str, str] = {}
        previous_by_code: dict[str, float] = {}
        for row in aggregate_rows:
            code, date, shares = row["code"], row["trade_date"], float(row["shares"])
            by_date.setdefault(date, {})[code] = shares
            first_seen.setdefault(code, date)
            if code in previous_by_code:
                share_deltas.setdefault(date, {})[code] = (shares - previous_by_code[code]) / 1e8
            previous_by_code[code] = shares
            if row["source"] == "腾讯行情份额字段":
                unconfirmed_dates.add(row["trade_date"])
        pool_history = []
        for date in sorted(by_date):
            if date in unconfirmed_dates:
                continue
            # Include each ETF from its first published share observation (newer ETFs
            # did not exist for the full historical window). Never forward-fill gaps.
            active_codes = [code for code in core_codes if first_seen.get(code, date) <= date]
            changes = share_deltas.get(date, {})
            covered_codes = [code for code in active_codes if code in by_date[date] and code in changes]
            if not has_usable_share_coverage(len(active_codes), len(covered_codes)):
                continue
            total = sum(by_date[date][code] for code in covered_codes)
            pool_history.append({
                "date": date, "shares_yi": total / 1e8,
                "delta_yi": sum(changes[code] for code in covered_codes),
                "core_count": len(covered_codes), "basket_count": len(active_codes),
            })

        # Keep the full range in the API: the two charts have independent range selectors.
        # `days` remains accepted for compatibility with older local URLs.

        latest_run = _latest_run(conn)
        meta = {row["key"]: row["value"] for row in conn.execute("SELECT key,value FROM app_meta")}
        return {
            "runtime": "local", "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "trade_date": latest, "source": meta.get("source", "腾讯行情公开接口；新浪 5 分钟 K 线"),
            "huijin_basis": meta.get("huijin_basis", "2025 年报历史披露口径，仅为历史标签"),
            "prev_share_date": meta.get("prev_share_date"), "latest_run": latest_run,
            "summary": {
                "amount_yi": amount, "avg20_yi": avg20, "ratio": ratio,
                "flow_yi": estimated_flow, "active_net_yi": flow_signed,
                "weighted_pct": weighted_change, "progress": progress, "verdict": verdict,
                "core_count": len(core), "total_count": len(rows),
            },
            "etfs": rows,
            "history": {"pool": pool_history},
        }
    finally:
        conn.close()


def load_flow_detail(trade_date: str) -> dict[str, Any]:
    """Return a same-day breakdown for a selected aggregate chart bar."""
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT e.code,e.name,h.shares,prev.shares AS prev_shares,
                      a.amount_yi,a.volume_lots,h.source,c.close_price,snap.payload_json AS snapshot_payload
               FROM etfs e
               JOIN share_history h ON h.code=e.code AND h.trade_date=? AND h.source <> '腾讯行情份额字段'
               LEFT JOIN share_history prev ON prev.code=e.code AND prev.trade_date=(
                   SELECT MAX(p.trade_date) FROM share_history p
                   WHERE p.code=e.code AND p.trade_date<h.trade_date AND p.source <> '腾讯行情份额字段'
               )
               LEFT JOIN daily_activity a ON a.code=e.code AND a.trade_date=h.trade_date
               LEFT JOIN daily_closes c ON c.code=e.code AND c.trade_date=h.trade_date
               LEFT JOIN daily_snapshots snap ON snap.code=e.code AND snap.trade_date=h.trade_date
               WHERE e.group_name='core' ORDER BY e.code""", (trade_date,)
        ).fetchall()
        basket_count = conn.execute("""SELECT COUNT(*) FROM etfs e WHERE e.group_name='core' AND EXISTS (
            SELECT 1 FROM share_history h WHERE h.code=e.code
              AND h.source <> '腾讯行情份额字段' AND h.trade_date<=?)""",
            (trade_date,)).fetchone()[0] or len(rows)
        if not has_usable_share_coverage(basket_count, len(rows)) or any(row["source"] == "腾讯行情份额字段" for row in rows):
            return {
                "date": trade_date, "core_count": len(rows), "basket_count": basket_count, "items": [],
                "buy_yi": 0.0, "sell_yi": 0.0, "net_yi": 0.0,
                "volume_yi": None, "amount_yi": None,
                "volume_coverage": 0, "amount_coverage": 0,
            }
        items = []
        total_buy_yi = 0.0
        total_sell_yi = 0.0
        total_amount_yi = 0.0
        total_volume_yi = 0.0
        volume_coverage = 0
        amount_coverage = 0
        total_buy_amount_yi = 0.0
        total_sell_amount_yi = 0.0
        buy_count = sell_count = buy_amount_coverage = sell_amount_coverage = 0
        for row in rows:
            delta_yi = None if row["prev_shares"] is None else (float(row["shares"]) - float(row["prev_shares"])) / 1e8
            volume_yi = None if row["volume_lots"] is None else float(row["volume_lots"]) * 100 / 1e8
            amount_yi = None if row["amount_yi"] is None else float(row["amount_yi"])
            close_price = float(row["close_price"]) if row["close_price"] is not None else None
            if close_price is None and row["snapshot_payload"]:
                try:
                    close_price = float(json.loads(row["snapshot_payload"]).get("price") or 0) or None
                except (TypeError, ValueError, json.JSONDecodeError):
                    close_price = None
            estimated_amount_yi = delta_yi * close_price if delta_yi is not None and close_price is not None else None
            if delta_yi is not None:
                if delta_yi > 0:
                    total_buy_yi += delta_yi
                    buy_count += 1
                    if estimated_amount_yi is not None:
                        total_buy_amount_yi += estimated_amount_yi
                        buy_amount_coverage += 1
                else:
                    total_sell_yi += abs(delta_yi)
                    if delta_yi < 0:
                        sell_count += 1
                        if estimated_amount_yi is not None:
                            total_sell_amount_yi += abs(estimated_amount_yi)
                            sell_amount_coverage += 1
            if volume_yi is not None:
                total_volume_yi += volume_yi
                volume_coverage += 1
            if amount_yi is not None:
                total_amount_yi += amount_yi
                amount_coverage += 1
            items.append({
                "code": row["code"], "name": row["name"], "delta_yi": delta_yi,
                "buy_amount_yi": max(estimated_amount_yi, 0) if estimated_amount_yi is not None else None,
                "sell_amount_yi": abs(min(estimated_amount_yi, 0)) if estimated_amount_yi is not None else None,
                "volume_yi": volume_yi, "amount_yi": amount_yi, "source": row["source"],
            })
        return {
            "date": trade_date, "core_count": len(items), "basket_count": basket_count, "items": items,
            "buy_yi": total_buy_yi, "sell_yi": total_sell_yi,
            "buy_amount_yi": total_buy_amount_yi, "sell_amount_yi": total_sell_amount_yi,
            "buy_count": buy_count, "sell_count": sell_count,
            "buy_amount_coverage": buy_amount_coverage, "sell_amount_coverage": sell_amount_coverage,
            "net_yi": total_buy_yi - total_sell_yi,
            "volume_yi": total_volume_yi if volume_coverage else None,
            "amount_yi": total_amount_yi if amount_coverage else None,
            "volume_coverage": volume_coverage, "amount_coverage": amount_coverage,
        }
    finally:
        conn.close()


def load_pool_statistics(days: int = 20) -> list[dict[str, Any]]:
    """Build pooled share, estimated flow, and turnover statistics for the table."""
    conn = connect()
    try:
        core_codes = [row[0] for row in conn.execute("SELECT code FROM etfs WHERE group_name='core' ORDER BY code")]
        histories = conn.execute(
            """SELECT trade_date,code,shares,source FROM share_history
               WHERE code IN (SELECT code FROM etfs WHERE group_name='core') AND source <> '腾讯行情份额字段' ORDER BY trade_date,code"""
        ).fetchall()
        deltas_by_date: dict[str, dict[str, float]] = {}
        unconfirmed_dates: set[str] = set()
        previous_by_code: dict[str, float] = {}
        first_seen: dict[str, str] = {}
        for row in histories:
            code = row["code"]
            shares = float(row["shares"])
            first_seen.setdefault(code, row["trade_date"])
            if row["source"] == "腾讯行情份额字段":
                unconfirmed_dates.add(row["trade_date"])
            if code in previous_by_code:
                deltas_by_date.setdefault(row["trade_date"], {})[code] = (shares - previous_by_code[code]) / 1e8
            previous_by_code[code] = shares

        activity_by_date: dict[str, dict[str, sqlite3.Row]] = {}
        for row in conn.execute(
            """SELECT trade_date,code,amount_yi,volume_lots FROM daily_activity
               WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date"""
        ):
            activity_by_date.setdefault(row["trade_date"], {})[row["code"]] = row
        prices_by_date: dict[str, dict[str, float]] = {}
        for row in conn.execute(
            """SELECT trade_date,code,close_price FROM daily_closes
               WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date"""
        ):
            prices_by_date.setdefault(row["trade_date"], {})[row["code"]] = float(row["close_price"])

        latest_snapshot = conn.execute("SELECT MAX(trade_date) FROM daily_snapshots").fetchone()[0]
        live_prices: dict[str, float] = {}
        if latest_snapshot:
            for row in conn.execute("SELECT code,payload_json FROM daily_snapshots WHERE trade_date=?", (latest_snapshot,)):
                try:
                    payload = json.loads(row["payload_json"])
                    if payload.get("price"):
                        live_prices[row["code"]] = float(payload["price"])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue

        amount_history: list[float] = []
        result = []
        for trade_date in sorted(deltas_by_date):
            if trade_date in unconfirmed_dates:
                continue
            changes = deltas_by_date[trade_date]
            active_codes = [code for code in core_codes if first_seen.get(code, trade_date) <= trade_date]
            covered_codes = [code for code in active_codes if code in changes]
            if not has_usable_share_coverage(len(active_codes), len(covered_codes)):
                continue
            change_yi = sum(changes[code] for code in covered_codes)
            prices = prices_by_date.get(trade_date, {}).copy()
            if trade_date == latest_snapshot:
                prices.update(live_prices)
            money_complete = all(code in prices for code in covered_codes)
            buy_amount = sum(max(changes[code], 0) * prices[code] for code in covered_codes) if money_complete else None
            sell_amount = sum(abs(min(changes[code], 0)) * prices[code] for code in covered_codes) if money_complete else None
            net_amount = buy_amount - sell_amount if money_complete else None

            activity = activity_by_date.get(trade_date, {})
            turnover_complete = all(code in activity and activity[code]["amount_yi"] is not None for code in covered_codes)
            volume_complete = all(code in activity and activity[code]["volume_lots"] is not None for code in covered_codes)
            turnover = sum(float(activity[code]["amount_yi"]) for code in covered_codes) if turnover_complete else None
            volume_yi = sum(float(activity[code]["volume_lots"]) * 100 / 1e8 for code in covered_codes) if volume_complete else None
            baseline = sum(amount_history[-20:]) / min(20, len(amount_history)) if amount_history else 0
            multiple = turnover / baseline if turnover is not None and baseline > 0 else None
            if change_yi > 0:
                signal = "份额净增加"
            elif change_yi < 0:
                signal = "份额净减少"
            else:
                signal = "份额持平"
            result.append({
                "date": trade_date, "pool_name": "汪汪队ETF合计",
                "shares_change_yi": change_yi, "buy_amount_yi": buy_amount,
                "sell_amount_yi": sell_amount, "net_amount_yi": net_amount,
                "turnover_yi": turnover, "volume_yi": volume_yi,
                "turnover_multiple": multiple, "signal": signal,
                "coverage_count": len(covered_codes), "basket_count": len(active_codes),
            })
            if turnover_complete:
                amount_history.append(turnover)

        return result[-days:] if days > 0 else result
    finally:
        conn.close()


def load_flow_overview() -> dict[str, Any]:
    """Return consistent rolling flow estimates and ETF/index breakdowns."""
    conn = connect()
    try:
        etfs = [dict(row) for row in conn.execute(
            "SELECT code,name,index_name,huijin_yi FROM etfs WHERE group_name='core' ORDER BY code"
        )]
        codes = [row["code"] for row in etfs]
        if not codes:
            return {"as_of_date": None, "metrics": [], "indexes": [], "etfs": [], "core_count": 0}

        histories = conn.execute(
            """SELECT trade_date,code,shares,source FROM share_history
               WHERE code IN (SELECT code FROM etfs WHERE group_name='core') AND source <> '腾讯行情份额字段' ORDER BY trade_date,code"""
        ).fetchall()
        prices_rows = conn.execute(
            """SELECT trade_date,code,close_price FROM daily_closes
               WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date,code"""
        ).fetchall()
        latest_snapshot = conn.execute("SELECT MAX(trade_date) FROM daily_snapshots").fetchone()[0]
        live_prices: dict[str, float] = {}
        if latest_snapshot:
            for row in conn.execute("SELECT code,payload_json FROM daily_snapshots WHERE trade_date=?", (latest_snapshot,)):
                try:
                    price = float(json.loads(row["payload_json"]).get("price") or 0)
                    if price > 0:
                        live_prices[row["code"]] = price
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue

        deltas: dict[str, dict[str, float]] = {}
        shares_at_date: dict[str, dict[str, float]] = {}
        first_seen: dict[str, str] = {}
        unconfirmed: set[str] = set()
        previous: dict[str, float] = {}
        for row in histories:
            date, code, shares = row["trade_date"], row["code"], float(row["shares"])
            shares_at_date.setdefault(date, {})[code] = shares
            first_seen.setdefault(code, date)
            if row["source"] == "腾讯行情份额字段":
                unconfirmed.add(date)
            if code in previous:
                deltas.setdefault(date, {})[code] = (shares - previous[code]) / 1e8
            previous[code] = shares

        prices: dict[str, dict[str, float]] = {}
        for row in prices_rows:
            prices.setdefault(row["trade_date"], {})[row["code"]] = float(row["close_price"])

        daily: list[dict[str, Any]] = []
        for date in sorted(deltas):
            changes = deltas[date]
            active_codes = [code for code in codes if first_seen.get(code, date) <= date]
            covered_codes = [code for code in active_codes if code in changes]
            if date in unconfirmed or not has_usable_share_coverage(len(active_codes), len(covered_codes)):
                continue
            day_prices = prices.get(date, {}).copy()
            if date == latest_snapshot:
                day_prices.update(live_prices)
            if not all(code in day_prices for code in covered_codes):
                continue
            amounts = {code: changes[code] * day_prices[code] for code in covered_codes}
            daily.append({"date": date, "amount_yi": sum(amounts.values()), "by_code": amounts,
                          "core_count": len(covered_codes), "basket_count": len(active_codes)})

        if not daily:
            return {"as_of_date": None, "metrics": [], "indexes": [], "etfs": [], "core_count": len(codes)}

        as_of = daily[-1]["date"]
        year = as_of[:4]
        as_of_day = datetime.strptime(as_of, "%Y%m%d").date()
        def months_before(months: int) -> calendar_date:
            month_index = as_of_day.year * 12 + as_of_day.month - 1 - months
            target_year, target_month0 = divmod(month_index, 12)
            target_month = target_month0 + 1
            return calendar_date(target_year, target_month, min(as_of_day.day, calendar.monthrange(target_year, target_month)[1]))
        windows = [
            ("latest", "最新交易日合计", as_of_day),
            ("week", "近一周累计", as_of_day - timedelta(days=6)),
            ("month", "近一月累计", months_before(1)),
            ("half_year", "近半年累计", months_before(6)),
            ("year", "近一年累计", months_before(12)),
            ("ytd", "今年以来累计", calendar_date(as_of_day.year, 1, 1)),
        ]
        metrics = []
        dates_by_window: dict[str, list[str]] = {}
        for key, label, start_day in windows:
            start_date = start_day.strftime("%Y%m%d")
            selected = [row for row in daily if start_date <= row["date"] <= as_of]
            dates_by_window[key] = [row["date"] for row in selected]
            metrics.append({"key": key, "label": label, "value_yi": sum(row["amount_yi"] for row in selected),
                            "trading_days": len(selected), "start_date": selected[0]["date"] if selected else None,
                            "as_of_date": selected[-1]["date"] if selected else None})

        amount_by_code: dict[str, dict[str, float]] = {code: {} for code in codes}
        for item in daily:
            for code, amount in item["by_code"].items():
                amount_by_code[code][item["date"]] = amount
        def sum_code(code: str, window: str) -> float:
            selected_dates = set(dates_by_window[window])
            return sum(value for date_key, value in amount_by_code[code].items() if date_key in selected_dates)

        latest_shares = shares_at_date.get(as_of, {})
        etf_rows = []
        for etf in etfs:
            code = etf["code"]
            etf_rows.append({**etf, "shares_yi": latest_shares.get(code, 0) / 1e8,
                "latest_yi": sum_code(code, "latest"), "week_yi": sum_code(code, "week"),
                "month_yi": sum_code(code, "month"), "ytd_yi": sum_code(code, "ytd")})
        indexes_map: dict[str, dict[str, Any]] = {}
        for etf in etf_rows:
            index = etf["index_name"]
            group = indexes_map.setdefault(index, {"index_name": index, "etf_count": 0, "shares_yi": 0.0,
                "reported_huijin_yi": 0.0, "reported_huijin_count": 0,
                "latest_yi": 0.0, "week_yi": 0.0, "month_yi": 0.0, "ytd_yi": 0.0})
            group["etf_count"] += 1
            if etf["huijin_yi"] is not None:
                group["reported_huijin_yi"] += float(etf["huijin_yi"])
                group["reported_huijin_count"] += 1
            for key in ("shares_yi", "latest_yi", "week_yi", "month_yi", "ytd_yi"):
                group[key] += float(etf[key] or 0)
        indexes = sorted(indexes_map.values(), key=lambda row: row["month_yi"], reverse=True)
        etf_rows.sort(key=lambda row: row["month_yi"], reverse=True)
        recent_dates = [row["date"] for row in daily[-10:]]
        daily_matrix = [{"code": etf["code"], "name": etf["name"], "index_name": etf["index_name"],
                         "values": [next((day["by_code"][etf["code"]] for day in daily if day["date"] == date), None)
                                    for date in recent_dates]} for etf in etfs]
        latest_coverage = daily[-1]
        return {"as_of_date": as_of, "year": year, "core_count": len(codes),
            "coverage_count": latest_coverage["core_count"], "basket_count": latest_coverage["basket_count"],
            "metrics": metrics,
            "recent_dates": recent_dates, "daily_matrix": daily_matrix, "indexes": indexes, "etfs": etf_rows,
            "method": "区间按日历跨度回溯，交易日数按实际交易记录动态统计，节假日不计。新上市 ETF 从首次披露份额后纳入当日合计；逐只 ETF 份额变化 × 同日收盘价，最新日缺收盘价时使用行情快照。历史每日覆盖数量随篮子中新上市 ETF 逐步纳入而变化。",
            "holding_note": "2025年报披露份额仅代表历史披露时点；ETF总份额是全市场发行量，不代表国家队当前持有。申赎估算不能识别实际交易账户。"}
    finally:
        conn.close()
