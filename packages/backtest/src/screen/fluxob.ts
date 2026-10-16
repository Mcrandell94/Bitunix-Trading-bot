// This Pine Script code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Volumized Order Blocks | Flux Charts" (Pine v5, © fluxchart) for the owner's ETH / BTC cards
// (owner 2026-10-16, cards v3). Calculations only (no boxes, volume bars or text), default inputs: swing length 10,
// zone invalidation "Wick", zone count "Low" (3 a side), historic zones shown, zones combined, ATR(10) x 3.5 at most.
//
// Bar-for-bar notes (the script draws on the chart's timeframe; "the last bar" is bar i):
// - It only runs on the chart's last 1750 bars, so its state starts from scratch 1749 bars before bar i (the swing
//   type at 0, no swings; bar values from before that start read na, as the script's own series do).
// - Swings: the bar 10 back is a swing high when its high is over the highest high of the 10 bars after it (low under
//   the lowest low: a swing low); the swing type only changes on those, and a new swing is kept when the type flips.
// - Bullish block: the first close over the last swing high (once per swing) takes, from the bars between the swing
//   and this bar, the one with the lowest low (the oldest if tied): its high and low. Volume = this bar's + the 2 before
//   (high part: this bar and the one before; low part: 2 bars back). Kept when no taller than 3.5 x ATR(10); the 30
//   newest are kept. Bearish mirrored on the swing lows (the highest high).
// - A wick under a bullish block's bottom makes it a breaker (broken; it stays as a historic zone, drawn up to the
//   break); a breaker is removed once a high goes over its top. Bearish mirrored.
// - Shown: the 3 newest of each list (breakers included); same-side blocks whose time x price boxes overlap (a live
//   box runs to the bar) are merged until none do: the outer edges, summed volume, the earliest start, the latest break
//   (a merge with a breaker is a breaker).
// - The card takes the shown blocks that are not breakers (bullish = long side, bearish = short side).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr } from './pine';

export const FLUXOB = { swing: 10, atrLen: 10, maxAtrMult: 3.5, maxBlocks: 30, shown: 3, window: 1750 } as const;

export interface FluxBlock {
  side: 1 | -1; top: number; bottom: number;
  /** The block candle (bar index and open time; the earliest one for a merged block). */
  startAt: number; startTime: number;
  vol: number; highVol: number; lowVol: number;
  breaker: boolean; breakTime: number | null; combined: boolean;
}

