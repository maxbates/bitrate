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
};

const SET_KEY = 'bitrate_voice_set_v1';
const DISPLAY_KEY = 'bitrate_voice_display_v1';
const SENS_KEY = 'bitrate_voice_sens_v1';
const TEMPLATES_KEY = 'bitrate_voice_templates_v1';
const LEVEL_KEY = 'bitrate_voice_level_v1';
const MAX_LANES = 9; // beyond this, lanes stop being readable

let setName = 'solfege'; // do–ti is the default set
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
  if (v && (v === 'auto' || SENS[v])) sensName = v;
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
    segmentation: 'dip-v2',
    vad_sensitivity: sensName,
    error_policy: 'advance',
    backspace: false,
    duration_s: 60,
    hud_position: 'corner',
    font_stack: 'system-mono',
  };
  DURATION_MS = CONFIG.duration_s * 1000;
  renderCfg();
}

// ---- templates ----

function loadTemplates() {
  try {
    const all = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '{}');
    if (all.timing !== 3) return null; // recalibrate after VAD/timing changes
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
  all.timing = 3;
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
let micStarting = false;
let bandBins = null; // [ [startBin, endBin), ... ]
let freqBuf = null, timeBuf = null;

// Idempotent: safe to call at boot (desktop) or from the touch gate's tap.
// On iOS both getUserMedia and the AudioContext must originate inside a user
// gesture, so the caller decides when — micInit just does it once.
async function micInit() {
  if (micStarting || micOK) return;
  micStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    audioCtx = new AudioContext();
    // iOS creates the context suspended even inside a gesture until resumed.
    if (audioCtx.state === 'suspended') await audioCtx.resume();
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
  } finally {
    micStarting = false;
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

// Absolute onset RMS floor. These were set against a hot mic; a laptop's
// built-in array with AGC off can peak around 0.01 on a shout, which left the
// old 0.005 "sensitive" floor sitting right at a yell — the meter barely
// reached the trigger line. Dropped ~4× so normal speech clears it with room
// to spare; steady background is rejected by the noise-floor term below, not
// by this number.
const SENS = { high: 0.0012, med: 0.003, low: 0.007 };

// ...and the presets are still a guess that has to fit every mic, every gain
// setting and every room. `auto` (the default) replaces the guess with a
// measurement — see the level check below — and keeps the presets as the
// manual override. A per-player measured number, so it lives in localStorage
// and NOT in the config hash; only the mode name is config (spec §5).
let sensName = 'auto';
let measured = null; // {ambient, speech, thr, snrDb, syllables, at} or null

// The absolute floor in force right now. Auto with nothing measured yet (the
// level check was skipped, or expired) falls back to the middle preset rather
// than the most sensitive one: under double-penalized errors, a missed
// syllable is half the cost of an invented one.
function absFloor() {
  if (sensName === 'auto') return measured ? measured.thr : SENS.med;
  return SENS[sensName] || SENS.med;
}

// Onset trigger = the higher of a multiple of the tracked noise floor or the
// preset's absolute floor. The floor term rejects *steady* background (it can't
// exceed its own adapting floor); the multiple sets how far above it a sound
// must jump to count. 1.8× (was 3×) picks up softer speech — impulsive clicks
// are still dropped downstream by MIN_FRAMES, so this doesn't leak steady
// noise in.
const TRIGGER_MULT = 1.8;
function onsetThreshold() {
  const t = Math.max(seg.noiseFloor * TRIGGER_MULT, absFloor());
  // Same rule as the measured floor, applied to the *live* threshold: never
  // above a level the player's voice was measured actually reaching. In a loud
  // or AGC-flattened room the adaptive term climbs past their own volume — the
  // floor tracks the din, the din is close to the voice, and the game goes
  // deaf with the meter looking healthy. The measurement is the one thing that
  // gives us a real upper bound, so use it.
  const ceiling = sensName === 'auto' && measured && measured.speech > 0
    ? measured.speech * NOISY_MAX_FRAC
    : Infinity;
  return Math.min(t, ceiling);
}

// The noise floor gates itself: every non-triggering frame used to be folded
// into it at one rate, so a sound that ramped in under the trigger dragged the
// floor up, which raised the trigger, which let the next (louder) frame stay
// sub-threshold — a ratchet that ends with even a yell failing to register.
// Rise slowly (~4 s), fall fast (~0.3 s), and cap it: a real room settles in a
// few seconds, but one loud unrecognized utterance can't move it far.
const NOISE_RISE = 0.004;
const NOISE_FALL = 0.05;
const NOISE_MAX = 0.02;

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

// >= 0 while buffered frames are being pushed back through this same state
// machine to count syllables (see replaySyllables). The count has to come from
// the *live* segmenter, not a reimplementation of it, or "heard 5 of 5" would
// be a claim about code that doesn't run during the game.
let replayCount = -1;
const replaying = () => replayCount >= 0;

function processFrame(f) {
  if (!replaying()) {
    updateLevel(f.rms);
    if (state === 'level') { levelFrame(f); return; }
  }

  const sens = absFloor();
  const onsetThresh = onsetThreshold();
  const endThresh = Math.max(seg.noiseFloor * 1.6, sens * 0.5);
  if (f.rms > seg.peak) seg.peak = f.rms;
  seg.peak *= 0.995;

  if (!seg.active) {
    if (seg.refractory > 0) seg.refractory--;
    else if (f.rms > onsetThresh) {
      startSyllable(f);
    } else {
      const rate = f.rms > seg.noiseFloor ? NOISE_RISE : NOISE_FALL;
      seg.noiseFloor = Math.min(NOISE_MAX, seg.noiseFloor + (f.rms - seg.noiseFloor) * rate);
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
      if (!replaying() && run && run.started && run.keylog.length) {
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
  if (replaying()) { replayCount++; return; } // counting only — no classify, no selection
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
  if (!replaying() && run && run.started && run.keylog.length) {
    const last = run.keylog[run.keylog.length - 1];
    if (last.t_keyup_ms === null) last.t_keyup_ms = t - run.t0;
  }
}

function updateLevel(rms) {
  // Scale the meter to the live trigger: the threshold line sits at the 50%
  // midpoint, so a sound clears the middle exactly when it will register, and
  // steady background rides visibly below the line. (2× headroom above the
  // trigger pins the bar full — this is a "am I over the line" meter, not a VU.)
  const thr = onsetThreshold();
  const pct = Math.max(0, Math.min(100, Math.round((rms / thr) * 50)));
  document.documentElement.style.setProperty('--level', pct + '%');
  const bar = $('calib-level-bar');
  if (state === 'calib' && bar) bar.style.width = pct + '%';
}

// ---- mic level check (spec §5) ----
//
// The onset floor is not a constant to be guessed once for every mic and every
// room; it is a property of this mic in this room, measurable in four seconds:
// a silent window gives the room, a counted phrase gives the voice, and the
// trigger goes at the log-midpoint between them. Runs before symbol
// calibration — templates recorded through a wrong trigger are captured off
// noise-opened segments and are worse than useless.

const LV = {
  // A Bluetooth headset switches profile when the stream opens and needs a
  // second or so before its levels mean anything; 500 ms measured the settling
  // transient as if it were the room.
  SETTLE_MS: 1200,
  AMBIENT_MS: 1200,
  SPEAK_MAX_MS: 5000,
  PHRASE: ['one', 'two', 'three', 'four', 'five'],
  // Counting: everyone already owns the cadence, it needs no reading, it is
  // five discrete syllables with voiced onsets, and it works in any accent.
  END_QUIET_MS: 700,  // this much quiet after real speech ends the window early
  MIN_VOICED: 20,     // ~330 ms clearly above the room before the window may end early
  MIN_HEARD: 6,       // ~100 ms above the room before we believe the mic works at all
};

// Trigger placement. Must clear the room (multiplicatively — the VAD works in
// amplitude) and sit under the quietest syllable; 0.28 is ~11 dB below the
// voiced peak, where an unstressed syllable and an onset ramp live.
const AMB_MULT = 2.5;
const SPEECH_FRAC = 0.28;
// Hard ceiling on the trigger, as a fraction of the voiced peak we just
// measured. A threshold ABOVE a level the player's voice actually reached is
// not "strict", it is dead: nothing they do can ever register. The noisy
// fallback below could produce exactly that — at 5 dB of headroom
// `ambient·2.5` works out to 1.4× the voice — which is how an AirPods user
// ended up with a mic check that never heard them.
const NOISY_MAX_FRAC = 0.55;
// If the dedicated silent window reads this much hotter than the gaps inside
// the phrase, the capture chain is running its own gain control (see below).
const PROCESSED_DB = 5;
// A stale threshold from a different room is worse than none, and re-measuring
// costs four seconds — so it expires rather than following the player around.
const LEVEL_MAX_AGE_MS = 6 * 3600 * 1000;

let lvl = null; // {phase, t0, ambient: [], speech: [], next, ...}

function loadLevel() {
  try {
    const m = JSON.parse(localStorage.getItem(LEVEL_KEY) || 'null');
    if (!m || m.v !== 1 || !(m.thr > 0)) return null;
    // Date.now() only stamps the measurement's age — all run timing is still
    // performance.now(); a wall clock never touches the scoring path.
    if (!(Date.now() - m.at < LEVEL_MAX_AGE_MS)) return null;
    return m;
  } catch { return null; }
}

function saveLevel(m) {
  try { localStorage.setItem(LEVEL_KEY, JSON.stringify(Object.assign({ v: 1, at: Date.now() }, m))); }
  catch { /* fine */ }
}

const dbfs = (r) => 20 * Math.log10(Math.max(r, 1e-7));
const DB_FLOOR = -66;
const dbPct = (r) => Math.max(0, Math.min(100, ((dbfs(r) - DB_FLOOR) / -DB_FLOOR) * 100));

function pctl(xs, p) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

function median(xs) {
  return pctl(xs, 0.5);
}

// The typical voiced peak, not the single loudest sample: median of the top
// decile. One door slam shouldn't define how loud the player is.
function voicedLevel(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return median(s.slice(Math.floor(s.length * 0.9)));
}

function startLevelCheck(next) {
  lvl = {
    phase: 'settle', t0: 0, ambient: [], speech: [],
    ambRef: 0, voiced: 0, lastVoicedT: 0, result: null,
    next: next || afterLevel,
  };
  setState('level');
  const bar = $('lv-meter-bar');
  if (bar) bar.style.width = '0';
  renderLevelPanel();
}

// Leaving without measuring. Auto with nothing measured falls back to the
// middle preset, so a skip degrades to the old behaviour rather than trapping
// anyone — which matters most when the mic is dead, since the panel would
// otherwise sit at "quiet for a moment" forever.
function skipLevelCheck() {
  if (!lvl) return;
  if (lvl.autoTimer) clearTimeout(lvl.autoTimer);
  const next = lvl.next;
  lvl = null;
  next();
}

// Called from processFrame while state === 'level'.
function levelFrame(f) {
  if (!lvl) return;
  if (!lvl.t0) lvl.t0 = f.t;
  const bar = $('lv-meter-bar');
  if (bar) bar.style.width = dbPct(f.rms).toFixed(1) + '%';

  if (lvl.phase === 'settle') {
    if (f.t - lvl.t0 >= LV.SETTLE_MS) { lvl.phase = 'ambient'; lvl.t0 = f.t; renderLevelPanel(); }
    return;
  }
  if (lvl.phase === 'ambient') {
    lvl.ambient.push(f);
    if (f.t - lvl.t0 >= LV.AMBIENT_MS) {
      lvl.ambRef = Math.max(median(lvl.ambient.map((x) => x.rms)), 1e-6);
      lvl.phase = 'speak';
      lvl.t0 = f.t;
      renderLevelPanel();
    } else {
      const left = Math.ceil((LV.AMBIENT_MS - (f.t - lvl.t0)) / 1000);
      if (left !== lvl.shownLeft) { // once a second, not once a frame
        lvl.shownLeft = left;
        $('lv-prompt').innerHTML = '<span class="quiet">listening to the room… ' + left + '</span>';
      }
    }
    return;
  }
  if (lvl.phase === 'speak') {
    lvl.speech.push(f);
    if (f.rms > lvl.ambRef * 3) { lvl.voiced++; lvl.lastVoicedT = f.t; }
    // End as soon as the phrase is clearly over, rather than making everyone
    // sit through the full window.
    const done = lvl.voiced >= LV.MIN_VOICED && f.t - lvl.lastVoicedT > LV.END_QUIET_MS;
    if (done || f.t - lvl.t0 >= LV.SPEAK_MAX_MS) finishLevelCheck();
  }
}

// Push the buffered frames back through the live segmenter with a candidate
// threshold and count what it would have opened. `seg` is saved and restored
// so the real state machine is untouched.
function replaySyllables(frames, thr, ambient, speech) {
  const savedSeg = Object.assign({}, seg);
  const savedMeasured = measured, savedSens = sensName;
  sensName = 'auto';
  // `speech` too, so the replay sees the same voice-derived ceiling in
  // onsetThreshold() that the live run will — otherwise the syllable count is
  // measuring a threshold the game won't actually use.
  measured = { thr, speech };
  Object.assign(seg, {
    active: false, frames: [], onsetT: 0, quietFrames: 0, refractory: 0,
    classified: false, noiseFloor: Math.min(NOISE_MAX, ambient), peak: 0,
    runMax: 0, dip: false, dipMin: 0,
  });
  replayCount = 0;
  for (const f of frames) processFrame(f);
  // A syllable still open at the end of the buffer counts if it got far enough
  // to have been classified live.
  if (seg.active && !seg.classified && seg.frames.length >= MIN_FRAMES) replayCount++;
  const n = replayCount;
  replayCount = -1;
  Object.assign(seg, savedSeg);
  measured = savedMeasured;
  sensName = savedSens;
  return n;
}

// Turn the two windows into a threshold. Pure, so voiceDebug can exercise it.
function deriveThreshold(ambient, speech) {
  const lo = ambient * AMB_MULT;    // must clear the room
  const hi = speech * SPEECH_FRAC;  // must sit under the quietest syllable
  // When the band inverts, the room is too loud relative to the voice. Erring
  // toward a missed syllable rather than an invented selection is the right
  // direction under double-penalized errors — but only up to a point, and the
  // first cut of this had no such point. `lo` alone can land above the voiced
  // peak (at 5 dB headroom it is 1.4× it), and a trigger the voice cannot
  // reach doesn't make the game strict, it makes it deaf. Cap it so a
  // full-volume syllable always clears: some false triggers in a loud room are
  // recoverable — the player hears them and moves — while total silence is not.
  const noisy = !(hi > lo);
  const thr = noisy
    ? Math.min(lo, speech * NOISY_MAX_FRAC)
    : Math.min(Math.max(Math.sqrt(ambient * speech), lo), hi);
  return { thr, noisy, snrDb: dbfs(speech) - dbfs(ambient) };
}

// Pure over its frame buffers (replaySyllables saves and restores `seg`), so
// the synthetic harness can exercise the whole measurement without a mic.
function computeLevel(ambientFrames, speechFrames) {
  const speechRms = speechFrames.map((f) => f.rms);
  const speech = voicedLevel(speechRms);

  // The room, measured two ways, because they fail in opposite directions.
  //
  //   quiet window — a dedicated 1.2 s of silence. Honest on a plain mic.
  //   phrase gaps  — a low percentile of the *speech* window, which lands in
  //     the four pauses of "one two three four five".
  //
  // The gaps exist because of AirPods. A Bluetooth headset runs over HFP with
  // the OS's own gain control, and `autoGainControl: false` cannot reach it
  // from a web page — the constraint is honoured by the browser, not by the
  // Bluetooth stack. AGC's whole job is to make quiet things loud: through a
  // silent window it winds the gain *up*, so the "room" reads hot, then pulls
  // it down over speech. The two windows are then measured at different gains
  // and the ratio between them is meaningless — squashed toward 1, which is
  // how a user talking loudly into AirPods got 5 dB of headroom and a trigger
  // above their own voice. Reading the room from inside the same window as the
  // voice puts both under the same gain, so the ratio is real again.
  //
  // Take the lower of the two: a room reading that is too low is corrected by
  // the upper clamp and by the live `noiseFloor · TRIGGER_MULT` term, while one
  // that is too high sets the trigger out of the player's reach and the game
  // simply stops responding.
  const quiet = Math.max(median(ambientFrames.map((f) => f.rms)), 1e-6);
  const gaps = Math.max(pctl(speechRms, 0.15), 1e-6);
  const ambient = Math.max(Math.min(quiet, gaps), 1e-6);
  // A silent window much hotter than the pauses in continuous speech is the
  // AGC signature. Worth naming, because "move somewhere quieter" is actively
  // wrong advice for someone sitting in a silent room wearing earbuds.
  const processed = dbfs(quiet) - dbfs(gaps) > PROCESSED_DB;

  const d = deriveThreshold(ambient, speech);

  // "Did anything reach the mic" is a *separate*, gentler question from "has
  // the phrase finished" (LV.MIN_VOICED, 3x, used only to end the window
  // early). Sharing one gate made a merely noisy room — where the voice sits
  // only ~10 dB over the din, so few frames clear 3x — report itself as a dead
  // microphone, which is the wrong advice entirely.
  //
  // Ask it against the threshold we just derived rather than a fixed multiple
  // of the room: those are the same question ("will this player's voice
  // register?"), and any fixed multiple repeats the original mistake — at 5 dB
  // of headroom even `ambient · 2` sits above the voice, so a perfectly
  // audible speaker was written off as a dead mic.
  const heard = speechFrames.filter((f) => f.rms > d.thr).length;
  const heardNothing = heard < LV.MIN_HEARD || speech <= ambient * 1.5;
  const syllables = heardNothing ? 0 : replaySyllables(speechFrames, d.thr, ambient, speech);
  return {
    ambient, speech, thr: d.thr, snrDb: d.snrDb, syllables,
    noisy: d.noisy, heardNothing, processed, quiet, gaps,
    clean: !heardNothing && !d.noisy && syllables === LV.PHRASE.length,
  };
}

function finishLevelCheck() {
  lvl.result = computeLevel(lvl.ambient, lvl.speech);
  lvl.phase = 'result';
  renderLevelPanel();
  if (lvl.result.clean) lvl.autoTimer = setTimeout(acceptLevel, 1400);
}

function acceptLevel() {
  if (!lvl || !lvl.result) return;
  if (lvl.autoTimer) { clearTimeout(lvl.autoTimer); lvl.autoTimer = null; }
  const r = lvl.result;
  const next = lvl.next;
  if (!r.heardNothing) {
    measured = { ambient: r.ambient, speech: r.speech, thr: r.thr, snrDb: r.snrDb, syllables: r.syllables };
    saveLevel(measured);
    measured = loadLevel() || measured;
    // The tracker starts at the room we just measured instead of walking to it
    // from a hardcoded 0.003.
    seg.noiseFloor = Math.min(NOISE_MAX, r.ambient);
  }
  lvl = null;
  next();
}

function afterLevel() {
  if (!templates) startCalibration();
  else toPractice();
}

function renderLevelPanel() {
  const step = $('lv-step'), prompt = $('lv-prompt');
  const readout = $('lv-readout'), foot = $('lv-foot'), meter = $('lv-meter');
  meter.classList.remove('has-trigger');
  readout.innerHTML = '';
  foot.innerHTML = '';
  if (!lvl) return;

  // A tappable skip, not just Esc: the device most likely to have a mic
  // problem is the one without a keyboard.
  const skipBtn = '<button type="button" class="act click" id="lv-skip"><kbd>Esc</kbd>skip</button>';

  if (lvl.phase === 'settle' || lvl.phase === 'ambient') {
    step.textContent = 'step 1 of 2 · the room';
    prompt.innerHTML = '<span class="quiet">quiet for a moment…</span>';
    readout.innerHTML = 'measuring the background noise you\'re playing over';
    foot.innerHTML = skipBtn;
    return;
  }
  if (lvl.phase === 'speak') {
    step.textContent = 'step 2 of 2 · your voice';
    prompt.innerHTML = LV.PHRASE.map((w) => '<span class="count">' + w + '</span>').join('');
    readout.innerHTML = 'say it out loud, evenly, at the volume you\'ll play at';
    foot.innerHTML = skipBtn;
    return;
  }

  const r = lvl.result;
  step.textContent = 'result';
  meter.classList.add('has-trigger');
  document.documentElement.style.setProperty('--lv-trigger', dbPct(r.thr).toFixed(1) + '%');

  if (r.heardNothing) {
    prompt.innerHTML = '<span class="quiet">didn\'t hear you</span>';
    readout.innerHTML = '<span class="warn">nothing came through above the room noise</span><br>' +
      'check the right microphone is selected and that it isn\'t muted, then try again';
  } else {
    prompt.innerHTML = r.clean
      ? '<span class="quiet">✓ ready</span>'
      : '<span class="quiet">have another go</span>';
    const counted = r.syllables === LV.PHRASE.length
      ? '<span class="ok">heard ' + r.syllables + ' of ' + LV.PHRASE.length + ' words</span>'
      : '<span class="warn">heard ' + r.syllables + ' of ' + LV.PHRASE.length + ' words</span>';
    readout.innerHTML =
      'room <b>' + dbfs(r.ambient).toFixed(0) + ' dB</b>' +
      ' · voice <b>' + dbfs(r.speech).toFixed(0) + ' dB</b>' +
      ' · headroom <b>' + r.snrDb.toFixed(0) + ' dB</b><br>' +
      'trigger set to <b>' + dbfs(r.thr).toFixed(0) + ' dB</b> · ' + counted +
      (r.noisy && r.processed
        // Naming the cause matters: this player is usually in a silent room,
        // and telling them to find a quieter one sends them chasing nothing.
        ? '<br><span class="warn">your microphone is doing its own noise processing — common on Bluetooth headsets like AirPods, and it flattens the gap between your voice and the room.</span>' +
          '<br>using a best-effort trigger. if sounds get missed, switch to the built-in microphone and re-check.'
        : r.noisy
          ? '<br><span class="warn">too much background noise for your voice level — move somewhere quieter, or speak up. quiet sounds may be missed.</span>' +
            '<br>on a Bluetooth headset? the built-in microphone usually does better here.'
          : r.syllables > LV.PHRASE.length
          ? '<br>extra words usually means background noise — try again somewhere quieter'
          : r.syllables < LV.PHRASE.length
            ? '<br>say the words a little louder, with a small gap between each'
            : '');
  }
  foot.innerHTML =
    (r.heardNothing ? '' : '<button type="button" class="act click" id="lv-accept"><kbd>Enter</kbd>use this</button>') +
    '<button type="button" class="act click" id="lv-again">measure again</button>';
}

$('lv-foot').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  b.blur();
  if (b.id === 'lv-accept') acceptLevel();
  else if (b.id === 'lv-skip') skipLevelCheck();
  else if (b.id === 'lv-again') {
    if (lvl && lvl.autoTimer) clearTimeout(lvl.autoTimer);
    startLevelCheck(lvl ? lvl.next : afterLevel);
  }
});

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
    flags: {},
    submitted: false,
  };
  setState(scored ? 'armed' : 'practice');
  renderStream();
  renderHud();
}

// What the settings sheet is currently set to, short enough for the corner.
function configLabel() {
  return SET.label;
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
  $('stage').hidden = next === 'done' || next === 'calib' || next === 'level';
  $('calib').hidden = next !== 'calib';
  $('level').hidden = next !== 'level';
  $('topbar').hidden = next === 'done' || next === 'calib' || next === 'level';
  if (next !== 'practice' && sheetOpen) closeSheet();
  if (next === 'practice') {
    modeBanner.textContent = 'practice';
    modeBanner.className = 'mode-practice';
    renderPracticeHelp();
  } else if (next === 'armed') {
    modeBanner.textContent = 'armed';
    modeBanner.className = 'mode-armed';
    modeHelp.innerHTML =
      '<span class="act armed-note">your first sound starts the 60 s clock</span>' +
      '<button type="button" class="act click" data-act="seed"><kbd>Esc</kbd>back to practice</button>';
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
  if (state === 'level') {
    if (e.key === 'Enter' && lvl && lvl.result && !lvl.result.heardNothing) {
      e.preventDefault();
      acceptLevel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      skipLevelCheck();
    }
    return;
  }
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

// Corner strip in play + the score screen's footer: same buttons, one binder
// (shared with every other environment — see common/results.js). The click is
// also the user gesture that unsuspends audio.
BitrateResults.wireActs({ arm: armScoredRun, seed: toPractice, settings: toggleSheet }, () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
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
  if (state === 'done' || state === 'calib' || state === 'level') return;
  if (!run || !run.started) {
    $('hud-bps').innerHTML = '0.0 <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = state === 'armed' ? CONFIG.duration_s + 's' : '';
    $('hud-counts').textContent = 'N ' + N + ' · Sc 0 · Si 0';
    window.BitrateResults.renderSpark('hud-spark', null, BITS, 0);
    return;
  }
  const elapsed = elapsedMsOf(run);
  if (run.scored) {
    // Scored HUD stays cumulative — it previews the actual 60 s score.
    const cs = scoreWith(run, Math.max(elapsed, 1000) / 1000);
    $('hud-bps').innerHTML = cs.bps.toFixed(1) + ' <span class="hud-unit">bits/s</span>';
    $('hud-time').textContent = Math.max(0, Math.ceil((DURATION_MS - elapsed) / 1000)) + 's';
    $('hud-counts').textContent = 'N ' + (run.n || N) + ' · Sc ' + run.sc + ' · Si ' + run.si;
    window.BitrateResults.renderSpark('hud-spark', run, BITS, elapsed);
    return;
  }
  // Practice: trailing-60 s window + rolling sparkline (shared helpers).
  const tr = window.BitrateResults.trailingBps(run.keylog, BITS, elapsed);
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
  renderCfg();
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
  // Switching to auto with nothing measured (or an expired measurement) runs
  // the check rather than silently sitting on the fallback preset.
  if (sensName === 'auto' && !measured) { closeSheet(); startLevelCheck(toPractice); return; }
  toPractice();
});

$('recheck-level').addEventListener('click', () => {
  closeSheet();
  startLevelCheck(toPractice);
});

// Live mic readout while the sheet is open — shows whether "didn't
// register" is a level problem (peak below threshold) at a glance.
setInterval(() => {
  if (!sheetOpen || !micOK) return;
  const src = sensName !== 'auto' ? 'preset ' + sensName
    : measured ? 'measured ' + measured.snrDb.toFixed(0) + ' dB headroom'
      : 'auto — not measured yet, using ' + SENS.med;
  $('mic-stats').textContent =
    'mic: noise ' + seg.noiseFloor.toFixed(4) +
    ' · peak ' + seg.peak.toFixed(3) +
    ' · trigger ' + onsetThreshold().toFixed(4) + ' (= midline)' +
    ' · floor ' + absFloor().toFixed(4) + ' (' + src + ')';
}, 400);

$('recalibrate').addEventListener('click', () => {
  closeSheet();
  startCalibration();
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

  // ---- level check, without a microphone ----
  // Synthesize an ambient window plus `words` bursts at `speech` RMS and run
  // the real measurement over them: same percentiles, same threshold algebra,
  // same segmenter replay. This is how the level check is regression-tested.
  // `ambientWindow` defaults to `ambient`; set it higher to model a capture
  // chain whose AGC winds the gain up through the silent window and back down
  // over speech (Bluetooth headsets), which is what makes the dedicated quiet
  // window disagree with the pauses inside the phrase.
  measureFake({ ambient = 0.002, speech = 0.05, words = 5, wordMs = 240, gapMs = 140,
                ambientWindow = null } = {}) {
    const dt = 1000 / 60;
    let t = 0;
    const mk = (rms) => ({ rms: Math.max(rms, 1e-7), zcr: 0.05, bands: new Array(BANDS).fill(-60), t: (t += dt) });
    const jitter = () => 0.75 + 0.5 * Math.random();
    const amb = () => mk(ambient * jitter());
    const quietLevel = ambientWindow == null ? ambient : ambientWindow;
    const ambientFrames = [];
    for (let i = 0; i < Math.round(LV.AMBIENT_MS / dt); i++) ambientFrames.push(mk(quietLevel * jitter()));
    const speechFrames = [];
    for (let w = 0; w < words; w++) {
      const n = Math.round(wordMs / dt);
      for (let i = 0; i < n; i++) {
        // Raised-cosine envelope: a real syllable ramps in and out, which is
        // what the dip-based boundary detector keys on.
        const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
        speechFrames.push(mk(ambient + (speech - ambient) * env * jitter()));
      }
      for (let i = 0; i < Math.round(gapMs / dt); i++) speechFrames.push(amb());
    }
    return computeLevel(ambientFrames, speechFrames);
  },
  deriveThreshold,
  measured: () => measured,
  absFloor,
  skipLevel() {
    if (state !== 'level') return 'not in level check';
    skipLevelCheck();
    return 'skipped';
  },
};

// ---- boot ----

loadSettings();
// The header is an in-flow band whose height moves with content and
// viewport; publish it so the play area always starts below it.
window.BitrateResults.trackHeaderHeight();
buildConfig();
scheduleFlush(1500);
templates = loadTemplates();
measured = loadLevel();
if (measured) seg.noiseFloor = Math.min(NOISE_MAX, measured.ambient);

function beginSession() {
  // Level check first: templates recorded through a wrong trigger are captured
  // off noise-opened segments, so measuring after calibrating fixes nothing.
  if (sensName === 'auto' && !measured) {
    startLevelCheck(afterLevel);
  } else if (!templates) {
    startCalibration();
    // startRun is deferred until calibration completes (calibCapture).
  } else {
    startRun(false).catch(showError);
  }
}

// iOS/iPadOS Safari won't grant getUserMedia or unlock a suspended
// AudioContext outside a user gesture, so a boot-time micInit() fails
// there silently. On touch devices, hold behind an explicit tap; desktop
// (fine pointer, no touch points) keeps auto-booting — no extra click.
const NEEDS_GESTURE =
  window.matchMedia('(pointer: coarse)').matches ||
  (navigator.maxTouchPoints || 0) > 1;

if (NEEDS_GESTURE) {
  const gate = $('mic-gate');
  const btn = $('mic-gate-btn');
  const sub = $('mic-gate-sub');
  gate.hidden = false;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'starting…';
    await micInit();
    if (micOK) {
      gate.hidden = true;
      beginSession();
    } else {
      btn.disabled = false;
      btn.textContent = 'try again';
      sub.textContent = 'microphone blocked — allow it in Settings ▸ Safari ▸ Microphone, then tap again';
    }
  });
} else {
  micInit();
  beginSession();
}
