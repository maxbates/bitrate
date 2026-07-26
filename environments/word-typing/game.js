'use strict';

/* word-typing environment (spec §2.2 refinement, §5).
 *
 * The alphabet is a fixed, versioned word list (common-v1), targets drawn
 * i.i.d. uniform — a compliant alphabet whose symbols are words. One
 * selection = one committed word (space commits); backspace edits the
 * buffer freely before commit and is not a selection, so N = word count
 * (log2(N-1) prices the reserved slot per the formula regardless).
 *
 * The spec's algebra predicts a near-wash vs per-letter typing
 * (log2(words) < sum of letter bits, ~18 vs ~19 bps). This mode exists to
 * measure that honestly rather than assume it.
 */

// ---- config ----

const WORDS = window.BitrateWords;
const SETTINGS_KEY = 'bitrate_words_settings_v1';
const LOOKAHEAD = 4;

let maxLen = 4;
let WORDLIST = [];       // the active alphabet (index = canonical symbol)
let WORDIDX = new Map(); // word -> index
let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ([3, 4, 5].includes(s.max_len)) maxLen = s.max_len;
  } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ max_len: maxLen })); } catch { /* fine */ }
}

function buildConfig() {
  WORDLIST = WORDS.typing.filter((w) => w.length <= maxLen); // already sorted
  WORDIDX = new Map(WORDLIST.map((w, i) => [w, i]));
  N = WORDLIST.length;
  BITS = Math.log2(N - 1);
  CONFIG = {
    environment: 'word-typing',
    alphabet_size: N,
    wordlist: WORDS.version,
    word_max_len: maxLen,
    selection: 'word-commit',
    error_policy: 'advance',
    backspace: false, // buffer editing is free; backspace is not a selection
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
let buffer = '';

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
  buffer = '';
  setState(scored ? 'armed' : 'practice');
  renderChips();
  renderBuffer();
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

function renderBuffer() {
  const target = WORDLIST[run.seq[run.pos]] || '';
  let html = '';
  for (let i = 0; i < buffer.length; i++) {
    const good = i < target.length && buffer[i] === target[i];
    html += '<span class="' + (good ? 'good' : 'bad') + '">' + buffer[i] + '</span>';
  }
  $('buffer').innerHTML = html;
}

// ---- input: letters build the buffer, space commits the selection ----

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (sheetOpen) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeSheet(); return; }
    const playKey = e.key === 'Backspace' || (e.key.length === 1 && /[a-z ]/i.test(e.key));
    if (!playKey) return;
    closeSheet();
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
    return;
  }

  const isSpace = e.key === ' ';
  const isBackspace = e.key === 'Backspace';
  const isLetter = e.key.length === 1 && /[a-z]/i.test(e.key);
  if (!isSpace && !isBackspace && !isLetter) return;
  e.preventDefault();
  if (e.repeat && !isBackspace) return; // held-key autorepeat only edits

  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  if (run.scored && run.started && e.timeStamp - run.t0 >= DURATION_MS) return;

  clearEscPending();
  if (!run.started && (isLetter || isSpace)) {
    // Timer starts on the first keypress, not the first commit (spec §2.5).
    run.started = true;
    run.t0 = e.timeStamp;
    if (!run.scored) {
      modeBanner.className = 'mode-practice-live';
    } else {
      setState('scored');
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }

  if (isLetter) {
    if (buffer.length < 12) buffer += e.key.toLowerCase();
    renderBuffer();
    return;
  }
  if (isBackspace) {
    buffer = buffer.slice(0, -1); // free editing before commit — not a selection
    renderBuffer();
    return;
  }
  // Space: commit the buffer as a selection.
  if (!buffer) return; // empty commit is a no-op, not a selection
  commitWord(e.timeStamp);
});

function commitWord(ts) {
  const t = ts - run.t0;
  const expected = run.seq[run.pos];
  const idx = WORDIDX.has(buffer) ? WORDIDX.get(buffer) : -1;
  const verdict = idx === expected;

  run.doneOk[run.pos] = verdict;
  if (verdict) run.sc++;
  else run.si++;

  run.keylog.push({
    i: run.keylog.length,
    // Canonical symbol id when the typed word is in the alphabet; an
    // impossible sentinel otherwise (server judges by string equality).
    key: idx >= 0 ? String(idx) : 'x:' + buffer,
    expected: String(expected),
    verdict,
    t_shown_ms: run.shownAt[run.pos] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
  });

  buffer = '';
  run.pos++;
  run.shownAt[run.pos] = t;
  if (run.pos >= run.seq.length) {
    if (!run.scored) toPractice();
    return;
  }
  renderChips();
  renderBuffer();
}

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
    '<div class="res-title">word typing (≤' + maxLen + ' letters) · scored run — ' + CONFIG.duration_s + ' s</div>' +
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
  for (const b of $('seg-len').querySelectorAll('button')) {
    b.classList.toggle('on', Number(b.dataset.v) === maxLen);
  }
  $('sheet-info').textContent =
    'N=' + N + ' words (' + WORDS.version + ') · ' + BITS.toFixed(2) +
    ' bits/selection · changes restart the bout';
}

$('seg-len').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  maxLen = Number(b.dataset.v);
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
startRun(false).catch(showError);
