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
lab/            Tier B: synthetic player, ship gate
deploy/aws/     CloudFormation + deploy.sh for the public instance
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
  worktree doesn't fork the ledger; ship/gate builds keep relative `data/`.

**Ship profile.** `lab` and `ship` are two build profiles from one tree; `-tags
ship` compiles the lab routes out (`server/profile_{lab,ship}.go`). Stripping
happens in the *build*, not behind runtime flags. **The gallery, leaderboard,
telemetry, export/merge, and device identity never ship.**

**The ship gate can never break.** `lab/ship_gate.py` unzips `dist/bitrate.zip`
into a fresh temp dir, runs `run.sh` with network blocked, drives a full scored
run headlessly, and asserts the results card, server/reference score agreement,
and zero non-localhost requests. Wired as a required CI check plus a local
pre-push hook (`SKIP_GATE=1` to skip). The gate proves the mechanical path; the
manual Wi-Fi-off ritual on a clean Linux box before submitting proves the human
one.

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
profiles); the README is written (`ship/README.md`) and rendered at `/readme` by
both profiles from that one embedded source, linked from the results card and
printed by `run.sh`; tile-size recommendations are badged in the first-open
picker (`{phone: 12mm, tablet: 20mm}`, off the screen's short edge).

Two reversals worth knowing, both owner decisions on 2026-07-26 and both
recorded with rationale in the spec:

- **The settings gear ships, visible** (spec §8). Tile size *is* N, and the right
  N is a property of the player's hand and screen — shipping the gear with the
  defaults that won beats shipping one guess. Does not re-admit the leaderboard,
  gallery, telemetry, or device identity.
- **The submission is a hosted URL *and* the offline ZIP** (spec §1 register
  item 7). Rule 5's "or equivalent" covers a URL, and the brief names web apps
  first; the site is the only way to hand a grader a touchscreen, and the ZIP is
  the fallback if EC2/DNS/TLS/their proxy fails during grading. No gating on the
  play path.

Not built: the analysis notebook (7) — **and it must use `effectiveEnv`**; the
§6.1 pilot machinery — invite tokens, `/join`, `/pilot` guided sessions,
`lab/pull.sh` (deliberately deferred in favour of the open sandbox; pulls are
currently a manual `curl` against token-gated `/api/export`); v2 per-player
calibration; and the rest of step 10 — **the ship ZIP still embeds all eleven
environments, including the rule-1-violating `word-typing`**, reachable at
`/env/word-typing/` in the bundle *and* on the public site. That is the
highest-priority remaining strip.
