"""hdash 4.x P4: the viewer listener (read-only, allowlisted tailnet logins) and the `share` / `unshare` / `viewers` / doctor verbs.

The listener's gate is its own: a request from 127.0.0.1 with no identity header is a 403 whatever the node's sync mode, only a
GET of a path in the read-only subset by a listed login is answered, and its budget is not the operator listener's."""
import http.client
import importlib.machinery
import importlib.util
import inspect
import json
import re
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)

LOGIN = "alice@example.com"
SUBSET = ["/", "/index.html", "/dashboard", "/dashboard/", "/logo.svg", "/favicon.svg", "/api/overview", "/api/search?q=x&limit=5",
          "/api/tags", "/api/related?kind=fact&id=1", "/api/item?sid=h:abc", "/api/audit", "/api/peers?probe=0",
          "/api/config/records", "/api/verify"]
REFUSED = ["/api/telemetry", "/api/status", "/api/daemon", "/api/entities", "/api/modules", "/api/module?name=x", "/api/workspace?name=agents",
           "/api/settings", "/api/csrf", "/api/overview?node=abc", "/api/overview?Node=abc", "/api/overview?node=",
           "/api/search?q=x&node=abc", "/api/search?q=a&q=b", "/api/nope", "/../etc/passwd", "/sync/hello"]


class FakeGateway:
    def __init__(self):
        self.calls = []

    def route(self, name, query):
        self.calls.append((name, query))
        return 200, {"route": name, "query": query}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write_peers(path, **kw):
    cfg = {"dashboard_share": True, "dashboard_viewers": [LOGIN], **kw}
    path.write_text(json.dumps(cfg))


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HIVE_HOME", str(tmp_path))
    monkeypatch.delenv("HIVE_MODULE_PORT", raising=False)
    write_peers(tmp_path / ".peers.json")
    return tmp_path


SERVE_HOST = "device.tail1234.ts.net:8443"


def start(home, gw=None, records=None, limiter=None, slots=None):
    gw = gw or FakeGateway()
    backend = hdash.ViewerBackend(gw, records=records or (lambda: (200, {"schema": 1, "keys": []})))
    settings = hdash.SettingsCache(path_fn=lambda: home / ".peers.json")
    server = hdash.ViewerServer(0, hdash.make_viewer_handler(backend, settings, limiter, slots, hosts=lambda: {SERVE_HOST}))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, backend, gw


@pytest.fixture
def viewer(home):
    server, backend, gw = start(home)
    yield server.server_address[1], backend, gw
    server.shutdown()
    server.server_close()


def req(port, path="/", method="GET", login=LOGIN, headers=None, body=None):
    h = {"Host": SERVE_HOST}
    if login is not None:
        h[hdash.LOGIN_HEADER] = login
    h.update(headers or {})
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        return r.status, data
    finally:
        c.close()


def jbody(data):
    try:
        return json.loads(data)
    except ValueError:
        return None


# ── the gate ──────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", SUBSET)
def test_a_listed_login_gets_every_path_of_the_subset(viewer, path):
    port, _, _ = viewer
    assert req(port, path)[0] == 200, path


@pytest.mark.parametrize("path", REFUSED)
def test_a_listed_login_is_refused_everything_outside_the_subset(viewer, path):
    port, _, gw = viewer
    status, data = req(port, path)
    assert status == 403 and jbody(data)["listener"] == "viewer", path
    assert gw.calls == []                                    # nothing reached the core


def test_no_identity_header_is_403_even_though_the_source_is_loopback_and_sync_auth_off_does_not_open_it(viewer, home):
    port, _, gw = viewer
    status, data = req(port, "/", login=None)
    assert status == 403 and jbody(data) == {"listener": "viewer", "error": "forbidden"}
    write_peers(home / ".peers.json", sync_auth="off")       # the mode that opens the daemon's `_local_or_signed`
    assert req(port, "/api/overview", login=None)[0] == 403 and gw.calls == []


@pytest.mark.parametrize("login", ["", "  ", "mallory@example.com", "alice@example.com.evil", "alice", "x" * 300,
                                   "alice@example.com\x00", "alice @example.com"])
def test_a_login_that_is_not_on_the_list_is_403(viewer, login):
    port, _, _ = viewer
    assert req(port, "/", login=login)[0] == 403


def test_the_allowlist_match_is_case_insensitive_both_ways(home):
    write_peers(home / ".peers.json", dashboard_viewers=["Alice@Example.COM"])
    server, _, _ = start(home)
    port = server.server_address[1]
    try:
        for login in ("alice@example.com", "ALICE@EXAMPLE.COM", "aLiCe@ExAmPlE.cOm"):
            assert req(port, "/api/overview", login=login)[0] == 200, login
    finally:
        server.shutdown()
        server.server_close()


