'use strict';

/* pixel-lens / drum-pad environments (spec §5 backlog).
 *
 * A target lights up somewhere on a huge grid and the player goes to it. One
 * implementation, two games, chosen by the page (window.BITRATE_INPUT):
 * pixel lens is the mouse game, with a fisheye loupe riding the cursor so
 * landing inside a small cell is comfortable; drum pad is the touch game,
 * with finger-sized cells and no loupe. Acquisition is serial and distance
 * costs time, so a big alphabet doesn't buy what it does in typing.
 *
 * Honest N (spec §7): the alphabet is the grid of ~1 cm hitbox cells, not
 * raw pixels — any click inside a cell selects it, so cells are the
 * distinguishable selections. N is recomputed from the viewport; resizing
 * mid-run changes the alphabet, which invalidates the run.
 */

// ---- config ----

const PX_PER_MM = 96 / 25.4; // CSS reference pixel
const ZOOM_TARGET_MM = 25;   // apparent cell size at the lens center (~2.5 cm)
let loupeR = 110;            // lens radius (px, settings-driven)
// Piecewise rings approximating the radial falloff; more rings at higher
// magnification so the steps stay invisible.
function lensRings() { return Math.round(16 + lensMag * 5); }
const ARROW_DIST = 320;      // beyond this, show the direction affordance
// Per-game settings: the two share an implementation, not a cell menu.
const SETTINGS_KEY_BY_MODE = { mouse: 'bitrate_pixel_settings_v1', touch: 'bitrate_drum_settings_v1' };
const DEFAULT_CELL_MM = 5;

// This file backs two games — same grid, same honest-N accounting, different
// hands — and the page decides which by setting window.BITRATE_INPUT:
//   pixel lens (mouse) — fine cells + a hover-driven fisheye loupe.
//   drum pad  (touch)  — finger-sized cells, no loupe: a touchscreen has no
//                        hover, so you tap the target directly.
// The modality is fixed by which page you opened rather than being a setting,
// so each game has one identity on the leaderboard.
const INPUT_MODES = { mouse: 'pixel-lens', touch: 'drum-pad' };
const CELL_OPTS = { mouse: [3, 5, 7.5, 10], touch: [12, 16, 20, 25] };
// Per-mode starting points, not limits — both knobs are in the settings sheet.
// One look-ahead dot on touch, because a tap has no hover to plan under:
// seeing the next target is what keeps the thumb moving.
const DEFAULT_PREVIEW = { mouse: 0, touch: 1 };

// Recommended tile size, taken from the leaderboard rather than from ergonomic
// first principles. The counterintuitive part is that the tablet wants *bigger*
// tiles than the phone — scored 60 s runs, best per size:
//
//   tablet   20 mm -> 16.26, 15.09 bps    12 mm -> 14.98, 14.46
//   phone    12 mm -> 15.41, 14.16        20 mm -> 11.36
//
// Fitts explains it. On a tablet you play with two index fingers and a freely
// moving arm, so travel time dominates and fewer, larger tiles win. On a phone
// one thumb barely travels, so travel is nearly free and the extra bits per tap
// from a denser grid are profit. 16 mm — the previous default, picked from
// fingertip width — is the worst tested size on a tablet and was never tested
// on a phone at all.
const RECOMMENDED_CELL = { mouse: 5, touch: { phone: 12, tablet: 20 } };

// Phone or tablet off the short edge of the screen rather than the user agent:
// what sets the best tile size is how far the hand has to reach, which a UA
// string doesn't report (and iPads lie about it anyway). The two device classes
// in the data sit at 414 and 1032 CSS px short-edge, so this threshold is
// nowhere near a real boundary.
function deviceClass() {
  return Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet';
}

function recommendedCell(mode) {
  const r = RECOMMENDED_CELL[mode];
  return typeof r === 'number' ? r : r[deviceClass()];
}
const CELL_MIN = 2, CELL_MAX = 30;
const MAX_PREVIEW = 4;

const inputMode = INPUT_MODES[window.BITRATE_INPUT] ? window.BITRATE_INPUT : 'mouse';
const ENV_NAME = INPUT_MODES[inputMode];
const GAME_LABEL = inputMode === 'touch' ? 'drum pad' : 'pixel lens';
let previewDepth = 0;      // look-ahead: upcoming targets shown as dimmer dots
let cellMm = DEFAULT_CELL_MM;
let zoomMode = 'auto'; // 'auto' (25mm apparent) or a fixed multiplier
let audioOn = true;    // short buzz on a miss
let sizeChosen = false; // has this player ever picked a tile size here?

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let grid = { cols: 0, rows: 0, cell: 19, w: 0, h: 0 };
let lensMag = 5; // center magnification; falls off to 1 at the rim

// ---- which hands is this device actually offering? ----
// Two different questions, two different answers, and only one of them is
// reliable:
//
//   capability — does this device have a touchscreen at all? `any-pointer:
//     coarse` / maxTouchPoints. True on a touch laptop, which is the case
//     that rules out anything cruder. Good enough to warn on, never to judge:
//     a touch laptop can still be played entirely with the trackpad.
//   what was actually used — PointerEvent.pointerType on the selection
//     itself: 'touch' | 'pen' | 'mouse'. Per event, from the browser, for the
//     hand that made *this* selection. That is the authority, and it's why
//     drum pad gates on selections rather than on device sniffing.

function hasTouchscreen() {
  try {
    return (navigator.maxTouchPoints || 0) > 0 || matchMedia('(any-pointer: coarse)').matches;
  } catch { return false; }
}

// A device with only a coarse pointer has no hover, so pixel lens's 5 mm cells
// and fisheye loupe are unplayable on it — that player wants drum pad.
function wrongDeviceForMode() {
  try {
    const coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
    return inputMode === 'mouse' && coarse;
  } catch { return false; }
}

// Drum pad is the touch game: its leaderboard is only worth reading if the
// runs on it were tapped. A pointerType of 'pen' counts as touch — a stylus on
// a tablet is direct pointing at the same cell, not cursor indirection.
function isTouchLike(pointerType) { return pointerType === 'touch' || pointerType === 'pen'; }
function touchRequired() { return inputMode === 'touch'; }

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY_BY_MODE[inputMode]) || '{}'); } catch { /* defaults */ }
  if (typeof s.cell_mm === 'number' && s.cell_mm >= CELL_MIN && s.cell_mm <= CELL_MAX) {
    cellMm = s.cell_mm;
    sizeChosen = true;
  }
  if (s.zoom === 'auto' || (typeof s.zoom === 'number' && s.zoom >= 2 && s.zoom <= 8)) zoomMode = s.zoom;
  if (typeof s.lens_r === 'number' && s.lens_r >= 60 && s.lens_r <= 180) loupeR = s.lens_r;
  if (typeof s.audio === 'boolean') audioOn = s.audio;
  previewDepth = typeof s.preview === 'number' && s.preview >= 0 && s.preview <= MAX_PREVIEW
    ? Math.round(s.preview) : DEFAULT_PREVIEW[inputMode];
  // Snap the cell size to a valid option for the mode (options differ by mode).
  if (!CELL_OPTS[inputMode].includes(cellMm)) cellMm = recommendedCell(inputMode);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY_BY_MODE[inputMode], JSON.stringify({
      cell_mm: cellMm, zoom: zoomMode, lens_r: loupeR, preview: previewDepth, audio: audioOn,
    }));
  } catch { /* fine */ }
}

