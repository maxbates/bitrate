#!/usr/bin/env python3
"""Regression test for drum pad's practice accuracy hint (spec §9).

Asserts the trigger boundaries (29 vs 30 selections, either side of 85%), both
copy branches, the two hypothetical bit rates against an independent reference,
all four dismissal paths, that the figures are static once shown, that the
banner never eats a tap or moves N, and that pixel lens never shows it.

Tier B: Playwright lives here and never ships (spec §4.1). Wired into the gate
workflow, which does install Chromium; with no argument it builds and launches
its own server, exactly like the other suites here.

    pip install -r requirements.txt && playwright install chromium
    python acc_hint_test.py                       # launches its own server
    python acc_hint_test.py http://127.0.0.1:4712 # or drive one already running

It drives the real UI through the pixelDebug hooks; it answers "is it correct",
never "is it better" (spec §7 — nothing here may rank variants).
"""
import atexit
import json, sys
from playwright.sync_api import sync_playwright

from synthetic_player import launch_server

if len(sys.argv) > 1:
    URL = sys.argv[1]
else:
    _proc, URL = launch_server()
    atexit.register(_proc.kill)
URL = URL.rstrip("/")
fails = []

def check(name, ok, detail=""):
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  -- " + str(detail)) if detail else ""))
    if not ok:
        fails.append(name)

def open_game(pw, path, cell_mm, key, touch=True):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 900, "height": 700},
                        has_touch=touch, is_mobile=False)
    ctx.add_init_script(
        "localStorage.setItem(%s, %s)" % (json.dumps(key), json.dumps(
            json.dumps({"cell_mm": cell_mm, "zoom": "auto", "lens_r": 110,
                        "preview": 1, "audio": False}))))
    p = ctx.new_page()
    p.goto(URL + path)
    p.wait_for_function("window.pixelDebug && pixelDebug.state() === 'practice'")
    # The header band settles once after boot (the sparkline and config line
    # paint), and that resize restarts the practice run — so taps dispatched
    # before it lands are counted into a run that gets thrown away.
    p.wait_for_timeout(1500)
    return b, p

def sentences(txt):
    """Sentence count that isn't fooled by the decimal points in the figures."""
    return txt.count(". ") + (1 if txt.rstrip().endswith(".") else 0)

def play(p, n, miss_every):
    """n taps, missing every `miss_every`-th one, ~150 ms apart."""
    before = p.evaluate("pixelDebug.counts().pos")
    for i in range(n):
        p.evaluate("""(miss) => {
            const t = pixelDebug.targetCell();
            const bad = pixelDebug.previewCells();
            let c = t;
            if (miss) { c = (t + 7) % 50; while (c === t || bad.includes(c)) c = (c + 1) % 50; }
            pixelDebug.tapCell(c, 'touch');
        }""", (i % miss_every == miss_every - 1))
        p.wait_for_timeout(150)
    got = p.evaluate("pixelDebug.counts().pos") - before
    assert got == n, "dispatched %d taps but the run recorded %d" % (n, got)

