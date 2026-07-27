'use strict';

/* bit-rate gallery + leaderboard (spec §5, §4.4).
 *
 * Everything renders from GET /api/leaderboard: ranked rows, the full run
 * history (progress strips, tile stats — same query, different cuts), and
 * the variant registry. Row expansion fetches /api/runs/{id} and reuses
 * the shared results renderer — one renderer, all call sites.
 */

const $ = (id) => document.getElementById(id);

// One entry per game. `n` and `trait` sit under the title — how many things
// you're choosing between, and what you're choosing with — then the blurb.
const ENV_META = {
  'pixel-lens': {
    name: 'pixel lens',
    n: 'N = your viewport',
    trait: 'mouse',
    desc: 'a target lights up on a huge grid. find it, move to it, click it.',
    href: 'pixel-lens/',
  },
  'drum-pad': {
    name: 'drum pad',
    n: 'N = your viewport',
    trait: 'touchscreen',
    desc: 'tap targets on a large grid.',
    href: 'drum-pad/',
  },
  'stream-typing': {
    name: 'stream typing',
    n: 'N = 27',
    trait: 'keyboard',
    desc: 'self-paced typing, random alphabet. the baseline.',
    href: 'stream-typing/',
  },
  'voice-babble': {
    name: 'voice babble',
    n: 'N = 6–9',
    trait: 'your voice',
    desc: 'calibrate your voice, then sing do re mi. needs a quiet room.',
    href: 'voice-babble/',
  },
  'lane-tap': {
    name: 'lane tap',
    n: 'N = 9–26',
    trait: 'touchscreen',
    desc: 'a strip of lanes along the bottom. tap the lit one; the stack above shows what is coming.',
    href: 'lane-tap/',
  },
  'beat-hands': {
    name: 'beat hands',
    n: 'N = 8–16',
    trait: 'camera, touch or keys',
    desc: 'notes arrive on the beat. cut each one in the direction it points.',
    href: 'beat-hands/',
  },
  'twin-stick': {
    name: 'twin stick',
    n: 'N = 8 per stick',
    trait: 'gamepad',
    desc: 'both thumbsticks at once. on every beat, point each stick where its ribbon says.',
    href: 'twin-stick/',
  },
  'parabola-fall': {
    name: 'parabola fall',
    n: 'N = 7–21',
    trait: 'one thumb',
    desc: 'dots fall into lanes along an arc. slide your thumb so you are in each lane as it lands.',
    href: 'parabola-fall/',
  },
  'word-typing': {
    name: 'word typing',
    n: 'N = 1053 words',
    trait: 'keyboard',
    desc: 'type whole words instead of letters. word-level targets are banned by the brief, so it never counted.',
    href: 'word-typing/',
  },
};

// The games still in the running, in the order they're worth trying.
const FEATURED = ['drum-pad', 'pixel-lens', 'stream-typing', 'voice-babble'];
// The graveyard: built and played, but beaten by something above or ruled out.
// Shown at the bottom of the page and kept out of the leaderboard.
//
// beat-hands is deliberately absent — no card anywhere. The game still exists
// and /env/beat-hands/ still plays; it just isn't offered from this page. Its
// runs stay in the history and the progress strips, and ENV_META keeps its
// entry so anything that does link to it still gets a name.
const GRAVEYARD = ['lane-tap', 'twin-stick', 'parabola-fall', 'word-typing'];
// Deleted outright; their historical runs are filtered from every view.
const HIDDEN_ENVS = new Set(['speech-words']);

// How many ranked rows the board shows per tab.
const BOARD_LIMIT = 10;

const DEVICE_ID = localStorage.getItem('bitrate_device_id') || '';

let DATA = null;
let boardFilter = 'all';
let openDetail = null; // run_id of the expanded row

async function boot() {
  let resp;
  try {
    resp = await fetch('/api/leaderboard');
  } catch {
    resp = null;
  }
  if (!resp || !resp.ok) {
    $('board').innerHTML = '<div class="empty">no data — is this a lab build?</div>';
    renderTiles(null);
    return;
  }
  DATA = await resp.json();
  DATA.rows = DATA.rows || [];
  DATA.history = DATA.history || [];
  DATA.variants = DATA.variants || [];
  DATA.history = DATA.history.filter((h) => !HIDDEN_ENVS.has(h.environment));
  DATA.rows = DATA.rows.filter((r) => !HIDDEN_ENVS.has(r.environment));
  DATA.dom = bpsDomain(DATA);
  renderTiles(DATA);
  renderProgress(DATA);
  renderTabs();
  renderBoard();
}

