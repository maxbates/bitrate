'use strict';

/* pixel-lens environment (spec §5 backlog).
 *
 * A target lights up somewhere on a huge grid; the player mouses to it and
 * clicks. A fisheye loupe rides the cursor so landing inside the cell is
 * comfortable. Deliberately pointer-bound: Fitts's law charges log-distance
 * per acquisition, so this mode exists to show *why* alphabet size cannot
 * rescue a serial pointing device (~4–10 bps expected ceiling).
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
const SETTINGS_KEY = 'bitrate_pixel_settings_v1';
const DEFAULT_CELL_MM = 5;

// Input mode drives cell-size options, loupe presence, and grid inset.
//   mouse — fine cells + hover-driven fisheye loupe (the original mode).
//   touch — finger-sized cells, no loupe: a touchscreen has no hover, so you
//           tap the target directly (an iPad on the same WiFi, say). Same grid,
//           same honest-N accounting; the mode is part of the variant identity,
//           so mouse-vs-touch is a within-environment leaderboard comparison.
const CELL_OPTS = { mouse: [3, 5, 7.5, 10], touch: [12, 16, 20, 25] };
const DEFAULT_CELL = { mouse: 5, touch: 20 };
const CELL_MIN = 2, CELL_MAX = 30;
const MAX_PREVIEW = 4;

let inputMode = 'mouse';   // 'mouse' | 'touch'
let previewDepth = 0;      // look-ahead: upcoming targets shown as dimmer dots
let cellMm = DEFAULT_CELL_MM;
let zoomMode = 'auto'; // 'auto' (25mm apparent) or a fixed multiplier

let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
let grid = { cols: 0, rows: 0, cell: 19, w: 0, h: 0 };
let lensMag = 5; // center magnification; falls off to 1 at the rim

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (s.input === 'mouse' || s.input === 'touch') inputMode = s.input;
    if (typeof s.cell_mm === 'number' && s.cell_mm >= CELL_MIN && s.cell_mm <= CELL_MAX) cellMm = s.cell_mm;
    if (s.zoom === 'auto' || (typeof s.zoom === 'number' && s.zoom >= 2 && s.zoom <= 8)) zoomMode = s.zoom;
    if (typeof s.lens_r === 'number' && s.lens_r >= 60 && s.lens_r <= 180) loupeR = s.lens_r;
    if (typeof s.preview === 'number' && s.preview >= 0 && s.preview <= MAX_PREVIEW) previewDepth = Math.round(s.preview);
  } catch { /* defaults */ }
  // Snap the cell size to a valid option for the mode (options differ by mode).
  if (!CELL_OPTS[inputMode].includes(cellMm)) cellMm = DEFAULT_CELL[inputMode];
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      input: inputMode, cell_mm: cellMm, zoom: zoomMode, lens_r: loupeR, preview: previewDepth,
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

