// TypeScript port of "Market Trend Levels Detector [BigBeluga]" (Pine v6) for the owner's ETH / BTC cards (owner
// 2026-10-17, cards v3). Calculations only (no lines, labels or fill), default inputs: fast EMA 12, slow EMA 25, the
// last 50 lines.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© BigBeluga). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - On a confirmed bar where EMA 12 crosses over EMA 25 (ta.crossover; Pine's SMA-seeded EMAs), each bar 0..25 back
//   whose low equals the lowest low of the last 25 bars gets a support line at that low; on a cross under, each bar
//   whose high equals the highest high of 25 gets a resistance line. (The search covers 26 bars, the lowest / highest
//   25; a bar 25 back counts only when it ties.)
// - Only the last 50 lines stay on the chart. With "Extend Lines" (off by default) a line runs to the current bar
//   until broken: a resistance by a high over it, a support by a low under it (the creation bar included, which never
//   breaks it). Off, each line is drawn 25 bars long from its bar.
// - The card takes, of the last 50 lines, those not broken since (the script's own extend rule), as S/R levels on
//   W / D / 4H; with the default 25-bar lines almost none would reach the current bar.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taEma, taHighest, taLowest } from './pine';

export const MTL = { fast: 12, slow: 25, qty: 50 } as const;

export interface MtlLine {
  /** 1 = resistance (from a cross under), -1 = support (from a cross over). */
  side: 1 | -1; y: number; at: number; cross: number;
  /** The first bar that broke it (the extend rule), or null. */
  brokenAt: number | null;
}

/** The last 50 lines as of bar `at`, oldest first. */
export function mtlLines(c: ReadonlyArray<Candle>, at: number): MtlLine[] {
  const M = MTL, cc = c.slice(0, at + 1), cl = cc.map((b) => b.close), e1 = taEma(cl, M.fast), e2 = taEma(cl, M.slow);
  const lo = taLowest(cc.map((b) => b.low), M.slow), hi = taHighest(cc.map((b) => b.high), M.slow);
  const all: MtlLine[] = [], live: MtlLine[] = [];
  for (let i = 0; i < cc.length; i++) {
    const b = cc[i]!, up = i > 0 && e1[i]! > e2[i]! && e1[i - 1]! <= e2[i - 1]!, dn = i > 0 && e1[i]! < e2[i]! && e1[i - 1]! >= e2[i - 1]!;
    if (up || dn) for (let k = 0; k <= M.slow && i - k >= 0; k++) {
      const x = cc[i - k]!;
      if (up && x.low === lo[i]) { const l: MtlLine = { side: -1, y: lo[i]!, at: i - k, cross: i, brokenAt: null }; all.push(l); live.push(l); }
      if (dn && x.high === hi[i]) { const l: MtlLine = { side: 1, y: hi[i]!, at: i - k, cross: i, brokenAt: null }; all.push(l); live.push(l); }
    }
    for (let k = live.length - 1; k >= 0; k--) {
      const l = live[k]!;
      if (l.side > 0 ? b.high > l.y : b.low < l.y) { l.brokenAt = i; live.splice(k, 1); }
    }
  }
  return all.slice(-M.qty);
}
