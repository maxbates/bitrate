#!/usr/bin/env python3
"""Synthetic input harness (spec §3a) — a test suite, not a predictor.

Drives the real UI in a headless browser with a configurable inter-key
interval and error rate, then asserts:

  - the timer starts on the first keypress, not page load
  - no dropped keystrokes at high cps (every dispatched selection is scored)
  - client and server scoring agree (no anomaly flag)
  - the results card renders bps / N / Sc / Si
  - the final bps matches this file's independent reference implementation

It answers "is it correct," never "is it better." Any run it generates is
synthetic telemetry; nothing here may be used to rank variants (spec §7).

Tier B: Playwright lives here and never ships (spec §4.1).

Usage:
    pip install -r requirements.txt && playwright install chromium
    python synthetic_player.py [--cps 15] [--error-rate 0.05] [--url URL]

If --url is omitted, the script builds and launches the server itself.
"""

import argparse
import math
import random
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent


def reference_bps(n: int, sc: int, si: int, t: float) -> float:
    """B = log2(N-1) * max(Sc-Si, 0) / t   (Shenoy et al. 2021)."""
    return math.log2(n - 1) * max(sc - si, 0) / t


def launch_server() -> tuple[subprocess.Popen, str]:
    proc = subprocess.Popen(
        ["go", "run", "./server", "-dev", "-no-browser", "-data",
         str(REPO / "lab" / ".synthetic-data")],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    deadline = time.time() + 60
    url = None
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.1)
            continue
        m = re.search(r"(http://127\.0\.0\.1:\d+/)", line)
        if m:
            url = m.group(1)
            break
    if not url:
        proc.kill()
        raise RuntimeError("server did not print a URL")
    return proc, url


def run(url: str, cps: float, error_rate: float, duration_s: int, seed: int,
        check_requests: bool = False) -> None:
    rng = random.Random(seed)
    iki = 1.0 / cps
    requests: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        if check_requests:
            page.on("request", lambda req: requests.append(req.url))
        page.goto(url)
        page.wait_for_selector("#stream .ch", timeout=10_000)

        # Timer must not start on page load: HUD reads 0.0 (spec §2.5).
        assert page.locator("#hud-bps").inner_text().startswith("0.0"), \
            "HUD not 0.0 before first keypress"

        # Arm the scored run; first synthetic keypress starts the clock.
        page.keyboard.press("Enter")
        page.wait_for_selector("#mode-banner.mode-armed", timeout=10_000)

        sc = si = 0
        typed_ok: list[bool] = []  # mirror of the advance-always state
        start = time.monotonic()
        dispatched = 0
        while time.monotonic() - start < duration_s + 0.5:
            # Read the current target from the DOM each press (the .cur span).
            cur = page.locator("#stream .ch.cur")
            if cur.count() == 0:
                break
            target = cur.first.inner_text()
            if typed_ok and not typed_ok[-1]:
                key = "Backspace"          # miss -> backspace -> retype (spec §2.4)
                sc_delta = 1
                typed_ok.pop()
            elif rng.random() < error_rate:
                key = "abcdefghijklmnopqrstuvwxyz".replace(target, "")[0]
                sc_delta = -1
                typed_ok.append(False)
            else:
                key = target
                sc_delta = 1
                typed_ok.append(True)
            page.keyboard.press(key)
            if sc_delta > 0:
                sc += 1
            else:
                si += 1
            dispatched += 1
            time.sleep(iki)

        # Results view must render with bps / N / Sc / Si (spec §8).
        page.wait_for_selector("#results:not([hidden])", timeout=15_000)
        page.wait_for_function(
            "() => !document.querySelector('#res-hero').innerText.includes('verifying')",
            timeout=15_000,
        )
        card = page.locator("#res-hero").inner_text()
        tiles = page.locator("#res-tiles .tile").count()
        charts = page.locator("#res-charts svg").count()
        assert tiles == 6 and charts == 2, \
            f"diagnostics missing: {tiles} tiles, {charts} charts"
        browser.close()

    if check_requests:
        # The ship gate's offline proof: zero requests to non-localhost hosts
        # (spec §8 gate assertion 5).
        bad = [u for u in requests
               if not (u.startswith("http://127.0.0.1") or u.startswith("http://localhost")
                       or u.startswith("data:"))]
        assert not bad, f"non-localhost requests: {bad}"
        print(f"    network: {len(requests)} requests, all localhost")

    m = re.search(r"([\d.]+)\s*bits/s", card)
    assert m, f"no bps on results card:\n{card}"
    got_bps = float(m.group(1))
    counts = re.search(r"N\s*(\d+)\s*·\s*Sc\s*(\d+)\s*·\s*Si\s*(\d+)", card)
    assert counts, f"no N/Sc/Si on results card:\n{card}"
    n, card_sc, card_si = (int(x) for x in counts.groups())

    # No dropped keystrokes: every dispatched in-window selection scored.
    # (The last few presses may fall past the 60 s boundary; allow that.)
    scored = card_sc + card_si
    assert scored <= dispatched, f"scored {scored} > dispatched {dispatched}"
    assert dispatched - scored <= max(3, int(cps)), \
        f"dropped keystrokes: dispatched {dispatched}, scored {scored}"

    want = reference_bps(n, card_sc, card_si, duration_s)
    assert abs(got_bps - want) < 0.01, \
        f"card bps {got_bps} != reference {want:.4f} (N={n} Sc={card_sc} Si={card_si})"
    assert "disagreement" not in card, f"client/server anomaly:\n{card}"

    print(f"OK  cps={cps} err={error_rate}  ->  N={n} Sc={card_sc} Si={card_si} "
          f"bps={got_bps} (dispatched {dispatched})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="running server URL (else build+launch)")
    ap.add_argument("--cps", type=float, default=15.0,
                    help="selections per second (15 stresses the render path)")
    ap.add_argument("--error-rate", type=float, default=0.05)
    ap.add_argument("--duration", type=int, default=60)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    proc = None
    url = args.url
    try:
        if not url:
            proc, url = launch_server()
        run(url, args.cps, args.error_rate, args.duration, args.seed)
    finally:
        if proc:
            proc.terminate()


if __name__ == "__main__":
    main()
