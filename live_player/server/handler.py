"""Bounded HTTP requests on a numeric loopback address, without request logs."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .app import _error

PAGES_ORIGIN = "https://johnxmj.github.io"


def serve(application, host="127.0.0.1", port=0):
    """Return a bound server. The caller owns serve_forever/shutdown/server_close."""
    if host != "127.0.0.1":
        raise ValueError("server host must be exactly 127.0.0.1")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, format, *args):
            pass  # Paths and headers may contain tokens; never log them.

        def _dispatch(self):
            bound_host, bound_port = self.server.server_address[:2]
            authority = f"{bound_host}:{bound_port}"
            allowed = {authority, f"localhost:{bound_port}"}
            hosts = self.headers.get_all("Host", [])
            origins = self.headers.get_all("Origin", [])
            origin = origins[0] if len(origins) == 1 else None
            origin_ok = not origins or origin == PAGES_ORIGIN or (
                len(hosts) == 1 and origin == "http://" + hosts[0]
            )
            if len(hosts) != 1 or hosts[0] not in allowed or len(origins) > 1 or not origin_ok:
                response = _error(403, "LOGIN_REQUIRED", "Local origin required")
            elif self.command == "OPTIONS":
                from .app import Response
                response = Response(204, {})
            elif self.headers.get_all("Transfer-Encoding"):
                response = _error(400, "UPSTREAM_FAILED", "Unsupported request framing")
            else:
                try:
                    lengths = self.headers.get_all("Content-Length", ["0"])
                    if len(lengths) != 1:
                        raise ValueError
                    length = int(lengths[0])
                    if length < 0 or length > 8192:
                        raise ValueError
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError
                    if len(self.headers.get_all("Authorization", [])) > 1:
                        raise ValueError
                    response = application.handle(self.command, self.path, dict(self.headers), body)
                except Exception:
                    response = _error(400, "UPSTREAM_FAILED", "Invalid local request")
            self.close_connection = True
            try:
                self.send_response(response.status)
                for key, value in response.headers.items():
                    if key.lower() not in {"cache-control", "connection"}:
                        self.send_header(key, value)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                if origin == PAGES_ORIGIN:
                    self.send_header("Access-Control-Allow-Origin", PAGES_ORIGIN)
                    self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                    self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                    self.send_header("Access-Control-Allow-Private-Network", "true")
                    self.send_header("Vary", "Origin")
                self.send_header("Connection", "close")
                if response.body_iter is None:
                    self.send_header("Content-Length", str(len(response.body)))
                self.end_headers()
                if self.command != "HEAD":
                    if response.body_iter is None:
                        self.wfile.write(response.body)
                    else:
                        for chunk in response.body_iter:
                            self.wfile.write(chunk)
            finally:
                close = getattr(response.body_iter, "close", None)
                if close is not None:
                    close()

        do_GET = do_POST = do_HEAD = do_OPTIONS = do_PUT = do_DELETE = do_PATCH = _dispatch

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            pass  # A streaming exception must not dump upstream URLs or cookies.

    return Server((host, port), Handler)