function applyLoupeSize() {
  const d = loupeR * 2;
  loupeEl.style.width = d + 'px';
  loupeEl.style.height = d + 'px';
  loupeEl.style.margin = -loupeR + 'px 0 0 ' + -loupeR + 'px';
  loupeArrow.style.width = d + 'px';
  loupeArrow.style.marginLeft = -loupeR + 'px';
}

// ---- dom ----

const $ = (id) => document.getElementById(id);
const fieldEl = $('field');
const targetEl = $('target');
const loupeEl = $('loupe');
const loupeArrow = $('loupe-arrow');
const loupeCanvas = $('loupe-canvas');
const modeBanner = $('mode-banner');
const modeHelp = $('mode-help');
const overlay = $('overlay');
const card = $('card');
const resultsEl = $('results');

const lctx = loupeCanvas.getContext('2d');

// ---- device identity (spec §4.4) ----

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
let mouse = { x: -1000, y: -1000, inField: false };

// ---- config from viewport ----

// How many cells of a given size fit in the field, and what one selection is
// therefore worth. buildConfig() and the size picker both go through this, so
// the number the picker promises is the number the game delivers.
function gridMetrics(mm) {
  const loupeOn = inputMode === 'mouse';
  const cell = Math.max(6, Math.round(mm * PX_PER_MM));
  const r = fieldEl.getBoundingClientRect();
  // Inset the grid from the field edges. Mouse mode keeps a lens-radius margin
  // so the loupe is never buried more than ~40% at a boundary target. Touch has
  // no loupe at all, so that margin is dead space: a thin edge gap is all a
  // finger needs, and every pixel it gives back becomes more cells — more N.
  const pad = loupeOn ? Math.round(loupeR * 0.6) : 4;
  const cols = Math.max(2, Math.floor((r.width - 2 * pad) / cell));
  const rows = Math.max(2, Math.floor((r.height - 2 * pad) / cell));
  const n = cols * rows; // no correction key in this environment
  return { cell, pad, cols, rows, n, bits: Math.log2(n - 1), w: r.width, h: r.height };
}

function buildConfig() {
  const loupeOn = inputMode === 'mouse';
  // Drives the touch-mode space reclaim in CSS; set before measuring the field.
  document.body.classList.toggle('touch', !loupeOn);
  const m = gridMetrics(cellMm);
  const { cell, cols, rows } = m;
  const ox = Math.round((m.w - cols * cell) / 2);
  const oy = Math.round((m.h - rows * cell) / 2);
  grid = { cols, rows, cell, ox, oy, w: m.w, h: m.h };
  const ga = $('gridarea');
  ga.style.left = ox + 'px';
  ga.style.top = oy + 'px';
  ga.style.width = (cols * cell) + 'px';
  ga.style.height = (rows * cell) + 'px';
  ga.style.backgroundSize = cell + 'px ' + cell + 'px';
  applyLoupeSize();
  // Touch has no cursor to hide; mouse hides it so the loupe *is* the cursor.
  fieldEl.style.cursor = loupeOn ? 'none' : 'auto';
  if (!loupeOn) loupeEl.hidden = true;
  // Center magnification: auto targets ~ZOOM_TARGET_MM apparent size,
  // tapering to 1x at the rim (see drawLoupe); or a fixed multiplier.
  lensMag = zoomMode === 'auto'
    ? Math.min(8, Math.max(2, ZOOM_TARGET_MM / cellMm))
    : zoomMode;
  N = m.n;
  BITS = m.bits;
  CONFIG = {
    environment: ENV_NAME,
    alphabet_size: N,
    grid_cols: cols,
    grid_rows: rows,
    cell_px: cell,
    cell_mm: cellMm,
    input: inputMode,
    loupe: loupeOn ? 'on' : 'off',
    preview: previewDepth,
    audio_feedback: audioOn,
    loupe_r_px: loupeOn ? loupeR : 0,
    loupe_mag: loupeOn ? Math.round(lensMag * 100) / 100 : 0,
    loupe_zoom_mode: loupeOn ? String(zoomMode) : 'off',
    grid_pad_px: m.pad,
    viewport_w: Math.round(window.innerWidth),
    viewport_h: Math.round(window.innerHeight),
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
  renderCfg();
  refreshSizePicker(); // keep the picker's promised numbers true
}

// The middle of the header: what this variant is set to, with the settings
// button under it — the label and the way to change it are one object. The
// grid, N and bits/selection are the honest accounting (spec §7, §5
// pixel-lens: cells are the distinguishable selections, not raw pixels).
function renderCfg() {
  $('res-info').innerHTML =
    '<b>' + CONFIG.viewport_w + '×' + CONFIG.viewport_h + '</b> px · ' +
    '<b>' + grid.cols + '×' + grid.rows + '</b> cells of ' + cellMm + ' mm' +
    (inputMode === 'mouse' ? ' (~' + Math.round(cellMm * lensMag) + ' mm in lens)' : ' · touch') +
    ' · N=<b>' + N + '</b> · <b>' + BITS.toFixed(2) + '</b> bits/selection' +
    (previewDepth ? ' · look-ahead <b>' + previewDepth + '</b>' : '');
}

// ---- run lifecycle ----

async function startRun(scored) {
  state = 'loading';
  // Snapshot the alphabet this run is created with. N/BITS are viewport-derived
  // globals that a mid-run resize (iPad Safari collapsing its toolbar, or an
  // orientation change) can move under us — but the run is scored by the server
  // against the config we send *now*, so the client must score against the same
  // fixed N, not whatever the global has drifted to by submit time. (Sc/Si are
  // already resize-safe: they compare against run.seq, which is fixed.)
  const startN = N, startBits = BITS;
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
    n: startN,
    bits: startBits,
    scored,
    started: false,
    t0: 0,
    pos: 0,
    sc: 0,
    si: 0,
    keylog: [],
    shownAt: [0],
    flags: {},
    submitted: false,
  };
  setState(scored ? 'armed' : 'practice');
  placeTarget();
  renderHud();
}

