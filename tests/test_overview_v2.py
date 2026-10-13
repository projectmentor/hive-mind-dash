"""D2 of hdash 0.2 (hdash_overview_v2 §3): the Overview as a grid of widgets. No browser in CI, so these pin the shipped files."""
import re
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "dashboard"
APP, CSS = (D / "app.js").read_text(), (D / "app.css").read_text()
OV = APP[APP.index("/* ---------- Overview ---------- */"):APP.index("/* ---------- Corpus ---------- */")]


def test_top_facts_and_recent_decisions_are_gone_from_the_overview():
    assert "Top facts" not in OV and "Recent decisions" not in OV and "factRow" not in OV and "decRow" not in OV
    assert "/api/search?limit=8" not in APP


def test_the_overview_has_the_d2_widgets_and_reads_only_existing_routes():
    for id_ in ("ovFacts", "ovDecs", "ovIdeas", "ovContested", "ovOnline", "ovShield", "ovFleet", "ovMix", "ovAudit", "ovModules", "ovApprovals"):
        assert f"'{id_}'" in OV, id_
    routes = set(re.findall(r"'(/api/[a-z/]+)", OV))
    assert routes == {"/api/overview", "/api/search", "/api/verify", "/api/peers", "/api/audit", "/api/telemetry", "/api/modules"}
    assert "/api/peers?probe=0" in OV and "kind=idea&limit=1" in OV and "ideas_total" in OV
    assert "/v1/series" not in OV and "/api/series" not in OV                   # no new core route (L1)


def test_a_viewer_page_leaves_out_what_the_viewer_listener_refuses():
    fetch = OV[OV.index("function ovFetch"):OV.index("/* One timer")]
    tail = fetch[fetch.index("if(!VIEWER){"):]
    assert "/api/telemetry" in tail and "/api/modules" in tail                   # both inside the operator-only block
    assert "/api/telemetry" not in fetch[:fetch.index("if(!VIEWER){")] and "/api/modules" not in fetch[:fetch.index("if(!VIEWER){")]
    assert "const t=OVD.tel; if(!t||VIEWER) return;" in OV                       # no per-device sparkline reads for a viewer
    assert "${VIEWER?null:widget('w4','ovModules'" in OV and "${VIEWER?null:widget('w4','ovApprovals'" in OV
    assert "${VIEWER?null:spark(d)}" in OV


def test_refresh_period_and_pause():
    assert "OV_EVERY=(VIEWER?120:60)*1000" in OV
    assert "document.hidden" in OV and "visibilitychange" in OV and "clearInterval(OVT)" in OV
    assert "animate:false" in OV and "ovAnim(" in OV                             # a refresh draws in place; only the first paint animates
    assert "updated '+" in OV


def test_device_rows_exclude_module_identities_and_the_sparkline_fan_out_is_capped():
    assert "ps.filter(p=>!isModuleRow(p))" in OV
    assert "OV_SPARK_CAP=8" in OV and ".slice(0,OV_SPARK_CAP)" in OV


def test_every_empty_state_says_why_and_gives_the_command():
    for cmd in ("hive-mind invite", "hv remember", "hv audit", "hive-mind module add hconfig", "hive-mind module add happrove"):
        assert cmd in OV, cmd
    assert OV.count("cmdBlock(") >= 6 and "failText(" in OV                       # a refused read never blames the daemon


def test_data_stays_text_and_no_literal_colour():
    assert not re.search(r"innerHTML|insertAdjacentHTML|style\s*=\s*\"", OV)
    assert not re.search(r"#[0-9a-fA-F]{3,6}\b|rgba?\(", re.sub(r"'[^']*'", "''", OV))


def test_the_hatched_ring_slice_keeps_its_length():
    assert "stroke-dasharray:none" not in CSS and ".viz .hatch{" not in CSS      # a CSS dash rule beats the slice's own dasharray and drew a full circle over the others
    assert ".viz rect.hatch{" in CSS
