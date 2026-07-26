'use strict';

/* parabola-fall environment (spec §5 backlog).
 *
 * A one-thumb touch rhythm game. A shallow "smile" (concave-up) arc sits at the
 * very bottom of the screen with Z lanes. Dots fall from the top, each down its
 * lane, and CROSS the arc at a fixed, configurable tempo. The thumb rides the
 * arc and must be in the crossing dot's lane at the moment it lands — you never
 * lift, you just slide. Dots come from ABOVE the arc, so the hand never blocks
 * the look-ahead.
 *
 * BOUNDED JUMPS (the tunable trade): the dots are a bounded random walk, not an
 * absolute i.i.d. sequence — consecutive dots are within `max_step` lanes, so a
 * small max_step keeps thumb travel tiny and lets you run a high tempo, at the
 * cost of fewer bits/step. The honest alphabet is the RELATIVE STEP, sampled
 * i.i.d. over a sliding window: N = 2*M+1 symbols (M = max_step) -> log2(2M)
 * bits/selection. Sampling an absolute lane i.i.d. instead would give
 * unbounded jumps (the whole point we're fixing); bounding an absolute sequence
 * would break rule-1 i.i.d. — so the step is what's sampled, and the absolute
 * dot lane is its running sum. Rides the numeric machinery with ZERO server
 * change: alphabet_size = N, sequence i.i.d. over 0..N-1, Replay compares each
 * logged step-symbol to the sequence; the geometry lives client-side.
 *
 * The sliding window (spec §7 honesty): step k offers the N lanes
 * [winLo, winLo+2M], winLo = clamp(prevLane - M, 0, Z-1-2M). Exactly N distinct
 * in-bounds lanes at every position (Z >= 2M+1 guaranteed by clamping M), so
 * the alphabet never collapses and jumps stay <= M in the interior (up to 2M
 * only right at an edge, where the window slides). The dot walk is a
 * deterministic function of the sequence (like stream-typing's fixed stream),
 * so the look-ahead is stable and server-reproducible.
 *
 * Judge, two modes:
 *   crossing (default) — the selection is the lane the thumb occupies AT the
 *     instant the dot crosses the arc (first frame >= the beat), decoded to a
 *     step-symbol against the ideal window. The twin-stick "AT the beat" rule: a
 *     swept thumb is at a random lane on the beat and never harvests, so under
 *     advance-always it nets Sc-Si <= 0 -> 0 bps.
 *   window — the MOST COMMON lane over [beat-WIN, beat+WIN]. Softer, but still
 *     unharvestable by sweeping.
 *
 * Paced (`pacing: fixed-tempo`) — the sanctioned §7 deviation (§5).
 */

// ---- config ----

const SETTINGS_KEY = 'bitrate_parabola_settings_v1';
const S = { lanes: 13, maxStep: 3, tempo: 120, look: 3, judge: 'crossing', window: 150 };

const LANE_OPTS = [7, 9, 13, 17, 21];
const MAXSTEP_OPTS = [1, 2, 3, 4, 6];
const TEMPO_OPTS = [90, 120, 150, 180, 240];
const LOOK_OPTS = [2, 3, 4];
const JUDGE_OPTS = ['crossing', 'window'];
const WINDOW_OPTS = [100, 150, 200];

const COUNTIN_MS = 1800; // scored pre-roll before the first dot falls

function loadSettings() {
  // Wide touchscreen (iPad-class): default to a wider arc so a bounded walk has
  // room to roam and lanes stay finger-sized. A saved setting still wins.
  if (Math.max(window.innerWidth, window.innerHeight) >= 1024) S.lanes = 21;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (LANE_OPTS.includes(s.lanes)) S.lanes = s.lanes;
    if (MAXSTEP_OPTS.includes(s.maxStep)) S.maxStep = s.maxStep;
    if (TEMPO_OPTS.includes(s.tempo)) S.tempo = s.tempo;
    if (LOOK_OPTS.includes(s.look)) S.look = s.look;
    if (JUDGE_OPTS.includes(s.judge)) S.judge = s.judge;
    if (WINDOW_OPTS.includes(s.window)) S.window = s.window;
  } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* fine */ }
}

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let BEAT_MS = 0, FALL_MS = 0, WIN_MS = 0;
let Z = 13, M = 3, CENTER = 6; // lanes, max_step (clamped so 2M+1<=Z), centre lane

