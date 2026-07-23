'use strict';

/* voice-babble environment (spec §5).
 *
 * Spoken i.i.d. symbols, recognized entirely client-side (spec §6: audio
 * never leaves the machine) by a hand-rolled DSP classifier:
 *
 *   frames (~60 fps): 18 log-spaced spectral bands (100–4000 Hz, from the
 *   AnalyserNode FFT) + zero-crossing rate + RMS energy
 *   VAD: energy vs a tracked noise floor segments utterances
 *   classify: nearest-centroid cosine against per-player templates,
 *   at onset+~180 ms (vowels are steady-state; no need to wait for the end)
 *
 * Templates come from a calibration pass (2 takes per symbol) — calibration
 * is a config compiler (spec §2.6): it writes static templates, the run
 * executes them with nothing adaptive. Every utterance reduces to one
 * discrete logged selection with confidence (rule 2, §5 contract).
 */

// ---- symbol sets ----

const SETS = {
  'babble-6': {
    label: 'babble 6',
    symbols: ['aah', 'eee', 'ooh', 'mmm', 'sss', 'shh'],
    note: 'chosen for acoustic separability',
  },
  'babble-8': {
    label: 'babble 8',
    symbols: ['aah', 'eee', 'ooh', 'mmm', 'sss', 'shh', 'uhh', 'aye'],
    note: 'uhh and aye are harder — close neighbors',
  },
  'solfege': {
    label: 'do–ti',
    symbols: ['do', 're', 'mi', 'fa', 'sol', 'la', 'ti'],
    note: 'syllables, not words (§1 register) — same-vowel pairs ride on the onset consonant, attack them crisply',
  },
  'letters-9': {
    label: 'letters 9',
    symbols: ['a', 'e', 'f', 'i', 'o', 'r', 's', 'u', 'x'],
    note: 'letter names picked for distinct sounds',
  },
  'letters-26': {
    label: 'a–z',
    symbols: 'abcdefghijklmnopqrstuvwxyz'.split(''),
    note: 'expected to fail on the e-set — measure it',
  },
};

const SET_KEY = 'bitrate_voice_set_v1';
const DISPLAY_KEY = 'bitrate_voice_display_v1';
const SENS_KEY = 'bitrate_voice_sens_v1';
const TEMPLATES_KEY = 'bitrate_voice_templates_v1';
const MAX_LANES = 9; // beyond this, lanes stop being readable

let setName = 'babble-6';
let SET = SETS[setName];
let display = 'lanes'; // lanes | chips (lanes forced off for big sets)
let CONFIG = null, N = 0, BITS = 0, DURATION_MS = 60000;
const LOOKAHEAD = 4;

function loadSettings() {
  const s = localStorage.getItem(SET_KEY);
  if (s && SETS[s]) { setName = s; SET = SETS[s]; }
  const d = localStorage.getItem(DISPLAY_KEY);
  if (d === 'chips' || d === 'lanes') display = d;
  const v = localStorage.getItem(SENS_KEY);
  if (v && SENS[v]) sensName = v;
}

function effectiveDisplay() {
  return SET.symbols.length <= MAX_LANES ? display : 'chips';
}

function buildConfig() {
  SET = SETS[setName];
  N = SET.symbols.length; // no correction symbol
  BITS = Math.log2(N - 1);
  CONFIG = {
    environment: 'voice-babble',
    alphabet_size: N,
    symbol_set: setName,
    symbols: SET.symbols,
    display: effectiveDisplay(),
    recognizer: 'dsp-cosine-v2',
    segmentation: 'dip-v1',
    vad_sensitivity: sensName,
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
}

// ---- templates ----

function loadTemplates() {
  try {
    const all = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '{}');
    if (all.timing !== 2) return null; // recalibrate after VAD/timing changes
    const map = (all.sets && all.sets[setName]) || null;
    if (!map) return null;
    // Stale templates from an older feature-vector shape force recalibration.
    for (const sym of SET.symbols) {
      if (!Array.isArray(map[sym]) || map[sym].length !== VEC_DIM) return null;
    }
    return map;
  } catch { return null; }
}

