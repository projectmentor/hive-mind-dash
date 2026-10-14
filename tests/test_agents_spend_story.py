"""D7 of hdash 0.2 (hdash_overview_v2 §5): the Agents and Spend storylines and their Raw toggle. No browser in CI, so these pin the shipped files."""
import re
from pathlib import Path

JS = (Path(__file__).resolve().parent.parent / "dashboard" / "app.js").read_text()
STORY = JS[JS.index("/* The Agents and Spend storylines"):]
AGENTS = STORY[STORY.index("async function agentsStory"):STORY.index("/* \"0/h")]
SPEND = STORY[STORY.index("async function spendStory"):]


def test_agents_question_headline_and_charts_in_order():
    assert "What are my agents doing, and is anything stuck?" in AGENTS
    order = [AGENTS.index(x) for x in ("<h2>Sessions by agent</h2>", "<h2>Last seen</h2>")]
    assert order == sorted(order) and AGENTS.count("VIZ.bars(") == 1


def test_spend_question_and_sections_in_order():
    assert "What is this costing, and what stops it running away?" in SPEND
    order = [SPEND.index(x) for x in ("<h2>Cost by model</h2>", "<h2>Write limits per module</h2>")]
    assert order == sorted(order) and "VIZ.limits(" in SPEND


def test_windows_never_exceed_the_daemon_cap_and_fan_out_is_capped():
    assert "const WS_DAYS=21, WS_WEEK=7, WS_AGENTS=8;" in STORY
    assert "ovDays(WS_DAYS)" in AGENTS and "names.slice(0,WS_AGENTS)" in AGENTS
    assert "30 days" not in AGENTS and "30d" not in AGENTS


def test_unknown_price_is_listed_not_zero_and_the_page_never_maps_model_ids():
    assert "Price unknown, so not in the chart or the total" in SPEND and "v.priced" in SPEND
    assert not re.search(r"claude-(opus|sonnet|haiku|fable|mythos)|opus", STORY.lower())
    assert "Cost per day is not reported" in SPEND and "by_day" not in SPEND   # no invented daily cost


def test_a_zero_write_limit_is_not_drawn_as_a_bar():
    assert "no writes allowed" in SPEND and "cap?html" in SPEND


def test_raw_is_off_by_default_and_toggles_without_a_reload():
    assert "let WRAW={agents:false,spend:false}" in STORY
    assert "aria-pressed=${String(!!WRAW[name])}" in JS and "WRAW[name]=!WRAW[name]; wsRaw();" in JS
    assert "put($('#wsraw'),on&&WSD.raw?WSD.raw():null)" in STORY


def test_old_unconditional_model_table_is_gone_and_raw_keeps_the_tables():
    assert "agentsTelemetry" not in JS
    assert "<h2>Module quotas</h2>" in SPEND and "modelRawTable(t)" in SPEND and "<h2>By agent</h2>" in AGENTS


def test_stale_reads_do_not_paint_another_page():
    assert "const wsStory=(name,...nodes)=>{ if(WSD.name===name)" in STORY


def test_data_stays_text_and_no_inline_colour():
    assert not re.search(r"innerHTML|insertAdjacentHTML", STORY)
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b|rgb\(", STORY)


def test_busy_period_note_cites_the_per_device_read_cap():
    assert "at most the newest 2,000 sessions on each device" in STORY and STORY.count("WS_CAP_NOTE}") == 2