// ---- helpers ----

// Shared log-scale bps axis (all progress strips and sparklines use the
// same domain — cross-environment comparison is the whole point).
function bpsDomain(data) {
  // Verified runs only: synthetic/headless entries must not stretch the
  // axis. Cap just above the best real observation.
  const vals = data.history.filter((h) => h.verified && h.bps > 0).map((h) => h.bps);
  const lo = Math.max(0.3, Math.min(1, ...vals) * 0.8);
  const hi = Math.max(2, ...vals) * 1.08;
  const ticks = [0.5, 1, 2, 5, 10, 20, 50, 100].filter((t) => t >= lo && t <= hi);
  return { lo, hi, ticks };
}

function yLog(v, lo, hi, top, height) {
  const c = Math.max(v, lo);
  return top + height - ((Math.log(c) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * height;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Which game a run belongs to. Normally that's the environment recorded in its
// config — but pixel lens and drum pad were one environment ('pixel-lens',
// with input as a setting) until they were split into two games, so runs from
// before the split are placed by the input mode their variant was played with.
function envOf(h) {
  const env = h.environment || 'unknown';
  if (env !== 'pixel-lens') return env;
  return variantConfig(h.variant_id).input === 'touch' ? 'drum-pad' : 'pixel-lens';
}

function variantConfig(variantId) {
  const v = (DATA && DATA.variants || []).find((x) => x.config_hash === variantId);
  if (!v) return {};
  return typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
}

// Every game with a card, listed order first, anything unrecognized after.
function knownEnvs(data) {
  const listed = [...FEATURED, ...GRAVEYARD];
  const seen = new Set(listed);
  const extra = [];
  for (const v of data ? data.variants : []) {
    const env = v.environment;
    if (!seen.has(env) && !HIDDEN_ENVS.has(env)) { seen.add(env); extra.push(env); }
  }
  return [...listed, ...extra];
}

// The leaderboard ranks the games still in the running: the graveyard is out,
// and so are environments that no longer exist (their runs stay in the history
// and the progress strips, but there's nothing left to play or rank).
function boardEnvs() { return FEATURED.filter((e) => ENV_META[e]); }
function ranks(env) { return boardEnvs().includes(env); }

function agoFmt(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function configSummary(variantId) {
  const v = (DATA.variants || []).find((x) => x.config_hash === variantId);
  if (!v) return variantId.slice(0, 8);
  const c = typeof v.config === 'string' ? JSON.parse(v.config) : v.config;
  if (v.environment === 'stream-typing') {
    let s = c.alphabet && c.alphabet.length === 26 ? 'a–z'
      : c.alphabet && c.alphabet.length === 36 ? 'a–z 0–9'
      : c.alphabet === 'asdfghjkl' ? 'home row'
      : (c.alphabet || '').length + ' keys';
    s += ' · look ' + c.lookahead;
    if (c.chunk_size) s += ' · chunk ' + c.chunk_size;
    return s;
  }
  if (v.environment === 'pixel-lens' || v.environment === 'drum-pad') {
    return c.cell_mm + ' mm · ' + c.grid_cols + '×' + c.grid_rows;
  }
  if (v.environment === 'voice-babble') {
    return (c.symbol_set || '') + ' · N=' + c.alphabet_size;
  }
  if (v.environment === 'beat-hands') {
    return '2×' + c.directions + ' · ' + c.tempo_npm + '/min · ' + (c.input || 'camera');
  }
  if (v.environment === 'twin-stick') {
    return '2 sticks × ' + c.directions + ' · ' + c.tempo_npm + '/min';
  }
  if (v.environment === 'parabola-fall') {
    return c.lanes + ' lanes · ±' + c.max_step + ' · ' + c.tempo_npm + '/min';
  }
  if (v.environment === 'lane-tap') {
    return c.lanes + ' lanes · look ' + c.look_ahead;
  }
  return variantId.slice(0, 8);
}

// ---- environment tiles (spec §5 gallery) ----

function renderTiles(data) {
  fillCards($('tiles'), FEATURED, data);
  const grave = GRAVEYARD.filter((e) => ENV_META[e]);
  if (grave.length) {
    $('graveyard-section').hidden = false;
    fillCards($('graveyard'), grave, data);
  }
}

function fillCards(wrap, envs, data) {
  wrap.innerHTML = '';
  for (const env of envs) wrap.appendChild(card(env, data));
}

// Title, then what you're choosing between (N) and what you're choosing with,
// then the blurb. Footer: how it has actually gone, and the way in.
function card(env, data) {
  const meta = ENV_META[env] || { name: env, desc: '', href: env + '/' };
  const scored = data ? data.history.filter((h) => envOf(h) === env && h.verified && h.is_scored) : [];
  const best = scored.length ? Math.max(...scored.map((h) => h.bps)) : null;
  const med = median(scored.map((h) => h.bps));
  const el = document.createElement('div');
  el.className = 'tile-env';
  el.innerHTML =
    '<div class="t-name">' + meta.name + '</div>' +
    '<div class="t-n">' + (meta.n || '') + '</div>' +
    '<div class="t-trait">' + (meta.trait || '') + '</div>' +
    '<div class="t-desc">' + meta.desc + '</div>' +
    '<div class="t-foot">' +
    '<span class="t-stats">' +
    stat(scored.length || '—', scored.length === 1 ? 'play' : 'plays') +
    stat(best !== null ? best.toFixed(1) : '—', 'best bps') +
    stat(med !== null ? med.toFixed(1) : '—', 'median bps') +
    '</span>' +
    '<a class="launch" href="' + meta.href + '">play</a>' +
    '</div>';
  return el;
}

function stat(v, l) {
  return '<span class="t-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></span>';
}

// ---- your progress (spec §4.4: bps against run index, per game mode) ----

function renderProgress(data) {
  if (!DEVICE_ID) return;
  const mine = data.history.filter((h) => h.device_id === DEVICE_ID && h.selections >= 10);
  if (mine.length < 2) return;
  $('progress-section').hidden = false;
  const wrap = $('progress');
  wrap.innerHTML = '';
  for (const env of knownEnvs(data)) {
    const runs = mine.filter((h) => envOf(h) === env);
    if (runs.length < 2) continue;
    const fig = document.createElement('figure');
    fig.innerHTML =
      '<figcaption>' + ((ENV_META[env] || {}).name || env) + ' · ' + runs.length +
      ' runs · bits/s, log scale (● scored · ○ practice)</figcaption>' +
      progressSVG(runs);
    wrap.appendChild(fig);
  }
}

function progressSVG(runs) {
  const W = 480, H = 210, PL = 36, PR = 10, PT = 10, PB = 24;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const { lo, hi, ticks } = DATA.dom; // shared across every environment strip
  const x = (i) => PL + (runs.length > 1 ? (i / (runs.length - 1)) * plotW : plotW / 2);
  const y = (v) => yLog(v, lo, hi, PT, plotH);
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img">';
  for (const v of ticks) {
    s += '<line class="grid" x1="' + PL + '" x2="' + (W - PR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    s += '<text class="axis-label" x="' + (PL - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
  }
  s += '<polyline class="data-line" points="' +
    runs.map((r, i) => x(i) + ',' + y(r.bps)).join(' ') + '"/>';
  runs.forEach((r, i) => {
    const fill = r.is_scored ? '' : ' style="fill:none;stroke:#7aa2f7;stroke-width:2"';
    s += '<circle class="data-dot" cx="' + x(i) + '" cy="' + y(r.bps) + '" r="4"' + fill + '>' +
      '<title>run ' + (i + 1) + ' · ' + r.bps.toFixed(2) + ' bits/s · ' +
      (r.is_scored ? 'scored' : 'practice') + ' · ' + agoFmt(r.ended_at) + '</title></circle>';
  });
  s += '<text class="axis-label" x="' + PL + '" y="' + (H - 8) + '">run 1</text>';
  s += '<text class="axis-label" x="' + (W - PR) + '" y="' + (H - 8) + '" text-anchor="end">run ' + runs.length + '</text>';
  return s + '</svg>';
}

// ---- leaderboard ----

function renderTabs() {
  const tabs = ['all', ...boardEnvs()];
  $('board-tabs').innerHTML = tabs.map((t) =>
    '<button data-t="' + t + '"' + (t === boardFilter ? ' class="on"' : '') + '>' +
    ((ENV_META[t] || {}).name || t) + '</button>').join('');
}

$('board-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  boardFilter = b.dataset.t;
  openDetail = null;
  renderTabs();
  renderBoard();
});

function renderBoard() {
  const all = DATA.rows.filter((r) => ranks(envOf(r)))
    .filter((r) => boardFilter === 'all' || envOf(r) === boardFilter);
  // Show only the top BOARD_LIMIT of whatever tab is active — the board is a
  // ranking, not a ledger. The full run history lives in the progress strips
  // and /api/leaderboard; nothing is dropped, only hidden from the table.
  const rows = all.slice(0, BOARD_LIMIT);
  $('board-note').textContent = ' · best verified scored run per player × config' +
    (all.length > rows.length ? ' · top ' + BOARD_LIMIT + ' of ' + all.length : '');
  if (!rows.length) {
    $('board').innerHTML =
      '<div class="empty">no scored runs here yet — arm one from any game (Enter) and claim the top spot.</div>';
    return;
  }
  let html = '<table class="lb"><tr>' +
    '<th></th><th>player</th><th>bits/s</th><th>mode</th><th>config</th><th>acc</th>' +
    '<th>round</th><th>when</th></tr>';
  for (const r of rows) {
    const you = r.device_id === DEVICE_ID ? '<span class="you">you</span>' : '';
    const acc = r.sc + r.si > 0 ? ((100 * r.sc) / (r.sc + r.si)).toFixed(1) + '%' : '—';
    // Which round this score came from: this player's nth run of this game.
    // A top score on someone's 3rd round and one on their 40th are different
    // claims, and the row that makes the claim should say which it is.
    const round = r.round || 0;
    const roundCell = '<td class="round" title="' + (round
      ? 'this player\'s run #' + round + ' of this game (practice and scored)' +
        (r.scored_round ? ' · their scored run #' + r.scored_round : '')
      : 'unknown') + '">' + (round ? '#' + round : '—') + '</td>';
    html += '<tr class="row" data-run="' + r.run_id + '" data-variant="' + r.variant_id + '" data-env="' + envOf(r) + '">' +
      '<td class="rank">' + r.rank + '</td>' +
      '<td><span class="player">' + r.pseudonym + '</span>' + you + '</td>' +
      '<td class="bps">' + r.bps.toFixed(2) + '</td>' +
      '<td>' + ((ENV_META[envOf(r)] || {}).name || envOf(r)) + '</td>' +
      '<td>' + configSummary(r.variant_id) + '</td>' +
      '<td>' + acc + '</td>' +
      roundCell +
      '<td>' + agoFmt(r.ended_at) + '</td></tr>';
    if (openDetail === r.run_id) {
      html += '<tr class="detail-row"><td colspan="8"><div class="lb-detail" id="detail-' + r.run_id + '">' +
        '<div class="d-loading">loading run…</div></div></td></tr>';
    }
  }
  html += '</table>';
  $('board').innerHTML = html;
  if (openDetail) loadDetail(openDetail);
}

$('board').addEventListener('click', (e) => {
  const tr = e.target.closest('tr.row');
  if (!tr) return;
  openDetail = openDetail === tr.dataset.run ? null : tr.dataset.run;
  renderBoard();
});

// Row expansion: the stored result.metrics through the shared renderer
// (spec §4.4 — one renderer, two call sites).
async function loadDetail(runId) {
  const host = $('detail-' + runId);
  if (!host) return;
  let detail;
  try {
    detail = await (await fetch('/api/runs/' + runId)).json();
  } catch {
    host.innerHTML = '<div class="d-loading">failed to load run</div>';
    return;
  }
  const res = detail.result;
  const m = res.metrics;
  const row = DATA.rows.find((r) => r.run_id === runId);
  const env = row ? envOf(row) : '';
  const meta = ENV_META[env];
  const bits = Math.log2(res.n - 1);
  const R = window.BitrateResults;
  const replay = meta
    ? '<a class="replay" href="' + meta.href + '?cfg=' + row.variant_id + '">play this config</a>'
    : '';
  host.innerHTML =
    '<div class="d-head"><span class="d-title">' +
    '<b>' + res.bps.toFixed(2) + ' bits/s</b> · N ' + res.n +
    ' · Sc ' + res.sc + ' · Si ' + res.si +
    ' · ' + bits.toFixed(2) + ' bits/selection · seed ' + (detail.run.seed || '').slice(0, 8) + '…' +
    '</span>' + replay + '</div>' +
    (m ? '<div class="d-tiles">' + R.tilesHTML(m, { corrections: env === 'stream-typing' }) + '</div>' +
      '<div class="d-charts">' +
      '<figure><figcaption>pace — net bits/s per 5 s <span class="err-key">▎misses</span></figcaption>' +
      (m.selections > 1 ? R.paceChartSVG(m, bits) : '') + '</figure>' +
      '<figure><figcaption>gap between selections</figcaption>' +
      (m.selections > 1 ? R.ikiChartSVG(m) : '') + '</figure>' +
      '</div>'
      : '<div class="d-loading">no diagnostics stored for this run</div>');
}

boot();
