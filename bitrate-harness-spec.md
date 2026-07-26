# Bit-Rate Harness — Build Spec

**Audience:** an implementing agent (and future me).
**Goal:** an experiment platform for maximizing human bit rate through a computer interface, plus the polished single-variant game that ships as the deliverable.
**Source of truth:** `swe-homework.pdf` in the repo root is the actual brief — read it before this spec; where they disagree, the PDF wins, and §1's interpretation register lists the readings we've taken. One instruction arrived outside the PDF and is authoritative anyway: **assume a Linux grading environment** (the PDF itself names no platform — do not "correct" the Linux-first packaging on that basis).
**Status (2026-07-22):** spec locked after external review (Codex consult) and reconciliation against the PDF. Nothing is built yet; the next action is §9 build-order step 1. Treat §2's decided positions as decided.

---

## 1. Context

This exists to answer a take-home: *design and build a game that maximizes the bit rate achievable by a human player.* A panel of three graders each play one scored 60-second run after a brief familiarization period. The submitted score is the **average of the three**.

Scoring formula (Shenoy et al. 2021):

```
B = log2(N - 1) * max(Sc - Si, 0) / t     bits per second
```

- `N` — number of possible selections, **including the reserved backspace key** (must be >= 3)
- `Sc` — correct selections within window `t`
- `Si` — incorrect selections within window `t`
- `t` — elapsed seconds

**Three structural facts that drive every decision below:**

1. `B` factors into *(bits per selection)* x *(net correct selections per second)*. These trade against each other. Optimizing one in isolation is the default failure mode.
2. Errors are **double-penalized**. A wrong selection forfeits the `+1` you would have earned *and* subtracts `1`. The optimum therefore sits at high accuracy with speed second — not the reverse.
3. **The −1 is a backspace, and it counts in N.** The brief reserves one of the N selections for error correction ("without a backspace key, typing doesn't work") and prices its own example as N=30 → log2(29). Shipping a backspace is therefore free bits — the formula charges for the reserved key whether or not you implement it (§2.4).

### Hard constraints from the brief

| # | Requirement | How we satisfy it |
|---|---|---|
| 1 | Targets sampled uniformly at random **with replacement** from an alphabet of size N >= 3. Sequence must be i.i.d. — no patterns, no language models, no predictive text, no word-level targets. | Server-side seeded uniform sampler. Repeats permitted (see pitfalls). |
| 2 | Unambiguous ground truth at every moment. | One target = one keystroke. Advance-always error policy. |
| 3 | Running bit rate over all elapsed session time, updated >= 1x/sec. | Peripheral HUD, 1 Hz tick. |
| 4 | Single 60-second timed evaluation; report final bit rate with N, Sc, Si. | Scored-run mode; results card. |
| 5 | `run.sh` (or equivalent) launching with no exotic setup. | Single command starts server + opens browser. |

### Interpretation register — assumptions to confirm or hedge

Several decisions rest on our reading of the brief, not its letter. Ranked by risk, with the hedge if we can't get a written answer:

