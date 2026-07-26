'use strict';

/* stream-typing environment (spec §2, §7).
 *
 * Direct DOM manipulation only — no framework, no reconciliation step
 * between keydown and paint (spec §4.3). Character spans are pre-rendered
 * once per run; the keydown path touches one class and one transform.
 * No network calls, no console.log, no layout reads inside keydown.
 */

// ---- config ----
// The default is the ship config (static; calibration is v2 — spec §2.6).
// The settings sheet edits the exposed knobs; every distinct config is
// content-addressed server-side, so tweaks mint/reuse variants for free
// (spec §9 step 5).

const DEFAULTS = {
  environment: 'stream-typing',
  alphabet: 'abcdefghijklmnopqrstuvwxyz',
  lookahead: 8,
  fixation: 'pinned',
  // Groups of 4 by default: the separators are display-only glyphs and never
  // targets (spec §2.3), but they give the eye a landing place, which is what
  // an unfamiliar player needs before they'll sit still for a scored run.
  // Off and 3/5/6 are one tap away in the sheet.
  chunk_size: 4,
  audio_feedback: false,
  error_policy: 'advance',
  backspace: true,
  duration_s: 60,
  hud_position: 'corner',
  font_stack: 'system-mono',
};
const SETTINGS_KEY = 'bitrate_settings_v1';
const TUNABLE = ['alphabet', 'lookahead', 'chunk_size', 'audio_feedback'];
// Short names for the alphabets the sheet offers, keyed by size (see index.html).
const ALPHA_LABELS = { 9: 'home row', 26: 'a–z', 36: 'a–z 0–9' };

let CONFIG, N, BITS, ALPHA, DURATION_MS, CHUNK;

function setConfig(cfg) {
  CONFIG = cfg;
  N = cfg.alphabet.length + (cfg.backspace ? 1 : 0); // backspace counts in N
  BITS = Math.log2(N - 1);                           // ship: log2(26) ≈ 4.70
  ALPHA = new Set(cfg.alphabet);
  DURATION_MS = cfg.duration_s * 1000;
  CHUNK = cfg.chunk_size || 0;
  renderCfg();
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* defaults */ }
  const cfg = { ...DEFAULTS };
  for (const k of TUNABLE) if (k in saved) cfg[k] = saved[k];
  setConfig(cfg);
}

function saveSettings() {
  const out = {};
  for (const k of TUNABLE) out[k] = CONFIG[k];
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch { /* fine */ }
}

// Chunk separators are display-only glyphs, never targets (spec §2.3):
// seps(p) = separators rendered before sequence position p.
function seps(p) {
  return CHUNK ? Math.floor(p / CHUNK) : 0;
}

// ---- dom ----

const $ = (id) => document.getElementById(id);
const streamEl = $('stream');
const caretEl = $('caret');
const viewportEl = $('stream-viewport');
const hudBps = $('hud-bps');
const hudTime = $('hud-time');
const hudCounts = $('hud-counts');
const modeBanner = $('mode-banner');
const modeHelp = $('mode-help');
const capsWarning = $('caps-warning');
const imeWarning = $('ime-warning');
const hintEl = $('hint');
const kbdEl = $('kbd-catcher');
const overlay = $('overlay');
const card = $('card');
const resultsEl = $('results');

// ---- device identity (spec §4.4): random id, no accounts, no PII ----

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
let spans = [];
let charW = 0;
let endTimer = null;
let imeActive = false;
let escPendingTimer = null; // double-Esc confirmation for ending a scored run
let noticeTimer = null;

// ---- run lifecycle ----

let lastConfigHash = '';

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
  lastConfigHash = data.config_hash || '';
  run = {
    id: data.run_id,
    seq: data.sequence,
    scored,
    started: false,
    t0: 0,
    pos: 0,
    errs: [],
    sc: 0,
    si: 0,
    keylog: [],
    shownAt: [0], // shownAt[p] = when position p entered fixation (ms since t0)
    flags: {},
    submitted: false,
  };
  // setState first: buildStream measures glyph widths, and measuring inside
  // a hidden stage (coming from the results view) reads zeros.
  setState(scored ? 'armed' : 'practice');
  buildStream(run.seq);
  renderHud();
  if (sheetOpen) syncSheet(); // config hash for the new run just arrived
}