function saveTemplates(map) {
  let all;
  try { all = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '{}'); } catch { all = {}; }
  all.version = 1;
  all.timing = 2;
  all.sets = all.sets || {};
  all.sets[setName] = map;
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(all)); } catch { /* fine */ }
}

let templates = null; // {symbol: number[]} for the active set

// ---- dom ----

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

// loading | calib | practice | armed | scored | done | error
let state = 'loading';
let run = null;
let endTimer = null;
let escPendingTimer = null;
let noticeTimer = null;

// ---- audio engine ----

const BANDS = 18;
const FMIN = 100, FMAX = 4000;
const ZCR_WEIGHT = 6;

let audioCtx = null;
let analyser = null;
let micOK = false;
let bandBins = null; // [ [startBin, endBin), ... ]
let freqBuf = null, timeBuf = null;

async function micInit() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
    timeBuf = new Float32Array(analyser.fftSize);
    const hzPerBin = audioCtx.sampleRate / analyser.fftSize;
    bandBins = [];
    for (let b = 0; b < BANDS; b++) {
      const f0 = FMIN * Math.pow(FMAX / FMIN, b / BANDS);
      const f1 = FMIN * Math.pow(FMAX / FMIN, (b + 1) / BANDS);
      bandBins.push([Math.max(1, Math.floor(f0 / hzPerBin)), Math.max(2, Math.ceil(f1 / hzPerBin))]);
    }
    micOK = true;
    frameLoop();
  } catch (err) {
    micOK = false;
    showNotice('microphone unavailable — allow access and reload', 'warn', 60000);
  }
}

function readFrame() {
  analyser.getFloatFrequencyData(freqBuf);
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0, zc = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    sum += timeBuf[i] * timeBuf[i];
    if (i > 0 && (timeBuf[i] >= 0) !== (timeBuf[i - 1] >= 0)) zc++;
  }
  const rms = Math.sqrt(sum / timeBuf.length);
  const zcr = zc / timeBuf.length;
  const bands = new Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const [s, e] = bandBins[b];
    let acc = 0;
    for (let i = s; i < e; i++) acc += freqBuf[i]; // dB domain
    bands[b] = acc / (e - s);
  }
  return { rms, zcr, bands, t: performance.now() };
}

// Two-stage feature vector: onset frames + steady frames, concatenated.
// The onset half is what separates same-vowel symbols (do/sol, fa/la,
// mi/ti, the letter e-set) — consonant attacks live in the first ~60 ms;
// the steady half carries the vowel formant shape. Each half is
// mean-normalized (mic gain cancels); whole vector unit-norm.
const VEC_DIM = BANDS * 2 + 2;
const ONSET_WEIGHT = 0.8; // onset frames are noisier than steady state

function stageVector(frames) {
  const v = new Array(BANDS).fill(0);
  let zcr = 0;
  for (const f of frames) {
    for (let b = 0; b < BANDS; b++) v[b] += f.bands[b];
    zcr += f.zcr;
  }
  for (let b = 0; b < BANDS; b++) v[b] /= frames.length;
  const mean = v.reduce((a, x) => a + x, 0) / BANDS;
  return { bands: v.map((x) => x - mean), zcr: zcr / frames.length };
}

