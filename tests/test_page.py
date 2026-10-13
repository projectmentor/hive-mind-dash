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


def test_the_corpus_tag_picker_is_a_multi_select_that_survives_a_revisit():
    """The picker is rebuilt each time the Corpus page opens, so its tag list is kept in `C.tagList` and refilled then
    (a `tagsLoaded` flag once left every later visit with only "All tags"). Several tags are ANDed; bare numbers and
    sha-like ids are hidden by default; the core's single `tag` is the first selection."""
    assert "tagsLoaded" not in JS and "C.tagList" in JS and "tagPickFill();" in JS
    assert 'type="checkbox"' in JS and "C.tags.every(" in JS and "p.set('tag',C.tags[0])" in JS
    pat = re.search(r"const NOISE_TAG=/(.+?)/,", JS).group(1)
    noise = re.compile(pat.replace("(?=", "(?="))
    for t in ("100", "054778e984", "deadbeef01"):
        assert noise.search(t), t
    for t in ("hwatch", "2.0.1", "decade", "gotcha", "1.11"):
        assert not noise.search(t), t


def test_a_model_without_a_price_reads_unpriced_never_zero():
    """A null cost is "unpriced" (the by-model rows, a session and the total), and a total that leaves a model out says so."""
    assert "const fmtCost=c=>c==null?'unpriced':" in JS
    assert "'n/a'" not in JS and JS.count("v.priced?fmtCost(v.cost):'unpriced'") == 2
    assert "priced models only" in JS


def test_an_unset_value_says_default_and_a_manifest_zero_says_manifest():
    assert "'default ('+showVal(r.default)+')'" in JS and "<td>${shownVal(r)}</td>" in JS
    assert "'not set: default ('+showVal(r.default)+')'" in JS
    assert "manifest: none allowed" in JS and "default (${q[k]})" in JS
