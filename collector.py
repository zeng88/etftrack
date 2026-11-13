"""Public Tencent quote and Sina 5-minute K-line collection."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any
from urllib.parse import urlencode
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from storage import DB_PATH, connect

TZ = ZoneInfo("Asia/Shanghai")
QUOTE_URL = "https://qt.gtimg.cn/q="
SINA_KLINE_URL = "https://quotes.sina.cn/cn/api/jsonp.php/=/CN_MarketDataService.getKLineData"
SOURCE = "腾讯公开行情 + 新浪 5 分钟 K 线"
RUN_LOCK = threading.Lock()
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"


def _https_get(url: str, referer: str = "") -> bytes:
    """Use the platform curl TLS trust store; never disable certificate checks."""
    args = ["/usr/bin/curl", "--fail", "--silent", "--show-error", "--location", "--max-time", "22",
            "--user-agent", USER_AGENT]
    if referer:
        args += ["--referer", referer]
    args.append(url)
    return subprocess.run(args, check=True, capture_output=True, timeout=25).stdout


def _number(fields: list[str], index: int) -> float:
    try:
        value = float(fields[index].strip() or 0)
        return value if math.isfinite(value) else 0.0
    except (IndexError, ValueError):
        return 0.0


def fetch_quotes(etfs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    symbols = ",".join(item["tcode"] for item in etfs)
    raw = _https_get(QUOTE_URL + urlencode({"q": symbols})).decode("gb18030", errors="replace")
    quotes: dict[str, dict[str, Any]] = {}
    for statement in raw.split(";"):
        if '="' not in statement:
            continue
        name, body = statement.split('="', 1)
        code_match = re.search(r"(\d{6})$", name.strip())
        fields = body.rstrip().rstrip('"').split("~")
        if not code_match or len(fields) < 73:
            continue
        code = code_match.group(1)
        stamp = fields[30].strip() if len(fields) > 30 else ""
        if len(stamp) < 8:
            continue
        quotes[code] = {
            "code": code,
            "name": fields[1].strip(),
            "price": _number(fields, 3),
            "prev_close": _number(fields, 4),
            "volume_lots": _number(fields, 6),
            "outer_lots": _number(fields, 7),
            "inner_lots": _number(fields, 8),
            "date": stamp[:8],
            "ts": stamp,
            "pct": _number(fields, 32),
            "amount_yi": _number(fields, 37) / 10000,
            "turnover": _number(fields, 38),
            "mktcap_yi": _number(fields, 45),
            "shares": _number(fields, 72),
        }
    return quotes


def fetch_live_flow(path: str | None = None) -> dict[str, Any]:
    """Estimate pool-wide aggressive buy/sell flow from the latest public ETF quotes."""
    conn = connect(path or DB_PATH)
    try:
        etfs = [dict(row) for row in conn.execute(
            "SELECT code,tcode,name FROM etfs WHERE group_name='core' ORDER BY code"
        )]
    finally:
        conn.close()
    if not etfs:
        raise RuntimeError("重点 ETF 名单为空")

    quotes = fetch_quotes(etfs)
    missing = sorted({item["code"] for item in etfs} - set(quotes))
    if missing:
        raise RuntimeError(f"实时行情覆盖不完整，缺少 {len(missing)} 只 ETF")

    buy_yi = sell_yi = amount_yi = 0.0
    stamps = []
    for quote in quotes.values():
        amount = max(float(quote.get("amount_yi") or 0), 0.0)
        outer = max(float(quote.get("outer_lots") or 0), 0.0)
        inner = max(float(quote.get("inner_lots") or 0), 0.0)
        total = outer + inner
        # Tencent's cumulative outer/inner volume gives an approximate trade direction.
        # Split reported turnover by that imbalance; it is not investor identity data.
        net = amount * (outer - inner) / total if total else 0.0
        buy_yi += (amount + net) / 2
        sell_yi += (amount - net) / 2
        amount_yi += amount
        stamps.append(quote["ts"])
    stamp = max(stamps)
    return {
        "date": stamp[:8], "time": stamp, "core_count": len(etfs),
        "buy_yi": round(buy_yi, 4), "sell_yi": round(sell_yi, 4),
        "net_yi": round(buy_yi - sell_yi, 4), "amount_yi": round(amount_yi, 4),
        "source": "腾讯公开行情内外盘估算",
    }


def _fetch_sina(etf: dict[str, Any]) -> tuple[str, list[dict[str, Any]], str | None]:
    query = urlencode({"symbol": etf["tcode"], "scale": "5", "ma": "5", "datalen": "1023"})
    try:
        raw = _https_get(f"{SINA_KLINE_URL}?{query}", "https://finance.sina.com.cn/").decode("utf-8", errors="replace")
        start = raw.find("=(")
        end = raw.rfind(")")
        if start < 0 or end <= start:
            return etf["code"], [], "新浪 K 线响应格式无法识别"
        values = json.loads(raw[start + 2:end])
        if not isinstance(values, list):
            return etf["code"], [], "新浪 K 线没有返回数组"
        return etf["code"], values, None
    except Exception as exc:  # network/provider errors become visible run status
        return etf["code"], [], f"{type(exc).__name__}: {exc}"


def backfill_exchange_shares(etfs: list[dict[str, Any]], start: str, end: str) -> tuple[list[tuple[str, str, float, str]], list[str]]:
    """Backfill published daily shares from SSE and SZSE within the short missing window."""
    rows: list[tuple[str, str, float, str]] = []
    errors: list[str] = []
    sh_items = [item for item in etfs if item["tcode"].startswith("sh")]
    if sh_items:
        from datetime import date, timedelta
        day = date.fromisoformat(start)
        last = date.fromisoformat(end)
        while day <= last:
            params = urlencode({"sqlId": "COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L", "STAT_DATE": day.isoformat()})
            try:
                payload = json.loads(_https_get(f"https://query.sse.com.cn/commonQuery.do?{params}", "https://www.sse.com.cn/").decode("utf-8", errors="replace"))
                wanted = {item["code"] for item in sh_items}
                for item in payload.get("result") or []:
                    code = str(item.get("SEC_CODE") or "")
                    if code in wanted and item.get("TOT_VOL") not in (None, ""):
                        rows.append((day.strftime("%Y%m%d"), code, float(str(item["TOT_VOL"]).replace(",", "")) * 1e4, "上交所 ETF 规模披露"))
            except Exception as exc:
                errors.append(f"上交所 {day.isoformat()}: {type(exc).__name__}")
            day += timedelta(days=1)

    sz_items = [item for item in etfs if item["tcode"].startswith("sz")]
    for item in sz_items:
        params = urlencode({"SHOWTYPE": "JSON", "CATALOGID": "scsj_fund_jjgm", "TABKEY": "tab1",
                            "txtDm": item["code"], "txtStart": start, "txtEnd": end,
                            "jjlb": "ETF", "tab1PAGENO": 1})
        try:
            payload = json.loads(_https_get(f"https://www.szse.cn/api/report/ShowReport/data?{params}",
                                            "https://www.szse.cn/market/fund/volume/etf/index.html").decode("utf-8", errors="replace"))
            block = payload[0] if isinstance(payload, list) and payload else {}
            for item_row in block.get("data") or []:
                date = str(item_row.get("size_date") or "").replace("-", "")
                shares = float(str(item_row.get("current_size") or "0").replace(",", "")) * 1e4
                if len(date) == 8 and shares > 0:
                    rows.append((date, item["code"], shares, "深交所 ETF 规模披露"))
        except Exception as exc:
            errors.append(f"深交所 {item['code']}: {type(exc).__name__}")
    return rows, errors


def fetch_sina_history(etfs: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    result: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(_fetch_sina, item) for item in etfs]
        for future in as_completed(futures):
            code, bars, error = future.result()
            if error:
                errors[code] = error
            else:
                result[code] = bars
    return result, errors


def _fetch_sina_daily(etf: dict[str, Any], datalen: int) -> tuple[str, list[dict[str, Any]], str | None]:
    query = urlencode({"symbol": etf["tcode"], "scale": "240", "ma": "no", "datalen": str(datalen)})
    try:
        raw = _https_get(f"{SINA_KLINE_URL}?{query}", "https://finance.sina.com.cn/").decode("utf-8", errors="replace")
        start, end = raw.find("=("), raw.rfind(")")
        if start < 0 or end <= start:
            return etf["code"], [], "日 K 线响应格式无法识别"
        values = json.loads(raw[start + 2:end])
        result = []
        for item in values if isinstance(values, list) else []:
            day = str(item.get("day") or "")[:10].replace("-", "")
            close = float(item.get("close") or 0)
            volume = float(item.get("volume") or 0)
            if len(day) == 8 and close > 0 and volume >= 0:
                result.append({"date": day, "close": close, "volume_lots": volume / 100,
                               "turnover_yi": close * volume / 1e8})
        return etf["code"], result, None
    except Exception as exc:
        return etf["code"], [], f"{type(exc).__name__}: {exc}"


def fetch_sina_daily(etfs: list[dict[str, Any]], datalen: int) -> tuple[dict[str, list[dict[str, Any]]], dict[str, str]]:
    result: dict[str, list[dict[str, Any]]] = {}
    errors: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(_fetch_sina_daily, item, datalen) for item in etfs]
        for future in as_completed(futures):
            code, rows, error = future.result()
            if error:
                errors[code] = error
            else:
                result[code] = rows
    return result, errors


def _day_rows(bars: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for bar in bars:
        stamp = str(bar.get("day") or "")
        if len(stamp) < 16:
            continue
        date, clock = stamp[:10].replace("-", ""), stamp[11:16]
        try:
            amount_yi = float(bar.get("amount") or 0) / 1e8
            volume_lots = float(bar.get("volume") or 0) / 100
        except (TypeError, ValueError):
            continue
        if not math.isfinite(amount_yi) or not math.isfinite(volume_lots):
            continue
        grouped.setdefault(date, []).append({"time": clock, "amount_yi": amount_yi, "volume_lots": volume_lots})

    result: dict[str, dict[str, Any]] = {}
    for date, points in grouped.items():
        points.sort(key=lambda point: point["time"])
        total = sum(point["amount_yi"] for point in points)
        if total <= 0:
            continue
        running = 0.0
        shape = []
        for point in points:
            running += point["amount_yi"]
            shape.append([point["time"], round(running / total, 5)])
        tail = sum(point["amount_yi"] for point in points if point["time"] >= "14:30") / total
        result[date] = {
            "amount_yi": total,
            "volume_lots": sum(point["volume_lots"] for point in points),
            "shape": shape,
            "tail_ratio": tail if points[-1]["time"] >= "15:00" else None,
            "complete": points[-1]["time"] >= "15:00",
            "last_time": points[-1]["time"],
        }
    return result


def _at_progress(shape: list[list[Any]], clock: str) -> float | None:
    eligible = [point for point in shape if len(point) >= 2 and str(point[0]) <= clock]
    if not eligible:
        return None
    try:
        return float(eligible[-1][1])
    except (TypeError, ValueError):
        return None


def _history_baselines(conn: sqlite3.Connection, code: str, date: str, clock: str) -> tuple[float, float, float]:
    amount_rows = conn.execute(
        "SELECT amount_yi FROM daily_activity WHERE code=? AND trade_date<? AND amount_yi IS NOT NULL ORDER BY trade_date DESC LIMIT 20",
        (code, date),
    ).fetchall()
    avg20 = sum(float(row[0]) for row in amount_rows) / len(amount_rows) if amount_rows else 0.0
    shape_rows = conn.execute(
        "SELECT shape_json,tail_ratio FROM daily_activity WHERE code=? AND trade_date<? ORDER BY trade_date DESC LIMIT 20",
        (code, date),
    ).fetchall()
    progress_values = []
    tail_values = []
    for row in shape_rows:
        if row["shape_json"]:
            progress = _at_progress(json.loads(row["shape_json"]), clock)
            if progress is not None:
                progress_values.append(progress)
        if row["tail_ratio"] is not None:
            tail_values.append(float(row["tail_ratio"]))
    progress = sum(progress_values) / len(progress_values) if progress_values else (1.0 if clock >= "15:00" else 0.0)
    tail = sum(tail_values) / len(tail_values) if tail_values else 0.0
    return avg20, progress, tail


def _previous_shares(conn: sqlite3.Connection, code: str, date: str) -> tuple[float | None, str | None]:
    row = conn.execute(
        "SELECT shares,trade_date FROM share_history WHERE code=? AND trade_date<? ORDER BY trade_date DESC LIMIT 1",
        (code, date),
    ).fetchone()
    return (float(row["shares"]), row["trade_date"]) if row else (None, None)


def _run_record(status: str, date: str | None, message: str, started: str) -> dict[str, Any]:
    finished = datetime.now(TZ).isoformat(timespec="seconds")
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO collection_runs(started_at,finished_at,status,trade_date,message,source) VALUES(?,?,?,?,?,?)",
            (started, finished, status, date, message[:1200], SOURCE),
        )
    finally:
        conn.close()
    return {"status": status, "trade_date": date, "message": message, "finished_at": finished}


def update_once(path: str | None = None) -> dict[str, Any]:
    if not RUN_LOCK.acquire(blocking=False):
        return {"status": "skipped", "message": "已有更新任务运行中"}
    started = datetime.now(TZ).isoformat(timespec="seconds")
    try:
        conn = connect(path or DB_PATH)
        try:
            etfs = [dict(row) for row in conn.execute(
                "SELECT code,tcode,name,index_name AS `index`,group_name AS `group`,huijin_yi FROM etfs ORDER BY code"
            )]
            latest = conn.execute("SELECT MAX(trade_date) AS d FROM daily_snapshots").fetchone()["d"]
            reference_row = conn.execute(
                "SELECT value FROM app_meta WHERE key='bootstrap_reference_date'"
            ).fetchone()
            reference_date = reference_row["value"] if reference_row else None
            pending_row = conn.execute(
                """SELECT 1 FROM share_history s JOIN etfs e ON e.code=s.code
                   WHERE s.trade_date=? AND e.group_name='core' AND s.source='腾讯行情份额字段' LIMIT 1""",
                (latest,),
            ).fetchone() if latest else None
            pending_quote_date = bool(pending_row)
        finally:
            conn.close()
        if not etfs:
            return _run_record("failed", None, "ETF 名单为空，请重新初始化 SQLite 数据库", started)

        quotes = fetch_quotes(etfs)
        missing = sorted({item["code"] for item in etfs} - set(quotes))
        if missing:
            raise RuntimeError(f"腾讯行情覆盖不完整，缺少 {len(missing)} 只 ETF：{', '.join(missing)}")
        dates = {quote["date"] for quote in quotes.values()}
        if len(dates) != 1:
            raise RuntimeError("腾讯行情返回的 ETF 交易日期不一致，本轮未写入")
        trade_date = dates.pop()
        if latest and trade_date < latest:
            return _run_record("skipped", trade_date, f"行情日期 {trade_date} 早于数据库最新日期 {latest}，保留旧快照", started)

        # Backfill daily close prices and market turnover for the statistics table once
        # per trading day. The first run loads up to 1,023 sessions; later runs are incremental.
        conn = connect(path or DB_PATH)
        try:
            checked_for = conn.execute("SELECT value FROM app_meta WHERE key='daily_closes_checked_for'").fetchone()
            close_count = conn.execute("SELECT COUNT(*) FROM daily_closes").fetchone()[0]
        finally:
            conn.close()
        if not checked_for or checked_for[0] != trade_date:
            daily_rows, daily_errors = fetch_sina_daily(etfs, 1023 if close_count == 0 else 10)
            conn = connect(path or DB_PATH)
            try:
                conn.execute("BEGIN IMMEDIATE")
                for code, records in daily_rows.items():
                    for record in records:
                        if record["date"] >= trade_date:
                            continue
                        conn.execute(
                            """INSERT OR REPLACE INTO daily_closes
                               (trade_date,code,close_price,volume_lots,turnover_yi,source)
                               VALUES(?,?,?,?,?,?)""",
                            (record["date"], code, record["close"], record["volume_lots"],
                             record["turnover_yi"], "新浪 ETF 日 K 线估算"),
                        )
                        conn.execute(
                            """INSERT INTO daily_activity
                               (trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete)
                               VALUES(?,?,?,?,NULL,NULL,1)
                               ON CONFLICT(trade_date,code) DO UPDATE SET
                                 amount_yi=COALESCE(daily_activity.amount_yi,excluded.amount_yi),
                                 volume_lots=COALESCE(daily_activity.volume_lots,excluded.volume_lots)""",
                            (record["date"], code, record["turnover_yi"], record["volume_lots"]),
                        )
                conn.execute("INSERT OR REPLACE INTO app_meta(key,value) VALUES('daily_closes_checked_for',?)", (trade_date,))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.close()
            if daily_errors:
                print("日收盘数据补齐提示：" + "；".join(f"{code} {error}" for code, error in list(daily_errors.items())[:8]))

        # Fill the gap since the last saved close from the exchanges' published share data.
        # A bootstrap snapshot is only a reference sample, so include its date in the first
        # official backfill instead of treating it as a verified share-history baseline.
        if latest and latest < trade_date:
            from datetime import date, timedelta
            latest_day = date.fromisoformat(f"{latest[:4]}-{latest[4:6]}-{latest[6:8]}")
            start_day = latest_day if pending_quote_date else latest_day + timedelta(days=1)
            end_day = date.fromisoformat(f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:8]}") - timedelta(days=1)
            if reference_date and reference_date < trade_date:
                reference_day = date.fromisoformat(f"{reference_date[:4]}-{reference_date[4:6]}-{reference_date[6:8]}")
                if reference_day <= end_day:
                    start_day = min(start_day, reference_day)
            start, end = start_day.isoformat(), end_day.isoformat()
            if start <= end:
                backfill_rows, backfill_errors = backfill_exchange_shares(etfs, start, end)
                if backfill_rows:
                    conn = connect(path or DB_PATH)
                    try:
                        conn.executemany(
                            """INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source)
                               VALUES(?,?,?,?,?)""",
                            [(day, code, shares, datetime.now(TZ).isoformat(timespec="seconds"), source)
                             for day, code, shares, source in backfill_rows],
                        )
                        if reference_date:
                            core_codes = {item["code"] for item in etfs if item["group"] == "core"}
                            covered = {row[0] for row in conn.execute(
                                "SELECT code FROM share_history WHERE trade_date=? AND source!='参考快照'",
                                (reference_date,),
                            )}
                            if core_codes.issubset(covered):
                                conn.execute("DELETE FROM app_meta WHERE key='bootstrap_reference_date'")
                    finally:
                        conn.close()
                if backfill_errors:
                    print("份额历史补齐提示：" + "；".join(backfill_errors[:8]))

        newest_stamp = max(quote["ts"] for quote in quotes.values())
        if latest == trade_date:
            conn = connect(path or DB_PATH)
            try:
                previous_run = conn.execute(
                    "SELECT MAX(source_ts) AS ts FROM daily_snapshots WHERE trade_date=?", (trade_date,)
                ).fetchone()["ts"]
            finally:
                conn.close()
            if previous_run and newest_stamp <= previous_run:
                # The browser checks every 20 seconds. Avoid writing a duplicate run row
                # each time the upstream quote timestamp has not advanced.
                return {"status": "skipped", "trade_date": trade_date,
                        "message": "同一交易日行情没有更新，保留现有快照", "finished_at": started}

        bars_by_code, errors = fetch_sina_history(etfs)
        core_codes = {item["code"] for item in etfs if item["group"] == "core"}
        missing_core = sorted(core_codes - set(bars_by_code))
        if missing_core:
            raise RuntimeError(f"新浪 K 线未覆盖全部重点 ETF，缺少 {len(missing_core)} 只；本轮未写入快照")

        all_days = {code: _day_rows(bars) for code, bars in bars_by_code.items()}
        for code in core_codes:
            if trade_date not in all_days.get(code, {}):
                raise RuntimeError(f"重点 ETF {code} 缺少 {trade_date} 的 5 分钟数据，本轮未写入快照")

        conn = connect(path or DB_PATH)
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                for code, day_map in all_days.items():
                    for date, activity in day_map.items():
                        quote = quotes.get(code) if date == trade_date else None
                        amount = quote["amount_yi"] if quote else activity["amount_yi"]
                        volume = quote["volume_lots"] if quote else activity["volume_lots"]
                        conn.execute(
                            """INSERT OR REPLACE INTO daily_activity
                               (trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete)
                               VALUES(?,?,?,?,?,?,?)""",
                            (date, code, amount, volume, json.dumps(activity["shape"], ensure_ascii=False),
                             activity["tail_ratio"], int(activity["complete"])),
                        )

                quote_clock = max(q["ts"][8:12] for q in quotes.values())
                clock = f"{quote_clock[:2]}:{quote_clock[2:4]}"
                if clock >= "15:00":
                    clock = "15:00"
                snapshot_source = SOURCE + ("（盘中）" if clock < "15:00" else "（收盘后）")
                for etf in etfs:
                    code = etf["code"]
                    quote = quotes[code]
                    day = all_days[code][trade_date]
                    if clock < "15:00":
                        day = dict(day)
                        day["amount_yi"] = quote["amount_yi"]
                        day["volume_lots"] = quote["volume_lots"]
                        day["tail_ratio"] = None
                        day["complete"] = False
                    avg20, progress, tail_base = _history_baselines(conn, code, trade_date, clock)
                    if avg20 <= 0:
                        avg20 = 0.0
                    previous_shares, previous_date = _previous_shares(conn, code, trade_date)
                    net = None
                    if previous_shares is not None and quote["price"] > 0:
                        net = round((quote["shares"] - previous_shares) * quote["price"] / 1e8, 2)
                    ratio = quote["amount_yi"] / (avg20 * progress) if avg20 > 0 and progress > 0 else 0
                    payload = {
                        **etf,
                        **quote,
                        "amount_wan": quote["amount_yi"] * 10000,
                        "shares_yi": quote["shares"] / 1e8,
                        "prev_shares": previous_shares,
                        "prev_share_date": previous_date,
                        "subscr_net_yi": net,
                        "avg20_yi": round(avg20, 4),
                        "day_progress": round(progress, 5),
                        "ratio": round(ratio, 4),
                        "tail_ratio": day.get("tail_ratio"),
                        "tail_ratio_base": round(tail_base, 5) if tail_base else None,
                        "shape": day.get("shape", []),
                        "hist": [
                            {"date": r["trade_date"], "amount_yi": r["amount_yi"], "volume_lots": r["volume_lots"]}
                            for r in conn.execute(
                                "SELECT trade_date,amount_yi,volume_lots FROM daily_activity WHERE code=? ORDER BY trade_date DESC LIMIT 30",
                                (code,),
                            ).fetchall()[::-1]
                        ],
                        "source": snapshot_source,
                        "kline_status": "available" if code in bars_by_code else "unavailable",
                    }
                    conn.execute(
                        """INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source)
                           VALUES(?,?,?,?,?)""",
                        (trade_date, code, quote["shares"], quote["ts"], "腾讯行情份额字段"),
                    )
                    conn.execute(
                        """INSERT OR REPLACE INTO daily_snapshots(trade_date,code,payload_json,source_ts,source)
                           VALUES(?,?,?,?,?)""",
                        (trade_date, code, json.dumps(payload, ensure_ascii=False), quote["ts"], snapshot_source),
                    )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.close()

        optional_errors = len(errors)
        message = f"已更新 {trade_date} 交易数据；覆盖 {len(quotes)} 只 ETF，K 线缺失 {optional_errors} 只"
        return _run_record("success", trade_date, message, started)
    except Exception as exc:
        return _run_record("failed", None, f"更新失败：{type(exc).__name__}: {exc}", started)
    finally:
        RUN_LOCK.release()


def main() -> None:
    result = update_once()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