1. **Deep lookahead** (visible future i.i.d. draws) — strongest argument for compliance (§2.3: the sequence stays uniform; the player just sees draws that already happened). README states the interpretation explicitly.
2. **Timer starts on first keypress** — "running bit rate over all elapsed session time" could be read as starting at presentation. Hedge: the armed screen makes "session start = first selection" defensible; state it in the README.
3. **Per-grader N locked during familiarization** — one fixed N is reported per scored run (rule 1 satisfied per-run). If challenged, the fallback is a single global N=26.
4. **Does an invalidated run consume the single scored attempt?** Our behavior: an invalidated run (focus loss) never counts and restarts with a fresh seed; the README says so before anyone plays.
5. **Backspace accounting — RESOLVED by the brief.** N counts the reserved correction key (the brief's own example: N=30 → log2(29)), so we ship 26 letters + backspace, report N=27, and judge backspace as a selection (correct iff it deletes an error; §2.4). Residual wording tension — requirement 1 says "targets sampled from an alphabet of size N" while targets come only from the 26 letters — is settled by the formula section defining N as "the number of possible selections" plus the reserved-key rationale. The README states this accounting explicitly.

6. **Vocal symbols are symbols, not word-level targets — owner sign-off 2026-07-22.** Babble sounds (aah, ooh, mmm…), solfège syllables (do–ti), and letter names are arbitrary vocal symbols in the same sense the PDF blesses letter-labeled keys; rule 1's "no word-level targets" bans language words as targets (and the word environments that used them are gone/hidden accordingly). Includes borderline items like "aye".

If the assignment contact can be asked, ask — a one-line email beats four hedges.

---

## 2. Design decisions and why

The agent should treat these as **decided**, not as suggestions to re-litigate. Rationale is included precisely so they aren't "improved" into the ground.

### 2.1 Input modality: standard keyboard

Rough throughput for *unpredictable* targets on commodity hardware:

- Touch typing: **~20–40 bits/s**
- Mouse pointing: ~4–10 bits/s (Fitts-bound, serial)
- Trackpad: ~3–5 bits/s
- Webcam gaze/face: ~2–5 bits/s (imprecise, calibration-hostile, dwell latency)
- Voice: latency-bound; ASR round-trip kills it for i.i.d. symbols

The keyboard wins structurally: it is **parallel, discrete, overlearned, and low-latency**. Ten semi-independent effectors with pre-acquired targets. Everything else on a normal machine is a serial pointing device or a noisy sensor.

Interfaces that genuinely beat it — stenography (chording raises the *bits per motor event* ceiling), piano, speech — all require years of training, exploit language redundancy the brief forbids, or pay a recognition-latency tax. None are usable by a grader sitting down cold.

### 2.2 Alphabet: 26 lowercase letters + backspace (N = 27), log2(26) ≈ 4.70 bits/selection

Hick's law (RT ≈ a + b·log2 N) implies large N costs time per decision — **but that slope collapses with practice** (Mowbray & Rhoades; Seibel). For *overlearned* responses N is close to free.

Design instruction that follows: **make N as large as the user's existing overlearned motor repertoire extends, and not one key further.** For our graders that is the 26 letters. Pushing into shifted symbols or the number row falls off the overlearning cliff — Hick's slope reappears and errors spike.

**Casing (52 letters + backspace, N = 53) is expected to be a net loss.** log2(52) = 5.70 vs 4.70 is +21% bits, but uniform sampling forces ~50% capitals (we can't tune the rate without breaking i.i.d.). Same-hand shifts are slow (`A` = left-shift + left-pinky) and `c`/`C` discrimination adds a perceptual step at every target. Estimated ~-24% rate. Wash at best, worse with the error penalty. **Ship it as a variant, expect null-to-negative.**

**Letters+digits (36 symbols + backspace, N=37) is the brief-hinted variant worth testing.** The brief's own example prices N=30, a nudge toward ~30-ish alphabets. Digits take bits/selection to log2(36) ≈ 5.17 (+10%), but the number row is a reach from home position with weaker overlearning; the §3(b) algebra says it must retain ~91% of letter-only speed to win (log2(26)/log2(36)). Test it as a lab variant; expect marginal-to-negative, but this one is close enough that assuming is not allowed.

**Multi-character targets ("doublets") are a no-op.** Bits/sec is invariant to how you bracket keystrokes: a two-char target at N=900 takes exactly twice as long as one at N=30. Pairs are marginally better on paper (9.81 bits vs 2 x 4.86 = 9.72, because the `-1` error-correction penalty amortizes once instead of twice — a ~1% effect) but strictly worse in practice, because scoring becomes all-or-nothing. Botch either character and you forfeit ~10 bits and take a ~10-bit penalty instead of ~5 and ~5. **Given double-penalized errors, we want the finest scoring granularity available, not the coarsest.**

**Word-level targets are banned by rule 1 — the PDF says so by name** ("no patterns, no structure, no language models, no predictive text, no word-level targets"). This was briefly "refined" away on 2026-07-22 to enable word-alphabet environments and then **reverted the same day** when checked against the PDF: the brief's letter is explicit and does not admit the uniform-fixed-list reading. Lesson recorded (§7 epistemics): a locked constraint traced to the PDF is never reinterpreted to unblock a feature — deviations get flagged to the owner *before* building. The economics were always secondary anyway: for typing, a word costs its letters, so a 1000-word list of 3–4 letter words gives log2(999) ≈ 9.96 bits at ~1.8 words/sec ≈ 18 bps versus ~19 bps for random characters — a near-perfect wash. (For speech the algebra would flip — one utterance = one selection — which is precisely why the temptation existed; the `word-typing`/`speech-words` environments survive only as clearly-badged **off-brief** lab toys, §5.)

### 2.3 Presentation: pinned cursor, deep lookahead, self-paced

**Pinned fixation.** The cursor stays at a fixed screen position and text flows leftward into it. At 4–5 chars/sec you cannot afford eye movement: a saccade plus fixation is 200–250 ms, which is the entire per-character budget. Do **not** build the typing-test convention where text is static and a cursor walks across it.

**Lookahead, default 8.** Reading research puts the perceptual span at ~15 characters right of fixation, with reliable letter identification within ~8–10. Predicted curve: steep gains to ~7, then a hard plateau, then possible decline from clutter. Showing already-drawn future characters does **not** violate i.i.d. — the sequence is still uniform with no exploitable structure; the player just sees draws that already happened.

Lookahead also **immunizes against display latency**: with a full buffer the player is never waiting on a render, because they already know the next several characters. This is what makes a web app viable.

**Chunking (config `chunk_size`, off or 3–8).** Optionally render the stream in fixed-size groups with a display-only separator space between them. The separator is **never a target** — a deterministic space would carry zero information while costing a keystroke, and it isn't sampled, so making it typeable would corrupt both the score and rule 1. Scoring and the sequence are untouched; chunking is pure presentation, so each chunk size is just another content-addressed variant. Hypothesis for: groups aid parsing the way phone-number grouping does, and chunk boundaries make repeat-runs easier to count. Hypothesis against: separators cost horizontal travel (more units scrolled per character) and the group boundary may induce a pause. Expect a small effect either way; measure, don't assume.

**Self-paced.** The stream advances on keypress, never on a clock. Any rhythm or timing window caps throughput below the player's maximum. No beat, no scroll speed, no timing gate.

**Stimulus-response compatibility.** The stimulus *is* the response: show the letter, press that letter. Zero translation. This is why colors, shapes, and abstract symbol sets lose — "purple → press F" injects a learned lookup between perception and action, adding latency and errors on every trial.

**Perceptual capacity is free but useless.** The retina delivers megabits; we consume tens of bits per second. Richer visuals cost nothing and gain nothing, while adding translation steps. The correct use of spare perceptual capacity is **lookahead**, not decoration.


**Chunking on by default (groups of 4) — 2026-07-25.** Separators are display-only glyphs and never targets (so N, the sequence, and the scoring are untouched), but they give the eye a landing place in an otherwise featureless random stream, which is what an unfamiliar player needs before they will sit still for a scored run. Off / 3 / 5 / 6 remain one tap away in the settings sheet.

### 2.4 Error policy: advance always

Every keypress consumes the current target, correct or not. Rationale:

- Clean ground truth (rule 2) — one target, one keystroke, one verdict.
- Desync is impossible.
- Finest scoring granularity, which matters most under double-penalized errors.
- No stall state. Block-until-correct lets a confused player bleed seconds.
- Key-mashing is self-punishing: 1/26 hit rate drives `Sc - Si` deeply negative.

**Backspace — a first-class selection, enabled in ship.** The brief settles what earlier drafts hedged: N counts the reserved correction key ("we use N−1 because... without a backspace key, typing doesn't work"; its own example prices N=30 at log2(29)). The ship alphabet is therefore **26 letters + backspace: N=27, log2(26) ≈ 4.70 bits/selection**. Implementing backspace is free bits — the formula subtracts the reserved key whether or not you ship one.

Scoring semantics — per-keypress ground truth, still fully unambiguous (rule 2): a letter keypress is judged against the target at the cursor. Backspace is judged as a selection too: **correct iff it deletes an uncorrected error immediately behind the cursor, incorrect otherwise** (chained backspaces walk back a trailing run of errors). Every action has a deterministic verdict; this is exactly the BCI convention the formula descends from.

The economics now favor correction outright: an uncorrected error nets −1, while error → backspace (Sc) → retype (Sc) nets +1 — a **+2 swing for ~2 keystrokes**, which typing ahead can only match at 100% accuracy. So the one strategy line familiarization teaches is: **miss → backspace → retype.** No exploit exists: deliberately erring then correcting yields +1 per 3 keys versus +3 for typing correctly, and backspacing a correct character scores Si.

### 2.5 Timer starts on first keypress

Not on page load, not after a countdown. Otherwise every player donates 300–800 ms of reaction time out of 60 seconds. The buffer is pre-filled and visible before the start so the player begins with full lookahead.

The end is equally sharp: the run ends exactly 60.000 s after the first scored keypress. Keystrokes with `t_pressed < 60 000 ms` count; later ones are ignored. Input then freezes and the results card renders. All boundary math runs on `event.timeStamp` (same clock origin as `performance.now`) — it stamps the event, not the handler, so a key physically pressed before the boundary but processed after it still counts. Before the first keypress the HUD reads 0.0 — no divide-by-zero, and the >= 1 Hz display rule is satisfied from page load.

**The scored run must be explicitly armed.** A deliberate ready action (button or hotkey) leads to an armed screen with the buffer visible; only after arming does the first keypress start the clock. A practice keystroke can never become a scored first key, and the armed state is visually unmistakable (§5).

### 2.6 Per-player N calibration during familiarization

The brief grants each grader a familiarization period, and the panel spans a wide range (one avid gamer at 200+ wpm; one who self-describes as below-average hand-eye). A single fixed N leaves points on the table at both ends — and the score is the *average across three different humans*.

Familiarization therefore runs short calibration bouts at two or three alphabet sizes, picks the best-performing one, and **locks it for the scored run**. A single fixed N is reported with the result, so this is fully compliant with rule 1.

**v1 ships static configurations only — in-game calibration is deferred. (TODO: v2.)** Every game starts directly with a fixed config; the default `stream-typing` config is N=26. When calibration arrives, it follows one principle: **calibration is a config compiler, not a game mode.** An optional pre-step (the protocol below, or e.g. the first 30 s of familiarization setting presentation speed for a paced environment) runs, then *writes a static config*; the run executes that config with nothing adaptive in it. This keeps scored runs single-fixed-N (rule 1), keeps the environment contract simple, and makes the default path "pick a config, play."

**v2 protocol sketch (recorded for later):** free practice at N=26, then 20-second bouts in ABBA order over N=26 and N=9 (home-row `asdfghjkl`), two bouts each, fresh seeds throughout. Higher mean bps across a candidate's bouts wins; ties or within-noise differences default to 26. The algebra sets the bar honestly: log2(26)/log2(9) ≈ 1.48, so home row must sustain ~1.48x the cps of the full alphabet to win — expected rare, which is exactly why 26 is the ambiguity default.

---

## 3. Automated variant evaluation — scope honestly

**A simulator cannot accurately predict human performance on presentation variants, and must not be used to rank them.** For parameters like lookahead depth, fixation mode, chunking, or audio feedback there is no validated model with calibrated effect sizes. Any simulator we write would encode our priors and then "discover" them — circular, with a veneer of empiricism. This is worse than no data because it is confidently wrong.

Three things automation *can* legitimately do:

**(a) Synthetic input harness — a test suite, not a predictor.** A scripted player with configurable inter-key-interval distribution and error rate that drives the real UI. Verifies: timer starts correctly, no dropped keystrokes at 15 cps, client and server scoring agree, bit-rate math matches a reference implementation, no render stalls, autorepeat handled. **This is essential** — we must not discover a keystroke-dropping bug during a graded run. It answers "is it correct," never "is it better."

**(b) Config-space pruning by algebra.** For any config, compute required cps to hit a target bps. This kills dominated configs without human testing: casing must retain ~82% of baseline speed to break even (log2(26)/log2(52)); an 8-letter alphabet needs ~1.57x the cps of the full 26 (log2(26)/log2(8)). Not simulation — arithmetic. Build it as an analysis notebook.

**(c) Digram-cost model for alphabet subsets.** If choosing *which* subset of keys, inter-key interval as a function of finger/hand transition is well-characterized and measurable from our own telemetry (same-finger digrams ~1.5–2x slower; alternating-hand fastest). Calibrate on collected data, use to rank *alphabet* candidates only. This is the one place a model earns its keep, because the mechanism is understood and the parameters come from real keystrokes.

### The real answer to "I'll be the only tester and I'll improve over time"

This is a **measurement design** problem, not a simulation problem:

1. **Short bouts, many reps.** Use 20-second bouts for experimentation, not 60. ~40 bouts per session instead of 8, far more statistical power per unit time. Only the final candidate needs 60-second validation.
2. **Paired seeds.** Serve identical character sequences across variants being compared. Large variance reduction on short samples. Caveat: pairing across *the same player's* bouts means the second exposure isn't naive — a 300-character random string can't be memorized, but motor priming from having just typed it is real. Counterbalance order, keep paired bouts short, and never pair anything with a scored run (§7).
3. **Counterbalanced order** (Latin square or ABBA), so within-session warm-up doesn't alias onto whichever variant ran first.
4. **Learning as a covariate, not a nuisance to avoid.** Fit `score ~ variant + log(exposure_index) + player` and estimate the practice effect rather than pretending it isn't there.
5. **First-contact scores are precious.** *The graders are first-session; we are not.* You can only be naive once per variant. Log the first run on each new variant distinctly and weight it heavily. A variant that rewards practice — chording, very large N, novel mappings — will look better to trained-us than it will score with the panel. **This is the single biggest self-deception risk in the project.**
6. **Learnability as an explicit metric.** Track the score-vs-exposure slope per variant. High ceiling with slow learning is a trap for a first-session eval.
7. **Recruit real humans.** See §6. Twenty people x three variants beats any simulator we could write.

### Pilot analysis plan — pre-declared (2026-07-23)

The §6.1 pilot is n≈10 recruited people, a handful of games each. The plan is declared *before* the data lands so exclusions can't be chosen after seeing results — and small-n honesty is itself part of the artifact: **plot every run, put n in every figure caption, prefer estimation (medians, ranges, per-person deltas) over hypothesis tests.** At most a sign test on paired deltas; the item-4 regression `score ~ variant + log(exposure_index) + player` runs only as a robustness check, never as the headline.

**Pre-declared exclusions:** invalidated runs; bot-flagged runs; author runs (participant `p-self` — segmented and shown separately as the practiced-ceiling reference, never pooled with naive data); organic participant-less traffic (reported as bonus context only, §6.1). Hardware-substituted steps are analyzed under the environment actually played.

Three questions, one figure each:

1. **What will a grader score?** Strip plot of all step-1 scored runs (ship config, grader-rehearsal protocol — §6.1). Median + range is the README's predicted panel range: the closest available proxy to three first-session graders.
2. **How do modalities rank?** Per participant: mean of their 20 s bouts per environment, minus their own same-session ship anchor → paired-delta dot plot, every point shown. Between-modality gaps are expected to be multiples (keyboard ~20 bps vs webcam ~3), so n≈5 per environment resolves ordering; any pair within ~±2 bps is reported as "within noise at this n," not ranked.
3. **What does practice buy?** Bout-2 − bout-1 gain per environment — the two-bout reduction of the item-6 learnability slope, and the detector for the "high ceiling, slow learning" first-session trap.

Gallery tiles (§5) pull their first-contact median and learnability note from these same queries — the gallery is the public face of this analysis, not a separate pipeline.

---

## 4. Architecture

### 4.1 Dependency policy

**Two tiers, and the boundary is strict.**

**Tier A — the server and shipped game. Go standard library only, compiled to static binaries. Zero runtime assumptions.**

The server is Go (`net/http`, `embed`, `crypto/rand`, `encoding/json`), built with `CGO_ENABLED=0` into a self-contained static binary per platform (~8 MB with `-ldflags="-s -w"`), frontend assets embedded via `go:embed`. The grader's machine needs **nothing** — no Python, no Node, no interpreter of any kind, not even glibc: static linking means the binary runs on any Linux distro as-is, musl/Alpine and containers included. The brief guarantees a Linux grading environment; cross-compilation covers the ship targets (Linux x86_64/arm64) plus macOS for local dev, from any single machine in one build step. The frontend stays vanilla JS: no build step, no CDN.

Web frameworks are **out** for the same reason FastAPI would have been out of a Python design: this app needs static serving, a handful of JSON endpoints, and an append-only log — `net/http` covers all of it in a few hundred lines with an empty `require` block in `go.mod`. CI asserts it stays empty.

**No cgo, ever.** cgo breaks static linking and reintroduces the per-platform toolchain matrix that made bundling an interpreter unattractive in the first place. This rules out C-backed SQLite — which is fine, because storage is JSONL (§4.4).

**Tier B — the research harness and public deployment. Dependencies allowed, never shipped.**

Analysis notebooks (pandas, numpy, statsmodels), the Playwright ship-gate driver, the synthetic-player harness, load testing, deployment tooling. Python lives here and only here. Separate directory, its own requirements file. **Nothing in Tier B is needed to build or run Tier A.**

**Experimental environments sit between the tiers.** A webcam or hand-tracking game mode cannot be built on the stdlib-plus-vanilla-JS diet, and does not need to be: environments are lab machinery until one wins. An environment may vendor JS/wasm libraries (e.g. MediaPipe hand tracking) inside its own directory, loaded locally — **never from a CDN, even in the lab**; development must work offline too. Each environment declares its vendored deps in a manifest. Becoming the ship candidate is where the bill comes due: whatever ships must satisfy Tier A's offline, zero-network rules, so an environment that can't vendor its stack cleanly can win the gallery but not the ZIP.

**Repo layout (the tier boundary is a directory boundary):**

```
server/             Tier A: Go module (stdlib only) — serving, sequences, scoring, storage
environments/       Tier A frontends, one dir per environment; stream-typing/ first
lab/                Tier B: Python analysis, synthetic-player driver, ship gate, deploy
dist/               build output (gitignored)
run.sh
```

Tier isolation is enforced by construction (Go cannot import Python) plus the CI check that `go.mod` declares zero dependencies.

**On vendoring:** eliminate rather than vendor. If a Tier A server need genuinely arises later, the rule is **pure-Go modules only**, `go mod vendor`ed and compiled in — never cgo. The frontend equivalent is the per-environment JS/wasm vendoring above; nothing is ever fetched at runtime.

### 4.2 Served by the server — always

The app is a **multi-file static bundle** (per-environment directories of plain HTML/CSS/JS) served by the Go binary on localhost. There is no `file://` mode and no single-file fallback: **the server is always present.** It is a single static binary with every asset embedded (`go:embed`), so requiring it costs the grader nothing, and one code path tested to death beats two that split attention. In the lab, a `-dev` flag serves assets from disk instead of the embedded copies, so frontend iteration needs no rebuild. Everything remains fully offline — localhost serving, no CDN, no build framework, nothing beyond the loopback.

`http://localhost` is a secure context, so `getUserMedia` (webcam/microphone modes) works without HTTPS.

Mid-run resilience does not depend on the server: the full sequence arrives at run start and telemetry uploads once at run end (§4), so a server hiccup during a scored run is structurally invisible to the player.

Consequences to respect (binding for the primary game and anything shipped; other environments follow the vendoring rules in §4.1):

- **System font stack only.** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. No Google Fonts, no webfont fetch. A font-load flash would be actively harmful in a fixation-critical UI.
- **No audio files.** Feedback tones come from the WebAudio API (`OscillatorNode`).
- **No charting library.** Gallery plots are hand-rolled SVG — bar and line charts are ~30 lines each, and it avoids both a CDN and a vendored bundle.

The build is `go build` per target plus ZIP assembly, driven by one small script. No bundler, no transpiler, no Node toolchain. That is the entire build system.

### 4.3 Frontend

No React or any framework with a reconciliation step between `keydown` and paint. Direct DOM manipulation only. Pre-render character spans and shift classes; do not rebuild the buffer per keystroke.

### 4.3.1 Touch & small-viewport (iOS) support (2026-07-23)

**Finding (owner, on-device iPad): the touch interfaces are genuinely valuable, not just a hardware-hedge curiosity.** Direct-touch pixel-lens, the beat-hands `touch-swipe-v1` recognizer, and the twin-stick sticks all feel good on an 11″ iPad over plain-HTTP LAN (no `getUserMedia`, so no secure-context blocker — the reason touch/gamepad were the iPad-reachable paths in the first place). This elevates touch from "build it as an alternative data-point" toward a **recommended play path**; the earlier hard caveat under `touch-grid` (§5) — "assumes the grader has a large touchscreen" — still governs *what we bet the grade on*, but the tablet experience itself is now a first-class target, not an afterthought.

**Resolved 2026-07-25 — one header band in every environment.** The corner cluster and floating HUD are gone; all eight environments now render the same in-flow `<header id="topbar">` grid, with the play field starting below it rather than under it:

  - **left** — mode banner + the run controls (`Enter` arm / `Esc` practice, real buttons since §4.3.1 made touch a first-class path).
  - **middle** — `#res-info`, what this variant is currently set to, with the **settings button directly under it**: the config line is the label and the button is the way to change it, so configurability announces itself instead of hiding behind the corner gear.
  - **right** — the figures the assignment requires (rule 3: running bits/s at >= 1 Hz; rule 4's `N`, `Sc`, `Si` alongside it, populated from page load, not once a run has data) plus the pace graph, which likewise renders an empty axis from load so the band never changes height under the player.

  `--topbar-h` is published by `BitrateResults.trackHeaderHeight()` from the measured band via a `ResizeObserver` — the band reflows with *content* (config line rewrapping, controls repainting), not just viewport, so a hard-coded height was never going to hold. Every field/stage is positioned at `top: var(--topbar-h)`; pixel-lens/drum-pad additionally rebuild the grid on the callback, since there N is derived from the space the band leaves. A canvas is a replaced element, so the four canvas environments need explicit `width`/`height` — offsets alone leave them at the intrinsic 300x150.

  **Under 640 px (a phone) the band demotes to two rows**: mode banner + settings button + the required figures on the first, the run controls on the second; the accounting line, the graph and the floating gear are hidden (all reachable on the score screen or via the header button). Measured 90 px on a 390 px viewport against 126 px on desktop.

**Soft keyboard: stream-typing on a phone (2026-07-25).** Every touch environment so far reads pointers, so nothing on the page was ever focusable — which left stream-typing, the one environment whose selections *are* keys, unplayable on a phone: no focused field, no keyboard, no way to type. Three parts, all inside the environment (the other seven are unaffected):

  - **A phantom input.** `#kbd-catcher` is a transparent `<input>` stretched over the play field, so the tap that raises the keyboard is the natural one — on the stream itself. It is `pointer-events: none` and never focused unless the device reports a touchscreen (`maxTouchPoints` / `any-pointer: coarse`), so a desktop — or a touch laptop nobody has tapped — keeps the untouched `keydown` path. Font-size 16 px, because iOS zooms the page on a smaller focused field.
  - **`input` events, not `keydown`, are the selection path while it has focus.** A soft key's `keydown` carries no usable `key` (Android reports `keyCode` 229 / `"Unidentified"` for every one of them, which the desktop code correctly reads as a hostile IME), whereas the field's *value* is exact on every platform. Each `input` event is diffed against the last value seen — characters gained are selections, characters lost are backspaces, in that order — so predictive text rewriting the tail scores exactly as the same keystrokes typed by hand. Two things this needs: the field carries 24 non-breaking spaces of filler, because a soft backspace on an *empty* field fires no event at all and backspace is one of the N selections (§2.4); and the caret is pinned to the end on every `selectionchange`, because a tap lands it in the middle of that filler and an insertion there reads as delete-and-retype (caught in test: one keystroke scoring as twelve backspaces). `keydown` on the field is ignored except Return, which arms. A composition on the field does **not** raise the §7 IME warning — a phone keyboard composes as a matter of course.
  - **The keyboard must not cover the stream.** The layout viewport doesn't shrink when a keyboard opens (iOS never resizes it; Chrome's default is `resizes-visual`), so the covered strip is measured off `visualViewport` — `innerHeight − height − offsetTop` — and published as `--kbd-inset`; the play field ends there and re-centres the stream in what's left. Under 640 px the stream also drops to 34 px glyphs with the fixation point at 30 % of width, which leaves ~13 characters of look-ahead on a 390 px screen against a default `lookahead` of 8. Verified on an emulated 390×844 phone with a 336 px keyboard: stream fully clear of both the header and the keyboard, and a full 60 s scored run typed entirely through the soft path replays server-side with no anomaly.

  Not a scoring change: `input` events carry the same high-resolution `timeStamp` as `keydown`, every selection still goes through one `offerSelection()` that applies the §2.4 rules and the §2.5 boundary, and the server replays the log by key identity and order as before. The one honest loss is `t_keyup_ms` (soft keys have no keyup), which is declared best-effort and feeds only the §6 bot heuristics. Whether a phone run is *comparable* to a desktop one is a leaderboard question, not a correctness one — `client_meta.touch_points` / `pointer_coarse` already record the device class on every run.

### Data model

A variant config is a JSON document; its canonical form (sorted keys, no whitespace) is what gets hashed into the variant identity (§4.4):

```json
{
  "environment": "stream-typing",
  "alphabet": "abcdefghijklmnopqrstuvwxyz",
  "lookahead": 8,
  "fixation": "pinned",
  "chunk_size": null,
  "audio_feedback": false,
  "error_policy": "advance",
  "backspace": true,
  "duration_s": 60,
  "hud_position": "corner",
  "font_stack": "system-mono"
}
```

Record types (stored as JSONL — see §4.4):

- `variant` — config_hash (the identity; see §4.4), name, config JSON, environment key (see §5), created_at
- `run` — id (random 128-bit hex; see §4.4), variant_id, instance_id, device_id, seed, started_at, ended_at, duration_s, is_scored, is_first_contact, flags (bot-heuristic / anomaly / invalidated), client_meta (UA, screen, input device, pointer/touch class, webcam+mic availability — capability probe only, no capture), participant (nullable invite token, §6.1), session_id + step_index (nullable; set when the run was played inside a guided pilot session, §6.1). **client_meta must include `touch_points` (`navigator.maxTouchPoints`) and `pointer_coarse` (2026-07-24):** iPadOS Safari requests desktop sites by default, so its UA is byte-identical to macOS — the owner's iPad runs recorded as "Macintosh; Intel Mac OS X". UA alone cannot classify device class; touch capability can (iPad reports 5 touch points even in desktop-UA mode, Macs report 0). All environments send both fields.
- `keystroke` — run_id, index, expected, actual, t_shown_ms (when this target entered the fixation position — not when it became visible in lookahead), t_pressed_ms, t_keyup_ms (keydown/keyup jitter feeds the §6 bot heuristics)
- `result` — run_id, N, Sc, Si, bits_per_selection, bps (server-authoritative), plus a server-computed `metrics` block (below)
- `session` — id, participant (invite token), plan (ordered steps: environment, config_hash, mode, duration_s), created_at, completed_at, status (in_progress / complete / abandoned), substitutions (steps swapped for hardware reasons, with the reason). Pilot machinery (§6.1); exists in the lab profile only, stripped from ship like everything else in §8. Derived quantities — exposure index per (participant, environment), completion rate — are **queries over runs/sessions, never stored** (same principle as the leaderboard, §4.4).

**Per-run diagnostics (`result.metrics`) — computed server-side at submit, from the selection log.** Because every environment emits the same log schema (§5 contract), these are directly comparable across modalities — the same "where did the bits go" breakdown for keyboard, webcam, or chords. The set is deliberately small:

- *Rates* — gross selections/s, net correct/s
- *Accuracy* — accuracy %, misses, corrected vs uncorrected (an uncorrected miss is a −2 swing; this pair is the "should have backspaced" diagnostic)
- *Cadence* — median / p90 inter-selection interval; stall count and total stall time (gap > 1.5 s = deciding, not executing); dead tail after the last selection
- *Two small series for charts* — Sc/Si per 5 s bin (pace over the run) and a 100 ms-bucket interval histogram

Client renders these under the headline score as a post-run results view (tiles + two hand-rolled SVGs, per §4.2 no charting library). Don't grow this list casually: anything finer-grained (digram costs, per-key latency) belongs in the §3 analysis notebook reading the raw keystroke logs, not in every result record.

**Sequence generation is server-side and seeded**, so runs are reproducible and replayable, and so identical sequences can be served for paired comparison. The **entire sequence for the run is delivered in the `run/start` response** — sized far beyond any human maximum (~2,000 characters covers 60 s at a fantasy 30 cps) — so the client never extends it and nothing needs the network mid-run. Do not have client and server co-implement a PRNG to save bytes; ship the characters. Derivation is pinned, not delegated to a library default: seed = 32 bytes from `crypto/rand`; symbol *k* = SHA-256(seed ‖ k) reduced by rejection sampling (no modulo bias); golden test vectors live in the repo so replay survives toolchain upgrades.

**Scoring is server-recomputed — validation, not authority.** The client computes the live HUD value; the server recomputes from the submitted keystroke log at run end, and any disagreement beyond floating-point tolerance is logged as an anomaly. Honest framing: timestamps originate client-side, so this catches bugs and drift, not fabrication — the §6 bot heuristics are the anti-abuse layer, and for graders on localhost the threat model is bugs, not cheating.

**Telemetry uploads once, at run end.** Nothing touches the network mid-run.

### Endpoints

```
GET  /                      variant gallery
GET  /play/{variant_id}     game page
POST /api/run/start         -> {run_id, seed, sequence}   (full sequence, see above)
POST /api/run/submit        keystroke log -> authoritative result
GET  /api/leaderboard       filterable by variant, human-verified only
GET  /api/variants          registry
GET  /api/runs/{id}         full telemetry for analysis
GET  /api/export            JSON bundle for backup/merge (see §4.4)
```

### 4.4 Persistence, leaderboard, and merge

The leaderboard is **self-contained**: one `data/` directory of JSONL per server instance, no database, no cross-instance sync, nothing shared at runtime. But an instance's data must be **downloadable and mergeable into another instance's** — every choice below serves merge-without-coordination.

**Identity rules.** These make merge a set-union; violate them and merge becomes entity resolution:

- `run.id` — random 128-bit hex (`secrets.token_hex(16)`) minted at creation. **Never autoincrement integers** — two instances would mint colliding ids and merging would mean rewriting foreign keys.
- Variant identity — `config_hash`: SHA-256 over the canonical config JSON (sorted keys, no whitespace) plus the environment key. `name` is a display label only. Two instances that independently define the same config merge into a single variant automatically.
- `instance_id` — random id minted on first server start, stored in the DB, stamped on every run. Pure provenance: answers "where did this row come from" after several merges.
- Player identity is a `device_id` — random 128-bit hex minted by the client on first visit and stored in `localStorage`. **No username prompt, no account, no sign-in** — a player's first keystroke can happen seconds after page load. The UI shows a pseudonym derived from the id (e.g. `runner-3f2a`). Do **not** use IP as identity: NAT merges a whole household into one player, DHCP splits one person into many, and it edges into PII. IP is for rate limiting only and is never stored on a run. (A side benefit over usernames: random device ids cannot collide across instances, so merge needs no disambiguation.)

**The leaderboard is a query, not a table.** Best bps per (device_id, variant) over scored, completed, human-verified runs; ties broken by earlier timestamp. Because it derives entirely from `run`/`result`, merging runs merges the leaderboard for free — there is no leaderboard merge logic because there is no leaderboard state. Never materialize it.

**Every leaderboard row carries its exact config and can relaunch it.** The run→variant join gives each entry its full config JSON; the row shows a config summary, and clicking it opens `/play?cfg=<config_hash>` — the game boots with precisely that configuration. Reproduce-what-you-see for free, because variants are content-addressed.

**Leaderboard rows expand into a run detail view.** The row shows headline numbers (bps, N, Sc, Si, accuracy); expanding it renders the stored `result.metrics` (§4.3) with the same tiles-and-charts renderer the post-run results view uses — one renderer, two call sites. This is how modality differences get diagnosed at a glance: a webcam mode and the keyboard baseline at similar bps can have opposite cadence/accuracy signatures, and the detail view shows it without opening the analysis notebook.

**The board shows the top 10 of the active tab (2026-07-26).** A ranking, not a ledger: the table renders at most 10 rows per tab (10 overall on *all*, 10 per game on an environment tab), and the header note says `top 10 of N` whenever rows are hidden. Capping is a **display** decision and lives in the gallery's `renderBoard()`, not in `/api/leaderboard` — the endpoint keeps returning every ranked row because `rank` is global across environments and the per-game tabs filter client-side, so a server-side cut would leave an environment tab showing only whichever of the global top 10 happened to land in it. Nothing is dropped: hidden rows stay in the API response and in the progress strips.

**The leaderboard must read well at n=2.** A grader generates one familiarization run and one scored run; the page cannot look like an empty stadium. And for repeat players it must answer "am I improving?": a per-device progress strip — bps against run index, per game mode — sits alongside the rankings. Both are the same query over `run`/`result` with different cuts.

**Export.** `GET /api/export` returns one JSON bundle: `{schema_version, instance_id, exported_at, variants, runs, results, sessions}`, with `?include=keystrokes` for full logs (large, so opt-in) and `?since=` for incremental pulls. (`sessions` and the run `participant`/`session_id` fields arrived with the §6.1 pilot — a `schema_version` bump, which the version gate below handles as designed.) **First round trip run 2026-07-25** — pulled the deployed ledger into local, merged, then pushed the union back up (bundle + a linux merge-tool binary staged through the deploy bucket, `systemctl stop` → merge → start, staging objects deleted afterwards since the bundle carries keystroke logs). Both sides now hold the same 510 runs / 93 results / 126 variants; the public leaderboard went from 3 ranked rows to 10. Deliberately *not* done as part of it: `deploy.sh`, which would also have shipped the unreviewed frontend — data movement and code deploys are separate acts. **Pulling the deployed instance into the local one is a cadence, not an event:** `lab/pull.sh` curls `?include=keystrokes&since=<last-pull>` and pipes the bundle through `bitrate merge` — set-union idempotency means running it twice, or overlapping `since` windows, changes nothing, so run it whenever. Keystrokes are always included on pilot pulls so the importer can recompute scores and bot flags locally ("recompute, don't trust", below) — imported pilot runs are never `unaudited`. The JSON bundle is the interchange format — and since storage itself is JSONL (below), export is little more than a filtered stream. Backup is `cp -r data/`; merge always goes through the CLI, never by hand-splicing files.

**Merge.** `bitrate merge export.json` — a subcommand of the server binary, offline, not an endpoint. **Built 2026-07-25** (`server/merge.go`, tests in `merge_test.go`); `-data` selects the ledger to merge into, `-` reads stdin. Semantics:

- Idempotent set-union keyed on ids. Merging the same bundle twice is a no-op; merge order never matters.
- Same id, different payload → conflict: keep local, log it. (Random ids make this near-impossible; if it happens, something is lying.) **Variants compare on identity only** — the hash *is* the config, so two instances that independently registered the same variant agree by construction; `created_at` and `name` differ as a matter of course (when each instance first saw it, what it called it) and are not a conflict. Merging the deployed instance into the local one surfaced exactly this: 14 shared variants, every "conflict" a timestamp.
- **Recompute, don't trust.** Where keystroke logs are included, the importer recomputes the score and the bot-heuristic flags from the log and stores its own verdict. Imported results without keystroke logs are accepted for leaderboard display but flagged `unaudited` and excluded from variant analysis.
- `schema_version` gates the import. Refuse newer versions; never guess.

**Storage is append-only JSONL — no database.** `data/variants.jsonl`, `data/runs.jsonl`, and `data/results.jsonl` are small and load into memory at boot; keystroke logs are file-per-run at `data/keys/<run_id>.jsonl`, written once at submit and read lazily. A single writer goroutine serializes appends, and a completed run is fsynced before the submit response returns. This drops SQLite entirely — and with it cgo, WAL tuning, and connection discipline — makes the on-disk format the same JSON the export endpoint and merge CLI already speak, and reduces backup to a directory copy. At public-deploy scale the in-memory index holds thousands of run records — trivial; the keystroke bulk stays on disk.

---

## 5. Environments and the gallery

Not every experiment is a config change. Some are entirely different setups (webcam, gamepad, chorded input). The registry must accommodate both.

- **Environment** — a distinct front-end implementation (e.g. `stream-typing`, `webcam-gaze`, `chord-pad`). Lives in its own directory, implements a common contract.
- **Variant** — an environment plus a config. Most experiments are variants of `stream-typing`.

**Environment contract:** every environment must (a) consume a server-provided seeded i.i.d. sequence, (b) emit a selection log in the standard keystroke schema — recognition-driven modes (webcam, mic) must reduce each attempt to a discrete, logged accept/reject event so ground truth stays unambiguous (rule 2), logging recognizer confidence alongside, (c) render the live bit-rate HUD at >= 1 Hz, (d) support both `familiarization` and `scored` modes, with an unmistakable visual affordance for which mode is active — a scored run must never start by accident. If it satisfies those four, it plugs into the leaderboard.

Environments are also where decided defaults get violated **on purpose**: a paced, beat-mapped, or pointer-driven mode contradicts §2 and §7 by design — that contradiction *is* the experiment, and the gallery documents the outcome. The §1 rules (i.i.d. targets, unambiguous ground truth, live HUD, honest scoring) bind every environment without exception.

**Gallery page** — a grid of cards, one per game. Target: **at least six modes** — the serious baseline, a couple of honest contenders, and a few gloriously doomed ones. **Including the failures** — the negative results are the most useful thing in the whole project and the most interesting part of the README.

**Shape as built (2026-07-25).** Titled simply *bit-rate games*, then: the four contenders side by side (**drum pad, pixel lens, stream typing, voice babble**, in that order), the leaderboard, the progress graphs, and at the bottom a **graveyard** holding everything else (lane tap, twin stick, parabola fall, word typing). **beat hands has no card at all** — the game and its URL still work and its runs stay in the history, it is simply not offered from this page. The graveyard is presentational only — those runs stay in the history and the progress strips, but the leaderboard ranks **only the games still in the running**, since a board mixing live contenders with abandoned modes ranks nothing useful. The card reads top-down: **title, N, what you play it with, one line about the game**; the footer carries plays / best bps / median bps on the left and the play button on the right. Copy describes the *game*, not the experiment behind it — no Fitts's-law asides, no "can X beat Y?" framing; the analysis belongs in the README and this spec. First-contact median came off the card (it's an analysis cut, not something a player picks a game by).

### Backlog of environments (build after the baseline works)

- `webcam-gaze` — close-range eye tracking: the player sits near the webcam, a coarse grid of colors/shapes as targets, gaze dwell to select. Expect 2–5 bps; the find-target-then-fixate loop (search saccade before every selection) may be the structural killer. Build for the fun and the data point, not the score.
- `voice-babble` — **built.** The typing test, spoken: i.i.d. symbols, player voices each one, judged client-side as a discrete accept/reject event with logged confidence (rule 2). Decisions:
  - **No cloud ASR, no neural ASR.** Web Speech API uploads audio (violates §6) and pays a 300–800 ms round trip; WASM whisper/Vosk is 40–75 MB of vendored model for a ≤26-symbol closed vocabulary. Both structurally wrong here.
  - **Hand-rolled DSP classifier, per-player templates**: 18 mean-normalized log-spaced spectral bands (100–4000 Hz) + zero-crossing rate at ~60 fps; energy-based VAD segments utterances; classify at onset+~180 ms by nearest-centroid cosine against templates the player records (2 takes/symbol) before playing. Sub-200 ms, fully offline, zero dependencies. Speaker-independence is sidestepped, not solved.
  - **Calibration is a config compiler (§2.6) made literal**: the calibration step writes static per-voice templates; the run executes them with nothing adaptive.
  - Symbol sets (config): `solfege` (do re mi fa sol la ti — 7 distinct; the octave "do" would break uniqueness) is the **default** (owner pick, 2026-07-23); also `babble-6` (aah eee ooh mmm sss shh — chosen for acoustic separability: formants/nasality/centroid/ZCR), `babble-8` (+ uhh, aye; flagged harder — uhh sits between aah/ooh, aye is a diphthong), `letters-9` (curated distinct names). No correction symbol; N = set size. **`letters-26` dropped (2026-07-23, owner request)** — the full a–z was a lab curiosity (it was expected to fail on the E-set /iː/ confusions) and cluttered the picker; removed from `SETS` and both set-pickers.
  - The feature vector is **two-stage**: onset frames (~first 60 ms) and steady frames concatenated, each mean-normalized. Same-vowel symbols (do/sol, fa/la, mi/ti, the E-set) differ mainly in the onset consonant, which a steady-state-only vector throws away.
  - Server unchanged: rides the numeric-alphabet machinery (`alphabet_size`, `sequence_ints`).
  - **Mic sensitivity + a visible trigger line (2026-07-23, owner request).** The onset trigger is `max(noiseFloor·MULT, absoluteFloor)` — the floor term rejects *steady* background (a constant hum can't exceed its own adapting noise floor), the multiple sets how far above it a sound must jump. `MULT` lowered **4→3** to pick up softer speech; impulsive clicks are still dropped downstream by `MIN_FRAMES` (a lone loud frame never reaches the classifier), and steady noise by floor adaptation — so more sensitive *without* leaking background in. The level meter is now **scaled to the live trigger** (`pct = rms/threshold · 50`), so the threshold is a fixed **line at the meter's midpoint**: a sound clears the middle exactly when it will register, and background rides visibly below it — the meter answers "am I over the line?" rather than being a calibrated VU. Line drawn on both the practice heard-line meter and the calibration meter; `mic-stats` labels the numeric trigger as "= midline". The `mic trigger` preset (sensitive/medium/loud room) still raises the absolute floor for noisy rooms, now legible against the line.
  - This is the first standalone channel for the composable-channels plan below; moose-babble becomes voice × pose composition.
- `moose-babble` — webcam + microphone. Targets are short vocal bursts ("boo", "ba", "ee") crossed with hand poses: hands beside the head, antler-style, each independently up/down (2 x 2 = 4 poses; x ~8 sounds ≈ 5 bits/event on paper, before recognition latency eats it). Records the player's video **locally**, replays it at run end, and offers a download — the memorable-submission artifact. Nothing leaves the machine.
  - **Recognizer design (2026-07-23, DESIGN ONLY — not built; owner brainstorm).** Head + hand detection with **no post-detection library and no model**, in the same zero-dep DSP spirit as beat-hands (frame differencing) and voice-babble (hand-rolled classifier). Three ideas make it tractable without ML:
    1. **Calibrated per-player skin model, in chroma space.** Don't detect "skin" universally (the hard, tone/lighting/white-balance-fragile problem) — during calibration (the same §2.6 "config compiler" step voice uses) sample *this* player's face in *this* lighting and learn an ellipse in **YCbCr Cb/Cr**, which is largely luma-invariant, so brightness swings don't break the mask. This is the biggest robustness lever; it turns a general-CV problem into "threshold to one known color."
    2. **The voice is the clock → static-pose *reading*, not tracking.** moose is voice × pose; the vocal onset (already produced by voice-babble's VAD) is the discrete event, and the hand pose is **sampled at that instant** like a chord. Poses are held still (antlers), so this is static-shape classification at a known moment — far easier than motion tracking, and it inherits twin-stick's anti-hack rule (read the pose *at the event*, never "was the pose ever shown in a window").
    3. **Head as the coordinate frame.** The head blob gives a **scale reference** (distance-invariance: lean in/out and thresholds hold) and the **origin** for "beside / above." Detect it as the central-upper skin blob, smoothed across frames (it barely moves; hands gesture). All hand geometry is measured in head-radius units.
  - **Per-question methods (design):** *hand vertical position* — in the two regions flanking the head, take each hand blob's centroid and compare to a head-scale-relative line (above-ear vs at-shoulder) → 1 robust bit/hand, no tracking. *open vs closed* — combine two calibrated cues: **area relative to head** (spread hand ~0.5–0.8 of face area, fist ~0.25–0.4 — normalizing by head area removes depth dependence; the most robust single signal) and **compactness** `perimeter²/area` (fist smooth/low, spread fingers spike it); only if those disagree at the margin, upgrade to a **radial signature** (rays from the hand centroid → 4–5 finger peaks for open, smooth for a fist — the model-free convexity-defect analog). Ergonomic mapping: open = antlers spread, closed = tucked.
  - **Building blocks (all plain JS, no deps):** downscale to ~96×72, YCbCr skin test, 1–2 passes of 3×3 erode/dilate to kill speckle, single-pass connected components, per-blob area/bbox/centroid/perimeter; optionally **intersect the skin mask with a background-subtraction foreground** (reuse beat-hands' frame differencing) to reject skin-colored furniture/walls.
  - **Honest-N caveat + staged scope.** Skin segmentation degrades gracefully, not perfectly (enemies: skin-colored backgrounds, hard color casts) — calibration + chroma-space + background subtraction handle most, not all; expect this to be *less* bulletproof than the voice DSP, which is fine for a memorable-artifact/"gloriously doomed" backlog env. Crucially, **every added binary must clear a reliability bar or it costs net bps** (a 15%-error open/closed channel can subtract more than the bit it adds). So build and *measure* in order: **(1) position-only** — 2 hands × up/down = 2 bits × ~8 sounds — prove the skin+head+region pipeline and get a real per-hand reliability number; **(2) add open/closed** only if the measured accuracy justifies the extra bit. Per the composable-channels principle, log voice / left-vertical / right-vertical / (open-closed) as **separate channels with partial credit** (twin-stick's per-channel scoring), so one blown hand doesn't zero the event. Secure-context note (§5 beat-hands): `getUserMedia` for camera *and* mic needs HTTPS/localhost, so moose-babble on an iPad needs a TLS server or tunnel — it's a desktop/localhost env until then.

- `word-typing` — **OFF-BRIEF; hidden from the app** (rule 1 bans word-level targets by name — §2.2). Code kept on disk (reachable by URL, quarantine banner in-page); filtered out of the gallery, leaderboard, and progress views. It existed to test §2.2's wash prediction; if that measurement is ever wanted, it runs as a private experiment, never a grading artifact.
- `speech-words` — **dropped (2026-07-22).** Off-brief twice over (word targets + LM decoder), and empirically moot: ASR final-result latency made the selection loop too slow to be interesting. Knowledge retained in this entry: Web Speech API has on-device modes (Chrome `processLocally`, macOS dictation) but general ASR is structurally wrong for this brief; homophone pruning is required for unambiguous ground truth over spoken words; never construct SpeechRecognition outside a trusted user gesture (backend-less headless builds hard-crash). The compliant voice path is `voice-babble`: vocal *symbols* (sounds/syllables — §1 register item 6), LM-free on-device DSP.

**Composable input channels (design principle for multi-modal environments).** Complex input streams should be built as composable units: a channel = one recognizer emitting discrete symbols from its own alphabet (keys, pointer-cell, voice-syllable, hand-pose), and an environment composes channels. Simultaneous channels multiply alphabets (targets drawn i.i.d. over the product, e.g. voice × pose = 8×4 → 5 bits/event; pixel-lens click × L/R home-row key → ×4 = +2 bits); the per-channel logs still reduce to the standard selection schema, so scoring, metrics, and the leaderboard need nothing new. Build `voice-letters` as the first standalone channel, then compose moose-babble from voice + pose rather than as a monolith — each channel gets validated (latency, accuracy) on its own before composition.
- `beat-hands` — **built.** Beat Saber-style: i.i.d. notes stream down a pseudo-3D canvas highway at a fixed tempo, each specifying hand (left/right) × swipe direction — N=8 (4 directions) or 16 (8 directions, a setting), no correction symbol. Deliberately violates §7 self-pacing (sanctioned above — the contradiction *is* the experiment): tests whether deep-lookahead paced execution can beat reactive self-pacing. Decisions:
  - **Swipes, not static pose angles** (amended 2026-07-22 from the original sketch, owner sign-off): inter-frame motion is the strongest signal a webcam yields, while static pose orientation needs shape analysis — ML territory. A swipe is also the authentic Beat Saber verb (cut direction).
  - **Recognizer is frame-differencing DSP, no ML.** Voice-babble's rejection of vendored neural models applies verbatim: MediaPipe-class hand tracking is megabytes of WASM for a closed "which hand, which of 4 directions" question. Pipeline: mirrored 96×54 grayscale; per-half motion energy is the VAD analog (onset opens a stroke, quiet or a dip closes it); the motion centroid's onset→peak displacement quantizes to direction sectors; confidence = angular margin. Hand identity = frame half. Frames never leave the machine (§6).
  - **Tempo is config** (60–180 notes/min, each its own variant; v2: a calibration pre-step writes it per §2.6). Effective hit window = min(window setting, just under half the beat) so windows never overlap and ground truth stays per-note unambiguous (rule 2): each note is judged exactly once — by the first in-window stroke (advance-always: wrong hand or direction consumes it) or as a miss when its window closes unswung.
  - **`input: keys` mode** (WASD / arrow keys, 4 directions) isolates the pacing experiment from recognizer noise — same targets, same tempo, zero recognition error. Camera and keys mint distinct variants by construction.
  - **`input: touch` mode (2026-07-23)** — swipe on the screen to cut a note: hand = which half of the screen the swipe *starts* in (matches the two lanes), direction = the swipe vector through the same 4/8 `quantizeDir` sectors the camera uses (so touch supports 8 directions, unlike keys). Pointer Events with a per-pointer map (both hands can swipe at once), a ≥28 px travel threshold so a tap isn't a stroke, `touch-action:none` so swipes don't scroll; `recognizer: 'touch-swipe-v1'`, its own variant. This is the **iPad-friendly input**: it needs no camera, so it works over plain-HTTP LAN — whereas the camera (and voice-babble's mic) require `getUserMedia`, which iOS Safari only grants in a **secure context** (HTTPS or localhost), so those modes on an iPad would need the server to serve HTTPS (a `-tls` flag + locally-trusted cert, or a tunnel — frames/audio still stay client-side per §6). Touch swipe sidesteps that entirely and is the recommended tablet path.
  - Timer starts at the first note's arrival (the first selection opportunity — register item 2's reading); the last dispatched note's window closes inside the 60 s, so the client and the server's boundary filter agree.
  - `window.beatDebug` injects strokes headlessly (the voiceDebug pattern); scored-run camera reliability is user-tested only, like the mic.
  - **Run recording (scored runs, camera input)**: the composited canvas — camera, highway, notes, feedback — captured via `canvas.captureStream` → MediaRecorder (webm), replayed on the results screen with a download offer. This is moose-babble's "memorable-submission artifact" delivered early. Local-only (§6): the file leaves the browser only via the player's own download click. Recording is a settings toggle with an on-screen ● rec indicator (never silent), and the source is configurable — composited game view, raw camera only, or off; it is *not* part of the variant config — it doesn't alter the task. The recognizer reads its own 96×54 proc frame; recording and recognition never touch.
- `twin-stick` — **built 2026-07-23** (controller game). Beat-Saber-style paced highway for a **dual-analog gamepad**: two big circles (one per thumb) at the bottom, each showing the 8 octant positions and a **live dot for the stick** (eyes-free — you never look down); above each, a scrolling ribbon of 8-way waypoints joined by segments flows toward a "now" line at the circle, ~3 of lookahead with current/next emphasized. At each tick, each stick's octant is judged against that tick's target. Decisions:
  - **Two parallel channels, partial credit — not a product.** Both thumbs act every tick, so each tick logs TWO independent selections (left octant, right octant), N=8 each (log2 7 ≈ 2.81 bits), scored independently — get one right and one wrong, you keep the bits you actually sent. (Contrast beat-hands, one hand per note → a single 2×dirs symbol; here both hands are genuinely simultaneous channels — the §5 composable-channels principle.) Implemented with **zero server change**: one interleaved sequence over alphabet 0–7 (`GenSequenceInts`, `alphabet_size` = 8), where tick k reads `seq[2k]` (left) and `seq[2k+1]` (right); the client logs L then R per tick so `Replay` matches each against its sequence position. i.i.d. uniform per channel; `SequenceLen` = 2000 covers 2×(max ticks).
  - **Judge = octant-at-tick, window-based (beat-hands model).** Each tick's window is [tick−WIN, tick+WIN], WIN = min(setting, ½ beat − 10) so windows never overlap (rule 2). A stick's selection is *correct* iff it occupied the target octant at any frame in the window (finalized at window close); otherwise it logs the octant it ended in, or `miss` in the deadzone → incorrect. The judging is strategy-agnostic: **flick-and-return** (ballistic, marking-menu) and **steer-along-the-path** score the same, so the player's strategy — and which wins — emerges in the data.
  - **Input: Gamepad API** (`navigator.getGamepads`, standard mapping: axes 0–1 left stick, 2–3 right), polled in the rAF loop, quantized to 8 octants with a 0.4 deadzone via beat-hands' `quantizeDir` convention. **Works over plain HTTP** (no secure context — runs on the iPad with a paired controller, unlike camera/mic). `window.stickDebug` (setSticks / noteAt / counts / config / state) drives octants headlessly since a real pad can't be automated.
  - **Paced (`pacing: fixed-tempo`)** — the sanctioned §7 deviation (§5), tempo configurable; a self-paced variant (ribbon advances on your hit) is a recorded follow-up to measure lookahead-vs-reactive, as in beat-hands.
  - **Perspective ribbon (redesigned 2026-07-23).** The waypoints do **not** fall from the top of the screen — that made the landing octant illegible until the last instant (owner: "very confusing where they're actually going to land"). Instead each circle is a **tunnel with its vanishing point at the centre**: a waypoint rides its own octant ray, small and near the centre when far in the future, rushing outward with 1/z foreshortening (`screenFrac = FOCAL/(FOCAL + depth·DEPTH_MAX)`, FOCAL 0.9 / DEPTH_MAX 9) and reaching the rim exactly at its tick — so the direction it demands is readable from the moment it appears. Consecutive waypoints are joined into the incoming ribbon; faint concentric depth rings sell the tunnel; near dots paint bright/large over far dim/small. The nearest waypoint coincides with the rim target-marker at the tick. A **`← gallery`** back-link (bottom-left → `/env/`) was added here as the standard escape affordance (see §4.3.1).
  - **Judge = octant AT the beat, not "touched during a window" (2026-07-23 fix — scoring-integrity bug).** The first cut latched a hit if the target octant was seen at *any* frame in the ±window; that was **reward-hackable — sweeping a stick in a full circle every beat visits all 8 octants and harvests every target** (owner caught it). The score would then max out while transmitting *zero* information, which voids the whole measurement (§7: N must be honest — a strategy indifferent to the target must not score). Fixed: the selection is the octant a stick points at **on the beat**; the `hit_window_ms` setting is repurposed as an honest **late-arrival grace** — if a stick is still in the deadzone at the beat, it may settle onto its target within the grace, but the judge takes the **first** octant it lands on, never any octant swept through. A sweep is therefore at a random octant on the beat (~1/8) and never settles from centre onto a single target, so under advance-always it nets Sc−Si ≤ 0 → **0 bps**. Verified in-browser: sweep-in-circles → 10 % accuracy (chance), net 0 bits; genuine aim-and-hold → 93 %. `recognizer: 'stick-octant-at-beat'`.
  - **Empirical finding (owner, on-device): it is NOT parallel processing.** Watching both ribbons and driving two thumbs to *independent* arbitrary octants simultaneously is "insanely hard" — which is exactly the Kelso / Haken-Kelso-Bunz prediction the estimate hedged on (independent bimanual targets fight the mirror/anti-phase attractors). So the parallel-channel thesis largely *fails in practice*: the game works in theory but the bimanual-coordination tax is severe, and twin-stick is unlikely to be keyboard-competitive without mitigation. Candidate directions if revisited (unbuilt, recorded): bias the sequence toward mirror/identical L-R octant pairs (cheap coordination) and measure how much of the ceiling that recovers; a **single-stick** variant as the honest baseline the two-stick mode must beat; fewer directions (4-way) to cut the per-hand translation cost. This is the kind of "the contradiction is the experiment" result the backlog exists to produce — a real, measured *negative* on genuine motor parallelism.
  - **Estimate:** the payoff hinges on genuine bimanual parallelism. Ceiling ~3–4 bimanual ticks/s × 5.6 bits ≈ **17–22 bits/s**; realistic **~8–14 bps** after the bimanual-coordination tax (Kelso / Haken-Kelso-Bunz: mirror/identical octant-pairs cheap, arbitrary pairs expensive — expect a lopsided confusion structure) and directional error — genuinely keyboard-competitive because it's a real parallel channel, which no single-limb gesture mode is. Marking-menu research (Kurtenbach & Buxton) sets 8-way as the reliable eyes-free ceiling; 16-way is a later variant.
- `parabola-fall` — **built 2026-07-24** (one-thumb touch **rhythm** game). A shallow **"smile" (concave-up) arc** of N lanes sits at the very bottom; dots **fall from the top**, each down its lane, and **cross the arc at a fixed, configurable tempo**. The thumb rides the arc and must be in the crossing dot's lane at the moment it lands — **you never lift, you just slide**. Dots come from *above* the arc, so the hand never blocks the look-ahead. Decisions:
  - **Pivot from the earlier self-paced "slide-and-settle" cut (owner: "I really hate the mechanics").** That version (renamed from `maze`) made the thumb *settle* on a lit zone with a look-ahead insetting toward the arc centre — the settle-dwell felt bad and the inset dots sat under the hand. The falling redesign is the **falling-ribbon** idea from the very first design exchange: the constant vertical fall converts temporal separation into visible vertical space, so the look-ahead is legible above the hand and the pace is a clean clock instead of a dwell.
  - **Bounded jumps are the tunable trade — `lanes` (arc width) and `max_step` M are independent knobs (added 2026-07-24 after owner playtest: "can't yet control the maximum distance… you can jump across the entire parabola").** The first falling cut sampled the **absolute** lane i.i.d. → consecutive dots could land anywhere → full-width jumps, no cap. Fix: the dots are a **bounded random walk**, so consecutive dots are ≤ M lanes apart; a small M keeps thumb travel tiny and lets you run a **high tempo** at the cost of **fewer bits/step** (owner's explicit ask). The **honest alphabet is the bounded RELATIVE STEP**, i.i.d. over a sliding window: **N = 2M+1** → `log2(2M)` bits/selection (M=1→3/1 bit, 2→5/2 bits, 3→7/2.58 bits, …). Why relative-not-absolute *again*: bounding an absolute sequence would break rule-1 i.i.d.; sampling the step keeps it i.i.d. and the absolute dot lane is its running sum. **Zero server change**: `alphabet_size = N`, i.i.d. over `0..N-1`, `Replay` compares each logged step to the sequence.
  - **Sliding window (honesty).** Step k offers the N lanes `[winLo, winLo+2M]`, `winLo = clamp(prevLane−M, 0, Z−1−2M)` — exactly N distinct in-bounds lanes at every position (M clamped so `Z ≥ 2M+1`), so the alphabet never collapses and jumps stay ≤ M in the interior (up to 2M only right at an edge, where the window slides). The dot walk is a deterministic function of the sequence (like stream-typing's fixed stream), so the look-ahead is stable and server-reproducible; the thumb's crossing lane is decoded to a step against the ideal window (`committed == step` iff the thumb is exactly in the dot's lane, so the server agrees). This is the earlier `maze` fan idea, minimal form — but now serving *jump-bound* under the falling interaction the owner likes, not thumb-settle. `lanes`/`max_step` default 13/±3 (N=7) on phones, 21/±3 on iPad-width; verified `maxJumpSeen = 2M` and never more.
  - **Paced (`pacing: fixed-tempo`), the sanctioned §7 deviation** (like twin-stick/beat-hands) — tempo configurable (default 120/min = 2/s; up to 240). `look_ahead` beats set the fall time. The 60 s clock starts when the first dot lands (count-in on scored runs). A self-paced variant is a possible follow-up.
  - **Judge = lane AT the crossing (default), the honest twin-stick "at-the-beat" rule.** The selection is the lane the thumb occupies at the instant the dot crosses (first frame ≥ the beat) — never a lane swept through, so a sweeping thumb is at a random lane on the beat (~1/N) and under advance-always nets Sc−Si ≤ 0 → **0 bps**; only genuinely tracking scores. `recognizer: 'lane-at-crossing'`. **Variant `window`** (owner-requested): the *most common* lane over `[beat−WIN, beat+WIN]` (`lane-mode-in-window`) — softer, but still unharvestable by sweeping (a sweep isn't the mode unless you actually rest on the target). Default is the strict crossing read.
  - **Verified** (browser judge + headless server replay): at 13 lanes / ±3 (N=7) — perfect play → Sc all / Si 0 / no anomaly, **5.17 bps at 120/min**; parked at a fixed lane → net negative → **0 bps**; an 80%-accurate player → 80% acc → 3.10 bps (net scoring linear); `maxJumpSeen` = 2M and never more (interior ≤ M). No console errors; smile arc + local falling walk + thumb render correctly on phone and iPad widths. `window.parabolaDebug` (targetLane / laneWalk / maxJumpSeen / forceTick / setThumbLane / counts) drives the judge since real-time pacing + a real thumb can't be automated. `← gallery` back-link per §4.3.1.
  - **Estimate:** bits/selection × dots/s, where `max_step` now sets *both* — bigger M = more bits but wider jumps (needs a lower tempo); smaller M = fewer bits but tiny thumb travel (sustains a high tempo). The product is the experiment: e.g. ±2/5 bits at a fast 3–4/s vs ±4/9 bits at a slower 2/s. Rough band **~5–9 bps** across the sweet spots, tunable per player. The sweep of (lanes × max_step × tempo × judge) is exactly what the variants exist to measure; the paced-lookahead-vs-reactive question it shares with beat-hands.
- `lane-tap` — **built 2026-07-24** (self-paced touch tapping; the pixel-lens ⇄ parabola-fall synthesis). An **action strip of Z lanes along the bottom edge**; the current target is a **lit lane cell**, and the upcoming targets **stack vertically above it at their lane x-positions** (nearest at the bottom, faint path segments joining them), stepping down one row on each tap. **Self-paced ballistic taps** judged by x alone — the alphabet is 1D, so y carries no information and the tap zone gets a full strip-height of grace above the drawn cells. Decisions:
  - **Motivation — the occlusion finding (owner, on-device 2026-07-24).** Two-hand alternation on a flat iPad in pixel-lens died on the classic direct-touch occlusion problem: the resting hand covered exactly where the next 2D preview dots appeared ("hands get in the way and it's hard to see the next keys"); single-pointer iPhone play nearly matched the iPad *because* the hand stayed out of the field. parabola-fall's geometry (cues above, hand parked at the bottom, 1:1 x-alignment = zero translation) is the occlusion fix, but its bounded-walk alphabet is starved (log2(2M) ≈ 2.6 bits at ±3) because *sliding* pays for distance linearly. lane-tap keeps the geometry and swaps the mechanism: **absolute lanes sampled i.i.d. over 0..Z−1** (`alphabet_size = Z`, full log2(Z−1) bits/tap, no walk discount) reached by **lift-and-jump taps** (ballistic, distance nearly free), self-paced so none of the §7 pacing deviations apply. The vertical stacking also makes lookahead **order** self-evident — the thing the 2D preview dots couldn't show (owner's preview-3 pixel-lens bouts all aborted confused).
  - **The data behind the bet (owner's pixel-lens touch runs, 2026-07-24):** two scored ~15 bps runs at opposite configs (N=84 @ 2.50 taps/s, 375 ms IKI, 97% vs N=275 @ 2.12 taps/s, 450 ms, 94%) — a flat speed–information plateau. Fitting IKI = a + b·bits gives a ≈ 100 ms, b ≈ 44 ms/bit → gross saturates ~23 bps as N→∞: **more N buys little; cadence is the lever.** lane-tap attacks cadence: a 1D strip cuts travel, and cues-above re-enables **two-finger alternation** (one finger flying while the other commits — temporal alternation, not twin-stick's simultaneous independent targets, so the bimanual tax mostly doesn't apply). Every `pointerdown` is a selection (no isPrimary filter); alternation is technique, not config — it shows up in the IKI histogram.
  - **Config:** `lanes` 9/13/17/21/26 (default 13, 21 at iPad width) × `look_ahead` 3/5/8 (default 5). N = Z, no correction key (log2(N−1) prices the reserved slot — pixel-lens precedent). `recognizer: 'lane-tap-v1'`. Zero server change (numeric machinery). Taps above the tap zone (the cue/display area) are **not selections** — same status as a bare modifier key in stream-typing; they transmit nothing and cost time, so no harvest exploit exists (contrast the armed-cells-only design rejected in the crossing-mode discussion, which the twin-stick sweep hack kills).
  - **Estimate:** N=21 → 4.32 bits/tap; single finger ~2.5–3 taps/s → **11–13 bps**; two-finger alternation at 3.5–4 net/s → **~15–17 bps**, knocking on the brief's neural table from a phone/tablet. iPhone (13 lanes, one thumb) ~10–13 bps. If the alternation regime materializes, the lanes sweep upward (26+) is the follow-up — the IKI slope says wider N only pays once cadence is pinned.
- `pixel-lens` — **built.** A massive grid where a target lights up, the player mouses to it and clicks, with a loupe magnifying around the cursor. Huge N, but Fitts's law charges log-distance per acquisition — expect the pointer bottleneck (~4–10 bps) to dominate no matter how large N grows. Worth building to show *why* alphabet size can't rescue a serial pointing device. Implementation decisions:
  - **Honest N = the hitbox grid, not raw pixels.** Any click inside a cell selects it, so cells are the distinguishable selections; claiming pixel-count N with cell-sized hits would inflate the score. The top bar shows the pixel resolution, the derived grid/N, and the apparent cell size under the lens.
  - **Cell size is a setting (3/5/7.5/10 mm, default 5).** Smaller cells → more bits/selection (5 mm at 1280×720 ≈ 67×33 = N 2211 ≈ 11.1 bits); the "~2.5 cm hitbox" intuition lives in the *lens*: center magnification M = 25 mm / cell_mm (clamped 2–8), so a cell always appears ~2.5 cm at the lens center regardless of its true size.
  - **The loupe is a curved lens, not a flat zoom**: radial magnification profile m(r) = 1 + (M−1)(1 − (r/R)²) — M at the center, exactly 1 at the rim so the glass edge is continuous with the field. Rendered as ~22 concentric painter's-algorithm rings over a 1:1 offscreen scene, plus a rim vignette.
  - The alphabet is viewport-derived, so each window size is its own content-addressed variant; **resizing mid-run changes N and invalidates the run** (drop to practice with a notice).
  - **Run pins its own N/BITS at creation (2026-07-23 fix).** N/BITS are viewport-derived globals; on iPad Safari the viewport shifts mid-run (toolbar collapse, orientation) and `buildConfig` moves the global under an in-flight run. The client must score against the N it *sent to the server at run/start*, not the drifted global — otherwise `client.N != server.N` fires a false scoring anomaly (observed on iPad: client N=250 vs server N=84 on a degenerate 1-tap run). `startRun` snapshots `run.n`/`run.bits`; `scoreWith` and the HUD/sparkline use the snapshot. Sc/Si were already resize-safe (they compare against the fixed `run.seq`), so only N needed pinning. The server stays authoritative; this only makes the client agree by construction.
  - Numeric alphabets required a second pinned sequence derivation (`GenSequenceInts`, §4.3): digest read as 8 big-endian uint32s, rejection-sampled below 2³² − 2³²%m; golden vectors frozen. Selection logs carry cell indices as canonical strings, plus click x/y for Fitts analysis (§3c analog).
  - Attention and acquisition assists that don't change the alphabet: bull's-eye collapse cue on target spawn, persistent glow, loupe with magnified grid + crosshair, direction affordance on the loupe ring beyond ~280 px.
  - No correction key (N = cells; the formula's log2(N−1) prices the reserved slot regardless). Advance-always: a miss consumes the target.
  - v2 idea (recorded, unbuilt): crossing each click with a left/right home-row key chord ×4 options = +2 bits/selection — tests whether a parallel keyboard channel can ride on top of pointing.
  - **Touch/mouse input axis + look-ahead previews (built 2026-07-23).** `input: mouse | touch` is now part of the config (so it is part of the variant identity), which makes direct-touch vs indirect-mouse a within-environment leaderboard comparison instead of two separate environments. Touch **drops the loupe** — a touchscreen has no hover to magnify around before committing, so you tap the target directly — and switches to **finger-sized cells** (12/16/20/25 mm vs the mouse 3/5/7.5/10); Pointer Events unify both input paths, and touch feedback is a ring that pops at the tap point (no loupe rim to flash). `preview: 0–3` shows that many upcoming targets as **dimmer green bull's-eyes, visually distinct from the solid-yellow fill of the live cell** (color = "next" vs "now", a functional affordance, not symbol encoding) — **the pointing analog of stream-typing's visible character stream**: non-interactive (a tap only ever resolves the live target; tapping a preview cell just consumes the current target as an incorrect selection under advance-always), so it leaks no bits — targets stay i.i.d. uniform over N — yet lets the player pre-plan the next saccade + reach (eye-hand span), a legitimate throughput gain. Each `input`/`preview`/cell combination is its own content-addressed variant, so look-ahead's value is directly measurable. Server unchanged (config is opaque, canonical-JSON hashed; `alphabet_size` still drives N). pixel-lens uses no camera, so it runs over **plain HTTP on the LAN** (no getUserMedia secure-context requirement) — an iPad on the same WiFi reaches `-addr :4700`, and the server now prints the reachable LAN URLs at startup. This realizes the `touch-grid` sketch below as pixel-lens config axes rather than a new environment. Headless-testable via `window.pixelDebug` (state/config/counts/targetCell/previewCount/tapCell/trailingBps/sparkSeries). A `mouse`-with-`loupe:off` variant to isolate the loupe's contribution is a possible future axis (not built — input mode currently drives loupe presence).
  - **Split into two games: pixel lens (mouse) and drum pad (touch) — 2026-07-25.** The `input` axis above made mouse-vs-touch a within-environment comparison; owner's call is that they read as two different games, so they are now two: `/env/pixel-lens/` (mouse + loupe) and `/env/drum-pad/` (touch, finger cells, no loupe). One implementation still backs both — drum-pad's page loads pixel-lens's `game.js`/`game.css` and sets `window.BITRATE_INPUT='touch'` — but the modality is fixed by which page you opened rather than being a setting, so each has a single identity: the input row is gone from both sheets, settings persist under separate keys, and `config.environment` is now `pixel-lens` or `drum-pad`. **Historical runs are placed at read time, not rewritten**: the gallery maps a `pixel-lens` run whose variant config has `input: touch` onto drum pad, so old scores land on the right game without touching append-only history or breaking content-addressed variant identity (§4.4). Opening pixel lens on a coarse-pointer-only device shows a link to drum pad — a loupe needs a hover that device doesn't have.
  - **Touch defaults, and space reclaimed for them (2026-07-25).** Drum pad starts at **16 mm cells** (a fingertip pad is ~15 mm — the smallest cell that still hits first try) with **one look-ahead dot**, since a tap has no hover to plan under. Touch also drops the two insets it inherited from the mouse game: the grid's edge padding was sized to keep the loupe from being buried at boundary targets (`loupeR*0.6`, ~66 px) and the footer strip was reserved for the gear, which touch no longer shows — both become cells, i.e. more N.
  - **Drum pad is touch-only, and enforces it on the selection (2026-07-25).** Two different questions with two different answers: *does this device have a touchscreen* (`any-pointer: coarse` / `maxTouchPoints` — true on a touch laptop, so only good enough to warn on) versus *what made this selection* (`PointerEvent.pointerType`: `touch` / `pen` / `mouse`, per event, from the browser). The second is the authority, so the gate is on selections, not on device sniffing: **arming requires a touch-like selection in the current practice bout** (a touch laptop passes by tapping once; a mouse-only machine can't), and a mouse selection **during** a scored run invalidates it the same way a focus loss does. A stylus counts as touch — direct pointing at the same cell, not cursor indirection. A machine with no touchscreen at all gets a standing red banner up front rather than discovering it at the arm button; practice still works with the mouse. This keeps drum pad's leaderboard a *touch* leaderboard, which is the only thing that makes it comparable to pixel lens's mouse one.
    - **Warnings overlay, they never reflow (verified 2026-07-26).** Both the standing `#device-warn` banner and the transient `#notice` toast are `position: fixed` on `<body>`, outside `#topbar` — so they can't feed the `ResizeObserver` that publishes `--topbar-h`, can't move `#field` (absolute, `top: var(--topbar-h)`), and can't change N mid-run. Measured identical field rect, `--topbar-h`, N and `body.scrollHeight` with the banner up, with the toast up, and with neither. That is the requirement: **a warning that resized the field would resize the alphabet**, which is a §2 correctness bug, not a cosmetic one. They are also **pointer-transparent** (`pointer-events: none`, with `a { pointer-events: auto }` so their links stay clickable): the banner sits over live cells, and a tap it swallowed would be silently lost time inside a scored run — the one toast that can be up mid-run is the 2.5 s "press Esc again".
  - **Cell size is asked once, at first open (2026-07-25).** It's the one setting that changes what the game *is* — it sets N and whether a tap lands first try — and the right answer is a property of the player's hand and screen, which no default can know. So the first open of either game shows each available size as a **3×3 grid drawn at its true physical size** (a millimetre figure can't answer "can your finger hit that") with one cell lit, **priced with what it actually yields on this screen** — the grid that fits and the bits one selection is then worth, so the trade is on the label rather than left to be discovered — and the choice becomes the saved default. Those numbers come from the same `gridMetrics()` the game builds from, recomputed whenever the grid is: the header band settles after boot, and a promise made against a stale layout is one the game won't keep. On a phone the samples stay true-size and drop to a **2×2**, since a 3×3 of 25 mm tiles is most of the screen. A note points at the settings sheet for changing it during practice, which is where every subsequent change happens. Skipped entirely once a size has been chosen on that device.
  - **Drum pad's picker also coaches the choice it can't make (2026-07-26).** Tile size is only half the decision; the other half is *which device and how many fingers*, and a first-session player has no way to know either — so the touch picker carries three one-line tips above the options, at the one moment they're actionable. **fingers**: tablet → two index fingers, phone → one, because on direct touch the resting hand covers exactly the board you're reading (§ the occlusion lesson). **device**: a tablet fits more tiles at the same physical size, so each tap is worth more bits — take it if the arm moves freely; a phone's shorter travel can win if reach is the limit. **try it**: practice is free, so spend a few seconds at two or three sizes rather than reasoning about it. The sub-line states the trade in one sentence — more tiles = more bits per tap, smaller tiles get missed, a miss costs double, so pick the smallest tile you hit almost every time. Deliberately **touch only** (pixel lens's mouse copy is untouched) and deliberately *advice*, not a default: the picker can price the bits but only the hand knows the accuracy, and coaching first-session players is worth more than another config axis. Kept to three short lines because everything it pushes below the fold is a tile option.
  - **Tapping a look-ahead dot: field border only, no ring (2026-07-26).** Landing on a green "next" dot instead of the yellow "now" cell is a distinct error — acting on next as if it were now — and gets a louder reaction than an ordinary miss: a red pulse around the whole field (plus a strong loupe-rim flash in mouse mode). The **tap-point burst that originally accompanied it is gone** (owner's call): the border alone is sufficient, and a red ring drawn on top of the very green dot you just hit read as two separate errors rather than one loud one. Ordinary misses keep their small ring at the tap point, so the two are still told apart by *shape of feedback*, not just intensity. `pixelDebug.earlyFlashCount()` now counts invocations rather than DOM nodes, since there is no longer a node to count.
  - **The error buzz was inaudible on a tablet (2026-07-26).** It was a 110 Hz square at 0.05 gain for 90 ms — fine on desktop, silent on an iPad, whose speakers are physically too small to radiate a 110 Hz fundamental; the buzz was present in the audio graph and absent from the room. Now **220 Hz at 0.12 for 100 ms**: a square's harmonics then sit where small speakers actually work, and it stays a low buzz rather than a beep on a laptop. Applied to stream-typing identically so "the same burst as stream-typing" stays true (it is off by default there, on by default in drum pad). Also **warmed on the first interaction of the session instead of the first miss** — iOS hands out every `AudioContext` suspended and only a user gesture may start it, so a buzz that had to construct its own context arrived late or not at all; the warm-up listener is self-removing rather than `{once}`, so an interaction taken before the config lands or with the buzz switched off doesn't burn the one chance. **Not fixable in code:** iOS silences *WebAudio* under the ring/silent switch (unlike `<audio>` elements), so a muted iPad stays silent no matter what we schedule.
  - **Practice metrics are a trailing-60 s window + rolling sparkline — shared across EVERY environment (2026-07-23).** The practice HUD bps/counts reflect only the last 60 s so the figure tracks current skill instead of being dragged down by warm-up; a small **client-side rolling sparkline** (bits/s over a 6 s window sampled each second, blue so it never collides with target colors) sits in the **header band's right zone**, in flow beside the HUD figures, so it stays out of the play area; its x-span fills the width for the first minute then holds at 60 s and scrolls. Scored-run HUD stays **cumulative** (it previews the actual 60 s score). **Amended 2026-07-25: the graph is always on screen** — from page load (an empty axis before the first selection) and through the scored run, not practice-only as first built — because a graph that appears and disappears moves the band and reads as a bug; owner's call, and the brief is indifferent (it requires the running bps figure, which is unchanged). Because every environment logs the same `{verdict, t_pressed_ms}` selection schema, the computation and SVG are one shared implementation in `common/results.js` (`trailingBps` / `sparkSeries` / `sparkHTML`, styled by `common/results.css`), called from each env's `renderHud` — keys, pointer, voice, and swipes all feed the same code. All derived from the selection log in-browser — no server involvement.
- `touch-grid` — **realized as pixel-lens config axes (2026-07-23), not a separate environment** (see the pixel-lens entry above). The estimate below stands as the projection for pixel-lens **touch mode**; it was originally logged 2026-07-23 as the direct-touch sibling of `pixel-lens`: a grid of comfortably-sized targets fills an ~11″ tablet screen (iPad-class), a cued cell lights up, the player taps it. Same honest-N accounting as pixel-lens (N = distinguishable cells, not pixels), same numeric-alphabet machinery (`GenSequenceInts`), same advance-always/reserved-slot pricing, self-paced (no §7 issue). The whole reason it's interesting: it strips out pixel-lens's two worst inefficiencies — the **cursor indirection** (finger goes straight to the target, no mouse-to-pointer transfer function) and the **loupe** (targets are already finger-sized, so no magnification round-trip). Fitts still charges the finger, but from a much better constant.
  - **Estimate (first-session, honest regime): ~7–8 bps net; tuned ceiling ~9.** Model: t(N) ≈ pop-out cue detection + motor plan (~0.30 s, roughly flat because the lit cell pops out pre-attentively) + touch Fitts MT. For a fixed screen, cell width W ∝ 1/√N, so ID = log2(0.45·√N + 1) grows only ~½·log2 N while bits/selection = log2(N−1) grows ~log2 N — the numerator outruns the denominator, so bigger N keeps paying *until* cells shrink past reliable-tap size and error/search costs bend the curve down. Worked points at D≈0.4·screen, touch a≈0.15 s, b≈0.10 s/bit: **N=16** → t≈0.60 s, 3.9 bits → 6.5 bps; **N=32** (≈6×5) → t≈0.63 s, 4.95 bits → ~7.9 bps; **N=48** → t≈0.65 s, 5.5 bits → ~8.4 bps; **N=64** → t≈0.67 s, 5.98 bits → ~8.9 bps gross. Net is ~10–15% under gross once misses on shrinking cells (finger contact ~9 mm; keep W ≥ ~0.7″ for low error) and the correct−incorrect penalty are charged. **Recommended honest sweet spot N ≈ 24–48** (cells ≥ ~0.8″, low error, no practice tax) → **~7–8 bps net**; pushing N ≥ 64 trades error for bits and the net barely moves.
  - **Where that lands it:** above `pixel-lens`'s mouse band (~4–10 bps, but realistically mid-single-digits once cursor travel + loupe are paid) and near the top of the non-keyboard family — plausibly rivaling a plain keyboard typing env (~8–12 bps). Direct touch on a big screen is, structurally, "a keyboard whose keys are spatially cued instead of memorized": the read-the-cue → point loop replaces the read → recall-key loop, trading motor recall for a (fast, pop-out) visual search. That's why it can be competitive where pixel-lens can't — it's the same pointing family but paying a much smaller constant.
  - **8-direction swipe sibling (lower ceiling, no large-screen dependence).** Finger parks, flicks in one of 8 directions; N=8 → log2(7)=2.81 bits/stroke, or 16 with L/R hand or two lengths. No travel and no search (respond to the cued direction), so cadence is high (~2.5–3.5 strokes/s), but N is capped and diagonal/cardinal confusion runs ~5–15%, plus the cue→direction mapping adds translation time. Estimate **~5–6 bps net** — worse than the tap-grid because the grid's log2(N) buys more than the swipe's cadence does, *but* it works on a phone-sized screen, which the tap-grid doesn't. (Same recognizer verb as `beat-hands`, minus the pacing — a self-paced touch reuse of that direction-quantizer, no webcam.)
  - **Hard caveat (the reason this stays a backlog data-point, not a ship candidate): it assumes the grader has a large touchscreen.** The panel does one 60 s first-contact run each on their own hardware (§6); if that's a laptop, `touch-grid` is ungradeable as the primary artifact. This is the owner's own stated worry, recorded here so the tradeoff is explicit — build it as an alternative/leaderboard entry and a "direct-touch beats indirect-pointing" data point, not as the thing we bet the grade on. The swipe sibling partially de-risks the hardware bet (runs on any touch device) at the cost of ceiling.
- `chord-pad` — i.i.d. sampled key chords. C(8,2)=28 chords ≈ 4.75 bits; adding 3-key subsets gives 92 ≈ 6.5 bits/event. Information-theoretically elegant, **expected to lose badly on a first-session eval** because it discards twenty years of single-key motor training. Worth building to demonstrate the point empirically.
- `foot-pedal` / modifier-state — a held modifier doubles the alphabet for as long as it's held: one decision, a bit on every keystroke underneath. To stay i.i.d. the modifier state must also be random, so if it flips every target you've bought a second decision. Only pays if key+modifier fuses into one overlearned chunk.
- `dual-modality` — speak random digits while typing random letters. Per Wickens' multiple resource theory this is the best candidate for a genuinely additive channel (different modality, code, and response channel). Expected to fail on PRP costs plus ASR latency, but it's the most defensible outside-the-box test.

---

## 6. Public hosting

Hosting publicly is the **actual** solution to the small-n problem. Requirements:

- Zero-friction identity. **No PII, no accounts, no email, no username prompt.** The client mints a `device_id` (§4.4) and the UI shows its derived pseudonym; a visitor is playing within seconds of landing. IP is used for rate limiting only, never as identity.
- A visible consent notice: we record keystroke timings and accuracy for research; note that keystroke dynamics are quasi-biometric.
- Leaderboard filterable by variant, with **human-verified and unverified pools kept separate**. A public typing leaderboard *will* attract scripted entries.
- Bot heuristics (flag, don't block): implausibly low IKI variance, sustained sub-80 ms intervals, 100% accuracy at high speed, absent keydown/keyup jitter. Flagged runs go to the unverified pool and are excluded from variant analysis.
- Rate limiting per IP on run submission.
- Webcam/microphone modes: all capture, recognition, and recording is client-side. Recordings are shown to the player and offered as a local download; **video and audio are never uploaded** — only the derived selection log is.
- Aggregate stats page: bps distribution per variant, learning curves by exposure index, first-contact distributions. **First-contact data from strangers is the closest proxy we will ever get to the grading panel.**

### 6.1 Pilot protocol — invite-only guided sessions (added 2026-07-23)

Realistic recruitment is ~10 known people playing a handful of games each, not a crowd. At that n, a **designed within-subject session beats an uncontrolled sample**: the claims we need (modality ordering, first-contact range) have effect sizes measured in multiples, so they need pairing and even coverage, not volume — and recruited friends will follow a protocol, which anonymous traffic never does. Everything in this section is lab machinery (§8: never ships) and adds no PII.

**Participant identity — an invite token above device identity.** Recruited players get personal invite URLs (`/join/p-7f3a`); visiting one stores the opaque token in `localStorage` next to `device_id`, and every subsequent run carries `participant`. The token→person mapping lives in a local file on the owner's machine — never server-side, never in the repo; the server knows only opaque tokens (consistent with this section's no-PII stance). One person on two devices = one token, two device_ids: **participant is the analysis unit; device_id stays the leaderboard unit.** The owner plays under the reserved token `p-self` so author data segments automatically (§3 analysis plan). Non-invited traffic has `participant = null` → the "organic" pool: bonus context, never pooled into pilot analysis.

**Guided session — the app enforces the protocol, not an instruction sheet.** `/pilot` walks the participant through their server-stored session plan step by step; progress lives in the `session` record (§4.3), so an interrupted session resumes where it left off. Budget ~10–12 min:

1. **Ship-config grader rehearsal — always first, never randomized.** ~90 s familiarization, then one 60 s scored run on the ship `stream-typing` config — deliberately mirroring the grading ritual (brief familiarization → single scored run). This run is the grader proxy and the participant's only naive exposure to the ship config; randomizing its position would spend the scarcest data in the study on protocol symmetry. The distribution of these runs is the README's predicted panel range.
2. **Comparison block — two assigned roster environments** (assignment below), each: ~60 s familiarization (voice-babble's includes template calibration — budget ~2 min there), then 2 × 20 s bouts (§3: short bouts, many reps).
3. **Ship re-anchor.** One closing 20 s ship-config bout, so every session brackets the comparison block with the baseline — a warm-up/fatigue drift check, and the same-session keyboard reference the paired-delta analysis subtracts.

**Assignment — deterministic and balanced; random order would do worse here.** The comparison roster is a config file, default (owner pick, 2026-07-23): `pixel-lens/touch` (phone or tablet), `pixel-lens/mouse` (desktop), `stream-typing` (ship config), and `voice-babble` (`solfege` or `letters-9`, fixed at invite-mint so the arm is one config per participant). Notes on the picks: the two pixel-lens arms make direct-touch vs indirect-mouse a *within-pilot* comparison (the §5 touch-grid question, answered with real people); `stream-typing` bouts double as extra anchor data for participants who draw that arm; `pixel-lens/touch` is the capability-gated arm (needs a touch device — a participant probed desktop-only gets the standard substitution). beat-hands and twin-stick are out of the default roster — assign them ad hoc to participants known to have a webcam they'll tolerate or a gamepad (neither is honestly probeable before use). At invite-mint, participant *i* takes pair *i* mod 6 from the fixed cycle of the C(4,2)=6 roster pairs, within-pair order alternating — 10 invites → each environment lands in ~5 sessions with balanced first/second positions. At n=10, uniform random assignment leaves lopsided coverage more often than not and buys nothing the balanced cycle doesn't. **Hardware fallback:** the pilot page probes capabilities (webcam, mic, pointer class); if an assigned environment can't run, substitute the first always-runnable roster environment not already in the session and record the swap in `session.substitutions` — even-ish coverage with an honest log beats a perfect plan nobody can execute.

**Seeds.** Fresh per participant, always (§7: never replay a sequence to a player who has seen it). Across participants, the seed for a given (environment, step slot) is shared — pinned derivation SHA-256(pilot_salt ‖ env ‖ slot) — so between-subject comparisons ride identical sequences (§3 paired seeds in the one regime where naivety is guaranteed: different people). This is variance reduction, not validity — **cut it first** if implementation time is tight.

**Consent.** The pilot page opens with this section's consent notice. A participant who bails keeps whatever they completed: `status: abandoned`, analyzed as partial, reported in the exclusions table.

---

## 7. Pitfalls — do not do these

**Rule compliance**

- Do not add predictive text, autocomplete, word targets, or any language model to target generation. Instant disqualification.
- Do not exclude repeated characters. `ll` and occasionally `lll` must appear — suppressing them breaks uniform i.i.d. sampling. Render runs with a subtle marker instead; they're fast to type but easy to miscount.
- Do not vary N mid-run. Calibration happens in familiarization; the scored run reports one fixed N.
- Do not reuse a seed for a player who has already seen it. Paired seeds are for cross-variant *analysis*; a replayed sequence is predictable to the player who typed it, which corrupts the measurement even though the sequence itself is i.i.d. Scored runs always get fresh seeds.

**Presentation** *(binds `stream-typing` and anything shipped; alternate environments may violate these deliberately as experiments — see §5. Rule-compliance items bind everything, always.)*

- No rhythm gate, beat, or fixed scroll speed. Ever.
- Do not block on error and force a retype.
- Do not start the timer on page load or after a countdown.
- Do not place the bit-rate HUD near the fixation point. A number twitching in peripheral vision steals attention. Corner placement, low contrast, update at exactly 1 Hz so it doesn't shimmer.
- Do not add color coding, 3D, or decorative animation to the target stream. Free in bandwidth, negative in translation cost.
- Do not render the stream small or in a font with ambiguous glyphs. Targets at ~3x body-text size; `i`/`l`/`1` must be unmistakable at a glance; browser zoom must not break the layout. With three graders, one squinting player is a third of the score.

**Implementation**

- Use `keydown`, not `keypress` or `keyup` — it fires earliest.
- Match on `event.key` (the character produced), not `event.code` (the physical key) — non-QWERTY layouts must just work. For the lowercase alphabet, case-fold the input and surface a visible warning when `getModifierState('CapsLock')` is on, rather than silently failing every keystroke.
- Detect IME composition (`event.isComposing`, keyCode 229) and refuse to start a scored run while an IME is active — composition breaks the one-keydown-one-selection model.
- Ignore `event.repeat` (held-key autorepeat) — it is not a selection.
- Ignore bare modifier keys as selections.
- `preventDefault` on browser shortcuts that would steal keys mid-run.
- Handle focus loss and tab-visibility change mid-run: mark the run invalid rather than silently scoring a gap. An invalidated run never dead-ends: it drops straight back to practice (no interstitial error screen) with a transient notice explaining why, and Enter re-arms a fresh-seed scored run. A flustered grader burning goodwill on a confusing error state is a scoring risk.
- Deliberately ending a scored run takes **Esc twice** (the first Esc shows a "press Esc again to end the run" prompt that a subsequent keystroke or 2.5 s withdraws) — one stray Esc must not burn a grader's run.
- If `run/submit` fails, queue the payload in `localStorage` and retry with backoff. Never lose a completed run to a network hiccup.
- Use `performance.now()` for all timing, never `Date.now()`.
- No network calls, no `console.log`, no layout thrash inside the keydown path.

**Dependencies and offline operation**

- Do not add a third-party dependency to Tier A. If one seems necessary, that is a signal the design went wrong — check whether the stdlib covers it first (it almost always does here).
- Do not reference any CDN, webfont, analytics script, or remote asset from shipped frontend code. **Verification: `grep -rE 'https?://' ` over the shipped HTML/JS must return zero hits.** Make this a test.
- Do not require a virtualenv, `pip install`, `npm install`, **or any installed runtime at all**. `run.sh` must work on a machine that has never seen this project, has no internet connection, and has neither Python nor Node installed.
- Do not use a bundler, transpiler, or Node toolchain. The build is `go build` plus ZIP assembly, nothing more.
- Do not use cgo or any C-backed module — static cross-compilation is the entire ballgame.
- Do not let Tier B tooling leak into Tier A. Enforce with the CI check that `go.mod` requires nothing.

**Epistemics**

- **Do not reinterpret a locked constraint to unblock a feature.** If a design idea conflicts with the PDF's letter — or even plausibly conflicts — flag the deviation to the owner *before* building, quoting the PDF. The interpretation register (§1) is where readings live; it only grows by explicit sign-off. (Instituted 2026-07-22 after the word-targets lapse: rule 1's "no word-level targets" was briefly reasoned away mid-build instead of being surfaced first.)
- Do not use the synthetic player to rank variants. It validates correctness only. Any leaderboard entry generated by it must be tagged and excluded from analysis.
- Do not compare variants across sessions without counterbalancing and paired seeds.
- Do not let well-practiced scores drive the final choice. Weight first-contact data.

---

## 8. Deliverable packaging

The submission is the harness frozen to the winning variant, with experiment machinery stripped. **The leaderboard, gallery, telemetry, export/merge, and device identity exist to pick the winning variant — none of them ship.** The graders receive a ZIP containing the game, `run.sh`, and the README; a scored run is stored locally at most (to render the results card) and nothing more.

Two build profiles from one source tree, both produced by the build script:

- **`lab`** — the full harness: server, leaderboard, gallery, telemetry, export/merge. What we run daily and deploy publicly.
- **`ship`** — the deliverable ZIP: the winning mode's assets embedded in a minimal server build (seeded sequences + score recomputation + static serving only; lab endpoints compiled out via Go build tags), binaries under `bin/` (Linux x86_64/arm64 per the brief's Linux assumption; macOS riding along as courtesy), `run.sh`, README. No leaderboard, no telemetry, no tracking of any kind. Stripping happens in the build, not behind runtime flags — dead tracking code in the deliverable invites grader questions we don't want to answer.

### The ship gate — this test can never break

The single most important property of the project: **a grader unzips the bundle and `./run.sh` works, offline, first try.** That is enforced by machine on **every commit**, not by discipline:

1. The build script cross-compiles every platform binary and produces `dist/bitrate.zip`.
2. The gate unzips it into a fresh temp directory — simulating the grader's machine: no repo, no venv, no prior state.
3. Runs `./run.sh` with network access blocked (plus the no-external-URL grep from §7 as a static backstop).
4. Loads the page in a headless browser (Playwright — a Tier B test dependency; it never ships) and drives a full scored run with the synthetic player.
5. Asserts: results card rendered with bps/N/Sc/Si; server score matches the reference implementation; zero requests to non-localhost hosts.
6. Runs the required matrix on **Linux runners** — the brief's guaranteed platform — x86_64 and arm64 where CI offers them, launching through `bash run.sh` exactly as a grader would, plus once inside a minimal container (no glibc, no xdg-open) to prove the static binary and the URL-printing fallback. A macOS leg with the quarantine simulation covers the courtesy path, non-blocking.

The gate proves the mechanical path, not the human one — it cannot see default-browser weirdness, desktop-environment quirks, or real keyboard layouts. That is what the manual ritual below on a clean Linux box is for. The gate makes regressions impossible; the ritual makes the first impression real.

Wired in as a required GitHub Actions check and a local pre-push hook; a commit that reddens the gate does not land. The gate is the every-commit proxy for the manual Wi-Fi-off ritual below — not a replacement for doing it once for real before submitting.

Deliverable contents:

- `run.sh` — no arguments, no setup, no network, **no runtime requirements of any kind**: dispatches on `uname` to the bundled static binary. **The brief says to assume a Linux environment, so Linux is the supported platform**; macOS is a courtesy path (we develop there, and it costs ~16 MB), Windows is out of scope per the brief. Launch hardening, each item earned by a real failure mode:
  - The server binds `127.0.0.1:0` — **loopback explicitly** (binding all interfaces invites firewall prompts), OS-assigned port (never a hardcoded one the grader's machine might have occupied).
  - The binary **prints the URL prominently first, then** tries to open the browser (`xdg-open`, `open` on the courtesy path — the branch lives in Go). If browser-open fails, there's no GUI handler, or it lands in the wrong profile, the grader pastes the URL. Browser-launch is best-effort, never load-bearing.
  - `run.sh` re-`chmod +x`es the binary before exec — ZIP extraction routinely drops execute bits. The README's canonical invocation is `bash run.sh`, which also sidesteps a stripped exec bit on the script itself.
  - Courtesy path only: on macOS, strip `com.apple.quarantine` before exec (unsigned + quarantined = Gatekeeper block). No signing or notarization needed — Linux graders never hit this.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   BIN=bin/bitrate-linux-amd64 ;;
  Linux-aarch64)  BIN=bin/bitrate-linux-arm64 ;;
  Darwin-arm64)   BIN=bin/bitrate-darwin-arm64 ;;  # courtesy; Linux is the supported platform
  Darwin-x86_64)  BIN=bin/bitrate-darwin-amd64 ;;
  *) echo "unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
chmod +x "$BIN" 2>/dev/null || true  # ZIP extraction routinely drops exec bits
command -v xattr >/dev/null 2>&1 && xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
exec "./$BIN"   # binds 127.0.0.1 on an OS-assigned port, prints the URL, opens the browser
```

- Verify before submitting: unzip the actual `dist/bitrate.zip` on a clean **Linux** machine (fresh VM or live-USB — something with a desktop and a browser, since that's what graders will use) with **networking disabled**, run `bash run.sh`, play a full scored run. Anything that fails this test does not ship.
- Familiarization mode (free practice on the static ship config — in-game calibration is v2, §2.6), an explicit arming step, then one scored 60-second run.
- Ship polish outside the keydown path: arming screen, a results-card moment, satisfying peripheral feedback. The brief says *game*; graders are human, and a bare bench test invites a judgment penalty that no bit rate recovers.
- Belt-and-suspenders: the README links the hosted instance (§6) — if everything local somehow fails, a grader still plays the identical build in a browser tab.
- Results card reporting **final bps, N, Sc, Si**, plus the §4.3 per-run diagnostics under the headline (computed locally by the ship server; nothing leaves the machine).
- `README.md` covering: choice of N and why (overlearning vs Hick's law), the N=27 backspace accounting with the brief's reserved-key rationale, input modality and why the keyboard beats the alternatives, presentation rationale (pinned fixation, lookahead, self-paced), the error-policy and correction-strategy argument (miss → backspace → retype), and the negative results from the gallery — the brief says "surprise us," and the gallery of honestly-measured failures is the surprise.

One framing worth including in the README: a healthy person touch-typing lands around 20–40 bits/s, which dwarfs every invasive system in the brief's reference table (best iBCI ~8.6 bps). That contrast is the point — the interface, not the human, is usually the bottleneck, and that is exactly why tapping the channel *before* the motor bottleneck is interesting.

---

## 9. Build order

1. Go server (`net/http`, stdlib only), JSONL storage, data model, seeded sequence generation, authoritative scoring.
2. `stream-typing` environment, baseline config, live HUD, served end-to-end. **Get a personal baseline number before the parameter space grows.**
3. Synthetic input harness + scoring reference test + the offline/no-CDN verification tests from §7.
4. Cross-compiled ship build + the ship gate (§8) wired into CI — from this point, every commit proves the grader path works.
5. Settings menu (behind a gear/hamburger, out of the fixation path) with live reconfiguration — every tweak mints or reuses a content-addressed variant, so ad-hoc experimentation lands in the registry automatically.
6. Run storage, leaderboard, gallery.
7. Analysis notebook: paired comparison, learning curves, digram costs.
8. Public deploy + §6.1 pilot machinery: invite tokens, guided session runner, `lab/pull.sh` export→merge cadence.
9. Alternate environments from the §5 backlog.
10. Freeze winning variant, strip, package, write README.
