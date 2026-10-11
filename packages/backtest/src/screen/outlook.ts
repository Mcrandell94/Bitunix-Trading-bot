// The ETH card's Outlook section (owner 2026-10-11: "which other indicator metric could help the outlook when seeing the
// card?"; picked BTC context, weekly bias, volatility squeeze, volume + funding trend; "show and test"). Display only.
// Each value uses closed bars / settled funding known at its time. Fixed before the preview run:
// - The other coin (BTC on the ETH card, ETH on the BTC card, round 4): its 1D trend ribbon side and 1D KAMA side (fast
//   over / under slow); ETH/BTC = the ETH daily close over BTC's of the same day, its 7-day change and its side of its
//   20-day EMA ("ETH leading" over it, "lagging" under).
// - Weekly: the last closed week (Monday weeks from the daily bars): RSI 14 and the close vs the 50-week EMA.
// - Volatility: Bollinger bandwidth (20, 2) = (upper - lower) / mid, as a percentile of the last 180 days of its own
//   values (squeeze <= 20th, expanding >= 80th); ATR 14 as % of the close.
// - Volume: the bar's coin volume over the mean of the 20 bars before.
// - Funding: settled rates; the 7-day mean, its direction (the last 3 days' mean vs the 4 days before) and the 90-day
//   median.
// Pure.

import type { Candle } from '@bot/marketdata';
import { bollinger, ema, rsi } from '../indicators';
import { kamaDaily, type KamaLine } from './kama';
import { coinVolume, taEma } from './pine';
import { lastClosed } from './scalp2';
import { trendRibbon } from './trendribbon';
import { aggregate } from './wyckoffhtf';

const DAY = 86_400_000;
export const OUTLOOK = { ratioEma: 20, ratioChangeDays: 7, weeklyRsi: 14, weeklyEma: 50, bbLen: 20, bbMult: 2, pctDays: 180, squeezePct: 20, expandPct: 80, relVolBars: 20, relVolHigh: 1.5, fundDays: 7, fundRecentDays: 3, fundMedianDays: 90 } as const;

/** Bollinger bandwidth (% of the mid) and relative volume per bar of one timeframe. */
export function volSeries(c: ReadonlyArray<Candle>): { width: number[]; relVol: number[] } {
  const O = OUTLOOK, bb = bollinger(c.map((b) => b.close), O.bbLen, O.bbMult), vol = coinVolume(c);
  const width = bb.mid.map((m, i) => (m == null || bb.upper[i] == null || !(m > 0) ? NaN : ((bb.upper[i]! - bb.lower[i]!) / m) * 100));
  const relVol = c.map((_, i) => {
    if (i < O.relVolBars) return NaN;
    let s = 0;
    for (let k = i - O.relVolBars; k < i; k++) s += vol[k]!;
    return s > 0 ? (vol[i]! / (s / O.relVolBars)) : NaN;
  });
  return { width, relVol };
}

/** The share (%) of the last n values (bar i included) at or under the value at i. */
export function pctRank(x: ReadonlyArray<number>, i: number, n: number): number | null {
  const v = x[i]!;
  if (Number.isNaN(v)) return null;
  let le = 0, cnt = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) { const y = x[k]!; if (Number.isNaN(y)) continue; cnt++; if (y <= v) le++; }
  return cnt >= n / 2 ? (100 * le) / cnt : null;
}

export interface OutlookSeries {
  /** The card's coin (selfD1) and the other one; selfIsEth: the ratio is self / other, else other / self. */
  selfD1: ReadonlyArray<Candle>; otherD1: ReadonlyArray<Candle>; selfIsEth: boolean; otherTrend: Int8Array; otherKama: KamaLine;
  ratio: number[]; ratioEma: number[]; weeks: { c: Candle[]; ends: number[] }; wRsi: (number | null)[]; wEma: (number | null)[];
  funding: { time: number; rate: number }[];
}
export function outlookSeries(selfD1: ReadonlyArray<Candle>, otherD1: ReadonlyArray<Candle>, funding: ReadonlyArray<{ time: number; rate: number }>, selfIsEth = true): OutlookSeries {
  const O = OUTLOOK, otherBy = new Map(otherD1.map((b) => [b.openTime, b.close]));
  const ratio = selfD1.map((b) => { const x = otherBy.get(b.openTime); return x && x > 0 && b.close > 0 ? (selfIsEth ? b.close / x : x / b.close) : NaN; });
  const weeks = aggregate(selfD1, 'W'), wc = weeks.c.map((b) => b.close);
  return {
    selfD1, otherD1, selfIsEth, otherTrend: trendRibbon(otherD1).trend, otherKama: kamaDaily(otherD1), ratio, ratioEma: taEma(ratio, O.ratioEma), weeks,
    wRsi: rsi(wc, O.weeklyRsi), wEma: ema(wc, O.weeklyEma).map((v, k) => (k >= O.weeklyEma - 1 ? v : null)), funding: [...funding].sort((a, b) => a.time - b.time),
  };
}

