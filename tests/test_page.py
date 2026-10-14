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


def test_module_identities_are_not_listed_as_peer_devices():
    """Core's `/api/peers` rows carry `module` for a module identity (hive-mind 4.x); the page groups those by module
    name under their own heading and leaves the Peers table to devices. A core with no `module` field leaves every row a
    device, so the filter keys on the field being a non-empty string, not on its absence."""
    assert "typeof p.module==='string'&&p.module!==''" in JS
    assert "all.filter(p=>!isModuleRow(p))" in JS and "all.filter(isModuleRow)" in JS
    assert "Module identities" in JS and "${moduleIdentities(g.loose)}" in JS
    assert "g.devices.length} admitted" in JS                   # the Devices count is devices only


def test_d5_module_identities_nest_under_their_host_device():
    """D5 (overview v2 §6): with `host` a module identity nests under its device (collapsed, expandable, linked to
    Modules › name); with no `host`, or a host that is not listed, it stays in the one section grouped by module name. The purge
    hint is on a device row only, and the Telemetry devices list splits the same way."""
    assert "typeof m.host==='string'&&ids.has(m.host)" in JS and "else loose.push(m)" in JS
    assert "aria-expanded=" in JS and "openModule(m.module)" in JS and "setNav('modules')" in JS
    assert "HOPEN[p.device]" in JS and "kids.forEach" in JS
    hive = JS[JS.index("function peerRows"):JS.index("function moduleIdentities")]
    assert "group purge" in hive and "gone?" in hive
    assert "group purge" not in JS[JS.index("function moduleIdentities"):JS.index("async function hive()")]
    # Pin the guards themselves: the substring checks above survive `const gone=true`, `ids.has(m.host)||1`, and a purge
    # hint pasted into a nested row.
    assert "const gone=!p.self&&/stale|offline/.test(p.status);" in hive and "${gone?html`" in hive
    assert "group purge ${p.device}" in hive
    assert "if(typeof m.host==='string'&&ids.has(m.host)) (nested[m.host]" in JS
    rows = [JS[m.start():JS.index("</tr>", m.start())] for m in re.finditer(r"modrow", JS) if "<tr" in JS[max(0, m.start() - 20):m.start()]]
    assert len(rows) == 2                                     # the Hive nested row and the Telemetry one
    assert all("group purge" not in r for r in rows)
    tel = JS[JS.index("async function telemetry()"):JS.index("Per-node drill-down")]
    assert "/api/peers?probe=0" in tel and "isModuleRow(p)" in tel and "Devices</h2>" in tel and "Module identities" in tel

