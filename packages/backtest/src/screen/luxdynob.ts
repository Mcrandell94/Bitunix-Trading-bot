// TypeScript port of "Dynamic Order Blocks [LuxAlgo]" (Pine v5) for the owner's ETH / BTC cards (owner 2026-10-13,
// cards v2). Calculations only (no plots or fills), default inputs: swing lookback 10, candle bodies on.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© LuxAlgo). Non-commercial: fine for the owner's
// own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - Swings: os = 0 when high[10] is above the highest high of the last 10 bars, 1 when low[10] is under their lowest
//   low, else unchanged (starts 0; os[1] is na on the first bar). os turning 0 sets the swing top (high[10], its bar),
//   turning 1 the swing bottom; a new swing starts uncrossed.
// - Bullish OB: the first close above the swing top (the swing is then crossed). Over the bars from 1 back to the bar
//   after the swing, the bar with the lowest body low (an equal one further back takes over) gives the block: its body
//   high .. body low. New blocks go first in the list. A block is removed when a bar's body low (min(open, close)) is
//   under its bottom, the same bar included. Bearish mirrored (highest body high; removed on a body high over its top).
// - Shown: the first block of each list (the newest one still there). A bullish sweep is a bar whose low is under the
//   shown bullish bottom and closes back over it; bearish mirrored on the shown bearish top.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taHighest, taLowest } from './pine';

export const LUXOB = { length: 10 } as const;

export interface LuxBlock { dir: 1 | -1; top: number; btm: number; createdAt: number; removedAt: number }

export function luxDynOb(c: ReadonlyArray<Candle>): LuxBlock[] {
  const L = LUXOB.length, hi = c.map((b) => b.high), lo = c.map((b) => b.low), upper = taHighest(hi, L), lower = taLowest(lo, L);
  const bmax = c.map((b) => Math.max(b.close, b.open)), bmin = c.map((b) => Math.min(b.close, b.open));
  const all: LuxBlock[] = [], bull: LuxBlock[] = [], bear: LuxBlock[] = [];
  let os = 0, osPrev = NaN;
  let top = { y: NaN, x: -1, crossed: false }, btm = { y: NaN, x: -1, crossed: false };
  for (let n = 0; n < c.length; n++) {
    const b = c[n]!;
    if (n >= L) os = hi[n - L]! > upper[n]! ? 0 : lo[n - L]! < lower[n]! ? 1 : os;
    if (!Number.isNaN(osPrev)) {
      if (os === 0 && osPrev !== 0) top = { y: hi[n - L]!, x: n - L, crossed: false };
      if (os === 1 && osPrev !== 1) btm = { y: lo[n - L]!, x: n - L, crossed: false };
    }
    osPrev = os;
    if (b.close > top.y && !top.crossed) {
      top.crossed = true;
      let minima = bmax[n - 1]!, maxima = bmin[n - 1]!;
      for (let i = 1; i <= n - top.x - 1; i++) { minima = Math.min(bmin[n - i]!, minima); maxima = minima === bmin[n - i]! ? bmax[n - i]! : maxima; }
      const k: LuxBlock = { dir: 1, top: maxima, btm: minima, createdAt: n, removedAt: -1 };
      all.push(k); bull.unshift(k);
    }
    for (let i = bull.length - 1; i >= 0; i--) if (bmin[n]! < bull[i]!.btm) { bull[i]!.removedAt = n; bull.splice(i, 1); }
    if (b.close < btm.y && !btm.crossed) {
      btm.crossed = true;
      let minima = bmin[n - 1]!, maxima = bmax[n - 1]!;
      for (let i = 1; i <= n - btm.x - 1; i++) { maxima = Math.max(bmax[n - i]!, maxima); minima = maxima === bmax[n - i]! ? bmin[n - i]! : minima; }
      const k: LuxBlock = { dir: -1, top: maxima, btm: minima, createdAt: n, removedAt: -1 };
      all.push(k); bear.unshift(k);
    }
    for (let i = bear.length - 1; i >= 0; i--) if (bmax[n]! > bear[i]!.top) { bear[i]!.removedAt = n; bear.splice(i, 1); }
  }
  return all;
}

/** The shown bullish and bearish blocks at bar i: the newest of each side still in its list. */
export function luxShown(ks: ReadonlyArray<LuxBlock>, i: number): { bull: LuxBlock | null; bear: LuxBlock | null } {
  const alive = (k: LuxBlock) => k.createdAt <= i && (k.removedAt < 0 || k.removedAt > i);
  let bull: LuxBlock | null = null, bear: LuxBlock | null = null;
  for (const k of ks) if (alive(k)) { if (k.dir === 1) bull = k; else bear = k; }
  return { bull, bear };
}

/** The script's sweep candles at bar i: a wick through the shown block's outer edge that closes back. */
export function luxSweep(c: ReadonlyArray<Candle>, ks: ReadonlyArray<LuxBlock>, i: number): { bull: boolean; bear: boolean } {
  const s = luxShown(ks, i), b = c[i]!;
  return { bull: s.bull != null && b.low < s.bull.btm && b.close > s.bull.btm, bear: s.bear != null && b.high > s.bear.top && b.close < s.bear.top };
}