function utteranceVector(frames) {
  const cut = Math.min(4, Math.max(1, frames.length - 1));
  const onset = stageVector(frames.slice(0, cut));
  const steady = stageVector(frames.slice(cut - 1 > 0 ? cut : 0));
  const out = [
    ...onset.bands.map((x) => x * ONSET_WEIGHT),
    ...steady.bands,
    onset.zcr * 100 * ZCR_WEIGHT * ONSET_WEIGHT,
    steady.zcr * 100 * ZCR_WEIGHT,
  ];
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function classify(vec) {
  let best = null, bestSim = -2, second = -2;
  for (const sym of SET.symbols) {
    const t = templates && templates[sym];
    if (!t) continue;
    const sim = cosine(vec, t);
    if (sim > bestSim) { second = bestSim; bestSim = sim; best = sym; }
    else if (sim > second) second = sim;
  }
  return { symbol: best, sim: bestSim, margin: bestSim - second };
}

// ---- VAD / segmenter ----

const SENS = { high: 0.005, med: 0.008, low: 0.013 }; // absolute onset RMS floor
let sensName = 'high'; // raw mic gain (no AGC) usually runs quiet — default sensitive

const seg = {
  active: false,
  frames: [],
  onsetT: 0,
  quietFrames: 0,
  refractory: 0,
  classified: false,
  noiseFloor: 0.003,
  peak: 0,    // decaying peak, for the mic debug readout
  runMax: 0,  // energy peak within the current syllable
  dip: false, // inside a dip candidate (possible syllable boundary)
  dipMin: 0,
};

const CLASSIFY_FRAMES = 7;  // ~115 ms at 60 fps — quick utterances are fine
const MIN_FRAMES = 3;       // ~50 ms floor: a crisp "ti" still counts
const END_QUIET_FRAMES = 5; // ~83 ms of quiet ends the utterance
const REFRACTORY_FRAMES = 3; // ~50 ms before the next can start
// Rapid speech never goes quiet between syllables — it dips. A drop below
// DIP_RATIO of the syllable's peak followed by a rise re-opens a new
// utterance immediately (no refractory): boundaries index on volume dips.
const DIP_RATIO = 0.5;
const RISE_RATIO = 2.1;

function frameLoop() {
  if (!micOK) return;
  processFrame(readFrame());
  requestAnimationFrame(frameLoop);
}

function processFrame(f) {
  updateLevel(f.rms);

  const sens = SENS[sensName] || SENS.high;
  const onsetThresh = Math.max(seg.noiseFloor * 4, sens);
  const endThresh = Math.max(seg.noiseFloor * 2, sens * 0.55);
  if (f.rms > seg.peak) seg.peak = f.rms;
  seg.peak *= 0.995;

  if (!seg.active) {
    if (seg.refractory > 0) seg.refractory--;
    else if (f.rms > onsetThresh) {
      startSyllable(f);
    } else {
      seg.noiseFloor = seg.noiseFloor * 0.98 + f.rms * 0.02;
    }
    return;
  }

  seg.frames.push(f);
  if (f.rms > seg.runMax) seg.runMax = f.rms;
  if (f.rms < endThresh) seg.quietFrames++;
  else seg.quietFrames = 0;

  // Early classification: steady-state sounds don't need the whole
  // utterance — this is where the latency win comes from.
  if (!seg.classified && seg.frames.length >= CLASSIFY_FRAMES) {
    seg.classified = true;
    emitUtterance();
  }

  // Dip boundary: energy fell well off the syllable peak and is rising
  // again — rapid speech, next syllable starting. No refractory.
  if (!seg.dip && seg.frames.length >= MIN_FRAMES && f.rms < seg.runMax * DIP_RATIO) {
    seg.dip = true;
    seg.dipMin = f.rms;
  }
  if (seg.dip) {
    if (f.rms < seg.dipMin) seg.dipMin = f.rms;
    if (f.rms > Math.max(seg.dipMin * RISE_RATIO, onsetThresh)) {
      if (!seg.classified && seg.frames.length >= MIN_FRAMES) {
        seg.classified = true;
        emitUtterance();
      }
      if (run && run.started && run.keylog.length) {
        const last = run.keylog[run.keylog.length - 1];
        if (last.t_keyup_ms === null) last.t_keyup_ms = f.t - run.t0;
      }
      startSyllable(f); // the rise is the next syllable's onset
      return;
    }
  }

  if (seg.quietFrames >= END_QUIET_FRAMES) {
    if (!seg.classified && seg.frames.length - seg.quietFrames >= MIN_FRAMES) {
      seg.classified = true;
      emitUtterance();
    }
    finishUtterance(f.t);
  }
}

function startSyllable(f) {
  seg.active = true;
  seg.frames = [f];
  seg.onsetT = f.t;
  seg.quietFrames = 0;
  seg.classified = false;
  seg.runMax = f.rms;
  seg.dip = false;
  seg.dipMin = 0;
}

function emitUtterance() {
  const vec = utteranceVector(seg.frames);
  if (state === 'calib') {
    calibCapture(vec);
    return;
  }
  if (!templates) return;
  const c = classify(vec);
  if (c.symbol === null) return;
  onVoice(c.symbol, c.sim, c.margin, seg.onsetT);
}

function finishUtterance(t) {
  seg.active = false;
  seg.refractory = REFRACTORY_FRAMES;
  seg.dip = false;
  seg.runMax = 0;
  // keyup analog: utterance end timestamp onto the last logged selection.
  if (run && run.started && run.keylog.length) {
    const last = run.keylog[run.keylog.length - 1];
    if (last.t_keyup_ms === null) last.t_keyup_ms = t - run.t0;
  }
}

function updateLevel(rms) {
  const pct = Math.min(100, Math.round((rms / 0.06) * 100));
  document.documentElement.style.setProperty('--level', pct + '%');
  const bar = $('calib-level-bar');
  if (state === 'calib' && bar) bar.style.width = pct + '%';
}

// ---- calibration ----

const CALIB_TAKES = 3;
let calib = null; // {idx, take, takes: {symbol: [vec,...]}}

function startCalibration() {
  calib = { idx: 0, take: 0, takes: {} };
  setState('calib');
  renderCalib();
}

function renderCalib() {
  for (const b of $('calib-seg-set').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === setName);
  }
  const sym = SET.symbols[calib.idx];
  const useLanes = SET.symbols.length <= MAX_LANES;
  $('calib-symbol').hidden = useLanes;
  $('calib-lanes').hidden = !useLanes;
  if (useLanes) {
    // Calibrate on the tracks: the symbol sits on its own lane, so the
    // ladder is visible while you record — pitch neighbors apart and the
    // recognizer hears it (F0 lands in the low spectral bands).
    const wrap = $('calib-lanes');
    const K = SET.symbols.length;
    wrap.innerHTML = '';
    for (let l = 0; l < K; l++) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      const laneSym = SET.symbols[K - 1 - l];
      if (laneSym === sym) lane.classList.add('calib-active');
      const label = document.createElement('span');
      label.className = 'lane-label';
      label.textContent = laneSym;
      lane.appendChild(label);
      wrap.appendChild(lane);
    }
    const note = document.createElement('span');
    note.className = 'note cur';
    note.id = 'calib-note';
    note.textContent = sym;
    note.style.left = '150px';
    note.style.top = ((K - 1 - SET.symbols.indexOf(sym)) * 46 + 23) + 'px';
    wrap.appendChild(note);
  } else {
    $('calib-symbol').textContent = sym;
    $('calib-symbol').classList.remove('captured');
  }
  $('calib-progress').textContent =
    'sound ' + (calib.idx + 1) + ' / ' + SET.symbols.length +
    ' · take ' + (calib.take + 1) + ' / ' + CALIB_TAKES +
    (SET.note ? ' · ' + SET.note : '');
}

