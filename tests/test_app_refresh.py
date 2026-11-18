import io
import json
import unittest
from unittest.mock import patch
from datetime import datetime
from zoneinfo import ZoneInfo

from app import Handler, _next_scheduled_run
from collector import fetch_quotes
from storage import has_usable_share_coverage


class RealtimeRefreshTests(unittest.TestCase):
    def test_scheduler_retries_official_shares_multiple_times_next_day(self):
        target, task_name = _next_scheduled_run(
            datetime(2026, 11, 18, 8, 31, tzinfo=ZoneInfo("Asia/Shanghai"))
        )
        self.assertEqual(target.strftime("%Y-%m-%d %H:%M"), "2026-11-18 13:30")
        self.assertEqual(task_name, "份额补采")

    def test_one_or_two_missing_funds_are_labelled_as_usable_partial_coverage(self):
        self.assertTrue(has_usable_share_coverage(34, 33))
        self.assertTrue(has_usable_share_coverage(34, 32))
        self.assertFalse(has_usable_share_coverage(34, 31))

    def test_tencent_quote_url_has_one_q_parameter(self):
        captured = []
        with patch("collector._https_get", side_effect=lambda url: captured.append(url) or b'v_sh510300="~test~0~4~3~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261117150000~0~0~0~0~0~0~100000~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0";'):
            fetch_quotes([{"code": "510300", "tcode": "sh510300"}])
        self.assertEqual(captured, ["https://qt.gtimg.cn/q=sh510300"])

    def test_live_turnover_route_uses_public_curve_api_without_running_storage_collector(self):
        handler = Handler.__new__(Handler)
        handler.path = "/api/live-turnover"
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "status", status)
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None
        handler.send_error = lambda status: setattr(handler, "status", status)

        with patch("app.fetch_live_turnover_comparison", return_value={"date": "20261117", "comparison_count": 9}) as curve_api, \
             patch("app.update_once") as storage_collector:
            handler.do_GET()

        payload = json.loads(handler.wfile.getvalue())
        self.assertEqual(handler.status, 200)
        self.assertEqual(payload["comparison_count"], 9)
        curve_api.assert_called_once_with()
        storage_collector.assert_not_called()

    def test_manual_refresh_uses_public_quote_api_without_running_storage_collector(self):
        handler = Handler.__new__(Handler)
        handler.path = "/api/update"
        handler.wfile = io.BytesIO()
        handler.send_response = lambda status: setattr(handler, "status", status)
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None

        with patch("app.fetch_live_flow", return_value={"time": "20261116150000"}) as quote_api, \
             patch("app.update_once") as storage_collector:
            handler.do_POST()

        payload = json.loads(handler.wfile.getvalue())
        self.assertEqual(handler.status, 200)
        self.assertEqual(payload["live_flow"]["time"], "20261116150000")
        quote_api.assert_called_once_with()
        storage_collector.assert_not_called()


if __name__ == "__main__":
    unittest.main()