// What the settings sheet is currently set to, short enough for the corner.
function configLabel() {
  return grid.cols + '×' + grid.rows + ' cells · ' + cellMm + ' mm' +
    (previewDepth ? ' · look ' + previewDepth : '');
}

// ---- the arm affordance ----
// Practice is unlimited and its HUD shows a trailing-60 s bit rate, so practice
// *looks* like the game. The failure mode this guards against is a first-session
// player who never arms and therefore never produces a score at all — worse, who
// believes the practice number was their score. So the arm control is the
// primary action, not one of two equal siblings, and it escalates:
//
//   tier 1, always in practice — accent outline plus a slow pulse.
//   tier 2, after ARM_PROMPT_MS of practice — filled, plus one suggestion card.
//
// Both tiers are colour-only. The header band must never change height mid-run
// (spec §4.3.1): a reflow there moves #field, which changes the grid, which
// changes N. Nothing here animates padding, font-size, or border-width.
const ARM_PROMPT_MS = 60000;
let practiceMs = 0;         // accumulated *practice* time, not wall clock
let armPromptShown = false; // once per session — a nag is worse than a hint

// The practice corner: the two run controls. What the game is set to, and
// the button that changes it, live in the header's middle zone.
function renderPracticeHelp() {
  modeHelp.innerHTML =
    '<button type="button" class="act click arm-cta' + (armPromptShown ? ' arm-urgent' : '') +
    '" data-act="arm"><kbd>Enter</kbd>arm scored run</button>' +
    '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>new practice seed</button>';
}

// Counts seconds of practice actually played: `run.started` gates on the first
// selection, so staring at the board — or walking away — never accrues time and
// never earns a scolding.
function tickArmPrompt() {
  if (armPromptShown || state !== 'practice' || !run || !run.started) return;
  practiceMs += 1000;
  if (practiceMs >= ARM_PROMPT_MS) showArmPrompt();
}

function closeArmPrompt() {
  const el = $('arm-prompt');
  if (el) el.remove();
}

// A suggestion, shown once. The primary button arms — an explicit click is
// explicit consent, and arming still doesn't start the clock (the first tap
// does), so there is no way for this card to accidentally burn a scored run.
function showArmPrompt() {
  if (armPromptShown || $('arm-prompt')) return;
  armPromptShown = true;
  renderPracticeHelp(); // escalate the header button to tier 2

  const wrap = document.createElement('div');
  wrap.id = 'arm-prompt';
  wrap.innerHTML =
    '<div class="ap-card">' +
    '<div class="ap-title">practice doesn\'t score</div>' +
    '<div class="ap-body">You\'ve had a minute on the board. Nothing so far counts — ' +
    'the bit rate up top is just your recent practice pace. ' +
    'A <b>scored run</b> is a single 60-second attempt, and it starts on your first ' +
    (inputMode === 'touch' ? 'tap' : 'click') + ' after you arm it.</div>' +
    '<div class="ap-acts">' +
    '<button type="button" class="ap-go" disabled>arm the 60 s run</button>' +
    '<button type="button" class="ap-stay" disabled>keep practicing</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(wrap);

  // A finger already travelling toward a tile must not dismiss a card it never
  // saw — and must not fall through to the grid either. The backdrop swallows
  // the tap (it is opaque to pointers from the start) while the buttons stay
  // disabled just long enough for that in-flight tap to land harmlessly.
  setTimeout(() => {
    for (const b of wrap.querySelectorAll('button')) b.disabled = false;
  }, 400);

  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.ap-go')) { closeArmPrompt(); armScoredRun().catch(showError); }
    else if (e.target.closest('.ap-stay')) { closeArmPrompt(); }
  });
}