function buildConfig() {
  Z = S.lanes;
  M = Math.min(S.maxStep, Math.floor((Z - 1) / 2)); // window must fit: Z >= 2M+1
  CENTER = Math.floor((Z - 1) / 2);
  N = 2 * M + 1;                    // honest alphabet = the bounded relative step
  BITS = Math.log2(N - 1);          // = log2(2M)
  BEAT_MS = 60000 / S.tempo;
  FALL_MS = S.look * BEAT_MS;                          // a dot is visible this long before it crosses
  WIN_MS = Math.min(S.window, Math.floor(BEAT_MS / 2) - 10); // window judge: never overlaps neighbours
  CONFIG = {
    environment: 'parabola-fall',
    alphabet_size: N,          // sequence is i.i.d. over 0..N-1 (the relative step)
    lanes: Z,
    max_step: M,
    tempo_npm: S.tempo,
    look_ahead: S.look,
    judge: S.judge,            // 'crossing' | 'window'
    window_ms: S.judge === 'window' ? WIN_MS : 0,
    input: 'touch',
    recognizer: S.judge === 'window' ? 'lane-mode-in-window' : 'lane-at-crossing',
    pacing: 'fixed-tempo',     // deliberate §7 deviation — the experiment (§5)
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
  renderCfg();
}

// ---- dom ----

const $ = (id) => document.getElementById(id);
const modeBanner = $('mode-banner');
const modeHelp = $('mode-help');
const overlay = $('overlay');
const card = $('card');
const resultsEl = $('results');
const fieldEl = $('field');
const ctx = fieldEl.getContext('2d');
const R = window.BitrateResults;

function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const DEVICE_ID = (() => {
  let id = localStorage.getItem('bitrate_device_id');
  if (!id) { id = randHex(16); localStorage.setItem('bitrate_device_id', id); }
  return id;
})();

// ---- state ----

// loading | practice | armed | scored | done | error
let state = 'loading';
let run = null;
let endTimer = null;
let escPendingTimer = null;
let noticeTimer = null;
let feedback = [];       // transient flashes {at, lane, kind}
// The thumb rides the arc: down flag + horizontal x (lane derived from x).
let thumb = { down: false, x: 0 };
// Per-tick judging capture (reset on finalize). tkAt = absolute lane at the
// crossing instant; tally = per-lane frame counts for the window judge.
let tkAt = -1, tkAtSet = false;
let tally = [];

// ---- run lifecycle ----

async function startRun(scored) {
  state = 'loading';
  const resp = await fetch('/api/run/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: DEVICE_ID,
      config: CONFIG,
      scored,
      client_meta: { ua: navigator.userAgent, screen_w: screen.width, screen_h: screen.height, dpr: devicePixelRatio, lang: navigator.language, touch_points: navigator.maxTouchPoints || 0, pointer_coarse: matchMedia('(pointer: coarse)').matches },
    }),
  });
  if (!resp.ok) throw new Error('run/start failed: ' + resp.status);
  const data = await resp.json();
  const seq = data.sequence_ints;
  // Ideal dot walk: each dot sits at winLo + step within the previous dot's
  // sliding window, so consecutive dots are <= M apart (interior). Deterministic
  // from the sequence -> stable look-ahead, server-reproducible.
  const lane = new Array(seq.length), winLo = new Array(seq.length);
  let prev = CENTER;
  for (let k = 0; k < seq.length; k++) {
    const lo = Math.max(0, Math.min(Z - 1 - 2 * M, prev - M));
    winLo[k] = lo;
    lane[k] = lo + seq[k];
    prev = lane[k];
  }
  const cap = Math.floor((DURATION_MS - 1) / BEAT_MS) + 1; // ticks whose beat < 60 s
  const lead = FALL_MS + (scored ? COUNTIN_MS : 0);        // dot 0 spawns FALL_MS before it crosses
  run = {
    id: data.run_id,
    seq, lane, winLo,
    scored,
    noteCount: scored ? Math.min(cap, seq.length) : seq.length,
    t0: performance.now() + lead,
    started: false,
    anyInput: false,
    reseeding: false,
    jt: 0,          // ticks finalized
    pos: 0,         // selections logged (= jt)
    sc: 0, si: 0,
    keylog: [],
    n: N, bits: BITS,
    flags: {},
    submitted: false,
  };
  feedback = [];
  tkAt = -1; tkAtSet = false; tally = [];
  thumb.down = false;
  setState(scored ? 'armed' : 'practice');
  renderHud();
}

