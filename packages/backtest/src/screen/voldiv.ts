// TypeScript port of "Volume HeatMap Divergence [BigBeluga]" (Pine v6) for the owner's ETH / BTC cards (owner
// 2026-10-13, cards v2, second batch). Calculations only (no candles, lines or labels), default inputs: range 5..60
// bars, pivot left 10 / right 5.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© BigBeluga). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - vol = volume / the 100th percentile (nearest rank, i.e. the highest) of the last 1000 bars' volume x 100. With
//   fewer than 1000 bars the window is the bars there are (as rangetargets.ts percentileNearestRank).
// - A volume peak is ta.pivothigh(vol, 10, 5): confirmed 5 bars after the peak bar.
// - On a confirmed peak, with the bars since the previous peak's confirmation (ta.barssince(PH[1])) within 5..60:
//   bullish when the peak is higher than the previous peak and the peak bar's low is under the previous peak bar's
//   low (more volume into a lower low); bearish when the peak is lower and the peak bar's high is over the previous
//   peak bar's high (less volume into a higher high).
// - Volume is in coin units (pine.ts coinVolume).
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';
import { pinePivot } from './srbreaks';

export const VOLDIV = { len: 1000, minRange: 5, maxRange: 60, left: 10, right: 5 } as const;

/** A divergence: confirmed on bar `i`, its volume peak on bar `at` (= i - 5); `price` is that bar's low (bull) / high. */
export interface VolDiv { dir: 1 | -1; i: number; at: number; price: number; vol: number; prevAt: number; prevPrice: number; prevVol: number }

export function volDivergence(c: ReadonlyArray<Candle>): { vol: number[]; divs: VolDiv[] } {
  const V = VOLDIV, raw = coinVolume(c), n = c.length, vol = new Array<number>(n).fill(NaN);
  // Rolling highest of the last 1000 bars (a monotonic queue), NaN skipped.
  const q: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(raw[i]!)) { while (q.length && raw[q.at(-1)!]! <= raw[i]!) q.pop(); q.push(i); }
    while (q.length && q[0]! <= i - V.len) q.shift();
    if (q.length && !Number.isNaN(raw[i]!)) vol[i] = (raw[i]! / raw[q[0]!]!) * 100;
  }
  const divs: VolDiv[] = [];
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const ph = pinePivot(vol, i, V.left, V.right, true);
    if (ph == null || Number.isNaN(ph)) continue;
    const at = i - V.right;
    if (prev >= 0) {
      const since = i - (prev + 1), pAt = prev - V.right, inRange = since >= V.minRange && since <= V.maxRange;
      const v = vol[at]!, pv = vol[pAt]!;
      if (inRange && v > pv && c[at]!.low < c[pAt]!.low) divs.push({ dir: 1, i, at, price: c[at]!.low, vol: v, prevAt: pAt, prevPrice: c[pAt]!.low, prevVol: pv });
      if (inRange && v < pv && c[at]!.high > c[pAt]!.high) divs.push({ dir: -1, i, at, price: c[at]!.high, vol: v, prevAt: pAt, prevPrice: c[pAt]!.high, prevVol: pv });
    }
    prev = i;
  }
  return { vol, divs };
}
