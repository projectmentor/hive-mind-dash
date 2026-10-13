"""Item 10 of hive-mind-dash#18: a setting's plain-language `help` reaches the page as clean text, and the pop-over is
an accessible button that renders text only. No `help` means no icon."""
import importlib.machinery
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
_spec = importlib.util.spec_from_loader("hdash", _loader)
hdash = importlib.util.module_from_spec(_spec)
_loader.exec_module(hdash)
JS = (ROOT / "dashboard" / "app.js").read_text()
CSS = (ROOT / "dashboard" / "app.css").read_text()


def rec(**kw):
    return {"id": "x-demo:k", "class": "module", "type": "string", "description": "d", **kw}


def test_help_text_is_passed_through_and_cleaned():
    out = hdash.record_view(rec(help="The port\x07 for sync.\nChange it rarely.‮"))
    assert out["help"] == "The port for sync. Change it rarely."


def test_help_is_capped_at_the_manifest_limit():
    assert len(hdash.record_view(rec(help="x" * 900))["help"]) == hdash.HELP_MAX == 400


def test_no_help_or_a_non_string_help_leaves_the_field_out():
    assert "help" not in hdash.record_view(rec())
    for bad in (None, "", "   ", 7, ["a"], {"a": 1}):
        assert "help" not in hdash.record_view(rec(help=bad))


def test_help_markup_stays_text_for_the_page():
    out = hdash.record_view(rec(help="<img src=x onerror=alert(1)>"))
    assert out["help"] == "<img src=x onerror=alert(1)>"           # the server only cleans; the page uses textContent
    body = JS[JS.index("function helpIcon"):JS.index("function settingRow")]
    assert "pop.textContent=text" in body and "innerHTML" not in body


def test_the_icon_is_an_accessible_button_that_needs_help_text():
    body = JS[JS.index("function helpIcon"):JS.index("function settingRow")]
    assert "if(typeof text!=='string'||!text.trim()) return null;" in body
    assert 'type="button"' in body and "aria-describedby=" in body and "aria-expanded" in body and "aria-label=" in body
    assert 'role="tooltip"' in body
    assert "'focus'" in body and "'blur'" in body and "'click'" in body          # keyboard focus and tap/click
    assert "e.key==='Escape'" in JS


def test_settings_and_policy_rows_show_the_icon():
    assert "${helpIcon(id,r.help)}" in JS and "${helpIcon(k.id,k.help)}" in JS


def test_the_popover_has_styles_and_stays_inside_the_page():
    assert re.search(r"\.help-pop\{[^}]*max-width|\.help-pop\{[^}]*width:min\(320px,80vw\)", CSS)
    assert ".help-pop[hidden]{display:none}" in CSS


def test_pointer_click_opens_rather_than_toggles():
    # A tap fires mouseenter, focus, click; a toggling click would close what those just opened.
    body = JS[JS.index("function helpIcon"):JS.index("function settingRow")]
    click = body[body.index("addEventListener('click'"):]
    click = click[:click.index("\n")]
    assert "e.detail===0" in click and ":true)" in click
    assert "open(btn.getAttribute('aria-expanded')!=='true')" not in click
