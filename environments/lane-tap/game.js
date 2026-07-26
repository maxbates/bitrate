'use strict';

/* lane-tap environment (spec §5).
 *
 * Self-paced bottom-strip tapping. An action strip of Z finger-sized lanes
 * runs along the bottom edge; the current target is a lit lane cell, and the
 * upcoming targets stack vertically above it at their lane x-positions
 * (nearest at the bottom), stepping down one row on every tap. Taps are
 * ballistic jumps judged by x alone — the alphabet is 1D, so y carries no
 * information and gets a full strip-height of grace.
 *
 * Why this shape (owner findings, 2026-07-24): two-hand play on a flat iPad
 * died on occlusion — the resting hand covered exactly where the next
 * pixel-lens previews appeared. Here every cue lives above the action strip
 * and the hands approach from below the screen edge, so lookahead depth is
 * occlusion-free and its ORDER is self-evident (vertical stacking), the two
 * things the 2D preview dots couldn't give. Absolute lanes are sampled i.i.d.
 * over 0..Z-1 (alphabet_size = Z, full log2(Z-1) bits/tap — no bounded-walk
 * discount, unlike parabola-fall) and the game is self-paced, so none of the
 * §7 pacing deviations apply. Rides the numeric machinery with zero server
 * change.
 *
 * Multi-touch: every pointerdown is a selection (no isPrimary filter), so
 * two-finger alternation — one finger flying while the other commits — is
 * the intended expert technique and needs no config axis; it's visible in
 * the IKI histogram instead.
 */

// ---- config ----

const SETTINGS_KEY = 'bitrate_lanetap_settings_v1';
const S = { lanes: 13, look: 5 };

const LANE_OPTS = [9, 13, 17, 21, 26];
const LOOK_OPTS = [3, 5, 8];

const PX_PER_MM = 96 / 25.4; // CSS reference pixel

function loadSettings() {
  // Wide touchscreen (iPad-class): default to more lanes so cells stay
  // finger-sized without wasting width. A saved setting still wins.
  if (Math.max(window.innerWidth, window.innerHeight) >= 1024) S.lanes = 21;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (LANE_OPTS.includes(s.lanes)) S.lanes = s.lanes;
    if (LOOK_OPTS.includes(s.look)) S.look = s.look;
  } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* fine */ }
}

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let Z = 13;

function buildConfig() {
  Z = S.lanes;
  N = Z;                       // no correction key; log2(N-1) prices the reserved slot
  BITS = Math.log2(N - 1);
  CONFIG = {
    environment: 'lane-tap',
    alphabet_size: Z,          // sequence is i.i.d. over 0..Z-1 (absolute lanes)
    lanes: Z,
    look_ahead: S.look,
    input: 'touch',
    recognizer: 'lane-tap-v1',
    pacing: 'self-paced',
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
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
let feedback = [];        // transient flashes {at, kind:'hit'|'wrong', x, y} | {at, kind:'expected', lane}
let lastAdvance = 0;      // stack step-down animation anchor

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
      client_meta: {
        ua: navigator.userAgent,
        screen_w: screen.width,
        screen_h: screen.height,
        dpr: devicePixelRatio,
        lang: navigator.language,
        // iPadOS Safari masquerades as desktop macOS; touch capability is the
        // reliable device-class signal (spec §4.3).
        touch_points: navigator.maxTouchPoints || 0,
        pointer_coarse: matchMedia('(pointer: coarse)').matches,
      },
    }),
  });
  if (!resp.ok) throw new Error('run/start failed: ' + resp.status);
  const data = await resp.json();
  run = {
    id: data.run_id,
    seq: data.sequence_ints,
    scored,
    started: false,
    anyInput: false,
    t0: 0,
    pos: 0,
    sc: 0, si: 0,
    keylog: [],
    shownAt: [0],
    n: N, bits: BITS,
    flags: {},
    submitted: false,
  };
  feedback = [];
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
      '<span class="act">tap the lit lane in the strip · the stack above shows what’s next</span>' +
      '<span class="act click" data-act="arm"><kbd>Enter</kbd>arm scored run</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>new practice seed</span>';
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    modeHelp.innerHTML =
      '<span class="act armed-note">first tap starts the 60 s clock</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</span>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

// ---- layout: action strip at the bottom, cue stack above ----

let W = 0, H = 0, DPR = 1;
// strip: x0/w/top/cellW/cellH; zoneTop = top of the tap zone (a full extra
// strip-height of grace above the drawn cells — the alphabet is 1D, so y is
// tolerance, not information); stackBottom/rowGap place the cue stack.
const strip = { x0: 0, w: 0, top: 0, cellW: 0, cellH: 0, zoneTop: 0, stackBottom: 0, rowGap: 0 };