function setState(next) {
  state = next;
  document.body.classList.toggle('armed', next === 'armed');
  overlay.hidden = next !== 'error';
  resultsEl.hidden = next !== 'done';
  fieldEl.hidden = next === 'done';
  $('topbar').hidden = next === 'done';
  if (next !== 'practice') $('hud-spark').innerHTML = '';
  if (next === 'done') { hidePreviews(); targetEl.hidden = true; }
  if (next !== 'practice' && sheetOpen) closeSheet();
  // The suggestion card belongs to practice and nothing else: leaving practice
  // by any route (armed, scored, results, error) takes it with you.
  if (next !== 'practice') closeArmPrompt();
  if (next === 'practice') {
    modeBanner.textContent = 'practice';
    modeBanner.className = 'mode-practice';
    renderPracticeHelp();
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    // Two lengths of the same cue: the long one on a desktop band, the short
    // one on a phone, where the long one wraps to a second row — and a second
    // row here would push the field down and take a row of cells (and so N)
    // with it, at the exact moment a scored run is about to start. The 60 s is
    // still on screen either way; the HUD clock reads it out in armed state.
    modeHelp.innerHTML =
      '<span class="act armed-note">' +
      '<span class="wide-only">first ' + (inputMode === 'touch' ? 'tap' : 'click') +
      ' starts the 60 s clock</span>' +
      '<span class="narrow-only">' + (inputMode === 'touch' ? 'tap' : 'click') +
      ' to start</span></span>' +
      '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</button>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

// ---- target ----

function cellCenter(idx) {
  return {
    x: grid.ox + (idx % grid.cols + 0.5) * grid.cell,
    y: grid.oy + (Math.floor(idx / grid.cols) + 0.5) * grid.cell,
  };
}

function placeTarget() {
  const c = cellCenter(run.seq[run.pos]);
  targetEl.style.left = c.x + 'px';
  targetEl.style.top = c.y + 'px';
  targetEl.style.setProperty('--cell', grid.cell + 'px'); // the fill spans one cell
  targetEl.hidden = false;
  // Restart the bull's-eye cue animation.
  targetEl.classList.remove('cue');
  void targetEl.offsetWidth;
  targetEl.classList.add('cue');
  placePreviews();
}

// ---- look-ahead previews: dimmer, static dots for the next targets ----
// Purely visual — never interactive. A tap is always judged against the live
// target (spec §2.1 ground truth); tapping a preview just resolves the current
// target as an incorrect selection under advance-always. This is the pointing
// analog of the visible upcoming characters in stream-typing: it lets the
// player pre-plan the next saccade + reach, so it speeds the task honestly
// without leaking bits (targets stay i.i.d. uniform over N).

const previewLayer = $('previews');
let previewEls = [];

function ensurePreviewPool(n) {
  while (previewEls.length < n) {
    const el = document.createElement('div');
    el.className = 'preview-dot';
    el.hidden = true;
    el.innerHTML = '<div class="pcue"></div><div class="pring2"></div><div class="pring"></div><div class="pdot"></div>';
    previewLayer.appendChild(el);
    previewEls.push(el);
  }
}

function placePreviews() {
  for (let k = 0; k < previewEls.length; k++) {
    const el = previewEls[k];
    const seqIdx = run ? run.pos + 1 + k : -1;
    if (!run || k >= previewDepth || seqIdx >= run.seq.length || state === 'done') {
      el.hidden = true;
      continue;
    }
    const c = cellCenter(run.seq[seqIdx]);
    el.style.left = c.x + 'px';
    el.style.top = c.y + 'px';
    // Nearer previews a touch stronger; all dimmer than the solid live cell.
    el.style.opacity = String(Math.max(0.28, 0.72 - k * 0.18));
    el.hidden = false;
    // The next target gets one collapsing ring — the live cell's bull's-eye cue
    // at a whisper: it says "you're going here after this" without competing
    // with the cue that says "go here now". Only k === 0; the rest stay static.
    if (k === 0) {
      el.classList.remove('cue');
      void el.offsetWidth; // reflow so the animation restarts on each advance
      el.classList.add('cue');
    } else {
      el.classList.remove('cue');
    }
  }
}

function hidePreviews() {
  for (const el of previewEls) el.hidden = true;
}

// ---- selection: mousedown is the earliest pointer event ----

fieldEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!e.isPrimary) return;                                // ignore extra fingers
  if (e.pointerType === 'mouse' && e.button !== 0) return; // left button only
  if (sheetOpen) closeSheet(); // a field click means "back to playing"
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  if (run.scored && run.started && e.timeStamp - run.t0 >= DURATION_MS) return;

  clearEscPending();
  if (!run.started) {
    // Timer starts on the first selection, not page load (spec §2.5).
    run.started = true;
    run.t0 = e.timeStamp;
    if (!run.scored) {
      modeBanner.className = 'mode-practice-live';
    } else {
      setState('scored');
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }
  // Drum pad's whole claim is that a finger did this. A mouse click landing in
  // a scored run invalidates it, the same as losing the window — the run can't
  // stand, and silently scoring it would put a cursor run on a touch board.
  if (touchRequired() && !isTouchLike(e.pointerType)) {
    if (run.scored && run.started) { abortScoredRun('mouse_input'); return; }
    if (state === 'armed') { toPractice(); }
    run.mouseSeen = true;
    showNotice('drum pad is the touch game — that was a <b>' + e.pointerType +
      '</b>. tap the grid to play; scored runs need a touchscreen.', 'warn', 5000);
    return;
  }
  if (isTouchLike(e.pointerType)) run.touchSeen = true;

  const t = e.timeStamp - run.t0;
  const r = fieldEl.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.ox) / grid.cell)));
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((y - grid.oy) / grid.cell)));
  const cell = row * grid.cols + col;
  const expected = run.seq[run.pos];
  const verdict = cell === expected;

  if (verdict) run.sc++;
  else run.si++;
  // Feedback: touch has no loupe border to flash, so pop a ring at the tap
  // point; mouse keeps the loupe-rim flash on a miss. Landing on a green
  // look-ahead dot is a distinct mistake — acting on "next" as if it were
  // "now" — so it gets a much louder red reaction in either input mode.
  const early = !verdict && isPreviewCell(cell);
  if (early) earlyFlash();
  else if (inputMode === 'touch') tapFlash(x, y, verdict);
  else if (!verdict) missFlash();
  if (!verdict) errorBuzz();

  run.keylog.push({
    i: run.keylog.length,
    key: String(cell),
    expected: String(expected),
    verdict,
    t_shown_ms: run.shownAt[run.pos] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
    x,
    y,
  });

  // Advance always: hit or miss consumes the target (spec §2.4).
  run.pos++;
  run.shownAt[run.pos] = t;
  if (run.pos >= run.seq.length) {
    if (!run.scored) toPractice();
    return;
  }
  placeTarget();
});

fieldEl.addEventListener('pointerup', (e) => {
  if (!run || !run.started || !run.keylog.length) return;
  const last = run.keylog[run.keylog.length - 1];
  if (last.t_keyup_ms === null) last.t_keyup_ms = e.timeStamp - run.t0;
});

function missFlash(strong) {
  loupeEl.style.borderColor = 'var(--err)';
  if (strong) loupeEl.style.boxShadow = '0 0 0 3px rgba(224, 82, 82, .45), 0 0 30px 8px rgba(224, 82, 82, .35)';
  setTimeout(() => {
    loupeEl.style.borderColor = '';
    loupeEl.style.boxShadow = '';
  }, strong ? 300 : 160);
}

// Was the tap on one of the visible look-ahead dots? Only the previews
// actually on screen count — a cell that happens to be further down the
// sequence isn't something the player could have been reacting to.
function isPreviewCell(cell) {
  for (let k = 0; k < previewDepth; k++) {
    const si = run.pos + 1 + k;
    if (si >= run.seq.length) break;
    if (run.seq[si] === cell) return true;
  }
  return false;
}

// The loudest error in the game: a red pulse around the whole field, so "you
// tapped the green one" is unmistakable at a glance. No ring at the tap point —
// the border alone carries it, and a red circle drawn over the green dot you
// just hit reads as two separate errors (owner's call, 2026-07-26).
let earlyFlashes = 0;

function earlyFlash() {
  earlyFlashes++;
  fieldEl.classList.remove('err-pulse');
  void fieldEl.offsetWidth; // restart the pulse on back-to-back early taps
  fieldEl.classList.add('err-pulse');
  if (inputMode === 'mouse') missFlash(true);
}

// ---- audio feedback: WebAudio only, no files (spec §4.1) ----
// The same short low square burst stream-typing plays on a wrong key. Created
// lazily inside the pointer handler, which is the user gesture browsers want.

let audioCtx = null;

// iOS hands out every AudioContext suspended and only a user gesture may start
// it, so warm it on the first interaction of the session rather than on the
// first *miss* — a buzz that has to build its own context arrives late or not
// at all. Cheap and idempotent; kept off the tap path after the first call.
function ensureAudio() {
  if (!audioOn) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* audio is never load-bearing */ }
}
// Self-removing rather than {once}: a tap taken with the buzz switched off must
// not burn the one chance to warm up.
function warmAudioOnce() {
  ensureAudio();
  if (audioCtx) document.removeEventListener('pointerdown', warmAudioOnce, true);
}
document.addEventListener('pointerdown', warmAudioOnce, true);

function errorBuzz() {
  if (!audioOn) return;
  ensureAudio();
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    // 220, not the 110 this started at: a tablet's speakers are physically too
    // small to radiate a 110 Hz fundamental, so on an iPad the buzz was there
    // in the graph and inaudible in the room. 220 with a square's harmonics
    // sits where small speakers actually work, and stays a low buzz on a
    // laptop rather than a beep. Level up to match (2026-07-26).
    o.frequency.value = 220;
    g.gain.setValueAtTime(0.12, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + 0.1);
  } catch { /* audio is never load-bearing */ }
}

