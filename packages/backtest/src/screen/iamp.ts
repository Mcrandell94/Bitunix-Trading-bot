// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "RedK Indicator Amplifier v1.0" (Pine v6, shorttitle "RedK i-Amp v1.0", © RedKTrader, internal
// build v0.30) for the owner's script library (owner 2026-10-16). Calculations only (no blocks, colours, markers or info
// panel). Default inputs: the RSI (14) preset, 10 bands, peak hold 3 bars, lookback 100, Max Hi / Max Low on.
//
// Bar-for-bar notes:
// - Oscillators: RSI 14 (Wilder, as ta.rsi); Stochastic = SMA 3 of ta.stoch(close, high, low, 14); CCI 20 = (close -
//   SMA 20) / (0.015 x the mean absolute deviation); MACD histogram 12 / 26 / 9 (Pine's SMA-seeded EMAs); or an
//   external series ("External Source", the close by default).
// - Presets: RSI and Stochastic are "Bounded - Centered" on 0..100; CCI and MACD are "Unbounded - Zero-Centered" over
//   the lookback. Max Hi / Max Low: RSI 70 / 30, Stochastic 80 / 20, CCI 100 / -100, MACD and external sources the
//   inputs. They are off (no crosses) for CCI, MACD and unbounded external sources while the lookback is over 1.
// - Lookback 1 on an unbounded mode = real values: a bounded mode on -full..+full (zero-centered) or 0..full / -full..0
//   (one direction Up / Down), full = block size x bands.
// - Scaling: bounded one direction (src - lo) / (hi - lo) in 0..1 (0.5 if hi = lo); bounded centered (src - mid) / half
//   in -1..1; unbounded one direction a stochastic over the lookback (0.5 when flat); zero-centered src / the highest
//   |src| of the lookback (0 when that is 0).
// - Blocks: round(|n| x bands), up while n > 0 and down while n < 0 in the centered modes; one direction "Down" counts
//   from the High (1 - n). Peak hold: the highest block stays for 3 bars, then falls one block a bar to the level.
// - Flips: the oscillator crosses the baseline (the centre; the floor or ceiling in one direction); Max crosses: over
//   Max Hi and under Max Low (ta.crossover / ta.crossunder).
// - na: warm-up bars read as 0 blocks (nz), and a comparison with na is false (Pine v6). ta.highest / ta.lowest are na
//   while the window holds an na (pine.ts), so the first lookback bars after an oscillator starts can differ from the
//   chart.
// It gives no price levels, so it is not one of the card's POI scripts; the preview's chart check shows its reading.
// Pure.

import type { Candle } from '@bot/marketdata';
import { rsi } from '../indicators';
import { nz, taEma, taHighest, taLowest, taSma } from './pine';

export type AmpSrc = 'RSI (14)' | 'Stochastic (14,3)' | 'CCI (20)' | 'MACD Histogram (12,26,9)' | 'External Source';
export type AmpMode = 'Bounded - One Direction' | 'Bounded - Centered' | 'Unbounded - One Direction' | 'Unbounded - Zero-Centered';
export interface AmpInputs {
  src: AmpSrc; mode: AmpMode; lo: number; hi: number; oneDir: 'Up' | 'Down'; rollLen: number; blkSize: number; bands: number;
  holdBars: number; useHi: boolean; maxHi: number; useLo: boolean; maxLo: number;
}
export const IAMP: Readonly<AmpInputs> = {
  src: 'RSI (14)', mode: 'Bounded - Centered', lo: 0, hi: 100, oneDir: 'Up', rollLen: 100, blkSize: 1, bands: 10,
  holdBars: 3, useHi: true, maxHi: 70, useLo: true, maxLo: 30,
};

export interface AmpSeries {
  /** The settings in force after the presets: the scaling mode, its range, the baseline and the Max levels (`levels` false = off). */
  mode: AmpMode; lo: number; hi: number; base: number; maxHi: number; maxLo: number; levels: boolean; bands: number;
  /** Per bar: the oscillator, its scaled value, the lit blocks up / down and their peak-hold caps. */
  osc: number[]; n: number[]; up: number[]; dn: number[]; upPeak: number[]; dnPeak: number[];
  flipUp: boolean[]; flipDn: boolean[]; hiCross: boolean[]; loCross: boolean[];
}

/** One of the built-in oscillators, per bar (NaN = na). */
export function ampOsc(c: ReadonlyArray<Candle>, src: Exclude<AmpSrc, 'External Source'>): number[] {
  const close = c.map((b) => b.close);
  if (src === 'RSI (14)') return rsi(close, 14).map((x) => x ?? NaN);
  if (src === 'Stochastic (14,3)') {
    const hh = taHighest(c.map((b) => b.high), 14), ll = taLowest(c.map((b) => b.low), 14);
    return taSma(close.map((x, i) => (hh[i]! !== ll[i]! ? (100 * (x - ll[i]!)) / (hh[i]! - ll[i]!) : NaN)), 3); // a flat 14 bars: na (x / 0)
  }
  if (src === 'CCI (20)') {
    const m = taSma(close, 20);
    return close.map((x, i) => {
      if (Number.isNaN(m[i]!)) return NaN;
      let dev = 0;
      for (let k = i - 19; k <= i; k++) dev += Math.abs(close[k]! - m[i]!);
      return dev > 0 ? (x - m[i]!) / ((0.015 * dev) / 20) : NaN;
    });
  }
  const f = taEma(close, 12), s = taEma(close, 26), line = f.map((x, i) => x - s[i]!), sig = taEma(line, 9);
  return line.map((x, i) => x - sig[i]!);
}

