// Higher-timeframe bias, as of bar t:
// - structure: the last swing broken by a close (up / down),
// - premium / discount: price vs the middle of the current dealing range,
// - PD arrays: price tapping an unmitigated FVG or order block,
// - SMT: BTC vs ETH, one makes a new swing extreme and the other doesn't.
// Long needs up-structure plus at least one of discount, a bullish PD-array
// tap or bullish SMT; short mirrors it; anything else is neutral.

import type { Candle } from '@bot/marketdata';
import { swingsKnownAt, type Context } from './context';

export type Direction = 'long' | 'short' | 'neutral';

export interface BiasConfig {
  /** Bars an unmitigated FVG / order block stays relevant. */
  arrayLookback: number;
  /** Bars before a structure break searched for its order block candle. */
  obLookback: number;
  /** Bars back SMT looks for the two swings compared. */
  smtLookback: number;
  /** Max distance (bars) between matching swings in the two series. */
  smtTolerance: number;
  /** false = structure alone sets the direction (no discount / tap / SMT needed). */
  requireConfluence: boolean;
}

export const DEFAULT_BIAS: BiasConfig = { arrayLookback: 60, obLookback: 10, smtLookback: 40, smtTolerance: 3, requireConfluence: true };

export interface Bias {
  direction: Direction;
  structure: 'up' | 'down' | null;
  zone: 'premium' | 'discount' | null;
  tapped: { bull: boolean; bear: boolean };
  smt: 'bullish' | 'bearish' | null;
  reasons: string[];
}

interface Zone { kind: 'bull' | 'bear'; top: number; bottom: number; from: number; label: string }

function orderBlocks(ctx: Context, t: number, cfg: BiasConfig): Zone[] {
  const c = ctx.candles;
  const out: Zone[] = [];
  for (const b of ctx.breaks) {
    if (b.index > t) break;
    // Bullish OB: the last down candle before the break's leg; bearish mirrors it.
    for (let j = b.index - 1; j >= Math.max(0, b.index - cfg.obLookback); j--) {
      const k = c[j]!;
      if (b.to === 'up' ? k.close < k.open : k.close > k.open) {
        out.push({ kind: b.to === 'up' ? 'bull' : 'bear', top: k.high, bottom: k.low, from: b.index, label: 'order block' });
        break;
      }
    }
  }
  return out;
}

/** Unmitigated arrays tapped by bar t: its range touches the zone, it closes on the right side. */
function taps(ctx: Context, t: number, cfg: BiasConfig): { bull: boolean; bear: boolean; labels: string[] } {
  const c = ctx.candles;
  const zones: Zone[] = [
    ...ctx.gaps.filter((g) => g.index < t && g.index >= t - cfg.arrayLookback).map((g) => ({ ...g, from: g.index, label: 'FVG' })),
    ...orderBlocks(ctx, t, cfg).filter((z) => z.from < t && z.from >= t - cfg.arrayLookback),
  ];
  const bar = c[t]!;
  let bull = false;
  let bear = false;
  const labels: string[] = [];
  for (const z of zones) {
    // Mitigated = a close through the far side between formation and t.
    let broken = false;
    for (let j = z.from + 1; j < t; j++) {
      if (z.kind === 'bull' ? c[j]!.close < z.bottom : c[j]!.close > z.top) { broken = true; break; }
    }
    if (broken) continue;
    if (z.kind === 'bull' && bar.low <= z.top && bar.close >= z.bottom) { bull = true; labels.push(`tapped bullish ${z.label}`); }
    if (z.kind === 'bear' && bar.high >= z.bottom && bar.close <= z.top) { bear = true; labels.push(`tapped bearish ${z.label}`); }
  }
  return { bull, bear, labels: [...new Set(labels)] };
}

/**
 * SMT between two series aligned bar-for-bar (same open times). Bullish when
 * one makes a lower low and the other a higher low over the same swings.
 */
export function smt(a: Context, b: Context, t: number, cfg: BiasConfig = DEFAULT_BIAS): 'bullish' | 'bearish' | null {
  const lastTwo = (ctx: Context, kind: 'high' | 'low') =>
    swingsKnownAt(ctx, t, kind).filter((s) => s.index >= t - cfg.smtLookback).slice(-2);
  for (const kind of ['low', 'high'] as const) {
    const [a1, a2] = lastTwo(a, kind);
    const [b1, b2] = lastTwo(b, kind);
    if (!a1 || !a2 || !b1 || !b2) continue;
    if (Math.abs(a2.index - b2.index) > cfg.smtTolerance || Math.abs(a1.index - b1.index) > cfg.smtTolerance) continue;
    const aNew = kind === 'low' ? a2.price < a1.price : a2.price > a1.price;
    const bNew = kind === 'low' ? b2.price < b1.price : b2.price > b1.price;
    if (aNew !== bNew) return kind === 'low' ? 'bullish' : 'bearish';
  }
  return null;
}

export function biasAt(ctx: Context, t: number, cfg: BiasConfig = DEFAULT_BIAS, smtWith?: Context): Bias {
  const structure = ctx.trend[t] ?? null;
  const reasons: string[] = [];
  if (structure) reasons.push(`structure ${structure}`);

  const hi = swingsKnownAt(ctx, t, 'high').at(-1);
  const lo = swingsKnownAt(ctx, t, 'low').at(-1);
  let zone: Bias['zone'] = null;
  if (hi && lo && hi.price > lo.price) {
    const eq = (hi.price + lo.price) / 2;
    const close = ctx.candles[t]!.close;
    zone = close < eq ? 'discount' : close > eq ? 'premium' : null;
    if (zone) reasons.push(zone);
  }

  const tapped = taps(ctx, t, cfg);
  reasons.push(...tapped.labels);
  const s = smtWith ? smt(ctx, smtWith, t, cfg) : null;
  if (s) reasons.push(`${s} SMT`);

  let direction: Direction = 'neutral';
  const conf = !cfg.requireConfluence;
  if (structure === 'up' && (conf || zone === 'discount' || tapped.bull || s === 'bullish')) direction = 'long';
  if (structure === 'down' && (conf || zone === 'premium' || tapped.bear || s === 'bearish')) direction = 'short';
  return { direction, structure, zone, tapped: { bull: tapped.bull, bear: tapped.bear }, smt: s, reasons };
}

/** Two timeframes: the higher one decides; the lower one may only veto. */
export function combineBias(higher: Direction, lower: Direction): Direction {
  if (higher === 'neutral') return 'neutral';
  if (lower !== 'neutral' && lower !== higher) return 'neutral';
  return higher;
}

/** Index of the last bar of `candles` closed at or before `time` (bar open + interval <= time). */
export function barAt(candles: ReadonlyArray<Candle>, intervalMs: number, time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime + intervalMs <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
