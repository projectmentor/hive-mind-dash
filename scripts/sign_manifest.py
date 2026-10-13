#!/usr/bin/env python3
"""Regenerate and sign `module.json`, or check it.

    HDASH_PUBLISHER_SEED=<64 hex> python3 -I scripts/sign_manifest.py [--core DIR]
    python3 -I scripts/sign_manifest.py --check [--core DIR]

Signing rewrites `files` (every `git ls-files` path except the manifest and its signature, with its sha256),
takes `publisher` from the seed, keeps every other field of the committed manifest, and writes `module.json`
and `module.json.sig` (Ed25519 over the exact manifest bytes). The seed comes from the environment only, never
from a file in the tree and never from the command line, and is never printed.

`--check` needs no seed. It verifies the committed manifest the way `hive-mind module add` does: well-formed,
signature valid under the manifest's own publisher, every tracked file listed with a matching digest, nothing
listed that is missing. Exit 0 if the tree is installable, 1 with the reason if not.

The Ed25519 code is the core's (`h:a2588f7edc`): `ed25519.py` from the core checkout named by `--core`, else
`HDASH_CORE`, else `HIVE_HOME`.
"""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST, SIGNATURE = "module.json", "module.json.sig"
DEFAULTS = {
    "name": "hdash",
    "version": "0.1.0",
    "min_core": "3.1",
    "contract": 1,
    "cli": {"name": "hdash", "command": ["python3", "-I", "hdash"]},
    "service": {"command": ["python3", "-I", "hdash", "serve"], "restart": "always"},
    "doctor": ["python3", "-I", "hdash", "doctor"],
    "reads": ["overview", "tags", "related", "audit", "peers", "verify"],
    "config_schema": {
        "port": {"type": "int", "min": 1024, "max": 65535, "default": "9896", "scope": "node",
                 "description": "Loopback port the dashboard listens on"},
    },
}


def die(msg):
    print(f"sign_manifest: {msg}", file=sys.stderr)
    sys.exit(1)


def load_ed25519(core):
    core = core or os.environ.get("HDASH_CORE") or os.environ.get("HIVE_HOME")
    if not core or not (Path(core) / "ed25519.py").is_file():
        die("no core checkout: pass --core DIR (or set HDASH_CORE or HIVE_HOME) to a directory holding ed25519.py")
    sys.path.insert(0, str(core))
    import ed25519
    return ed25519


def tracked_files(root):
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"], check=True, capture_output=True).stdout
    return sorted(n.decode() for n in out.split(b"\x00") if n and n.decode() not in (MANIFEST, SIGNATURE))


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def render(manifest):
    return (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()


def sign(root, core):
    ed25519 = load_ed25519(core)
    seed_hex = os.environ.get("HDASH_PUBLISHER_SEED", "").strip()
    try:
        seed = bytes.fromhex(seed_hex)
        assert len(seed) == 32
    except (ValueError, AssertionError):
        die("HDASH_PUBLISHER_SEED must be 64 hex characters (a 32-byte seed)")
    try:
        old = json.loads((root / MANIFEST).read_text())
    except (OSError, ValueError):
        old = {}
    manifest = {**DEFAULTS, **{k: v for k, v in old.items() if k not in ("files", "publisher")}}
    manifest["publisher"] = base64.b64encode(ed25519.pub_from_seed(seed)).decode()
    manifest["files"] = {rel: sha256_file(root / rel) for rel in tracked_files(root)}
    raw = render(manifest)
    (root / MANIFEST).write_bytes(raw)
    (root / SIGNATURE).write_text(base64.b64encode(ed25519.sign(raw, seed)).decode() + "\n")
    print(f"signed {MANIFEST}: {len(manifest['files'])} files, publisher {manifest['publisher']}")


def check(root, core):
    ed25519 = load_ed25519(core)
    try:
        raw = (root / MANIFEST).read_bytes()
        m = json.loads(raw)
        sig = base64.b64decode("".join((root / SIGNATURE).read_text().split()), validate=True)
        pub = base64.b64decode(m["publisher"], validate=True)
        files = m["files"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        die(f"{MANIFEST} or {SIGNATURE} is missing or malformed: {e}")
    if not ed25519.verify(raw, sig, pub):
        die("the manifest signature is not valid under its publisher key")
    tracked = set(tracked_files(root))
    if tracked - set(files):
        die(f"tracked files the manifest does not list: {', '.join(sorted(tracked - set(files))[:5])}")
    if set(files) - tracked:
        die(f"manifest lists files that are not tracked: {', '.join(sorted(set(files) - tracked)[:5])}")
    for rel, digest in sorted(files.items()):
        if sha256_file(root / rel) != digest:
            die(f"{rel!r} does not match its manifest digest")
    print(f"{MANIFEST} ok: {len(files)} files, signature valid")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="verify the committed manifest; needs no seed")
    ap.add_argument("--core", help="core checkout holding ed25519.py (default HDASH_CORE, then HIVE_HOME)")
    ap.add_argument("--root", default=str(ROOT), help="the module tree (default: this repository)")
    args = ap.parse_args(argv)
    root = Path(args.root)
    (check if args.check else sign)(root, args.core)


if __name__ == "__main__":
    main()
