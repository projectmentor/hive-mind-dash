"""D1 of hdash 0.2, behaviour tests (hive-mind-dash#25). test_visual_system.py reads the shipped files for strings; these run the
code. The request queue, getJSON and failText run under node (tests/queue_behaviour.js); the motion rules and the `.t(` rule are
checked on the files. CI must run the node test: set CI (GitHub sets it) and a missing node is a failure, not a skip."""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "dashboard"


def _node():
    found = shutil.which("node")
    if found:
        return found
    for cand in sorted((Path.home() / ".nvm" / "versions" / "node").glob("v*/bin/node"), reverse=True):
        if cand.is_file():
            return str(cand)
    return None


def test_request_queue_and_fail_text_behaviour_under_node():
    """Kills: failText 429 -> 428; the `!busy&&r.status!==429` exclusion removed from the viewer note; and the queue limits and retry."""
    node = _node()
    if node is None:
        if os.environ.get("CI"):
            pytest.fail("node is required in CI")
        pytest.skip("node is not installed")
    r = subprocess.run([node, str(ROOT / "tests" / "queue_behaviour.js"), str(D / "app.js")], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.startswith("ok"), r.stderr + r.stdout


# `.t(` takes author-written markup. One string literal and nothing else, so data cannot get in by concatenation.
_LIT = r"""(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")"""
_T_OK = re.compile(r"\.t\(\s*" + _LIT + r"\s*\)")


def t_calls_not_literal(text):
    """The offsets of `.t(` calls whose whole argument is not one string literal."""
    text = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group()), text, flags=re.S)
    return [m.start() for m in re.finditer(r"\.t\(", text) if not _T_OK.match(text, m.start())]


def test_t_argument_checker_catches_data():
    """The checker itself: the shapes a mutant would take."""
    assert t_calls_not_literal("b.t('<g>').t(\"x\")") == []
    for bad in ("b.t('<g class='+x)", "b.t('<g>'+ x +'</g>')", "b.t(x)", "b.t(`<g>`)", "b.t('<g>', x)", "b.t('a' + 'b')"):
        assert t_calls_not_literal(bad), bad


def test_every_t_argument_is_a_string_literal():
    """Kills: data concatenated into a `.t()` literal in viz.js."""
    for name in ("viz.js", "app.js"):
        text = (D / name).read_text()
        bad = [text[:o].count("\n") + 1 for o in t_calls_not_literal(text)]
        assert not bad, f"{name}: .t() argument is not one string literal at line(s) {bad}"
    assert (D / "viz.js").read_text().count(".t('") > 20          # the scan did find the calls


def test_every_motion_duration_is_200ms():
    """Kills: one motion rule changed from 200ms to 300ms. Every animation in the stylesheet and the countUp tick is 200 ms."""
    css = (D / "app.css").read_text()
    anims = re.findall(r"animation:\s*([^;}]*)", css)
    timed = [a for a in anims if "viz-" in a]
    assert len(timed) >= 4
    for a in timed:
        assert re.search(r"\b200ms ease-out\b", a), a
    durations = re.findall(r"\bviz-\w+\s+(\d+m?s)", css)
    assert durations and set(durations) == {"200ms"}, durations
    assert re.search(r"\bdur=200\b", (D / "viz.js").read_text())
