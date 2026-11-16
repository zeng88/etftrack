import io
import json
import unittest
from unittest.mock import patch

from app import Handler


class RealtimeRefreshTests(unittest.TestCase):
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