// What the settings sheet is currently set to, short enough for the corner.
function configLabel() {
  return Z + ' lanes · ±' + M + ' · ' + S.tempo + '/min';
}

// The middle of the header: what this variant is set to, with the settings
// button under it — the label and the way to change it are one object. The
// N and bits/selection are the honest accounting (spec §7), always on screen.
function renderCfg() {
  $('res-info').innerHTML =
    configLabel() + ' · N <b>' + N + '</b> · <b>' + BITS.toFixed(2) + '</b> bits/step';
}

// The practice corner: the two run controls. What the game is set to, and
// the button that changes it, live in the header's middle zone.
function renderPracticeHelp() {
  modeHelp.innerHTML =
    '<button type="button" class="act click" data-act="arm"><kbd>Enter</kbd>arm scored run</button>' +
    '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>new practice seed</button>';
}

function setState(next) {
  state = next;
  document.body.classList.toggle('armed', next === 'armed');
  overlay.hidden = next !== 'error';
  resultsEl.hidden = next !== 'done';
  fieldEl.hidden = next === 'done';
  $('topbar').hidden = next === 'done';
  if (next !== 'practice') $('hud-spark').innerHTML = '';
  if (next !== 'practice' && sheetOpen) closeSheet();
  if (next === 'practice') {
    modeBanner.textContent = 'practice';
    modeBanner.className = 'mode-practice';
    renderPracticeHelp();
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    modeHelp.innerHTML =
      '<span class="act armed-note">dots incoming — the clock starts when they land</span>' +
      '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</button>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

function beginScored() {
  run.started = true;
  setState('scored');
  endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
}

// ---- arc geometry: a smile (concave-up) at the bottom ----

let W = 0, H = 0, DPR = 1;
let arc = { x0: 0, w: 0, cy: 0, amp: 0, fallH: 0 };

function layout() {
  DPR = devicePixelRatio || 1;
  W = fieldEl.clientWidth; H = fieldEl.clientHeight;
  if (fieldEl.width !== Math.round(W * DPR)) {
    fieldEl.width = Math.round(W * DPR);
    fieldEl.height = Math.round(H * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const marginX = Math.max(W * 0.07, 26);
  arc.x0 = marginX;
  arc.w = W - 2 * marginX;
  arc.cy = H * 0.86;                          // centre (lowest point) near the bottom
  arc.amp = Math.min(H * 0.12, arc.w * 0.10); // edges rise this much above centre
  arc.fallH = arc.cy - H * 0.10;              // dots fall from ~10% down to the arc
}

// Lane i tiles [i/Z, (i+1)/Z); its centre is at t=(i+0.5)/Z.
function laneT(i) { return (i + 0.5) / Z; }
function laneX(i) { return arc.x0 + laneT(i) * arc.w; }
function curveYAt(t) { const u = 2 * t - 1; return arc.cy - arc.amp * u * u; } // smile: low centre, high edges
function laneCurveY(i) { return curveYAt(laneT(i)); }
function laneAtX(px) {
  const t = arc.w > 0 ? (px - arc.x0) / arc.w : 0.5;
  return Math.max(0, Math.min(Z - 1, Math.floor(t * Z)));
}

// ---- what is riding the arc? ----
// The authority is pointerType on the event itself, not a device sniff: a
// touch laptop has a touchscreen and can still be played entirely with the
// trackpad. A pen counts as touch — a stylus rides the arc the same way.
//
// Unlike drum pad, a cursor here doesn't invalidate anything: parabola fall is
// a touch game by design, not by rule, and a mouse run is a real run of a
// different task (a cursor jumps; a thumb travels). So it says so once,
// records it on the run, and gets out of the way.
let cursorNoted = false;

function noteCursorInput(e) {
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
  if (run) run.mouseSeen = true;
  if (cursorNoted) return;
  cursorNoted = true;
  showNotice('parabola fall is built for a thumb riding the arc — a mouse plays, ' +
    'but the tempo assumes a thumb that never lifts, so these numbers aren\'t a phone\'s.', '', 7000);
}

// ---- input: the thumb rides the arc (never lifts) ----

fieldEl.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  if (sheetOpen) { closeSheet(); return; }
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  noteCursorInput(e);
  fieldEl.setPointerCapture(e.pointerId);
  const r = fieldEl.getBoundingClientRect();
  thumb.down = true;
  thumb.x = e.clientX - r.left;
});
fieldEl.addEventListener('pointermove', (e) => {
  if (!thumb.down || !e.isPrimary) return;
  const r = fieldEl.getBoundingClientRect();
  thumb.x = e.clientX - r.left;
});
function releaseThumb() { thumb.down = false; }
fieldEl.addEventListener('pointerup', releaseThumb);
fieldEl.addEventListener('pointercancel', releaseThumb);

// ---- judging: lane AT the crossing (or mode over a window), decoded to a step ----

function noteT(k) { return k * BEAT_MS; }           // crossing time, ms relative to t0
function thumbLane() { return thumb.down ? laneAtX(thumb.x) : -1; }
// Decode an absolute thumb lane to the step-symbol for tick k (or -1 if the
// thumb is outside the tick's window). committed === seq[k] iff the thumb is
// exactly in the dot's lane, so the server (comparing symbols) agrees.
function laneToSym(absLane, lo) {
  if (absLane < 0) return -1;
  const o = absLane - lo;
  return (o >= 0 && o <= 2 * M) ? o : -1;
}

function finalizeTick(k) {
  const expected = run.seq[k];
  const lo = run.winLo[k];
  let sym;
  if (S.judge === 'window') {
    let bestLane = -1, best = 0;
    for (let i = 0; i < tally.length; i++) if ((tally[i] || 0) > best) { best = tally[i]; bestLane = i; }
    sym = laneToSym(bestLane, lo);
  } else {
    sym = laneToSym(tkAt, lo); // crossing: lane at the instant the dot crossed
  }
  const verdict = sym >= 0 && sym === expected;
  if (verdict) run.sc++; else run.si++;
  feedback.push({ at: performance.now(), lane: run.lane[k], kind: verdict ? 'hit' : (sym < 0 ? 'miss' : 'wrong') });
  run.keylog.push({
    i: run.keylog.length,
    key: sym < 0 ? 'miss' : String(sym),
    expected: String(expected),
    verdict,
    t_shown_ms: Math.max(0, Math.floor(noteT(k) - FALL_MS)),
    t_pressed_ms: Math.floor(noteT(k)), // floored — never rounds up across 60 s
    t_keyup_ms: null,
    x: thumb.down ? thumb.x : null,
  });
  run.jt++;
  run.pos++;
  tkAt = -1; tkAtSet = false; tally = [];
}

// Read the thumb AT the beat (and, for the window judge, tally a band around
// it), then finalize once the judge's read is complete. Only positions at/near
// the beat are read — never set-membership over the whole fall.
function sweepTicks(now) {
  if (!run || (state !== 'practice' && state !== 'scored')) return;
  const rel = now - run.t0;
  const lane = thumbLane();
  if (thumb.down && !run.anyInput) { run.anyInput = true; if (!run.scored) modeBanner.className = 'mode-practice-live'; }
  while (run.jt < run.noteCount) {
    const tk = noteT(run.jt);
    if (S.judge === 'window' && lane >= 0 && rel >= tk - WIN_MS && rel <= tk + WIN_MS) {
      tally[lane] = (tally[lane] || 0) + 1;
    }
    if (rel < tk) break;                 // beat not here yet
    if (!tkAtSet) { tkAt = lane; tkAtSet = true; } // crossing sample, taken once
    const doneAt = S.judge === 'window' ? tk + WIN_MS : tk;
    if (rel >= doneAt) finalizeTick(run.jt); else break;
  }
  if (!run.scored && run.jt >= run.noteCount && !run.reseeding) {
    run.reseeding = true;
    toPractice();
  }
}

// ---- render ----

function drawArc() {
  // the smile curve = the crossing line
  ctx.strokeStyle = '#3a4150';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let s = 0; s <= 1.0001; s += 1 / 96) {
    const x = arc.x0 + s * arc.w, y = curveYAt(s);
    if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // lane markers on the curve
  for (let i = 0; i < Z; i++) {
    ctx.fillStyle = '#2a2e36';
    ctx.beginPath(); ctx.arc(laneX(i), laneCurveY(i), 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function drawDots(now) {
  if (!run) return;
  const rel = now - run.t0;
  // visible: dots whose crossing is within the fall window ahead (and just past)
  for (let k = run.jt; k < run.noteCount; k++) {
    const tk = noteT(k);
    const dt = tk - rel;
    if (dt > FALL_MS) break;         // not spawned yet
    if (dt < -60) continue;          // already crossed
    const laneIdx = run.lane[k];
    const p = Math.max(0, Math.min(1, dt / FALL_MS)); // 1 = top, 0 = crossing
    const x = laneX(laneIdx);
    const y = laneCurveY(laneIdx) - p * arc.fallH;
    const near = k === run.jt;
    // trailing guide line down the lane to the crossing point (faint), for the next dot
    if (near) {
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#7aa2f7'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, laneCurveY(laneIdx)); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = Math.max(0.35, 1 - p * 0.6);
    ctx.fillStyle = near ? '#e0b452' : '#58b368';
    ctx.beginPath(); ctx.arc(x, y, near ? 11 : 8, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawThumb() {
  if (!thumb.down) return;
  const lane = laneAtX(thumb.x);
  const x = laneX(lane), y = laneCurveY(lane);
  // highlight the current lane cell on the arc
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#7aa2f7'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#7aa2f7';
  ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
}

function drawFeedback(now) {
  for (const f of feedback) {
    const age = now - f.at;
    if (age > 300) continue;
    const a = 1 - age / 300;
    const x = laneX(f.lane), y = laneCurveY(f.lane);
    ctx.globalAlpha = a;
    ctx.strokeStyle = f.kind === 'hit' ? '#58b368' : '#e05252';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, 12 + (1 - a) * 20, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  feedback = feedback.filter((f) => now - f.at <= 300);
}

function drawCountIn(now) {
  if (!run || state !== 'armed') return;
  const rel = now - run.t0;
  if (rel > -FALL_MS) return; // dots are already falling
  const n = Math.ceil((-rel - FALL_MS) / BEAT_MS);
  if (n <= 0) return;
  ctx.fillStyle = '#e0b452';
  ctx.font = '64px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), W / 2, H * 0.4);
}

function drawPrompt() {
  if (run && run.anyInput) return;
  ctx.fillStyle = '#565c66';
  ctx.font = '15px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center';
  ctx.fillText('touch the arc and slide — catch each dot in its lane as it lands', W / 2, H * 0.12);
}

function frame() {
  requestAnimationFrame(frame);
  if (state === 'done' || state === 'error' || state === 'loading') return;
  layout();
  const now = performance.now();
  if (run && state === 'armed' && now >= run.t0 - FALL_MS) beginScored();
  sweepTicks(now);
  if (!run) return; // toPractice may be mid-flight (async reseed)
  ctx.clearRect(0, 0, W, H);
  drawArc();
  drawDots(now);
  drawFeedback(now);
  drawThumb();
  drawCountIn(now);
  drawPrompt();
}

// ---- mode transitions ----

async function armScoredRun() { await finishBout(); try { await startRun(true); } catch (err) { showError(err); } }
async function toPractice() { await finishBout(); try { await startRun(false); } catch (err) { showError(err); } }

async function finishBout() {
  if (run && run.anyInput && !run.submitted && !run.scored) submitRun(false).catch(() => {});
  run = null;
}

function endScoredRun() {
  endTimer = null;
  clearEscPending();
  sweepTicks(run.t0 + DURATION_MS + 1); // finalize every beat inside 60 s
  setState('done');
  renderResults({ waiting: true });
  submitRun(false)
    .then((res) => renderResults({ server: res }))
    .catch(() => renderResults({ clientOnly: true }));
}

function abortScoredRun(reason) {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  clearEscPending();
  run.flags[reason === 'aborted' ? 'aborted' : reason] = true;
  run.submitted = run.submitted || !run.started;
  if (!run.submitted) submitRun(true).catch(() => {});
  run = null;
  toPractice();
  if (reason !== 'aborted') showNotice('scored run invalidated — window lost focus · <b>Enter</b> re-arms', 'warn', 6000);
}

// ---- scoring (client mirror; server authoritative) ----

function scoreWith(r, tSec) {
  const net = Math.max(r.sc - r.si, 0);
  const rn = r.n ?? N, rbits = r.bits ?? BITS;
  return { n: rn, sc: r.sc, si: r.si, bps: tSec > 0 ? (rbits * net) / tSec : 0 };
}
function elapsedMsOf(r) { return r && r.started ? performance.now() - r.t0 : 0; }
function lastKeyT(r) { return r.keylog.length ? r.keylog[r.keylog.length - 1].t_pressed_ms : 0; }

// ---- submit with retry queue (house pattern) ----

async function submitRun(invalidated) {
  const r = run;
  if (!r || r.submitted) return null;
  r.submitted = true;
  const elapsed = r.scored ? DURATION_MS : Math.max(elapsedMsOf(r), 0);
  const tSec = r.scored ? CONFIG.duration_s : Math.max(elapsed, lastKeyT(r)) / 1000;
  const cs = scoreWith(r, tSec);
  // A cursor run still counts — it just isn't the thumb this game is scored
  // for, so the ledger says which hand made it (see noteCursorInput).
  if (r.mouseSeen) r.flags.mouse_input = true;
  const payload = {
    run_id: r.id, device_id: DEVICE_ID, invalidated, flags: r.flags,
    elapsed_ms: elapsed, client_result: invalidated ? null : cs, keystrokes: r.keylog,
  };
  try { return await postSubmit(payload); }
  catch (err) { enqueue(payload); throw err; }
}

async function postSubmit(payload) {
  const resp = await fetch('/api/run/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error('submit failed: ' + resp.status);
  return resp.json();
}

const QUEUE_KEY = 'bitrate_submit_queue_v1';
function enqueue(payload) {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    q.push(payload); localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); scheduleFlush(2000);
  } catch { /* storage full: telemetry lost, game unaffected */ }
}
let flushTimer = null;
function scheduleFlush(delay) {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    let q; try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return; }
    if (!q.length) return;
    try {
      await postSubmit(q[0]); q.shift(); localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      if (q.length) scheduleFlush(500);
    } catch { scheduleFlush(Math.min(delay * 2, 60000)); }
  }, delay);
}

// ---- HUD (shared trailing-60s + sparkline) ----

function hudCounts() { $('hud-counts').textContent = 'N ' + (run.n || N) + ' · Sc ' + run.sc + ' · Si ' + run.si; }

function renderHud() {
  if (state === 'done') return;
  if (!run || (!run.started && !run.anyInput && state !== 'scored')) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? 'starts in ' + Math.max(1, Math.ceil((run ? run.t0 - performance.now() : 0) / 1000)) + 's' : '';
    $('hud-counts').textContent = 'N ' + N + ' · Sc 0 · Si 0';
    window.BitrateResults.renderSpark('hud-spark', null, BITS, 0);
    if (run && !run.scored && run.pos > 0) hudCounts();
    return;
  }
  const elapsed = Math.max(elapsedMsOf(run), 0);
  if (run.scored) {
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    hudCounts();
    window.BitrateResults.renderSpark('hud-spark', run, BITS, elapsed);
    return;
  }
  const tr = R.trailingBps(run.keylog, run.bits, elapsed);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(elapsed / 1000) + 's practice';
  $('hud-counts').textContent = 'N ' + (run.n || N) + ' · Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  window.BitrateResults.renderSpark('hud-spark', run, BITS, elapsed);
}
setInterval(renderHud, 1000);

// ---- results (shared renderer) ----

function renderResults(opts) {
  if (state !== 'done') return;
  const cs = scoreWith(run, CONFIG.duration_s);
  const bps = opts.server ? opts.server.bps : cs.bps;
  const sc = opts.server ? opts.server.sc : cs.sc;
  const si = opts.server ? opts.server.si : cs.si;
  const n = opts.server ? opts.server.n : cs.n;
  let note = '';
  if (opts.waiting) note = '<div class="res-note">verifying with server…</div>';
  else if (opts.clientOnly) note = '<div class="res-note warn">server unreachable — client score shown; result queued</div>';
  else if (opts.server && opts.server.anomaly) note = '<div class="res-note warn">client/server scoring disagreement logged</div>';

  $('res-hero').innerHTML =
    '<div class="res-title">parabola-fall (' + Z + ' lanes · ±' + M + ' · ' + S.tempo + '/min · ' + S.judge + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> (' + BITS.toFixed(2) + ' bits/step)' +
    ' · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
    ' · accuracy <b>' + (sc + si > 0 ? ((100 * sc) / (sc + si)).toFixed(1) : '—') + '%</b></div>' + note;

  const m = opts.server && opts.server.metrics;
  $('res-tiles').innerHTML = m ? R.tilesHTML(m, { corrections: false }) : '';
  $('chart-pace').innerHTML = m && m.selections > 1 ? R.paceChartSVG(m, run.bits ?? BITS) : '';
  $('chart-iki').innerHTML = m && m.selections > 1 ? R.ikiChartSVG(m) : '';
}

function showError(err) {
  state = 'error';
  overlay.hidden = false;
  card.innerHTML =
    '<div class="title">server error</div>' +
    '<div class="row">' + String(err).replace(/[<>&]/g, '') + '</div>' +
    '<div class="note">is the server still running? press <b>Enter</b> to retry</div>';
}

// ---- notices ----

function showNotice(html, cls, ms) {
  const n = $('notice');
  n.innerHTML = html; n.className = cls || ''; n.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, ms || 4000);
}
function hideNotice() { if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; } $('notice').hidden = true; }
function armEscPending() { showNotice('press <b>Esc</b> again to end the scored run', '', 2500); escPendingTimer = setTimeout(clearEscPending, 2500); }
function clearEscPending() { if (!escPendingTimer) return; clearTimeout(escPendingTimer); escPendingTimer = null; hideNotice(); }

// ---- keyboard: arm / abort / restart ----

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state === 'done' || state === 'error') {
    if (e.key === 'Enter') { e.preventDefault(); armScoredRun(); }
    else if (e.key === 'Escape') { e.preventDefault(); toPractice(); }
    return;
  }
  if (state === 'loading') return;
  if (e.key === 'Enter') {
    if (sheetOpen) { e.preventDefault(); closeSheet(); return; }
    if (state === 'practice') { e.preventDefault(); armScoredRun(); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sheetOpen) { closeSheet(); return; }
    if (state === 'practice' || state === 'armed') toPractice();
    else if (state === 'scored') { if (escPendingTimer) abortScoredRun('aborted'); else armEscPending(); }
  }
});

