from email.message import Message
from io import BytesIO
import unittest

from live_player.server.app import Response
from live_player.server.handler import serve


class HandlerTest(unittest.TestCase):
    def test_serve_records_the_actual_numeric_loopback_authority(self):
        class Application:
            def __init__(self):
                self.authorities = []

            def set_loopback_authority(self, authority):
                self.authorities.append(authority)

            def handle(self, method, path, headers, body):
                raise AssertionError("request handling is not needed")

        application = Application()
        server = serve(application)
        try:
            self.assertEqual(application.authorities, ["127.0.0.1:" + str(server.server_address[1])])
        finally:
            server.server_close()

    def test_streamed_response_omits_content_length_and_flushes_each_chunk(self):
        stream = BytesIO(b"media")

        class Application:
            def handle(self, method, path, headers, body):
                return Response(200, {"Content-Length": "5"}, body_iter=stream)

        class RecordingWriter:
            def __init__(self):
                self.parts = []
                self.flushes = 0

            def write(self, value):
                self.parts.append(value)
                return len(value)

            def flush(self):
                self.flushes += 1

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
            self.assertNotIn(b"Content-Length:", payload)
            self.assertIn(b"media", payload)
            self.assertEqual(handler.wfile.flushes, 1)
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
