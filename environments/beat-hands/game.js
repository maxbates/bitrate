'use strict';

/* beat-hands environment (spec §5).
 *
 * Beat Saber, honestly scored: i.i.d. notes stream down a pseudo-3D
 * highway at a fixed tempo; each note wants one hand (left/right) and one
 * swipe direction. Pacing deliberately violates §7's self-paced rule —
 * that contradiction is the experiment: can deep-lookahead paced
 * execution beat reactive self-pacing?
 *
 * Swipes are read from the webcam with frame differencing — no ML, no
 * landmarks, frames never leave the machine (spec §6):
 *
 *   frames: mirrored 96x54 grayscale; per-half motion energy = fraction
 *   of pixels whose |diff| clears a threshold (hand identity = frame half)
 *   segmentation: energy onset opens a stroke, quiet closes it — the
 *   voice-babble VAD pattern with pixels instead of spectral bands
 *   classify: motion-centroid displacement onset->peak, quantized to
 *   direction sectors; confidence = angular margin
 *
 * Every note reduces to one discrete logged accept/reject event (rule 2):
 * the first in-window stroke judges it (advance-always — wrong hand or
 * direction consumes it), or its window closing unswung logs a miss.
 * Windows never overlap: effective half-window = min(setting, beat/2-10).
 *
 * `input: keys` (WASD + arrows) isolates the pacing question from
 * recognizer noise; camera and keys mint distinct variants.
 */

// ---- tunables / settings ----

const SETTINGS_KEY = 'bitrate_beat_settings_v1';
const TRAVEL_MS = 2400;   // spawn -> hit line; lookahead depth = TRAVEL/beat notes
const COUNTIN_MS = 2400;  // armed lead-in before note 0 arrives
const SENS = { high: 0.015, med: 0.03, low: 0.06 }; // motion-energy onset (fraction of half-frame pixels)

const S = { input: 'camera', dirs: 4, tempo: 90, window: 300, tick: 'on', sens: 'med', rec: 'overlay' };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.input === 'keys' || s.input === 'camera') S.input = s.input;
    if (s.dirs === 4 || s.dirs === 8) S.dirs = s.dirs;
    if ([60, 90, 120, 150, 180].includes(s.tempo)) S.tempo = s.tempo;
    if ([200, 300, 400].includes(s.window)) S.window = s.window;
    if (s.tick === 'on' || s.tick === 'off') S.tick = s.tick;
    if (SENS[s.sens]) S.sens = s.sens;
    if (['overlay', 'camera', 'off'].includes(s.rec)) S.rec = s.rec;
    else if (s.rec === 'on') S.rec = 'overlay'; // pre-toggle settings
  } catch { /* fine */ }
  if (S.input === 'keys') S.dirs = 4; // keys mode has no diagonal keys
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch { /* fine */ }
}

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let BEAT_MS = 0, WIN_MS = 0;

function buildConfig() {
  if (S.input === 'keys') S.dirs = 4;
  N = 2 * S.dirs; // no correction symbol; log2(N-1) prices the reserved slot regardless
  BITS = Math.log2(N - 1);
  BEAT_MS = 60000 / S.tempo;
  // Non-overlapping windows keep ground truth per-note unambiguous (rule 2).
  WIN_MS = Math.min(S.window, Math.floor(BEAT_MS / 2) - 10);
  CONFIG = {
    environment: 'beat-hands',
    alphabet_size: N,
    hands: 2,
    directions: S.dirs,
    tempo_npm: S.tempo,
    hit_window_ms: S.window,
    travel_ms: TRAVEL_MS,
    input: S.input,
    recognizer: S.input === 'camera' ? 'motion-diff-v1' : 'keys',
    motion_sensitivity: S.input === 'camera' ? S.sens : null,
    pacing: 'fixed-tempo', // deliberate §7 deviation — the experiment (spec §5)
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
}

// Symbol = hand * dirs + direction. Directions clockwise from up:
// 4: up right down left · 8: up upright right downright down downleft left upleft
const DIR_NAMES4 = ['↑', '→', '↓', '←'];
const DIR_NAMES8 = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
function dirName(d) { return (S.dirs === 4 ? DIR_NAMES4 : DIR_NAMES8)[d]; }
function symName(s) { return (Math.floor(s / S.dirs) ? 'R' : 'L') + dirName(s % S.dirs); }

// ---- dom ----

const $ = (id) => document.getElementById(id);
const modeBanner = $('mode-banner');
const modeHelp = $('mode-help');
const overlay = $('overlay');
const card = $('card');
const resultsEl = $('results');
const fieldEl = $('field');
const ctx = fieldEl.getContext('2d');

function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const DEVICE_ID = (() => {
  let id = localStorage.getItem('bitrate_device_id');
  if (!id) {
    id = randHex(16);
    localStorage.setItem('bitrate_device_id', id);
  }
  return id;
})();

// ---- state ----

// loading | practice | armed | scored | done | error
let state = 'loading';
let run = null;
let endTimer = null;
let escPendingTimer = null;
let noticeTimer = null;
let feedback = []; // transient hit-zone flashes {at, hand, kind, dir, heard, conf}

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
      },
    }),
  });
  if (!resp.ok) throw new Error('run/start failed: ' + resp.status);
  const data = await resp.json();
  const seq = data.sequence_ints;
  // Scored: only dispatch notes whose window closes strictly inside the
  // 60 s — the server's boundary filter is a strict t < duration, so an
  // event logged at exactly 60000 would count here and not there.
  const cap = Math.floor((DURATION_MS - WIN_MS - 1) / BEAT_MS) + 1;
  run = {
    id: data.run_id,
    seq,
    scored,
    noteCount: scored ? Math.min(cap, seq.length) : seq.length,
    t0: performance.now() + (scored ? COUNTIN_MS : TRAVEL_MS),
    started: false,
    anyInput: false,
    pos: 0,
    sc: 0,
    si: 0,
    keylog: [],
    doneOk: {},
    heardAt: {},
    flags: {},
    submitted: false,
    lastBeat: -99,
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
      '<span class="act armed-note">notes incoming — the clock starts when the first arrives</span>' +
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
  startRec();
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
  // Practice bouts submit only if the player actually swiped — idle
  // practice accrues misses by design (paced mode) and isn't a run.
  if (run && run.anyInput && !run.submitted && !run.scored) {
    submitRun(false).catch(() => {});
  }
  run = null;
}

