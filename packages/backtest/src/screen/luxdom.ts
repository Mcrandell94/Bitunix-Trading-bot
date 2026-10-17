// TypeScript port of the "Key Levels" column of "Depth of Market (DOM) [LuxAlgo]" (Pine v5) for the owner's ETH / BTC
// cards (owner 2026-10-17, cards v3). Default inputs: period SESSIONS, mode AUTO, every key level on.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© LuxAlgo). Non-commercial: fine for the owner's
// own cards and group; it must not go into a paid product or group.
//
// Not ported: the DOM itself (bid / ask, sell / buy, imbalance and depth columns) and Time & Sales. They are built from
// live price and volume changes inside the bar (varip, real-time only), which closed candles do not hold.
//
// Bar-for-bar notes:
// - The script works on the bars of the last 24 hours. Its period (SESSIONS) restarts on each new 930-minute bar:
//   00:00 and 15:30 UTC for crypto. The port runs it on 15m bars (it is made for intraday charts, and its opening range
//   is the period's first bar, so it depends on the chart).
// - Mode AUTO picks POINTS when the daily ATR(10) is over 5,000 ticks, as for ETH and BTC; levels are then whole
//   numbers, cut toward zero (int()). The port always uses POINTS.
// - Previous week / day (1W / 1D, lookahead on, read at the last bar): close (PWS / PDS settlement), high, low and their
//   mid. The period: OPEN (its first bar's open), HOD / LOD (high / low so far), MOD (their mid), ORH / ORL (the first
//   bar's high / low), IBH / IBL (high / low of the bars opening in its first hour), VWAP of hlc3 since the period
//   start with 1 / 2 / 3 standard deviation bands (ta.vwap), and POC.
// - POC: each historical bar's volume spread evenly over the whole numbers from its high down to its low (volume /
//   (int(high - low) + 1) each); the number holding the most since the period start (the first one stored on a tie). The
//   script gathers the key levels before adding the bar, so the last bar is not in it; on the period's first bar it
//   reads 0 (no level).
// - The card takes every key level (previous week tagged W, previous day D, the period's levels 4H).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';

export const LUXDOM = { sessionMs: 930 * 60_000, ibMs: 3_600_000, windowMs: 86_400_000, m15: 15 * 60_000 } as const;
const DAY = 86_400_000, WEEK = 7 * DAY;

export type DomTf = 'W' | 'D' | '4H';
export interface DomLevel { note: string; tf: DomTf; v: number }
export interface DomLevels { periodStart: number; bars: number; levels: DomLevel[] }

/** The period (SESSIONS) a bar opening at `x` falls in: 00:00 or 15:30 UTC. */
export const domPeriodStart = (x: number) => { const d = Math.floor(x / DAY) * DAY; return x >= d + LUXDOM.sessionMs ? d + LUXDOM.sessionMs : d; };
const weekOf = (x: number) => Math.floor((x - 4 * DAY) / WEEK) * WEEK + 4 * DAY;

/** The key levels as the script shows them after the last 15m bar closed by t. */
export function domKeyLevels(m15: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, t: number): DomLevels {
  const L = LUXDOM, r = Math.trunc, win = m15.filter((b) => b.openTime + L.m15 <= t && b.openTime >= t - L.windowMs);
  const levels: DomLevel[] = [], add = (note: string, tf: DomTf, v: number) => { if (Number.isFinite(v)) levels.push({ note, tf, v }); };
  const last = win.at(-1);
  if (!last) return { periodStart: NaN, bars: 0, levels };
  // Previous week and day, from the daily bars closed by t.
  const d = d1.filter((b) => b.openTime + DAY <= t), day0 = Math.floor(last.openTime / DAY) * DAY, w0 = weekOf(last.openTime);
  const pd = d.find((b) => b.openTime === day0 - DAY), pw = d.filter((b) => b.openTime >= w0 - WEEK && b.openTime < w0);
  if (pw.length) {
    const h = r(Math.max(...pw.map((b) => b.high))), l = r(Math.min(...pw.map((b) => b.low)));
    add('PWS', 'W', r(pw.at(-1)!.close)); add('PWH', 'W', h); add('PWL', 'W', l); add('PWM', 'W', r(0.5 * (h + l)));
  }
  if (pd) { const h = r(pd.high), l = r(pd.low); add('PDS', 'D', r(pd.close)); add('PDH', 'D', h); add('PDL', 'D', l); add('PDM', 'D', r(0.5 * (h + l))); }
  // The period's bars.
  const start = domPeriodStart(last.openTime), bars = win.filter((b) => domPeriodStart(b.openTime) === start && b.openTime >= start);
  const first = bars[0]!, hod = Math.max(...bars.map((b) => b.high)), lod = Math.min(...bars.map((b) => b.low));
  add('session open', '4H', r(first.open)); add('HOD', '4H', r(hod)); add('MOD', '4H', r(r(0.5 * (hod + lod)))); add('LOD', '4H', r(lod));
  add('ORH', '4H', r(first.high)); add('ORL', '4H', r(first.low));
  const ib = bars.filter((b) => b.openTime < first.openTime + L.ibMs);
  add('IBH', '4H', r(Math.max(...ib.map((b) => b.high)))); add('IBL', '4H', r(Math.min(...ib.map((b) => b.low))));
  const vol = coinVolume(bars);
  let sv = 0, v = 0, ssv = 0;
  bars.forEach((b, k) => { const s = (b.high + b.low + b.close) / 3, x = vol[k] || 0; sv += s * x; v += x; ssv += s * s * x; });
  const vw = sv / v, sd = Math.sqrt(Math.max(ssv / v - vw * vw, 0));
  for (const k of [3, 2, 1]) add(`VWAP +${k}SD`, '4H', r(vw + k * sd));
  add('session VWAP', '4H', r(vw));
  for (const k of [1, 2, 3]) add(`VWAP −${k}SD`, '4H', r(vw - k * sd));
  // POC from the period's bars before the last one.
  const total = new Map<number, number>();
  bars.slice(0, -1).forEach((b, k) => {
    const per = (vol[k] || 0) / (r(b.high - b.low) + 1);
    for (let p = r(b.high); p >= r(b.low); p--) total.set(p, (total.get(p) ?? 0) + per);
  });
  let poc = 0, max = -Infinity;
  for (const [p, x] of total) if (x > max) { max = x; poc = p; }
  if (poc !== 0) add('session POC', '4H', poc);
  return { periodStart: start, bars: bars.length, levels };
}
