"""hdash 4.x: the config forms read `hconfig list` and `POST /api/settings` runs `hconfig set`, behind the P3 guard and
hive-mind#100's gates 6a-6c: a loopback source, the Origin/CSRF pair, no Tailscale-* header, a bounded JSON body."""
import http.client
import importlib.machinery
import importlib.util
import json
import os
import stat
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
REC = {"id": "x-demo:seat.dev.runtime", "class": "governed", "scope": "fleet", "type": "enum", "default": "claude",
       "values": ["claude", "grok"], "description": "Runtime", "secret": False, "identifying": False, "visibility": "operator",
       "writable_by": "owner", "write_via": "hconfig set x-demo:seat.dev.runtime VALUE", "warnings": [], "set": True,
       "source": "fleet", "value": "grok", "set_by": {"device_id": "k1:0123456789abcdef", "ts": "2026-10-13T00:00:00Z", "sid": "k1:0:1"}}


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """A fake `hconfig` on PATH that logs its argv, stdin and environment, then answers from a script file."""
    bin_dir, log = tmp_path / "bin", tmp_path / "log"
    bin_dir.mkdir()
    exe = bin_dir / "hconfig"
    exe.write_text(f"""#!/usr/bin/env python3
import json, os, sys, time
raw = sys.stdin.read() if not sys.stdin.isatty() else ""
t0 = time.time()
with open({str(log)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "stdin": raw, "source": os.environ.get("HCONFIG_SOURCE"),
        "owner_env": [k for k in os.environ if k.startswith("HIVE_OWNER")], "t0": t0}}) + "\\n")
a = json.load(open({str(tmp_path / "answer")!r}))
time.sleep(a.get("sleep", 0))
with open({str(log)!r}, "a") as f:
    f.write(json.dumps({{"done": time.time()}}) + "\\n")
print(json.dumps(a["out"]))
sys.exit(a.get("rc", 0))
""")
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("HIVE_OWNER_KEY_PASSPHRASE", "hunter2")

    class Fake:
        def answer(self, out, rc=0, sleep=0):
            (tmp_path / "answer").write_text(json.dumps({"out": out, "rc": rc, "sleep": sleep}))

        def calls(self):
            rows = [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
            return [r for r in rows if "argv" in r]
    f = Fake()
    f.answer({"schema": 1, "ok": True, "keys": [REC], "warnings": []})
    return f


@pytest.fixture
def srv(fake):
    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), hdash.local_routes(), {"settings": hdash.write_setting})
    server = hdash.make_server(gw, 0)
    port = server.server_address[1]
    server.RequestHandlerClass = hdash.make_handler(gw, port, csrf_token=TOKEN)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield port
    server.shutdown()
    server.server_close()


def req(port, method="POST", path="/api/settings", body=None, headers=None):
    body = json.dumps({"id": "node:port", "value": "9000"}).encode() if body is None and method == "POST" else body
    h = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", hdash.CSRF_HEADER: TOKEN,
         "Content-Type": "application/json"}
    h.update(headers or {})
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            if v is not None:
                c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        return r.status, (json.loads(data) if data else None)
    finally:
        c.close()


def ok_set(rec=None, changed=True):
    return {"schema": 1, "ok": True, "id": "node:port", "action": "set", "changed": changed, "key": rec or dict(REC, id="node:port"),
            "warnings": []}


# ── gates 6a-6c ──────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("hdrs", [
    {hdash.CSRF_HEADER: None}, {hdash.CSRF_HEADER: "x" * 43}, {"Origin": "http://evil.example"}, {"Origin": None},
    {"Sec-Fetch-Site": "cross-site"}, {"Tailscale-User-Login": "viewer@example.com"}, {"tailscale-user-name": "v"},
    {"Tailscale-App-Capabilities": "{}"},
])
def test_a_settings_write_failing_a_gate_starts_nothing(srv, fake, hdrs):
    assert req(srv, headers=hdrs)[0] == 403
    assert fake.calls() == []


def test_a_foreign_host_is_refused(srv, fake):
    assert req(srv, headers={"Host": "evil.example"})[0] == 403 and fake.calls() == []


