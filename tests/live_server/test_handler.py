from email.message import Message
from io import BytesIO
import unittest

from live_player.server.app import Response
from live_player.server.handler import serve


class HandlerTest(unittest.TestCase):
    def test_streamed_response_keeps_explicit_content_length(self):
        stream = BytesIO(b"media")

        class Application:
            def handle(self, method, path, headers, body):
                return Response(200, {"Content-Length": "5"}, body_iter=stream)

        class RecordingWriter:
            def __init__(self):
                self.parts = []

            def write(self, value):
                self.parts.append(value)
                return len(value)

        server = serve(Application())
        try:
            handler = server.RequestHandlerClass.__new__(server.RequestHandlerClass)
            handler.server = server
            handler.command = "GET"
            handler.path = "/media/opaque"
            handler.request_version = "HTTP/1.1"
            handler.requestline = "GET /media/opaque HTTP/1.1"
            handler.headers = Message()
            handler.headers["Host"] = "127.0.0.1:" + str(server.server_address[1])
            handler.rfile = BytesIO()
            handler.wfile = RecordingWriter()
            handler.do_GET()
            payload = b"".join(handler.wfile.parts)
            self.assertIn(b"Content-Length: 5\r\n", payload)
            self.assertIn(b"media", payload)
            self.assertTrue(stream.closed)
        finally:
            server.server_close()
            stream.close()

    def test_header_write_failure_closes_stream(self):
        stream = BytesIO(b"media")

        class Application:
            def handle(self, method, path, headers, body):
                return Response(200, {}, body_iter=stream)

        class DisconnectedWriter:
            def write(self, value):
                raise BrokenPipeError("client disconnected")

        server = serve(Application())
        try:
            handler = server.RequestHandlerClass.__new__(server.RequestHandlerClass)
            handler.server = server
            handler.command = "GET"
            handler.path = "/media/opaque"
            handler.request_version = "HTTP/1.1"
            handler.requestline = "GET /media/opaque HTTP/1.1"
            handler.headers = Message()
            handler.headers["Host"] = "127.0.0.1:" + str(server.server_address[1])
            handler.rfile = BytesIO()
            handler.wfile = DisconnectedWriter()
            with self.assertRaises(BrokenPipeError):
                handler.do_GET()
            self.assertTrue(stream.closed)
        finally:
            server.server_close()
            stream.close()