// What the settings sheet is currently set to, short enough for the corner.
function configLabel() {
  return (ALPHA_LABELS[CONFIG.alphabet.length] || 'N ' + N) + ' · look ' + CONFIG.lookahead +
    (CHUNK ? ' · chunk ' + CHUNK : '');
}

// The middle of the header: what this variant is set to, with the settings
// button under it — the label and the way to change it are one object. The
// N and bits/selection are the honest accounting (spec §7), always on screen.
function renderCfg() {
  $('res-info').innerHTML =
    configLabel() + ' · N <b>' + N + '</b> · <b>' + BITS.toFixed(2) + '</b> bits/selection';
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
  $('stage').hidden = next === 'done';
  // The results view carries all the numbers; the peripheral chrome goes.
  $('topbar').hidden = next === 'done';
  // Settings only reachable from practice; never mid-run.
  if (next !== 'practice' && sheetOpen) closeSheet();
  // The score screen is a screenful of numbers: drop the soft keyboard so
  // there is room for them (the arm button brings it back).
  if (next === 'done' || next === 'error') blurKbd();
  if (next === 'practice') {
    modeBanner.textContent = 'practice';
    modeBanner.className = 'mode-practice';
    renderPracticeHelp();
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    modeHelp.innerHTML =
      '<span class="act armed-note">first keypress starts the 60 s clock</span>' +
      '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</button>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

// ---- rendering: pinned cursor, text flows leftward into it (spec §2.3) ----

function buildStream(seq) {
  streamEl.textContent = '';
  spans = new Array(seq.length); // letter spans only, indexed by seq position
  const frag = document.createDocumentFragment();
  for (let i = 0; i < seq.length; i++) {
    if (CHUNK && i > 0 && i % CHUNK === 0) {
      const sep = document.createElement('span');
      sep.className = 'ch sep';
      sep.textContent = ' '; // display-only separator, never a target
      frag.appendChild(sep);
    }
    const s = document.createElement('span');
    // Repeats must appear (i.i.d.); mark them subtly instead (spec §7).
    // Beyond the lookahead window, spans start masked ('far').
    s.className = baseClassFor(seq, i) + (i > CONFIG.lookahead ? ' far' : '');
    s.textContent = seq[i];
    spans[i] = s;
    frag.appendChild(s);
  }
  streamEl.appendChild(frag);
  spans[0].classList.add('cur');
  measure();
  moveStream();
}

function measure() {
  // Layout read outside the keydown path only. The advance width is
  // fractional — offsetLeft rounds to integers and the error accumulates
  // into visible caret drift over a run — so measure with float rects
  // across many spans and divide by advance units (letters + separators).
  const k = Math.min(spans.length - 1, 200);
  const units = k + seps(k);
  charW = k > 0
    ? (spans[k].getBoundingClientRect().left - spans[0].getBoundingClientRect().left) / units
    : 0;
}

function moveStream() {
  const offsetUnits = run.pos + seps(run.pos);
  streamEl.style.transform =
    'translateY(-50%) translateX(' + -offsetUnits * charW + 'px)';
}

function baseClassFor(seq, i) {
  return 'ch' + (i > 0 && seq[i] === seq[i - 1] ? ' rpt' : '');
}

function baseClass(i) {
  return baseClassFor(run.seq, i);
}

window.addEventListener('resize', () => {
  if (spans.length && !$('stage').hidden) { // hidden stage measures as zero
    measure();
    moveStream();
  }
});

// ---- selection handling (spec §2.4 advance-always + backspace) ----

function applySelection(key, ts) {
  if (!run.started) {
    // Timer starts on the first keypress, not page load (spec §2.5).
    run.started = true;
    run.t0 = ts;
    if (!run.scored) {
      // Practice goes live: green chip, a little attention.
      modeBanner.className = 'mode-practice-live';
    }
    if (run.scored) {
      setState('scored');
      // End exactly duration after the first scored keypress; boundary math
      // runs on event.timeStamp (same clock origin as performance.now).
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }
  const t = ts - run.t0;
  const posAtPress = run.pos;
  let verdict, expected;

  if (key === 'Backspace') {
    if (run.pos > 0) {
      const wasErr = run.errs[run.pos - 1];
      verdict = wasErr; // correct iff it deletes an uncorrected error
      expected = run.seq[run.pos - 1];
      spans[run.pos].classList.remove('cur');
      run.pos--;
      run.errs.pop();
      spans[run.pos].className = baseClass(run.pos) + ' cur';
      run.shownAt[run.pos] = t; // re-entered fixation
      const mask = run.pos + CONFIG.lookahead + 1; // window shrank on the right
      if (mask < spans.length) spans[mask].classList.add('far');
    } else {
      verdict = false; // nothing behind the cursor to delete
      expected = '';
    }
  } else {
    expected = run.seq[run.pos];
    verdict = key === expected;
    const s = spans[run.pos];
    s.classList.remove('cur');
    s.classList.add(verdict ? 'ok' : 'err');
    run.errs.push(!verdict);
    run.pos++;
    if (run.pos < spans.length) {
      spans[run.pos].classList.add('cur');
      run.shownAt[run.pos] = t;
    }
    const reveal = run.pos + CONFIG.lookahead; // window grew on the right
    if (reveal < spans.length) spans[reveal].classList.remove('far');
  }

  if (!verdict) errorBuzz();

  if (verdict) run.sc++;
  else run.si++;

  run.keylog.push({
    i: run.keylog.length,
    key,
    expected,
    verdict,
    t_shown_ms: run.shownAt[posAtPress] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
  });

  moveStream();

  if (run.pos >= run.seq.length) {
    // Sequence exhausted (practice marathon) — new bout.
    if (!run.scored) practiceReset();
  }
}

// One selection, whatever produced it — a physical keydown or a soft
// keyboard's input event. Both paths land here so both obey the same rules:
// anything outside the N-selection set is ignored, and the run boundary is
// judged on the event's own timestamp.
function offerSelection(key, ts) {
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  if (!run) return;
  if (key === 'Backspace') {
    if (!CONFIG.backspace) return;
  } else if (!ALPHA.has(key)) {
    return;
  }
  // Past the 60.000 s boundary: pressed-late keys are ignored; the timeStamp
  // check means a key pressed before the boundary but processed after it
  // still counts (spec §2.5).
  if (run.scored && run.started && ts - run.t0 >= DURATION_MS) return;
  clearEscPending(); // typing again withdraws a pending Esc
  applySelection(key, ts);
}

// ---- keyboard (spec §7 implementation pitfalls) ----

document.addEventListener('keydown', (e) => {
  // Soft keyboard: the phantom field owns letters and backspace — they arrive
  // as `input` events, because a soft key's keydown carries no usable key
  // (Android reports keyCode 229 for every one of them). Return still arms,
  // which is what a phone keyboard's go key should do.
  if (e.target === kbdEl) {
    // The one thing this keydown is still good for: a held key autorepeats
    // into the field, and autorepeat is not a selection on either path.
    kbdRepeat = e.repeat;
    if (e.key === 'Enter' && (state === 'practice' || state === 'done' || state === 'error')) {
      e.preventDefault();
      armScoredRun();
    }
    return;
  }
  // IME composition breaks one-keydown-one-selection (spec §7).
  if (e.isComposing || e.keyCode === 229) {
    imeActive = true;
    imeWarning.hidden = false;
    return;
  }
  updateCapsWarning(e);

  // Leave browser shortcuts (Cmd/Ctrl/Alt combos) alone.
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // While the settings sheet is open its controls own Enter/Esc/arrows —
  // but a letter or Backspace means "back to playing": close the sheet and
  // let the key fall through as a selection.
  if (sheetOpen) {
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key === 'Enter') { e.preventDefault(); closeSheet(); return; } // don't click a focused control
    const playKey = e.key === 'Backspace' ||
      (e.key.length === 1 && ALPHA.has(e.key.toLowerCase()));
    if (!playKey) return; // sliders/buttons keep arrows, tab, space
    closeSheet();
    // fall through: this keystroke is a selection
  }

  // Overlay states: one-keypress restart affordances (spec §7).
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
    if (state === 'practice') practiceReset();
    else if (state === 'armed') toPractice(); // disarm; clock never started
    else if (state === 'scored') {
      // Ending a live scored run takes Esc twice — one stray Esc must not
      // burn a run.
      if (escPendingTimer) abortScoredRun('aborted');
      else armEscPending();
    }
    return;
  }

  const isBackspace = e.key === 'Backspace';
  let ch = null;
  if (!isBackspace) {
    if (e.key.length !== 1) return; // bare modifiers, F-keys, arrows: not selections
    // Match event.key (character produced), case-folded — non-QWERTY
    // layouts and Caps Lock must just work (spec §7).
    ch = e.key.toLowerCase();
  }

  // Swallow anything that could steal keys mid-run (quick-find, backspace
  // navigation) whether or not it's a selection.
  e.preventDefault();

  if (e.repeat) return; // autorepeat is not a selection

  offerSelection(isBackspace ? 'Backspace' : ch, e.timeStamp);
});

document.addEventListener('keyup', (e) => {
  updateCapsWarning(e);
  if (!run || !run.started) return;
  const key = e.key === 'Backspace' ? 'Backspace' : e.key.toLowerCase();
  // Best-effort keydown/keyup pairing; jitter feeds §6 bot heuristics.
  for (let i = run.keylog.length - 1; i >= 0; i--) {
    const k = run.keylog[i];
    if (k.key === key && k.t_keyup_ms === null) {
      k.t_keyup_ms = e.timeStamp - run.t0;
      break;
    }
    if (run.keylog.length - i > 8) break; // bounded scan
  }
});

// A soft keyboard composes as a matter of course (predictive text), so a
// composition in the phantom field is not the desktop-IME problem the warning
// is about — the input path below reads it correctly either way.
document.addEventListener('compositionstart', (e) => {
  if (e.target === kbdEl) return;
  imeActive = true;
  imeWarning.hidden = false;
});
document.addEventListener('compositionend', (e) => {
  if (e.target === kbdEl) return;
  imeActive = false;
});

// ---- soft keyboard (spec §4.3.1): playing this on a phone ----
//
// Nothing on the page used to be focusable, so a phone showed no keyboard and
// the environment was unplayable there. #kbd-catcher is a transparent input
// stretched over the play field: tapping the stream focuses it, and focusing
// it is what raises the keyboard. While it has focus, selections come from
// its `input` events rather than from keydown — a soft key's keydown carries
// no usable `key` (Android sends keyCode 229 / "Unidentified" for all of
// them), whereas the field's value is exact on every platform.

// Does this device have a touchscreen at all? Only that question is settled
// here; on anything else the field never takes focus and the keydown path is
// untouched, so a touch laptop keeps its physical keyboard until it is tapped.
const TOUCH = (navigator.maxTouchPoints || 0) > 0 ||
  matchMedia('(any-pointer: coarse)').matches;

// The field always carries filler (non-breaking spaces — an ordinary space
// invites the double-space-to-period substitution), because a soft keyboard's
// backspace on an empty field fires no event at all, and backspace is one of
// the N selections (spec §2.4), so it has to be reportable.
const KBD_PAD = ' '.repeat(24);
let kbdPrev = '';
let kbdOpen = false;
let kbdRepeat = false; // set by the keydown that precedes an input event

function resetKbd() {
  kbdEl.value = KBD_PAD;
  kbdPrev = KBD_PAD;
  pinCaret(KBD_PAD.length);
}

// A tap sets the caret from where the finger landed, which is somewhere in
// the middle of the filler — and an insertion there reads as delete-and-
// retype, scoring a burst of backspaces per keystroke. The field is invisible
// and its contents mean nothing, so no caret position is worth honouring:
// pin it to the end whenever anything moves it.
function pinCaret(end) {
  if (end === undefined) {
    if (document.activeElement !== kbdEl) return;
    end = kbdEl.value.length;
    if (kbdEl.selectionStart === end && kbdEl.selectionEnd === end) return;
  }
  try { kbdEl.setSelectionRange(end, end); } catch { /* not selectable yet */ }
}

kbdEl.addEventListener('click', () => pinCaret());
document.addEventListener('selectionchange', () => pinCaret());

function focusKbd() {
  if (!TOUCH) return;
  resetKbd();
  kbdEl.focus({ preventScroll: true });
}

function blurKbd() {
  if (TOUCH && document.activeElement === kbdEl) kbdEl.blur();
}

// Each input event is diffed against the value we last saw: characters gained
// are selections, characters lost are backspaces, in that order. Predictive
// text rewriting the tail therefore scores exactly as the same keystrokes
// typed by hand would, and nothing needs to know which IME produced them.
kbdEl.addEventListener('input', (e) => {
  const v = kbdEl.value;
  if (!kbdRepeat) { // a held key still lands in the field; it just isn't scored
    let i = 0;
    while (i < v.length && i < kbdPrev.length && v[i] === kbdPrev[i]) i++;
    for (let d = kbdPrev.length - i; d > 0; d--) offerSelection('Backspace', e.timeStamp);
    // Case-folded like the keydown path: a soft keyboard capitalizes on its own.
    for (const ch of v.slice(i)) offerSelection(ch.toLowerCase(), e.timeStamp);
  }
  kbdRepeat = false;
  // Keep filler deep in both directions, but re-pad only when it runs low or
  // long — rewriting the value mid-word fights the IME for no reason.
  if (v.length < 8 || v.length > 96) resetKbd();
  else kbdPrev = v;
});

kbdEl.addEventListener('focus', () => { resetKbd(); renderHint(); });
kbdEl.addEventListener('blur', renderHint);

// On a phone the first thing to say is how to get a keyboard; once it's up,
// the rule of the game.
function renderHint() {
  hintEl.textContent = TOUCH && document.activeElement !== kbdEl
    ? 'tap the stream to bring up the keyboard'
    : 'type the letter at the caret · miss → backspace → retype';
}

// Vertical space: the keyboard covers the bottom of the screen and the stream
// must never be under it. The layout viewport does not shrink when it opens
// (iOS never resizes it; Chrome's default is `resizes-visual`), so the covered
// strip is measured off visualViewport and published as --kbd-inset — the play
// field ends there and re-centres the stream in what is left.
const vv = window.visualViewport;

function syncKbdInset() {
  if (!vv) return;
  const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kbd-inset', inset + 'px');
  const open = inset > 120; // a keyboard, not a URL bar collapsing
  if (open !== kbdOpen) {
    kbdOpen = open;
    document.body.classList.toggle('kbd-open', open);
  }
  // Nothing here scrolls; iOS scrolls the layout viewport anyway to reveal a
  // focused field, which would push the header off-screen.
  if (window.scrollY) window.scrollTo(0, 0);
}

if (TOUCH) {
  document.body.classList.add('touch'); // the field starts taking taps
  if (vv) {
    vv.addEventListener('resize', syncKbdInset);
    vv.addEventListener('scroll', syncKbdInset);
  }
}

function updateCapsWarning(e) {
  const caps = e.getModifierState && e.getModifierState('CapsLock');
  capsWarning.hidden = !caps;
  if (caps && run) run.flags.caps_lock = true;
}

// ---- mode transitions ----

async function armScoredRun() {
  if (imeActive) { imeWarning.hidden = false; return; } // refuse to arm mid-composition
  await finishBout();
  try {
    await startRun(true); // scored runs always get fresh seeds (spec §7)
  } catch (err) {
    showError(err);
  }
}

async function toPractice() {
  await finishBout();
  try {
    await startRun(false);
  } catch (err) {
    showError(err);
  }
}

function practiceReset() {
  toPractice();
}

// Submit the current bout's telemetry (if it started) and forget it.
async function finishBout() {
  if (run && run.started && !run.submitted) {
    submitRun(false).catch(() => {}); // fire-and-forget; queued on failure
  }
  run = null;
}

// ---- scored run end (spec §2.5): freeze input, render results ----

function endScoredRun() {
  endTimer = null;
  clearEscPending();
  setState('done');
  renderResults({ waiting: true });
  submitRun(false)
    .then((res) => renderResults({ server: res }))
    .catch(() => renderResults({ clientOnly: true }));
}

// Ending a scored run early (double-Esc or focus loss): the run is marked
// invalid — never silently scored with a gap (spec §7) — and the player
// lands straight back in practice, no dead-end screen.
function abortScoredRun(reason) {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  clearEscPending();
  run.flags[reason === 'aborted' ? 'aborted' : 'focus_lost'] = true;
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
  if (state === 'scored') abortScoredRun('focus');
  else if (state === 'practice') run.flags.focus_lost = true;
}

// ---- scoring (client mirror of server/scoring.go; server is authoritative) ----

// scoreWith computes the formula for run r over t seconds. The caller picks
// t: elapsed (live HUD), exactly duration_s (scored final), or the
// last-key-floored elapsed (practice final — must match the server's choice
// or every practice submit trips the anomaly check).
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

// ---- submit with retry queue (spec §7: never lose a completed run) ----

async function submitRun(invalidated) {
  const r = run;
  if (!r || r.submitted) return null;
  r.submitted = true;
  // t computed once and reused for both client_result and elapsed_ms, so
  // client and server derive bps from identical inputs.
  const elapsed = r.scored ? DURATION_MS : elapsedMsOf(r);
  const tSec = r.scored
    ? CONFIG.duration_s
    : Math.max(elapsed, lastKeyT(r)) / 1000;
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
  } catch { /* storage full: telemetry lost, game unaffected */ }
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
      scheduleFlush(Math.min(delay * 2, 60000)); // backoff
    }
  }, delay);
}