function layout() {
  DPR = devicePixelRatio || 1;
  W = fieldEl.clientWidth; H = fieldEl.clientHeight;
  if (fieldEl.width !== Math.round(W * DPR)) {
    fieldEl.width = Math.round(W * DPR);
    fieldEl.height = Math.round(H * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const marginX = Math.max(W * 0.03, 10);
  strip.x0 = marginX;
  strip.w = W - 2 * marginX;
  strip.cellW = strip.w / Z;
  strip.cellH = Math.max(44, Math.min(76, strip.cellW));
  // Clear of the iOS home-indicator bar and the gear button: at least 64px
  // off the bottom edge, more when the safe-area inset says so.
  const sab = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
  strip.top = H - strip.cellH - Math.max(64, sab + 32);
  strip.zoneTop = strip.top - strip.cellH;
  strip.stackBottom = strip.zoneTop - 16;
  const topPad = 92; // clear of the corner cluster / HUD
  strip.rowGap = Math.min(110, Math.max(34, (strip.stackBottom - topPad) / Math.max(1, S.look - 0.5)));
}

function laneX(i) { return strip.x0 + (i + 0.5) * strip.cellW; }
function laneAtX(px) {
  const t = strip.w > 0 ? (px - strip.x0) / strip.w : 0.5;
  return Math.max(0, Math.min(Z - 1, Math.floor(t * Z)));
}

// ---- selection: pointerdown is the earliest event; every finger counts ----

fieldEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
  if (sheetOpen) { closeSheet(); return; }
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  const r = fieldEl.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  if (y < strip.zoneTop) return; // cue/display area — not a selection (like a bare modifier key)
  if (run.scored && run.started && e.timeStamp - run.t0 >= DURATION_MS) return;

  clearEscPending();
  if (!run.started) {
    // Timer starts on the first selection, not page load (spec §2.5).
    run.started = true;
    run.t0 = e.timeStamp;
    run.anyInput = true;
    if (!run.scored) {
      modeBanner.className = 'mode-practice-live';
    } else {
      setState('scored');
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }
  const t = e.timeStamp - run.t0;
  const lane = laneAtX(x);
  const expected = run.seq[run.pos];
  const verdict = lane === expected;

  if (verdict) run.sc++;
  else { run.si++; feedback.push({ at: performance.now(), kind: 'expected', lane: expected }); }
  feedback.push({ at: performance.now(), kind: verdict ? 'hit' : 'wrong', x, y });

  run.keylog.push({
    i: run.keylog.length,
    key: String(lane),
    expected: String(expected),
    verdict,
    t_shown_ms: run.shownAt[run.pos] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
    x, y,
  });
  run.pos++;
  run.shownAt[run.pos] = t;
  lastAdvance = performance.now();
  // Practice bouts reseed before the visible stack would run off the sequence.
  if (!run.scored && run.pos >= run.seq.length - S.look) toPractice();
});

// ---- render ----

function drawStrip() {
  const y = strip.top, h = strip.cellH;
  ctx.strokeStyle = '#2a2e36';
  ctx.lineWidth = 1;
  for (let i = 0; i < Z; i++) {
    const x = strip.x0 + i * strip.cellW;
    ctx.strokeRect(x + 1, y, strip.cellW - 2, h);
  }
  // lit current lane
  if (run && run.pos < run.seq.length && state !== 'done') {
    const cur = run.seq[run.pos];
    const x = strip.x0 + cur * strip.cellW;
    ctx.fillStyle = '#e0b452';
    ctx.fillRect(x + 1, y, strip.cellW - 2, h);
  }
}

function drawStack(now) {
  if (!run || run.pos >= run.seq.length) return;
  // Step-down ease after each tap: markers start one row high and settle.
  const p = Math.min(1, (now - lastAdvance) / 90);
  const rise = strip.rowGap * (1 - p);
  const pts = [];
  for (let k = 0; k < S.look; k++) {
    const seqIdx = run.pos + k;
    if (seqIdx >= run.seq.length) break;
    pts.push({ x: laneX(run.seq[seqIdx]), y: strip.stackBottom - k * strip.rowGap - rise, k });
  }
  if (!pts.length) return;
  // path: faint segments joining the upcoming targets, plus a drop line from
  // the nearest marker onto its strip cell — plan the whole chain at a glance
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#7aa2f7';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, strip.top + strip.cellH * 0.5);
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (let i = pts.length - 1; i >= 0; i--) {
    const m = pts[i];
    const near = m.k === 0;
    ctx.globalAlpha = near ? 1 : Math.max(0.3, 0.85 - m.k * 0.14);
    ctx.fillStyle = near ? '#e0b452' : '#58b368';
    ctx.beginPath(); ctx.arc(m.x, m.y, near ? 12 : 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawFeedback(now) {
  for (const f of feedback) {
    const age = now - f.at;
    if (age > 300) continue;
    const a = 1 - age / 300;
    ctx.globalAlpha = a;
    if (f.kind === 'expected') {
      // flash the lane that should have been tapped
      ctx.strokeStyle = '#e05252';
      ctx.lineWidth = 2;
      ctx.strokeRect(strip.x0 + f.lane * strip.cellW + 1, strip.top, strip.cellW - 2, strip.cellH);
    } else {
      ctx.strokeStyle = f.kind === 'hit' ? '#58b368' : '#e05252';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(f.x, f.y, 12 + (1 - a) * 22, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  feedback = feedback.filter((f) => now - f.at <= 300);
}

function drawPrompt() {
  if (run && run.anyInput) return;
  ctx.fillStyle = '#565c66';
  ctx.font = '15px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center';
  ctx.fillText('tap the lit lane — the stack above shows what’s coming', W / 2, H * 0.12);
}

function frame() {
  requestAnimationFrame(frame);
  if (state === 'done' || state === 'error' || state === 'loading') return;
  layout();
  if (!run) return; // toPractice may be mid-flight (async reseed)
  const now = performance.now();
  ctx.clearRect(0, 0, W, H);
  drawStrip();
  drawStack(now);
  drawFeedback(now);
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
  if (!run || !run.started) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? 'first tap starts' : '';
    $('hud-counts').textContent = '';
    $('hud-spark').innerHTML = '';
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

  $('res-hero').innerHTML =
    '<div class="res-title">lane-tap (' + Z + ' lanes · look ' + S.look + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> (' + BITS.toFixed(2) + ' bits/tap)' +
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

modeHelp.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'arm') armScoredRun();
  else if (act.dataset.act === 'seed') toPractice();
});

// Results screen has no keyboard on a tablet: tapping the footer re-arms.
$('res-footer').addEventListener('click', armScoredRun);

window.addEventListener('blur', () => { if (state === 'scored' && run && run.started) abortScoredRun('focus_lost'); });

// ---- settings sheet ----

const sheetEl = $('sheet');
let sheetOpen = false;
function openSheet() { if (state !== 'practice') return; sheetOpen = true; syncSheet(); sheetEl.classList.add('open'); }
function closeSheet() { sheetOpen = false; sheetEl.classList.remove('open'); if (document.activeElement && sheetEl.contains(document.activeElement)) document.activeElement.blur(); }

function syncSheet() {
  const seg = (id, v) => { for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v)); };
  seg('seg-lanes', S.lanes); seg('seg-look', S.look);
  layout();
  $('sheet-info').textContent =
    Z + ' lanes → N=' + N + ' (' + BITS.toFixed(2) + ' bits/tap) · cells ~' +
    (strip.cellW / PX_PER_MM).toFixed(0) + ' mm · look-ahead ' + S.look + ' · changes restart the bout';
}

function applySetting(mut) { mut(); saveSettings(); buildConfig(); syncSheet(); toPractice(); }
function bindSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return; b.blur();
    applySetting(() => fn(b.dataset.v));
  });
}
bindSeg('seg-lanes', (v) => { S.lanes = Number(v); });
bindSeg('seg-look', (v) => { S.look = Number(v); });