function calibCapture(vec) {
  const sym = SET.symbols[calib.idx];
  (calib.takes[sym] = calib.takes[sym] || []).push(vec);
  $('calib-symbol').classList.add('captured');
  const note = $('calib-note');
  if (note) note.classList.add('captured');
  calib.take++;
  if (calib.take >= CALIB_TAKES) {
    calib.take = 0;
    calib.idx++;
  }
  if (calib.idx >= SET.symbols.length) {
    const map = {};
    for (const [sym2, takes] of Object.entries(calib.takes)) {
      const dim = takes[0].length;
      const avg = new Array(dim).fill(0);
      for (const t of takes) for (let i = 0; i < dim; i++) avg[i] += t[i];
      const norm = Math.hypot(...avg) || 1;
      map[sym2] = avg.map((x) => x / norm);
    }
    saveTemplates(map);
    templates = map;
    setTimeout(() => toPractice(), 350);
    return;
  }
  setTimeout(renderCalib, 350);
}

$('calib-restart').addEventListener('click', () => startCalibration());

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
  renderStream();
  renderHud();
}

function setState(next) {
  state = next;
  document.body.classList.toggle('armed', next === 'armed');
  overlay.hidden = next !== 'error';
  resultsEl.hidden = next !== 'done';
  $('stage').hidden = next === 'done' || next === 'calib';
  $('calib').hidden = next !== 'calib';
  $('hud').hidden = next === 'done' || next === 'calib';
  $('corner').hidden = next === 'done' || next === 'calib';
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
      '<span class="act armed-note">your first sound starts the 60 s clock</span>' +
      '<span class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</span>';
  } else if (next === 'scored') {
    modeBanner.textContent = 'scored run';
    modeBanner.className = 'mode-scored';
    modeHelp.innerHTML = '';
  }
}