with sync_playwright() as pw:
    # ---- 1. fires in drum pad below the accuracy bar ----
    b, p = open_game(pw, "/env/drum-pad/", 20, "bitrate_drum_settings_v1")
    play(p, 29, 5)  # 5 of the first 29 missed
    # The 30th tap, the reference snapshot and the trigger all in ONE evaluate.
    # The figures scale with elapsed practice time, so anything that lets the
    # 1 Hz tick (or a Playwright round trip) slip in between fires the banner at
    # a different instant than the reference is computed for, and the two then
    # disagree by a few percent for no interesting reason.
    st = p.evaluate("""(() => {
        const t = pixelDebug.targetCell();
        const bad = pixelDebug.previewCells();
        let c = (t + 7) % 50;
        while (c === t || bad.includes(c)) c = (c + 1) % 50;
        pixelDebug.tapCell(c, 'touch');            // 6th miss -> 24/30 = 80%
        const tr = pixelDebug.trailingBps(60000);
        const bits = Math.log2(pixelDebug.config().alphabet_size - 1);
        pixelDebug.tickAccuracyHint();
        return {bps: tr.bps, sc: tr.sc, si: tr.si, bits: bits,
                text: pixelDebug.accHintText()};
    })()""")
    txt = st["text"]
    check("hint fires at 80% over 30 taps", "80%" in txt and "30" in txt, txt)
    check("suggests the next tile size up (20 -> 25 mm)", "25 mm" in txt, txt)
    check("quotes both 95% and 100%", "95%" in txt and "100%" in txt, txt)
    check("one sentence of advice + one of arithmetic",
          sentences(txt) == 2, repr(txt))

    # arithmetic, derived independently from the run's own trailing window
    net = max(st["sc"] - st["si"], 0)
    secs = st["bits"] * net / st["bps"]
    n_sel = st["sc"] + st["si"]
    exp95 = st["bits"] * n_sel * 0.9 / secs
    exp100 = st["bits"] * n_sel / secs
    check("95%% figure matches bits*n*0.9/t (%.1f)" % exp95, ("%.1f" % exp95) in txt, txt)
    check("100%% figure matches bits*n/t (%.1f)" % exp100, ("%.1f" % exp100) in txt, txt)
    check("hypotheticals beat the live trailing bps", exp95 > st["bps"] and exp100 > exp95,
          "live %.1f" % st["bps"])

    # ---- 2. it is static: the text does not move as play continues ----
    play(p, 6, 2)
    check("text stays static while play continues", p.evaluate("pixelDebug.accHintText()") == txt)

    # ---- 3. it does not affect layout (N must not move) ----
    n_before = p.evaluate("pixelDebug.globalN()")
    check("N unchanged while the banner is up", n_before == p.evaluate("pixelDebug.config().alphabet_size"))
    check("banner is transparent to the pointer",
          p.evaluate("getComputedStyle(document.getElementById('acc-hint')).pointerEvents") == "none")
    check("banner is fixed, above the grid",
          p.evaluate("getComputedStyle(document.getElementById('acc-hint')).position") == "fixed")

    # ---- 4. once per practice run ----
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("spent for this run", p.evaluate("pixelDebug.accHintSpent()"))

    # ---- 5. dismissal: opening settings ----
    p.click("#cfg [data-act=settings]")
    p.wait_for_timeout(200)
    check("settings dismisses it", p.evaluate("pixelDebug.accHintText()") == "")
    check("the sheet actually opened", p.evaluate("document.getElementById('sheet').classList.contains('open')"))
    p.keyboard.press("Escape")  # close the sheet
    p.wait_for_timeout(200)

    # ---- 6. a new practice run re-arms it ----
    p.click("#mode-help [data-act=seed]")
    p.wait_for_function("pixelDebug.state() === 'practice' && !pixelDebug.accHintSpent()")
    check("new practice run re-arms the hint", not p.evaluate("pixelDebug.accHintSpent()"))
    play(p, 30, 5)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("fires again on the new practice run", p.evaluate("pixelDebug.accHintText()") != "")

    # ---- 7. dismissal: arming ----
    p.click("#mode-help [data-act=arm]")
    p.wait_for_function("pixelDebug.state() === 'armed'")
    check("arming dismisses it", p.evaluate("pixelDebug.accHintText()") == "")
    check("armed runs never show it",
          (p.evaluate("pixelDebug.tickAccuracyHint(); pixelDebug.accHintText()") == ""))
    p.keyboard.press("Escape")
    p.wait_for_function("pixelDebug.state() === 'practice'")

    # ---- 8. dismissal: the 10 s timer ----
    play(p, 30, 5)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("up again for the timer test", p.evaluate("pixelDebug.accHintText()") != "")
    p.wait_for_timeout(9000)
    check("still up at 9 s", p.evaluate("pixelDebug.accHintText()") != "")
    p.wait_for_timeout(1600)
    check("gone by 10.6 s", p.evaluate("pixelDebug.accHintText()") == "")
    b.close()

    # ---- 9. good accuracy never triggers it ----
    b, p = open_game(pw, "/env/drum-pad/", 20, "bitrate_drum_settings_v1")
    play(p, 30, 100)  # no misses
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("100% accuracy: no hint", p.evaluate("pixelDebug.accHintText()") == "")
    # 4 of 30 missed -> 86.7%, just above the bar
    play(p, 30, 8)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    acc = p.evaluate("(() => { const t = pixelDebug.trailingBps(60000); return t.sc/(t.sc+t.si); })()")
    check("above the 85%% bar (%.1f%%): no hint" % (100 * acc),
          acc > 0.85 and p.evaluate("pixelDebug.accHintText()") == "")
    b.close()

    # ---- 10. fewer than 30 selections never triggers it ----
    b, p = open_game(pw, "/env/drum-pad/", 20, "bitrate_drum_settings_v1")
    play(p, 20, 2)  # 50% accuracy, but only 20 taps
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("29 or fewer selections: no hint", p.evaluate("pixelDebug.accHintText()") == "")
    play(p, 12, 2)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("fires once past 30", p.evaluate("pixelDebug.accHintText()") != "")
    b.close()

    # ---- 11. largest tile: different advice, still one sentence ----
    b, p = open_game(pw, "/env/drum-pad/", 25, "bitrate_drum_settings_v1")
    play(p, 30, 5)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    txt = p.evaluate("pixelDebug.accHintText()")
    check("at 25 mm it does not suggest a bigger tile", "mm" not in txt, txt)
    check("at 25 mm it suggests slowing down", "biggest tiles" in txt, txt)
    check("still two sentences", sentences(txt) == 2, repr(txt))
    b.close()

    # ---- 12. pixel lens (mouse) is untouched ----
    b, p = open_game(pw, "/env/pixel-lens/", 5, "bitrate_pixel_settings_v1", touch=False)
    for i in range(30):
        p.evaluate("""(miss) => {
            const t = pixelDebug.targetCell();
            pixelDebug.tapCell(miss ? (t + 11) % 200 : t, 'mouse');
        }""", i % 5 == 4)
        p.wait_for_timeout(50)
    p.evaluate("pixelDebug.tickAccuracyHint()")
    check("pixel lens never shows it", p.evaluate("pixelDebug.accHintText()") == "")
    b.close()

print()
if fails:
    print("FAILED: " + ", ".join(fails))
    sys.exit(1)
print("all checks passed")
