"""hdash 0.2 D9 (hive-mind-dash#18, #41 item 2): Modules is the one home for module detail; Trust and Governance keep a compact
one-line list per module that links to it; a module's Config tab keeps its own Fleet / This device state."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = (ROOT / "dashboard" / "app.js").read_text()
WS = JS[JS.index("async function workspace("):JS.index("/* The Agents and Spend storylines")]


def test_trust_and_governance_use_compact_lines_not_module_tables():
    assert WS.count("moduleLines(w.modules") == 2
    assert "<th>Publisher</th>" not in WS and "<th>Module</th>" not in WS.split("name==='governance'")[1].split("const story")[0]
    assert "healthPill" not in WS


def test_compact_line_links_to_the_module_page():
    body = JS[JS.index("const moduleLines="):JS.index("let HOPEN")]
    assert "openModule(m.name)" in body and "No modules installed." in body


def test_config_tab_has_its_own_state_per_page():
    assert "SETTINGS_TAB=" not in JS and "SETTINGS_TAB==" not in JS
    body = JS[JS.index("const SETTINGS_TABS"):JS.index("async function viewerSettings")]
    assert "const tabKey=prefix||'node'" in body
    assert "SETTINGS_TABS[tabKey]=t[0]" in body and "SETTINGS_TABS[tabKey]||'device'" in body
    assert "settingsPanel('x-'+MP.name+':')" in JS and "settingsPanel('')" in JS


def test_module_overview_lists_its_identities_and_host():
    assert "moduleIdentitiesOf(MP.name)" in JS and 'id="mpids"' in JS
    body = JS[JS.index("async function moduleIdentitiesOf"):JS.index("/* ---------- Settings forms")]
    assert "p.module===name" in body and "p.host" in body