function buildConfig() {
  const loupeOn = inputMode === 'mouse';
  const cell = Math.max(6, Math.round(cellMm * PX_PER_MM));
  const r = fieldEl.getBoundingClientRect();
  // Inset the grid from the field edges. Mouse mode keeps a lens-radius margin
  // so the loupe is never buried more than ~40% at a boundary target; touch
  // has no loupe, so a half-cell finger margin is enough and the grid fills more.
  const pad = loupeOn ? Math.round(loupeR * 0.6) : Math.round(cell * 0.5);
  const cols = Math.max(2, Math.floor((r.width - 2 * pad) / cell));
  const rows = Math.max(2, Math.floor((r.height - 2 * pad) / cell));
  const ox = Math.round((r.width - cols * cell) / 2);
  const oy = Math.round((r.height - rows * cell) / 2);
  grid = { cols, rows, cell, ox, oy, w: r.width, h: r.height };
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
  N = cols * rows; // no correction key in this environment
  BITS = Math.log2(N - 1);
  CONFIG = {
    environment: 'pixel-lens',
    alphabet_size: N,
    grid_cols: cols,
    grid_rows: rows,
    cell_px: cell,
    cell_mm: cellMm,
    input: inputMode,
    loupe: loupeOn ? 'on' : 'off',
    preview: previewDepth,
    loupe_r_px: loupeOn ? loupeR : 0,
    loupe_mag: loupeOn ? Math.round(lensMag * 100) / 100 : 0,
    loupe_zoom_mode: loupeOn ? String(zoomMode) : 'off',
    grid_pad_px: pad,
    viewport_w: Math.round(window.innerWidth),
    viewport_h: Math.round(window.innerHeight),
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
  $('res-info').innerHTML =
    '<b>' + CONFIG.viewport_w + '×' + CONFIG.viewport_h + '</b> px · ' +
    '<b>' + cols + '×' + rows + '</b> cells of ' + cellMm + ' mm' +
    (loupeOn ? ' (~' + Math.round(cellMm * lensMag) + ' mm in lens)' : ' · touch') +
    ' · N=<b>' + N + '</b> · <b>' + BITS.toFixed(2) + '</b> bits/selection' +
    (previewDepth ? ' · look-ahead <b>' + previewDepth + '</b>' : '');
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
    flags: {},
    submitted: false,
  };
  setState(scored ? 'armed' : 'practice');
  placeTarget();
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
  $('res-info').hidden = next === 'done';
  $('gear').hidden = next !== 'practice';
  if (next !== 'practice') $('hud-spark').innerHTML = '';
  if (next === 'done') { hidePreviews(); targetEl.hidden = true; }
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
      '<span class="act armed-note">first click starts the 60 s clock</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</span>';
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
    el.innerHTML = '<div class="pring2"></div><div class="pring"></div><div class="pdot"></div>';
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
  if (early) earlyFlash(x, y);
  else if (inputMode === 'touch') tapFlash(x, y, verdict);
  else if (!verdict) missFlash();

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

// The loudest error in the game: a big red burst at the tap point plus a red
// pulse around the field. Deliberately more than an ordinary near-miss, so
// "you tapped the green one" is unmistakable at a glance.
function earlyFlash(x, y) {
  const el = document.createElement('div');
  el.className = 'tap-flash early';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fieldEl.appendChild(el);
  setTimeout(() => el.remove(), 520);
  fieldEl.classList.remove('err-pulse');
  void fieldEl.offsetWidth; // restart the pulse on back-to-back early taps
  fieldEl.classList.add('err-pulse');
  if (inputMode === 'mouse') missFlash(true);
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
    if (Math.hypot(dx, dy) > ARROW_DIST) {
      loupeArrow.hidden = false;
      loupeArrow.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
    } else {
      loupeArrow.hidden = true;
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

function syncSheet() {
  const loupeOn = inputMode === 'mouse';
  segOn('seg-input', (b) => b.dataset.v === inputMode);
  segOn('seg-cell', (b) => Number(b.dataset.v) === cellMm);
  segOn('seg-zoom', (b) => b.dataset.v === String(zoomMode));
  segOn('seg-lens', (b) => Number(b.dataset.v) === loupeR);
  segOn('seg-preview', (b) => Number(b.dataset.v) === previewDepth);
  $('row-zoom').hidden = !loupeOn; // lens controls are meaningless in touch mode
  $('row-lens').hidden = !loupeOn;
  $('sheet-info').textContent =
    grid.cols + '×' + grid.rows + ' cells · N=' + N + ' · ' + BITS.toFixed(2) +
    ' bits/selection' +
    (loupeOn ? ' · lens ' + lensMag.toFixed(1) + '× / r' + loupeR +
      ' · ~' + Math.round(cellMm * lensMag) + ' mm in lens' : ' · touch, no lens') +
    (previewDepth ? ' · look-ahead ' + previewDepth : '') +
    ' · changes restart the bout';
}

function segApply(mut) {
  mut();
  saveSettings();
  buildConfig();
  syncSheet();
  toPractice();
}

$('seg-input').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.v === inputMode) return;
  b.blur();
  segApply(() => {
    inputMode = b.dataset.v;
    if (!CELL_OPTS[inputMode].includes(cellMm)) cellMm = DEFAULT_CELL[inputMode];
    renderCellSeg();
  });
});

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