// A ring that pops at the tap point — the touch analog of the loupe-rim flash.
function tapFlash(x, y, ok) {
  const el = document.createElement('div');
  el.className = 'tap-flash' + (ok ? ' ok' : ' miss');
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fieldEl.appendChild(el);
  setTimeout(() => el.remove(), 380);
}

// ---- loupe: canvas fisheye assist, rAF-throttled (mouse mode only) ----

let rafPending = false;

fieldEl.addEventListener('pointermove', (e) => {
  if (inputMode !== 'mouse' || e.pointerType !== 'mouse') return;
  const r = fieldEl.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
  mouse.inField = true;
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(drawLoupe);
  }
});

fieldEl.addEventListener('pointerleave', () => {
  mouse.inField = false;
  loupeEl.hidden = true;
});

// Radial magnification profile: lensMag at the center, tapering
// quadratically to exactly 1 at the rim — the glass edge is continuous
// with the field behind it, which is what reads as a curved lens rather
// than a flat zoom window.
function magAt(r) {
  const u = r / loupeR;
  return 1 + (lensMag - 1) * (1 - u * u);
}

// Offscreen scene at 1:1 around the cursor; the lens composites it.
const sceneCanvas = document.createElement('canvas');
const sctx = sceneCanvas.getContext('2d');

function drawScene(dpr, side) {
  if (sceneCanvas.width !== side * dpr) {
    sceneCanvas.width = side * dpr;
    sceneCanvas.height = side * dpr;
  }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.fillStyle = '#101216';
  sctx.fillRect(0, 0, side, side);

  // Grid at 1:1: screen x = k*cell maps to k*cell - mouse.x + loupeR.
  sctx.strokeStyle = '#2a2e36';
  sctx.lineWidth = 1;
  sctx.beginPath();
  for (let k = Math.max(0, Math.floor((mouse.x - loupeR - grid.ox) / grid.cell));
       k <= grid.cols && grid.ox + k * grid.cell <= mouse.x + loupeR; k++) {
    const lx = grid.ox + k * grid.cell - mouse.x + loupeR;
    sctx.moveTo(lx, 0);
    sctx.lineTo(lx, side);
  }
  for (let k = Math.max(0, Math.floor((mouse.y - loupeR - grid.oy) / grid.cell));
       k <= grid.rows && grid.oy + k * grid.cell <= mouse.y + loupeR; k++) {
    const ly = grid.oy + k * grid.cell - mouse.y + loupeR;
    sctx.moveTo(0, ly);
    sctx.lineTo(side, ly);
  }
  sctx.stroke();

  // Look-ahead previews at 1:1, dimmer, drawn under the live target.
  if (run && state !== 'done') {
    for (let k = 0; k < previewDepth; k++) {
      const si = run.pos + 1 + k;
      if (si >= run.seq.length) break;
      const c = cellCenter(run.seq[si]);
      const lx = c.x - mouse.x + loupeR;
      const ly = c.y - mouse.y + loupeR;
      if (lx > -grid.cell && lx < side + grid.cell && ly > -grid.cell && ly < side + grid.cell) {
        // green bullseye: ring + center dot, dimmer with depth
        const a = Math.max(0.22, 0.6 - k * 0.15);
        sctx.strokeStyle = 'rgba(88, 179, 104, ' + a + ')';
        sctx.lineWidth = 2;
        sctx.beginPath();
        sctx.arc(lx, ly, Math.max(4, grid.cell * 0.32), 0, Math.PI * 2);
        sctx.stroke();
        sctx.fillStyle = 'rgba(88, 179, 104, ' + a + ')';
        sctx.beginPath();
        sctx.arc(lx, ly, Math.max(1.5, grid.cell * 0.1), 0, Math.PI * 2);
        sctx.fill();
      }
    }
  }

  // Live target: a solid yellow fill of the cell (the "act now" cue).
  if (run && run.pos < run.seq.length && state !== 'done') {
    const c = cellCenter(run.seq[run.pos]);
    const lx = c.x - mouse.x + loupeR;
    const ly = c.y - mouse.y + loupeR;
    if (lx > -grid.cell && lx < side + grid.cell && ly > -grid.cell && ly < side + grid.cell) {
      const half = grid.cell / 2 - 1;
      sctx.fillStyle = 'rgba(224, 180, 82, .9)';
      sctx.fillRect(lx - half, ly - half, half * 2, half * 2);
    }
  }
}

function drawLoupe() {
  rafPending = false;
  if (inputMode !== 'mouse' || !mouse.inField || fieldEl.hidden) { loupeEl.hidden = true; return; }
  loupeEl.hidden = false;
  loupeEl.style.transform = 'translate(' + mouse.x + 'px,' + mouse.y + 'px)';

  const dpr = window.devicePixelRatio || 1;
  const side = loupeR * 2;
  if (loupeCanvas.width !== side * dpr) {
    loupeCanvas.width = side * dpr;
    loupeCanvas.height = side * dpr;
  }
  drawScene(dpr, side);

  // Composite the lens: concentric rings from rim to center, each drawn as
  // the whole scene scaled by that ring's magnification about the center —
  // painter's algorithm leaves each annulus at its own scale, a piecewise
  // approximation of the continuous radial profile.
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.clearRect(0, 0, side, side);
  const rings = lensRings();
  for (let i = rings; i >= 1; i--) {
    const rOuter = (loupeR * i) / rings;
    const m = magAt(loupeR * (i - 0.5) / rings);
    lctx.save();
    lctx.beginPath();
    lctx.arc(loupeR, loupeR, rOuter, 0, Math.PI * 2);
    lctx.clip();
    lctx.translate(loupeR, loupeR);
    lctx.scale(m, m);
    lctx.drawImage(sceneCanvas, 0, 0, side * dpr, side * dpr, -loupeR, -loupeR, side, side);
    lctx.restore();
  }

  // Glass vignette: darkening toward the rim sells the curvature.
  const vg = lctx.createRadialGradient(loupeR, loupeR, loupeR * 0.55, loupeR, loupeR, loupeR);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.28)');
  lctx.fillStyle = vg;
  lctx.fillRect(0, 0, side, side);

  // Direction affordance on the ring when the target is far.
  if (run && run.pos < run.seq.length && state !== 'done') {
    const c = cellCenter(run.seq[run.pos]);
    const dx = c.x - mouse.x;
    const dy = c.y - mouse.y;
    const dist = Math.hypot(dx, dy);
    if (dist > ARROW_DIST) {
      loupeArrow.hidden = false;
      loupeArrow.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
    } else {
      loupeArrow.hidden = true;
    }
    // True-position pin: the magnified image slides under the glass, but the
    // click lands at the pointer's real coordinates. Once the target is under
    // the lens, draw an undistorted ring at its actual screen offset — that
    // ring, not the magnified dot, is where the pointer must go.
    if (dist < loupeR) {
      const tx = loupeR + dx;
      const ty = loupeR + dy;
      lctx.lineWidth = 3.5;
      lctx.strokeStyle = 'rgba(0, 0, 0, .6)';
      lctx.beginPath();
      lctx.arc(tx, ty, 6, 0, Math.PI * 2);
      lctx.stroke();
      lctx.lineWidth = 1.75;
      lctx.strokeStyle = '#e0b452';
      lctx.beginPath();
      lctx.arc(tx, ty, 6, 0, Math.PI * 2);
      lctx.stroke();
      lctx.lineWidth = 1;
    }
  }

  // Crosshair: the true click point (drawn undistorted, on top).
  lctx.strokeStyle = '#565c66';
  lctx.beginPath();
  lctx.moveTo(loupeR - 10, loupeR); lctx.lineTo(loupeR - 4, loupeR);
  lctx.moveTo(loupeR + 4, loupeR); lctx.lineTo(loupeR + 10, loupeR);
  lctx.moveTo(loupeR, loupeR - 10); lctx.lineTo(loupeR, loupeR - 4);
  lctx.moveTo(loupeR, loupeR + 4); lctx.lineTo(loupeR, loupeR + 10);
  lctx.stroke();
  lctx.fillStyle = '#7aa2f7';
  lctx.fillRect(loupeR - 1, loupeR - 1, 2, 2);
}

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
    if (state === 'practice') { e.preventDefault(); armScoredRun(); }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (sheetOpen) { closeSheet(); return; }
    if (state === 'practice') toPractice();
    else if (state === 'armed') toPractice();
    else if (state === 'scored') {
      if (escPendingTimer) abortScoredRun('aborted');
      else armEscPending();
    }
  }
});

