// TypeScript port of "Heikin/Kaufman Strategy" (shorttitle KAMA; Pine Script, no version line = v1) for the owner's ETH
// card (2026-10-11: "add the Kama with the chop filters for a signal with noting support and confluence from other
// factors"). The copy given has no licence header; TradingView's default for open scripts is MPL 2.0. Calculations only
// (no lines or arrows drawn), default inputs: Heikin Ashi time frame D, shift 0, slow EMA 20, KAMA length 5, price
// hlc3, fast end 2.5, slow end 20.
//
// Bar-for-bar notes (Pine semantics kept):
// - Heikin Ashi (heikinashi(tickerid)): haClose = (o + h + l + c) / 4, haOpen = (haOpen[1] + haClose[1]) / 2 (the first
//   one (o + c) / 2), haHigh = max(h, haOpen, haClose), haLow = min(l, haOpen, haClose).
// - KAMA (`security(ha_t, period, nAMA)`): on the chart timeframe's Heikin Ashi bars, x = hlc3; efficiency ratio =
//   |x - x[5]| / sum(|x - x[1]|, 5) (0 when the noise is 0); smoothing = (ER x (2/3.5 - 2/21) + 2/21)^2;
//   nAMA = nz(nAMA[1]) + smoothing x (x - nz(nAMA[1])). It starts from 0 as the script does (na before 5 bars), so the
//   first KAMA.warmup bars are not used for signals.
// - Slow line = ema(KAMA, 20) (ta.ema seeding, pine.ts). Fast line = ema(daily HA hlc3, 1), i.e. the daily Heikin Ashi
//   hlc3 itself (shift 0).
// - BUY = crossover(fast, slow) (fast > slow and fast[1] <= slow[1]); SELL = crossunder.
// - The original's `security()` (Pine v1) reads the finished daily bar on past bars of a 4H chart, so its historical 4H
//   arrows on TradingView use the day's final value, which was not known at the time; live it uses the developing day.
//   This port uses only what was known at each 4H close (what is seen live): today's open / high / low / close so far
//   with haOpen from the completed days. Some old 4H arrows on the chart can therefore differ. The 1D line has no such
//   issue.
// - The chop filter, the notes and the record are the card's (ethreport.ts), not the script's.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taEma } from './pine';

export const KAMA = { length: 5, fastEnd: 2.5, slowEnd: 20, slowEma: 20, warmup: 300, cost: 0.0022 } as const;
const DAY = 86_400_000;

export interface HaBar { open: number; high: number; low: number; close: number }
export function heikinAshi(c: ReadonlyArray<{ open: number; high: number; low: number; close: number }>): HaBar[] {
  const out: HaBar[] = [];
  let po = NaN, pc = NaN;
  for (const b of c) {
    const close = (b.open + b.high + b.low + b.close) / 4, open = Number.isNaN(po) ? (b.open + b.close) / 2 : (po + pc) / 2;
    out.push({ open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close });
    po = open; pc = close;
  }
  return out;
}
export const hlc3 = (b: HaBar) => (b.high + b.low + b.close) / 3;

/** The script's Kaufman adaptive moving average of x (na for the first 5 bars, then from nz(prev) = 0). */
export function kaufman(x: ArrayLike<number>): number[] {
  const K = KAMA, fast = 2 / (K.fastEnd + 1), slow = 2 / (K.slowEnd + 1), out = new Array<number>(x.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (i < K.length) continue;
    let noise = 0;
    for (let k = i - K.length + 1; k <= i; k++) noise += Math.abs(x[k]! - x[k - 1]!);
    const er = noise !== 0 ? Math.abs(x[i]! - x[i - K.length]!) / noise : 0, sc = (er * (fast - slow) + slow) ** 2;
    const p = Number.isNaN(prev) ? 0 : prev;
    out[i] = p + sc * (x[i]! - p);
    prev = out[i]!;
  }
  return out;
}

export interface KamaLine { fast: number[]; slow: number[] }
const slowLine = (c: ReadonlyArray<Candle>) => taEma(kaufman(heikinAshi(c).map(hlc3)), KAMA.slowEma);

