"""hdash: another OS account on the node can reach 127.0.0.1 and set any header, so `/api/csrf` is handed out only
against the launch token in a 0600 file under HIVE_HOME. Without it there is no CSRF token and no write."""
import http.client
import importlib.machinery
import importlib.util
import json
import os
import stat
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)

LAUNCH = "l" * 43


@pytest.fixture
def srv():
    seen = []

    def echo(obj):
        seen.append(obj)
        return 200, {"ok": True}

    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), {}, {"settings": echo})
    server = hdash.make_server(gw, 0, LAUNCH)          # the real csrf token: random, learnt only through /api/csrf
    port = server.server_address[1]
    server.RequestHandlerClass = hdash.make_handler(gw, port, launch_token=LAUNCH)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield port, seen
    server.shutdown()
    server.server_close()


def call(port, method, path, headers=None, body=None):
    h = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}"}
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
        return r.status, (json.loads(data) if data else None)
    finally:
        c.close()


@pytest.mark.parametrize("hdrs", [{}, {hdash.LAUNCH_HEADER: ""}, {hdash.LAUNCH_HEADER: "x" * 43}, {hdash.LAUNCH_HEADER: LAUNCH + "x"}])
def test_csrf_without_the_launch_token_is_403(srv, hdrs):
    port, _ = srv
    code, body = call(port, "GET", "/api/csrf", hdrs)
    assert code == 403 and "token" not in body


def test_a_local_client_without_the_launch_token_cannot_write(srv):
    port, seen = srv
    assert call(port, "GET", "/api/csrf")[0] == 403          # step 1 of the probe: no token handed out
    for tok in (None, "guess", "t" * 43):                    # step 2: a write with any CSRF value
        h = {"Content-Type": "application/json"}
        if tok:
            h[hdash.CSRF_HEADER] = tok
        assert call(port, "POST", "/api/settings", h, b'{"id":"node:x","value":"v"}')[0] == 403
    assert seen == []


def test_with_the_launch_token_the_flow_works(srv):
    port, seen = srv
    code, body = call(port, "GET", "/api/csrf", {hdash.LAUNCH_HEADER: LAUNCH})
    assert code == 200
    h = {hdash.CSRF_HEADER: body["token"], "Content-Type": "application/json"}
    assert call(port, "POST", "/api/settings", h, b'{"id":"node:x","value":"v"}')[0] == 200
    assert seen == [{"id": "node:x", "value": "v"}]


def test_a_server_with_no_launch_token_given_makes_its_own_and_hands_nothing_out():
    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), {})
    server = hdash.make_server(gw, 0)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        assert call(port, "GET", "/api/csrf", {hdash.LAUNCH_HEADER: ""})[0] == 403
    finally:
        server.shutdown()
        server.server_close()


def test_the_token_file_is_0600_fresh_each_time_and_read_back(tmp_path):
    p = tmp_path / "tok"
    a = hdash.write_launch_token(p)
    assert stat.S_IMODE(p.stat().st_mode) == 0o600 and hdash.read_launch_token(p) == a
    b = hdash.write_launch_token(p)
    assert a != b and hdash.read_launch_token(p) == b and [x.name for x in tmp_path.iterdir()] == ["tok"]


def test_a_token_file_others_can_read_or_that_is_a_link_is_not_trusted(tmp_path):
    p = tmp_path / "tok"
    hdash.write_launch_token(p)
    os.chmod(p, 0o644)
    assert hdash.read_launch_token(p) is None
    os.chmod(p, 0o600)
    link = tmp_path / "link"
    link.symlink_to(p)
    assert hdash.read_launch_token(link) is None and hdash.read_launch_token(tmp_path / "none") is None


def test_the_page_sends_the_launch_token_from_the_fragment_and_drops_it():
    js = (ROOT / "dashboard" / "app.js").read_text()
    assert "#k=" in js and "X-HDash-Launch" in js and "history.replaceState" in js


def test_dash_opener_argv_never_carries_the_launch_token(monkeypatch, tmp_path):
    monkeypatch.setenv("HIVE_HOME", str(tmp_path))
    monkeypatch.setenv("HIVE_MODULE_DIR", str(tmp_path))
    (tmp_path / "config").write_text(json.dumps({"port": "65112"}))
    token = hdash.write_launch_token()
    monkeypatch.setattr(hdash.urllib.request, "urlopen", lambda *a, **k: type("R", (), {"close": lambda s: None})())
    monkeypatch.setattr(hdash.shutil, "which", lambda c: "/usr/bin/xdg-open" if c == "xdg-open" else None)
    argvs = []
    monkeypatch.setattr(hdash.subprocess, "Popen", lambda argv, **k: argvs.append(list(argv)))
    assert hdash.main(["dash"]) == 0
    assert argvs and token not in " ".join(" ".join(a) for a in argvs)
    opener = next(a for a in argvs if a[0] == "xdg-open")
    page = Path(opener[-1].removeprefix("file://"))
    assert stat.S_IMODE(page.stat().st_mode) == 0o600
    assert f"http://127.0.0.1:65112/#k={token}" in page.read_text()