// ---- stream display: chips row, or lanes (position IS the symbol) ----

function renderStream() {
  const lanes = effectiveDisplay() === 'lanes';
  $('chips').hidden = lanes;
  $('lanes').hidden = !lanes;
  if (lanes) renderLanes();
  else renderChips();
}

function renderChips() {
  const wrap = $('chips');
  wrap.innerHTML = '';
  const from = Math.max(0, run.pos - 2);
  const to = Math.min(run.seq.length, run.pos + LOOKAHEAD + 1);
  for (let i = from; i < to; i++) {
    const el = document.createElement('span');
    const sym = SET.symbols[run.seq[i]];
    el.textContent = sym;
    let cls = 'chip';
    if (i < run.pos) cls += run.doneOk && run.doneOk[i] ? ' done-ok' : ' done-err';
    else if (i === run.pos) cls += ' cur';
    if (i > from && run.seq[i] === run.seq[i - 1] && i >= run.pos) cls += ' rpt';
    el.className = cls;
    wrap.appendChild(el);
  }
}

// Lanes: one row per symbol; upcoming notes sit at their symbol's row and
// flow toward the now-line as you go. Solfège reads like a staff (do at
// the bottom). Still self-paced — advance on selection only (spec §7).
const NOTE_X0 = 214, NOTE_DX = 92; // now-line x; done slots sit left of it

function renderLanes() {
  const wrap = $('lanes');
  const K = SET.symbols.length;
  wrap.innerHTML = '';
  for (let l = 0; l < K; l++) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    const label = document.createElement('span');
    label.className = 'lane-label';
    label.textContent = SET.symbols[K - 1 - l]; // bottom lane = symbol 0 (do)
    lane.appendChild(label);
    wrap.appendChild(lane);
  }
  const now = document.createElement('div');
  now.className = 'now-line';
  wrap.appendChild(now);

  const laneH = 46;
  // The last two selections stay visible left of the now-line, with their
  // verdicts — what you said, whether it landed.
  const from = Math.max(0, run.pos - 2);
  const to = Math.min(run.seq.length, run.pos + LOOKAHEAD + 1);
  for (let i = from; i < to; i++) {
    const symIdx = run.seq[i];
    const doneX = NOTE_X0 - (run.pos - i) * 56; // done slots: 158, 102
    const el = document.createElement('span');
    el.textContent = SET.symbols[symIdx];
    let cls = 'note';
    if (i < run.pos) cls += run.doneOk && run.doneOk[i] ? ' done-ok' : ' done-err';
    else if (i === run.pos) cls += ' cur';
    el.className = cls;
    el.style.left = (i < run.pos ? doneX : NOTE_X0 + (i - run.pos) * NOTE_DX) + 'px';
    el.style.top = ((K - 1 - symIdx) * laneH + laneH / 2) + 'px';
    wrap.appendChild(el);

    // For a miss, also show what the recognizer heard: an outlined dim-red
    // bubble on the HEARD symbol's lane (position is the symbol), with the
    // confidence in small text underneath.
    const h = i < run.pos && run.heardAt && run.heardAt[i];
    if (h) {
      const hb = document.createElement('span');
      hb.className = 'note heard';
      hb.textContent = SET.symbols[h.idx];
      hb.style.left = doneX + 'px';
      hb.style.top = ((K - 1 - h.idx) * laneH + laneH / 2) + 'px';
      const conf = document.createElement('span');
      conf.className = 'conf-sub';
      conf.textContent = h.conf.toFixed(2);
      hb.appendChild(conf);
      wrap.appendChild(hb);
    }
  }
}

