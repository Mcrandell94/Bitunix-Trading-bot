// TypeScript port of "Liquidation HeatMap [BigBeluga]" (Pine v5) for the owner's ETH / BTC cards (owner 2026-10-13,
// cards v2, second batch). Calculations only (no boxes, colours or scale table); the script has no inputs besides colours.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© BigBeluga). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - Only the last 500 bars of the chart make and track zones (last_bar_index - bar_index < 500): the port takes the bar
//   the card is for as the chart's last bar.
// - Pivots are ta.pivothigh(2, 2) / ta.pivotlow(2, 2) on the highs / lows. On the bar a pivot is confirmed and on the 2
//   bars after it, a zone is made from the high 2 bars back up by ATR(200) x k 2 bars back (lows: down from the low),
//   so each pivot leaves 3 stacked zones (the pivot bar and the next two). k = 0.2 on 4H and daily, 0.4 on weekly
//   (the script's timeframe rule).
// - Each zone's volume is that bar's volume, shown against the average and highest volume of the last 500 bars at the
//   bar it was made (the heat colour: at or under the average fades out, over it lime to yellow at the highest).
// - A zone stops when a bar trades through its middle (high over and low under it). Assumption: every zone is checked
//   once per bar (the script removes from the array it loops over; if Pine skipped the element after a removal, a swept
//   zone could last one more bar there).
// - The script allows 500 boxes; older ones are deleted by TradingView, so only the 500 newest zones can show.
// - Volume is in coin units (pine.ts coinVolume).
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr } from './pine';
import { pinePivot } from './srbreaks';

export const LIQMAP = { bars: 500, pivot: 2, atrLen: 200, maxBoxes: 500 } as const;
export const liqMult = (tf: '4H' | 'D' | 'W') => (tf === 'W' ? 0.4 : 0.2);

export interface LiqZone {
  /** 1 = above a high, -1 = under a low. */
  side: 1 | -1; top: number; bot: number;
  /** The bar it starts at (2 bars before it was made), the bar it was made, and its order of making. */
  left: number; createdAt: number; seq: number;
  vol: number; avg: number; max: number;
  /** The bar a bar traded through its middle (-1 = live). */
  removedAt: number;
}

/** The zones the chart shows with bar `at` as its last bar, and which of them are live there. */
export function liqMap(c: ReadonlyArray<Candle>, at: number, tf: '4H' | 'D' | 'W'): { zones: LiqZone[]; live: LiqZone[] } {
  const L = LIQMAP, k = liqMult(tf), hi = c.map((b) => b.high), lo = c.map((b) => b.low), atr = taAtr(c, L.atrLen), vol = coinVolume(c);
  const zones: LiqZone[] = [], open: LiqZone[] = [];
  const pv = (i: number, high: boolean) => i >= 0 && pinePivot(high ? hi : lo, i, L.pivot, L.pivot, high) != null;
  for (let i = Math.max(0, at - L.bars + 1); i <= at; i++) {
    const p = i - L.pivot;
    if (p < 0) continue;
    let s = 0, m = -Infinity, cnt = 0;
    for (let q = Math.max(0, i - L.bars + 1); q <= i; q++) if (!Number.isNaN(vol[q]!)) { s += vol[q]!; m = Math.max(m, vol[q]!); cnt++; }
    const a = atr[p]! * k, base = { left: p, createdAt: i, vol: vol[p]!, avg: cnt ? s / cnt : NaN, max: m, removedAt: -1 };
    if (!Number.isNaN(a)) {
      if (pv(i, true) || pv(i - 1, true) || pv(i - 2, true)) { const z: LiqZone = { side: 1, top: hi[p]! + a, bot: hi[p]!, seq: zones.length, ...base }; zones.push(z); open.push(z); }
      if (pv(i, false) || pv(i - 1, false) || pv(i - 2, false)) { const z: LiqZone = { side: -1, top: lo[p]!, bot: lo[p]! - a, seq: zones.length, ...base }; zones.push(z); open.push(z); }
    }
    for (const z of [...open]) {
      const mid = (z.top + z.bot) / 2;
      if (hi[i]! > mid && lo[i]! < mid) { z.removedAt = i; open.splice(open.indexOf(z), 1); }
    }
  }
  const firstShown = zones.length - L.maxBoxes;
  return { zones, live: open.filter((z) => z.seq >= firstShown) };
}
