"""D4 of hdash 0.2 (hdash_overview_v2 §4): Corpus sub-tabs and the tag picker. No browser in CI, so these pin the shipped files."""
import re
from pathlib import Path

JS = (Path(__file__).resolve().parent.parent / "dashboard" / "app.js").read_text()
CORPUS = JS[JS.index("/* ---------- Corpus ---------- */"):JS.index("/* ---------- Hive ---------- */")]


def test_the_five_sub_tabs_and_their_searches():
    for sub in ("search", "latest-facts", "latest-decisions", "ideas", "entities"):
        assert f"'{sub}'" in CORPUS or f"{sub}:" in CORPUS, sub
    assert "'latest-facts':{kind:'fact',sort:'recency'}" in CORPUS and "'latest-decisions':{kind:'decision',sort:'recency'}" in CORPUS
    assert "ideas:{kind:'idea'" in CORPUS and "'/api/entities'" in CORPUS
    assert "/^corpus(?:\\/([a-z-]+))?$/" in JS                                  # the sub-tab is in the hash


def test_entities_is_the_operators_only():
    assert "SUBS.filter(s=>!(VIEWER&&s[0]==='entities'))" in CORPUS
    assert "if(C.sub==='entities'&&VIEWER) applySub('search')" in CORPUS
    assert "(VIEWER&&sub==='entities')" in JS
    assert "'/api/entities'" in JS[JS.index("const VIEWER_NO"):JS.index("function viewerUrl")]


def test_tag_or_is_one_single_tag_call_per_tag_capped_at_eight():
    assert "OR_MAX=8" in CORPUS and "C.tags.slice(0,OR_MAX)" in CORPUS
    assert "tags.map(t=>getJSON(" in CORPUS and "tag:t}" in CORPUS
    assert "new Map()" in CORPUS and "r.sid||r.ref||r.id" in CORPUS             # merged by short id
    assert "p.set('tag',C.tags[0])" in CORPUS and "tag:C.tags[0]" in CORPUS     # AND still asks for one tag
    assert "tag_mode" not in CORPUS                                             # core L1 is not assumed
    assert "C.mode==='or'?scanOr:scanAnd" in CORPUS and "mode:'and'" in CORPUS   # AND by default


def test_noise_rules():
    noise = re.compile(re.search(r"const NOISE_TAG=/(.+?)/,", CORPUS).group(1))
    ver = re.compile(re.search(r"VER_TAG=/(.+?)/,", CORPUS).group(1))
    for t in ("100", "054778e984", "abc1234"):
        assert noise.search(t), t
    for t in ("hwatch", "decade", "2.0.1", "1.11"):
        assert not noise.search(t), t
    assert ver.search("2.0.1") and ver.search("3.x") and not ver.search("hwatch")
    assert "versions (" in CORPUS and "show all" in CORPUS and "hideNoise=!C.showAll&&!q" in CORPUS   # typing finds a hidden tag