function endScoredRun() {
  endTimer = null;
  clearEscPending();
  $('res-video-wrap').hidden = true;
  stopRec(showRecording);
  sweepMisses(run.t0 + DURATION_MS + 1); // all windows closed by now (noteCount cap)
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
  discardRec();
  run.submitted = run.submitted || !run.started;
  if (!run.submitted) submitRun(true).catch(() => {});
  run = null;
  toPractice();
  if (reason !== 'aborted') {
    showNotice('scored run invalidated — window lost focus · <b>Enter</b> re-arms', 'warn', 6000);
  }
}

// ---- judging ----

function noteT(k) { return k * BEAT_MS; } // arrival, ms relative to t0

function judge(k, sym, conf, tPressed, tKeyup) {
  const expected = run.seq[k];
  const verdict = sym !== null && sym === expected;
  run.doneOk[k] = verdict;
  if (verdict) run.sc++;
  else {
    run.si++;
    if (sym !== null) run.heardAt[k] = { sym, conf };
  }
  run.keylog.push({
    i: run.keylog.length,
    key: sym === null ? 'miss' : String(sym),
    expected: String(expected),
    verdict,
    conf,
    t_shown_ms: Math.max(0, Math.floor(noteT(k) - TRAVEL_MS)),
    t_pressed_ms: Math.floor(tPressed), // floor: never rounds up across the 60 s boundary
    t_keyup_ms: tKeyup === null ? null : Math.floor(tKeyup),
  });
  feedback.push({
    at: performance.now(),
    hand: Math.floor(expected / S.dirs),
    kind: verdict ? 'hit' : (sym === null ? 'miss' : 'wrong'),
    dir: expected % S.dirs,
    heard: sym,
    conf,
  });
  run.pos++;
}

// A note's window closing unswung is an incorrect selection: the paced
// analog of advance-always. Runs every frame.
function sweepMisses(now) {
  if (!run || (state !== 'practice' && state !== 'scored')) return;
  while (run.pos < run.noteCount && now - run.t0 > noteT(run.pos) + WIN_MS) {
    judge(run.pos, null, 0, noteT(run.pos) + WIN_MS, null);
  }
  if (!run.scored && run.pos >= run.seq.length && !run.reseeding) {
    run.reseeding = true; // sweep runs every frame; reseed exactly once
    toPractice();
  }
}

// One stroke = one selection attempt. hand 0=left 1=right.
function onStroke(hand, dir, conf, ts, tsEnd) {
  if (!run || (state !== 'practice' && state !== 'armed' && state !== 'scored')) return;
  clearEscPending();
  const sym = hand * S.dirs + dir;
  const rel = ts - run.t0;
  if (run.scored && run.started && rel >= DURATION_MS) return;
  if (run.pos >= run.noteCount) return;
  if (!run.anyInput) {
    run.anyInput = true;
    if (!run.scored) modeBanner.className = 'mode-practice-live';
  }
  const tk = noteT(run.pos);
  if (rel < tk - WIN_MS) {
    // Stray: no note in window. Logged nowhere, consumes nothing — but shown.
    feedback.push({ at: performance.now(), hand, kind: 'early', dir, heard: sym, conf });
    return;
  }
  judge(run.pos, sym, conf, rel, tsEnd === null ? null : tsEnd - run.t0);
}

// ---- camera pipeline: mirrored 96x54 grayscale, per-half motion ----

