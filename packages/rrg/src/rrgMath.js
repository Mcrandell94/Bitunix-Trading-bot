// Pure RRG math, shared by RelativeRotationGraph and its tests. Everything
// here is deterministic on the daily price arrays the API returns — no
// fetching, no React — so the readings can be unit-tested directly.
//
// RS-Ratio / RS-Momentum are a standard open approximation of the JdK
// method, not the proprietary formula:
//   ratio      = asset / benchmark (optionally EMA-smoothed)
//   RS-Ratio   = zscore: 100 + (ratio - SMA_n) / SD_n
//                simple: 100 * ratio / SMA_n
//   RS-Mom     = the same transform applied to RS-Ratio over m days
// 100/100 is the benchmark; quadrants split at 100 on both axes.

export const QUADRANT_ORDER = ['leading', 'weakening', 'lagging', 'improving'];

function sma(arr, i, w) {
  const s = arr.slice(Math.max(0, i - w + 1), i + 1);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

function stdev(arr, i, w) {
  const s = arr.slice(Math.max(0, i - w + 1), i + 1);
  if (s.length < 2) return 0;
  const m = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / (s.length - 1));
}

// Exponential moving average with span `span` (alpha = 2 / (span + 1)).
// span <= 1 returns the input unchanged (smoothing off).
export function ema(arr, span) {
  if (!(span > 1)) return arr.slice();
  const alpha = 2 / (span + 1);
  const out = [];
  let prev = arr[0];
  for (let i = 0; i < arr.length; i++) {
    prev = i === 0 ? arr[0] : alpha * arr[i] + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

// First index whose point is built entirely from full windows. Earlier
// points use partial rolling windows (a 2-day stdev, an EMA still anchored
// on day one) and aren't meaningful, so the chart never shows them.
export function firstValidIndex({ trendWindow, momentumWindow, smoothing = 1 }) {
  const emaWarmup = smoothing > 1 ? 3 * smoothing : 0;
  return emaWarmup + (trendWindow - 1) + (momentumWindow - 1);
}

// Returns [{ x: RS-Ratio, y: RS-Momentum }, ...], one per day, same length
// as the inputs.
export function computeSeries(asset, bench, { trendWindow, momentumWindow, zscore = true, smoothing = 1 }) {
  const raw = asset.map((v, i) => v / bench[i]);
  const ratio = ema(raw, smoothing);
  const n = trendWindow;
  const m = momentumWindow;
  const rsRatio = zscore
    ? ratio.map((r, i) => {
        const sd = stdev(ratio, i, n);
        return sd > 0 ? 100 + (r - sma(ratio, i, n)) / sd : 100;
      })
    : ratio.map((r, i) => 100 * (r / sma(ratio, i, n)));
  const rsMom = zscore
    ? rsRatio.map((r, i) => {
        const sd = stdev(rsRatio, i, m);
        return sd > 0 ? 100 + (r - sma(rsRatio, i, m)) / sd : 100;
      })
    : rsRatio.map((r, i) => 100 * (r / sma(rsRatio, i, m)));
  return rsRatio.map((_, i) => ({ x: rsRatio[i], y: rsMom[i] }));
}

export function quadrantOf(x, y) {
  if (x >= 100 && y >= 100) return 'leading';
  if (x >= 100 && y < 100) return 'weakening';
  if (x < 100 && y < 100) return 'lagging';
  return 'improving';
}

export function countFlips(pts) {
  let f = 0;
  for (let i = 1; i < pts.length; i++) {
    if (quadrantOf(pts[i].x, pts[i].y) !== quadrantOf(pts[i - 1].x, pts[i - 1].y)) f++;
  }
  return f;
}

// How many consecutive days (ending at the last point) the series has sat
// in its current quadrant, and the quadrant it came from before that
// (null if it never changed within the given points).
export function quadrantStreak(pts) {
  if (pts.length === 0) return { days: 0, from: null };
  const q = quadrantOf(pts[pts.length - 1].x, pts[pts.length - 1].y);
  let days = 0;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (quadrantOf(pts[i].x, pts[i].y) !== q) {
      return { days, from: quadrantOf(pts[i].x, pts[i].y) };
    }
    days++;
  }
  return { days, from: null };
}

// Direction of travel over the last `lookback` steps, as an arrow glyph
// and compass angle (0 = right/"strengthening trend", 90 = up/"rising
// momentum"). Uses the net move, so one noisy day doesn't flip it.
const ARROWS = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
export function heading(pts, lookback = 3) {
  if (pts.length < 2) return null;
  const a = pts[Math.max(0, pts.length - 1 - lookback)];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) === 0) return null;
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { deg, arrow: ARROWS[Math.round(deg / 45) % 8], dx, dy };
}

// Preset reads, tuned jointly on simulated crypto data with known regime
// switches (100 days of history, 3-4.5% daily idiosyncratic vol, 0.4-1.2%/day
// relative drift, regimes of 8-45 days). Measured against the previous
// default (Trend 14 / Momentum 5 / no smoothing: ~2.5 quadrant flips per
// 7 days, ~3.2 days to catch a real switch):
// - fast:     ~2.1 flips / 7d, ~2.3d to catch a switch (quickest, noisier)
// - balanced: ~1.7 flips / 7d, ~3.1d — same speed and accuracy as before,
//             about a third fewer false flips (the default)
// - steady:   ~1.3 flips / 7d, ~4d — calmest; misses more short-lived moves
// Momentum 10 beat 5 at every trend/smoothing combination tested.
export const RRG_PRESETS = [
  { key: 'fast', label: 'Fast', blurb: 'Quick turns, noisier', settings: { trendWindow: 7, momentumWindow: 10, smoothing: 2, tailLength: 5 } },
  { key: 'balanced', label: 'Balanced', blurb: 'Default', settings: { trendWindow: 10, momentumWindow: 10, smoothing: 3, tailLength: 7 } },
  { key: 'steady', label: 'Steady', blurb: 'Big picture, calmest', settings: { trendWindow: 14, momentumWindow: 10, smoothing: 5, tailLength: 10 } },
];
