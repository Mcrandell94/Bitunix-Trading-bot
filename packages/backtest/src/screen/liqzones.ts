// This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Liquidity Zones [BigBeluga]" (Pine v5,
// © BigBeluga) for the owner's ETH / BTC cards (owner 2026-10-16, cards v3). Calculations only (no boxes, lines, labels
// or table), default inputs: length 10 (pivots 10 left / 8 right), 10 zones, volume strength filter "Mid" (2), simple
// distance (not dynamic). This port is shared under the same licence: non-commercial use only.
//
// Bar-for-bar notes:
// - Pivots: ta.pivothigh / ta.pivotlow(10, 8), confirmed 8 bars after the pivot (srbreaks.ts pinePivot). A bar that is
//   both takes the high (the script's switch).
// - Volume strength: avg = SMA 8 of the volume, strength = avg / stdev(avg, 500) (population; a ratio, not a z-score). A
//   pivot draws a zone when the strength on the pivot bar is over 2 ("Mid").
// - The zone: a box from the pivot high up to high + ATR(200) (from the low down to low - ATR(200)), with the ATR of
//   the confirmation bar, and a line at that outer edge that extends while price leaves it alone. A bar trading through
//   the line (high over it and low under it, the confirmation bar included) grabs it: the line turns dashed and is no
//   longer tracked. The script runs that check on the chart's last 1500 bars only.
// - Only the 10 most recent zones stay on the chart, grabbed ones included (older ones are deleted).
// - The card takes each live line (on the chart, not grabbed) as a Liq level: that is where the script places the
//   liquidity and checks the grab, and the box behind it starts at the pivot itself, which the S/R scripts already count.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taSma, taStdev } from './pine';
import { pinePivot } from './srbreaks';

export const LIQZONES = { left: 10, right: 8, qty: 10, filter: 2, volLen: 500, atrLen: 200, checkBars: 1500 } as const;

export interface LiqZone {
  /** 1 = over a pivot high, -1 = under a pivot low. */
  side: 1 | -1;
  /** The pivot bar, the bar the zone was drawn on (8 bars later), the pivot's high / low and the line (pivot ± ATR(200)). */
  pivotAt: number; at: number; edge: number; level: number;
  /** The SMA 8 volume on the pivot bar (the box's text) and its strength (avg / stdev). */
  vol: number; strength: number;
}

/** Every zone the script draws, in order (bar i reads only the bars up to it). */
export function liqZones(c: ReadonlyArray<Candle>): LiqZone[] {
  const { left, right, filter, volLen, atrLen } = LIQZONES;
  const hi = c.map((b) => b.high), lo = c.map((b) => b.low), avg = taSma(coinVolume(c), right), sd = taStdev(avg, volLen), atr = taAtr(c, atrLen);
  const out: LiqZone[] = [];
  for (let i = right; i < c.length; i++) {
    const k = i - right, strength = sd[k]! > 0 ? avg[k]! / sd[k]! : NaN;
    if (!(strength > filter)) continue;
    const ph = pinePivot(hi, i, left, right, true), pl = ph == null ? pinePivot(lo, i, left, right, false) : null;
    if (ph == null && pl == null) continue;
    const side = ph != null ? 1 : -1, edge = (ph ?? pl)!;
    out.push({ side, pivotAt: k, at: i, edge, level: edge + side * atr[i]!, vol: avg[k]!, strength });
  }
  return out;
}

/** The zones on the chart at the close of bar i (the 10 most recent drawn by then), each with the bar that grabbed it. */
export function liqZonesAt(zs: ReadonlyArray<LiqZone>, c: ReadonlyArray<Candle>, i: number): (LiqZone & { grabbedAt: number | null })[] {
  return zs.filter((z) => z.at <= i).slice(-LIQZONES.qty).map((z) => {
    let grabbedAt: number | null = null;
    for (let k = Math.max(z.at, i - LIQZONES.checkBars + 1); k <= i && grabbedAt == null; k++) if (c[k]!.high > z.level && c[k]!.low < z.level) grabbedAt = k;
    return { ...z, grabbedAt };
  });
}
