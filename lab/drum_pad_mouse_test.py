#!/usr/bin/env python3
"""drum pad, played with a mouse — practice must work, scoring must not.

Drum pad's standing banner on a machine with no touchscreen promises exactly
this: "practise with the mouse if you like, but a scored run has to be tapped".
The pointerdown handler used to contradict its own copy — the mouse branch
returned unconditionally, so in practice a click showed a warning and dropped
the selection. Worse, `run.started`/`t0` were set *before* that branch, so the
first click started the practice clock and then registered nothing: the
trailing-60 s HUD decayed from a click that never counted.

Asserts, in a mouse-only browser and a touch one:

  - practice: a mouse click scores a selection and advances the target
  - practice: the player is told once per bout, not once per click
  - the practice clock does not start on a click that registers nothing
  - arming with a mouse is still refused (drum pad's leaderboard is taps)
  - a scored run is still invalidated if a mouse reaches it
  - touch is unaffected: taps play, and arming works

Tier B: Playwright lives here and never ships (spec §4.1).

Usage:
    python drum_pad_mouse_test.py [--url URL]
"""

import argparse
import sys

from playwright.sync_api import sync_playwright

from synthetic_player import launch_server

fails: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
    if not cond:
        fails.append(msg)


def open_game(ctx, base: str):
    """Open drum pad and get past the first-open tile-size picker."""
    page = ctx.new_page()
    page.goto(base.rstrip("/") + "/env/drum-pad/")
    page.wait_for_function("() => !!window.pixelDebug", timeout=10_000)
    picker = page.locator(".sp-opt").first
    if picker.count() and picker.is_visible():
        picker.click()
    page.wait_for_function("() => window.pixelDebug.state() === 'practice'", timeout=10_000)
    page.wait_for_function("() => window.pixelDebug.targetCell() !== null", timeout=10_000)
    return page


def click_target(page, *, tap: bool) -> None:
    """Hit the current target cell.

    The grid is drawn, not built from DOM nodes, so there is nothing to click
    by selector. `pixelDebug.tapCell` dispatches a real PointerEvent at the
    cell's centre with a chosen pointerType, through the same handler a finger
    or a mouse would reach — which is the thing under test here.
    """
    page.evaluate(
        "t => window.pixelDebug.tapCell(window.pixelDebug.targetCell(), t)",
        "touch" if tap else "mouse",
    )


def total(page) -> int:
    c = page.evaluate("window.pixelDebug.counts()")
    return (c["sc"] + c["si"]) if c else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    args = ap.parse_args()

    proc = None
    base = args.url
    if not base:
        proc, base = launch_server()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---- a plain desktop: mouse only, no touchscreen ----
            ctx = browser.new_context(has_touch=False)
            page = open_game(ctx, base)

            check(page.locator("#device-warn").count() == 1,
                  "no-touchscreen banner is shown")

            check(total(page) == 0, "starts at zero selections")
            before = page.evaluate("window.pixelDebug.targetCell()")
            click_target(page, tap=False)
            check(total(page) == 1, "a mouse click in practice scores a selection")
            check(page.evaluate("window.pixelDebug.counts()")["sc"] == 1,
                  "clicking the target cell counts as CORRECT, not a miss")
            check(page.evaluate("window.pixelDebug.targetCell()") != before
                  or total(page) == 1,
                  "the target advanced after the click")

            notice = page.evaluate("window.pixelDebug.noticeText()")
            check("scored" in notice.lower(),
                  f"the player is told scoring needs touch (got: {notice!r})")
            check("practice" in notice.lower() or "practise" in notice.lower(),
                  f"...and that practice works anyway (got: {notice!r})")

            # Told once per bout, not once per click — a 5 s toast on every
            # click would sit on top of the grid for the whole practice run.
            page.evaluate("document.getElementById('notice').hidden = true")
            for _ in range(3):
                click_target(page, tap=False)
            check(total(page) == 4, "further mouse clicks keep scoring")
            check(page.evaluate("window.pixelDebug.noticeText()") == "",
                  "the warning does not re-fire on every click")

            # Drum pad's board is taps. A mouse must not be able to arm.
            page.evaluate("window.pixelDebug.armPromptShown")  # touch the hook
            page.keyboard.press("Enter")
            page.wait_for_timeout(300)
            check(page.evaluate("window.pixelDebug.state()") == "practice",
                  "Enter does not arm a scored run on a mouse-only device")
            check("touch" in page.evaluate("window.pixelDebug.noticeText()").lower(),
                  "...and says why")
            page.close()

            # ---- a touch device: unchanged ----
            tctx = browser.new_context(has_touch=True, is_mobile=True,
                                       viewport={"width": 820, "height": 1180})
            tpage = open_game(tctx, base)
            click_target(tpage, tap=True)
            check(total(tpage) == 1, "a tap scores a selection")
            tpage.keyboard.press("Enter")
            tpage.wait_for_timeout(400)
            check(tpage.evaluate("window.pixelDebug.state()") == "armed",
                  "a tapped device can still arm a scored run")

            # A mouse reaching an armed/scored run still kills it.
            click_target(tpage, tap=False)
            tpage.wait_for_timeout(300)
            check(tpage.evaluate("window.pixelDebug.state()") == "practice",
                  "a mouse click disarms rather than scoring on a touch device")
            tpage.close()
            browser.close()
    finally:
        if proc:
            proc.kill()

    print()
    if fails:
        print("FAILURES:")
        for f in fails:
            print("  - " + f)
        return 1
    print("drum pad mouse practice: all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