def test_two_login_headers_or_a_funnel_marker_are_refused(viewer):
    port, _, _ = viewer
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    c.putrequest("GET", "/", skip_host=True)
    c.putheader("Host", f"127.0.0.1:{port}")
    c.putheader(hdash.LOGIN_HEADER, LOGIN)
    c.putheader(hdash.LOGIN_HEADER, "mallory@example.com")
    c.endheaders()
    assert c.getresponse().status == 403
    c.close()
    assert req(port, "/", headers={hdash.FUNNEL_HEADER: "?1"})[0] == 403


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
def test_every_method_but_get_is_403_and_settings_is_unreachable(viewer, method):
    port, _, gw = viewer
    assert req(port, "/api/overview", method)[0] == 403
    assert req(port, "/api/settings", method, body=b"{}", headers={"Content-Type": "application/json"})[0] == 403
    assert gw.calls == []


def test_a_get_with_a_body_is_refused(viewer):
    port, _, _ = viewer
    assert req(port, "/api/overview", body=b"x")[0] == 403


def test_sharing_off_or_a_login_removed_closes_the_listener_on_the_next_request(viewer, home):
    port, _, _ = viewer
    assert req(port, "/")[0] == 200
    write_peers(home / ".peers.json", dashboard_viewers=["bob@example.com"])
    assert req(port, "/")[0] == 403
    write_peers(home / ".peers.json", dashboard_share=False)
    assert req(port, "/", login="bob@example.com")[0] == 403
    (home / ".peers.json").unlink()
    assert req(port, "/")[0] == 403                           # an unreadable node file fails closed


def test_the_viewer_handler_has_one_authorization_path_and_no_source_address(home):
    handler = hdash.make_viewer_handler(hdash.ViewerBackend(FakeGateway()), hdash.SettingsCache(path_fn=lambda: home / ".peers.json"))
    operator = hdash.make_handler(hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {})), 1)
    assert not issubclass(handler, operator) and not issubclass(operator, handler)
    src = inspect.getsource(hdash.make_viewer_handler)
    for forbidden in ("client_address", "LOOPBACK", "_is_loopback", "_local_or_signed"):
        assert forbidden not in src, forbidden
    assert "do_POST" in src and "= _handle" in src             # the only entry is the gate


@pytest.mark.parametrize("host", ["evil.example:8443", "evil.example", "127.0.0.1:{port}", "localhost", "device.tail1234.ts.net",
                                  "device.tail1234.ts.net:9906", "", "device.tail1234.ts.net:8443.evil.example"])
def test_a_host_other_than_the_serve_host_gets_the_signature_403(viewer, host):
    port = viewer[0]
    code, data = req(port, "/api/search?q=x", headers={"Host": host.format(port=port)})
    assert code == 403 and jbody(data)["listener"] == "viewer"


def test_the_serve_host_is_case_insensitive_and_the_default_source_fails_closed(home):
    port = start(home)[0].server_address[1]
    assert req(port, "/", headers={"Host": SERVE_HOST.upper()})[0] == 200
    def boom(args):
        raise RuntimeError("no tailscale")
    assert hdash.ServeHosts(tsj=boom)() == frozenset()
    status = {"Self": {"DNSName": "Device.tail1234.ts.net.", "UserID": 1}, "User": {}}
    assert hdash.ServeHosts(tsj=lambda a: status)() == {"device.tail1234.ts.net:8443"}


def test_serve_hosts_retries_a_failed_lookup_soon_and_keeps_a_good_one():
    now, calls = [0.0], []
    def tsj(a):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("down")
        return {"Self": {"DNSName": "d.ts.net."}, "User": {}}
    h = hdash.ServeHosts(tsj=tsj, ttl=300, retry=5, clock=lambda: now[0])
    assert h() == frozenset() and h() == frozenset() and len(calls) == 1
    now[0] = 6
    assert h() == {"d.ts.net:8443"}
    now[0] = 200
    assert h() == {"d.ts.net:8443"} and len(calls) == 2


# ── what it serves, and what reaches the core ─────────────────────────────────────────────────────────────────────────

def test_only_a_routes_own_parameters_reach_the_core_and_peers_never_probe(viewer):
    port, _, gw = viewer
    assert req(port, "/api/search?q=hello&limit=5&status=all")[0] == 200
    assert req(port, "/api/peers?probe=1")[0] == 200 and req(port, "/api/peers")[0] == 200
    assert gw.calls[0] == ("search", "limit=5&q=hello&status=all")
    assert all(c == ("peers", "probe=0") for c in gw.calls[1:])
    assert not any("node" in q for _, q in gw.calls)


