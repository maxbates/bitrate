'use strict';

/* speech-words environment (spec §5).
 *
 * i.i.d. words from a fixed, versioned, homophone-pruned list, spoken
 * aloud. One utterance = one selection regardless of word length — unlike
 * typing, a big word alphabet multiplies bits per utterance (1024 words ≈
 * 10 bits per ~600 ms ≈ 15+ bps theoretical).
 *
 * Recognition: the Web Speech API. On-device where available (Chrome 139+
 * processLocally / macOS Safari dictation); otherwise the browser's
 * default engine, which MAY use a network service — a visible notice says
 * so (lab experiment; §6's audio-never-leaves rule binds anything that
 * would ship, and the offline path for that is vendored WASM ASR, §4.1).
 * The recognizer's language model is in the recognition channel only —
 * target generation stays i.i.d. uniform (rule 1).
 */

// ---- config ----

const WORDS = window.BitrateWords;
const SETTINGS_KEY = 'bitrate_speech_settings_v1';
const LOOKAHEAD = 3;

let alphaSize = 512; // 0 = the whole list
let WORDLIST = [];
let WORDIDX = new Map();
let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([0, 256, 512, 1024].includes(s.size)) alphaSize = s.size;
  } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ size: alphaSize })); } catch { /* fine */ }
}

function buildConfig() {
  const full = WORDS.speech; // sorted; homophone-pruned
  if (alphaSize && alphaSize < full.length) {
    // Deterministic stride sample so the sublist spans the alphabet
    // rather than biasing toward a-words.
    WORDLIST = [];
    for (let i = 0; i < alphaSize; i++) {
      WORDLIST.push(full[Math.floor((i * full.length) / alphaSize)]);
    }
  } else {
    WORDLIST = full.slice();
  }
  WORDIDX = new Map(WORDLIST.map((w, i) => [w, i]));
  N = WORDLIST.length;
  BITS = Math.log2(N - 1);
  CONFIG = {
    environment: 'speech-words',
    alphabet_size: N,
    wordlist: WORDS.version,
    selection: 'spoken-word',
    recognizer: 'web-speech-api',
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
}

// ---- dom / identity ----

const $ = (id) => document.getElementById(id);
const modeBanner = $('mode-banner');
const modeHelp = $('mode-help');
const overlay = $('overlay');
const card = $('card');
const resultsEl = $('results');

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
  run = {
    id: data.run_id,
    seq: data.sequence_ints,
    scored,
    started: false,
    t0: 0,
    pos: 0,
    sc: 0,
    si: 0,
    keylog: [],
    shownAt: [0],
    doneOk: {},
    flags: {},
    submitted: false,
  };
  setState(scored ? 'armed' : 'practice');
  renderChips();
  renderHud();
}

function setState(next) {
  state = next;
  document.body.classList.toggle('armed', next === 'armed');
  overlay.hidden = next !== 'error';
  resultsEl.hidden = next !== 'done';
  $('stage').hidden = next === 'done';
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
      '<span class="act armed-note">your first keypress starts the 60 s clock</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</span>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

// ---- rendering ----

function renderChips() {
  const wrap = $('chips');
  wrap.innerHTML = '';
  const from = Math.max(0, run.pos - 2);
  const to = Math.min(run.seq.length, run.pos + LOOKAHEAD + 1);
  for (let i = from; i < to; i++) {
    const el = document.createElement('span');
    el.textContent = WORDLIST[run.seq[i]];
    let cls = 'chip';
    if (i < run.pos) cls += run.doneOk[i] ? ' done-ok' : ' done-err';
    else if (i === run.pos) cls += ' cur';
    el.className = cls;
    wrap.appendChild(el);
  }
}

// ---- recognition: Web Speech API, on-device where available ----

let recog = null;
let recogWanted = false;
let localMode = false;

function recogInit() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showNotice('speech recognition unavailable in this browser — try Chrome or Safari', 'warn', 60000);
    $('heard-text').textContent = 'no recognizer';
    return;
  }
  // Constructing SpeechRecognition can hard-crash backend-less builds
  // (headless shells), and mic permission wants a gesture anyway — so the
  // recognizer is built lazily on the first TRUSTED user gesture. The
  // synthetic harness drives speechDebug and never trips this.
  $('heard-text').textContent = 'press any key or click to start the microphone';
  const arm = (e) => {
    if (!e.isTrusted || recog) return;
    document.removeEventListener('keydown', arm, true);
    document.removeEventListener('mousedown', arm, true);
    try {
      recogInitReal(SR);
    } catch (err) {
      showNotice('speech recognition failed to start: ' + String(err).replace(/[<>&]/g, ''), 'warn', 30000);
    }
  };
  document.addEventListener('keydown', arm, true);
  document.addEventListener('mousedown', arm, true);
}

function recogInitReal(SR) {
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.maxAlternatives = 1;
  recog.lang = 'en-US';
  // Chrome 139+: keep audio on this machine when the local model exists.
  if ('processLocally' in recog) {
    try { recog.processLocally = true; localMode = true; } catch { /* server fallback */ }
  }
  if (!localMode) {
    showNotice('recognition may use a network service — lab experiment (§6 binds anything that ships)', '', 8000);
  }
  recog.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (!res.isFinal) continue;
      const transcript = String(res[0].transcript || '').toLowerCase();
      const tokens = transcript.match(/[a-z]+/g);
      if (!tokens || !tokens.length) continue;
      onSpoken(tokens[tokens.length - 1], res[0].confidence || 0, ev.timeStamp, transcript);
    }
  };
  recog.onerror = (ev) => {
    if (ev.error === 'not-allowed') {
      showNotice('microphone blocked — allow access and reload', 'warn', 60000);
      recogWanted = false;
    }
  };
  // Engines stop themselves periodically; keep it running.
  recog.onend = () => { if (recogWanted) { try { recog.start(); } catch { /* retried onend */ } } };
  recogStart();
}