def test_a_non_loopback_source_is_refused_even_with_every_other_header_right(fake):
    gw = hdash.Gateway(lambda p, q: (200, {}), lambda p, q: (200, {}), hdash.local_routes(), {"settings": hdash.write_setting})
    handler = hdash.make_handler(gw, 9, csrf_token=TOKEN)
    seen = []

    class Probe(handler):
        def __init__(self):                           # no socket: only _mutate's first line is under test
            self.client_address = ("100.64.0.7", 4444)
            self.headers = {"Host": "127.0.0.1:9", "Origin": "http://127.0.0.1:9", hdash.CSRF_HEADER: TOKEN}

        def _deny(self, code, msg):
            seen.append((code, msg))
    Probe()._mutate()
    assert seen == [(403, "loopback only")] and fake.calls() == []


def test_settings_reads_with_a_tailscale_header_are_refused(srv, fake):
    assert req(srv, "GET", "/api/settings?prefix=node:", None, {"Tailscale-User-Login": "v@example.com"})[0] == 403
    assert fake.calls() == []


# ── the write ────────────────────────────────────────────────────────────────────────────────────

def test_a_good_write_runs_hconfig_set_with_the_value_on_stdin_only(srv, fake):
    fake.answer(ok_set())
    code, out = req(srv, body=json.dumps({"id": "node:port", "value": "9000"}).encode())
    assert code == 200 and out["ok"] is True and out["changed"] is True and out["key"]["id"] == "node:port"
    [call] = fake.calls()
    assert call["argv"] == ["set", "--json", "--stdin", "--non-interactive", "--", "node:port"]
    assert call["stdin"] == "9000\n" and "9000" not in " ".join(call["argv"])
    assert call["source"] == "hdash" and call["owner_env"] == []         # the owner passphrase never reaches the child


def test_a_secret_and_a_dash_value_never_reach_argv(srv, fake):
    fake.answer(ok_set())
    for value in ("s3cret-value", "--stdin", "-x"):
        assert req(srv, body=json.dumps({"id": "x-demo:token", "value": value}).encode())[0] == 200
    assert all(c["argv"][-1] == "x-demo:token" and not {"s3cret-value", "-x"} & set(c["argv"]) for c in fake.calls())
    assert [c["stdin"] for c in fake.calls()] == ["s3cret-value\n", "--stdin\n", "-x\n"]


@pytest.mark.parametrize("key", ["core:cap_self", "core:quorum_m", "node:owner_quota"])
def test_owner_only_keys_start_nothing(srv, fake, key):
    code, out = req(srv, body=json.dumps({"id": key, "value": "1"}).encode())
    assert code == 403 and out["error"]["code"] == "owner-only" and fake.calls() == []


@pytest.mark.parametrize("body", [
    {"id": "node:port"}, {"value": "1"}, {"id": "node:port", "value": 9000}, {"id": "node:port", "value": ["a"]},
    {"id": "../etc:passwd", "value": "1"}, {"id": "--json", "value": "1"}, {"id": "node:", "value": "1"},
    {"id": "node:port", "value": "a\nb"}, {"id": "node:port", "value": "a\x00b"}, {"id": "node:port", "value": "x" * 5000},
    {"id": "x-" + "a" * 50 + ":k", "value": "1"},
])
def test_a_malformed_write_is_400_and_starts_nothing(srv, fake, body):
    code, out = req(srv, body=json.dumps(body).encode())
    assert code == 400 and out["ok"] is False and fake.calls() == []


def test_an_unknown_key_is_hconfigs_404(srv, fake):
    fake.answer({"schema": 1, "ok": False, "error": {"code": "unknown-key", "id": "node:nope", "message": "no such key", "hint": ""}}, rc=1)
    code, out = req(srv, body=json.dumps({"id": "node:nope", "value": "1"}).encode())
    assert code == 404 and out["error"]["code"] == "unknown-key"


def test_owner_locked_is_409_with_the_unlock_hint(srv, fake):
    fake.answer({"schema": 1, "ok": False, "error": {"code": "owner-locked", "id": REC["id"], "message": "the owner key is locked",
                                                     "hint": "run `hive-mind owner unlock --module demo` on your own terminal"}}, rc=5)
    code, out = req(srv, body=json.dumps({"id": REC["id"], "value": "claude"}).encode())
    assert code == 409 and out["error"]["code"] == "owner-locked" and "owner unlock --module demo" in out["error"]["hint"]