def test_an_upstream_failure_shows_a_viewer_nothing_of_the_cause(home):
    class Down(FakeGateway):
        def route(self, name, query):
            return 502, {"error": "sync daemon unavailable: [Errno 111] 127.0.0.1:9876 /home/me/.hive"}

    server, _, _ = start(home, Down())
    try:
        status, data = req(server.server_address[1], "/api/overview")
        assert status == 502 and jbody(data) == {"error": "unavailable"} and b"9876" not in data
    finally:
        server.shutdown()
        server.server_close()


def test_a_repeated_read_is_answered_from_the_cache(viewer):
    port, backend, gw = viewer
    for _ in range(5):
        assert req(port, "/api/overview")[0] == 200
    assert len(gw.calls) == 1 and backend.calls == 1


HCONFIG = [
    {"id": "core:quorum_m", "class": "governed", "visibility": "viewer", "secret": False, "identifying": False, "type": "int",
     "default": 2, "value": 3, "source": "fleet", "description": "quorum", "set_by": {"device_id": "d1", "ts": 1, "sid": "h:1"},
     "write_via": "hive-mind config set quorum_m <value>", "writable_by": "owner", "warnings": ["w"], "env": None, "set": True},
    {"id": "core:owner_name", "class": "governed", "visibility": "operator", "secret": False, "identifying": True, "type": "string", "value": "me"},
    {"id": "node:dashboard_viewers", "class": "node", "visibility": "operator", "secret": False, "identifying": False, "value": [LOGIN]},
    {"id": "node:x", "class": "governed", "visibility": "viewer", "secret": False, "identifying": False, "value": 1},     # a node: key, whatever its label
    {"id": "x-m:token", "class": "module", "visibility": "viewer", "secret": True, "identifying": False, "value": "********"},
    {"id": "x-m:who", "class": "module", "visibility": "viewer", "secret": False, "identifying": True, "value": "me"},
    {"id": "x-m:level", "class": "module", "visibility": "viewer", "secret": False, "identifying": False, "type": "string", "value": "hi",
     "default": "lo", "source": "node", "set_by": None, "write_via": "hive-mind module config m set level"},
    {"id": "x-m:operator", "class": "module", "visibility": "operator", "secret": False, "identifying": False, "value": "no"},
    {"id": "x-m:nolabel", "class": "module", "visibility": "viewer", "value": "no"},                                        # secret/identifying missing
    "not a record", {"id": 5},
]


def test_a_viewer_gets_the_viewer_records_and_only_their_viewer_fields(home, monkeypatch):
    monkeypatch.setattr(hdash, "run_hconfig", lambda args, stdin_text=None, timeout=0: (0, {"ok": True, "keys": HCONFIG, "governance": {"owner_id": "o"}}))
    server, _, _ = start(home, records=hdash.viewer_records)
    port = server.server_address[1]
    try:
        status, data = req(port, "/api/config/records")
        doc = jbody(data)
        assert status == 200 and [k["id"] for k in doc["keys"]] == ["core:quorum_m", "x-m:level"]
        assert set(doc["keys"][0]) <= set(hdash.VIEWER_RECORD_FIELDS)
        for leaked in ("set_by", "write_via", "writable_by", "warnings", "env", "governance", "dashboard_viewers", "d1", LOGIN, "token", "owner"):
            assert leaked not in data.decode(), leaked
        assert req(port, "/api/config/records", "POST", body=b"{}")[0] == 403
        assert req(port, "/api/config/records?node=x")[0] in (200, 403)     # no parameter is read from it
    finally:
        server.shutdown()
        server.server_close()


