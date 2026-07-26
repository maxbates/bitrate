'use strict';

/* twin-stick environment (spec §5).
 *
 * A dual-analog controller game: two circles (one per thumb), a scrolling
 * ribbon of 8-way waypoints joined by segments coming at you, and at each
 * tick each stick should be at the shown octant. Two genuinely-parallel
 * channels (left stick, right stick) — each tick logs TWO independent
 * selections over 8 octants (N=8, log2 7 each), scored with partial credit.
 *
 * Server needs no change: one interleaved sequence over 0..7 (alphabet_size
 * = 8); tick k reads seq[2k] (left) and seq[2k+1] (right); the client logs
 * L then R so Replay matches each against its own sequence position.
 *
 * Input is the Gamepad API — plain HTTP, no secure context (runs on the iPad
 * with a paired controller). Judge = octant-at-tick over a hit window, so
 * flick-and-return and steer-the-path both score the same.
 */

// ---- config ----

const SETTINGS_KEY = 'bitrate_twinstick_settings_v1';
const S = { tempo: 90, dirs: 8, window: 300, look: 3, tick: 'on' };

const DEADZONE = 0.4;          // stick magnitude below this = no octant
const TRAVEL_MS = 2400;        // a waypoint is visible this long before its tick
const COUNTIN_MS = 2400;       // lead-in before tick 0 on a scored run

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([60, 90, 120, 150, 180].includes(s.tempo)) S.tempo = s.tempo;
    if (s.dirs === 4 || s.dirs === 8) S.dirs = s.dirs;
    if ([200, 300, 400].includes(s.window)) S.window = s.window;
    if ([2, 3, 4].includes(s.look)) S.look = s.look;
    if (s.tick === 'on' || s.tick === 'off') S.tick = s.tick;
  } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* fine */ }
}

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let BEAT_MS = 0, WIN_MS = 0, GRACE_MS = 0;

