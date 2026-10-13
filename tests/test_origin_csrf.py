"""hdash P3: every non-GET request passes Host, Origin, Sec-Fetch-Site, the CSRF token, JSON type and a size bound
before any write route is looked up; a cross-origin GET is refused too."""
import http.client
import importlib.machinery
import importlib.util
import json
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)

TOKEN = "t" * 43
LAUNCH = "l" * 43


@pytest.fixture
def srv():
    seen = []

    def echo(obj):
        seen.append(obj)
        return 200, {"ok": True}

    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), {}, {"echo": echo})
    server = hdash.make_server(gw, 0)
    port = server.server_address[1]
    server.RequestHandlerClass = hdash.make_handler(gw, port, csrf_token=TOKEN, launch_token=LAUNCH)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield port, seen
    server.shutdown()
    server.server_close()


def req(port, method="POST", path="/api/echo", body=b'{"a": 1}', headers=None, host=None):
    h = {"Host": host or f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", hdash.CSRF_HEADER: TOKEN,
         "Content-Type": "application/json"}
    h.update(headers or {})
    h = {k: v for k, v in h.items() if v is not None}
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        return r.status, r.read()
    finally:
        c.close()


def test_a_write_with_everything_right_reaches_the_route(srv):
    port, seen = srv
    assert req(port)[0] == 200 and seen == [{"a": 1}]


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_every_mutating_method_is_guarded(srv, method):
    port, seen = srv
    assert req(port, method)[0] == 200
    assert req(port, method, headers={hdash.CSRF_HEADER: None})[0] == 403
    assert req(port, method, headers={"Origin": None})[0] == 403
    assert len(seen) == 1


@pytest.mark.parametrize("hdrs", [
    {"Origin": "http://evil.example"}, {"Origin": "null"}, {"Origin": "https://127.0.0.1"},
    {"Origin": "http://127.0.0.1:1"}, {"Origin": None}, {"Sec-Fetch-Site": "cross-site"},
    {"Sec-Fetch-Site": "same-site"}, {"Sec-Fetch-Site": "none"},
    {hdash.CSRF_HEADER: None}, {hdash.CSRF_HEADER: ""}, {hdash.CSRF_HEADER: "x" * 43}, {hdash.CSRF_HEADER: TOKEN + "x"},
    {hdash.CSRF_HEADER: TOKEN[:-1]}, {hdash.CSRF_HEADER: TOKEN[:1]},
])
def test_a_write_failing_any_check_never_reaches_the_route(srv, hdrs):
    port, seen = srv
    assert req(port, headers=hdrs)[0] == 403 and not seen


def test_foreign_host_is_refused_even_with_a_good_token(srv):
    port, seen = srv
    assert req(port, host="evil.example")[0] == 403 and not seen


def test_content_type_size_and_json_shape(srv):
    port, seen = srv
    assert req(port, headers={"Content-Type": "text/plain"})[0] == 415
    assert req(port, headers={"Content-Type": None})[0] == 415
    assert req(port, body=b"x" * (hdash.MAX_BODY + 1))[0] == 413
    assert req(port, body=b"not json")[0] == 400
    assert req(port, body=b"[1]")[0] == 400
    assert req(port, headers={"Content-Type": "Application/JSON; charset=utf-8"})[0] == 200
    assert len(seen) == 1


def test_unknown_write_route_is_405_only_after_the_guard(srv):
    port, _ = srv
    assert req(port, path="/api/nope")[0] == 405
    assert req(port, path="/api/nope", headers={"Origin": None})[0] == 403
    assert req(port, path="/elsewhere")[0] == 404


def test_a_refused_write_closes_the_connection_so_its_body_is_not_a_second_request(srv):
    port, _ = srv
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    smuggled = b"GET /api/overview HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    c.request("POST", "/api/echo", body=smuggled, headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
    r = c.getresponse()
    assert r.status == 403 and r.getheader("Connection", "").lower() == "close"
    r.read()
    c.close()


def test_reads_are_refused_from_a_foreign_origin_and_allowed_without_one(srv):
    port, _ = srv
    assert req(port, "GET", "/api/overview", None, {"Origin": "http://evil.example"})[0] == 403
    assert req(port, "GET", "/api/overview", None, {"Origin": None, hdash.CSRF_HEADER: None})[0] == 200
    assert req(port, "GET", "/api/overview", None, {"Sec-Fetch-Site": "cross-site"})[0] == 403
    assert req(port, "GET", "/api/overview", None, {"Sec-Fetch-Site": "same-origin"})[0] == 200
    assert req(port, "GET", "/", None, {"Sec-Fetch-Site": "none", "Origin": None})[0] == 200


def test_csrf_token_is_served_to_the_page_only(srv):
    port, _ = srv
    lh = {hdash.LAUNCH_HEADER: LAUNCH}
    code, body = req(port, "GET", hdash.CSRF_ROUTE, None, {"Origin": None, **lh})
    assert code == 200 and json.loads(body) == {"token": TOKEN}
    assert req(port, "GET", hdash.CSRF_ROUTE, None, {"Origin": "http://evil.example", **lh})[0] == 403
    assert req(port, "GET", hdash.CSRF_ROUTE, None, lh, host="evil.example")[0] == 403


def test_options_is_never_a_cors_yes(srv):
    port, _ = srv
    code, _ = req(port, "OPTIONS", "/api/echo", None)
    assert code == 405


def _serve(handler_factory_gw):
    server = hdash.make_server(handler_factory_gw, 0)
    port = server.server_address[1]
    server.RequestHandlerClass = hdash.make_handler(handler_factory_gw, port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def test_each_server_makes_its_own_token():
    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}))
    servers = [_serve(gw) for _ in range(2)]
    try:
        tokens = []
        for _, port in servers:
            code, body = req(port, "GET", hdash.CSRF_ROUTE, None, {"Origin": None})
            assert code == 200
            tokens.append(json.loads(body)["token"])
        assert tokens[0] != tokens[1] and all(len(t) >= 32 for t in tokens)
    finally:
        for server, _ in servers:
            server.shutdown()
            server.server_close()


def test_write_is_503_when_every_slot_is_busy_and_recovers():
    gate, entered = threading.Event(), threading.Semaphore(0)

    def slow(obj):
        entered.release()
        gate.wait(10)
        return 200, {"ok": True}

    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), {}, {"slow": slow})
    server = hdash.make_server(gw, 0)
    port = server.server_address[1]
    server.RequestHandlerClass = hdash.make_handler(gw, port, csrf_token=TOKEN)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    workers = [threading.Thread(target=lambda: results.append(req(port, path="/api/slow")[0]))
               for _ in range(hdash.MAX_CONCURRENT)]
    try:
        for w in workers:
            w.start()
        for _ in workers:
            assert entered.acquire(timeout=5)
        assert req(port, path="/api/slow")[0] == 503
        assert req(port, "GET", "/api/overview", None)[0] == 503
    finally:
        gate.set()
        for w in workers:
            w.join(10)
        # the 200 is sent before the slot is released, so poll for recovery
        deadline = time.monotonic() + 2
        recovered = req(port, path="/api/slow")[0]
        while recovered != 200 and time.monotonic() < deadline:
            time.sleep(0.02)
            recovered = req(port, path="/api/slow")[0]
        server.shutdown()
        server.server_close()
    assert results == [200] * hdash.MAX_CONCURRENT
    assert recovered == 200
