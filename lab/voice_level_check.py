#!/usr/bin/env python3
"""voice-babble mic level check — correctness suite (spec §3a, §5).

The onset trigger used to be a hand-tuned constant that had to suit every mic
and every room; it is now measured per player (silent window for the room,
"one two three four five" for the voice, trigger at the log-midpoint). This
drives that measurement in a real browser over synthesized frames — same
percentiles, same threshold algebra, same live segmenter replayed for the
syllable count — and asserts:

  - a fresh profile lands on the level check BEFORE template calibration
    (templates recorded through a wrong trigger are captured off noise)
  - across quiet / very quiet / hot-mic / noisy / silent rooms the trigger
    always lands strictly between the room and the voice
  - a noisy room is reported as noisy, and a dead mic as a dead mic — the two
    diagnoses give opposite advice, so they must not be conflated
  - the check is skippable, and a skip falls back to the middle preset
  - a stored measurement is used and skips the check; a stale one is discarded
  - the game still plays afterwards

Correctness only — nothing here may rank a variant (spec §7).

Tier B: Playwright lives here and never ships (spec §4.1).

Usage:
    pip install -r requirements.txt && playwright install chromium
    python voice_level_check.py [--url URL]
"""

import argparse
import math
import re
import sys

from playwright.sync_api import sync_playwright

from synthetic_player import launch_server

# name, room rms, voice rms, words spoken, what the result must say
SCENARIOS = [
    ("quiet room, normal voice", 0.0015, 0.06, 5, {"clean": True}),
    ("very quiet room, soft voice", 0.0004, 0.012, 5, {"clean": True}),
    ("hot mic, loud voice", 0.002, 0.25, 5, {"clean": True}),
    ("noisy room", 0.02, 0.06, 5, {"noisy": True, "heardNothing": False}),
    ("nothing said", 0.002, 0.0021, 5, {"heardNothing": True}),
    ("only three words", 0.0015, 0.06, 3, {"syllables": 3, "clean": False}),
    # Reported from a real session: AirPods, talking loudly, 5 dB headroom and
    # the check never heard a word. `ambient·2.5` is 1.4x the voice at that
    # ratio, so the trigger sat above the loudest frame the player could
    # produce. A trigger the voice cannot reach is dead, never merely strict.
    ("airpods, 5 dB headroom", 0.034, 0.06, 5, {"heardNothing": False}),
]

# The AGC case, which needs its own frame shape rather than a flat room level:
# a Bluetooth chain winds the gain up through the silent window and back down
# over speech, so the dedicated quiet window reads far hotter than the pauses
# inside the phrase. Measuring the room from those pauses is the fix.
AGC = {"ambient": 0.002, "speech": 0.05, "words": 5, "ambientWindow": 0.03}

FALLBACK_FLOOR = 0.003  # SENS.med — what `auto` uses before it has measured


