#!/usr/bin/env python3
"""The ship gate (spec §8) — this test can never break.

Proves the single most important property of the project: a grader unzips
the bundle and `bash run.sh` works, offline, first try.

    1. build dist/bitrate.zip (cross-compiled ship binaries)
    2. unzip into a fresh temp dir — no repo, no venv, no prior state
    3. `bash run.sh` exactly as a grader would
    4. drive a full scored run with the synthetic player (headless browser)
    5. assert: results render (bps/N/Sc/Si + diagnostics), score matches the
       reference implementation, zero requests leave localhost

The gate proves the mechanical path, not the human one — the manual
Wi-Fi-off ritual on a clean Linux box before submitting is still required.

Usage:
    python ship_gate.py [--no-build] [--zip PATH] [--cps 12]
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from synthetic_player import run

REPO = Path(__file__).resolve().parent.parent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-build", action="store_true", help="use the existing zip")
    ap.add_argument("--zip", default=str(REPO / "dist" / "bitrate.zip"))
    ap.add_argument("--cps", type=float, default=12.0)
    args = ap.parse_args()

    if not args.no_build:
        print("==> build")
        subprocess.run(["bash", str(REPO / "build.sh")], check=True)

    zip_path = Path(args.zip)
    assert zip_path.exists(), f"missing {zip_path}"

    tmp = Path(tempfile.mkdtemp(prefix="bitrate-gate-"))
    proc = None
    try:
        print(f"==> unzip into fresh dir: {tmp}")
        # Extract like a grader's archive tool would — then rely on run.sh's
        # own chmod to recover exec bits, proving that path works.
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(tmp)
        assert (tmp / "run.sh").exists() and (tmp / "README.md").exists(), \
            "zip missing run.sh/README.md"

        print("==> bash run.sh")
        proc = subprocess.Popen(
            ["bash", "run.sh"], cwd=tmp,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, "BITRATE_NO_BROWSER": "1"},  # don't pop a tab during the gate
        )
        url = None
        deadline = time.time() + 30
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
            proc.terminate()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
