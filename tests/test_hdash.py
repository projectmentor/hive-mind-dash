"""hdash: the page is served as the core served it, `/api/*` maps to /v1 or the daemon, and nothing else is reachable."""
import importlib.machinery
import importlib.util
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)


@pytest.fixture
def served():
    calls = {"v1": [], "daemon": []}

    def v1(path, query):
        calls["v1"].append((path, query))
        return 200, {"via": "v1", "path": path}

    def daemon(path, query):
        calls["daemon"].append((path, query))
        return 200, {"via": "daemon", "path": path}

    srv = hdash.make_server(hdash.Gateway(v1, daemon), 0)
    port = srv.server_address[1]
    srv.RequestHandlerClass = hdash.make_handler(hdash.Gateway(v1, daemon), port)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield port, calls
    srv.shutdown()
    srv.server_close()


def get(port, path, host=None, method="GET"):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method,
                                 headers={"Host": f"127.0.0.1:{port}" if host is None else host})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_the_page_and_assets_are_served_with_a_csp_on_the_index(served):
    port, _ = served
    for path, ctype in (("/", "text/html"), ("/app.js", "text/javascript"), ("/app.css", "text/css"), ("/viz.js", "text/javascript"),
                        ("/logo.svg", "image/svg+xml"), ("/favicon.svg", "image/svg+xml")):
        code, body, h = get(port, path)
        assert code == 200 and h["Content-Type"].startswith(ctype) and body, path
        assert h["X-Content-Type-Options"] == "nosniff"
    assert get(port, "/")[2]["Content-Security-Policy"] == "default-src 'self'"
    assert get(port, "/dashboard")[0] == 200


def test_the_shipped_page_is_the_one_the_core_served(served):
    assert b"/api/overview" in (ROOT / "dashboard" / "app.js").read_bytes()


@pytest.mark.parametrize("route", ["overview", "tags", "related", "audit", "peers", "verify", "search"])
def test_v1_reads_go_signed_to_the_module_api(served, route):
    port, calls = served
    code, body, _ = get(port, f"/api/{route}?limit=8")
    assert code == 200 and json.loads(body)["via"] == "v1"
    assert calls["v1"] == [(f"/v1/{route}", "limit=8")] and not calls["daemon"]


def test_item_renames_sid_to_id(served):
    port, calls = served
    get(port, "/api/item?sid=h%3Aabc")
    assert calls["v1"] == [("/v1/item", "id=h%3Aabc")]


@pytest.mark.parametrize("route", ["status", "telemetry", "entities"])
def test_daemon_only_routes_go_to_the_daemon(served, route):
    port, calls = served
    assert json.loads(get(port, f"/api/{route}?cmd=doctor")[1])["via"] == "daemon"
    assert calls["daemon"] == [(f"/api/{route}", "cmd=doctor")] and not calls["v1"]


@pytest.mark.parametrize("route", ["overview", "search"])
def test_a_node_query_goes_to_the_daemon_which_does_the_signed_proxy(served, route):
    port, calls = served
    get(port, f"/api/{route}?node=k1%3Aabcdef&limit=5")
    assert calls["daemon"] == [(f"/api/{route}", "node=k1%3Aabcdef&limit=5")] and not calls["v1"]


def test_a_foreign_host_is_refused_before_any_read(served):
    port, calls = served
    for host in ("evil.example", f"evil.example:{port}", "127.0.0.1:1", ""):
        assert get(port, "/api/overview", host=host)[0] == 403
        assert get(port, "/", host=host)[0] == 403
    assert not calls["v1"] and not calls["daemon"]
    assert get(port, "/", host=f"localhost:{port}")[0] == 200


def test_only_get_and_head_and_only_known_paths(served):
    port, calls = served
    for m in ("POST", "PUT", "DELETE", "PATCH"):
        code, _, h = get(port, "/api/overview", method=m)
        assert code == 403                      # no Origin, no CSRF token: refused before any route is looked up
    assert get(port, "/api/overview", method="OPTIONS")[0] == 405
    assert get(port, "/api/overview", method="HEAD")[0] == 200
    for path in ("/api/daemon", "/api/nope", "/../hdash", "/hdash", "/module.json", "/dashboard/app.js", "/v1/feed"):
        assert get(port, path)[0] == 404, path


def test_a_failing_core_is_a_502_not_a_crash():
    def boom(path, query):
        raise OSError("refused")
    g = hdash.Gateway(boom, boom)
    assert g.route("overview", "")[0] == 502 and g.route("status", "")[0] == 502


def test_port_comes_from_config_and_bad_values_fall_back(tmp_path):
    cfg = tmp_path / "config"
    assert hdash.load_port(cfg) == hdash.PORT_DEFAULT
    cfg.write_text(json.dumps({"port": "9911"}))
    assert hdash.load_port(cfg) == 9911
    for bad in ('{"port": "80"}', '{"port": "x"}', "[]", "not json"):
        cfg.write_text(bad)
        assert hdash.load_port(cfg) == hdash.PORT_DEFAULT


def test_serve_without_the_module_key_exits_nonzero_and_names_it(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("HIVE_HOME", str(tmp_path))
    assert hdash.main(["serve"]) == 1
    assert "hive_module_client.py" in capsys.readouterr().err


def test_dash_says_so_when_the_service_is_down(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("HIVE_MODULE_DIR", str(tmp_path))
    (tmp_path / "config").write_text(json.dumps({"port": "65111"}))
    assert hdash.main(["dash", "--print"]) == 1
    assert "http://127.0.0.1:65111/" in capsys.readouterr().out


def test_dash_print_prints_the_url_and_opens_nothing(served, monkeypatch, capsys, tmp_path):
    port, _ = served
    monkeypatch.setenv("HIVE_MODULE_DIR", str(tmp_path))
    (tmp_path / "config").write_text(json.dumps({"port": str(port)}))
    opened = []
    monkeypatch.setattr(hdash.subprocess, "Popen", lambda *a, **k: opened.append(a))
    assert hdash.main(["dash", "--print"]) == 0 and not opened
    assert f"http://127.0.0.1:{port}/" in capsys.readouterr().out


def test_series_is_a_v1_read_and_a_viewer_may_pass_days_only():
    assert "series" in hdash.V1_READS and "series" in hdash.API_ROUTES
    assert hdash.VIEWER_ROUTES["series"] == ("days",)
    assert hdash.viewer_query("series", "days=90") == "days=90"
    assert hdash.viewer_query("series", "node=x") is None