// Corner strip in play + the score screen's footer: same buttons, one binder
// (shared with every other environment — see common/results.js).
BitrateResults.wireActs({ arm: armScoredRun, seed: toPractice, settings: toggleSheet });

window.addEventListener('blur', () => { if (state === 'scored' && run && run.started) abortScoredRun('focus_lost'); });

// ---- settings sheet ----

const sheetEl = $('sheet');
let sheetOpen = false;
// One entry point for the sheet — the header's settings button and the score
// screen's both land here. From the score screen it drops back to
// practice first: settings are a practice-mode thing (a config change mints a
// new variant, so it can't happen mid-run).
async function toggleSheet() {
  if (state !== 'practice') { await toPractice(); openSheet(); return; }
  sheetOpen ? closeSheet() : openSheet();
}

function openSheet() { if (state !== 'practice') return; sheetOpen = true; syncSheet(); sheetEl.classList.add('open'); }
function closeSheet() { sheetOpen = false; sheetEl.classList.remove('open'); if (document.activeElement && sheetEl.contains(document.activeElement)) document.activeElement.blur(); }

function renderMaxStepSeg() {
  const maxM = Math.floor((S.lanes - 1) / 2);
  $('seg-maxstep').innerHTML = MAXSTEP_OPTS
    .map((m) => '<button data-v="' + m + '"' + (m > maxM ? ' disabled' : '') + '>±' + m + '</button>')
    .join('');
}

