# bit-rate

A game that maximizes the bit rate a human can push through a computer
interface, scored as

```
B = log2(N − 1) · max(Sc − Si, 0) / t     bits per second
```

## Run it

```
bash run.sh
```

That's it — no installation, no network, no runtime dependencies. The script
starts a small local server (loopback only), prints a URL, and opens your
browser; if the browser doesn't open, paste the printed URL into one. Works
fully offline. Linux (x86_64 / arm64) is the supported platform; macOS
binaries are included as a courtesy.

## How to play

- You start in **practice** — type the letter at the caret. The stream is
  self-paced: it advances only when you type.
- The one strategy worth knowing: **miss → backspace → retype.** An
  uncorrected error costs you −2 net; correcting it turns that into +1.
- Press **Enter** to arm the scored run. Your **first keypress starts the
  60-second clock** — take your time, the buffer is already visible.
- After 60.000 s, input freezes and the results card shows your bit rate
  with N, Sc, Si, and a breakdown of where the bits went.
- Ending a scored run early takes Esc twice. Losing window focus mid-run
  invalidates the run (it never scores); Enter re-arms with a fresh sequence.

## The accounting, stated up front

- **Targets are i.i.d. uniform** over 26 lowercase letters, sampled
  server-side with a seeded generator. Repeats appear (they must — marked
  with a subtle underline). No language model, no predictive text anywhere.
- **N = 27**: 26 letters plus the reserved backspace key, which the scoring
  formula's own definition counts among the possible selections (its
  reference example prices N=30 as log2(29)). Bits per selection:
  log2(26) ≈ 4.70.
- **Backspace is a scored selection**: correct iff it deletes an uncorrected
  error immediately behind the cursor, incorrect otherwise. Every keypress
  has a deterministic verdict; ground truth is never ambiguous.
- **The timer starts at your first scored keypress**, not page load — the
  session is the 60.000 s from that press, measured on the keystroke event's
  own timestamp. Keys pressed before the boundary count even if processed
  after it.
- **The visible lookahead does not break i.i.d.** — the future draws are
  already fixed; seeing them adds no exploitable structure. It exists
  because reading ahead is how humans overlap perception with motor output.
- The live bit-rate HUD updates once per second from page load; the final
  score is recomputed server-side from the keystroke log. Everything stays
  on your machine.

## Why this design

Rough throughput for unpredictable targets on commodity hardware: touch
typing ~20–40 bits/s at the practiced ceiling; mouse pointing ~4–10
(Fitts-bound, serial); gaze or voice lower still once recognition latency
is paid. The keyboard wins structurally — ten parallel, discrete,
overlearned effectors with no acquisition cost per target. The alphabet
stops at 26 letters because that is where an ordinary typist's overlearned
motor repertoire ends: log2 gains from a larger symbol set are erased by
Hick's-law decision time and error double-penalties the moment you leave
well-trained keys.

For calibration: the best invasive brain–computer interface in the
literature this scoring formula comes from reports ~8.6 bits/s. A first-time
player on this game typically lands 7–12; practiced typists clear 20. The
interface, not the human, is usually the bottleneck — which is exactly what
makes measuring the channel interesting.