// ---- HUD: exactly 1 Hz so it doesn't shimmer (spec §7) ----

function renderHud() {
  if (state === 'done') return; // frozen at run end
  if (!run || !run.started) {
    hudBps.innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    hudTime.textContent = state === 'armed' ? CONFIG.duration_s + 's' : '';
    hudCounts.textContent = 'N ' + N + ' · Sc 0 · Si 0';
    window.BitrateResults.renderSpark('hud-spark', null, BITS, 0);
    return;
  }
  const elapsed = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD is cumulative over the run (spec §1 rule 3) — it previews the
    // actual score. Display-only floor at 1 s avoids the first-keypress spike.
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    hudBps.innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    hudTime.textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    hudCounts.textContent = 'N ' + (run.n || N) + ' · Sc ' + run.sc + ' · Si ' + run.si;
    window.BitrateResults.renderSpark('hud-spark', run, BITS, elapsed);
    return;
  }
  // Practice: trailing-60 s window + rolling sparkline (shared helpers), so the
  // figure tracks current skill instead of being dragged down by warm-up.
  const tr = window.BitrateResults.trailingBps(run.keylog, BITS, elapsed);
  hudBps.innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  hudTime.textContent = Math.floor(elapsed / 1000) + 's practice';
  hudCounts.textContent = 'N ' + (run.n || N) + ' · Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  window.BitrateResults.renderSpark('hud-spark', run, BITS, elapsed);
}