function syncSheet() {
  const seg = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v)); };
  seg('seg-lanes', S.lanes); seg('seg-maxstep', M); seg('seg-tempo', S.tempo); seg('seg-look', S.look); seg('seg-judge', S.judge); seg('seg-window', S.window);
  $('row-window').hidden = S.judge !== 'window';
  $('sheet-info').textContent =
    Z + ' lanes · max jump ±' + M + ' → N=' + N + ' (' + BITS.toFixed(2) + ' bits/step) · ' +
    S.tempo + '/min (' + (S.tempo / 60).toFixed(1) + '/s) · ' +
    (S.judge === 'window' ? '±' + WIN_MS + ' ms window' : 'read at crossing') + ' · changes restart the bout';
  renderCfg();
}

function applySetting(mut) { mut(); saveSettings(); renderMaxStepSeg(); buildConfig(); syncSheet(); toPractice(); }
function bindSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return; b.blur();
    applySetting(() => fn(b.dataset.v));
  });
}
bindSeg('seg-lanes', (v) => { S.lanes = Number(v); });
bindSeg('seg-maxstep', (v) => { S.maxStep = Number(v); });
bindSeg('seg-tempo', (v) => { S.tempo = Number(v); });
bindSeg('seg-look', (v) => { S.look = Number(v); });
bindSeg('seg-judge', (v) => { S.judge = v; });
bindSeg('seg-window', (v) => { S.window = Number(v); });


