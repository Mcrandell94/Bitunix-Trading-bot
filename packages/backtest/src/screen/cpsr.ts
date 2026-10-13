// TypeScript port of "Dynamic Support/Resistance Zones [ChartPrime]" (Pine v5, MPL 2.0, © ChartPrime) for the owner's
// ETH / BTC cards (owner 2026-10-13, cards v2). Calculations only (no distribution boxes, heat map or bounce dots),
// default inputs: linear weighting, 50 pivots per side, filtering 3, pivots of length 5 / 10 / 20 / 50 on highs and lows.
//
// Bar-for-bar notes:
// - Each bar pushes the confirmed pivot highs of lengths 5, 10, 20, 50 (in that order, ta.pivothigh: pine.ts taPivot)
//   and then the pivot lows; each list then drops its oldest entry once if it holds more than 50 (one drop per bar, as
//   written, so a list can grow past 50 when several lengths confirm on one bar).
// - Range = the lowest .. highest stored pivot (both lists). The precision checkbox is negated in the script
//   (`auto_precision = not input.bool(true, ...)`), so with defaults it is the manual 75 bins.
// - Each pivot adds 1 to its bin (the top value goes into the last bin). The bins are smoothed with a sinc kernel of
//   bandwidth 4 (filter 3 + 1), normalised by the kernel sum, negatives set to 0.
// - Peaks: the smoothed bins are scaled to 1..30 from the smallest non-zero value; a bin is a peak when its scaled value
//   is above the bin before and above the bin after; a plateau of equal scaled values that then falls counts once, at
//   its middle (a half-bin for an even width, as written). Each peak's level is its bin's middle; it reads as support
//   when the close is over it, else resistance.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taPivot } from './pine';

export const CPSR = { lengths: [5, 10, 20, 50], pivots: 50, filter: 3, bins: 75, scale: 30 } as const;

const sinc = (x: number, bw: number) => (x === 0 ? 1 : Math.sin((Math.PI * x) / bw) / ((Math.PI * x) / bw));

/** The script's peak finder on already-smoothed bins (indexes, a .5 for an even plateau). */
export function cpPeaks(src: ReadonlyArray<number>, scale: number, realMin: number): number[] {
  const out: number[] = [], n = src.length, max = Math.max(...src) - realMin;
  if (!(max > 0)) return out;
  const q = (k: number) => Math.trunc(((src[k]! - realMin) / max) * (scale - 1) + 1);
  let i = -1;
  while (i < n - 1) {
    i++;
    const center = q(i), previous = i > 0 ? q(i - 1) : 0, next = i < n - 1 ? q(i + 1) : 0;
    if (center > previous) {
      let j = i + 1;
      if (center === next) {
        while (j <= n - 1) {
          j++;
          const vp = q(j - 1), vn = j <= n - 1 ? q(j) : 0;
          if (vn !== vp) {
            if (center > vn) { const p = Math.trunc((i + j) / 2); out.push(j - i > 2 && (j - i) % 2 !== 0 ? p : p - 0.5); i = j; }
            else i = j - 1;
            break;
          }
        }
      }
      if (center > next) out.push(i);
    }
  }
  return out;
}

/** The S/R levels the script shows at bar i (one pass over bars 0..i). */
export function cpSr(c: ReadonlyArray<Candle>, i: number): { levels: number[]; support: number[]; resistance: number[] } {
  const P = CPSR, hi = c.map((b) => b.high), lo = c.map((b) => b.low), ph: number[] = [], pl: number[] = [];
  for (let k = 0; k <= i; k++) {
    for (const L of P.lengths) { const v = taPivot(hi, k, L, true); if (!Number.isNaN(v)) ph.push(v); }
    for (const L of P.lengths) { const v = taPivot(lo, k, L, false); if (!Number.isNaN(v)) pl.push(v); }
    if (ph.length > P.pivots) ph.shift();
    if (pl.length > P.pivots) pl.shift();
  }
  const none = { levels: [], support: [], resistance: [] };
  if (!ph.length || !pl.length) return none;
  const maxR = Math.max(...ph, ...pl), minR = Math.min(...ph, ...pl), size = (maxR - minR) / P.bins;
  if (!(size > 0)) return none;
  const scores = new Array<number>(P.bins).fill(0);
  for (const v of [...ph, ...pl]) scores[Math.min(Math.floor((v - minR) / size), P.bins - 1)]! += 1;
  const f = scores.map((_, a) => {
    let sum = 0, sw = 0;
    for (let b = 0; b < P.bins; b++) { const w = sinc(a - b, P.filter + 1); sum += scores[b]! * w; sw += w; }
    const v = sum / sw;
    return v >= 0 ? v : 0;
  });
  if (!(Math.max(...f) > 0)) return none;
  const realMin = Math.min(...f.filter((v) => v !== 0));
  const levels = cpPeaks(f, P.scale, realMin).map((p) => minR + size * (p + 0.5)).sort((a, b) => a - b), close = c[i]!.close;
  return { levels, support: levels.filter((l) => close > l), resistance: levels.filter((l) => close <= l) };
}
