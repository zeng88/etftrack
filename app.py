"""Local HTTP server for the ETF Flow Observer."""

from __future__ import annotations

import json
import mimetypes
import re
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from collector import fetch_live_flow, update_once
from storage import ROOT, initialize_db, load_dashboard, load_flow_detail, load_pool_statistics

TZ = ZoneInfo("Asia/Shanghai")
STATIC_DIR = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8765


class Handler(BaseHTTPRequestHandler):
    server_version = "ETFFlowLocal/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{datetime.now(TZ).strftime('%H:%M:%S')}] {fmt % args}")

    def _json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/dashboard":
            query = parse_qs(parsed.query)
            code = (query.get("code") or ["510300"])[0]
            try:
                days = int((query.get("days") or ["30"])[0])
            except ValueError:
                days = 30
            days = 0 if days <= 0 else min(days, 1000)
            try:
                self._json(load_dashboard(code=code, days=days))
            except Exception as exc:
                self._json({"error": f"读取本地数据库失败：{type(exc).__name__}: {exc}"}, 500)
            return
        if parsed.path == "/api/flow-detail":
            trade_date = (parse_qs(parsed.query).get("date") or [""])[0]
            if not re.fullmatch(r"\d{8}", trade_date):
                self._json({"error": "日期格式应为 YYYYMMDD"}, 400)
                return
            try:
                detail = load_flow_detail(trade_date)
                if not detail["items"]:
                    self._json({"error": "所选日期没有份额明细"}, 404)
                    return
                self._json(detail)
            except Exception as exc:
                self._json({"error": f"读取份额明细失败：{type(exc).__name__}: {exc}"}, 500)
            return
        if parsed.path == "/api/pool-stats":
            try:
                days = int((parse_qs(parsed.query).get("days") or ["20"])[0])
            except ValueError:
                days = 20
            days = min(max(days, 1), 240)
            try:
                self._json({"days": days, "rows": load_pool_statistics(days)})
            except Exception as exc:
                self._json({"error": f"读取汪汪队统计数据失败：{type(exc).__name__}: {exc}"}, 500)
            return
        if parsed.path == "/api/health":
            self._json({"ok": True, "time": datetime.now(TZ).isoformat(timespec="seconds")})
            return
        if parsed.path == "/api/live-flow":
            try:
                self._json(fetch_live_flow())
            except Exception as exc:
                self._json({"error": f"实时买卖估算暂不可用：{type(exc).__name__}: {exc}"}, 502)
            return

        relative = "index.html" if parsed.path in ("", "/") else parsed.path.lstrip("/")
        target = (STATIC_DIR / relative).resolve()
        if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        content_type, _ = mimetypes.guess_type(str(target))
        if target.suffix == ".js":
            content_type = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", (content_type or "application/octet-stream") + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/update":
            self.send_error(404)
            return
        result = update_once()
        self._json(result, 200 if result.get("status") != "failed" else 502)


def _next_close_run(now: datetime) -> datetime:
    target = now.replace(hour=18, minute=45, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    return target


def _scheduler() -> None:
    while True:
        now = datetime.now(TZ)
        target = _next_close_run(now)
        wait_seconds = max(1, (target - now).total_seconds())
        print(f"本地自动更新已安排：{target.strftime('%Y-%m-%d %H:%M')} Asia/Shanghai")
        time.sleep(wait_seconds)
        result = update_once()
        print(f"定时更新：{result.get('status')} · {result.get('message')}")


def main() -> None:
    seeded = initialize_db()
    print("SQLite 初始化完成" + ("，已导入参考历史" if seeded else "，沿用现有数据库"))
    threading.Thread(target=_scheduler, name="etf-close-scheduler", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"汪汪队ETF跟踪器：http://{HOST}:{PORT}")
    print("本地服务运行期间会在交易日收盘后尝试更新；按 Ctrl+C 停止。")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