def test_hconfig_failing_gives_a_bare_502(home, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("hconfig is not installed on /home/me")
    monkeypatch.setattr(hdash, "run_hconfig", boom)
    server, _, _ = start(home, records=hdash.viewer_records)
    try:
        status, data = req(server.server_address[1], "/api/config/records")
        assert status == 502 and b"/home" not in data
    finally:
        server.shutdown()
        server.server_close()


def test_the_operator_listener_ignores_identity_headers(home):
    gw = FakeGateway()
    op = hdash.make_server(hdash.Gateway(lambda p, q: (200, {"v1": p}), lambda p, q: (200, {"d": p})), 0)
    port = op.server_address[1]
    op.RequestHandlerClass = hdash.make_handler(hdash.Gateway(lambda p, q: (200, {"v1": p}), lambda p, q: (200, {"d": p})), port)
    threading.Thread(target=op.serve_forever, daemon=True).start()
    try:
        same = req(port, "/api/overview", login=None, headers={"Host": f"127.0.0.1:{port}"})
        assert same[0] == 200
        for hdrs in ({hdash.LOGIN_HEADER: "mallory@example.com"}, {"Tailscale-User-Name": "x"}):
            assert req(port, "/api/overview", login=None, headers={"Host": f"127.0.0.1:{port}", **hdrs}) == same
        assert req(port, "/", login="mallory@example.com", headers={"Host": f"127.0.0.1:{port}"})[0] == 200       # a local caller keeps operator access, unchanged
    finally:
        op.shutdown()
        op.server_close()


# ── its own budget ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_viewer_flood_is_throttled_and_moves_nothing_onto_the_operator_listeners_budget(home):
    vgw, ogw = FakeGateway(), FakeGateway()
    server, backend, _ = start(home, vgw, limiter=hdash.KeyedLimiter(40, 5.0))
    op = hdash.make_server(ogw, 0)
    oport = op.server_address[1]
    op.RequestHandlerClass = hdash.make_handler(ogw, oport)
    threading.Thread(target=op.serve_forever, daemon=True).start()
    port = server.server_address[1]
    try:
        t0 = time.monotonic()
        with ThreadPoolExecutor(16) as pool:
            flood = [pool.submit(req, port, f"/api/search?q=n{i}") for i in range(300)]
            op_status = [req(oport, "/api/overview", login=None, headers={"Host": f"127.0.0.1:{oport}"})[0] for _ in range(5)]
            codes = [f.result()[0] for f in flood]
        elapsed = time.monotonic() - t0
        assert op_status == [200] * 5 and len(ogw.calls) == 5                      # the operator was not touched by the flood
        assert codes.count(429) + codes.count(503) > 100 and codes.count(200) >= 1
        bound = hdash.VIEWER_UPSTREAM[0] + hdash.VIEWER_UPSTREAM[1] * elapsed + 1
        assert backend.calls == len(vgw.calls) <= bound, (backend.calls, bound)   # the core saw no more than the call budget
    finally:
        for s in (server, op):
            s.shutdown()
            s.server_close()


def test_unidentified_traffic_shares_one_bucket_and_is_charged_before_the_refusal(home):
    server, _, gw = start(home, limiter=hdash.KeyedLimiter(3, 0.001))
    port = server.server_address[1]
    try:
        codes = [req(port, "/", login=None)[0] for _ in range(6)]
        assert codes == [403, 403, 403, 429, 429, 429]
        assert req(port, "/")[0] == 200                       # a listed login has a bucket of its own
    finally:
        server.shutdown()
        server.server_close()


def test_the_viewer_slots_are_their_own_and_a_full_set_is_503(home):
    slots = threading.BoundedSemaphore(1)
    server, _, _ = start(home, slots=slots)
    port = server.server_address[1]
    try:
        assert slots.acquire(blocking=False)
        assert req(port, "/")[0] == 503
        slots.release()
        assert req(port, "/")[0] == 200
    finally:
        server.shutdown()
        server.server_close()


def test_the_limiter_and_bucket_refill_and_bound_their_keys():
    now = [0.0]
    lim = hdash.KeyedLimiter(2, 1.0, max_keys=2, clock=lambda: now[0])
    assert [lim.allow("a") for _ in range(3)] == [True, True, False]
    now[0] = 1.0
    assert lim.allow("a") and not lim.allow("a")
    lim.allow("b"), lim.allow("c"), lim.allow("d")
    assert len(lim.buckets) <= 3


# ── ports: a viewer port clear of every other listener ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("port,op,daemon,problem", [
    (9896, 9896, 9876, "operator"), (9910, 9896, 9910, "live port"), (9877, 9896, 9876, "fallback range"),
    (9880, 9896, 9876, "fallback range"), (9903, 9896, 9901, "fallback range"), (9886, 9896, 9876, "module API"),
    (80, 9896, 9876, "outside"), (70000, 9896, 9876, "outside"),
])
def test_ports_that_are_or_may_be_full_trust_listeners_are_refused(port, op, daemon, problem):
    assert problem in hdash.viewer_port_problem(port, op, daemon, 9886)


