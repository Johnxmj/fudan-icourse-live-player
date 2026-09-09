from email.message import Message
from io import BytesIO
import json
import unittest

from live_player.server.app import LiveApplication, Response
from live_player.server.handler import serve


class PagesPairingTest(unittest.TestCase):
    def options(self, origin, private_network=False):
        class Application:
            def handle(self, method, path, headers, body):
                return Response(404, {})
        server = serve(Application())
        try:
            handler = server.RequestHandlerClass.__new__(server.RequestHandlerClass)
            handler.server = server
            handler.command = "OPTIONS"
            handler.path = "/api/session"
            handler.request_version = "HTTP/1.1"
            handler.requestline = "OPTIONS /api/session HTTP/1.1"
            handler.headers = Message()
            handler.headers["Host"] = "127.0.0.1:" + str(server.server_address[1])
            handler.headers["Origin"] = origin
            if private_network:
                handler.headers["Access-Control-Request-Private-Network"] = "true"
            handler.rfile = BytesIO()
            handler.wfile = BytesIO()
            handler.do_OPTIONS()
            raw = handler.wfile.getvalue().decode("iso-8859-1")
            _, headers = raw.split("\r\n", 1)
            message = Message()
            for line in headers.split("\r\n"):
                if ": " in line:
                    key, value = line.split(": ", 1)
                    message[key] = value
            return type("Result", (), {"status": int(raw.split(" ", 2)[1]), "headers": message})
        finally:
            server.server_close()

    def test_pages_origin_is_allowed_only_for_pairing(self):
        response = self.options("https://johnxmj.github.io", private_network=True)
        self.assertEqual(response.status, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://johnxmj.github.io")
        self.assertEqual(response.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS")
        self.assertEqual(response.headers["Access-Control-Allow-Headers"], "Authorization, Content-Type")
        self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(response.headers["Vary"], "Origin")

    def test_other_origin_gets_no_cors_headers(self):
        response = self.options("https://evil.invalid", private_network=True)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        self.assertNotIn("Access-Control-Allow-Methods", response.headers)
        self.assertNotIn("Access-Control-Allow-Headers", response.headers)
        self.assertNotIn("Vary", response.headers)

    def test_missing_host_is_rejected_without_index_error(self):
        class Application:
            def handle(self, method, path, headers, body):
                return Response(404, {})

        server = serve(Application())
        try:
            handler = server.RequestHandlerClass.__new__(server.RequestHandlerClass)
            handler.server = server
            handler.command = "OPTIONS"
            handler.path = "/api/session"
            handler.request_version = "HTTP/1.1"
            handler.requestline = "OPTIONS /api/session HTTP/1.1"
            handler.headers = Message()
            handler.headers["Origin"] = "https://johnxmj.github.io"
            handler.rfile = BytesIO()
            handler.wfile = BytesIO()
            handler.do_OPTIONS()
            raw = handler.wfile.getvalue().decode("iso-8859-1")
            self.assertIn("403", raw.split("\r\n", 1)[0])
        finally:
            server.server_close()

    def test_bootstrap_exchange_is_one_use(self):
        app = LiveApplication(object())
        token = app.issue_bootstrap_token()
        body = json.dumps({"bootstrap_token": token}).encode()
        self.assertEqual(app.handle("POST", "/api/session", {}, body).status, 200)
        self.assertEqual(app.handle("POST", "/api/session", {}, body).status, 401)
