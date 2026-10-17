// Anchored VWAPs for the ETH / BTC cards (owner 2026-10-17: "an accurate vwap for each weekly, daily, 4hr"), as
// TradingView's built-in VWAP (source hlc3, bands from the volume-weighted standard deviation, x 1 / 2 / 3), anchored at
// the start of the week (Monday 00:00 UTC), the day (00:00 UTC) and the 4H bar. Not one of the owner's pasted scripts.
//
// - The period is the one the last closed bar falls in (the moment just before t): at a 4H close that is the 4H bar
//   that just closed (the new one has no trades yet), today (yesterday at 00:00) and this week (last week on Monday
//   00:00).
// - Each is built from the finest bars that reach back to its anchor: 15m for the 4H bar and the day, 1H for the week
//   (the worker keeps two days of 15m bars), else the next coarser ones. Only bars closed by t are used.
// - vwap = sum(hlc3 x volume) / sum(volume); sd = sqrt(sum(hlc3^2 x volume) / sum(volume) - vwap^2) (0 if negative).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';

export const AVWAP = { bands: [1, 2, 3] } as const;
const M15 = 15 * 60_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H, WEEK = 7 * DAY;

export type AvwapTf = 'W' | 'D' | '4H';
export interface AnchoredVwap { tf: AvwapTf; from: number; barMs: number; bars: number; vwap: number; sd: number }

const weekOf = (x: number) => Math.floor((x - 4 * DAY) / WEEK) * WEEK + 4 * DAY;

/** The VWAP of the bars opening from `from`, closed by t, or null when the series does not reach back to `from`. */
function vwapFrom(c: ReadonlyArray<Candle>, ms: number, from: number, t: number): Omit<AnchoredVwap, 'tf'> | null {
  if (!c.length || c[0]!.openTime > from) return null;
  const bars = c.filter((b) => b.openTime >= from && b.openTime + ms <= t);
  if (!bars.length) return null;
  const vol = coinVolume(bars);
  let sv = 0, v = 0, ssv = 0;
  bars.forEach((b, k) => { const s = (b.high + b.low + b.close) / 3, x = vol[k] || 0; sv += s * x; v += x; ssv += s * s * x; });
  if (!(v > 0)) return null;
  const vwap = sv / v;
  return { from, barMs: ms, bars: bars.length, vwap, sd: Math.sqrt(Math.max(ssv / v - vwap * vwap, 0)) };
}

/** The weekly, daily and 4H anchored VWAPs at t (any that cannot be built is left out). */
export function anchoredVwaps(m15: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, t: number): AnchoredVwap[] {
  const ref = t - 1, out: AnchoredVwap[] = [];
  const plan: [AvwapTf, number, [ReadonlyArray<Candle>, number][]][] = [
    ['W', weekOf(ref), [[h1, H], [h4, H4]]],
    ['D', Math.floor(ref / DAY) * DAY, [[m15, M15], [h1, H], [h4, H4]]],
    ['4H', Math.floor(ref / H4) * H4, [[m15, M15], [h1, H]]],
  ];
  for (const [tf, from, series] of plan) {
    for (const [c, ms] of series) { const r = vwapFrom(c, ms, from, t); if (r) { out.push({ tf, ...r }); break; } }
  }
  return out;
}
