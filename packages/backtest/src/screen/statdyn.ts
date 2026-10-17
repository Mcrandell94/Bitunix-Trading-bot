// TypeScript port of "Static + Dynamic Levels" (Pine v4; the copy given has no author or licence header, TradingView's
// default for open scripts is MPL 2.0) for the owner's ETH / BTC cards (owner 2026-10-17, cards v3). Calculations only
// (no plots), default inputs: every group on.
//
// Bar-for-bar notes:
// - Opens (security(..., open, lookahead_on)): this day's, Monday week's, month's and year's open (DO / WO / MO / YO, UTC
//   periods, as TradingView's D / W / M / 12M bars for crypto) and the period's before (PDO / PWO / PMO / PYO).
// - PDH / PDL: the previous day's high and low (security(..., high[1] / low[1], lookahead_on)).
// - 100 / 200 DMA and 100 / 200 WMA: the SMA of the daily / weekly closes (security(..., sma(close, n)) without
//   lookahead). Live, TradingView draws them with the developing day / week (its close so far): that is what the port
//   gives at the close, the last n - 1 closed periods and the last price. The chart's older bars show the value of the
//   last closed period instead, so a past value can differ from the one shown live then. The 200 WMA needs 199 closed
//   weeks (about 4 years); with less history it reads na and is not drawn, as on the chart.
// - The period is the one the moment `t` falls in (what the chart shows live). A period that starts at t has no closed
//   bar yet: its open is the last close (the next bar opens there, give or take a tick).
// - Opens, highs and lows come from the daily bars, else from the 4H bars of that period (the worker keeps fewer 4H
//   days); a period with no bar opening at its start reads na rather than a later bar's open.
// - The card takes every one of these as a level.
// Pure.

import type { Candle } from '@bot/marketdata';

export const STATDYN = { dma: [100, 200], wma: [100, 200] } as const;
const H4 = 4 * 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY;

export type SdNote = 'DO' | 'PDO' | 'WO' | 'PWO' | 'MO' | 'PMO' | 'YO' | 'PYO' | 'PDH' | 'PDL' | '100DMA' | '200DMA' | '100WMA' | '200WMA';
export interface SdLevels { at: number; levels: { note: SdNote; tf: 'D' | 'W'; v: number }[] }

const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
/** Monday 00:00 UTC of t's week (1970-01-05 was a Monday). */
export const weekOf = (t: number) => Math.floor((t - 4 * DAY) / WEEK) * WEEK + 4 * DAY;
const monthOf = (t: number, back = 0) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1); };
const yearOf = (t: number, back = 0) => Date.UTC(new Date(t).getUTCFullYear() - back, 0, 1);

/** The script's levels at moment t, from closed daily and 4H bars (only bars closed by t are used). */
export function staticDynamicLevels(h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, t: number): SdLevels {
  const d = d1.filter((b) => b.openTime + DAY <= t), f = h4.filter((b) => b.openTime + H4 <= t);
  const lastEnd = Math.max(d.length ? d.at(-1)!.openTime + DAY : -Infinity, f.length ? f.at(-1)!.openTime + H4 : -Infinity);
  const price = (f.length && f.at(-1)!.openTime + H4 >= lastEnd ? f.at(-1)!.close : d.at(-1)?.close) ?? NaN;
  const byD = new Map(d.map((b) => [b.openTime, b])), byF = new Map(f.map((b) => [b.openTime, b]));
  const open = (s: number) => byD.get(s)?.open ?? byF.get(s)?.open ?? (s >= lastEnd ? price : NaN);
  const day0 = dayOf(t), pd = byD.get(day0 - DAY), pdBars = pd ? [pd] : f.filter((b) => b.openTime >= day0 - DAY && b.openTime < day0);
  const pdh = pdBars.length ? Math.max(...pdBars.map((b) => b.high)) : NaN, pdl = pdBars.length ? Math.min(...pdBars.map((b) => b.low)) : NaN;
  // Daily and weekly closes before the current period (a week's close is its last daily bar's).
  const dCl = d.filter((b) => b.openTime < day0).map((b) => b.close), w0 = weekOf(t), wCl: number[] = [];
  for (let k = 0; k < d.length; k++) { const b = d[k]!; if (b.openTime < w0 && (k === d.length - 1 || weekOf(d[k + 1]!.openTime) !== weekOf(b.openTime))) wCl.push(b.close); }
  const sma = (xs: number[], n: number) => (xs.length < n - 1 || !Number.isFinite(price) ? NaN : (xs.slice(xs.length - (n - 1)).reduce((s, x) => s + x, 0) + price) / n);
  const [d100, d200] = STATDYN.dma, [w100, w200] = STATDYN.wma;
  const all: SdLevels['levels'] = [
    { note: 'DO', tf: 'D', v: open(day0) }, { note: 'PDO', tf: 'D', v: open(day0 - DAY) },
    { note: 'WO', tf: 'W', v: open(w0) }, { note: 'PWO', tf: 'W', v: open(w0 - WEEK) },
    { note: 'MO', tf: 'W', v: open(monthOf(t)) }, { note: 'PMO', tf: 'W', v: open(monthOf(t, 1)) },
    { note: 'YO', tf: 'W', v: open(yearOf(t)) }, { note: 'PYO', tf: 'W', v: open(yearOf(t, 1)) },
    { note: 'PDH', tf: 'D', v: pdh }, { note: 'PDL', tf: 'D', v: pdl },
    { note: '100DMA', tf: 'D', v: sma(dCl, d100) }, { note: '200DMA', tf: 'D', v: sma(dCl, d200) },
    { note: '100WMA', tf: 'W', v: sma(wCl, w100) }, { note: '200WMA', tf: 'W', v: sma(wCl, w200) },
  ];
  return { at: t, levels: all.filter((x) => Number.isFinite(x.v) && x.v !== 0) };
}