setInterval(renderHud, 1000); // >= 1x/sec from page load (spec §1 rule 3)

// ---- results view (spec §8): headline + server-computed diagnostics ----

function renderResults(opts) {
  if (state !== 'done') return;
  const cs = scoreWith(run, CONFIG.duration_s);
  const r = opts.server || cs;
  let note = '';
  if (opts.waiting) note = '<div class="res-note">verifying with server…</div>';
  else if (opts.clientOnly) note = '<div class="res-note warn">server unreachable — client score shown; result queued</div>';
  else if (opts.server && opts.server.anomaly) note = '<div class="res-note warn">client/server scoring disagreement logged</div>';

  $('res-hero').innerHTML =
    '<div class="res-title">stream typing (N ' + N + ' · look ' + CONFIG.lookahead +
    (CHUNK ? ' · chunk ' + CHUNK : '') + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + r.bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + r.n + '</b> · Sc <b>' + r.sc + '</b> · Si <b>' + r.si +
    '</b> · accuracy <b>' + (r.sc + r.si > 0 ? ((100 * r.sc) / (r.sc + r.si)).toFixed(1) : '—') + '%</b></div>' +
    note;

  const m = opts.server && opts.server.metrics;
  const R = window.BitrateResults;
  $('res-tiles').innerHTML = m ? R.tilesHTML(m, { corrections: true }) : '';
  $('chart-pace').innerHTML = m && m.selections > 1 ? R.paceChartSVG(m, BITS) : '';
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

// ---- audio feedback (config.audio_feedback): WebAudio only, no files ----

let audioCtx = null;

// Warmed on the first interaction, not on the first miss: iOS hands out every
// context suspended and only a user gesture may start it, so a buzz that has to
// build its own context arrives late or not at all on a phone/tablet.
function ensureAudio() {
  // CONFIG lands with the first fetch; a tap before that just skips the warm-up.
  if (!CONFIG || !CONFIG.audio_feedback) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio is never load-bearing */ }
}
// Self-removing rather than {once}: an interaction before CONFIG lands (or with
// the buzz switched off) must not burn the one chance to warm up.
function warmAudioOnce() {
  ensureAudio();
  if (!audioCtx) return;
  document.removeEventListener('pointerdown', warmAudioOnce, true);
  document.removeEventListener('keydown', warmAudioOnce, true);
}
document.addEventListener('pointerdown', warmAudioOnce, true);
document.addEventListener('keydown', warmAudioOnce, true);