// ---- settings sheet: cell size ----

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

// Cell-size options differ by input mode, so the segment is rebuilt on mode
// change; click handling is delegated on the container, so it survives that.
function renderCellSeg() {
  $('seg-cell').innerHTML = CELL_OPTS[inputMode]
    .map((v) => '<button data-v="' + v + '">' + v + ' mm</button>')
    .join('');
}

function segOn(id, pred) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', pred(b));
}

// Marks the *recommended* option, as distinct from the selected one. Two
// different questions — "what am I on" and "what should I be on" — so two
// different marks, and a player who has wandered can always see the way back.
function segRec(id, pred) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('rec', pred(b));
}

// The shipped defaults, in one place: the settings the leaderboard's best runs
// actually used, per device class (spec §9 step 10 — tablet 20 mm / phone 12 mm,
// one look-ahead dot, error sound on). The first-open picker badges the tile
// size; this is the same answer, kept visible inside the sheet.
function recommendedSettings() {
  return {
    cell_mm: recommendedCell(inputMode),
    preview: DEFAULT_PREVIEW[inputMode],
    audio: true,
  };
}

function atRecommended() {
  const r = recommendedSettings();
  return cellMm === r.cell_mm && previewDepth === r.preview && audioOn === r.audio;
}

function syncSheet() {
  const loupeOn = inputMode === 'mouse';
  const rec = recommendedSettings();
  segOn('seg-cell', (b) => Number(b.dataset.v) === cellMm);
  segOn('seg-zoom', (b) => b.dataset.v === String(zoomMode));
  segOn('seg-lens', (b) => Number(b.dataset.v) === loupeR);
  segOn('seg-preview', (b) => Number(b.dataset.v) === previewDepth);
  segOn('seg-audio', (b) => (b.dataset.v === 'on') === audioOn);
  segRec('seg-cell', (b) => Number(b.dataset.v) === rec.cell_mm);
  segRec('seg-preview', (b) => Number(b.dataset.v) === rec.preview);
  segRec('seg-audio', (b) => (b.dataset.v === 'on') === rec.audio);
  const reset = $('sh-reset');
  if (reset) reset.hidden = atRecommended();
  $('row-zoom').hidden = !loupeOn; // lens controls are meaningless in touch mode
  $('row-lens').hidden = !loupeOn;
  $('sheet-info').textContent =
    grid.cols + '×' + grid.rows + ' cells · N=' + N + ' · ' + BITS.toFixed(2) +
    ' bits/selection' +
    (loupeOn ? ' · lens ' + lensMag.toFixed(1) + '× / r' + loupeR +
      ' · ~' + Math.round(cellMm * lensMag) + ' mm in lens' : ' · touch, no lens') +
    (previewDepth ? ' · look-ahead ' + previewDepth : '') +
    ' · changes restart the bout';
  renderCfg();
}

function segApply(mut) {
  mut();
  saveSettings();
  buildConfig();
  syncSheet();
  toPractice();
}

$('seg-cell').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  segApply(() => { cellMm = Number(b.dataset.v); });
});

$('seg-preview').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  segApply(() => { previewDepth = Number(b.dataset.v); });
});

$('seg-audio').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  segApply(() => { audioOn = b.dataset.v === 'on'; });
  ensureAudio(); // switching it on is itself the gesture iOS wants
});

// "Back to recommended" — injected from here rather than added to each env's
// index.html, because one implementation backs both games and a control that
// exists in only one of them is a bug waiting to happen. Hidden whenever the
// player is already on the defaults, so it never nags.
(function mountSheetReset() {
  const sheet = $('sheet');
  const info = $('sheet-info');
  if (!sheet || !info) return;
  const row = document.createElement('div');
  row.className = 'sh-row sh-row-reset';
  row.innerHTML =
    '<span class="sh-reclegend">recommended</span>' +
    '<button type="button" id="sh-reset" class="sh-reset" hidden>back to recommended</button>';
  sheet.insertBefore(row, info);
  row.addEventListener('click', (e) => {
    if (!e.target.closest('#sh-reset')) return;
    e.target.blur();
    const r = recommendedSettings();
    segApply(() => { cellMm = r.cell_mm; previewDepth = r.preview; audioOn = r.audio; });
  });
})();

$('seg-zoom').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  segApply(() => { zoomMode = b.dataset.v === 'auto' ? 'auto' : Number(b.dataset.v); });
});

$('seg-lens').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  segApply(() => { loupeR = Number(b.dataset.v); });
});

// Corner strip in play + the score screen's footer: same buttons, one binder
// (shared with every other environment — see common/results.js).
BitrateResults.wireActs({ arm: armScoredRun, seed: toPractice, settings: toggleSheet });

// ---- mode transitions ----

