// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Open Liquidity Heatmap [Bigbeluga]" (Pine v5,
// shorttitle "Open Liquidity Heatmap [1.5]", © BigBeluga) for the owner's ETH / BTC cards (owner 2026-10-16, cards v3:
// "seek more confluence from other indicators"). Calculations only (no lines, boxes, polylines or labels), default
// inputs: lookback 200, leverage 4.5, 250 levels. This port is shared under the same licence: non-commercial use only.
//
// Bar-for-bar notes (the script works on the last bar only):
// - Grid: hs = highest(200) x (1 + 4.5%), ls = lowest(200) x (1 - 4.5%), diff = (hs - ls) / 250; level k = hs - k x diff
//   (k = 0..249). Band k lies between level k + 1 and level k (k = 0..248).
// - The last bar and the 200 before it, newest first: a bar's long liquidation level is its low x (1 - 4.5%), its short
//   one its high x (1 + 4.5%). The long level counts (the bar's volume goes to every band holding it, edges included)
//   only while it is under the running low, which starts at the last bar's low and takes each bar's low as the loop goes
//   back: no newer bar has traded down to it. The short level mirrors it with the running high.
// - The chart draws band k centred on level k (half a step over the band it was counted in), coloured from transparent
//   at the least volume to full at the most, and the POC line at the fullest band (the first one if tied).
// - The bright part, taken here: the bands over the mean volume of the bands that have any; next ones join into one
//   zone (as drawn: centred on their levels). The volume profile and the resting-liquidity line starts are display only.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';

export const OPENLIQ = { back: 200, lev: 0.045, step: 250 } as const;

export interface OpenLiqZone { lo: number; hi: number; vol: number; poc: boolean }
export interface OpenLiq {
  /** Volume per band (index k = band k, between level k + 1 and level k). */
  heat: number[];
  hs: number; ls: number; diff: number;
  /** The fullest band's level (where the chart draws the POC), or null with no volume. */
  poc: number | null;
  /** The bright bands, joined, as drawn. */
  zones: OpenLiqZone[];
}

/** The heat map as the chart shows it at the close of bar `i` (only bars up to i are read). */
export function openLiq(c: ReadonlyArray<Candle>, i: number = c.length - 1): OpenLiq {
  const { back, lev, step } = OPENLIQ, heat = new Array<number>(step - 1).fill(0);
  if (i < back - 1 || i >= c.length) return { heat, hs: NaN, ls: NaN, diff: NaN, poc: null, zones: [] };
  let hi = -Infinity, lo = Infinity;
  for (let k = i - back + 1; k <= i; k++) { hi = Math.max(hi, c[k]!.high); lo = Math.min(lo, c[k]!.low); }
  const hs = hi * (1 + lev), ls = lo * (1 - lev), diff = (hs - ls) / step, level = (k: number) => (k === 0 ? hs : hs - diff * k);
  const vol = coinVolume(c.slice(Math.max(0, i - back), i + 1)), v0 = Math.max(0, i - back);
  const add = (px: number, v: number) => { for (let x = 0; x < step - 1; x++) if (px >= level(x + 1) && px <= level(x)) heat[x]! += v; };
  let runLo = c[i]!.low, runHi = c[i]!.high;
  for (let k = 0; k <= back && i - k >= 0; k++) {
    const b = c[i - k]!, v = vol[i - k - v0] || 0, lP = b.low * (1 - lev), hP = b.high * (1 + lev);
    if (lP < runLo) { if (b.low < runLo) runLo = b.low; add(lP, v); }
    if (hP > runHi) { if (b.high > runHi) runHi = b.high; add(hP, v); }
  }
  const max = Math.max(...heat), withVol = heat.filter((x) => x > 0), mean = withVol.reduce((a, b) => a + b, 0) / Math.max(1, withVol.length);
  const pocK = max > 0 ? heat.indexOf(max) : -1, zones: OpenLiqZone[] = [];
  for (let k = 0; k < heat.length; k++) {
    if (!(heat[k]! > mean)) continue;
    const z: OpenLiqZone = { lo: level(k) - diff / 2, hi: level(k) + diff / 2, vol: heat[k]!, poc: k === pocK }, last = zones.at(-1);
    if (last && k > 0 && heat[k - 1]! > mean) { last.lo = z.lo; last.vol += z.vol; last.poc ||= z.poc; } else zones.push(z);
  }
  return { heat, hs, ls, diff, poc: pocK >= 0 ? level(pocK) : null, zones };
}