function errorBuzz() {
  if (!CONFIG.audio_feedback) return;
  ensureAudio();
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    // 220, not the 110 this started at: a phone/tablet speaker is physically
    // too small to radiate a 110 Hz fundamental, so the buzz was inaudible on
    // an iPad. Kept in lockstep with pixel-lens/drum-pad (2026-07-26).
    o.frequency.value = 220;
    g.gain.setValueAtTime(0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + 0.1);
  } catch { /* audio is never load-bearing */ }
}

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

function openSheet() {
  if (state !== 'practice') return;
  blurKbd(); // the sheet comes up from the same edge the keyboard does
  sheetOpen = true;
  syncSheet();
  sheetEl.classList.add('open');
}

function closeSheet() {
  sheetOpen = false;
  sheetEl.classList.remove('open');
  // A focused control would swallow the next Enter/Space press.
  if (document.activeElement && sheetEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

function syncSheet() {
  segSync('seg-alphabet', CONFIG.alphabet);
  segSync('seg-chunk', CONFIG.chunk_size ? String(CONFIG.chunk_size) : '');
  segSync('seg-audio', CONFIG.audio_feedback ? '1' : '');
  $('set-lookahead').value = CONFIG.lookahead;
  $('lookahead-val').textContent = CONFIG.lookahead;
  $('sheet-info').textContent =
    'N=' + N + ' · ' + BITS.toFixed(2) + ' bits/selection' +
    (lastConfigHash ? ' · config ' + lastConfigHash.slice(0, 8) : '') +
    ' · changes restart the practice bout';
  renderCfg();
}

function segSync(id, val) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === val);
  }
}