// ---- headless test hook (a real thumb + real-time pacing can't be automated) ----

window.parabolaDebug = {
  state: () => state,
  config: () => CONFIG,
  counts: () => (run ? { sc: run.sc, si: run.si, pos: run.pos, jt: run.jt } : null),
  // absolute dot lane for the current step, and the upcoming walk (to check the
  // jump bound and injectivity from a test)
  targetLane: () => (run && run.jt < run.noteCount ? run.lane[run.jt] : null),
  laneWalk: (n) => (run ? run.lane.slice(run.jt, run.jt + (n || 12)) : null),
  maxJumpSeen: () => {
    if (!run) return null;
    let mx = 0;
    for (let k = 1; k < run.lane.length; k++) mx = Math.max(mx, Math.abs(run.lane[k] - run.lane[k - 1]));
    return mx;
  },
  laneAtX: (px) => laneAtX(px),
  setThumbLane: (lane) => { thumb.down = true; thumb.x = laneX(Math.max(0, Math.min(Z - 1, lane | 0))); },
  liftThumb: () => { thumb.down = false; },
  // Finalize the current tick with the thumb read as absolute `lane` (-1 = miss),
  // bypassing real-time pacing — drives the exact same judge a crossing would.
  forceTick: (lane) => {
    if (!run || run.jt >= run.noteCount) return null;
    if (!run.started) run.started = true;
    tkAt = (lane === undefined ? thumbLane() : lane);
    if (S.judge === 'window') { tally = []; if (tkAt >= 0) tally[tkAt] = 1; }
    finalizeTick(run.jt);
    return run ? { sc: run.sc, si: run.si, jt: run.jt } : null;
  },
};

// ---- boot ----

async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== 'parabola-fall') return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if (LANE_OPTS.includes(c.lanes)) S.lanes = c.lanes;
    if (MAXSTEP_OPTS.includes(c.max_step)) S.maxStep = c.max_step;
    if (TEMPO_OPTS.includes(c.tempo_npm)) S.tempo = c.tempo_npm;
    if (LOOK_OPTS.includes(c.look_ahead)) S.look = c.look_ahead;
    if (JUDGE_OPTS.includes(c.judge)) S.judge = c.judge;
    if (WINDOW_OPTS.includes(c.window_ms)) S.window = c.window_ms;
    buildConfig();
  } catch { /* ship build or unknown hash: defaults */ }
}

// The header is an in-flow band whose height moves with content and
// viewport; publish it so the play area always starts below it.
window.BitrateResults.trackHeaderHeight();
loadSettings();
buildConfig();
renderMaxStepSeg();
scheduleFlush(1500);
applyCfgParam().then(() => startRun(false)).catch(showError);
requestAnimationFrame(frame);