def test_the_default_viewer_port_is_clear_of_every_loopback_listener():
    assert hdash.viewer_port_problem(hdash.VIEWER_PORT_DEFAULT, hdash.PORT_DEFAULT, 9876, 9886) is None
    assert hdash.VIEWER_PORT_DEFAULT not in range(9876, 9881) and hdash.VIEWER_PORT_DEFAULT not in (9886, 9896)


def test_the_manager_binds_on_share_stops_on_unshare_and_follows_a_port_change(home):
    port = free_port()
    write_peers(home / ".peers.json", dashboard_viewer_port=port)
    logs = []
    backend = hdash.ViewerBackend(FakeGateway())
    mgr = hdash.ViewerManager(backend, hdash.PORT_DEFAULT, hdash.SettingsCache(path_fn=lambda: home / ".peers.json"), log=logs.append)
    try:
        mgr.reconcile()
        assert mgr.port == port and hdash.probe_viewer(port)[0] == "viewer"
        write_peers(home / ".peers.json", dashboard_viewer_port=port, port=9999)        # a daemon rebind changes nothing here
        mgr.reconcile()
        assert mgr.port == port
        new = free_port()
        write_peers(home / ".peers.json", dashboard_viewer_port=new)
        mgr.reconcile()
        assert mgr.port == new and hdash.probe_viewer(port)[0] == "down" and hdash.probe_viewer(new)[0] == "viewer"
        write_peers(home / ".peers.json", dashboard_share=False, dashboard_viewer_port=new)
        mgr.reconcile()
        assert mgr.server is None and hdash.probe_viewer(new)[0] == "down"
    finally:
        mgr.stop()


def test_a_taken_port_leaves_sharing_off_and_never_falls_back(home):
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen()
    port = held.getsockname()[1]
    write_peers(home / ".peers.json", dashboard_viewer_port=port)
    logs = []
    mgr = hdash.ViewerManager(hdash.ViewerBackend(FakeGateway()), hdash.PORT_DEFAULT,
                              hdash.SettingsCache(path_fn=lambda: home / ".peers.json"), log=logs.append)
    try:
        mgr.reconcile()
        mgr.reconcile()
        assert mgr.server is None and "cannot bind" in mgr.error and len(logs) == 1
        assert hdash.exposure_results(hdash.viewer_settings(), hdash.PORT_DEFAULT, ts=lambda a: {},
                                      probe=lambda p: ("other", "answered 200"))[0]["level"] == "fail"
    finally:
        mgr.stop()
        held.close()


def test_the_manager_refuses_a_port_that_is_the_operator_or_the_daemons(home):
    mgr = hdash.ViewerManager(hdash.ViewerBackend(FakeGateway()), 9896, hdash.SettingsCache(path_fn=lambda: home / ".peers.json"), log=lambda m: None)
    for bad in (9896, 9877, 9886):
        write_peers(home / ".peers.json", dashboard_viewer_port=bad)
        mgr.reconcile()
        assert mgr.server is None and mgr.error
    write_peers(home / ".peers.json", dashboard_viewer_port=9910, port=9910)             # the daemon's persisted port
    mgr.reconcile()
    assert mgr.server is None and "live port" in mgr.error


def test_the_manager_run_loop_starts_and_stops_with_the_process(home):
    port = free_port()
    write_peers(home / ".peers.json", dashboard_viewer_port=port)
    mgr = hdash.ViewerManager(hdash.ViewerBackend(FakeGateway()), hdash.PORT_DEFAULT, hdash.SettingsCache(path_fn=lambda: home / ".peers.json"), log=lambda m: None)
    t = threading.Thread(target=mgr.run, args=(0.05,), daemon=True)
    t.start()
    for _ in range(100):
        if hdash.probe_viewer(port)[0] == "viewer":
            break
        time.sleep(0.05)
    assert hdash.probe_viewer(port)[0] == "viewer"
    mgr.stop()
    t.join(5)
    assert hdash.probe_viewer(port)[0] == "down"


def test_the_probe_tells_the_viewer_from_an_operator_listener_and_from_nothing(home):
    op = hdash.make_server(hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {})), 0)
    oport = op.server_address[1]
    op.RequestHandlerClass = hdash.make_handler(hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {})), oport)
    threading.Thread(target=op.serve_forever, daemon=True).start()
    server, _, _ = start(home)
    try:
        assert hdash.probe_viewer(server.server_address[1])[0] == "viewer"
        assert hdash.probe_viewer(oport)[0] == "other"
        assert hdash.probe_viewer(free_port())[0] == "down"
    finally:
        for s in (server, op):
            s.shutdown()
            s.server_close()


# ── the Serve front end ───────────────────────────────────────────────────────────────────────────────────────────────

