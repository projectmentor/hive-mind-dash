"""hdash P2: Settings > Modules and the generic module page read the core's catalog and doctor cache, run no module code."""
import importlib.machinery
import importlib.util
import json
import os
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)

ROW = {"name": "demo", "version": "1.0", "publisher": "ab12", "signature": "valid", "service": "active",
       "device": "admitted", "trust": "trusted", "quota_use": "1/60", "problem": None, "config_schema": True}


def write_cache(home, name, doc, mode=0o700):
    d = home / ".module-doctor"
    d.mkdir(mode=mode, exist_ok=True)
    d.chmod(mode)
    (d / f"{name}.json").write_text(json.dumps(doc))


def good(at, results=None):
    return {"schema": 1, "module": "demo", "version": "1.0", "mode": "manual", "at": at, "worst": "ok",
            "results": results if results is not None else [{"level": "warn", "check": "unit", "message": "down", "fix_hint": "restart it"}]}


def test_doctor_cache_has_an_age_and_worst_level(tmp_path):
    write_cache(tmp_path, "demo", good(1000))
    d = hdash.read_doctor_cache(tmp_path, "demo", now=1090)
    assert d["age_s"] == 90 and d["worst"] == "warn" and d["results"][0]["fix_hint"] == "restart it"


def test_doctor_cache_strings_are_cleaned_again(tmp_path):
    write_cache(tmp_path, "demo", good(1, [{"level": "ok", "check": "a‮b\nc", "message": "x\x00y" + "z" * 900}]))
    r = hdash.read_doctor_cache(tmp_path, "demo", now=2)["results"][0]
    assert r["check"] == "ab c" and "\x00" not in r["message"] and len(r["message"]) == 400


@pytest.mark.parametrize("doc", [[], {"schema": 2, "at": 1, "results": []}, {"schema": 1, "at": "x", "results": []},
                                 {"schema": 1, "at": True, "results": []}, {"schema": 1, "at": 1, "results": "no"}])
def test_doctor_cache_wrong_shape_is_none(tmp_path, doc):
    write_cache(tmp_path, "demo", doc)
    assert hdash.read_doctor_cache(tmp_path, "demo") is None


def test_doctor_cache_refuses_links_shared_dirs_big_files_and_bad_names(tmp_path):
    write_cache(tmp_path, "demo", good(1))
    assert hdash.read_doctor_cache(tmp_path, "../demo") is None and hdash.read_doctor_cache(tmp_path, "Demo") is None
    (tmp_path / ".module-doctor" / "link.json").symlink_to(tmp_path / ".module-doctor" / "demo.json")
    assert hdash.read_doctor_cache(tmp_path, "link") is None
    (tmp_path / ".module-doctor" / "big.json").write_text(" " * (256 * 1024 + 1))
    assert hdash.read_doctor_cache(tmp_path, "big") is None
    (tmp_path / ".module-doctor").chmod(0o777)
    assert hdash.read_doctor_cache(tmp_path, "demo") is None
    assert hdash.read_doctor_cache(tmp_path / "missing", "demo") is None


def test_modules_view_joins_rows_and_cache(tmp_path):
    write_cache(tmp_path, "demo", good(10))
    v = hdash.modules_view([ROW, {**ROW, "name": "other"}], tmp_path, now=15)
    assert [m["name"] for m in v["modules"]] == ["demo", "other"]
    assert v["modules"][0]["doctor"]["age_s"] == 5 and v["modules"][1]["doctor"] is None


def test_list_modules_failures_are_runtime_errors(monkeypatch):
    class P:
        returncode, stdout = 1, ""
    monkeypatch.setattr(hdash.subprocess, "run", lambda *a, **k: P())
    with pytest.raises(RuntimeError):
        hdash.list_modules()
    P.returncode, P.stdout = 0, json.dumps({"schema": 1, "modules": [ROW, {"name": "../x"}, "junk"]})
    assert [r["name"] for r in hdash.list_modules()] == ["demo"]


def manifest(base, name, mf):
    (base / name).mkdir(parents=True)
    (base / name / "module.json").write_text(json.dumps(mf))


def test_module_page_reads_ui_only_for_a_valid_signature(tmp_path):
    ui = {"title": "Demo", "summary": "s", "actions": [
        {"id": "drain", "label": "Drain", "command": ["demo", "wait", "--role", "{role2}", "a b"], "confirm": "sure?", "owner": False},
        {"id": "bad", "command": "nope"}]}
    manifest(tmp_path / "mods", "demo", {"cli": {"name": "demo"}, "ui": ui})
    v = hdash.module_view("demo", [ROW], tmp_path, base=tmp_path / "mods")
    assert v["ui"]["title"] == "Demo" and len(v["ui"]["actions"]) == 1
    assert v["ui"]["actions"][0]["command"] == "demo wait --role \"<role2>\" 'a b'"
    assert v["module"]["cli"] == "demo"
    tampered = hdash.module_view("demo", [{**ROW, "signature": "invalid"}], tmp_path, base=tmp_path / "mods")
    assert tampered["ui"] is None and "cli" not in tampered["module"]


def test_an_action_line_cannot_smuggle_shell(tmp_path):
    line = hdash._argv_line(["x", "--a={p}$(id)`id`\"", "; rm -rf ~"])
    assert line == "x \"--a=<p>\\$(id)\\`id\\`\\\"\" '; rm -rf ~'"


def test_module_page_unknown_or_malformed_name(tmp_path):
    assert hdash.module_view("nope", [ROW], tmp_path) is None
    assert hdash.module_view("../demo", [ROW], tmp_path) is None
    assert hdash.read_manifest("demo", tmp_path) == {}


def test_routes_are_local_loopback_and_ignore_node(monkeypatch):
    monkeypatch.setattr(hdash, "list_modules", lambda: [ROW])
    monkeypatch.setattr(hdash, "hive_home", lambda: Path("/nonexistent"))
    calls = []
    g = hdash.Gateway(lambda *a: calls.append(a), lambda *a: calls.append(a), hdash.local_routes())
    code, obj = g.route("modules", "node=k1%3Aabc")
    assert code == 200 and obj["modules"][0]["name"] == "demo" and not calls
    assert g.route("module", "name=demo")[0] == 200 and g.route("module", "name=zzz")[0] == 404
    assert g.route("module", "")[0] == 404 and not calls

    def boom():
        raise RuntimeError("no core")
    monkeypatch.setattr(hdash, "list_modules", boom)
    assert g.route("modules", "")[0] == 502 and g.route("module", "name=demo")[0] == 502


def test_page_has_the_modules_nav_and_calls_only_served_routes():
    js = (ROOT / "dashboard" / "app.js").read_text()
    assert 'data-v="modules"' in (ROOT / "dashboard" / "index.html").read_text()
    assert "/api/modules" in js and "/api/module?name=" in js
