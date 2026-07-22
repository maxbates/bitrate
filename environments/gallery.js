'use strict';

/* bit-rate gallery + leaderboard (spec §5, §4.4).
 *
 * Everything renders from GET /api/leaderboard: ranked rows, the full run
 * history (progress strips, tile stats — same query, different cuts), and
 * the variant registry. Row expansion fetches /api/runs/{id} and reuses
 * the shared results renderer — one renderer, all call sites.
 */

const $ = (id) => document.getElementById(id);

const ENV_META = {
  'stream-typing': {
    name: 'stream-typing',
    desc: 'the serious baseline: pinned stream, deep lookahead, self-paced keys',
    href: 'stream-typing/',
  },
  'pixel-lens': {
    name: 'pixel-lens',
    desc: 'a target lights up on a huge grid; find it, loupe it, click it — Fitts’s law says the pointer loses',
    href: 'pixel-lens/',
  },
  'voice-babble': {
    name: 'voice-babble',
    desc: 'say the sounds — recognized on-device from your own calibrated voice; latency is the enemy',
    href: 'voice-babble/',
  },
  'word-typing': {
    name: 'word-typing',
    desc: 'type i.i.d. words from a fixed list — the spec predicts a wash vs letters; measure it',
    href: 'word-typing/',
  },
  'speech-words': {
    name: 'speech-words',
    desc: 'speak i.i.d. words — one utterance is one selection, so the big alphabet multiplies bits',
    href: 'speech-words/',
  },
};

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

function envOf(h) { return h.environment || 'unknown'; }

function knownEnvs(data) {
  const envs = new Set(Object.keys(ENV_META));
  for (const v of data ? data.variants : []) envs.add(v.environment);
  return [...envs];
}

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
  if (v.environment === 'pixel-lens') {
    return c.cell_mm + ' mm · ' + c.grid_cols + '×' + c.grid_rows;
  }
  if (v.environment === 'voice-babble') {
    return (c.symbol_set || '') + ' · N=' + c.alphabet_size;
  }
  if (v.environment === 'word-typing') {
    return '≤' + c.word_max_len + ' letters · N=' + c.alphabet_size;
  }
  if (v.environment === 'speech-words') {
    return (c.wordlist || '') + ' · N=' + c.alphabet_size;
  }
  return variantId.slice(0, 8);
}

// ---- environment tiles (spec §5 gallery) ----

function renderTiles(data) {
  const wrap = $('tiles');
  wrap.innerHTML = '';
  for (const env of knownEnvs(data)) {
    const meta = ENV_META[env] || { name: env, desc: '', href: env + '/' };
    const scored = data ? data.history.filter((h) => envOf(h) === env && h.verified && h.is_scored) : [];
    const best = scored.length ? Math.max(...scored.map((h) => h.bps)) : null;
    const med = median(scored.map((h) => h.bps));
    const fc = median(scored.filter((h) => h.is_first_contact).map((h) => h.bps));
    const el = document.createElement('div');
    el.className = 'tile-env';
    el.innerHTML =
      '<div class="t-head"><span class="t-name">' + meta.name + '</span>' +
      '<span class="t-bits">' + bitsLabel(env) + '</span></div>' +
      '<div class="t-desc">' + meta.desc + '</div>' +
      '<div class="t-stats">' +
      stat(scored.length || '—', scored.length === 1 ? 'run' : 'runs') +
      stat(best !== null ? best.toFixed(1) : '—', 'best bps') +
      stat(med !== null ? med.toFixed(1) : '—', 'median') +
      stat(fc !== null ? fc.toFixed(1) : '—', 'first-contact') +
      '</div>' +
      '<div class="t-foot">' +
      '<span class="t-spark">' + (scored.length > 1 ? sparkSVG(scored.map((h) => h.bps)) : '') + '</span>' +
      '<a class="launch" href="' + meta.href + '">play</a>' +
      '</div>';
    wrap.appendChild(el);
  }
}

function stat(v, l) {
  return '<span class="t-stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></span>';
}

function bitsLabel(env) {
  if (env === 'stream-typing') return 'N=27 · 4.70 bits/sel';
  if (env === 'pixel-lens') return 'N = your viewport';
  if (env === 'voice-babble') return 'N=6–26 · your voice';
  if (env === 'word-typing') return 'N≈1–1.9k words · 10+ bits/sel';
  if (env === 'speech-words') return 'N≤1.7k words · 10+ bits/sel';
  return '';
}

function sparkSVG(vals) {
  const W = 120, H = 34, n = vals.length;
  const { lo, hi } = DATA.dom; // shared log axis across every tile
  const pts = vals.map((v, i) =>
    (n > 1 ? (i / (n - 1)) * (W - 8) + 4 : W / 2) + ',' + yLog(v, lo, hi, 4, H - 10));
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
    '<polyline class="data-line" points="' + pts.join(' ') + '"/>' +
    '<circle class="data-dot" cx="' + pts[pts.length - 1].split(',')[0] +
    '" cy="' + pts[pts.length - 1].split(',')[1] + '" r="3.5"/></svg>';
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
      '<figcaption>' + env + ' · ' + runs.length + ' runs · bits/s, log scale (● scored · ○ practice)</figcaption>' +
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
  const tabs = ['all', ...knownEnvs(DATA)];
  $('board-tabs').innerHTML = tabs.map((t) =>
    '<button data-t="' + t + '"' + (t === boardFilter ? ' class="on"' : '') + '>' + t + '</button>').join('');
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
  const rows = DATA.rows.filter((r) => boardFilter === 'all' || envOf(r) === boardFilter);
  $('board-note').textContent = ' · best verified scored run per player × config';
  if (!rows.length) {
    $('board').innerHTML =
      '<div class="empty">no scored runs here yet — arm one from any game (Enter) and claim the top spot.</div>';
    return;
  }
  let html = '<table class="lb"><tr>' +
    '<th></th><th>player</th><th>bits/s</th><th>mode</th><th>config</th><th>acc</th><th>when</th></tr>';
  for (const r of rows) {
    const you = r.device_id === DEVICE_ID ? '<span class="you">you</span>' : '';
    const acc = r.sc + r.si > 0 ? ((100 * r.sc) / (r.sc + r.si)).toFixed(1) + '%' : '—';
    html += '<tr class="row" data-run="' + r.run_id + '" data-variant="' + r.variant_id + '" data-env="' + envOf(r) + '">' +
      '<td class="rank">' + r.rank + '</td>' +
      '<td><span class="player">' + r.pseudonym + '</span>' + you + '</td>' +
      '<td class="bps">' + r.bps.toFixed(2) + '</td>' +
      '<td>' + envOf(r) + '</td>' +
      '<td>' + configSummary(r.variant_id) + '</td>' +
      '<td>' + acc + '</td>' +
      '<td>' + agoFmt(r.ended_at) + '</td></tr>';
    if (openDetail === r.run_id) {
      html += '<tr class="detail-row"><td colspan="7"><div class="lb-detail" id="detail-' + r.run_id + '">' +
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