const PROC_W = 96, PROC_H = 54, HALF_W = PROC_W / 2;
const PIX_T = 26;          // per-pixel |diff| threshold (0-255)
const MIN_FRAMES = 2;
const END_QUIET = 3;       // ~100 ms at 30 fps ends the stroke
const MAX_FRAMES = 18;     // force-end runaway strokes (~600 ms)
const REFRACTORY = 4;      // swallow the hand's return motion
const MIN_DISP = 5;        // proc-pixels of centroid travel to count as a swipe

const video = $('cam');
const procCanvas = document.createElement('canvas');
procCanvas.width = PROC_W; procCanvas.height = PROC_H;
const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
const motCanvas = document.createElement('canvas');
motCanvas.width = PROC_W; motCanvas.height = PROC_H;
const motCtx = motCanvas.getContext('2d');
const motImg = motCtx.createImageData(PROC_W, PROC_H);

let camOK = false, camWanted = false;
let prevGray = null;
const level = { l: 0, r: 0 }; // live energy readout (sheet + preview bars)
const segs = [mkSeg(), mkSeg()]; // [left half, right half]

function mkSeg() {
  return { active: false, frames: [], quiet: 0, refractory: 0, peakE: 0, peakIdx: 0 };
}

async function camInit() {
  camWanted = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();
    camOK = true;
    camFrameLoop();
  } catch {
    camOK = false;
    showNotice('camera unavailable — allow access and reload, or switch input to keys in ⚙ settings', 'warn', 12000);
  }
}

function camStop() {
  camWanted = false;
  camOK = false;
  const s = video.srcObject;
  if (s) for (const t of s.getTracks()) t.stop();
  video.srcObject = null;
  prevGray = null;
}

function camFrameLoop() {
  if (!camOK) return;
  // Prefer per-video-frame callbacks; rAF re-reads duplicate frames
  // (diff 0) which would end strokes early.
  if (video.requestVideoFrameCallback) {
    video.requestVideoFrameCallback(() => { procFrame(); camFrameLoop(); });
  } else {
    requestAnimationFrame(() => { procFrame(); camFrameLoop(); });
  }
}

function procFrame() {
  if (!camOK || !video.videoWidth) return;
  // Mirror at capture: everything downstream is in mirror space, so the
  // user's left hand is the left half and +x is "my right".
  procCtx.save();
  procCtx.translate(PROC_W, 0);
  procCtx.scale(-1, 1);
  procCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
  procCtx.restore();
  const img = procCtx.getImageData(0, 0, PROC_W, PROC_H).data;
  const gray = new Uint8Array(PROC_W * PROC_H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (img[p] * 2 + img[p + 1] * 5 + img[p + 2]) >> 3;
  }
  const t = performance.now();
  if (prevGray) {
    const halves = [
      { n: 0, sx: 0, sy: 0, e: 0 },
      { n: 0, sx: 0, sy: 0, e: 0 },
    ];
    const mp = motImg.data;
    for (let y = 0, i = 0; y < PROC_H; y++) {
      for (let x = 0; x < PROC_W; x++, i++) {
        const d = Math.abs(gray[i] - prevGray[i]);
        const hot = d > PIX_T;
        const o = i * 4;
        mp[o] = 224; mp[o + 1] = 82; mp[o + 2] = 82;
        mp[o + 3] = hot ? 200 : 0;
        if (hot) {
          const h = halves[x < HALF_W ? 0 : 1];
          h.n++; h.sx += x; h.sy += y; h.e += d;
        }
      }
    }
    motCtx.putImageData(motImg, 0, 0);
    const halfPix = HALF_W * PROC_H;
    for (let s = 0; s < 2; s++) {
      const h = halves[s];
      const energy = h.n / halfPix;
      if (s === 0) level.l = energy; else level.r = energy;
      stepSeg(s, energy, h.n ? h.sx / h.n : null, h.n ? h.sy / h.n : null, t);
    }
  }
  prevGray = gray;
}

function stepSeg(hand, energy, cx, cy, t) {
  const seg = segs[hand];
  const onset = SENS[S.sens];
  const endT = onset * 0.45;
  if (!seg.active) {
    if (seg.refractory > 0) seg.refractory--;
    else if (energy > onset && cx !== null) {
      seg.active = true;
      seg.frames = [{ t, cx, cy, e: energy }];
      seg.quiet = 0;
      seg.peakE = energy;
      seg.peakIdx = 0;
    }
    return;
  }
  if (cx !== null) seg.frames.push({ t, cx, cy, e: energy });
  if (energy > seg.peakE) { seg.peakE = energy; seg.peakIdx = seg.frames.length - 1; }
  if (energy < endT) seg.quiet++;
  else seg.quiet = 0;
  if (seg.quiet >= END_QUIET || seg.frames.length >= MAX_FRAMES) endStroke(hand);
}

