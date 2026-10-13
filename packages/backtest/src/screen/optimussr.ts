// TypeScript port of "Optimus S/R Zones" (Pine v6; the copy given has no author or licence header) for the owner's
// ETH / BTC cards (owner 2026-10-13, cards v2). Calculations only (no lines, boxes, labels or dashboard), default
// inputs: auto lookback by timeframe (4H 200, daily 120, weekly 80 bars), pivot strength 5, at most 3 levels per side,
// at least 1.8% between levels, 2+ touches within 0.3%, zone width 0.25% of the close, fallback lookback 200.
//
// Bar-for-bar notes (the script works on the last bar only):
// - Pivots: bars 5..lookback back whose low (high) is strictly lower (higher) than each of the 5 bars on both sides.
// - Touches: the bars 0..lookback back (the pivot bar included) whose low (high) is within 0.3% of the level; a pivot
//   needs 2.
// - Ranking: by touches, more first; equal touches nearer the close first (the script's pairwise swap sort, kept).
//   Then, in that order: supports under the close and resistances over it, each at least 1.8% from those already
//   kept, 3 at most.
// - When a side finds none and the fallback lookback (200) is longer, both sides are found again with it.
// - The zone is the level +/- 0.25% of the close; the dashboard's "nearest" is the first kept level (the strongest).
// Pure.

import type { Candle } from '@bot/marketdata';

export const OPTIMUS = { lookback: { '4H': 200, D: 120, W: 80 } as const, strength: 5, maxLevels: 3, minDistPct: 1.8, minTouches: 2, touchPct: 0.3, zonePct: 0.25, fallback: 200 } as const;

export interface OptLevel { price: number; touches: number; age: number }

function findPivots(c: ReadonlyArray<Candle>, at: number, lookback: number, sup: boolean): OptLevel[] {
  const O = OPTIMUS, out: OptLevel[] = [], v = (k: number) => (sup ? c[at - k]!.low : c[at - k]!.high);
  const maxOffset = Math.max(0, Math.min(lookback, at - O.strength - 1));
  if (maxOffset < O.strength * 2) return out;
  for (let i = O.strength; i <= maxOffset; i++) {
    const p = v(i);
    let pivot = true;
    for (let j = 1; j <= O.strength && pivot; j++) if (sup ? p >= v(i - j) || p >= v(i + j) : p <= v(i - j) || p <= v(i + j)) pivot = false;
    if (!pivot) continue;
    let touches = 0;
    const range = p * (O.touchPct / 100);
    for (let k = 0; k <= Math.min(lookback, at); k++) if (Math.abs(v(k) - p) <= range) touches++;
    if (touches >= O.minTouches) out.push({ price: p, touches, age: i });
  }
  return out;
}

function filterLevels(levels: OptLevel[], price: number, sup: boolean): OptLevel[] {
  const O = OPTIMUS, xs = [...levels];
  for (let i = 0; i < xs.length - 1; i++) for (let j = i + 1; j < xs.length; j++) {
    const a = xs[i]!, b = xs[j]!;
    if (b.touches > a.touches || (b.touches === a.touches && Math.abs(b.price - price) < Math.abs(a.price - price))) { xs[i] = b; xs[j] = a; }
  }
  const out: OptLevel[] = [];
  for (const l of xs) {
    if (out.length >= O.maxLevels) break;
    if (sup ? l.price >= price : l.price <= price) continue;
    if (out.some((e) => (Math.abs(l.price - e.price) / e.price) * 100 < O.minDistPct)) continue;
    out.push(l);
  }
  return out;
}

/** The support and resistance levels the script shows on bar `at` of a timeframe's bars, strongest first. */
export function optimusSr(c: ReadonlyArray<Candle>, at: number, tf: '4H' | 'D' | 'W'): { support: OptLevel[]; resistance: OptLevel[]; lookback: number; zone: number } {
  const O = OPTIMUS, price = c[at]!.close;
  let lookback: number = O.lookback[tf];
  const find = () => ({ s: filterLevels(findPivots(c, at, lookback, true), price, true), r: filterLevels(findPivots(c, at, lookback, false), price, false) });
  let { s, r } = find();
  if ((!s.length || !r.length) && O.fallback > lookback) { lookback = O.fallback; ({ s, r } = find()); }
  return { support: s, resistance: r, lookback, zone: price * (O.zonePct / 100) };
}
