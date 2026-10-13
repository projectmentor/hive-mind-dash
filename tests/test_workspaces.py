"""hdash P4: the Agents and Trust workspaces. Defined in hdash; a module only declares the panels that fill a slot."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)

UI = {"schema": 1, "title": "hwatch", "panels": [
    {"id": "seats", "widget": "table", "title": "hwatch / seats", "from": "status", "path": "seats", "columns": ["role", "lag"]},
    {"id": "lag", "widget": "stat", "title": "lag", "from": "status", "path": "seats[*].lag"},
    {"id": "cfg", "widget": "table", "title": "cfg", "from": "config"},
    {"id": "off", "widget": "table", "title": "not in the slot", "from": "status", "path": "x"}],
    "slots": {"agents": ["seats", "lag", "cfg", "ghost"], "trust": ["seats"]}}
ENV = {"schema": 1, "state": "ok", "detail": {"seats": [{"role": "impl", "lag": 3}, {"role": "ver‮", "lag": 9}]}}


def row(name="hwatch", sig="valid"):
    return {"name": name, "version": "1", "publisher": "ab", "signature": sig, "service": "active", "device": "admitted",
            "trust": "trusted", "quota_use": "1/60", "problem": None}


def install(base, name, ui):
    (base / name).mkdir()
    (base / name / "module.json").write_text(json.dumps({"name": name, "ui": ui}))


def calls():
    seen = []
    def fn(name):
        seen.append(name)
        return ENV
    return fn, seen


def test_eval_path_subset():
    d = {"a": {"b": [{"c": 1}, {"c": 2}]}, "s": 5}
    assert hdash.eval_path(d, "s") == 5 and hdash.eval_path(d, "a.b[*].c") == [1, 2]
    for bad in ("a.b.c", "a..b", "a[0]", "__import__('os')", "", "a b", "missing"):
        assert hdash.eval_path(d, bad) is None


def test_agents_slot_fills_from_status_and_cleans_text(tmp_path):
    install(tmp_path, "hwatch", UI)
    fn, seen = calls()
    w = hdash.workspace_view("agents", rows=[row()], home=tmp_path, envelope_fn=fn, base=tmp_path)
    by = {p["id"]: p for p in w["panels"]}
    assert list(by) == ["seats", "lag", "cfg"]                       # ghost (no such panel) and `off` (not in the slot) skipped
    assert by["seats"]["data"][1]["role"] == "ver" and by["seats"]["columns"] == ["role", "lag"]
    assert by["lag"]["data"] == [3, 9]
    assert by["cfg"]["data"] is None and "own page" in by["cfg"]["note"]
    assert seen == ["hwatch", "hwatch"]
    assert w["notes"] and "hrouter" in w["notes"][0]                  # an empty slot says so


def test_a_module_without_a_valid_signature_fills_nothing_and_runs_nothing(tmp_path):
    install(tmp_path, "hwatch", UI)
    fn, seen = calls()
    w = hdash.workspace_view("agents", rows=[row(sig="invalid")], home=tmp_path, envelope_fn=fn, base=tmp_path)
    assert w["panels"] == [] and seen == []


def test_a_module_that_does_not_declare_the_slot_runs_nothing(tmp_path):
    install(tmp_path, "other", {"schema": 1, "panels": UI["panels"], "slots": {"spend": ["seats"]}})
    fn, seen = calls()
    w = hdash.workspace_view("agents", rows=[row("other")], home=tmp_path, envelope_fn=fn, base=tmp_path)
    assert w["panels"] == [] and seen == []


def test_status_that_does_not_answer_is_a_note_not_an_error(tmp_path):
    install(tmp_path, "hwatch", UI)
    w = hdash.workspace_view("agents", rows=[row()], home=tmp_path, envelope_fn=lambda n: None, base=tmp_path)
    assert w["panels"][0]["data"] is None and "did not answer" in w["panels"][0]["note"]


def test_trust_lists_claims_with_verify_commands_and_every_module(tmp_path):
    w = hdash.workspace_view("trust", rows=[row(), row("b", "invalid")], home=tmp_path, envelope_fn=lambda n: None, base=tmp_path)
    assert [m["signature"] for m in w["modules"]] == ["valid", "invalid"]
    assert any(c["verify"] == "hv verify" for c in w["claims"])


def test_unknown_workspace_and_route():
    assert hdash.workspace_view("nope", rows=[]) is None
    assert "workspace" in hdash.LOCAL_ROUTES
    assert hdash.local_routes()["workspace"]("name=nope")[0] == 404


def test_status_envelope_is_cached_between_page_loads(monkeypatch):
    hdash._status_cache.clear()
    n = []
    class P:
        stdout = json.dumps(ENV)
    monkeypatch.setattr(hdash.subprocess, "run", lambda *a, **k: n.append(a[0]) or P())
    monkeypatch.setattr(hdash, "hive_mind_argv", lambda: ["hm"])
    assert hdash.module_status_envelope("w", now=100) == ENV and hdash.module_status_envelope("w", now=110) == ENV
    assert len(n) == 1 and n[0] == ["hm", "module", "status", "w", "--json"]
    hdash.module_status_envelope("w", now=100 + hdash.STATUS_TTL + 1)
    assert len(n) == 2


def test_spend_shows_quotas_lowered_by_a_valid_manifest_and_fills_its_slot(tmp_path):
    ui = {"schema": 1, "panels": [{"id": "wb", "widget": "table", "title": "wake budget", "from": "status", "path": "seats"}],
          "slots": {"spend": ["wb"]}}
    (tmp_path / "hwatch").mkdir()
    (tmp_path / "hwatch" / "module.json").write_text(json.dumps({"name": "hwatch", "ui": ui, "quota": {"per_hour": 10, "per_day": 99999, "lifetime": True}}))
    fn, seen = calls()
    w = hdash.workspace_view("spend", rows=[row()], home=tmp_path, envelope_fn=fn, base=tmp_path)
    q = w["quotas"][0]
    assert q["per_hour"] == 10 and q["per_day"] == 500 and q["lifetime"] == 50000 and q["use"] == "1/60"   # a raise or a bool is ignored
    assert [p["id"] for p in w["panels"]] == ["wb"] and seen == ["hwatch"]
    assert any("hrouter" in n for n in w["notes"])                       # the empty hrouter slot says so


def test_spend_ignores_the_manifest_of_a_module_without_a_valid_signature(tmp_path):
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "module.json").write_text(json.dumps({"quota": {"per_hour": 1}}))
    w = hdash.workspace_view("spend", rows=[row("x", "invalid")], home=tmp_path, envelope_fn=lambda n: None, base=tmp_path)
    assert w["quotas"][0]["per_hour"] == 60


def test_governance_lists_core_policy_and_module_admission(tmp_path):
    pol = [{"id": "core:forget_writers", "value": "owner"}]
    w = hdash.workspace_view("governance", rows=[row(), row("b", "invalid")], home=tmp_path, envelope_fn=lambda n: None,
                             base=tmp_path, policy_fn=lambda: (pol, ""))
    assert w["policy"] == pol and [m["device"] for m in w["modules"]] == ["admitted", "admitted"]
    assert any("Refusals" in n for n in w["notes"]) and "quota_use" not in w["modules"][0]


def test_governance_says_why_when_hconfig_does_not_answer(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("hconfig did not answer: OSError")
    monkeypatch.setattr(hdash, "run_hconfig", boom)
    w = hdash.workspace_view("governance", rows=[], home=tmp_path, envelope_fn=lambda n: None, base=tmp_path)
    assert w["policy"] == [] and "hconfig" in w["policy_note"]


def test_core_policy_keeps_only_known_fields(monkeypatch):
    recs = [{"id": "core:k", "value": "v", "secret": False, "evil": "x", "description": "d‮"}]
    monkeypatch.setattr(hdash, "run_hconfig", lambda a: (0, {"ok": True, "keys": recs}))
    pol, why = hdash.core_policy()
    assert pol == [{"id": "core:k", "value": "v", "description": "d"}] and why == ""


def test_spend_and_governance_are_routes_and_nav_buttons():
    for n in ("spend", "governance"):
        assert hdash.local_routes()["workspace"]("name=" + n)[0] in (200, 502)
        assert f'data-v="{n}"' in (ROOT / "dashboard" / "index.html").read_text()
        assert f"workspace('{n}')" in (ROOT / "dashboard" / "app.js").read_text()