function endStroke(hand) {
  const seg = segs[hand];
  seg.active = false;
  seg.refractory = REFRACTORY;
  const fr = seg.frames;
  if (fr.length < MIN_FRAMES) return;
  // Direction from onset -> energy peak: the return motion (after the
  // peak) belongs to the hand coming back, not to the swipe.
  const a = fr[0], b = fr[Math.max(seg.peakIdx, 1)];
  let dx = b.cx - a.cx, dy = b.cy - a.cy;
  if (Math.hypot(dx, dy) < MIN_DISP) {
    const c = fr[fr.length - 1];
    dx = c.cx - a.cx; dy = c.cy - a.cy;
    if (Math.hypot(dx, dy) < MIN_DISP) return; // shimmer, not a swipe
  }
  const q = quantizeDir(dx, dy);
  onStroke(hand, q.dir, q.conf, b.t, fr[fr.length - 1].t);
}

function quantizeDir(dx, dy) {
  const ang = Math.atan2(-dy, dx) * 180 / Math.PI; // 0=right, 90=up
  const sw = 360 / (S.dirs === 4 ? 4 : 8);
  const raw = (90 - ang) / sw; // 0=up, clockwise
  const idx = Math.round(raw);
  const offset = (raw - idx) * sw;
  const dir = ((idx % S.dirs) + S.dirs) % S.dirs;
  return { dir, conf: Math.round((1 - Math.abs(offset) / (sw / 2)) * 1000) / 1000 };
}

// ---- run recording: the composited canvas (camera + highway), scored
// runs only. canvas.captureStream feeds MediaRecorder while the DSP
// recognizer keeps reading its own 96x54 proc frame — fully independent.
// Local-only (spec §6): the file leaves the browser only via the download
// link. Not part of the variant config: recording doesn't alter the task.

let recorder = null, recChunks = [], recUrl = null;

function recMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function startRec() {
  if (S.input !== 'camera' || S.rec === 'off' || !camOK) return;
  const mime = recMime();
  if (!mime) return;
  // Source is a setting: the composited game view (canvas), or the raw
  // unmirrored camera feed with no overlay.
  const src = S.rec === 'camera' ? video.srcObject : fieldEl.captureStream(30);
  try {
    recorder = new MediaRecorder(src, {
      mimeType: mime,
      videoBitsPerSecond: 2_500_000,
    });
  } catch { recorder = null; return; }
  recChunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.start(1000);
}

function stopRec(onReady) {
  if (!recorder) { onReady(null); return; }
  const r = recorder;
  recorder = null;
  r.onstop = () => {
    if (!recChunks.length) { onReady(null); return; }
    if (recUrl) URL.revokeObjectURL(recUrl);
    recUrl = URL.createObjectURL(new Blob(recChunks, { type: r.mimeType }));
    recChunks = [];
    onReady(recUrl);
  };
  try { r.stop(); } catch { onReady(null); }
}

function discardRec() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  r.onstop = () => { recChunks = []; };
  try { r.stop(); } catch { /* fine */ }
}

function showRecording(url) {
  if (state !== 'done') return; // player already re-armed; keep it quiet
  const wrap = $('res-video-wrap');
  if (!url) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('res-video').src = url;
  const cs = scoreWith(run, CONFIG.duration_s);
  $('res-video-dl').href = url;
  $('res-video-dl').download = 'beat-hands-' + cs.bps.toFixed(2) + 'bps.webm';
}

// ---- keyboard: strokes (keys mode), arm / abort / sheet ----

const KEYMAP_L = { w: 0, d: 1, s: 2, a: 3 };
const KEYMAP_R = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 };

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (state === 'done' || state === 'error') {
    if (e.key === 'Enter') { e.preventDefault(); armScoredRun(); }
    else if (e.key === 'Escape') { e.preventDefault(); toPractice(); }
    return;
  }
  if (state === 'loading') return;
  if (S.input === 'keys' && !e.repeat) {
    const l = KEYMAP_L[e.key.toLowerCase ? e.key.toLowerCase() : e.key];
    const r = KEYMAP_R[e.key];
    if (l !== undefined || r !== undefined) {
      e.preventDefault();
      if (sheetOpen) closeSheet(); // play through, house lesson
      onStroke(r !== undefined ? 1 : 0, r !== undefined ? r : l, 1, e.timeStamp, null);
      return;
    }
  }
  if (e.key === 'Enter') {
    if (sheetOpen) { e.preventDefault(); closeSheet(); return; }
    if (state === 'practice') { e.preventDefault(); armScoredRun(); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sheetOpen) { closeSheet(); return; }
    if (state === 'practice' || state === 'armed') toPractice();
    else if (state === 'scored') {
      if (escPendingTimer) abortScoredRun('aborted');
      else armEscPending();
    }
  }
});

modeHelp.addEventListener('click', (e) => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'arm') armScoredRun();
  else if (act.dataset.act === 'seed') toPractice();
});

