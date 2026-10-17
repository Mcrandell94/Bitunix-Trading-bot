// TypeScript port of "Momentum Shift [Bigbeluga]" (Pine v6) for the owner's ETH / BTC cards (owner 2026-10-17, cards
// v3). Calculations only (no lines, fills or labels), default inputs: length 50, smooth 50, shift zone size 1.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© BigBeluga). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - Momentum = HMA 50 of (close - close[50]). A rising shift = it crosses over its value 2 bars back (ta.crossover), a
//   falling shift = crosses under. The hollow marks (a rising shift with momentum under 0, a falling one over 0) are
//   kept as `fromOpposite`.
// - dist = SMA 100 of (high - low) x 1. A rising shift clears the falling lines and adds 6 lines at the bar's high +
//   dist x 0..5 (labelled 0..5); a falling shift clears the rising lines and adds 6 at its low - dist x 0..5. (The
//   script does not clear same-side lines on a new same-side shift; that only happens when momentum touches its value 2
//   bars back exactly between two shifts.)
// - Each bar, a rising line is stopped once a high reaches it, a falling line once a low reaches it; the same bar
//   included, so line 0 (at the shift bar's own high / low) always stops at once.
// - The card takes the lines not yet reached as levels (W / D / 4H).
// Pure.

import type { Candle } from '@bot/marketdata';
import { taHma, taSma } from './pine';

export const MOMSHIFT = { length: 50, smooth: 50, mult: 1, distLen: 100, lines: 6 } as const;

export interface MomShiftSeries { mom: number[]; rising: boolean[]; falling: boolean[]; dist: number[] }
export interface MomShiftLine { side: 1 | -1; k: number; y: number; from: number; fromOpposite: boolean; hitAt: number | null }

export function momShift(c: ReadonlyArray<Candle>): MomShiftSeries {
  const M = MOMSHIFT, cl = c.map((b) => b.close);
  const mom = taHma(cl.map((x, i) => (i >= M.length ? x - cl[i - M.length]! : NaN)), M.smooth);
  const cross = (up: boolean) => mom.map((m, i) => i >= 3 && (up ? m > mom[i - 2]! && mom[i - 1]! <= mom[i - 3]! : m < mom[i - 2]! && mom[i - 1]! >= mom[i - 3]!));
  return { mom, rising: cross(true), falling: cross(false), dist: taSma(c.map((b) => b.high - b.low), M.distLen).map((x) => x * M.mult) };
}

/** The lines on the chart at bar `at` (the current side's, reached or not). */
export function momShiftLines(c: ReadonlyArray<Candle>, at: number, s: MomShiftSeries = momShift(c)): MomShiftLine[] {
  let up: MomShiftLine[] = [], dn: MomShiftLine[] = [];
  for (let i = 0; i <= at; i++) {
    const b = c[i]!;
    if (s.rising[i]) { dn = []; for (let k = 0; k < MOMSHIFT.lines; k++) up.push({ side: 1, k, y: b.high + s.dist[i]! * k, from: i, fromOpposite: s.mom[i]! < 0, hitAt: null }); }
    if (s.falling[i]) { up = []; for (let k = 0; k < MOMSHIFT.lines; k++) dn.push({ side: -1, k, y: b.low - s.dist[i]! * k, from: i, fromOpposite: s.mom[i]! > 0, hitAt: null }); }
    for (const l of up) if (l.hitAt == null && b.high >= l.y) l.hitAt = i;
    for (const l of dn) if (l.hitAt == null && b.low <= l.y) l.hitAt = i;
  }
  return [...up, ...dn];
}
