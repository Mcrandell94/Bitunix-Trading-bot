// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Trend Lines v2" (Pine v4, © LonesomeTheBlue) for the owner's ETH / BTC cards (owner 2026-10-16,
// cards v3). Calculations only (no lines drawn), default inputs: pivot period 20, 3 pivot points checked, from 2020-01-01.
//
// Bar-for-bar notes (the script redraws its lines on every bar; here "the bar" is bar i):
// - Pivots: pivothigh / pivotlow(20, 20), confirmed 20 bars after the pivot (srbreaks.ts pinePivot). The script keeps
//   the last 3 of each, newest first, with the bar each was confirmed on.
// - Up lines: for the newest pivot low, then the second newest (p1), each older pivot low (p2, the oldest first) that is
//   lower draws a line from p2 through p1. It is valid when no close from the bar after p2 to bar i is under the line
//   (the line value is stepped bar by bar, as the script adds its slope); the first valid p2 is taken. So up to 2 up
//   lines, ending at bar i. Down lines mirror it on the pivot highs (lower highs; no close over the line).
// - The card takes each line's value at bar i as an S/R level (support under an up line, resistance over a down line).
// Pure.

import type { Candle } from '@bot/marketdata';
import { pinePivot } from './srbreaks';

export const TRENDLINES = { prd: 20, ppNum: 3, maxLine: 3, start: Date.UTC(2020, 0, 1) } as const;

export interface TrendLine {
  /** 1 = up line under the pivot lows (support), -1 = down line over the pivot highs (resistance). */
  side: 1 | -1;
  /** The older pivot (the line's start), the newer pivot it runs through, and its slope per bar. */
  from: { at: number; v: number }; through: { at: number; v: number }; slope: number;
  /** The line's value at bar i (its end). */
  now: number;
}

/** The last `n` pivots confirmed by bar i, newest first: the value, the pivot bar and the bar it was confirmed on. */
function lastPivots(src: ReadonlyArray<number>, i: number, high: boolean): { v: number; at: number; pos: number }[] {
  const { prd, ppNum } = TRENDLINES, out: { v: number; at: number; pos: number }[] = [];
  for (let k = i; k >= 2 * prd && out.length < ppNum; k--) { const v = pinePivot(src, k, prd, prd, high); if (v != null && v !== 0) out.push({ v, at: k - prd, pos: k }); }
  return out;
}

/** The lines drawn at the close of bar i (bars up to i only). */
export function trendLines(c: ReadonlyArray<Candle>, i: number = c.length - 1): { up: TrendLine[]; down: TrendLine[] } {
  const { prd, ppNum, maxLine, start } = TRENDLINES, up: TrendLine[] = [], down: TrendLine[] = [];
  if (i < 0 || i >= c.length || c[i]!.openTime < start) return { up, down };
  const cc = c.slice(0, i + 1), bot = lastPivots(cc.map((b) => b.low), i, false), top = lastPivots(cc.map((b) => b.high), i, true);
  for (let p1 = 0; p1 <= ppNum - 2; p1++) {
    for (const [piv, side, out] of [[bot, 1, up], [top, -1, down]] as const) {
      if (out.length > maxLine) continue;
      for (let p2 = ppNum - 1; p2 >= p1 + 1; p2--) {
        const a = piv[p1], b = piv[p2];
        if (!a || !b || !(side > 0 ? a.v > b.v : a.v < b.v)) continue;
        const diff = (side > 0 ? a.v - b.v : b.v - a.v) / (a.pos - b.pos);
        let line = side > 0 ? b.v + diff : b.v - diff, valid = true;
        for (let x = b.pos + 1 - prd; x <= i; x++) {
          if (side > 0 ? cc[x]!.close < line : cc[x]!.close > line) { valid = false; break; }
          line = side > 0 ? line + diff : line - diff;
        }
        if (valid) {
          if (out.length < maxLine) out.push({ side, from: { at: b.at, v: b.v }, through: { at: a.at, v: a.v }, slope: side * diff, now: side > 0 ? line - diff : line + diff });
          break;
        }
      }
    }
  }
  return { up, down };
}
