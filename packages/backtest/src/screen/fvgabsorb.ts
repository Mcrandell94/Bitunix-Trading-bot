// TypeScript port of "Fair Value Gap Absorption Indicator [LuxAlgo]" (Pine v5) for the owner's ETH / BTC cards (owner
// 2026-10-13, cards v2). Calculations only (no boxes or labels), default inputs: width filter 0.5 x ATR(144).
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© LuxAlgo). Non-commercial: fine for the owner's
// own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - The filter is nz(ATR(144)) x 0.5: no filter while ATR(144) is not there yet.
// - Bullish gap: low - high[2] > filter, low > high[2], close[1] > high[2], and neither this bar nor the one before is
//   a full gap up (low > the previous high). Zone = high[2] .. low. Bearish mirrored (low[2] - high > filter, high <
//   low[2], close[1] < low[2], no full gap down on this bar or the one before). Zone = high .. low[2].
// - Only the latest gap is tracked: a new gap ends the one before ("replaced"), and so does any full gap bar (a low
//   over the previous high or a high under the previous low), the new gap's own bar included.
// - Each bar the tracked gap overlaps (high > its bottom and low < its top), the absorbed part grows: bullish from the
//   top down to the bar's low (the share shown is absorbed / the whole gap); a low at or under the bottom absorbs it
//   all and ends it. Bearish mirrored. Nothing is absorbed on the gap's own bar.
// Pure.

import type { Candle } from '@bot/marketdata';
import { nz, taAtr } from './pine';

export const FVGABS = { atrLen: 144, width: 0.5 } as const;

export interface AbsGap {
  dir: 1 | -1; top: number; bot: number; createdAt: number;
  /** The absorbed edge after each bar it moved (bullish: falling from the top; bearish: rising from the bottom). */
  fills: { i: number; edge: number }[];
  /** The bar tracking ended (-1 = still tracked) and why. */
  endAt: number; how: 'absorbed' | 'replaced' | 'gap' | null;
}

export function fvgAbsorb(c: ReadonlyArray<Candle>): AbsGap[] {
  const atr = taAtr(c, FVGABS.atrLen), all: AbsGap[] = [];
  let cur: AbsGap | null = null;
  const end = (i: number, how: 'absorbed' | 'replaced' | 'gap') => { if (cur) { cur.endAt = i; cur.how = how; cur = null; } };
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, p1 = c[i - 1], p2 = c[i - 2];
    const bullG = (k: number) => k >= 1 && c[k]!.low > c[k - 1]!.high, bearG = (k: number) => k >= 1 && c[k]!.high < c[k - 1]!.low;
    const f = nz(atr[i]!) * FVGABS.width;
    if (p1 && p2) {
      const bull = b.low - p2.high > f && b.low > p2.high && p1.close > p2.high && !(bullG(i) || bullG(i - 1));
      if (bull) { end(i, 'replaced'); cur = { dir: 1, top: b.low, bot: p2.high, createdAt: i, fills: [], endAt: -1, how: null }; all.push(cur); }
      const bear = p2.low - b.high > f && b.high < p2.low && p1.close < p2.low && !(bearG(i) || bearG(i - 1));
      if (bear) { end(i, 'replaced'); cur = { dir: -1, top: p2.low, bot: b.high, createdAt: i, fills: [], endAt: -1, how: null }; all.push(cur); }
    }
    if (bullG(i) || bearG(i)) end(i, 'gap');
    const g = cur as AbsGap | null;
    if (!g) continue;
    const edge = g.fills.length ? g.fills.at(-1)!.edge : g.dir > 0 ? g.top : g.bot;
    const uTop = g.dir > 0 ? edge : g.top, uBot = g.dir > 0 ? g.bot : edge;
    if (b.high > uBot && b.low < uTop) {
      if (g.dir > 0) {
        if (b.low > uBot) g.fills.push({ i, edge: Math.min(b.low, edge) });
        else { g.fills.push({ i, edge: g.bot }); end(i, 'absorbed'); }
      } else if (b.high < uTop) g.fills.push({ i, edge: Math.max(b.high, edge) });
      else { g.fills.push({ i, edge: g.top }); end(i, 'absorbed'); }
    }
  }
  return all;
}

/** The gap tracked at bar i and the share of it absorbed by then (0..1), or null. */
export function absAt(gs: ReadonlyArray<AbsGap>, i: number): { g: AbsGap; absorbed: number } | null {
  let g: AbsGap | null = null;
  for (const x of gs) if (x.createdAt <= i && (x.endAt < 0 || x.endAt > i)) g = x;
  if (!g) return null;
  let edge = g.dir > 0 ? g.top : g.bot;
  for (const f of g.fills) if (f.i <= i) edge = f.edge;
  return { g, absorbed: g.top > g.bot ? (g.dir > 0 ? g.top - edge : edge - g.bot) / (g.top - g.bot) : 0 };
}