function buildConfig() {
  N = S.dirs; // per-channel alphabet; two selections per tick
  BITS = Math.log2(N - 1);
  BEAT_MS = 60000 / S.tempo;
  // WIN_MS is a visual "near the beat" band (marker pulse); GRACE_MS is the
  // honest late-arrival tolerance the judge allows a stick to settle onto its
  // target AFTER the beat. Both kept under a beat so ticks never overlap.
  WIN_MS = Math.min(S.window, Math.floor(BEAT_MS / 2) - 10);
  GRACE_MS = Math.min(S.window, Math.max(0, Math.floor(BEAT_MS) - 30));
  CONFIG = {
    environment: 'twin-stick',
    alphabet_size: N,          // per selection; each tick = 2 selections
    channels: 2,
    directions: S.dirs,
    tempo_npm: S.tempo,
    hit_window_ms: S.window,   // late-arrival grace: settle onto target ≤ this after the beat
    look_ahead: S.look,
    travel_ms: TRAVEL_MS,
    input: 'gamepad',
    recognizer: 'stick-octant-at-beat',
    deadzone: DEADZONE,
    pacing: 'fixed-tempo',     // deliberate §7 deviation — the experiment (§5)
    scoring: 'per-channel',    // partial credit, not a 64-way product
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
}

// Octants clockwise from up: 4 → ↑→↓← · 8 → ↑↗→↘↓↙←↖
const DIR4 = ['↑', '→', '↓', '←'];
const DIR8 = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function dirName(o) { return (S.dirs === 4 ? DIR4 : DIR8)[o]; }

// Unit vector for an octant in screen coords (x right, y down; up = -y).
function octVec(o) {
  const a = o * (2 * Math.PI / S.dirs);
  return { x: Math.sin(a), y: -Math.cos(a) };
}

// Quantize raw stick axes (y down) to an octant, or -1 in the deadzone.
function octantOf(x, y) {
  if (Math.hypot(x, y) < DEADZONE) return -1;
  const ang = Math.atan2(-y, x) * 180 / Math.PI; // 0 = right, 90 = up
  const step = 360 / S.dirs;
  const raw = (90 - ang) / step; // 0 = up, clockwise
  return ((Math.round(raw) % S.dirs) + S.dirs) % S.dirs;
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
let feedback = [];       // transient circle flashes {at, side, kind}
// Per-tick judging capture (reset each finalize). The selection is the octant a
// stick points at ON the beat — not any octant it swept through — so a full
// circular sweep can't harvest every target. `tkAt` = octant sampled at the
// beat (per stick); `tkAfter` = first octant it settles into within the late
// grace, used only when the stick hadn't arrived yet (deadzone) at the beat.
let tkAt = [-1, -1];
let tkAtSet = [false, false];
let tkAfter = [-1, -1];

// ---- gamepad ----

let forceAxes = null; // headless-test override: [lx, ly, rx, ry]
let padSeen = false;

function firstPad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

function readSticks() {
  let a = forceAxes;
  if (!a) {
    const gp = firstPad();
    if (gp) { a = [gp.axes[0] || 0, gp.axes[1] || 0, gp.axes[2] || 0, gp.axes[3] || 0]; padSeen = true; }
  }
  if (!a) return { l: -1, r: -1, lx: 0, ly: 0, rx: 0, ry: 0, pad: false };
  return { l: octantOf(a[0], a[1]), r: octantOf(a[2], a[3]), lx: a[0], ly: a[1], rx: a[2], ry: a[3], pad: true };
}

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
  // Each tick consumes two sequence positions; only dispatch ticks whose
  // window closes strictly inside 60 s (server boundary is t < duration).
  const maxTicks = Math.floor(seq.length / 2);
  // Only dispatch beats whose time floors strictly inside 60 s (server boundary
  // is t < duration); the grace-finalize can trail past 60 s in wall-clock but
  // t_pressed is the beat time, which stays < 60 s.
  const cap = Math.floor((DURATION_MS - 1) / BEAT_MS) + 1;
  run = {
    id: data.run_id,
    seq,
    scored,
    noteCount: scored ? Math.min(cap, maxTicks) : maxTicks,
    t0: performance.now() + (scored ? COUNTIN_MS : TRAVEL_MS),
    started: false,
    anyInput: false,
    jt: 0,          // ticks finalized
    pos: 0,         // selections logged (= 2 * jt)
    sc: 0, si: 0,
    keylog: [],
    n: N, bits: BITS,
    flags: {},
    submitted: false,
    lastBeat: -99,
    reseeding: false,
  };
  feedback = [];
  tkAt = [-1, -1]; tkAtSet = [false, false]; tkAfter = [-1, -1];
  setState(scored ? 'armed' : 'practice');
  renderHud();
}

function setState(next) {
  state = next;
  document.body.classList.toggle('armed', next === 'armed');
  overlay.hidden = next !== 'error';
  resultsEl.hidden = next !== 'done';
  fieldEl.hidden = next === 'done';
  $('hud').hidden = next === 'done';
  $('corner').hidden = next === 'done';
  $('gear').hidden = next !== 'practice';
  if (next !== 'practice') $('hud-spark').innerHTML = '';
  if (next !== 'practice' && sheetOpen) closeSheet();
  if (next === 'practice') {
    modeBanner.textContent = 'practice';
    modeBanner.className = 'mode-practice';
    modeHelp.innerHTML =
      '<span class="act click" data-act="arm"><kbd>Enter</kbd>arm scored run</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>new practice seed</span>';
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    modeHelp.innerHTML =
      '<span class="act armed-note">ribbon incoming — the clock starts when it arrives</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</span>';
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

async function armScoredRun() {
  await finishBout();
  try { await startRun(true); } catch (err) { showError(err); }
}

async function toPractice() {
  await finishBout();
  try { await startRun(false); } catch (err) { showError(err); }
}

async function finishBout() {
  if (run && run.anyInput && !run.submitted && !run.scored) submitRun(false).catch(() => {});
  run = null;
}

function endScoredRun() {
  endTimer = null;
  clearEscPending();
  sweepTicks(run.t0 + DURATION_MS + GRACE_MS + 1); // finalize every beat inside 60 s
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

// ---- judging: octant AT the beat, two channels per tick ----
// The selection for a tick is where each stick points on the beat (a late
// grace lets a stick that hadn't arrived yet settle onto the target just after
// the beat — taking the FIRST octant it lands on, never any octant swept
// through). This defeats the "sweep the stick in circles" reward hack: a sweep
// is at a random octant on the beat (~1/8) and never settles from centre onto a
// single target, so it nets ~0 bps; only genuinely aiming the stick scores.

function noteT(k) { return k * BEAT_MS; } // beat arrival, ms relative to t0
function targetOct(side, k) { return run.seq[2 * k + side]; }

function finalizeTick(k) {
  for (let side = 0; side < 2; side++) {
    const expected = targetOct(side, k);
    // octant on the beat, else the octant it first settled onto within the grace
    const sym = tkAt[side] >= 0 ? tkAt[side] : (tkAfter[side] >= 0 ? tkAfter[side] : null);
    const verdict = sym !== null && sym === expected;
    if (verdict) run.sc++; else run.si++;
    run.keylog.push({
      i: run.keylog.length,
      key: sym === null ? 'miss' : String(sym),
      expected: String(expected),
      verdict,
      t_shown_ms: Math.max(0, Math.floor(noteT(k) - TRAVEL_MS)),
      t_pressed_ms: Math.floor(noteT(k)), // floored — never rounds up across 60 s
      t_keyup_ms: null,
    });
    feedback.push({ at: performance.now(), side, kind: verdict ? 'hit' : (sym === null ? 'miss' : 'wrong') });
  }
  run.jt++;
  run.pos += 2;
  tkAt = [-1, -1];
  tkAtSet = [false, false];
  tkAfter = [-1, -1];
}

// For the tick being judged: capture each stick's octant AT the beat, then the
// first octant it settles into during the grace, and finalize once the grace
// has elapsed. Runs each frame (and once at run end). Only the beat/first-settle
// positions are read — never set-membership over an interval.
function sweepTicks(now) {
  if (!run || (state !== 'practice' && state !== 'scored')) return;
  const rel = now - run.t0;
  const s = readSticks();
  if (s.pad && !run.anyInput) { run.anyInput = true; if (!run.scored) modeBanner.className = 'mode-practice-live'; }
  while (run.jt < run.noteCount) {
    const tk = noteT(run.jt);
    if (rel < tk) break; // beat not here yet
    // sample the octant AT the beat (first frame at/after it)
    if (!tkAtSet[0]) { tkAt[0] = s.pad ? s.l : -1; tkAtSet[0] = true; }
    if (!tkAtSet[1]) { tkAt[1] = s.pad ? s.r : -1; tkAtSet[1] = true; }
    // after the beat, record the first non-deadzone octant each stick settles on
    if (rel > tk && s.pad) {
      if (tkAfter[0] < 0 && s.l >= 0) tkAfter[0] = s.l;
      if (tkAfter[1] < 0 && s.r >= 0) tkAfter[1] = s.r;
    }
    if (rel >= tk + GRACE_MS) finalizeTick(run.jt);
    else break; // still inside the grace for this tick
  }
  if (!run.scored && run.jt >= run.noteCount && !run.reseeding) {
    run.reseeding = true;
    toPractice();
  }
}

// ---- audio: metronome tick ----

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { audioCtx = null; } }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function tick(down) {
  if (S.tick !== 'on' || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
  osc.frequency.value = down ? 880 : 440;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  osc.connect(g); g.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.06);
}

// ---- render loop: the canvas owns the frame clock ----

let W = 0, H = 0, DPR = 1;
function layout() {
  DPR = devicePixelRatio || 1;
  W = fieldEl.clientWidth; H = fieldEl.clientHeight;
  if (fieldEl.width !== Math.round(W * DPR)) {
    fieldEl.width = Math.round(W * DPR);
    fieldEl.height = Math.round(H * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

const SIDE_COLOR = ['#7aa2f7', '#58b368']; // left blue, right green (match diagnostic)
function circleGeom(side) {
  const cx = side === 0 ? W * 0.28 : W * 0.72;
  const cy = H * 0.68;
  const rad = Math.min(W * 0.16, 150);
  return { cx, cy, rad };
}

function drawBigCircle(side, now) {
  const { cx, cy, rad } = circleGeom(side);
  const col = SIDE_COLOR[side];
  // feedback flash ring
  let flash = null;
  for (const f of feedback) if (f.side === side && now - f.at < 220) flash = f;
  ctx.lineWidth = 2;
  ctx.strokeStyle = flash ? (flash.kind === 'hit' ? '#58b368' : '#e05252') : '#2a2e36';
  ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  // octant ticks + labels
  ctx.font = '15px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const target = (run && run.jt < run.noteCount && (state === 'scored' || state === 'practice')) ? targetOct(side, run.jt) : -1;
  const inWindow = run && Math.abs((now - run.t0) - noteT(run.jt)) <= WIN_MS;
  for (let o = 0; o < S.dirs; o++) {
    const v = octVec(o);
    const px = cx + v.x * (rad + 18), py = cy + v.y * (rad + 18);
    ctx.fillStyle = (o === target) ? col : '#565c66';
    ctx.fillText(dirName(o), px, py);
    // target octant marker on the rim
    if (o === target) {
      ctx.fillStyle = col;
      ctx.globalAlpha = inWindow ? 1 : 0.5;
      ctx.beginPath(); ctx.arc(cx + v.x * rad, cy + v.y * rad, inWindow ? 9 : 6, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // live stick dot (analog position, eyes-free)
  const s = readSticks();
  const ax = side === 0 ? s.lx : s.rx, ay = side === 0 ? s.ly : s.ry;
  ctx.strokeStyle = '#20242c';
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + ax * rad, cy + ay * rad); ctx.stroke();
  ctx.fillStyle = s.pad ? col : '#565c66';
  ctx.beginPath(); ctx.arc(cx + ax * rad, cy + ay * rad, 8, 0, Math.PI * 2); ctx.fill();
}

// Ribbon of upcoming octant waypoints rushing OUT from the circle's centre —
// the vanishing point of a tunnel — toward the rim along each one's octant ray.
// Perspective: a waypoint is small and near the centre when it's far in the
// future, then rushes outward (1/z foreshortening) and reaches the rim exactly
// at its tick. Because it rides its octant ray the whole way in, where it will
// land is legible from the moment it appears — unlike a top-down fall, where the
// direction only resolves at the last instant.
const FOCAL = 0.9, DEPTH_MAX = 9; // tunnel constants: screenFrac = FOCAL/(FOCAL+depth*DEPTH_MAX)
function drawRibbon(side, now) {
  if (!run) return;
  const { cx, cy, rad } = circleGeom(side);
  const col = SIDE_COLOR[side];
  const rel = now - run.t0;
  const pt = (k) => {
    const dt = noteT(k) - rel;
    const depth = Math.max(0, Math.min(1, dt / TRAVEL_MS)); // 0 = at rim (tick), 1 = spawned
    const persp = FOCAL / (FOCAL + depth * DEPTH_MAX);       // 1 near → ~0.09 far
    const rr = rad * persp;
    const v = octVec(targetOct(side, k));
    return { x: cx + v.x * rr, y: cy + v.y * rr, rr, persp };
  };
  const last = Math.min(run.jt + S.look, run.noteCount);
  const visible = (k) => { const dt = noteT(k) - rel; return dt <= TRAVEL_MS * 1.1 && dt >= -WIN_MS; };
  // connecting segments (under the dots) — the joined ribbon between waypoints
  ctx.lineWidth = 2;
  for (let k = run.jt; k + 1 < last; k++) {
    if (!visible(k) || !visible(k + 1)) continue;
    const a = pt(k), b = pt(k + 1);
    ctx.globalAlpha = Math.max(0.1, 0.7 * Math.min(a.persp, b.persp));
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // waypoint dots + faint depth ring, near (bright/big) painted over far (dim/small)
  for (let k = last - 1; k >= run.jt; k--) {
    if (!visible(k)) continue;
    const p = pt(k);
    const near = k === run.jt;
    // faint concentric depth ring at this waypoint's radius — reads as tunnel depth
    ctx.globalAlpha = 0.16 * p.persp;
    ctx.strokeStyle = '#2a2e36'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, p.rr, 0, Math.PI * 2); ctx.stroke();
    // the octant dot, sized by perspective so nearer reads closer
    ctx.globalAlpha = Math.max(0.28, p.persp);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2.5, (near ? 9 : 7) * p.persp), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCountIn(now) {
  if (!run) return;
  const rel = now - run.t0;
  if (rel > -WIN_MS) return;
  const n = Math.ceil(-rel / BEAT_MS);
  ctx.fillStyle = '#e0b452';
  ctx.font = '64px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), W / 2, H * 0.42);
}

function drawPadPrompt() {
  ctx.fillStyle = '#565c66';
  ctx.font = '15px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center';
  ctx.fillText('connect a controller & press any button — both thumbs read as 8-way', W / 2, H * 0.14);
}

function frame() {
  requestAnimationFrame(frame);
  if (state === 'done' || state === 'error' || state === 'loading') return;
  layout();
  const now = performance.now();

  if (run && state === 'armed' && now >= run.t0 - WIN_MS) beginScored();
  sweepTicks(now);
  if (!run) return; // toPractice may be mid-flight (async reseed)

  // metronome from 4 beats before the downbeat
  const beatIdx = Math.floor((now - run.t0) / BEAT_MS);
  if (beatIdx !== run.lastBeat && beatIdx >= -4) { run.lastBeat = beatIdx; tick(beatIdx === 0); }

  ctx.clearRect(0, 0, W, H);
  if (!readSticks().pad && forceAxes === null) drawPadPrompt();
  for (let side = 0; side < 2; side++) { drawRibbon(side, now); drawBigCircle(side, now); }
  if (state === 'armed') drawCountIn(now);
}

// ---- scoring (client mirror; server authoritative) ----

function scoreWith(r, tSec) {
  const net = Math.max(r.sc - r.si, 0);
  const rn = r.n ?? N, rbits = r.bits ?? BITS;
  return { n: rn, sc: r.sc, si: r.si, bps: tSec > 0 ? (rbits * net) / tSec : 0 };
}
function elapsedMsOf(r) { return r && r.started ? performance.now() - r.t0 : (r ? Math.max(0, performance.now() - r.t0) : 0); }
function lastKeyT(r) { return r.keylog.length ? r.keylog[r.keylog.length - 1].t_pressed_ms : 0; }

// ---- submit with retry queue (house pattern) ----

async function submitRun(invalidated) {
  const r = run;
  if (!r || r.submitted) return null;
  r.submitted = true;
  const elapsed = r.scored ? DURATION_MS : Math.max(elapsedMsOf(r), 0);
  const tSec = r.scored ? CONFIG.duration_s : Math.max(elapsed, lastKeyT(r)) / 1000;
  const cs = scoreWith(r, tSec);
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

function hudCounts() { $('hud-counts').textContent = 'Sc ' + run.sc + ' · Si ' + run.si; }

function renderHud() {
  if (state === 'done') return;
  if (!run || (!run.started && !run.anyInput && state !== 'scored')) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? 'starts in ' + Math.max(1, Math.ceil((run ? run.t0 - performance.now() : 0) / 1000)) + 's' : '';
    $('hud-counts').textContent = '';
    $('hud-spark').innerHTML = '';
    if (run && !run.scored && run.pos > 0) hudCounts();
    return;
  }
  const elapsed = Math.max(elapsedMsOf(run), 0);
  if (run.scored) {
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    hudCounts();
    $('hud-spark').innerHTML = '';
    return;
  }
  const tr = R.trailingBps(run.keylog, run.bits, elapsed);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(elapsed / 1000) + 's practice';
  $('hud-counts').textContent = 'Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  $('hud-spark').innerHTML = R.sparkHTML(run.keylog, run.bits, elapsed);
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

  const ticks = Math.round((sc + si) / 2);
  $('res-hero').innerHTML =
    '<div class="res-title">twin stick (2×' + S.dirs + ' · ' + S.tempo + '/min) · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b>/stick · ' + ticks + ' ticks · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
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
  ensureAudio();
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

modeHelp.addEventListener('click', (e) => {
  ensureAudio();
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'arm') armScoredRun();
  else if (act.dataset.act === 'seed') toPractice();
});

window.addEventListener('gamepadconnected', ensureAudio);
window.addEventListener('blur', () => { if (state === 'scored' && run && run.started) abortScoredRun('focus_lost'); });

// ---- settings sheet ----

const sheetEl = $('sheet');
let sheetOpen = false;
function openSheet() { if (state !== 'practice') return; sheetOpen = true; syncSheet(); sheetEl.classList.add('open'); }
function closeSheet() { sheetOpen = false; sheetEl.classList.remove('open'); if (document.activeElement && sheetEl.contains(document.activeElement)) document.activeElement.blur(); }

function syncSheet() {
  const seg = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v)); };
  seg('seg-tempo', S.tempo); seg('seg-dirs', S.dirs); seg('seg-window', S.window); seg('seg-look', S.look); seg('seg-tick', S.tick);
  $('sheet-info').textContent =
    'N=' + N + '/stick · ' + (2 * BITS).toFixed(2) + ' bits/tick · judged on the beat, +' + GRACE_MS + ' ms grace · changes restart the bout';
}

function applySetting(mut) { mut(); saveSettings(); buildConfig(); syncSheet(); toPractice(); }
function bindSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; b.blur();
    applySetting(() => fn(b.dataset.v));
  });
}
bindSeg('seg-tempo', (v) => { S.tempo = Number(v); });
bindSeg('seg-dirs', (v) => { S.dirs = Number(v); });
bindSeg('seg-window', (v) => { S.window = Number(v); });
bindSeg('seg-look', (v) => { S.look = Number(v); });
bindSeg('seg-tick', (v) => { S.tick = v; });

$('gear').addEventListener('click', (e) => { e.currentTarget.blur(); ensureAudio(); sheetOpen ? closeSheet() : openSheet(); });
document.addEventListener('pointerdown', ensureAudio, { once: true });

// ---- headless test hook (a real pad can't be automated) ----

window.stickDebug = {
  state: () => state,
  config: () => CONFIG,
  counts: () => (run ? { sc: run.sc, si: run.si, jt: run.jt, pos: run.pos } : null),
  noteAt: (k) => (run ? [targetOct(0, k), targetOct(1, k)] : null),
  tick: () => (run ? run.jt : -1),
  // set both sticks to octants (or -1 for centered); drives the axes readSticks sees
  setSticks: (lOct, rOct) => {
    const v = (o) => (o < 0 ? [0, 0] : [octVec(o).x, octVec(o).y]);
    const L = v(lOct), Rr = v(rOct);
    forceAxes = [L[0], L[1], Rr[0], Rr[1]];
    padSeen = true;
  },
  clearSticks: () => { forceAxes = null; },
};

// ---- boot ----

async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== 'twin-stick') return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if ([60, 90, 120, 150, 180].includes(c.tempo_npm)) S.tempo = c.tempo_npm;
    if (c.directions === 4 || c.directions === 8) S.dirs = c.directions;
    if ([200, 300, 400].includes(c.hit_window_ms)) S.window = c.hit_window_ms;
    buildConfig();
  } catch { /* ship build or unknown hash: defaults */ }
}

loadSettings();
buildConfig();
scheduleFlush(1500);
applyCfgParam().then(() => startRun(false)).catch(showError);
requestAnimationFrame(frame);