// ---- selection: one classified utterance ----

function onVoice(symbol, sim, margin, onsetT) {
  if (state !== 'practice' && state !== 'armed' && state !== 'scored') return;
  if (run.scored && run.started && onsetT - run.t0 >= DURATION_MS) return;

  clearEscPending();
  if (!run.started) {
    run.started = true;
    run.t0 = onsetT;
    if (!run.scored) {
      modeBanner.className = 'mode-practice-live';
    } else {
      setState('scored');
      endTimer = setTimeout(endScoredRun, run.t0 + DURATION_MS - performance.now());
    }
  }
  const t = onsetT - run.t0;
  const heardIdx = SET.symbols.indexOf(symbol);
  const expectedIdx = run.seq[run.pos];
  const verdict = heardIdx === expectedIdx;
  const conf = Math.round(margin * 1000) / 1000;

  run.doneOk = run.doneOk || {};
  run.doneOk[run.pos] = verdict;
  if (verdict) run.sc++;
  else {
    run.si++;
    run.heardAt = run.heardAt || {};
    run.heardAt[run.pos] = { idx: heardIdx, conf };
  }

  run.keylog.push({
    i: run.keylog.length,
    key: String(heardIdx),
    expected: String(expectedIdx),
    verdict,
    conf,
    t_shown_ms: run.shownAt[run.pos] ?? 0,
    t_pressed_ms: t,
    t_keyup_ms: null,
  });

  $('heard-text').innerHTML = 'heard <b>' + symbol + '</b> ' +
    (margin < 0.08 ? '<span class="lowconf">(low confidence ' + conf + ')</span>'
      : '(' + conf + ')');

  run.pos++;
  run.shownAt[run.pos] = t;
  if (run.pos >= run.seq.length) {
    if (!run.scored) toPractice();
    return;
  }
  renderStream();
}

// ---- keyboard: arm / abort / sheet ----

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  if (state === 'done' || state === 'error') {
    if (e.key === 'Enter') { e.preventDefault(); armScoredRun(); }
    else if (e.key === 'Escape') { e.preventDefault(); toPractice(); }
    return;
  }
  if (state === 'loading') return;
  if (state === 'calib') {
    if (e.key === 'Escape' && loadTemplates()) { e.preventDefault(); templates = loadTemplates(); toPractice(); }
    return;
  }
  if (e.key === 'Enter') {
    if (sheetOpen) { e.preventDefault(); closeSheet(); return; }
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

modeHelp.addEventListener('click', (e) => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
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
  if (state === 'done' || state === 'calib') return;
  if (!run || !run.started) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? CONFIG.duration_s + 's' : '';
    $('hud-counts').textContent = '';
    $('hud-spark').innerHTML = '';
    return;
  }
  const elapsed = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD stays cumulative — it previews the actual 60 s score.
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    $('hud-counts').textContent = 'Sc ' + run.sc + ' · Si ' + run.si;
    $('hud-spark').innerHTML = '';
    return;
  }
  // Practice: trailing-60 s window + rolling sparkline (shared helpers).
  const tr = window.BitrateResults.trailingBps(run.keylog, BITS, elapsed);
  $('hud-bps').innerHTML = tr.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
  $('hud-time').textContent = Math.floor(elapsed / 1000) + 's practice';
  $('hud-counts').textContent = 'Sc ' + tr.sc + ' · Si ' + tr.si + ' · 60s';
  $('hud-spark').innerHTML = window.BitrateResults.sparkHTML(run.keylog, BITS, elapsed);
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
    '<div class="res-title">voice babble (' + SET.label + ') · scored run — ' + CONFIG.duration_s + ' s</div>' +
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
  for (const b of $('seg-set').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === setName);
  }
  $('row-display').hidden = SET.symbols.length > MAX_LANES;
  for (const b of $('seg-display').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === effectiveDisplay());
  }
  for (const b of $('seg-sens').querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === sensName);
  }
  $('sheet-info').textContent =
    'N=' + N + ' · ' + BITS.toFixed(2) + ' bits/selection · ' + (SET.note || '') +
    ' · changes restart the bout';
}

