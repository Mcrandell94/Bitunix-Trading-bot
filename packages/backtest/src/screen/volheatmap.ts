// TypeScript port of "Heatmap Volume [xdecow]" (Pine v5; the copy given has no licence header, TradingView's default for
// open scripts is MPL 2.0) for the owner's ETH / BTC cards (owner 2026-10-13, cards v2, second batch). Calculations only
// (no bar colours, fills or plots), default inputs: MA length 610, deviation length 610, thresholds extra high 4, high
// 2.5, medium 1, normal -0.5.
//
// Bar-for-bar notes:
// - Both lengths are cut to the bars there are (bar_index + 1) until 610 bars exist, as the script does.
// - Mean = SMA of the volume, deviation = Pine's ta.stdev (population) over the same bars; the bar's score is
//   (volume - mean) / deviation, in deviations from the mean.
// - Level: extra high over 4, high over 2.5, medium over 1, normal over -0.5, low otherwise (an na score is low, as
//   the script's comparisons fall through). The colour's up / down side is close > open.
// - Volume is in coin units (pine.ts coinVolume), as TradingView shows crypto volume.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';

export const HMV = { len: 610, sLen: 610, extraHigh: 4, high: 2.5, medium: 1, normal: -0.5 } as const;
export type VolLevel = 'extra high' | 'high' | 'medium' | 'normal' | 'low';
export interface HmvSeries { z: number[]; level: VolLevel[]; up: boolean[] }

export const volLevel = (z: number): VolLevel => (z > HMV.extraHigh ? 'extra high' : z > HMV.high ? 'high' : z > HMV.medium ? 'medium' : z > HMV.normal ? 'normal' : 'low');

export function heatmapVolume(c: ReadonlyArray<Candle>): HmvSeries {
  const v = coinVolume(c), n = c.length, z = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const L = Math.min(HMV.len, i + 1), S = Math.min(HMV.sLen, i + 1);
    let s = 0, bad = false;
    for (let k = i - L + 1; k <= i; k++) { if (Number.isNaN(v[k]!)) { bad = true; break; } s += v[k]!; }
    if (bad) continue;
    const mean = s / L;
    let sm = 0;
    for (let k = i - S + 1; k <= i; k++) sm += v[k]!;
    const m2 = sm / S;
    let ss = 0;
    for (let k = i - S + 1; k <= i; k++) ss += (v[k]! - m2) ** 2;
    const sd = Math.sqrt(ss / S);
    if (sd > 0) z[i] = (v[i]! - mean) / sd;
  }
  return { z, level: z.map(volLevel), up: c.map((b) => b.close > b.open) };
}