/** The blocks at the close of bar i (bars up to i only): the two lists (newest first) and the ones on the chart. */
export function fluxObs(c: ReadonlyArray<Candle>, i: number = c.length - 1): { bull: FluxBlock[]; bear: FluxBlock[]; shown: FluxBlock[] } {
  const { swing: len, maxAtrMult, maxBlocks, shown: nShown, window } = FLUXOB;
  if (i < 0 || i >= c.length) return { bull: [], bear: [], shown: [] };
  const start = Math.max(0, i - window + 1), atr = taAtr(c.slice(0, i + 1), FLUXOB.atrLen), vol = coinVolume(c.slice(0, i + 1));
  const H = (k: number) => (k >= start ? c[k]!.high : NaN), L = (k: number) => (k >= start ? c[k]!.low : NaN);
  const bull: FluxBlock[] = [], bear: FluxBlock[] = [];
  let swingType = 0, prev = NaN;
  let top = { x: NaN, y: NaN, crossed: false }, btm = { x: NaN, y: NaN, crossed: false };
  const range = (from: number, to: number) => { const out: number[] = []; if (from <= to) for (let d = from; d <= to; d++) out.push(d); else for (let d = from; d >= to; d--) out.push(d); return out; };
  for (let k = start; k <= i; k++) {
    const b = c[k]!;
    let upper = -Infinity, lower = Infinity;
    for (let q = k - len + 1; q <= k; q++) { upper = Math.max(upper, q >= 0 ? c[q]!.high : NaN); lower = Math.min(lower, q >= 0 ? c[q]!.low : NaN); }
    const hk = k - len >= 0 ? c[k - len]!.high : NaN, lk = k - len >= 0 ? c[k - len]!.low : NaN;
    swingType = hk > upper ? 0 : lk < lower ? 1 : swingType;
    if (swingType === 0 && !Number.isNaN(prev) && prev !== 0) top = { x: k - len, y: hk, crossed: false };
    if (swingType === 1 && !Number.isNaN(prev) && prev !== 1) btm = { x: k - len, y: lk, crossed: false };
    prev = swingType;

    for (let q = bull.length - 1; q >= 0; q--) {
      const ob = bull[q]!;
      if (!ob.breaker) { if (b.low < ob.bottom) { ob.breaker = true; ob.breakTime = b.openTime; } } else if (b.high > ob.top) bull.splice(q, 1);
    }
    if (b.close > top.y && !top.crossed) {
      top.crossed = true;
      let lo = H(k - 1), hi = L(k - 1), loc = k - 1;
      for (const d of range(1, k - top.x - 1)) { const m = L(k - d); lo = Math.min(m, lo); if (lo === m) { hi = H(k - d); loc = k - d; } }
      if (Math.abs(hi - lo) <= atr[k]! * maxAtrMult) {
        bull.unshift({ side: 1, top: hi, bottom: lo, startAt: loc, startTime: c[loc]!.openTime, vol: vol[k]! + vol[k - 1]! + vol[k - 2]!, highVol: vol[k]! + vol[k - 1]!, lowVol: vol[k - 2]!, breaker: false, breakTime: null, combined: false });
        if (bull.length > maxBlocks) bull.pop();
      }
    }

    for (let q = bear.length - 1; q >= 0; q--) {
      const ob = bear[q]!;
      if (!ob.breaker) { if (b.high > ob.top) { ob.breaker = true; ob.breakTime = b.openTime; } } else if (b.low < ob.bottom) bear.splice(q, 1);
    }
    if (b.close < btm.y && !btm.crossed) {
      btm.crossed = true;
      let lo = L(k - 1), hi = H(k - 1), loc = k - 1;
      for (const d of range(1, k - btm.x - 1)) { const m = H(k - d); hi = Math.max(m, hi); if (hi === m) { lo = L(k - d); loc = k - d; } }
      if (Math.abs(hi - lo) <= atr[k]! * maxAtrMult) {
        bear.unshift({ side: -1, top: hi, bottom: lo, startAt: loc, startTime: c[loc]!.openTime, vol: vol[k]! + vol[k - 1]! + vol[k - 2]!, highVol: vol[k - 2]!, lowVol: vol[k]! + vol[k - 1]!, breaker: false, breakTime: null, combined: false });
        if (bear.length > maxBlocks) bear.pop();
      }
    }
  }

  // The shown blocks: the 3 newest of each side, then the overlapping same-side ones merged until none overlap.
  const now = c[i]!.openTime + 1, x2 = (z: FluxBlock) => z.breakTime ?? now, area = (z: FluxBlock) => Math.abs(x2(z) - z.startTime) * Math.abs(z.top - z.bottom);
  const touch = (a: FluxBlock, b: FluxBlock) => {
    const inter = Math.max(0, Math.min(x2(a), x2(b)) - Math.max(a.startTime, b.startTime)) * Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
    return (inter / (area(a) + area(b) - inter)) * 100 > 0;
  };
  let list = [...bull.slice(0, nShown), ...bear.slice(0, nShown)].map((z) => ({ ...z }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < list.length; a++) for (let b = 0; b < list.length; b++) {
      const A = list[a]!, B = list[b]!;
      if (a === b || A.side !== B.side || !touch(A, B)) continue;
      const brk = Math.max(A.breakTime ?? 0, B.breakTime ?? 0), first = A.startTime <= B.startTime ? A : B;
      const m: FluxBlock = { side: A.side, top: Math.max(A.top, B.top), bottom: Math.min(A.bottom, B.bottom), startAt: first.startAt, startTime: first.startTime, vol: A.vol + B.vol, highVol: A.highVol + B.highVol, lowVol: A.lowVol + B.lowVol, breaker: A.breaker || B.breaker, breakTime: brk === 0 ? null : brk, combined: true };
      list = [m, ...list.filter((_, k) => k !== a && k !== b)];
      merged = true;
      break outer;
    }
  }
  return { bull, bear, shown: list };
}