export interface OutlookAt {
  other: { trend: number; kamaOver: boolean | null; ratio: number; ratioChg7: number | null; ratioOverEma: boolean | null } | null;
  weekly: { weekOf: number; rsi: number | null; ema: number | null } | null;
  funding: { avg7: number; recent: number; prior: number; median90: number } | null;
}
const mean = (xs: number[]) => xs.reduce((p, x) => p + x, 0) / xs.length;

/** The outlook values known at time t (a bar close). */
export function outlookAt(o: OutlookSeries, t: number): OutlookAt {
  const O = OUTLOOK, kb = lastClosed(o.otherD1, DAY, t), kd = lastClosed(o.selfD1, DAY, t);
  let other: OutlookAt['other'] = null;
  if (kb >= 0 && kd >= 0 && !Number.isNaN(o.ratio[kd]!)) {
    const f = o.otherKama.fast[kb]!, s = o.otherKama.slow[kb]!, r = o.ratio[kd]!, r7 = o.ratio[kd - O.ratioChangeDays], e = o.ratioEma[kd]!;
    other = { trend: o.otherTrend[kb]!, kamaOver: Number.isNaN(f) || Number.isNaN(s) ? null : f > s, ratio: r, ratioChg7: r7 != null && !Number.isNaN(r7) ? (r / r7 - 1) * 100 : null, ratioOverEma: Number.isNaN(e) ? null : r > e };
  }
  let wk = -1;
  for (let k = 0; k < o.weeks.ends.length && o.weeks.ends[k]! <= t; k++) wk = k;
  const weekly = wk >= 0 ? { weekOf: o.weeks.c[wk]!.openTime, rsi: o.wRsi[wk] ?? null, ema: o.wEma[wk] ?? null } : null;
  const f = o.funding.filter((p) => p.time <= t && p.time > t - O.fundMedianDays * DAY), last7 = f.filter((p) => p.time > t - O.fundDays * DAY);
  const recent = last7.filter((p) => p.time > t - O.fundRecentDays * DAY), prior = last7.filter((p) => p.time <= t - O.fundRecentDays * DAY);
  let funding: OutlookAt['funding'] = null;
  if (recent.length && prior.length && f.length >= 10) {
    const sorted = f.map((p) => p.rate).sort((a, b) => a - b), m = sorted.length >> 1;
    funding = { avg7: mean(last7.map((p) => p.rate)), recent: mean(recent.map((p) => p.rate)), prior: mean(prior.map((p) => p.rate)), median90: sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2 };
  }
  return { other, weekly, funding };
}

export type OutlookMetric = 'other ribbon' | 'ETH/BTC' | 'weekly RSI' | 'weekly EMA' | 'squeeze' | 'relative volume' | 'funding';
export const OUTLOOK_METRICS: OutlookMetric[] = ['other ribbon', 'ETH/BTC', 'weekly RSI', 'weekly EMA', 'squeeze', 'relative volume', 'funding'];
/**
 * Whether each metric agrees with a signal of side `dir` (fixed before the preview run; null = not available):
 * the other coin's 1D ribbon on its side; ETH/BTC over its EMA for an ETH buy (under for a sell; mirrored on the BTC
 * card, where BTC leading = ETH/BTC under its EMA); weekly RSI over 50 (under); the price
 * over the 50-week EMA (under); a squeeze (bandwidth <= 20th percentile, either side); relative volume >= 1.5x; the
 * 7-day funding mean under its 90-day median for a buy (over for a sell).
 */
export function outlookAgree(a: OutlookAt, dir: 1 | -1, price: number, squeezePct: number | null, relVol: number, selfIsEth = true): Record<OutlookMetric, boolean | null> {
  const O = OUTLOOK, w = a.weekly, f = a.funding;
  return {
    'other ribbon': a.other ? a.other.trend === dir : null,
    'ETH/BTC': a.other?.ratioOverEma == null ? null : a.other.ratioOverEma === (selfIsEth ? dir > 0 : dir < 0),
    'weekly RSI': w?.rsi == null ? null : dir > 0 ? w.rsi > 50 : w.rsi < 50,
    'weekly EMA': w?.ema == null ? null : dir > 0 ? price > w.ema : price < w.ema,
    squeeze: squeezePct == null ? null : squeezePct <= O.squeezePct,
    'relative volume': Number.isNaN(relVol) ? null : relVol >= O.relVolHigh,
    funding: f ? (dir > 0 ? f.avg7 < f.median90 : f.avg7 > f.median90) : null,
  };
}
