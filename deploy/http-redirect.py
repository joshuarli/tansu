import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit


class RedirectHandler(BaseHTTPRequestHandler):
    def redirect(self):
        self.send_response(308)
        self.send_header("Location", f"{self.server.origin}{self.path}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = redirect
    do_HEAD = redirect
    do_POST = redirect
    do_PUT = redirect
    do_PATCH = redirect
    do_DELETE = redirect
    do_OPTIONS = redirect


origin = os.environ["TANSU2_REDIRECT_ORIGIN"]
parsed_origin = urlsplit(origin)
if parsed_origin.scheme != "https" or not parsed_origin.netloc or parsed_origin.path:
    raise ValueError("TANSU2_REDIRECT_ORIGIN must be an HTTPS origin")

server = HTTPServer(("127.0.0.1", 3002), RedirectHandler)
server.origin = origin
server.serve_forever()