def db(x: float) -> float:
    return 20 * math.log10(max(x, 1e-7))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="base URL of a running server")
    args = ap.parse_args()

    proc = None
    base = args.url
    if not base:
        proc, base = launch_server()
    url = base.rstrip("/") + "/env/voice-babble/"
    fails: list[str] = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
            ])
            ctx = browser.new_context(permissions=["microphone"])
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)

            # 1. Level check first, calibration second.
            page.wait_for_selector("#level:not([hidden])", timeout=10_000)
            if not page.locator("#calib").is_hidden():
                fails.append("calibration showed before the level check")
            if not page.locator("#topbar").is_hidden():
                fails.append("the header band showed during the level check")
            step = page.locator("#lv-step").inner_text().lower()
            if "room" not in step:
                fails.append(f"first step was {step!r}, expected the room window")
            print(f"  flow: level check first ({step})")

            # 2. The measurement, over synthetic frames.
            for name, amb, sp, words, want in SCENARIOS:
                r = page.evaluate("o => window.voiceDebug.measureFake(o)",
                                  {"ambient": amb, "speech": sp, "words": words})
                bad = [f"{k}={r[k]!r} (wanted {v!r})" for k, v in want.items() if r[k] != v]
                # The invariant that must hold everywhere, including rooms too
                # loud to serve well: the trigger has to be REACHABLE. A
                # threshold above a level the measured voice actually hit is
                # dead, not strict — the game cannot respond to anything.
                if not r["heardNothing"] and not r["thr"] < r["speech"]:
                    bad.append(f"trigger {r['thr']:.5f} is at or above the voice "
                               f"{r['speech']:.5f} — nothing could ever register")
                # In a room with real headroom it should also clear the room.
                if not r["heardNothing"] and not r["noisy"] \
                        and not (r["ambient"] < r["thr"]):
                    bad.append(f"trigger {r['thr']:.5f} below the room {r['ambient']:.5f}")
                print(f"  {'ok  ' if not bad else 'FAIL'} {name}: "
                      f"room {db(amb):.0f} dB, voice {db(sp):.0f} dB -> "
                      f"trigger {db(r['thr']):.0f} dB, {r['syllables']} syllables, "
                      f"headroom {r['snrDb']:.0f} dB, clean={r['clean']}")
                if bad:
                    fails.append(f"{name}: " + "; ".join(bad))

            # 2b. The AGC case: a silent window far hotter than the pauses
            #     inside the phrase. Reading the room from the pauses is what
            #     keeps the headroom real and the trigger reachable.
            r = page.evaluate("o => window.voiceDebug.measureFake(o)", AGC)
            r.setdefault("processed", False)
            r.setdefault("quiet", r["ambient"])
            r.setdefault("gaps", r["ambient"])
            print(f"  {'ok  ' if r['processed'] and r['thr'] < r['speech'] else 'FAIL'} "
                  f"agc-flattened mic: quiet window {db(r['quiet']):.0f} dB vs "
                  f"phrase gaps {db(r['gaps']):.0f} dB -> room taken as "
                  f"{db(r['ambient']):.0f} dB, trigger {db(r['thr']):.0f} dB, "
                  f"{r['syllables']} syllables, processed={r['processed']}")
            if not r["processed"]:
                fails.append("AGC-flattened mic not flagged as processed — the panel "
                             "would tell a user in a silent room to find a quieter one")
            if not r["thr"] < r["speech"]:
                fails.append(f"AGC case: trigger {r['thr']} not reachable by voice {r['speech']}")
            if r["syllables"] != 5:
                fails.append(f"AGC case: heard {r['syllables']} of 5 syllables")
            # Reading the room from the hot silent window instead of the gaps
            # is the bug being guarded against.
            if not r["ambient"] < AGC["ambientWindow"] * 0.75:
                fails.append(f"AGC case: room {r['ambient']} took the inflated quiet "
                             f"window {AGC['ambientWindow']} rather than the gaps")

            # 2c. The energy path must be band-limited to the recognizer's own
            #     band. A full-band RMS counts rumble the classifier never
            #     looks at; because the voice adds energy only inside the band,
            #     the two sum in quadrature and a clear speaker in a silent
            #     room measures ~5 dB of headroom on ANY microphone. That was
            #     the real bug behind the AirPods report, which is why it
            #     reproduced on the built-in mic too.
            band = page.evaluate("window.voiceDebug.band()")
            ok = band["hp"] >= 80 and band["lp"] <= 8000
            print(f"  {'ok  ' if ok else 'FAIL'} vad energy band-limited to "
                  f"{band['hp']}-{band['lp']} Hz")
            if not ok:
                fails.append(f"VAD energy band {band} does not bracket the speech band")

            # ...and the filter has to actually do it. Render the same chain
            # offline and measure its response, rather than trusting that a
            # biquad named "highpass" is placed and configured correctly.
            resp = page.evaluate("""async () => {
              const { hp, lp } = window.voiceDebug.band();
              const sr = 48000, len = sr / 2, out = {};
              for (const f of [50, 60, 100, 300, 1000, 3000, 12000]) {
                const ctx = new OfflineAudioContext(1, len, sr);
                const mk = (type, hz) => {
                  const b = ctx.createBiquadFilter();
                  b.type = type; b.frequency.value = hz; b.Q.value = Math.SQRT1_2;
                  return b;
                };
                const osc = ctx.createOscillator();
                osc.frequency.value = f;
                osc.connect(mk('highpass', hp)).connect(mk('highpass', hp))
                   .connect(mk('lowpass', lp)).connect(ctx.destination);
                osc.start();
                const d = (await ctx.startRendering()).getChannelData(0);
                let s = 0, n = 0;                      // skip the settling transient
                for (let i = (d.length >> 1); i < d.length; i++) { s += d[i] * d[i]; n++; }
                out[f] = 20 * Math.log10(Math.sqrt(s / n) / Math.SQRT1_2);
              }
              return out;
            }""")
            shape = " · ".join(f"{f}Hz {resp[f]:+.0f}" for f in sorted(resp, key=int))
            rumble_cut = -resp["50"]
            passband = max(abs(resp["300"]), abs(resp["1000"]), abs(resp["3000"]))
            ok = rumble_cut >= 15 and passband <= 3
            print(f"  {'ok  ' if ok else 'FAIL'} filter response (dB): {shape}")
            if rumble_cut < 15:
                fails.append(f"50 Hz rumble only cut by {rumble_cut:.0f} dB — the whole "
                             "point is that it stops setting the trigger")
            if passband > 3:
                fails.append(f"speech band bent by {passband:.0f} dB — the filter is "
                             "eating what the recognizer needs")

            # The quadrature arithmetic itself, in the units the check uses:
            # a rumble floor under a clear voice must not eat the headroom.
            import math
            rumble, voice = 0.020, 0.030
            full_band = 20 * math.log10(math.hypot(rumble, voice) / rumble)
            in_band = 20 * math.log10(math.hypot(0.002, voice) / 0.002)
            print(f"  ok   same room measured full-band reads {full_band:.0f} dB "
                  f"headroom, band-limited {in_band:.0f} dB")
            if full_band > 8:
                fails.append("quadrature model wrong — revisit the premise")

            # 3. Skippable, and the skip falls back to the middle preset.
            page.evaluate("window.voiceDebug.skipLevel()")
            page.wait_for_selector("#calib:not([hidden])", timeout=5_000)
            floor = page.evaluate("window.voiceDebug.absFloor()")
            print(f"  flow: skip -> calibration, fallback floor {floor}")
            if abs(floor - FALLBACK_FLOOR) > 1e-9:
                fails.append(f"skip fallback floor was {floor}, wanted {FALLBACK_FLOOR}")

            # 4. A stored measurement is used, and skips the check.
            page.evaluate("""
              localStorage.setItem('bitrate_voice_level_v1', JSON.stringify(
                {v: 2, at: Date.now(), ambient: 0.0015, speech: 0.06, thr: 0.0092, snrDb: 32}));
            """)
            page.reload()
            page.wait_for_selector("#calib:not([hidden]), #stage:not([hidden])", timeout=10_000)
            floor = page.evaluate("window.voiceDebug.absFloor()")
            print(f"  persistence: stored measurement -> floor {floor}")
            if abs(floor - 0.0092) > 1e-9:
                fails.append(f"stored measurement ignored: floor {floor}")
            if not page.locator("#level").is_hidden():
                fails.append("level check re-ran despite a fresh stored measurement")

            # 5. A stale one is discarded — a threshold from another room is
            #    worse than none.
            page.evaluate("""
              const m = JSON.parse(localStorage.getItem('bitrate_voice_level_v1'));
              m.at = Date.now() - 7 * 3600 * 1000;
              localStorage.setItem('bitrate_voice_level_v1', JSON.stringify(m));
            """)
            page.reload()
            page.wait_for_selector("#level:not([hidden])", timeout=10_000)
            print("  expiry: a 7 h old measurement is discarded and re-measured")

            # 6. The game still plays.
            page.evaluate("window.voiceDebug.skipLevel()")
            page.wait_for_selector("#calib:not([hidden])", timeout=5_000)
            page.evaluate("window.voiceDebug.calibrateFake()")
            page.reload()
            page.wait_for_selector("#level:not([hidden])", timeout=10_000)
            page.evaluate("window.voiceDebug.skipLevel()")
            page.wait_for_selector("#stage:not([hidden])", timeout=5_000)
            page.evaluate("""
              const cur = document.querySelector('.note.cur, .chip.cur');
              window.voiceDebug.say(cur.textContent.trim());
            """)
            page.wait_for_timeout(1200)
            counts = page.evaluate("document.getElementById('hud-counts').textContent")
            # Chromium's fake audio device emits a constant tone, so the live
            # VAD contributes selections of its own here; only assert that the
            # deliberate one landed.
            sc = int(re.search(r"Sc (\d+)", counts).group(1))
            print(f"  play: a correct selection scores ({counts})")
            if sc < 1:
                fails.append(f"a correct selection did not score: {counts!r}")

            if errors:
                fails.append("page errors: " + "; ".join(errors))
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
    print("voice level check: all assertions passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