def serve_doc(port=9906, funnel=False, other=False, extra_443=True):
    web = {"h.t.ts.net:8443": {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{port}"}}}}
    if other:
        web["h.t.ts.net:8443"]["Handlers"]["/x"] = {"Text": "hi"}
    if extra_443:
        web["h.t.ts.net:443"] = {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}
    return {"TCP": {"443": {"HTTPS": True}, "8443": {"HTTPS": True}}, "Web": web,
            **({"AllowFunnel": {"h.t.ts.net:8443": True}} if funnel else {})}


STATUS = {"Self": {"UserID": 7, "DNSName": "h.t.ts.net."}, "User": {"7": {"LoginName": "Me@Example.com"}}}


def test_front_end_reads_only_our_https_port():
    fe = hdash.front_end(serve_doc())
    assert fe["served"] and fe["targets"] == [("/", "http://127.0.0.1:9906")] and not fe["funnel"] and not fe["other"]
    assert hdash.serves_viewer(fe, 9906) and not hdash.serves_viewer(fe, 9907)
    assert hdash.front_end({}) == {"served": False, "targets": [], "other": False, "funnel": False}
    assert hdash.front_end(serve_doc(funnel=True))["funnel"]
    assert not hdash.serves_viewer(hdash.front_end(serve_doc(other=True)), 9906)
    only_443 = {"TCP": {"443": {}}, "Web": {"h:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:1"}}}}, "AllowFunnel": {"h:443": True}}
    assert hdash.front_end(only_443)["served"] is False and hdash.front_end(only_443)["funnel"] is False


def test_tailnet_identity_is_the_devices_lowercased_login_and_dns_name():
    assert hdash.tailnet_identity(STATUS) == ("me@example.com", "h.t.ts.net")
    assert hdash.tailnet_identity({}) == ("", "")


class Rig:
    """Fakes for `share` / `unshare`: the tailscale CLI, the node-config writer, the probe."""

    def __init__(self, serve=None, probe=("viewer", ""), cfg=None):
        self.serve = serve if serve is not None else {}
        self.probe_result, self.cfg = probe, cfg or {"share": False, "port": 9906, "port_set": False, "viewers": []}
        self.writes, self.ts_calls, self.lines = [], [], []

    def tsj(self, args):
        return STATUS if args[0] == "status" else self.serve

    def ts(self, args):
        self.ts_calls.append(args)
        return 0, "", ""

    def write(self, key, value):
        self.writes.append((key, value))

    def kw(self):
        return dict(ts=self.ts, tsj=self.tsj, write=self.write, read=lambda: self.cfg, out=self.lines.append)

    def share(self, *a, **k):
        return hdash.share(*a, probe=lambda p: self.probe_result, operator_port=9896, wait=0, sleep=lambda s: None, **self.kw(), **k)


def test_share_defaults_the_allowlist_to_this_devices_login_and_serves_only_after_the_probe_passes():
    r = Rig()
    assert r.share() == 0
    assert r.writes == [("dashboard_viewers", '["me@example.com"]'), ("dashboard_share", "true")]
    assert r.ts_calls == [["serve", "--bg", "--https=8443", "http://127.0.0.1:9906"]]
    assert any("https://h.t.ts.net:8443" in line for line in r.lines)


def test_share_allow_adds_a_viewer_and_a_port_is_written_when_it_changes():
    r = Rig(cfg={"share": True, "port": 9906, "port_set": False, "viewers": ["me@example.com"]}, serve=serve_doc())
    assert r.share(["Bob@Example.com"], 9950) == 1                        # 9950 is not what Serve points at: probe is the viewer, but 8443 is not ours
    r = Rig(cfg={"share": True, "port": 9906, "port_set": False, "viewers": ["me@example.com"]}, serve=serve_doc())
    assert r.share(["Bob@Example.com"]) == 0
    assert r.writes == [("dashboard_viewers", '["bob@example.com", "me@example.com"]')] and r.ts_calls == []   # already serving: Serve untouched


@pytest.mark.parametrize("kw,expect", [
    ({"port": 9896}, "operator port"), ({"port": 9877}, "fallback range"), ({"port": 9886}, "module API"),
])
def test_share_aborts_on_a_port_check_before_touching_anything(kw, expect):
    r = Rig()
    assert r.share([], kw["port"]) == 1
    assert r.writes == [] and r.ts_calls == [] and expect in " ".join(r.lines)


def test_share_aborts_when_the_daemons_live_port_is_the_viewer_port(home):
    write_peers(home / ".peers.json", port=9906)
    r = Rig()
    assert r.share() == 1 and r.writes == [] and r.ts_calls == [] and "live port" in " ".join(r.lines)


