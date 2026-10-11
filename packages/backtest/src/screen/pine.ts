// Pine Script ta.* helpers for the indicator ports of the ETH card (owner 2026-10-11). NaN = na, as in prismrsi.ts and
// smclux.ts; every helper returns one value per bar, oldest first. Pure.
//
// Pine semantics kept:
// - ta.sma / ta.highest / ta.lowest / ta.stdev / math.sum: na until `len` bars exist, and na when the window holds an na.
// - ta.ema: na for the first len-1 values, seeded with their SMA, then alpha = 2 / (len + 1) (see prismrsi.ts).
// - ta.rma / ta.atr: seeded with the SMA of the first `len` values, then alpha = 1 / len (ta.atr = RMA of the true
//   range; the first bar's true range is high - low).
// - ta.stdev is the population deviation (biased = true, Pine's default).
// - ta.alma(src, len, offset, sigma): m = offset x (len - 1), s = len / sigma, weight(i) = exp(-(i - m)^2 / (2 s^2)) for
//   i = 0 (the oldest bar of the window) .. len - 1 (the current bar), normalised.
// - ta.pivothigh / ta.pivotlow: see srbreaks.ts pinePivot (a higher bar on the left or an equal-or-higher bar on the
//   right disqualifies the candidate).

import type { Candle } from '@bot/marketdata';
import { pineAtr } from './smclux';
import { pinePivot } from './srbreaks';

const isNa = Number.isNaN;
export const nz = (x: number, y = 0) => (isNa(x) ? y : x);

export function taSma(src: ArrayLike<number>, len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let sum = 0, nas = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (isNa(v)) nas++; else sum += v;
    if (i >= len) { const o = src[i - len]!; if (isNa(o)) nas--; else sum -= o; }
    if (i >= len - 1 && nas === 0) out[i] = sum / len;
  }
  return out;
}

/** math.sum(src, len). */
export function taSum(src: ArrayLike<number>, len: number): number[] {
  return taSma(src, len).map((x) => x * len);
}

export function taEma(src: ArrayLike<number>, len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN), a = 2 / (len + 1);
  let prev = NaN, run = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (isNa(prev)) {
      if (isNa(v)) { run = 0; cnt = 0; continue; }
      run += v; cnt++;
      if (cnt >= len) { prev = run / len; out[i] = prev; }
      continue;
    }
    prev = isNa(v) ? prev : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

export function taRma(src: ArrayLike<number>, len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  let prev = NaN, run = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (isNa(prev)) {
      if (isNa(v)) continue;
      run += v; cnt++;
      if (cnt >= len) { prev = run / len; out[i] = prev; }
      continue;
    }
    if (!isNa(v)) prev = (prev * (len - 1) + v) / len;
    out[i] = prev;
  }
  return out;
}

export const taAtr = (c: ReadonlyArray<Candle>, len: number): number[] => Array.from(pineAtr(c, len));

/** The true range of each bar (ta.tr(true): the first bar's is high - low). */
export const trueRange = (c: ReadonlyArray<Candle>): number[] =>
  c.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1]!.close), Math.abs(b.low - c[i - 1]!.close))));

export function taStdev(src: ArrayLike<number>, len: number): number[] {
  const m = taSma(src, len), out = new Array<number>(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    if (isNa(m[i]!)) continue;
    let ss = 0;
    for (let k = i - len + 1; k <= i; k++) ss += (src[k]! - m[i]!) ** 2;
    out[i] = Math.sqrt(ss / len);
  }
  return out;
}

export function taAlma(src: ArrayLike<number>, len: number, offset: number, sigma: number): number[] {
  const m = offset * (len - 1), s = len / sigma, w: number[] = [];
  for (let i = 0; i < len; i++) w.push(Math.exp(-((i - m) ** 2) / (2 * s * s)));
  const norm = w.reduce((a, b) => a + b, 0), out = new Array<number>(src.length).fill(NaN);
  for (let t = len - 1; t < src.length; t++) {
    let sum = 0, bad = false;
    for (let i = 0; i < len; i++) { const v = src[t - (len - 1) + i]!; if (isNa(v)) { bad = true; break; } sum += v * w[i]!; }
    if (!bad) out[t] = sum / norm;
  }
  return out;
}

function rolling(src: ArrayLike<number>, len: number, hi: boolean): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = len - 1; i < src.length; i++) {
    let x = hi ? -Infinity : Infinity, bad = false;
    for (let k = i - len + 1; k <= i; k++) { const v = src[k]!; if (isNa(v)) { bad = true; break; } x = hi ? Math.max(x, v) : Math.min(x, v); }
    if (!bad) out[i] = x;
  }
  return out;
}
export const taHighest = (src: ArrayLike<number>, len: number) => rolling(src, len, true);
export const taLowest = (src: ArrayLike<number>, len: number) => rolling(src, len, false);

/** ta.pivothigh / ta.pivotlow evaluated on bar i with `len` bars each side: the pivot's value, or NaN. */
export function taPivot(src: ArrayLike<number>, i: number, len: number, high: boolean): number {
  const v = pinePivot(src, i, len, len, high);
  return v == null ? NaN : v;
}

/** The previous bar's value (x[1]); NaN on the first bar. */
export const prev = (xs: ArrayLike<number>, i: number, n = 1) => (i - n >= 0 ? xs[i - n]! : NaN);

/** Quote volume turned into coin units with each bar's typical price (TradingView shows crypto volume in coin units). */
export const coinVolume = (c: ReadonlyArray<Candle>): number[] =>
  c.map((b) => { const tp = (b.high + b.low + b.close) / 3; return b.volume != null && tp > 0 ? b.volume / tp : NaN; });
