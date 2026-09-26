// Precomputed market structure for one candle series. Built once over the
// whole series, then queried "as of" bar t. Nothing here uses a bar after
// the one it is known at, so querying at t on the full series gives the same
// answer as building on candles[0..t] (tested).

import type { Candle } from '@bot/marketdata';

export interface StructureConfig {
  /** Bars on each side that make a swing; a swing is known `right` bars later. */
  swingLeft: number;
  swingRight: number;
  atrPeriod: number;
}

export const DEFAULT_STRUCTURE: StructureConfig = { swingLeft: 2, swingRight: 2, atrPeriod: 14 };

export interface Swing {
  index: number;
  price: number;
  kind: 'high' | 'low';
  /** First bar at which this swing can be known. */
  confirmedAt: number;
}

export interface Gap {
  /** The third candle of the pattern; the gap is known once it closes. */
  index: number;
  kind: 'bull' | 'bear';
  top: number;
  bottom: number;
}

export type Trend = 'up' | 'down' | null;

export interface Context {
  candles: ReadonlyArray<Candle>;
  config: StructureConfig;
  /** ATR at each bar (simple mean of true range), null during warm-up. */
  atr: (number | null)[];
  /** Sorted by confirmedAt, then index. */
  swings: Swing[];
  /** The same swings split by kind (same order), for fast as-of lookups. */
  highs: Swing[];
  lows: Swing[];
  /** Sorted by index. */
  gaps: Gap[];
  /** Structure trend after each bar's close: the last swing broken by a close. */
  trend: Trend[];
  /** Bars where `trend` flipped, with the swing that was broken. */
  breaks: { index: number; to: 'up' | 'down'; level: number }[];
}

function trueRange(c: ReadonlyArray<Candle>, i: number): number {
  const b = c[i]!;
  if (i === 0) return b.high - b.low;
  const pc = c[i - 1]!.close;
  return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
}

export function buildContext(candles: ReadonlyArray<Candle>, config: StructureConfig = DEFAULT_STRUCTURE): Context {
  const n = candles.length;
  const { swingLeft: L, swingRight: R, atrPeriod: P } = config;

  const tr = candles.map((_, i) => trueRange(candles, i));
  const atr: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tr[i]!;
    if (i >= P) sum -= tr[i - P]!;
    atr.push(i >= P - 1 ? sum / P : null);
  }

  const swings: Swing[] = [];
  for (let i = L; i + R < n; i++) {
    const h = candles[i]!.high;
    const l = candles[i]!.low;
    let isHigh = true;
    let isLow = true;
    for (let j = i - L; j <= i + R; j++) {
      if (j === i) continue;
      const c = candles[j]!;
      // Strict on the left, non-strict on the right: of equal highs, the first counts.
      if (j < i ? c.high >= h : c.high > h) isHigh = false;
      if (j < i ? c.low <= l : c.low < l) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: h, kind: 'high', confirmedAt: i + R });
    if (isLow) swings.push({ index: i, price: l, kind: 'low', confirmedAt: i + R });
  }
  swings.sort((a, b) => a.confirmedAt - b.confirmedAt || a.index - b.index);

  const gaps: Gap[] = [];
  for (let i = 2; i < n; i++) {
    const a = candles[i - 2]!;
    const c = candles[i]!;
    if (c.low > a.high) gaps.push({ index: i, kind: 'bull', top: c.low, bottom: a.high });
    if (c.high < a.low) gaps.push({ index: i, kind: 'bear', top: a.low, bottom: c.high });
  }

  const trend: Trend[] = [];
  const breaks: Context['breaks'] = [];
  let cur: Trend = null;
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k < swings.length && swings[k]!.confirmedAt <= i) {
      const s = swings[k++]!;
      if (s.kind === 'high') lastHigh = s;
      else lastLow = s;
    }
    const close = candles[i]!.close;
    if (lastHigh && close > lastHigh.price && cur !== 'up') {
      cur = 'up';
      breaks.push({ index: i, to: 'up', level: lastHigh.price });
    } else if (lastLow && close < lastLow.price && cur !== 'down') {
      cur = 'down';
      breaks.push({ index: i, to: 'down', level: lastLow.price });
    }
    trend.push(cur);
  }

  return {
    candles, config, atr, swings, gaps, trend, breaks,
    highs: swings.filter((s) => s.kind === 'high'),
    lows: swings.filter((s) => s.kind === 'low'),
  };
}

/** How many of `list` (sorted by confirmedAt) are known at bar t. Binary search. */
export function knownCount(list: ReadonlyArray<Swing>, t: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.confirmedAt <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Swings known at bar t (confirmedAt <= t). */
export function swingsKnownAt(ctx: Context, t: number, kind?: Swing['kind']): Swing[] {
  const list = kind === 'high' ? ctx.highs : kind === 'low' ? ctx.lows : ctx.swings;
  return list.slice(0, knownCount(list, t));
}

/**
 * The same series upside down (price → -price, high ↔ low). Running long
 * logic on it finds shorts, so both sides follow identical rules.
 */
export function mirror(candles: ReadonlyArray<Candle>): Candle[] {
  return candles.map((c) => ({ ...c, open: -c.open, close: -c.close, high: -c.low, low: -c.high }));
}
