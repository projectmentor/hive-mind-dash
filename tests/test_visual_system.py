"""D1 of hdash 0.2 (hdash_overview_v2 §2, §3, §9): viz.js, the request queue and the visual system. There is no browser in CI, so
these read the shipped files for the rules the CSP and the `html` helper impose."""
import importlib.machinery
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_loader = importlib.machinery.SourceFileLoader("hdash", str(ROOT / "hdash"))
hdash = importlib.util.module_from_spec(importlib.util.spec_from_loader("hdash", _loader))
_loader.exec_module(hdash)
D = ROOT / "dashboard"
VIZ, APP, CSS, INDEX = [(D / n).read_text() for n in ("viz.js", "app.js", "app.css", "index.html")]
TOKENS = ("--bg", "--surface", "--elevated", "--ink", "--dim", "--muted", "--line", "--accent", "--ok", "--warn", "--bad",
          "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--grid", "--shim")


def test_viz_is_a_static_asset_on_both_listeners():
    assert hdash.PAGES["/viz.js"] == "viz.js" and "viz.js" in hdash.STATIC
    assert "/viz.js" in hdash.VIEWER_PAGES
    assert '<script src="viz.js"></script>' in INDEX and INDEX.index("viz.js") < INDEX.index("app.js")


def test_viz_follows_the_csp_and_html_rules():
    assert not re.search(r'style\s*=\s*"|<style|innerHTML|insertAdjacentHTML|createElement|eval\(|var\(|#[0-9a-fA-F]{3,6}\b', re.sub(r"/\*.*?\*/", "", VIZ, flags=re.S))
    for helper in ("spark", "bars", "line", "ring", "limits"):
        body = VIZ[VIZ.index(f"function {helper}("):]
        body = body[:body.index("\n  }\n")]
        assert body.count("<svg class=") == 1 and "done()" in body, helper     # one whole <svg> per helper, built in one template
    assert body.count("preserveAspectRatio") <= 1
    assert VIZ.count('preserveAspectRatio="xMidYMid meet"') == 1               # ring only
    assert "export" not in VIZ and "VIZ=" in VIZ.replace(" ", "")


def test_no_literal_colour_outside_the_token_blocks():
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", re.sub(r"'[^']*'", "''", APP.replace("'use strict'", "")))
    outside = re.sub(r"(:root|html\[data-theme=light\])\{[^}]*\}", "", CSS)
    outside = re.sub(r":root:not\(\[data-theme=dark\]\)\{[^}]*\}", "", outside)
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", outside)
    for t in TOKENS:
        assert CSS.count(f"{t}:") >= 3 or t in ("--s1",), t                     # dark, system light and forced light


def test_theme_is_forced_by_attribute_and_remembered_in_a_try():
    assert "prefers-color-scheme: light" in CSS and "html[data-theme=light]" in CSS and ":not([data-theme=dark])" in CSS
    assert "hdash-theme" in APP and re.search(r"try\{[^}]*localStorage\.getItem", APP) and re.search(r"try\{[^}]*localStorage\.setItem", APP)
    assert 'id="hTheme"' in INDEX


def test_motion_is_one_rule_and_reduced_motion_turns_it_off():
    assert "200ms ease-out" in CSS and "prefers-reduced-motion: reduce" in CSS and "animation:none!important" in CSS


def test_the_request_queue_limits_and_retries():
    assert "QMAX=VIEWER?4:6" in APP
    assert "r.status===503" in APP and "'server busy'" in APP and "'busy'" in APP
    assert "300+Math.random()*500" in APP and "tries===0" in APP               # one retry, 300 to 800 ms
    assert "rate limited, try again in a moment" in APP and "e.status=r.status" in APP
