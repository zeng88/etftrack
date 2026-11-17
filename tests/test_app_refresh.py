import io
import json
import unittest
from unittest.mock import patch

from app import Handler
from collector import fetch_quotes


class RealtimeRefreshTests(unittest.TestCase):
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