@pytest.mark.parametrize("probe,expect", [(("other", "answered 200"), "full-trust"), (("down", "URLError"), "nothing answered")])
def test_share_aborts_when_the_loopback_probe_is_not_the_viewer_signature_and_puts_the_config_back(probe, expect):
    r = Rig(probe=probe)
    assert r.share() == 1
    assert r.ts_calls == [] and expect in " ".join(r.lines)               # Serve was never configured
    assert r.writes[-1] == ("dashboard_share", "false")


@pytest.mark.parametrize("serve,expect", [
    (serve_doc(port=3000), "already served"), (serve_doc(other=True), "already served"), (serve_doc(funnel=True), "Funnel"),
])
def test_share_aborts_when_8443_is_taken_or_public_and_writes_nothing(serve, expect):
    r = Rig(serve=serve)
    assert r.share() == 1 and r.writes == [] and r.ts_calls == [] and expect in " ".join(r.lines)


def test_unshare_turns_off_only_the_8443_entry_when_it_is_ours_and_clears_the_switch():
    r = Rig(serve=serve_doc(), cfg={"share": True, "port": 9906, "port_set": False, "viewers": ["me@example.com"]})
    assert hdash.unshare(**r.kw()) == 0
    assert r.ts_calls == [["serve", "--https=8443", "off"]] and r.writes == [("dashboard_share", "false")]


def test_unshare_leaves_a_front_end_that_is_not_ours_alone():
    r = Rig(serve=serve_doc(port=3000), cfg={"share": True, "port": 9906, "port_set": False, "viewers": []})
    assert hdash.unshare(**r.kw()) == 1
    assert r.ts_calls == [] and r.writes == [("dashboard_share", "false")]