async function armScoredRun() {
  // A touch laptop passes this by tapping once; a mouse-only machine can't.
  if (touchRequired() && !(run && run.touchSeen)) {
    showNotice(hasTouchscreen()
      ? 'tap the grid once first — scored drum pad runs have to be tapped, not clicked'
      : 'this device has no touchscreen. drum pad scores taps; try it on a tablet or phone, '
        + 'or play <a href="/env/pixel-lens/">pixel lens</a> with the mouse.', 'warn', 7000);
    return;
  }
  await finishBout();
  try {
    await startRun(true);
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
    const why = reason === 'resized'
      ? 'viewport changed — the alphabet resized, run invalidated'
      : reason === 'mouse_input'
        ? 'scored run invalidated — drum pad scores taps, and that was a mouse'
        : 'scored run invalidated — window lost focus';
    showNotice(why + ' · <b>Enter</b> re-arms', 'warn', 6000);
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

// ---- focus loss and resize invalidate (alphabet is viewport-derived) ----

window.addEventListener('blur', onFocusLost);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) onFocusLost();
});

function onFocusLost() {
  if (!run || !run.started) return;
  if (state === 'scored') abortScoredRun('focus_lost');
  else if (state === 'practice') run.flags.focus_lost = true;
}

let resizeTimer = null;
function scheduleResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 250);
}
window.addEventListener('resize', scheduleResize);

// The band can also change height on its own — the config line rewrapping, the
// run controls repainting — which moves the field's top edge just as a window
// resize does. Here that also moves N, since the alphabet is the grid that
// fits in the space left over, so it takes the same path.
window.BitrateResults.trackHeaderHeight(() => scheduleResize());

function onResize() {
  resizeTimer = null;
  if (state === 'done' || state === 'error' || state === 'loading') {
    buildConfig(); // results stay up; next run uses the new grid
    return;
  }
  // Same alphabet? Then nothing scoring depends on has moved. The field may
  // have shifted a few pixels, but the same cols×rows of the same cell still
  // fit, so N and bits/selection are untouched — re-lay the grid out where the
  // field is now and let the run stand. Only a real change in N can invalidate
  // a run (spec §7: the score is bits × selections, and bits is log2(N-1)),
  // and a band that gained a line is not one.
  const m = gridMetrics(cellMm);
  if (grid && m.cols === grid.cols && m.rows === grid.rows && m.cell === grid.cell) {
    buildConfig();
    if (run && run.seq && run.pos < run.seq.length) placeTarget();
    return;
  }
  const wasScored = state === 'scored' && run && run.started;
  if (wasScored) {
    // N changed mid-run: the run cannot stand. Rebuild the config first so
    // the fresh practice run abortScoredRun kicks off uses the new grid —
    // the invalidated run's submit payload only reads the old `run` object.
    buildConfig();
    abortScoredRun('resized');
    return;
  }
  const played = !!(run && run.started);
  if (played && !run.submitted) submitRun(false).catch(() => {});
  run = null;
  buildConfig();
  startRun(state === 'armed').catch(showError);
  // Only worth saying when something was actually lost: at boot the bar settles
  // once as the corner strip paints, and nobody has played anything yet.
  if (played) showNotice('viewport changed — N recalculated', '', 3000);
}

// ---- scoring (client mirror; server is authoritative) ----

function scoreWith(r, tSec) {
  const net = Math.max(r.sc - r.si, 0);
  // Use the run's own snapshot, never the mutable global (see startRun).
  const rn = r.n ?? N, rbits = r.bits ?? BITS;
  return { n: rn, sc: r.sc, si: r.si, bps: tSec > 0 ? (rbits * net) / tSec : 0 };
}

function elapsedMsOf(r) {
  return r && r.started ? performance.now() - r.t0 : 0;
}

function lastKeyT(r) {
  return r.keylog.length ? r.keylog[r.keylog.length - 1].t_pressed_ms : 0;
}

// ---- submit with retry queue ----

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

const QUEUE_KEY = 'bitrate_submit_queue_v1'; // shared queue across environments

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
      scheduleFlush(Math.min(delay * 2, 60000));
    }
  }, delay);
}

// ---- HUD: exactly 1 Hz. Practice metrics are a trailing-60 s window +
// rolling sparkline (shared BitrateResults helpers — same in every env). ----

const R = window.BitrateResults;

function renderHud() {
  if (state === 'done') return;
  const spark = $('hud-spark');
  if (!run || !run.started) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? CONFIG.duration_s + 's' : '';
    $('hud-counts').textContent = 'N ' + N + ' · Sc 0 · Si 0';
    window.BitrateResults.renderSpark('hud-spark', null, BITS, 0);
    return;
  }
  const nowT = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD stays cumulative — it previews the actual 60 s score.
    const cs = scoreWith(run, Math.max(nowT, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - nowT) / 1000)) + 's';
    $('hud-counts').textContent = 'N ' + (run.n || N) + ' · Sc ' + run.sc + ' · Si ' + run.si;
    window.BitrateResults.renderSpark('hud-spark', run, BITS, nowT);
    return;
  }
  // Practice: trailing-60 s window, so the figure reflects current skill
  // rather than being dragged down by warm-up.
  const tr = R.trailingBps(run.keylog, run.bits, nowT);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(nowT / 1000) + 's practice';
  $('hud-counts').textContent = 'N ' + (run.n || N) + ' · Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  window.BitrateResults.renderSpark('hud-spark', run, BITS, nowT);
}

setInterval(() => { renderHud(); tickArmPrompt(); }, 1000);

// ---- results view (shared renderer — spec §4.3) ----

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
    '<div class="res-title">' + GAME_LABEL + ' · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> (' + grid.cols + '×' + grid.rows + ' cells)' +
    ' · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
    ' · accuracy <b>' + (sc + si > 0 ? ((100 * sc) / (sc + si)).toFixed(1) : '—') + '%</b></div>' +
    note;

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

// ---- boot ----

// Leaderboard relaunch (spec §4.4): ?cfg=<config_hash> applies that
// variant's cell size for the session; N still derives from this viewport.
async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== ENV_NAME) return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if (c.input === 'mouse' || c.input === 'touch') inputMode = c.input;
    if (typeof c.preview === 'number' && c.preview >= 0 && c.preview <= MAX_PREVIEW) previewDepth = Math.round(c.preview);
    if (typeof c.cell_mm === 'number' && c.cell_mm >= CELL_MIN && c.cell_mm <= CELL_MAX) cellMm = c.cell_mm;
    if (!CELL_OPTS[inputMode].includes(cellMm)) cellMm = recommendedCell(inputMode);
    renderCellSeg();
    buildConfig();
  } catch { /* ship build or unknown hash: defaults */ }
}