$('gear').addEventListener('click', (e) => { e.currentTarget.blur(); sheetOpen ? closeSheet() : openSheet(); });

// ---- headless test hook (dispatches real pointer events) ----

window.laneDebug = {
  state: () => state,
  config: () => CONFIG,
  counts: () => (run ? { sc: run.sc, si: run.si, pos: run.pos } : null),
  targetLane: () => (run && run.pos < run.seq.length ? run.seq[run.pos] : null),
  upcoming: (n) => (run ? run.seq.slice(run.pos, run.pos + (n || S.look)) : null),
  // Tap a lane's strip-cell center through the real pointerdown path.
  tapLane: (lane) => {
    layout();
    const r = fieldEl.getBoundingClientRect();
    fieldEl.dispatchEvent(new PointerEvent('pointerdown', {
      pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true,
      clientX: r.left + laneX(Math.max(0, Math.min(Z - 1, lane | 0))),
      clientY: r.top + strip.top + strip.cellH / 2,
    }));
    return run ? { sc: run.sc, si: run.si, pos: run.pos } : null;
  },
};

// ---- boot ----

async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== 'lane-tap') return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if (LANE_OPTS.includes(c.lanes)) S.lanes = c.lanes;
    if (LOOK_OPTS.includes(c.look_ahead)) S.look = c.look_ahead;
    buildConfig();
  } catch { /* ship build or unknown hash: defaults */ }
}

loadSettings();
buildConfig();
scheduleFlush(1500);
applyCfgParam().then(() => startRun(false)).catch(showError);
requestAnimationFrame(frame);
