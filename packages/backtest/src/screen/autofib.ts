// TypeScript port of "Auto-Fibonacci Levels [ChartWhizzperer]" (Pine v6) for the owner's ETH / BTC cards (owner
// 2026-10-13, cards v2, second batch). Calculations only (no lines, labels or anchor plots), default inputs: swing length
// 20, Classic mode (confirmed pivots, no repainting), direction Auto, levels 0 / 23.6 / 38.2 / 50 / 61.8 / 100 / 161.8 /
// 261.8% shown (the negative levels are off by default).
//
// Licence: Mozilla Public License 2.0 (© ChartWhizzperer).
//
// Bar-for-bar notes:
// - Swing high / low = the latest ta.pivothigh / ta.pivotlow (20, 20); the range is their max / min.
// - Direction (Auto): bullish when the swing low's bar is before the swing high's (0% at the low, levels measured up
//   from it), bearish otherwise (0% at the high, measured down); bullish while either is missing.
// - The lines are redrawn only on a bar with a new swing high or a new swing low, not both; the levels shown are the
//   ones drawn then (a bar with both keeps the old lines).
// - The script's alerts: the close crossing over / under a shown level, the levels taken from the current swings on
//   every bar (ta.crossover(close, level): over now, at or under on the bar before).
// Pure.

import type { Candle } from '@bot/marketdata';
import { pinePivot } from './srbreaks';

export const AUTOFIB = { len: 20, levels: [0, 0.236, 0.382, 0.5, 0.618, 1, 1.618, 2.618] } as const;

export interface AutoFibSet { at: number; hi: number; lo: number; bull: boolean }
export interface AutoFibCross { i: number; level: number; price: number; up: boolean }

export const autoFibPrice = (s: { hi: number; lo: number; bull: boolean }, p: number) => (s.bull ? s.lo + (s.hi - s.lo) * p : s.hi - (s.hi - s.lo) * p);
export const fibPct = (p: number) => `${Number((p * 100).toFixed(1))}%`;

export function autoFib(c: ReadonlyArray<Candle>): { sets: AutoFibSet[]; crosses: AutoFibCross[] } {
  const A = AUTOFIB, hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  let sh = NaN, sl = NaN, shAt = -1, slAt = -1;
  const sets: AutoFibSet[] = [], crosses: AutoFibCross[] = [];
  let prevPx: number[] | null = null;
  for (let i = 0; i < c.length; i++) {
    const ph = pinePivot(hi, i, A.len, A.len, true), pl = pinePivot(lo, i, A.len, A.len, false);
    if (ph != null) { sh = ph; shAt = i - A.len; }
    if (pl != null) { sl = pl; slAt = i - A.len; }
    const have = !Number.isNaN(sh) && !Number.isNaN(sl);
    const cur = have ? { hi: Math.max(sh, sl), lo: Math.min(sh, sl), bull: shAt >= 0 && slAt >= 0 ? slAt < shAt : true } : null;
    if (cur && (ph != null) !== (pl != null)) sets.push({ at: i, ...cur });
    const px = cur ? A.levels.map((p) => autoFibPrice(cur, p)) : null;
    if (px && prevPx && i >= 1) {
      A.levels.forEach((p, k) => {
        const x = px[k]!, y = prevPx![k]!, cl = c[i]!.close, pc = c[i - 1]!.close;
        if (cl > x && pc <= y) crosses.push({ i, level: p, price: x, up: true });
        if (cl < x && pc >= y) crosses.push({ i, level: p, price: x, up: false });
      });
    }
    if (px) prevPx = px;
  }
  return { sets, crosses };
}

/** The lines on the chart at bar i (the last set drawn by then), or null. */
export function autoFibAt(sets: ReadonlyArray<AutoFibSet>, i: number): AutoFibSet | null {
  let s: AutoFibSet | null = null;
  for (const x of sets) if (x.at <= i) s = x; else break;
  return s;
}