function recogStart() {
  if (!recog) return;
  recogWanted = true;
  try { recog.start(); $('level-dot').className = 'live'; } catch { /* already running */ }
  $('level-dot').id = 'level-dot';
  $('level-dot').classList.add('live');
}

function onSpoken(word, conf, ts, transcript) {
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  if (!run) return;
  if (run.scored && run.started && ts - run.t0 >= DURATION_MS) return;

  clearEscPending();
  if (!run.started) {
    // The recognizer only reports result time; the utterance began
    // earlier. Honest accounting: the clock starts at the first result
    // event (biases the first selection's latency in the player's favor
    // by at most one recognition delay; logged as-is).
    run.started = true;
    run.t0 = ts;
    if (!run.scored) {
      modeBanner.className = 'mode-practice-live';
    } else {
      setState('scored');
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }
  const t = ts - run.t0;
  const expected = run.seq[run.pos];
  const idx = WORDIDX.has(word) ? WORDIDX.get(word) : -1;
  const verdict = idx === expected;

  run.doneOk[run.pos] = verdict;
  if (verdict) run.sc++;
  else run.si++;

  const confR = Math.round(conf * 1000) / 1000;
  run.keylog.push({
    i: run.keylog.length,
    key: idx >= 0 ? String(idx) : 'x:' + word.slice(0, 24),
    expected: String(expected),
    verdict,
    conf: confR,
    t_shown_ms: run.shownAt[run.pos] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
  });

  $('heard-text').innerHTML = 'heard <b>' + word + '</b>' +
    (conf ? (conf < 0.75 ? ' <span class="lowconf">(' + confR + ')</span>' : ' (' + confR + ')') : '');

  run.pos++;
  run.shownAt[run.pos] = t;
  if (run.pos >= run.seq.length) {
    if (!run.scored) toPractice();
    return;
  }
  renderChips();
}

// keyboard: arming and aborting only — words come from the microphone
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (sheetOpen) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeSheet(); }
    return;
  }
  if (state === 'done' || state === 'error') {
    if (e.key === 'Enter') { e.preventDefault(); armScoredRun(); }
    else if (e.key === 'Escape') { e.preventDefault(); toPractice(); }
    return;
  }
  if (state === 'loading') return;
  if (e.key === 'Enter') {
    if (state === 'practice') { e.preventDefault(); armScoredRun(); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (state === 'practice') toPractice();
    else if (state === 'armed') toPractice();
    else if (state === 'scored') {
      if (escPendingTimer) abortScoredRun('aborted');
      else armEscPending();
    }
  }
});

// debug hook: drives the recognition path without a microphone (spec §3a)
window.speechDebug = {
  say(word) { onSpoken(word, 0.9, performance.now(), word); return word; },
  wordAt(i) { return WORDLIST[run.seq[run.pos + (i || 0)]]; },
  state: () => state,
};

// ---- corner actions ----

modeHelp.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'arm') armScoredRun();
  else if (act.dataset.act === 'seed') toPractice();
});

// ---- mode transitions (house pattern) ----

async function armScoredRun() {
  await finishBout();
  try { await startRun(true); } catch (err) { showError(err); }
}

async function toPractice() {
  await finishBout();
  try { await startRun(false); } catch (err) { showError(err); }
}

async function finishBout() {
  if (run && run.started && !run.submitted) {
    submitRun(false).catch(() => {});
  }
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
  submitRun(true).catch(() => {});
  toPractice();
  if (reason !== 'aborted') {
    showNotice('scored run invalidated — window lost focus · <b>Enter</b> re-arms', 'warn', 6000);
  }
}

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
  if (!run || !run.started) return;
  if (state === 'scored') abortScoredRun('focus_lost');
  else if (state === 'practice') run.flags.focus_lost = true;
}

// ---- scoring / submit (house pattern) ----

function scoreWith(r, tSec) {
  const net = Math.max(r.sc - r.si, 0);
  return { n: N, sc: r.sc, si: r.si, bps: tSec > 0 ? (BITS * net) / tSec : 0 };
}

function elapsedMsOf(r) {
  return r && r.started ? performance.now() - r.t0 : 0;
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

// ---- HUD ----

function renderHud() {
  if (state === 'done') return;
  if (!run || !run.started) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? CONFIG.duration_s + 's' : '';
    $('hud-counts').textContent = '';
    return;
  }
  const elapsed = elapsedMsOf(run);
  const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
  $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  if (run.scored) {
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
  } else {
    $('hud-time').textContent = Math.floor(elapsed / 1000) + 's practice';
  }
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
    '<div class="res-title">speech words (N=' + N + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> words · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
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
  for (const b of $('seg-size').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.v) === alphaSize);
  }
  $('sheet-info').textContent =
    'N=' + N + ' words (' + WORDS.version + ', homophone-pruned) · ' + BITS.toFixed(2) +
    ' bits/selection · ' + (localMode ? 'on-device recognition' : 'browser recognition engine') +
    ' · changes restart the bout';
}

$('seg-size').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  alphaSize = Number(b.dataset.v);
  saveSettings();
  buildConfig();
  syncSheet();
  toPractice();
});

$('gear').addEventListener('click', (e) => {
  e.currentTarget.blur();
  sheetOpen ? closeSheet() : openSheet();
});

// ---- boot ----

loadSettings();
buildConfig();
scheduleFlush(1500);
recogInit();
startRun(false).catch(showError);