// Live reconfiguration (spec §9 step 5): apply -> persist -> fresh practice
// bout under the new config. The server content-addresses it into the
// variant registry on run/start.
function applyChange(mutate) {
  const cfg = { ...CONFIG };
  mutate(cfg);
  setConfig(cfg);
  saveSettings();
  syncSheet();
  toPractice();
}

function segWire(id, mutate) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    applyChange((c) => mutate(c, b.dataset.v));
  });
}

segWire('seg-alphabet', (c, v) => { c.alphabet = v; });
segWire('seg-chunk', (c, v) => { c.chunk_size = v ? Number(v) : null; });
segWire('seg-audio', (c, v) => { c.audio_feedback = !!v; });
$('set-lookahead').addEventListener('input', (e) => {
  $('lookahead-val').textContent = e.target.value;
});
$('set-lookahead').addEventListener('change', (e) => {
  e.target.blur();
  applyChange((c) => { c.lookahead = Number(e.target.value); });
});
// ---- corner actions (click = same as the hotkey) ----

// Corner strip in play + the score screen's footer: same buttons, one binder
// (shared with every other environment — see common/results.js).
//
// Tapping a button drops the soft keyboard. Arm and reseed mean "keep
// playing", so they take it straight back — inside the tap, because iOS only
// opens a keyboard from a real gesture and the run/start fetch these actions
// await is long since past that. Settings wants the screen instead.
BitrateResults.wireActs(
  { arm: armScoredRun, seed: toPractice, settings: toggleSheet },
  (e) => {
    if (!TOUCH || !e || !e.target.closest) return;
    const act = e.target.closest('[data-act]');
    if (!act || e.detail === 0) return; // keyboard activation: not a tap
    if (act.dataset.act === 'settings') blurKbd();
    else focusKbd();
  },
);

// ---- boot: straight into practice; flush any stranded submissions ----

// Leaderboard relaunch (spec §4.4): ?cfg=<config_hash> boots this exact
// variant for the session (not persisted — your saved settings stay yours).
async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== CONFIG.environment) return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    const cfg = { ...DEFAULTS };
    for (const k of TUNABLE) if (k in c) cfg[k] = c[k];
    setConfig(cfg);
  } catch { /* ship build or unknown hash: defaults */ }
}

// The header is an in-flow band whose height moves with content and
// viewport; publish it so the play area always starts below it.
window.BitrateResults.trackHeaderHeight();
loadConfig();
renderHint();    // on a phone the hint is how you get a keyboard at all
syncKbdInset();  // 0 until one opens, but the var has to exist
scheduleFlush(1500);
applyCfgParam().then(() => startRun(false)).catch(showError);
