"""The shipped page, pinned: what the hive-mind tests asserted about `dashboard/app.js` before it moved here."""
import re
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "dashboard"
JS, PAGE, CSS = (D / "app.js").read_text(), (D / "index.html").read_text(), (D / "app.css").read_text()


def test_the_page_names_its_own_assets_and_title():
    assert "<title>HiveMind</title>" in PAGE and 'src="logo.svg"' in PAGE


def test_the_dashboard_builds_its_dom_without_executing_data():
    """A tag, fact or peer string is only ever a text node or an attribute value: no markup is built from data, and
    no script runs from an attribute (`new Function` over `data-onclick` was the sink for a tag with a quote)."""
    assert "<script src=\"app.js\"></script>" in PAGE
    assert not re.search(r"<script(?![^>]*\bsrc=)", PAGE) and "<style" not in PAGE      # nothing inline for the CSP to block
    assert not re.search(r"\son[a-z]+\s*=|\sstyle\s*=", PAGE)
    for sink in ("new Function", "eval(", "data-onclick", "javascript:", "document.write", "insertAdjacentHTML", "outerHTML", "esc("):
        assert sink not in JS, sink
    assert re.findall(r"\.innerHTML\s*=", JS) == [".innerHTML="]                         # only html()'s own static template
    assert "t.innerHTML=s;" in JS
    assert "onclick=${e=>{e.stopPropagation();filterTag(t);}}" in JS and ">${t}</span>" in JS
    assert "url(http" not in CSS and "@import" not in CSS


def test_the_page_reads_entities_items_ideas_and_sorts():
    assert "/api/entities" in JS and "e.label" in JS
    assert "/api/item?sid=" in JS and "hashchange" in JS and "history.replaceState" in JS
    assert "r.kind==='idea'" in JS and "d.kind==='idea'" in JS
    assert 'value="importance"' in JS and 'value="utility"' in JS and "sort:'confidence'" in JS


def test_the_page_shows_a_superseding_entry():
    assert "href=${'#'+d.superseded_by_sid}" in JS and "SUPERSEDED by ${d.superseded_by_sid}" in JS
    assert "supPill(d)" in JS and "supPill(x)" in JS and "supEvidence(" in JS
    assert "evidence only, not in effect" in JS


def test_every_api_route_the_page_calls_is_one_hdash_serves():
    import importlib.machinery, importlib.util
    loader = importlib.machinery.SourceFileLoader("hdash", str(D.parent / "hdash"))
    spec = importlib.util.spec_from_loader("hdash", loader)
    hdash = importlib.util.module_from_spec(spec)
    loader.exec_module(hdash)
    called = set(re.findall(r"/api/([a-z]+)", JS))
    served = set(hdash.API_ROUTES) | {"csrf", "config"}      # /api/csrf is the guard's own route; /api/config/records is the viewer listener's
    assert called and called <= served, called - served