def test_every_node_config_write_goes_through_the_one_writer():
    src = (ROOT / "hdash").read_text()
    assert "update_peers_file" not in src
    assert not re.search(r"open\([^)]*peers|peers_file\(\)\.(write|open)|write_text", src.split("def peers_file")[1].split("def cmd_serve")[0])
    calls = []
    import subprocess as sp
    orig = sp.run
    try:
        sp.run = lambda argv, **k: calls.append(argv) or type("P", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        hdash.subprocess.run = sp.run
        hdash.config_node_set("dashboard_share", "true")
    finally:
        hdash.subprocess.run = orig
    assert calls[0][-5:] == ["config", "node", "set", "dashboard_share", "true"]


def test_viewers_lists_the_allowlist_and_the_serve_state():
    r = Rig(serve=serve_doc(), cfg={"share": True, "port": 9906, "port_set": False, "viewers": ["a@x.org", "b@x.org"]})
    assert hdash.viewers_report(tsj=r.tsj, read=lambda: r.cfg, out=r.lines.append) == 0
    text = "\n".join(r.lines)
    assert "sharing: on" in text and "a@x.org" in text and "points at the viewer listener" in text
    out = []
    hdash.viewers_report(tsj=r.tsj, read=lambda: r.cfg, out=out.append, as_json=True)
    assert json.loads(out[0])["viewers"] == ["a@x.org", "b@x.org"]


# ── doctor: dashboard-exposure ────────────────────────────────────────────────────────────────────────────────────────

ON = {"share": True, "port": 9906, "port_set": False, "viewers": ["a@x.org"]}
OFF = {**ON, "share": False}


def levels(cfg, serve, probe=("viewer", ""), op=9896, daemon=None):
    return [(r["level"], r["message"]) for r in hdash.exposure_results(cfg, op, ts=lambda a: serve, probe=lambda p: probe)]


def test_doctor_is_ok_when_off_and_when_everything_lines_up():
    assert levels(OFF, {})[0][0] == "ok"
    assert levels(ON, serve_doc()) == [("ok", "sharing on for 1 login(s) via 127.0.0.1:9906")]


def test_doctor_fails_on_funnel_for_the_8443_front_end_not_the_backend_port():
    rows = levels(ON, serve_doc(funnel=True))
    assert rows[0][0] == "fail" and "Funnel" in rows[0][1] and "8443" in rows[0][1]
    assert levels(OFF, serve_doc(funnel=True))[0][0] == "fail"


def test_doctor_fails_on_a_serve_target_that_is_not_the_viewer_listener_or_a_probe_that_is_not_the_signature():
    assert any(l == "fail" for l, _ in levels(ON, serve_doc(port=9896)))
    assert any(l == "fail" and "not the viewer listener" in m for l, m in levels(ON, serve_doc(), probe=("other", "answered 200")))
    assert any(l == "fail" for l, _ in levels({**ON, "port": 9877}, serve_doc(port=9877)))
    assert any(l == "fail" and "operator port" in m for l, m in levels({**ON, "port": 9896}, serve_doc(port=9896)))


def test_doctor_warns_when_sharing_is_on_with_no_listener_bound_or_nothing_served():
    assert ("warn" in [l for l, _ in levels(ON, serve_doc(), probe=("down", "URLError"))])
    assert "warn" in [l for l, _ in levels(ON, {})]
    assert levels(OFF, serve_doc())[0][0] == "warn"                        # sharing off but Serve still points at the port


def test_doctor_without_tailscale_is_quiet_when_off_and_warns_when_on():
    def gone(a):
        raise RuntimeError("the tailscale command is not installed on this node")
    assert [r["level"] for r in hdash.exposure_results(OFF, 9896, ts=gone)] == ["ok"]
    assert "warn" in [r["level"] for r in hdash.exposure_results(ON, 9896, ts=gone, probe=lambda p: ("viewer", ""))]


def test_the_doctor_answer_is_the_module_doctor_envelope(home, monkeypatch, capsys):
    monkeypatch.setattr(hdash.exposure_results, "__defaults__", (lambda a: {}, lambda p: ("viewer", "")))
    assert hdash.main(["doctor"]) == 0
    doc = json.loads(capsys.readouterr().out)
    assert doc["schema"] == 1 and doc["results"] and all(r["level"] in ("ok", "warn", "fail") for r in doc["results"])


def test_doctor_names_a_missing_hconfig_and_is_quiet_when_it_is_there():
    (ok,) = hdash.hconfig_results(lambda name: "/bin/hconfig" if name == "hconfig" else None)
    assert ok["level"] == "ok"
    (warn,) = hdash.hconfig_results(lambda name: None)
    assert warn["level"] == "warn" and warn["fix_hint"] == "hive-mind module add hconfig"


# ── the settings reader fails closed ──────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("cfg,share", [
    ({"dashboard_share": True}, True), ({"dashboard_share": "true"}, False), ({"dashboard_share": 1}, False),
    ({"dashboard_share": True, "dashboard_viewer_port": "9906"}, False), ({"dashboard_share": True, "dashboard_viewer_port": True}, False),
    ({"dashboard_share": True, "dashboard_viewer_port": 0}, False), ({"dashboard_share": True, "dashboard_viewer_port": 70000}, False),
    ({"dashboard_share": True, "dashboard_viewer_port": 9950}, True), ([], False), ("x", False),
])
def test_settings_are_strict(tmp_path, cfg, share):
    p = tmp_path / "p.json"
    p.write_text(json.dumps(cfg))
    assert hdash.viewer_settings(p)["share"] is share
    assert hdash.viewer_settings(tmp_path / "missing.json")["share"] is False
    p.write_text("{not json")
    assert hdash.viewer_settings(p)["share"] is False


def test_viewers_are_lowercased_and_junk_entries_dropped(tmp_path):
    p = tmp_path / "p.json"
    p.write_text(json.dumps({"dashboard_viewers": ["A@X.org", 5, "", None, "b@x.org"]}))
    assert hdash.viewer_settings(p)["viewers"] == ["a@x.org", "b@x.org"]


# ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_page_enters_viewer_mode_off_loopback_and_only_removes_calls():
    js = (ROOT / "dashboard" / "app.js").read_text()
    assert "const VIEWER=!['127.0.0.1','localhost','[::1]','::1'].includes(location.hostname)" in js
    assert "if(VIEWER) u=viewerUrl(u)" in js and "x.searchParams.delete('node')" in js and "x.searchParams.set('probe','0')" in js
    no = set(re.findall(r"'(/api/[a-z]+)'", re.search(r"const VIEWER_NO=\[(.*?)\]", js).group(1)))
    assert {"/api/status", "/api/telemetry", "/api/entities", "/api/settings", "/api/csrf", "/api/modules", "/api/module", "/api/workspace"} <= no
    called = set(re.findall(r"/api/([a-z/]+)", js))
    served = set(hdash.VIEWER_ROUTES) | {"config/records"} | {n[5:] for n in no}
    assert {c.rstrip("/") for c in called} <= served | {"config"}, called - served
    assert 'nav button[data-v="agents"]' in js and 'nav button[data-v="trust"]' in js      # the workspaces run module code: not for viewers
    assert "listener==='viewer'" in js and 'id="vnote"' in (ROOT / "dashboard" / "index.html").read_text()
