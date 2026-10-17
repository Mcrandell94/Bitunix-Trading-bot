// This Pine Script code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Momentum Ghost Machine [ChartPrime]" (Pine v5, © ChartPrime) for the owner's script library (owner
// 2026-10-17). Calculations only (no plots, glow, fills or bar colours), default inputs: source close, momentum length
// 50, smoothing 50, post smoothing 4 (WMA), MA 24 (EMA), ghost mode on.
//
// Bar-for-bar notes:
// - The filter: a 100-tap windowed sinc (cutoff 1 / 50, Blackman window at k + 0.5 since the length is even, centre
//   (100 - 1) / 2 = 49 in Pine's integer division) over the last 100 sources, newest first, divided by the taps' sum.
//   The script builds its one-row Toeplitz matrix on the first call (bar 101), so it reads from bar 101 on.
// - Momentum = WMA 4 of (source - filter) / 49 (the offset, 49 in integer division). MA = EMA 24 of EMA 2 of it, with
//   the script's own EMA (it starts on its first value: nz(prev, source)). Histogram = momentum - MA.
// - Histogram colours: over 0 and rising = bullish up, over 0 otherwise = bullish down; else falling = bearish down,
//   otherwise bearish up (na reads bearish up).
// - Ghost: each line plus avg(change over 1 bar, change over 2 bars / 2), once and twice; the projected histogram is
//   their difference, 1 and 2 bars ahead.
// It gives no price levels, so it is not one of the card's POI scripts; the preview's chart check shows its reading.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taWma } from './pine';

export const MGM = { length: 100, fc: 50, offset: 49, post: 4, ma: 24 } as const;
export type MgmColor = 'bullish up' | 'bullish down' | 'bearish down' | 'bearish up';

export interface MgmSeries { filter: number[]; delta: number[]; ma: number[]; momo: number[]; color: MgmColor[]; ghost1: number[]; ghost2: number[] }

/** The filter taps, index 0 = the newest source. */
export function mgmCoefficients(): number[] {
  const { length: L, fc } = MGM, mid = Math.trunc((L - 1) / 2), cutoff = 1 / fc;
  const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const blackman = (n: number, M: number) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (M - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (M - 1));
  return Array.from({ length: L }, (_, i) => sinc(2 * cutoff * (i - mid)) * (L % 2 === 0 ? blackman(i + 0.5, L) : blackman(i, L)));
}

/** The script's EMA: alpha x source + (1 - alpha) x nz(previous, source). */
const ema = (src: number[], len: number) => {
  const a = 2 / (len + 1), out: number[] = [];
  let prev = NaN;
  for (const v of src) { prev = a * v + (1 - a) * (Number.isNaN(prev) ? v : prev); out.push(prev); }
  return out;
};

export function mgm(c: ReadonlyArray<Candle>): MgmSeries {
  const { length: L, offset, post } = MGM, src = c.map((b) => b.close), co = mgmCoefficients(), norm = co.reduce((a, b) => a + b, 0);
  const filter = src.map((_, i) => {
    if (i <= L) return NaN;
    let s = 0;
    for (let k = 0; k < L; k++) s += co[k]! * src[i - k]!;
    return s / norm;
  });
  const delta = taWma(src.map((x, i) => (x - filter[i]!) / offset), post), ma = ema(ema(delta, 2), MGM.ma);
  const momo = delta.map((d, i) => d - ma[i]!);
  const color = momo.map((m, i): MgmColor => { const p = i > 0 ? momo[i - 1]! : NaN; return m > 0 ? (m > p ? 'bullish up' : 'bullish down') : m < p ? 'bearish down' : 'bearish up'; });
  const proj = (x: number[], i: number) => ((x[i]! - (i >= 1 ? x[i - 1]! : NaN)) + (x[i]! - (i >= 2 ? x[i - 2]! : NaN)) / 2) / 2;
  const ghost1 = delta.map((d, i) => d + proj(delta, i) - (ma[i]! + proj(ma, i))), ghost2 = delta.map((d, i) => d + 2 * proj(delta, i) - (ma[i]! + 2 * proj(ma, i)));
  return { filter, delta, ma, momo, color, ghost1, ghost2 };
}
