# bitrate — project guide for agents

Read this first, then `bitrate-harness-spec.md` for detail. This file is the
map; the spec is the territory.

## Sources of truth, in order

1. **`swe-homework.pdf`** (repo root, also served at `/assignment.pdf`) — the
   actual assignment. **The PDF wins over everything, always.**
2. **`bitrate-harness-spec.md`** — the build spec: every design decision with
   its rationale, the interpretation register, pitfalls, build order. Decisions
   live *in the spec*, not in chat. When a discussion settles something, write
   it into the spec with the reasoning.
3. This file — the summary. If it disagrees with the spec, the spec is right
   and this file needs updating.

One instruction arrived outside the PDF and is authoritative anyway: **assume a
Linux grading environment.** The PDF names no platform — do not "correct" the
Linux-first packaging on that basis.

## The assignment

Design and build a game that maximizes the bit rate a human can push through a
computer interface. Three graders each get a brief familiarization period and
then play **one scored 60-second run**; the submitted score is the **average of
the three**.

```
B = log2(N − 1) · max(Sc − Si, 0) / t     bits per second
```

`N` = number of possible selections including the reserved backspace key (≥ 3);
`Sc` / `Si` = correct / incorrect selections; `t` = elapsed seconds.

Three facts that drive every decision:

1. `B` = (bits per selection) × (net correct selections per second). They trade
   against each other; optimizing one alone is the default failure mode.
2. Errors are **double-penalized** — a miss forfeits +1 *and* subtracts 1. The
   optimum is high accuracy with speed second, not the reverse.
3. The −1 is a backspace and **it counts in N**, so shipping a backspace is free
   bits: the formula charges for the reserved key whether you implement it or not.

### Hard constraints (from the PDF — these bind every environment, no exceptions)

| # | Requirement |
|---|---|
| 1 | Targets sampled uniformly at random **with replacement** from an alphabet of size N ≥ 3. i.i.d. — **no patterns, no structure, no language models, no predictive text, no word-level targets.** |
| 2 | Unambiguous ground truth at every moment. |
| 3 | Running bit rate over all elapsed session time, updated ≥ 1×/sec. |
| 4 | A single 60-second timed evaluation; report final bit rate with N, Sc, Si. |
| 5 | `run.sh` (or equivalent) launching with no exotic setup. |

**Never reinterpret a locked constraint to unblock a feature.** If an idea
conflicts — or plausibly conflicts — with the PDF, stop, quote the PDF's exact
words to the owner, and build only after explicit sign-off; then record the
reading in the spec's §1 interpretation register. (Instituted 2026-07-22 after
word-level targets were reasoned into two environments before checking; both
were quarantined.)

## The approach

The project is deliberately larger than the deliverable, and this is the plan:

1. **Research first.** Perceptual bandwidth vastly exceeds motor output —
   the retina delivers megabits, we emit tens of bits per second — so the
   bottleneck is the effector, not the eye, and spare perceptual capacity is
   best spent on **lookahead, not decoration**. Rough ceilings for
   *unpredictable* targets on commodity hardware: touch typing ~20–40 bps,
   mouse pointing ~4–10 (Fitts-bound, serial), trackpad ~3–5, webcam gaze ~2–5,
   voice latency-bound. Keyboard wins structurally — parallel, discrete,
   overlearned, low-latency. Stenography/piano/speech beat it only with years of
   training or by exploiting language redundancy the brief forbids.
2. **Build many games, not one.** A gallery of environments — the serious
   baseline, honest contenders, and some gloriously doomed ones. The negative
   results are the most interesting part of the submission ("surprise us").
3. **Play them ourselves,** but never trust our own practiced scores (see
   below).
4. **Publish the app** at a public URL and **have friends play**.
5. **Let the leaderboard decide what ships.** The winning variant gets frozen,
   stripped of lab machinery, and packaged as the deliverable.

**A simulator cannot rank presentation variants and must not be used to.** It
would encode our priors and then "discover" them. Automation is legitimate for
(a) the synthetic-input harness as a *correctness* test, (b) config pruning by
algebra (an 8-letter alphabet must sustain ~1.57× the cps of 26 to break even),
and (c) a digram-cost model for choosing *alphabet subsets* only.

