'use strict';

/* Shared post-run diagnostics renderer (spec §4.3): stat tiles + two
 * hand-rolled SVGs (no charting library — spec §4.2). Every environment
 * renders the same server-computed result.metrics through this file, and
 * the step-6 leaderboard detail view reuses it — one renderer, all call
 * sites (spec §4.4).
 *
 * Single-series charts: single hue, no legend, thin marks, hairline solid
 * grid; values reachable via tiles, axis labels, and <title> tooltips.
 */

(function () {
function tile(label, value, sub) {
  return '<div class="tile"><div class="t-label">' + label + '</div>' +
    '<div class="t-value">' + value + '</div>' +
    (sub ? '<div class="t-sub">' + sub + '</div>' : '') + '</div>';
}

function fmtMs(ms) {
  return ms >= 995 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}

function tilesHTML(m, opts) {
  const showCorrections = !opts || opts.corrections !== false;
  return [
    tile('net correct / s', m.net_per_s.toFixed(2), m.gross_per_s.toFixed(2) + ' gross'),
    tile('accuracy', m.accuracy_pct.toFixed(1) + '%', m.letter_errors + (m.letter_errors === 1 ? ' miss' : ' misses')),
    tile('median gap', fmtMs(m.median_iki_ms), 'p90 ' + fmtMs(m.p90_iki_ms)),
    tile('stalls >1.5 s', String(m.stall_count), fmtMs(m.stall_ms) + ' lost'),
    showCorrections
      ? tile('corrections', m.corrected + '/' + m.letter_errors,
        m.uncorrected > 0 ? m.uncorrected + ' left = −' + 2 * m.uncorrected + ' net' : 'all corrected')
      : '',
    tile('dead tail', fmtMs(m.dead_tail_ms), 'after last key'),
  ].join('');
}

// ---- charts: hand-rolled SVG (no charting library — spec §4.2) ----
// Single series -> single hue, no legend; thin marks, hairline solid grid;
// values reachable via axis labels, tiles, and <title> tooltips.

const CW = 500, CH = 190, PADL = 40, PADR = 12, PADT = 14, PADB = 30;

function gridStep(maxV) {
  for (const s of [0.5, 1, 2, 4, 5, 10, 20, 40]) {
    if (maxV / s <= 5) return s;
  }
  return Math.ceil(maxV / 5);
}

// Pace: net bits/s per 5 s bin, line + wash, misses as ticks above the axis.
function paceChartSVG(m, bits) {
  const plotW = CW - PADL - PADR, plotH = CH - PADT - PADB;
  const tEnd = m.bins.length * 5;
  const vals = m.bins.map((b) => (bits * (b.sc - b.si)) / 5);
  const vMax = Math.max(1, ...vals);
  const vMin = Math.min(0, ...vals);
  const y = (v) => PADT + plotH - ((v - vMin) / (vMax - vMin)) * plotH;
  const x = (i) => PADL + ((i + 0.5) / m.bins.length) * plotW;

  let s = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" role="img">';
  const step = gridStep(vMax);
  for (let v = Math.ceil(vMin / step) * step; v <= vMax + 1e-9; v += step) {
    s += '<line class="grid" x1="' + PADL + '" x2="' + (CW - PADR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    s += '<text class="axis-label" x="' + (PADL - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + '</text>';
  }
  for (let t = 0; t <= tEnd; t += 15) {
    const tx = PADL + (t / tEnd) * plotW;
    s += '<text class="axis-label" x="' + tx + '" y="' + (CH - PADB + 16) + '" text-anchor="middle">' + t + 's</text>';
  }
  if (vMin === 0) {
    s += '<polygon class="data-wash" points="' + x(0) + ',' + y(0) + ' ' +
      vals.map((v, i) => x(i) + ',' + y(v)).join(' ') + ' ' + x(vals.length - 1) + ',' + y(0) + '"/>';
  }
  s += '<polyline class="data-line" points="' + vals.map((v, i) => x(i) + ',' + y(v)).join(' ') + '"/>';
  vals.forEach((v, i) => {
    const b = m.bins[i];
    s += '<circle class="data-dot" cx="' + x(i) + '" cy="' + y(v) + '" r="4">' +
      '<title>' + i * 5 + '–' + (i + 1) * 5 + ' s · ' + b.sc + ' correct · ' + b.si +
      (b.si === 1 ? ' miss' : ' misses') + ' · ' + v.toFixed(1) + ' bits/s</title></circle>';
  });
  // Misses along the time axis (status color: these are the −1s).
  (m.err_ts_ms || []).forEach((t) => {
    const tx = PADL + (t / 1000 / tEnd) * plotW;
    s += '<rect class="err-tick" x="' + (tx - 1) + '" y="' + (PADT + plotH - 7) + '" width="2" height="7">' +
      '<title>miss at ' + (t / 1000).toFixed(1) + ' s</title></rect>';
  });
  return s + '</svg>';
}

// Interval histogram: 100 ms buckets to 1.5 s + overflow, median marker.
function ikiChartSVG(m) {
  const plotW = CW - PADL - PADR;
  const plotH = CH - PADT - PADB - 14; // 14px headroom so the median label clears the bars
  const nB = m.iki_hist.length;
  const maxC = Math.max(1, ...m.iki_hist);
  const slot = plotW / nB;
  const barW = Math.min(24, slot - 2); // 2px surface gap between bars
  const y0 = PADT + 14 + plotH;

  let s = '<svg viewBox="0 0 ' + CW + ' ' + CH + '" role="img">';
  const step = Math.max(1, gridStep(maxC));
  for (let v = 0; v <= maxC; v += step) {
    const gy = y0 - (v / maxC) * plotH;
    s += '<line class="grid" x1="' + PADL + '" x2="' + (CW - PADR) + '" y1="' + gy + '" y2="' + gy + '"/>';
    s += '<text class="axis-label" x="' + (PADL - 6) + '" y="' + (gy + 3) + '" text-anchor="end">' + v + '</text>';
  }
  m.iki_hist.forEach((c, i) => {
    if (!c) return;
    const bx = PADL + i * slot + (slot - barW) / 2;
    const h = Math.max(2, (c / maxC) * plotH);
    const by = y0 - h;
    const rr = Math.min(4, h / 2); // rounded data-end, square baseline
    s += '<path class="data-bar" d="M' + bx + ',' + y0 + ' V' + (by + rr) +
      ' Q' + bx + ',' + by + ' ' + (bx + rr) + ',' + by + ' H' + (bx + barW - rr) +
      ' Q' + (bx + barW) + ',' + by + ' ' + (bx + barW) + ',' + (by + rr) + ' V' + y0 + ' Z">' +
      '<title>' + (i === nB - 1 ? '≥1.5 s' : i * 100 + '–' + (i + 1) * 100 + ' ms') +
      ' · ' + c + (c === 1 ? ' gap' : ' gaps') + '</title></path>';
  });
  [0, 500, 1000, 1500].forEach((ms) => {
    const tx = PADL + (ms / 100 / nB) * plotW;
    s += '<text class="axis-label" x="' + tx + '" y="' + (CH - PADB + 16) + '" text-anchor="middle">' +
      (ms === 1500 ? '≥1.5s' : ms / 1000 + 's') + '</text>';
  });
  const mx = PADL + Math.min(m.median_iki_ms / 100 / nB, 1) * plotW;
  s += '<line class="marker-line" x1="' + mx + '" x2="' + mx + '" y1="' + PADT + '" y2="' + y0 + '"/>';
  const anchor = mx > CW * 0.7 ? 'end' : 'start';
  s += '<text class="axis-label" x="' + (mx + (anchor === 'end' ? -4 : 4)) + '" y="' + (PADT + 8) +
    '" text-anchor="' + anchor + '">median ' + fmtMs(m.median_iki_ms) + '</text>';
  return s + '</svg>';
}
// ---- live practice HUD: trailing-window bps + rolling sparkline ----
// Shared across every environment. Each selection carries {verdict,
// t_pressed_ms} (the §5 log contract), so this is modality-agnostic — keys,
// pointer, voice, swipes all feed the same computation. All client-side.

const SPARK_WIN_MS = 60000;   // trailing window for the headline figure
const SPARK_ROLL_MS = 6000;   // smoothing window for each sparkline sample
const SPARK_STEP_MS = 1000;   // sample spacing
const SPARK_W = 208, SPARK_H = 50, SPARK_PAD = 3;

function windowNet(keylog, startT, endT) {
  let sc = 0, si = 0;
  for (const k of keylog) {
    const t = k.t_pressed_ms;
    if (t > startT && t <= endT) { if (k.verdict) sc++; else si++; }
  }
  return { sc, si };
}

// Net bits/s over the trailing winMs (default 60 s), divided by the elapsed
// portion of that window (floored at 1 s so the figure isn't noisy at start).
function trailingBps(keylog, bits, nowT, winMs) {
  winMs = winMs || SPARK_WIN_MS;
  const w = windowNet(keylog, nowT - winMs, nowT);
  const net = Math.max(w.sc - w.si, 0);
  const secs = Math.max(Math.min(winMs, nowT), 1000) / 1000;
  return { bps: bits * net / secs, sc: w.sc, si: w.si };
}

// Visible span fills the panel width for the first minute (min 8 s so it isn't
// over-zoomed at the very start), then holds at 60 s and scrolls.
function sparkSpanMs(nowT) { return Math.min(SPARK_WIN_MS, Math.max(nowT, 8000)); }

function sparkSeries(keylog, bits, nowT) {
  const t0 = nowT - sparkSpanMs(nowT);
  const pts = [];
  for (let ts = nowT; ts >= Math.max(0, t0); ts -= SPARK_STEP_MS) {
    const w = windowNet(keylog, ts - SPARK_ROLL_MS, ts);
    pts.push({ ts, b: bits * Math.max(w.sc - w.si, 0) / (SPARK_ROLL_MS / 1000) });
  }
  pts.reverse();
  return pts;
}

// Returns the sparkline SVG + caption, or '' when there isn't enough data yet.
// Empty string collapses the host (.hud-spark-host:empty { display:none }).
function sparkHTML(keylog, bits, nowT) {
  const pts = sparkSeries(keylog, bits, nowT);
  if (pts.length < 2) return '';
  const span = sparkSpanMs(nowT), t0 = nowT - span;
  let maxB = 1;
  for (const p of pts) if (p.b > maxB) maxB = p.b;
  const yMax = maxB * 1.15;
  const clampX = (x) => Math.max(SPARK_PAD, Math.min(SPARK_W - SPARK_PAD, x));
  const X = (ts) => clampX(SPARK_PAD + ((ts - t0) / span) * (SPARK_W - 2 * SPARK_PAD));
  const Y = (b) => SPARK_H - SPARK_PAD - (b / yMax) * (SPARK_H - 2 * SPARK_PAD);
  const base = SPARK_H - SPARK_PAD;
  const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p.ts).toFixed(1) + ' ' + Y(p.b).toFixed(1)).join(' ');
  const area = 'M' + X(pts[0].ts).toFixed(1) + ' ' + base + ' ' +
    pts.map((p) => 'L' + X(p.ts).toFixed(1) + ' ' + Y(p.b).toFixed(1)).join(' ') +
    ' L' + X(pts[pts.length - 1].ts).toFixed(1) + ' ' + base + ' Z';
  return '<svg class="spark-svg" viewBox="0 0 ' + SPARK_W + ' ' + SPARK_H + '" preserveAspectRatio="none">' +
    '<path class="spark-area" d="' + area + '"/>' +
    '<line class="spark-base" x1="' + SPARK_PAD + '" y1="' + base + '" x2="' + (SPARK_W - SPARK_PAD) + '" y2="' + base + '"/>' +
    '<path class="spark-line" d="' + line + '"/></svg>' +
    '<div class="spark-cap">bits/s · trailing 60&thinsp;s</div>';
}

  window.BitrateResults = {
    fmtMs, tilesHTML, paceChartSVG, ikiChartSVG,
    trailingBps, sparkSeries, sparkHTML,
  };
})();

/* Consent banner (spec §6) — self-injecting so every page that loads this
   shared script shows it, deep-linked env pages included. Gated to non-loopback
   hosts: it appears on the public deploy (and LAN), never in local/grader play,
   so it can never leak into the ship deliverable. Dismissal persists per browser. */
(function () {
  var h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "") return;
  try {
    if (localStorage.getItem("bitrate-consent-v1")) return;
  } catch (e) { /* private mode: show it, just don't persist the dismissal */ }
  function mount() {
    if (document.getElementById("consent-banner")) return;
    var bar = document.createElement("div");
    bar.id = "consent-banner";
    bar.innerHTML =
      '<span>This is a research game. We log your selection timings and accuracy ' +
      "to study human input bit-rate — keystroke dynamics are <b>quasi-biometric</b>. " +
      "No account or personal information is collected; webcam and microphone modes run " +
      "entirely on your device and never upload audio or video.</span>" +
      '<button type="button" id="consent-ok">Got it</button>';
    document.body.appendChild(bar);
    document.getElementById("consent-ok").addEventListener("click", function () {
      try { localStorage.setItem("bitrate-consent-v1", "1"); } catch (e) {}
      bar.remove();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