/** The 1D lines: the daily Heikin Ashi hlc3 and the EMA 20 of the KAMA of it. */
export function kamaDaily(d1: ReadonlyArray<Candle>): KamaLine {
  return { fast: heikinAshi(d1).map(hlc3), slow: slowLine(d1) };
}

/** The 4H lines: the developing daily Heikin Ashi hlc3 at each 4H close, and the EMA 20 of the KAMA of the 4H HA hlc3. */
export function kama4h(h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>): KamaLine {
  const ha = heikinAshi(d1), fast = new Array<number>(h4.length).fill(NaN);
  let day = NaN, o = NaN, h = NaN, l = NaN, j = -1;
  for (let i = 0; i < h4.length; i++) {
    const b = h4[i]!, d = Math.floor(b.openTime / DAY) * DAY;
    if (d !== day) { day = d; o = b.open; h = b.high; l = b.low; while (j + 1 < d1.length && d1[j + 1]!.openTime < d) j++; }
    else { h = Math.max(h, b.high); l = Math.min(l, b.low); }
    if (j < 0) continue;
    // haOpen of today from the completed days (the last daily bar before today).
    const haOpen = (ha[j]!.open + ha[j]!.close) / 2, haClose = (o + h + l + b.close) / 4;
    fast[i] = (Math.max(h, haOpen, haClose) + Math.min(l, haOpen, haClose) + haClose) / 3;
  }
  return { fast, slow: slowLine(h4) };
}

export interface KamaCross { i: number; dir: 1 | -1 }
/** Every crossover (BUY) / crossunder (SELL) of the fast line over the slow one from bar `from`. */
export function kamaCrosses(line: KamaLine, from: number = KAMA.warmup): KamaCross[] {
  const out: KamaCross[] = [], { fast: f, slow: s } = line;
  for (let i = Math.max(1, from); i < f.length; i++) {
    const a = f[i]!, b = s[i]!, a0 = f[i - 1]!, b0 = s[i - 1]!;
    if ([a, b, a0, b0].some(Number.isNaN)) continue;
    if (a > b && a0 <= b0) out.push({ i, dir: 1 });
    else if (a < b && a0 >= b0) out.push({ i, dir: -1 });
  }
  return out;
}

export interface KamaTrade { i: number; dir: 1 | -1; entry: number; exitAt: number; exit: number; ret: number; mae: number }
/**
 * The record "until the opposite signal": each taken cross enters at its bar's close and is held to the next opposite
 * cross (taken or not); still open at the last bar = marked to its close (exitAt -1). ret and mae (the worst move
 * against, from the bars after entry) in %, ret after the round-trip cost.
 */
export function kamaRecord(c: ReadonlyArray<{ high: number; low: number; close: number }>, crosses: ReadonlyArray<KamaCross>, taken: (x: KamaCross) => boolean): KamaTrade[] {
  const out: KamaTrade[] = [];
  crosses.forEach((x, k) => {
    if (!taken(x)) return;
    const next = crosses.slice(k + 1).find((y) => y.dir !== x.dir), exitAt = next ? next.i : -1, end = next ? next.i : c.length - 1;
    const entry = c[x.i]!.close, exit = c[end]!.close;
    let mae = 0;
    for (let q = x.i + 1; q <= end; q++) mae = Math.min(mae, (x.dir * ((x.dir > 0 ? c[q]!.low : c[q]!.high) - entry)) / entry);
    out.push({ i: x.i, dir: x.dir, entry, exitAt, exit, ret: ((x.dir * (exit - entry)) / entry - KAMA.cost) * 100, mae: mae * 100 });
  });
  return out;
}

export interface KamaStats { signals: number; closed: number; wins: number; avg: number | null; medianBars: number | null; worstMae: number | null }
export function kamaStats(t: ReadonlyArray<KamaTrade>): KamaStats {
  const cl = t.filter((x) => x.exitAt >= 0), bars = cl.map((x) => x.exitAt - x.i).sort((a, b) => a - b);
  return {
    signals: t.length, closed: cl.length, wins: cl.filter((x) => x.ret > 0).length, avg: cl.length ? cl.reduce((p, x) => p + x.ret, 0) / cl.length : null,
    medianBars: bars.length ? bars[Math.floor(bars.length / 2)]! : null, worstMae: t.length ? Math.min(...t.map((x) => x.mae)) : null,
  };
}
