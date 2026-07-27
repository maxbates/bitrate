#!/usr/bin/env python3
"""The ship gate (spec §8) — this test can never break.

Proves the single most important property of the project: someone who has only
the public repo can `bash run.sh` and play, offline, first try.

    1. copy the working tree into a fresh temp dir — no .git, no ledger, no
       venv, no build output, no prior state of any kind
    2. `bash run.sh` exactly as the README tells a reader to
    3. drive a full scored run with the synthetic player (headless browser)
    4. assert: results render (bps/N/Sc/Si + diagnostics), score matches the
       reference implementation, zero requests leave localhost

There is no ZIP any more (spec §8, §1 register item 7 — the submission is the
deployed site plus the public repo), so the gate no longer builds and unzips a
bundle. What it protects is unchanged and still load-bearing: `run.sh` is
requirement 5's artifact and the fallback if the site is down during grading,
so it has to work from a clean tree with nothing but Go installed.

The gate proves the mechanical path, not the human one — the manual
Wi-Fi-off ritual on a clean Linux box before submitting is still required.

Usage:
    python ship_gate.py [--cps 12]
"""

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from synthetic_player import run

REPO = Path(__file__).resolve().parent.parent

# Everything a fresh clone would not carry, plus anything that would let prior
# state leak in and make the gate pass for the wrong reason.
IGNORE = shutil.ignore_patterns(
    ".git", ".github", ".claude", ".gstack", ".context",
    "data", "dist", "bin", ".venv", ".synthetic-data",
    "__pycache__", "*.pyc",
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cps", type=float, default=12.0)
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="bitrate-gate-"))
    tree = tmp / "bitrate"
    proc = None
    try:
        print(f"==> fresh copy of the tree: {tree}")
        shutil.copytree(REPO, tree, ignore=IGNORE, symlinks=True)
        assert (tree / "run.sh").exists() and (tree / "README.md").exists(), \
            "tree missing run.sh/README.md"
        assert not (tree / ".git").exists(), "gate copy carried .git"

        print("==> bash run.sh")
        # `-data` is forwarded by run.sh like any other flag (its own header
        # documents `bash run.sh -addr :4700`). It is passed here only so the
        # gate writes its runs into the temp dir instead of the developer's
        # real ledger at ~/.bitrate/data — the launch path itself is the
        # grader's, unmodified.
        proc = subprocess.Popen(
            ["bash", "run.sh", "-data", str(tmp / "gate-data")], cwd=tree,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, "BITRATE_NO_BROWSER": "1"},  # don't pop a tab during the gate
            # run.sh execs `go run`, which compiles to a temp binary and runs it
            # as a CHILD: terminating the wrapper leaves that child holding the
            # port. Own the whole process group so cleanup actually cleans up.
            start_new_session=True,
        )
        url = None
        # Generous: a cold runner has no Go build cache, and `go run` compiling
        # the server from scratch is the honest cost of shipping no binaries.
        deadline = time.time() + 240
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    raise RuntimeError(f"server exited: {proc.returncode}")
                time.sleep(0.1)
                continue
            m = re.search(r"(http://127\.0\.0\.1:\d+/)", line)
            if m:
                url = m.group(1)
                break
        assert url, "run.sh never printed a URL"
        print(f"    serving {url}")

        print(f"==> synthetic scored run ({args.cps} cps, full 60 s)")
        run(url, cps=args.cps, error_rate=0.04, duration_s=60, seed=7,
            check_requests=True)

        print("==> GATE GREEN")
        return 0
    finally:
        if proc:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
