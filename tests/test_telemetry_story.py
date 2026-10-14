"""D6 of hdash 0.2 (hdash_overview_v2 §5): the Telemetry storyline and its Raw toggle. No browser in CI, so these pin the shipped files."""
import re
from pathlib import Path

JS = (Path(__file__).resolve().parent.parent / "dashboard" / "app.js").read_text()
STORY = JS[JS.index("/* The Telemetry storyline"):JS.index("/* ---------- Per-node drill-down ---------- */")]


def test_question_headline_and_three_charts_in_order():
    assert "How much work are my devices doing?" in STORY
    order = [STORY.index(x) for x in ("Sessions per day, last", "Tokens out by model", "Sessions by device")]
    assert order == sorted(order) and STORY.count("VIZ.bars(") == 3


def test_unknown_price_is_hatched_not_zero_and_the_page_never_maps_model_ids():
    assert "hatch:!v.priced" in STORY and "price unknown" in STORY
    assert "claude-" not in STORY and "opus" not in STORY.lower()


def test_no_extra_reads_beyond_the_page_fetch():
    fn = STORY[STORY.index("function telStory"):STORY.index("const TSEEN")]
    assert "getJSON(" not in fn and "fnode" not in fn                              # the charts draw from the one hive read
    tab = STORY[STORY.index("async function telemetry"):]
    assert tab.count("getJSON(") == 2                                              # the hive read and D5's peers read, as before


def test_raw_is_off_by_default_and_holds_the_filters_and_tables():
    assert "let TRAW=false" in STORY and "aria-pressed=${String(TRAW)}" in STORY
    assert "TRAW?html`${controls}" in STORY and "telemetryBody(t,TP,goTel,true,true,true)" in STORY
    assert "TRAW=true;TF.fmodel" in STORY and "TRAW=true;TF.fday" in STORY          # a row click filters inside Raw, so Raw stays open


def test_the_node_tab_keeps_its_cards():
    assert "telemetryBody(t,NTP,goNodeTel,false)" in JS and "noCards?null" in JS


def test_data_stays_text():
    assert not re.search(r"innerHTML|insertAdjacentHTML", STORY)


def test_story_window_fits_the_daemon_by_day_cap():
    # core _tel_aggregate returns by_day[-21:]; a longer window draws older days as zero and undercounts
    assert "const TEL_DAYS=21;" in JS
    assert "ovDays(TEL_DAYS)" in JS


def test_hiding_raw_clears_the_filters():
    # the chips only render inside Raw, so a filter must not outlive it
    assert "if(!on){TF.fnode=TF.fproject=TF.fagent=TF.fday=TF.fmodel=''" in JS