// ---- headless test hook (the beatDebug/voiceDebug pattern) ----
// Lets QA drive deterministic taps and read state without a real pointer.
window.pixelDebug = {
  state: () => state,
  config: () => CONFIG,
  counts: () => (run ? { sc: run.sc, si: run.si, pos: run.pos } : null),
  trailingBps: (winMs) => (run && run.started ? R.trailingBps(run.keylog, run.bits, elapsedMsOf(run), winMs) : null),
  sparkSeries: () => (run && run.started ? R.sparkSeries(run.keylog, run.bits, elapsedMsOf(run)) : null),
  targetCell: () => (run && run.pos < run.seq.length ? run.seq[run.pos] : null),
  previewCount: () => previewEls.filter((e) => !e.hidden).length,
  // test-only: the N the client would report for this run, and a way to force
  // the global alphabet to drift (simulating a mid-run iPad viewport change).
  scoreN: () => (run ? scoreWith(run, 60).n : null),
  globalN: () => N,
  _forceN: (nn) => { N = nn; BITS = Math.log2(nn - 1); },
  // Live look-ahead cells, and whether the last tap triggered the loud
  // "you hit the green dot" reaction.
  previewCells: () => (run ? run.seq.slice(run.pos + 1, run.pos + 1 + previewDepth) : []),
  earlyFlashCount: () => earlyFlashes,
  // The arm affordance: read the practice clock, or jump straight to the
  // suggestion card instead of playing for a real minute to see it.
  practiceMs: () => practiceMs,
  armPromptShown: () => armPromptShown,
  showArmPrompt: () => showArmPrompt(),
  recommended: () => recommendedSettings(),
  atRecommended: () => atRecommended(),
  // Dispatch a real pointerdown at a cell's center (pointerType defaults to the
  // current input mode) — exercises the same handler a finger/mouse would.
  tapCell: (idx, type) => {
    const c = cellCenter(idx);
    const fr = fieldEl.getBoundingClientRect();
    fieldEl.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: fr.left + c.x,
      clientY: fr.top + c.y,
      button: 0,
      isPrimary: true,
      pointerType: type || inputMode,
      bubbles: true,
      cancelable: true,
    }));
  },
};

loadSettings();
ensurePreviewPool(MAX_PREVIEW);
renderCellSeg();
buildConfig();
scheduleFlush(1500);
applyCfgParam().then(() => startRun(false)).catch(showError);

// ---- first open: pick a tile size ----
// Cell size is the one setting that changes what the game *is* — it sets N and
// whether a tap lands first try — and the right answer is a property of the
// player's hand and screen, not something a default can know. So ask once,
// with the sizes drawn at their real physical size rather than named in
// millimetres nobody can picture. Everything after this is the settings sheet.

// Each option priced with what it actually yields here: the grid that fits on
// this screen and the bits one selection is then worth. Rebuilt from
// buildConfig() (below) because the band settles after boot — a promise made
// against a stale layout is a promise the game won't keep.
function sizeOptionsHTML() {
  // Nine samples; the CSS shows a 2x2 of them on a phone, where a 3x3 of
  // real-size tiles is most of the screen.
  const cells = new Array(9).fill('<i></i>').join('');
  const rec = recommendedCell(inputMode);
  return CELL_OPTS[inputMode].map((mm) => {
    const m = gridMetrics(mm);
    const isRec = mm === rec;
    return '<button type="button" class="sp-opt' + (isRec ? ' sp-rec' : '') + '" data-v="' + mm + '">' +
      (isRec ? '<span class="sp-badge">recommended</span>' : '') +
      '<span class="sp-grid" style="--c:' + m.cell + 'px">' + cells + '</span>' +
      '<span class="sp-size">' + mm + ' mm</span>' +
      '<span class="sp-rate">' + m.cols + '×' + m.rows + ' · <b>' + m.bits.toFixed(2) +
      '</b> bits/' + (inputMode === 'touch' ? 'tap' : 'click') + '</span>' +
      '</button>';
  }).join('');
}

function refreshSizePicker() {
  const host = document.querySelector('#size-pick .sp-opts');
  if (host) host.innerHTML = sizeOptionsHTML();
}

// Touch only. Tile size is half the decision — the other half is which device
// and how many fingers, and a first-session player has no way to know either.
// Three lines, shown at the one moment they're actionable: hands, device, and
// the standing permission to go try it rather than reason about it.
function touchTipsHTML() {
  if (inputMode !== 'touch') return '';
  return '<ul class="sp-tips">' +
    '<li><b>fingers</b> — tablet: two index fingers. phone: one, so your hand never covers the board.</li>' +
    '<li><b>size</b> — the badged tile is what has scored best on a screen this size. tablets do better with <em>bigger</em> tiles than phones: two fingers crossing a big screen spend their time travelling, so fewer stops beats more bits.</li>' +
    '<li><b>try it</b> — practice is free, and the badge is an average, not your hand. a few seconds at two or three sizes, then trust your hand.</li>' +
    '</ul>';
}

function showSizePicker() {
  const wrap = document.createElement('div');
  wrap.id = 'size-pick';
  wrap.innerHTML =
    '<div class="sp-card">' +
    '<div class="sp-title">how big should the tiles be?</div>' +
    '<div class="sp-sub">' +
    (inputMode === 'touch'
      ? 'more tiles means more bits per tap, but smaller tiles get missed — and a miss costs double. pick the smallest tile you hit almost every time.'
      : 'pick what you can click without aiming. smaller cells mean more of them — more bits per click — until the pointing costs more than the bits are worth.') +
    '</div>' +
    touchTipsHTML() +
    '<div class="sp-opts">' + sizeOptionsHTML() + '</div>' +
    '<div class="sp-note">you can change this any time — <b>settings</b>, during practice</div>' +
    '</div>';
  document.body.appendChild(wrap);
  document.body.classList.add('picking');
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('.sp-opt');
    if (!b) return;
    cellMm = Number(b.dataset.v);
    sizeChosen = true;
    saveSettings();
    wrap.remove();
    document.body.classList.remove('picking');
    buildConfig();
    toPractice();
  });
}

// Opened the mouse game on a touchscreen: the loupe needs a hover this device
// doesn't have. Point at the game that fits rather than letting them fight it.
if (wrongDeviceForMode()) {
  showNotice('no mouse here — <a href="/env/drum-pad/">drum pad</a> is the touch version of this grid', '', 12000);
}

// Drum pad on a machine with no touchscreen at all: say so up front and keep
// saying it. Practice still works with the mouse — it's the scored run that
// has to be tapped — so this is a standing banner, not a wall.
if (touchRequired() && !hasTouchscreen()) {
  const warn = document.createElement('div');
  warn.id = 'device-warn';
  warn.innerHTML = 'drum pad is a <b>touch</b> game and this device has no touchscreen. ' +
    'practise with the mouse if you like, but a scored run has to be tapped — ' +
    'open it on a phone or tablet, or play <a href="/env/pixel-lens/">pixel lens</a> with the mouse.';
  document.body.appendChild(warn);
}

if (!sizeChosen) showSizePicker();