$('gear').addEventListener('click', (e) => {
  e.currentTarget.blur();
  sheetOpen ? closeSheet() : openSheet();
});

modeHelp.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'arm') armScoredRun();
  else if (act.dataset.act === 'seed') toPractice();
});

// ---- mode transitions ----

async function armScoredRun() {
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
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(onResize, 250);
});

function onResize() {
  resizeTimer = null;
  if (state === 'done' || state === 'error' || state === 'loading') {
    buildConfig(); // results stay up; next run uses the new grid
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
  if (run && run.started && !run.submitted) submitRun(false).catch(() => {});
  run = null;
  buildConfig();
  startRun(state === 'armed').catch(showError);
  showNotice('viewport changed — N recalculated', '', 3000);
}

// ---- scoring (client mirror; server is authoritative) ----

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
    $('hud-counts').textContent = '';
    spark.innerHTML = '';
    return;
  }
  const nowT = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD stays cumulative — it previews the actual 60 s score.
    const cs = scoreWith(run, Math.max(nowT, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - nowT) / 1000)) + 's';
    $('hud-counts').textContent = 'Sc ' + run.sc + ' · Si ' + run.si;
    spark.innerHTML = '';
    return;
  }
  // Practice: trailing-60 s window, so the figure reflects current skill
  // rather than being dragged down by warm-up.
  const tr = R.trailingBps(run.keylog, BITS, nowT);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(nowT / 1000) + 's practice';
  $('hud-counts').textContent = 'Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  spark.innerHTML = R.sparkHTML(run.keylog, BITS, nowT);
}

setInterval(renderHud, 1000);

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
    '<div class="res-title">pixel lens · scored run — ' + CONFIG.duration_s + ' s</div>' +
    '<div class="res-bps">' + bps.toFixed(2) + ' <span>bits/s</span></div>' +
    '<div class="res-sub">N <b>' + n + '</b> (' + grid.cols + '×' + grid.rows + ' cells)' +
    ' · Sc <b>' + sc + '</b> · Si <b>' + si + '</b>' +
    ' · accuracy <b>' + (sc + si > 0 ? ((100 * sc) / (sc + si)).toFixed(1) : '—') + '%</b></div>' +
    note;

  const m = opts.server && opts.server.metrics;
  $('res-tiles').innerHTML = m ? R.tilesHTML(m, { corrections: false }) : '';
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

// ---- boot ----

// Leaderboard relaunch (spec §4.4): ?cfg=<config_hash> applies that
// variant's cell size for the session; N still derives from this viewport.
async function applyCfgParam() {
  const h = new URLSearchParams(location.search).get('cfg');
  if (!h) return;
  try {
    const data = await (await fetch('/api/variants')).json();
    const v = (data.variants || []).find((x) => x.config_hash === h);
    if (!v || v.environment !== 'pixel-lens') return;
    const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
    if (c.input === 'mouse' || c.input === 'touch') inputMode = c.input;
    if (typeof c.preview === 'number' && c.preview >= 0 && c.preview <= MAX_PREVIEW) previewDepth = Math.round(c.preview);
    if (typeof c.cell_mm === 'number' && c.cell_mm >= CELL_MIN && c.cell_mm <= CELL_MAX) cellMm = c.cell_mm;
    if (!CELL_OPTS[inputMode].includes(cellMm)) cellMm = DEFAULT_CELL[inputMode];
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
  trailingBps: (winMs) => (run && run.started ? R.trailingBps(run.keylog, BITS, elapsedMsOf(run), winMs) : null),
  sparkSeries: () => (run && run.started ? R.sparkSeries(run.keylog, BITS, elapsedMsOf(run)) : null),
  targetCell: () => (run && run.pos < run.seq.length ? run.seq[run.pos] : null),
  previewCount: () => previewEls.filter((e) => !e.hidden).length,
  // Live look-ahead cells, and whether the last tap triggered the loud
  // "you hit the green dot" reaction.
  previewCells: () => (run ? run.seq.slice(run.pos + 1, run.pos + 1 + previewDepth) : []),
  earlyFlashCount: () => fieldEl.querySelectorAll('.tap-flash.early').length,
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