**The single biggest self-deception risk: the graders are first-session and we
are not.** First-contact scores are precious and weighted heavily; a variant
that rewards practice will look better to trained-us than it will score with the
panel. Use short bouts (20 s) with many reps, paired seeds, counterbalanced
order, and treat learning as a covariate.

## Locked design decisions (baseline `stream-typing`)

Treat as decided — the rationale is in spec §2 precisely so they don't get
"improved" into the ground.

- **Keyboard**, 26 lowercase letters + backspace → **N = 27**, log2(26) ≈ 4.70
  bits/selection. Make N as large as the player's *overlearned* repertoire
  extends and not one key further (Hick's slope collapses with practice).
- **Backspace is a first-class selection**: correct iff it deletes an
  uncorrected error immediately behind the cursor. The taught strategy is
  **miss → backspace → retype** (+2 swing for ~2 keystrokes). No exploit exists.
- **Advance always** — every keypress consumes the current target, right or
  wrong. Clean ground truth, no desync, no stall state, finest scoring
  granularity.
- **Pinned cursor, deep lookahead (default 8), self-paced.** Text flows into a
  fixed fixation point; no beat, no scroll speed, no timing gate. Showing
  already-drawn future characters does not violate i.i.d.
- **Chunking on by default (groups of 4)** — display-only separators, never
  targets.
- **Keyboard map under the stream, on by default** (`keyboard`, 2026-07-26) —
  QWERTY diagram with the current key filled yellow and the next outlined
  green (drum pad's colours, one visual language). The stream says which
  letter, the map says which finger: a glyph is not a spatial stimulus, and
  first-session players translate. **A config key, not a local preference** —
  same axis as lookahead/chunking, since presentation moves the bit rate and
  on/off must be separate variants. Green is gated on `lookahead >= 1` (never
  reveal more future than the stream does); keys outside the alphabet render
  inert; highlight changes colour only, never size (the band/fixation rule).
- **Timer starts on the first keypress** of an explicitly **armed** run, and
  ends exactly 60.000 s later. All boundary math on `event.timeStamp`.
- **Stimulus-response compatibility**: the stimulus *is* the response. No
  "purple → press F" translation layers.
- Rejected with reasons: casing (N=53, expected net loss), multi-character
  doublets (bits/sec invariant, coarser scoring under double-penalized errors),
  word-level targets (banned by rule 1).
- Per-player N calibration is **deferred to v2**, and when it lands the
  principle is **calibration is a config compiler, not a game mode**: it writes
  a static config, then the run executes that config with nothing adaptive.

## Architecture

**Two tiers, strict boundary.**

- **Tier A — server + anything shipped.** Go **standard library only**,
  `CGO_ENABLED=0` static binaries, frontend assets via `go:embed`. Vanilla JS,
  no framework, no build step, no CDN, system font stack, WebAudio for tones,
  hand-rolled SVG charts. CI asserts `go.mod` stays empty. **No cgo, ever.**
- **Tier B — research harness and deploy.** Python notebooks, Playwright,
  deploy tooling. Lives in `lab/`, never ships, never needed to build or run
  Tier A.
- **Environments sit between**: they may vendor JS/wasm *locally* (never a CDN),
  but whatever ships must satisfy Tier A.

```
server/         Tier A Go (main package; module is at the repo ROOT because
                go:embed can't reach a parent dir — root embed.go embeds
                environments/)
environments/   one dir per game + common/ (shared results renderer, CSS)
lab/            Tier B: synthetic player, ship gate, voice level check
deploy/aws/     CloudFormation + deploy.sh for the public instance
README.md       the deliverable README: GitHub landing page AND /readme
run.sh          the only launcher (needs Go); requirement 5's artifact
dist/           build output (gitignored)
```

**Data model rules** (they exist so merge is a set-union, not entity resolution):

- `run.id` — random 128-bit hex, never autoincrement.
- **Variant identity = `config_hash`** — SHA-256 over canonical config JSON
  (sorted keys, no whitespace) + environment key. Content-addressed: every
  settings tweak mints or reuses a variant automatically, and any leaderboard
  row relaunches its exact config via `?cfg=<hash>`.
- Player identity = `device_id` in `localStorage`, shown as a pseudonym
  (`runner-3f2a`). **No accounts, no usernames, no PII.** IP is for rate
  limiting only and is never stored on a run.
- **The leaderboard is a query, not a table** — best bps per (device_id,
  variant) over scored, completed, human-verified runs. Never materialize it.
  Rows show which **round** a score came from (that player's nth run of the
  game), because a top score on someone's 3rd round and their 40th are different
  claims.
- **Storage is append-only JSONL**, no database: `variants/runs/results.jsonl`
  plus `data/keys/<run_id>.jsonl`. Backup is `cp -r data/`.
- `bitrate merge export.json` (a subcommand of the binary, `server/merge.go`) is
  idempotent set-union. **Recompute, don't trust** — where keystroke logs are
  present the importer recomputes score and bot flags.
- Lab builds default `-data` to `~/.bitrate/data` (absolute) so launching from a
  worktree doesn't fork the ledger; ship-tag builds keep relative `data/`.

**Static backup + DNS failover (2026-07-27, spec §8.1).** `bitrate.einkgen.link`
is a Route 53 **failover** pair: PRIMARY → the EIP (gated on the same health
check that drives the email alarms), SECONDARY → CloudFront over a private S3
bucket holding a front-end-only build. It works because **scoring was always
client-side** — the server's only unique contribution to *playing* is the target
sequence, so `BitrateOffline` (in `common/results.js`) draws it locally with
rejection sampling (never `x % m`, which biases low symbols). Offline runs set
`run.offline`, skip submit, and say "score computed on this device, not
recorded". The bundle is emitted by the binary (`-emit-static`) so it can't drift
from what the server serves. **Trap already hit:** S3 doesn't resolve directory
indexes, and "fixing" that with CloudFront 403/404→index.html made *every* path
return 200 with the wrong page — a CloudFront viewer-request rewrite is the real
fix. **Verify a static mirror on content, never status codes.**

**Packaging (revised 2026-07-26).** There is **no ZIP and no `ship/` directory** —
the submission is the deployed site plus the public repo (spec §8). `README.md` is
at the repo root (GitHub's landing page *and* the source for `/readme`), `run.sh`
at the root is the only launcher and doubles as requirement 5's artifact (it needs
Go — the honest cost of dropping prebuilt binaries), and `build.sh` just builds
binaries. The `-tags ship` profile (`server/profile_{lab,ship}.go`) still compiles
but has **no consumer**, since the deployed *lab* build is the deliverable; it is
kept, not deleted, and stays CI-gated. **The gallery, leaderboard,
telemetry, export/merge, and device identity never ship.**

**The ship gate can never break** — and on 2026-07-27 it had been broken for a
day, red on every branch *and* on main, because `gate.yml` and `ship_gate.py`
still built and unzipped a `dist/bitrate.zip` that `build.sh` had stopped
producing. It is **repointed** now (spec §8): it copies the working tree into a
fresh temp dir (minus `.git`, `data/`, `dist/`, `bin/`, venvs, caches), runs
`bash run.sh` with network blocked, drives a full scored run headlessly, and
asserts the results card, server/reference score agreement, and zero
non-localhost requests. Two `go run` traps it had to handle, both worth knowing:
a **cold compile** on a runner with no Go build cache needs a generous startup
deadline, and `go run` runs the compiled server as a **child**, so killing the
wrapper orphans the process holding the port — own the process group (same trap
as the `pkill` note in Ops gotchas). Wired as a required CI check plus a local
pre-push hook (`SKIP_GATE=1` to skip). The gate proves the mechanical path; the
manual Wi-Fi-off ritual on a clean Linux box before submitting proves the human
one.

**`lab/synthetic_player.py` plays `/env/stream-typing/`, not `/`** — `/`
redirects to the ship game (drum pad, touch), so a bare base URL waits forever
for a `#stream` that never renders. `stream_url()` resolves this; pass a full
environment URL to override. Also: `--duration` below 60 s does not work (the
scored run is always 60 s), so the results wait times out.

## Environments as they stand

Every environment must: consume the server's seeded i.i.d. sequence; emit a
selection log in the standard keystroke schema (recognizers reduce each attempt
to a discrete accept/reject with logged confidence); render the live bit-rate
HUD at ≥ 1 Hz; support familiarization *and* scored modes with an unmistakable
affordance for which is active.

Environments may violate §2/§7 defaults **on purpose** — a paced or pointer-driven
mode contradicts the baseline by design, and that contradiction *is* the
experiment. The rule-1/2/3/4 constraints bind everything without exception.

**Contenders** (gallery front page, and the only games the leaderboard ranks):
`drum-pad` (touch, finger cells — **the winner and what ships**, see spec §9
step 10), `pixel-lens` (mouse + fisheye loupe), `stream-typing` (the baseline),
`voice-babble` (hand-rolled DSP recognizer, per-player templates, solfège
default).

**drum-pad and pixel-lens are one implementation.** `drum-pad/index.html` loads
`pixel-lens/game.js` with `window.BITRATE_INPUT='touch'`; the input mode selects
the game. They were a single environment until 2026-07-25, so a `pixel-lens`
variant with `input:"touch"` **is** a drum-pad variant — 41 human results. The
board reclassifies them at query time via `effectiveEnv` (spec §4.4). **The
stored `environment` field is provenance, not truth**; every analysis path must
go through `effectiveEnv`.

**Graveyard** (built, played, beaten or ruled out — still reachable, still in
the history and progress strips, out of the leaderboard): `lane-tap`,
`twin-stick`, `parabola-fall`, `word-typing` (off-brief, quarantined).
`beat-hands` still works by URL but has no card anywhere. `speech-words` is
deleted.

Recurring lessons from building them:

- **Judge at the event, never "was it ever right in a window."** twin-stick's
  first judge latched a hit if the stick touched the target octant at any frame,
  which made sweeping in circles harvest every target with zero information.
  Read the state *at the beat*.
- **Every added channel must clear a reliability bar or it costs net bps** — a
  15%-error binary can subtract more than the bit it adds. Stage and measure.
- **Composable channels**: a channel = one recognizer emitting discrete symbols;
  simultaneous channels multiply alphabets, and per-channel partial credit keeps
  one blown channel from zeroing the event. But two thumbs to independent
  arbitrary targets is *not* parallel processing in practice (twin-stick's
  thesis largely failed on playtest).
- **Occlusion is real on direct touch** — the resting hand covers exactly where
  the next preview appears. Cues above, hand at the bottom.
- `getUserMedia` (camera **and** mic) needs a secure context, so webcam/voice
  modes don't work over plain-HTTP LAN on an iPad. Touch and the Gamepad API do.
- One shared in-flow `<header id="topbar">` in every environment; `--topbar-h`
  is published from a `ResizeObserver` and fields position at
  `top: var(--topbar-h)`. **The band must never change height mid-run.**
- **Phones need a soft-keyboard path for `stream-typing`** (2026-07-25): a
  transparent focusable input over the field, `input` events diffed against the
  last value as the selection path (soft `keydown` carries no usable `key`),
  filler characters so a backspace on an empty field still fires, caret pinned
  to the end, and the covered strip measured off `visualViewport` into
  `--kbd-inset`. Desktop keeps the untouched `keydown` path.

## Public deploy

Live at **https://bitrate.einkgen.link** — one t3.micro (AL2023) running the lab
binary under systemd behind Caddy for auto TLS, Elastic IP + Route 53, artifacts
through S3 + SSM (no SSH). IaC in `deploy/aws/`; redeploy with
`./deploy/aws/deploy.sh` (idempotent).

The ledger lives on a **dedicated retained EBS volume** at `/var/lib/bitrate`;
the unit has `RequiresMountsFor` so it refuses to start rather than silently
writing a fresh empty ledger, the AMI is pinned, and `deploy.sh` asserts the
mount every time. Hardening (armed by `BITRATE_PUBLIC=1`): per-IP rate limit
120/min on `/api/*`, 4 MiB body cap, `/api/export*` behind
`BITRATE_EXPORT_TOKEN`, consent banner on non-loopback hosts only.

Data movement and code deploys are **separate acts** — pulling the deployed
ledger down and merging never implies running `deploy.sh`.

## Working agreements

- **Spec-first.** Discussion → decision → write it into
  `bitrate-harness-spec.md` with rationale. Conversation-only knowledge is
  considered lost.
- **Don't start building until the owner says go.** Review and architecture
  turns are spec-editing turns.
- **Warn before deviating from the brief** (see above) — quote the PDF, get
  sign-off, record the reading.
- **Big scope choices belong to the owner.** Ask with explicit options when a
  decision changes project direction.
- **Commit only when asked** — the owner controls cadence.
- `/codex` gives an independent second opinion; findings get triaged
  accept/reject with reasons, never swallowed whole.

## Ops gotchas

- Kill a stale server with `lsof -ti :<port> -sTCP:LISTEN | xargs kill` —
  `pkill -f 'go run ./server'` kills the wrapper, not the compiled child holding
  the port. (Default `-addr` is `127.0.0.1:0`, an OS-assigned port; pass
  `-addr :4700` to bind wide for a phone or iPad on the LAN, and the server
  prints the reachable LAN URLs.)
- `run.sh` here is the **dev** launcher (`go run ./server -dev`); the grader's
  `run.sh` is generated into `dist/bitrate.zip` by `build.sh`.
- `BITRATE_NO_BROWSER=1` (or `-no-browser`) suppresses the courtesy browser open.
- Golden sequence vectors in `server/sequence_test.go` are **frozen** — never
  regenerate them to make a test pass; a mismatch means stored seeds no longer
  replay.
- Chart mark classes in `environments/common/results.css` are global on purpose;
  scoping them to `#res-charts` once broke the gallery sparklines.
- `[hidden]` needs `display: none !important` (ID display rules override the UA
  rule). No opacity/filter on `#stage`. Canvases need explicit `width`/`height`.
- Use `keydown` + `event.key` (not `event.code`); ignore `event.repeat`, bare
  modifiers, and IME composition; `performance.now()` never `Date.now()`; no
  network calls or `console.log` inside the keydown path.

## Where the build order stands (spec §9)

Done: server + storage + scoring (1), `stream-typing` (2), synthetic harness and
offline tests (3), cross-compiled ship build + gate in CI (4), settings sheet
with content-addressed variants (5), runs/leaderboard/gallery (6), public deploy
(8, partial), the merge CLI, and eight environments from the §5 backlog (9).

Step 10 is **partly done** (2026-07-26): `drum-pad` is frozen as the winner
(`shipGame` in `server/api.go`, one constant driving the `/` redirect in both
profiles); the README is written (**`README.md` at the repo root** — `ship/` was
deleted 2026-07-26, there is no ZIP and no packaging dir) and rendered at `/readme` by
both profiles from that one embedded source, linked from the results card and
printed by `run.sh`; tile-size recommendations are badged in the first-open
picker (`{phone: 12mm, tablet: 20mm}`, off the screen's short edge).

Two reversals worth knowing, both owner decisions on 2026-07-26 and both
recorded with rationale in the spec:

- **The settings gear ships, visible** (spec §8). Tile size *is* N, and the right
  N is a property of the player's hand and screen — shipping the gear with the
  defaults that won beats shipping one guess. Does not re-admit the leaderboard,
  gallery, telemetry, or device identity.
- **The submission is the deployed web app + a link to the public repo. We do
  NOT submit a ZIP** (spec §1 register item 7, §8). A ZIP cannot deliver a
  touchscreen, and unzip → start a server → find the LAN address → pair a tablet
  is more exotic setup than rule 5 allows. Rule 5 is satisfied *literally*
  instead: `run.sh` exists and is **included in the public repo**. **So `run.sh`
  and the `ship` profile must keep working and stay CI-gated even though nobody
  is asked to run them** — they are rule 5's artifact and the fallback if the
  site is down during grading. Accepted risk: site unreachable during grading =
  no score.
- **The gallery SHIPS, and that's a feature** (reversal of "none of them ship").
  The brief says "surprise us", and the eight environments plus a graveyard that
  says why each loser lost is the most interesting half of the submission.
  `word-typing` stays *visibly* quarantined — its gallery tile says "banned by
  the brief, so it never counted" and its page carries an off-brief banner;
  showing that is a stronger claim than hiding it. **What ships is the `lab`
  profile, deployed** — not a stripped build. §6 hardening still applies.
- **Routing settles discovery:** `/` → drum pad (land on the graded game, not a
  chooser); gallery at `/env/`, reachable from the game's "← gallery" link; the
  gallery footer links back to drum pad, `/readme`, and the source repo. No flag
  or special mode needed.

**Built 2026-07-26 — the arm affordance.** Practice is unlimited and its HUD
shows a trailing-60 s bps, so practice *looked like the game*; a grader could
burn their familiarization in it and never score. Now two **colour-only** tiers
(the header band must never change height mid-run — a reflow moves `#field`,
changing the grid, changing N): accent outline + slow pulse always, and after 60 s
of *accumulated practice* a one-shot card plus a filled button. The card's
backdrop is pointer-opaque immediately while its buttons enable after 400 ms, so
a finger already travelling toward a tile can neither dismiss it unseen nor fall
through to the grid. Honours `prefers-reduced-motion`. Drive it without waiting a
minute: `pixelDebug.showArmPrompt()`.

**Built 2026-07-26 — recommended settings, surfaced three ways.**
`RECOMMENDED_CELL` + `DEFAULT_PREVIEW` in `pixel-lens/game.js` are the single
source: badged in the first-open picker, dotted in the settings sheet (`.rec` — a
different mark from `.on`, because "what am I on" and "what should I be on" are
different questions), and restorable via "back to recommended". Values come from
the actual best scored runs, not taste.

**Built 2026-07-27 — the practice accuracy hint** (spec §9, after the arm
affordance). Drum pad only, `practice` only: when the trailing-60 s window holds
**≥30 selections at ≤85% accuracy**, one banner says so, names the next tile size
up, and prices the gap — *"at that same pace, 95% would be 12.4 bits/s and 100%
would be 13.8"*. The second sentence is the point: accuracy as a percentage is a
scolding, accuracy as bits left on the table is an argument, and `net = n(2a−1)`
is the double penalty made legible. Figures are a **static snapshot**, not a live
readout. Once per practice run; dismissed by settings, arming, a new bout, or
10 s. Fires on the existing 1 Hz tick, so nothing new runs in the tap path. It
sits over the top row of cells because it cannot push `#field` down without
moving N — same trade as `#device-warn`, minimised by being wide and shallow.
**CSS trap:** `position: fixed` + `left: 50%` shrink-to-fits to 50vw; centre with
`left/right: 0; margin-inline: auto; width: fit-content` (`#device-warn` still
has this bug). Hooks: `pixelDebug.accHintText/accHintSpent/tickAccuracyHint`.

**Voice babble's mic calibration is OFF** — `MIC_CALIBRATION = false` in
`voice-babble/game.js` (owner's call, 2026-07-27). One flag disables the level
check, the `auto` trigger mode, and the band-limited energy path; voice babble
behaves exactly as it did before that work (preset `high` 0.0012, unfiltered
analyser, `TEMPLATE_VERSION` 3 so existing templates still load), and the `auto`
button and re-check control are removed from the sheet. Kept, not deleted: the
diagnosis was right each time and the remedy never survived real hardware —
deaf on AirPods, then *8 of 5 words* on the built-in mic, ending at room −48 dB
/ voice −40 dB where no threshold can sit above the room's peaks and below the
voice. **A first-session grader must not be asked to tune a threshold before
they can play**, which is why even the manual slider didn't save it.
`lab/voice_level_check.py` asserts the reverted behaviour while the flag is off
and the full suite when it is on — flip it and both still pass. Template
calibration (saying each sound) is untouched and still required.

**Fixed 2026-07-27 — two bugs where the code contradicted its own on-screen
copy.** Both were invisible to every existing test because neither the rule nor
the prose was wrong on its own — only the two disagreed. **Where a rule is
stated to the player in prose, treat the prose as a testable assertion.**

- **drum pad with a mouse.** `#device-warn` promises "practise with the mouse if
  you like, but a scored run has to be tapped"; the pointerdown handler's
  non-touch branch `return`ed unconditionally, so practice clicks were warned
  about and *dropped* — and since `run.started`/`t0` are set above that branch,
  the first click started the practice clock and registered nothing. Practice
  now plays; scored runs still abort on a mouse, arming still needs a prior tap,
  the warning fires once per bout, and `run.flags.mouse_practice` marks the run.
  `lab/drum_pad_mouse_test.py`.
- **voice babble's mic trigger could sit ABOVE the player's voice.** At 5 dB of
  headroom the noisy fallback `ambient·2.5` is 1.4× the measured voice — nothing
  can ever register. Same fixed-multiple mistake in the reach test (`ambient·2`)
  and in the live `noiseFloor·1.8` term. **A threshold above a level the measured
  voice actually reached is not strict, it is deaf** — all three are now capped
  by `speech·0.55`.
- **...and the 5 dB reading itself: the VAD measured energy the recognizer never
  looks at.** Full-band time-domain RMS counted DC, sub-100 Hz rumble and hiss;
  the voice adds energy only in 100–4000 Hz; uncorrelated signals sum in
  quadrature, so a −34 dB rumble floor under a −30 dB voice reads as 5.1 dB of
  headroom **on any microphone in a silent room**. Now band-limited at the
  source: `src → highpass(100) ×2 → lowpass(6000) → analyser`. Forces one
  recalibration (`timing` 3→4, level `v` 1→2).
  **Method note worth more than the fix:** the first diagnosis was AGC on the
  Bluetooth chain, and it was wrong. What falsified it was the owner reporting
  the same 5 dB on the *built-in* mic. **When a symptom survives a change of
  device, the device is not the variable.** The AGC handling was kept — it is
  right about a different case — but it was not this bug.
- **...and then the player got the dial.** Band-limiting fixed the rumble but
  the owner's real room was still only 8 dB of headroom, and the check flipped
  from deaf to over-triggering ("heard 8 of 5 words"). A threshold must sit
  above the room's *peaks* and below the voice; peaks run 6–10 dB over the room
  median, so at 8 dB the target window is **zero dB wide** and no automatic
  placement is correct. The result panel now always offers a **manual trigger
  slider with a live count of what it fires on** — say five words, drag until it
  reads 5. **When a measurement must survive hardware you cannot enumerate, ship
  the measurement AND the override, not a cleverer estimator.** Three guesses at
  the estimator each failed on real hardware; the dial cannot.

**Built 2026-07-26 — liveness hardening** (spec §8, tests in
`server/liveness_test.go`). The site is now the deliverable, so a failed request
is fine and a dead process is not. Fixed one critical (unbounded pace-bin
allocation from client `duration_s`/`elapsed_ms` — a fatal OOM *throw*, which
`net/http`'s recover cannot catch, reachable in two unauthenticated requests and
live in the ship build) and three high (unevicted `pending` map; a corrupt ledger
line making startup permanently fatal into a 10 s restart loop; no HTTP
timeouts). Plus two correctness bugs: the persisted keystroke log was silently
corrupted on any run with a past-boundary tap (`keys[:0]` aliasing the slice that
gets written), and a failed submit destroyed its own retry. See the spec for what
was deliberately left unfixed and why.

**What is actually left before submitting** (2026-07-27): (a) the README's own
prose — it is at the repo root and the owner is writing it, plus the
development-trajectory section (spec §9 TODO); (b) **redeploy** — main runs ahead
of production, so the stream-typing keyboard map and the README move are not live;
(c) settle the final defaults (they *are* shipped and taken from the best runs,
but the evidence is n≈4 per cell). The repo is already public and the arm
affordance is built.

Not built: the analysis notebook (7) — **and it must use `effectiveEnv`**; the
§6.1 pilot machinery — invite tokens, `/join`, `/pilot` guided sessions,
`lab/pull.sh` (deliberately deferred in favour of the open sandbox; pulls are
currently a manual `curl` against token-gated `/api/export`); v2 per-player
calibration; the README's development-trajectory section (spec §9 step 10 TODO);
and the arm-affordance work above.

**No longer a TODO:** stripping the gallery and stripping `word-typing` from the
bundle. Both were priorities only while the deliverable was a stripped ZIP; with
the gallery shipping deliberately and word-typing labelled off-brief in two
places, they're resolved by the decision rather than by code. `.off-brief` in
`gallery.css` is now dead CSS (the real banner lives in
`word-typing/index.html`).