function selectSet(name) {
  if (!SETS[name]) return;
  setName = name;
  try { localStorage.setItem(SET_KEY, setName); } catch { /* fine */ }
  buildConfig();
  syncSheet();
  templates = loadTemplates();
  if (!templates) startCalibration();
  else toPractice();
}

$('seg-set').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  selectSet(b.dataset.v);
});

$('calib-seg-set').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  selectSet(b.dataset.v); // uncalibrated set -> calibration restarts for it
});

$('seg-display').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  display = b.dataset.v;
  try { localStorage.setItem(DISPLAY_KEY, display); } catch { /* fine */ }
  buildConfig();
  syncSheet();
  toPractice(); // display is part of the config -> new variant
});

$('seg-sens').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  sensName = b.dataset.v;
  try { localStorage.setItem(SENS_KEY, sensName); } catch { /* fine */ }
  buildConfig();
  syncSheet();
  toPractice();
});

// Live mic readout while the sheet is open — shows whether "didn't
// register" is a level problem (peak below threshold) at a glance.
setInterval(() => {
  if (!sheetOpen || !micOK) return;
  const sens = SENS[sensName] || SENS.high;
  $('mic-stats').textContent =
    'mic: noise ' + seg.noiseFloor.toFixed(4) +
    ' · peak ' + seg.peak.toFixed(3) +
    ' · trigger ' + Math.max(seg.noiseFloor * 4, sens).toFixed(4);
}, 400);

$('recalibrate').addEventListener('click', () => {
  closeSheet();
  startCalibration();
});

$('gear').addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  sheetOpen ? closeSheet() : openSheet();
});

// ---- debug hook: lets the synthetic harness drive the recognizer path
// without a microphone (spec §3a — correctness only, never ranking; runs
// from headless browsers are excluded from the leaderboard anyway). ----

window.voiceDebug = {
  calibrateFake() {
    const map = {};
    SET.symbols.forEach((sym, i) => {
      const v = new Array(VEC_DIM).fill(0);
      v[i % BANDS] = 1; // orthogonal-ish
      v[BANDS + ((i + 7) % BANDS)] = 0.6;
      const norm = Math.hypot(...v);
      map[sym] = v.map((x) => x / norm);
    });
    saveTemplates(map);
    templates = map;
    return Object.keys(map).length;
  },
  say(symbol) {
    const t = templates && templates[symbol];
    if (!t) return 'no template';
    const vec = t.map((x) => x + (Math.random() - 0.5) * 0.02);
    const c = classify(vec);
    onVoice(c.symbol, c.sim, c.margin, performance.now());
    return c.symbol;
  },
  classify,
  processFrame,
  state: () => state,
};

// ---- boot ----

loadSettings();
buildConfig();
scheduleFlush(1500);
templates = loadTemplates();
micInit();
if (!templates) {
  startCalibration();
  // startRun is deferred until calibration completes (calibCapture).
} else {
  startRun(false).catch(showError);
}
