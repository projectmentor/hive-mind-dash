"""hdash 0.2 D8 (hive-mind-dash#18): Settings › Node is two tabs, Fleet (governed) and This device (node and module),
grouped by key prefix; an unset key reads `default (N)`; a template key is one row; the page computes no value itself."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = (ROOT / "dashboard" / "app.js").read_text()
BODY = JS[JS.index("/* Fleet = governed keys"):JS.index("async function viewerSettings")]


def test_two_tabs_split_by_class_and_the_old_labels_are_gone():
    assert "k.class==='governed'" in BODY and "k.class!=='governed'" in BODY
    assert "'Fleet'" in BODY and "'This device'" in BODY
    assert "<h3>Per-node</h3>" not in JS and "Core governed keys" not in JS


def test_keys_are_grouped_by_prefix_and_the_node_page_reads_every_prefix_once():
    assert "const prefixOf=" in BODY and "settingsGroups" in BODY
    assert "settingsPanel('')" in JS and "settingsPanel('core:'" not in JS


def test_unset_key_says_default_and_a_template_is_one_row():
    assert "'default ('+showVal(r.default)+')'" in JS and "showVal=v=>v==null?'—'" in JS
    assert "a template: add a key with" in JS and "if(r.template) return" in JS


def test_tab_behaviour_under_node():
    """Kills: the class split swapped; the owner-key note inverted; the tab body inverted; a tab click that re-renders the rows
    (and loses unsaved input) instead of hiding one pane. Needs node; in CI a missing node is a failure."""
    import os
    import subprocess
    import pytest
    from test_queue_behaviour import _node
    node = _node()
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("node is required in CI")
        pytest.skip("node is not installed")
    r = subprocess.run([node, str(ROOT / "tests" / "settings_tabs_behaviour.js"), str(ROOT / "dashboard" / "app.js")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.startswith("ok"), r.stderr + r.stdout


def test_a_tab_click_switches_panes_and_does_not_re_render():
    panel = JS[JS.index("function settingsPanel("):JS.index("async function viewerSettings")]
    assert "settingsTabSwitch(t[0],btns,panes)" in panel
    assert panel.count("settingsGroups(") == 2, "each pane is built once, at load"
    assert "show()" not in panel
