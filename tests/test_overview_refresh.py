"""Overview refresh behaviour (hive-mind-dash#27): the hidden-tab pause, the failure state when every read fails, OVAT moving only on
a success, and sparklines that do not share a series between devices with one name. Runs under node (tests/overview_refresh.js).
CI must run it: set CI (GitHub sets it) and a missing node is a failure, not a skip."""
import os
import subprocess
from pathlib import Path

import pytest

from test_queue_behaviour import _node

ROOT = Path(__file__).resolve().parent.parent


def test_overview_refresh_behaviour_under_node():
    """Kills: `if(document.hidden) return;` removed from ovTick; OVAT set before the reads return; no failure state; a name-shared fnode read."""
    node = _node()
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("node is required in CI")
        pytest.skip("node is not installed")
    r = subprocess.run([node, str(ROOT / "tests" / "overview_refresh.js"), str(ROOT / "dashboard" / "app.js")], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.startswith("ok"), r.stderr + r.stdout