/** The amplifier on every bar (bar i reads only bars up to i). `ext`: the external series, one value per bar. */
export function iAmp(c: ReadonlyArray<Candle>, opts: Partial<AmpInputs> & { ext?: ArrayLike<number> } = {}): AmpSeries {
  const o = { ...IAMP, ...opts }, { bands, rollLen } = o;
  const isExt = o.src === 'External Source', isRSI = o.src === 'RSI (14)', isSto = o.src === 'Stochastic (14,3)', isCCI = o.src === 'CCI (20)';
  const oneDir = isExt ? o.oneDir : 'Up';
  const baseMode: AmpMode = isExt ? o.mode : isRSI || isSto ? 'Bounded - Centered' : 'Unbounded - Zero-Centered';
  const zc = baseMode === 'Unbounded - Zero-Centered', baseUnb = zc || baseMode === 'Unbounded - One Direction';
  const realVals = baseUnb && rollLen === 1, fullH = o.blkSize * bands;
  const mode: AmpMode = !realVals ? baseMode : zc ? 'Bounded - Centered' : 'Bounded - One Direction';
  const lo = realVals ? (zc || oneDir === 'Down' ? -fullH : 0) : isExt ? o.lo : 0;
  const hi = realVals ? (zc ? fullH : oneDir === 'Down' ? 0 : fullH) : isExt ? o.hi : 100;
  const maxHi = isRSI ? 70 : isSto ? 80 : isCCI ? 100 : o.maxHi, maxLo = isRSI ? 30 : isSto ? 20 : isCCI ? -100 : o.maxLo;
  const levels = !(rollLen > 1 && (isCCI || o.src === 'MACD Histogram (12,26,9)' || (isExt && baseUnb)));
  const osc = isExt ? Array.from(o.ext ?? c.map((b) => b.close), Number) : ampOsc(c, o.src as Exclude<AmpSrc, 'External Source'>);

  const isBi = mode === 'Unbounded - Zero-Centered' || mode === 'Bounded - Centered', oneDn = !isBi && oneDir === 'Down';
  const hh = taHighest(osc, rollLen), ll = taLowest(osc, rollLen), mx = taHighest(osc.map(Math.abs), rollLen);
  const clamp = (x: number, min: number) => Math.max(min, Math.min(1, x)), mid = (lo + hi) / 2, half = (hi - lo) / 2;
  const n = osc.map((v, i) =>
    mode === 'Bounded - One Direction' ? (hi !== lo ? clamp((v - lo) / (hi - lo), 0) : 0.5)
      : mode === 'Bounded - Centered' ? (half !== 0 ? clamp((v - mid) / half, -1) : 0)
        : mode === 'Unbounded - One Direction' ? (hh[i]! !== ll[i]! && !Number.isNaN(hh[i]!) && !Number.isNaN(ll[i]!) ? clamp((v - ll[i]!) / (hh[i]! - ll[i]!), 0) : 0.5)
          : mx[i]! > 0 ? clamp(v / mx[i]!, -1) : 0);

  const lvl = (x: number) => Math.min(bands, Math.max(0, Math.round(nz(x) * bands)));
  const peak = () => {
    let pk = 0, age = 0;
    return (l: number) => { if (l >= pk) { pk = l; age = 0; } else if (++age > o.holdBars) pk = Math.max(l, pk - 1); return pk; };
  };
  const pu = peak(), pd = peak(), up: number[] = [], dn: number[] = [], upPeak: number[] = [], dnPeak: number[] = [];
  for (const x of n) {
    const one = oneDn ? 1 - x : x, u = isBi ? (x > 0 ? lvl(x) : 0) : oneDn ? 0 : lvl(one), d = isBi ? (x < 0 ? lvl(-x) : 0) : oneDn ? lvl(one) : 0;
    up.push(u); dn.push(d); upPeak.push(pu(u)); dnPeak.push(pd(d));
  }
  const base = mode === 'Bounded - Centered' ? mid : mode === 'Bounded - One Direction' ? (oneDn ? hi : lo) : 0;
  const over = (y: number) => osc.map((v, i) => i > 0 && v > y && osc[i - 1]! <= y);
  const under = (y: number) => osc.map((v, i) => i > 0 && v < y && osc[i - 1]! >= y);
  return {
    mode, lo, hi, base, maxHi, maxLo, levels, bands, osc, n, up, dn, upPeak, dnPeak, flipUp: over(base), flipDn: under(base),
    hiCross: over(maxHi).map((x) => x && o.useHi && levels), loCross: under(maxLo).map((x) => x && o.useLo && levels),
  };
}