function armEscPending() {
  showNotice('press <b>Esc</b> again to end the scored run', '', 2500);
  escPendingTimer = setTimeout(clearEscPending, 2500);
}

function clearEscPending() {
  if (!escPendingTimer) return;
  clearTimeout(escPendingTimer);
  escPendingTimer = null;
  hideNotice();
}

function showNotice(html, cls, ms) {
  const n = $('notice');
  n.innerHTML = html;
  n.className = cls || '';
  n.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideNotice, ms || 4000);
}

function hideNotice() {
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  $('notice').hidden = true;
}

window.addEventListener('blur', onFocusLost);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) onFocusLost();
});

function onFocusLost() {
  if (!run) return;
  if (state === 'scored') abortScoredRun('focus_lost');
  else if (state === 'armed') toPractice();
  else if (state === 'practice') run.flags.focus_lost = true;
}

// ---- metronome ----

let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new AudioContext(); } catch { /* fine */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function tick(accent) {
  if (S.tick !== 'on' || !audioCtx || audioCtx.state !== 'running') return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.frequency.value = accent ? 1318 : 880;
  g.gain.setValueAtTime(accent ? 0.12 : 0.07, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
}

// ---- render loop: the canvas owns the frame clock ----

const HAND_COLOR = ['#e05252', '#7aa2f7']; // left red, right blue (house err/caret)
const ZFAR = 6;

let W = 0, H = 0, DPR = 1;

function layout() {
  DPR = devicePixelRatio || 1;
  W = fieldEl.clientWidth;
  H = fieldEl.clientHeight;
  if (fieldEl.width !== Math.round(W * DPR)) {
    fieldEl.width = Math.round(W * DPR);
    fieldEl.height = Math.round(H * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

function laneX(hand) { return hand === 0 ? W * 0.3 : W * 0.7; } // near where hands sit on camera

function hitR() { return Math.min(W * 0.07, 64); }

function project(hand, p) {
  // Constant world velocity toward the camera: z linear in (1-p), screen
  // motion accelerates near the line — the authentic highway feel.
  const z = 1 + ZFAR * (1 - p);
  const vx = W / 2, vy = H * 0.14, hy = H * 0.72;
  return {
    x: vx + (laneX(hand) - vx) / z,
    y: vy + (hy - vy) / z,
    s: Math.min(W * 0.13, 132) / z,
  };
}

function frame() {
  requestAnimationFrame(frame);
  if (state === 'done' || state === 'error' || state === 'loading') return;
  layout();
  const now = performance.now();

  if (run && state === 'armed' && now >= run.t0) beginScored();
  sweepMisses(now);
  if (!run) return; // toPractice may be mid-flight (async reseed)

  // metronome: beats tick from 4 before the downbeat
  const beatIdx = Math.floor((now - run.t0) / BEAT_MS);
  if (beatIdx !== run.lastBeat && beatIdx >= -4) {
    run.lastBeat = beatIdx;
    tick(beatIdx === 0);
  }

  ctx.clearRect(0, 0, W, H);
  if (S.input === 'camera') drawCamBackdrop();
  drawHighway();
  drawNotes(now);
  drawFeedback(now);
  drawTrail();
  if (recorder && state === 'scored') drawRecDot(now);
  if (state === 'armed') drawCountIn(now);
  if (S.input !== 'camera') drawKeysHint();
}

// The webcam IS the stage: full-screen mirrored feed, dimmed under the
// highway, with the motion mask shimmering on top — your hands visually
// line up with the lanes they control.
function drawCamBackdrop() {
  if (camOK && video.videoWidth) {
    const scale = Math.max(W / video.videoWidth, H / video.videoHeight); // cover-fit
    const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
    const dx = (W - dw) / 2, dy = (H - dh) / 2;
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1); // mirror to match proc space: your left hand, left half
    ctx.drawImage(video, W - dx - dw, dy, dw, dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(16, 18, 22, 0.62)'; // dim so notes stay readable
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.3;
    ctx.drawImage(motCanvas, dx, dy, dw, dh); // motion shimmer, already mirrored
    ctx.restore();
  } else {
    ctx.fillStyle = '#565c66';
    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('no camera — allow access and reload, or switch to keys in ⚙', W / 2, H - 24);
  }
  // faint center divider: the hand-half boundary
  ctx.strokeStyle = 'rgba(86, 92, 102, 0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 8]);
  ctx.beginPath();
  ctx.moveTo(W / 2, H * 0.08);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);
  if (camOK) {
    // live energy bars at the screen edges, threshold marker at 1/3
    const on = SENS[S.sens];
    const bh0 = H * 0.3, by = H * 0.6;
    for (const [i, e] of [[0, level.l], [1, level.r]]) {
      const bx = i === 0 ? 10 : W - 18;
      const bh = Math.min(1, e / (on * 3)) * bh0;
      ctx.fillStyle = e > on ? '#58b368' : 'rgba(86, 92, 102, 0.8)';
      ctx.fillRect(bx, by + bh0 - bh, 8, bh);
      ctx.strokeStyle = '#565c66';
      ctx.beginPath();
      ctx.moveTo(bx - 2, by + bh0 * (2 / 3));
      ctx.lineTo(bx + 10, by + bh0 * (2 / 3));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(86, 92, 102, 0.9)';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('video stays on this machine', W / 2, H - 10);
  }
}

function drawHighway() {
  const hy = H * 0.72;
  ctx.strokeStyle = '#2a2e36';
  ctx.lineWidth = 1;
  for (const hand of [0, 1]) {
    const a = project(hand, 0), b = project(hand, 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(W * 0.2, hy);
  ctx.lineTo(W * 0.8, hy);
  ctx.stroke();
  // hit zones
  for (const hand of [0, 1]) {
    ctx.strokeStyle = HAND_COLOR[hand];
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(laneX(hand), hy, hitR(), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#565c66';
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(hand === 0 ? 'left hand' : 'right hand', laneX(hand), hy + hitR() + 18);
  }
}

function drawNotes(now) {
  const rel = now - run.t0;
  // find the farthest visible note, draw far-to-near (painter's order)
  let far = run.pos;
  while (far < run.noteCount && rel - (noteT(far) - TRAVEL_MS) >= 0) far++;
  for (let k = Math.min(far, run.noteCount - 1); k >= run.pos; k--) {
    if (k >= run.noteCount) continue;
    const p = (rel - (noteT(k) - TRAVEL_MS)) / TRAVEL_MS;
    if (p < 0 || p > 1.12) continue;
    const sym = run.seq[k];
    const hand = Math.floor(sym / S.dirs), dir = sym % S.dirs;
    const pr = project(hand, Math.min(p, 1.12));
    ctx.globalAlpha = 0.3 + 0.7 * Math.min(p * 1.6, 1);
    roundRect(pr.x - pr.s / 2, pr.y - pr.s / 2, pr.s, pr.s, pr.s * 0.18);
    ctx.fillStyle = HAND_COLOR[hand];
    ctx.fill();
    // in-window ring on the current note
    if (k === run.pos && Math.abs(rel - noteT(k)) <= WIN_MS) {
      ctx.strokeStyle = '#d7dae0';
      ctx.lineWidth = 2.5;
      roundRect(pr.x - pr.s / 2 - 3, pr.y - pr.s / 2 - 3, pr.s + 6, pr.s + 6, pr.s * 0.2);
      ctx.stroke();
    }
    drawArrow(pr.x, pr.y, pr.s * 0.62, dir * (360 / S.dirs), '#101216');
    ctx.globalAlpha = 1;
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawArrow(x, y, size, angleDeg, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleDeg * Math.PI / 180);
  ctx.fillStyle = color;
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.8, s * 0.25);
  ctx.lineTo(s * 0.32, s * 0.25);
  ctx.lineTo(s * 0.32, s);
  ctx.lineTo(-s * 0.32, s);
  ctx.lineTo(-s * 0.32, s * 0.25);
  ctx.lineTo(-s * 0.8, s * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawFeedback(now) {
  const hy = H * 0.72;
  feedback = feedback.filter((f) => now - f.at < 700);
  // Text bubbles collide when strokes come fast — keep only the newest
  // text-bearing entry per hand; rings/crosses stack fine.
  const newestText = {};
  for (const f of feedback) {
    if (f.kind === 'wrong' || f.kind === 'early') newestText[f.hand] = f;
  }
  for (const f of feedback) {
    if ((f.kind === 'wrong' || f.kind === 'early') && newestText[f.hand] !== f) continue;
    const age = (now - f.at) / 700;
    const x = laneX(f.hand);
    ctx.globalAlpha = 1 - age;
    if (f.kind === 'hit') {
      ctx.strokeStyle = '#58b368';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, hy, hitR() + age * 16, 0, Math.PI * 2);
      ctx.stroke();
    } else if (f.kind === 'miss') {
      ctx.strokeStyle = '#e05252';
      ctx.lineWidth = 3;
      cross(x, hy, 16);
    } else if (f.kind === 'wrong' || f.kind === 'early') {
      // heard-bubble analog: what the recognizer saw, dashed red, with
      // confidence underneath.
      ctx.strokeStyle = '#e05252';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(x, hy - 84, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (f.heard !== null) {
        drawArrow(x, hy - 84, 28, (f.heard % S.dirs) * (360 / S.dirs), '#e05252');
      }
      ctx.fillStyle = '#e05252';
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(f.kind === 'early' ? 'early' : ('heard ' + symName(f.heard) + ' · ' + f.conf.toFixed(2)), x, hy - 46);
    }
  }
  ctx.globalAlpha = 1;
}

function cross(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
  ctx.stroke();
}

function drawTrail() {
  // last 12 verdicts, oldest left — the "how am I doing" strip
  const n = Math.min(run.pos, 12);
  for (let j = 0; j < n; j++) {
    const k = run.pos - n + j;
    ctx.fillStyle = run.doneOk[k] ? '#58b368' : '#e05252';
    ctx.globalAlpha = run.doneOk[k] ? 0.9 : 0.7;
    ctx.beginPath();
    ctx.arc(24 + j * 14, H * 0.72 + 40, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRecDot(now) {
  ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 350);
  ctx.fillStyle = '#e05252';
  ctx.beginPath();
  ctx.arc(W / 2 - 52, 27, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8a9199';
  ctx.fillText('rec · stays local', W / 2 - 40, 31);
}

function drawCountIn(now) {
  const sLeft = Math.ceil((run.t0 - now) / 1000);
  if (sLeft <= 0) return;
  ctx.fillStyle = '#e0b452';
  ctx.font = '64px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(String(sLeft), W / 2, H * 0.45);
}

function drawKeysHint() {
  ctx.fillStyle = '#565c66';
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('left hand: W A S D · right hand: arrow keys', W / 2, H - 24);
}

// ---- scoring / submit (house pattern) ----

function scoreWith(r, tSec) {
  const net = Math.max(r.sc - r.si, 0);
  return { n: N, sc: r.sc, si: r.si, bps: tSec > 0 ? (BITS * net) / tSec : 0 };
}

function elapsedMsOf(r) {
  return Math.max(0, performance.now() - r.t0);
}

function lastKeyT(r) {
  return r.keylog.length ? r.keylog[r.keylog.length - 1].t_pressed_ms : 0;
}

async function submitRun(invalidated) {
  const r = run;
  if (!r || r.submitted) return null;
  r.submitted = true;
  const elapsed = r.scored ? DURATION_MS : elapsedMsOf(r);
  const tSec = r.scored ? CONFIG.duration_s : Math.max(elapsed, lastKeyT(r)) / 1000;
  const cs = scoreWith(r, tSec);
  const payload = {
    run_id: r.id,
    device_id: DEVICE_ID,
    invalidated,
    flags: r.flags,
    elapsed_ms: elapsed,
    client_result: invalidated ? null : cs,
    keystrokes: r.keylog,
  };
  try {
    return await postSubmit(payload);
  } catch (err) {
    enqueue(payload);
    throw err;
  }
}

async function postSubmit(payload) {
  const resp = await fetch('/api/run/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error('submit failed: ' + resp.status);
  return resp.json();
}

const QUEUE_KEY = 'bitrate_submit_queue_v1';

function enqueue(payload) {
  try {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    q.push(payload);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    scheduleFlush(2000);
  } catch { /* fine */ }
}

let flushTimer = null;
function scheduleFlush(delay) {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    let q;
    try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return; }
    if (!q.length) return;
    try {
      await postSubmit(q[0]);
      q.shift();
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      if (q.length) scheduleFlush(500);
    } catch {
      scheduleFlush(Math.min(delay * 2, 60000));
    }
  }, delay);
}

// ---- HUD (contract (c): >= 1 Hz) ----

function renderHud() {
  if (state === 'done') return;
  if (!run || (!run.started && !run.anyInput && state !== 'scored')) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent =
      state === 'armed' ? 'starts in ' + Math.max(1, Math.ceil((run ? run.t0 - performance.now() : 0) / 1000)) + 's' : '';
    $('hud-counts').textContent = '';
    if (run && !run.scored && run.pos > 0) hudCounts();
    $('hud-spark').innerHTML = '';
    return;
  }
  const elapsed = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD stays cumulative — it previews the actual 60 s score.
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    hudCounts();
    $('hud-spark').innerHTML = '';
    return;
  }
  // Practice: trailing-60 s window + rolling sparkline (shared helpers). A miss
  // (verdict:false) counts as an incorrect selection, same as scoring.
  const tr = window.BitrateResults.trailingBps(run.keylog, BITS, elapsed);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(elapsed / 1000) + 's practice';
  $('hud-counts').textContent = 'Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  $('hud-spark').innerHTML = window.BitrateResults.sparkHTML(run.keylog, BITS, elapsed);
}

function hudCounts() {
  $('hud-counts').textContent = 'Sc ' + run.sc + ' · Si ' + run.si;
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
    '<div class="res-title">beat hands (2×' + S.dirs + ' · ' + S.tempo + '/min · ' + S.input + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
    ' · accuracy <b>' + (sc + si > 0 ? ((100 * sc) / (sc + si)).toFixed(1) : '—') + '%</b></div>' +
    note;

  const m = opts.server && opts.server.metrics;
  const R = window.BitrateResults;
  $('res-tiles').innerHTML = m ? R.tilesHTML(m, { corrections: false }) : '';
  $('chart-pace').innerHTML = m && m.selections > 1 ? R.paceChartSVG(m, BITS) : '';
  $('chart-iki').innerHTML = m && m.selections > 1 ? R.ikiChartSVG(m) : '';
}

function showError(err) {
  state = 'error';
  overlay.hidden = false;
  card.innerHTML =
    '<div class="title">error</div>' +
    '<div class="row">' + String(err).replace(/[<>&]/g, '') + '</div>' +
    '<div class="note">press <b>Enter</b> to retry</div>';
}

// ---- settings sheet ----

const sheetEl = $('sheet');
let sheetOpen = false;

function openSheet() {
  if (state !== 'practice') return;
  sheetOpen = true;
  syncSheet();
  sheetEl.classList.add('open');
}

function closeSheet() {
  sheetOpen = false;
  sheetEl.classList.remove('open');
  if (document.activeElement && sheetEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

function syncSheet() {
  const segSync = (id, v) => {
    for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === String(v));
  };
  segSync('seg-input', S.input);
  segSync('seg-dirs', S.dirs);
  segSync('seg-tempo', S.tempo);
  segSync('seg-window', S.window);
  segSync('seg-tick', S.tick);
  segSync('seg-sens', S.sens);
  segSync('seg-rec', S.rec);
  $('seg-dirs').querySelector('[data-v="8"]').disabled = S.input === 'keys';
  $('row-sens').hidden = S.input !== 'camera';
  $('row-rec').hidden = S.input !== 'camera';
  $('sheet-info').textContent =
    'N=' + N + ' · ' + BITS.toFixed(2) + ' bits/selection · window ±' + WIN_MS +
    ' ms effective · ' + Math.round(TRAVEL_MS / BEAT_MS * 10) / 10 + ' notes visible · changes restart the bout';
}

function applySetting(mut) {
  mut();
  saveSettings();
  buildConfig();
  syncSheet();
  if (S.input === 'camera' && !camWanted) camInit();
  if (S.input === 'keys' && camWanted) camStop();
  toPractice(); // config change -> new variant
}

function bindSeg(id, fn) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    b.blur();
    applySetting(() => fn(b.dataset.v));
  });
}

bindSeg('seg-input', (v) => { S.input = v; });
bindSeg('seg-dirs', (v) => { S.dirs = Number(v); });
bindSeg('seg-tempo', (v) => { S.tempo = Number(v); });
bindSeg('seg-window', (v) => { S.window = Number(v); });
bindSeg('seg-tick', (v) => { S.tick = v; });
bindSeg('seg-sens', (v) => { S.sens = v; });
bindSeg('seg-rec', (v) => { S.rec = v; });

// Live motion readout while the sheet is open — is "didn't register" a
// trigger-threshold problem? (the mic-stats pattern)
setInterval(() => {
  if (!sheetOpen) return;
  $('cam-stats').textContent = S.input !== 'camera' ? ''
    : !camOK ? 'camera: unavailable'
    : 'motion: L ' + level.l.toFixed(3) + ' · R ' + level.r.toFixed(3) +
      ' · trigger ' + SENS[S.sens].toFixed(3);
}, 400);

$('gear').addEventListener('click', (e) => {
  e.currentTarget.blur();
  ensureAudio();
  sheetOpen ? closeSheet() : openSheet();
});

document.addEventListener('pointerdown', ensureAudio, { once: true });
document.addEventListener('keydown', ensureAudio, { once: true });

// ---- ?cfg= relaunch from the gallery (session-only, not persisted) ----

async function applyCfgParam() {
  const hash = new URLSearchParams(location.search).get('cfg');
  if (!hash) return;
  try {
    const vs = await (await fetch('/api/variants')).json();
    const v = (vs.variants || vs || []).find((x) => x.config_hash === hash && x.environment === 'beat-hands');
    if (!v) return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if (c.input === 'keys' || c.input === 'camera') S.input = c.input;
    if (c.directions === 4 || c.directions === 8) S.dirs = c.directions;
    if (c.tempo_npm) S.tempo = c.tempo_npm;
    if (c.hit_window_ms) S.window = c.hit_window_ms;
    if (c.motion_sensitivity && SENS[c.motion_sensitivity]) S.sens = c.motion_sensitivity;
  } catch { /* fine */ }
}

// ---- debug hook: drives strokes without a camera (spec §3a — correctness
// only, never ranking; headless runs are excluded from the board anyway) ----

window.beatDebug = {
  swipe(hand, dir, conf) {
    onStroke(hand, dir, conf === undefined ? 1 : conf, performance.now(), performance.now());
    return run ? run.pos : -1;
  },
  quantizeDir,
  noteAt: (k) => (run ? run.seq[k] : null),
  pos: () => (run ? run.pos : -1),
  counts: () => (run ? { sc: run.sc, si: run.si } : null),
  config: () => CONFIG,
  state: () => state,
};

// ---- boot ----

loadSettings();
(async () => {
  await applyCfgParam();
  buildConfig();
  scheduleFlush(1500);
  if (S.input === 'camera') camInit();
  try { await startRun(false); } catch (err) { showError(err); }
  requestAnimationFrame(frame);
})();