def test_exit_5_is_owner_locked_whatever_the_json_says(srv, fake):
    fake.answer({"schema": 1, "ok": False, "error": {"code": "core-failed", "message": "x", "hint": ""}}, rc=5)
    assert req(srv, body=json.dumps({"id": REC["id"], "value": "claude"}).encode())[1]["error"]["code"] == "owner-locked"


def test_a_garbled_answer_is_502_and_carries_no_value(srv, fake, tmp_path):
    (tmp_path / "answer").write_text(json.dumps({"out": [1], "rc": 0}))
    code, out = req(srv, body=json.dumps({"id": "node:port", "value": "topsecret"}).encode())
    assert code == 502 and "topsecret" not in json.dumps(out)


def test_two_concurrent_writes_serialise(srv, fake):
    fake.answer(ok_set(), sleep=0.4)
    res = []
    ts = [threading.Thread(target=lambda: res.append(req(srv)[0])) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert res == [200, 200]
    rows = [json.loads(x) for x in (Path(fake.calls()[0] and os.environ["PATH"].split(os.pathsep)[0]).parent / "log").read_text().splitlines()]
    starts = sorted(r["t0"] for r in rows if "argv" in r)
    done = sorted(r["done"] for r in rows if "done" in r)
    assert len(starts) == 2 and starts[1] >= done[0]                     # the second began after the first finished


def test_a_missing_hconfig_says_how_to_install_it(srv, monkeypatch):
    monkeypatch.setenv("PATH", "/nonexistent")
    code, out = req(srv)
    assert code == 502 and "hive-mind module add hconfig" in out["error"]["message"]


# ── the read ─────────────────────────────────────────────────────────────────────────────────────

def test_the_read_runs_hconfig_list_and_returns_cleaned_records(srv, fake):
    dirty = dict(REC, description="a‮b\nc", surprise="not a known field")
    secret = dict(REC, id="x-demo:token", secret=True, set=True, value="plaintext-leak", writable_by="operator")
    fake.answer({"schema": 1, "ok": True, "keys": [dirty, secret], "warnings": ["demo: bad schema\x00"]})
    code, out = req(srv, "GET", "/api/settings?prefix=x-demo:&class=governed", None, {"Origin": None})
    assert code == 200
    assert fake.calls()[0]["argv"] == ["list", "--json", "--class", "governed", "--", "x-demo:"]
    a, b = out["keys"]
    assert a["description"] == "ab c" and "surprise" not in a and out["warnings"] == ["demo: bad schema"]
    assert b["value"] == "********" and "plaintext-leak" not in json.dumps(out)


@pytest.mark.parametrize("q", ["prefix=--json", "prefix=a%20b", "prefix=../x", "class=bogus", "prefix=node:;ls"])
def test_the_read_refuses_a_bad_prefix_or_class(srv, fake, q):
    assert req(srv, "GET", "/api/settings?" + q, None, {"Origin": None})[0] == 400 and fake.calls() == []


def test_a_failed_list_is_502(srv, fake):
    fake.answer({"schema": 1, "ok": False, "error": {"code": "core-failed", "message": "this core may predate the config verbs"}}, rc=1)
    code, out = req(srv, "GET", "/api/settings", None, {"Origin": None})
    assert code == 502 and "predate" in out["error"]


def test_settings_is_a_local_route_and_node_is_not_forwarded(fake):
    calls = []
    gw = hdash.Gateway(lambda p, q: calls.append(p) or (200, {}), lambda p, q: calls.append(p) or (200, {}), hdash.local_routes())
    assert gw.route("settings", "node=peer&prefix=node:")[0] == 200 and calls == []


# ── the page ─────────────────────────────────────────────────────────────────────────────────────

def test_the_page_posts_with_the_csrf_header_and_never_shows_the_owner_a_passphrase_box():
    js = (ROOT / "dashboard" / "app.js").read_text()
    assert "'X-HDash-CSRF'" in js and "/api/settings" in js and "hive-mind owner unlock --module" in js
    assert "HIVE_OWNER" not in js and 'type="password"' not in js.replace("type=${r.secret?'password':'text'}", "")
    assert "settingsPanel('x-'+MP.name+':')" in js and "write_via" in js
