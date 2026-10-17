// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Dynamic Volume RSI (DVRSI) [QuantAlgo]" (Pine v5, © QuantAlgo) for the owner's ETH / BTC cards
// (owner 2026-10-17, cards v3). Calculations only (no plots, fills or bar colours), default inputs: RSI length 14,
// source hlc3, smoothing length 14 (the "Enable Adaptive Smoothing" input is not used by the script's calculation).
//
// Bar-for-bar notes:
// - Smoothed volume (DynamicEMA, length 14): efficiency ratio = |vol - vol[14]| / sum of |vol - vol[1]| over 14 bars
//   (x / 0 read as na), factor = (ER x (2/3 - 2/31) + 2/31)^2, value = RMA14(vol) + factor x (vol - RMA14(vol)).
// - up / down = RMA 14 of the positive / negative change of hlc3 times the smoothed volume; index = 100 when down is 0,
//   0 when up is 0, else 100 - 100 / (1 + up / down).
// - DVRSI = EMA14(index) + 2/15 x (index - EMA14(index)) (the script's noise reducer). Pine's SMA-seeded RMA and EMA.
// - Marks: crossing over / under 50 (bullish / bearish trend shift), under 60 ("potential overbought", the script's
//   bearish take-profit alert) and over 40 ("potential oversold", bullish take profit). Candles: bullish over 50,
//   bearish under 50, else as before.
// - No price levels: not a POI script; the preview's chart check shows it.
// Volume is in coin units (pine.ts coinVolume), as the other ports; the index does not depend on the volume's scale.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taEma, taRma, taSum } from './pine';

export const DVRSI = { len: 14, smooth: 14, mid: 50, ob: 60, os: 40 } as const;

export interface DvrsiSeries {
  value: number[]; bullShift: boolean[]; bearShift: boolean[]; overbought: boolean[]; oversold: boolean[];
  /** The candle colour: 1 bullish, -1 bearish, 0 before the first. */
  trend: (1 | -1 | 0)[];
}

export function dvrsi(c: ReadonlyArray<Candle>): DvrsiSeries {
  const { len, smooth: L, mid, ob, os } = DVRSI, fast = 2 / 3, slow = 2 / 31, n = c.length;
  const vol = coinVolume(c), src = c.map((b) => (b.high + b.low + b.close) / 3);
  const volat = taSum(vol.map((v, i) => (i > 0 ? Math.abs(v - vol[i - 1]!) : NaN)), L), rv = taRma(vol, L);
  const sv = vol.map((v, i) => {
    const vt = volat[i]!, er = i >= L && vt !== 0 ? Math.abs(v - vol[i - L]!) / vt : NaN;
    return rv[i]! + (er * (fast - slow) + slow) ** 2 * (v - rv[i]!);
  });
  const ch = src.map((x, i) => (i > 0 ? x - src[i - 1]! : NaN));
  const up = taRma(ch.map((d, i) => Math.max(d, 0) * sv[i]!), len), dn = taRma(ch.map((d, i) => Math.abs(Math.min(d, 0)) * sv[i]!), len);
  const idx = up.map((u, i) => (dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i]!)));
  const e = taEma(idx, len), a = 2 / (len + 1), value = idx.map((x, i) => e[i]! + a * (x - e[i]!));
  const cross = (lvl: number, over: boolean) => value.map((v, i) => i > 0 && (over ? v > lvl && value[i - 1]! <= lvl : v < lvl && value[i - 1]! >= lvl));
  const trend: DvrsiSeries['trend'] = [];
  for (let i = 0; i < n; i++) trend.push(value[i]! > mid ? 1 : value[i]! < mid ? -1 : (trend[i - 1] ?? 0));
  return { value, bullShift: cross(mid, true), bearShift: cross(mid, false), overbought: cross(ob, false), oversold: cross(os, true), trend };
}
