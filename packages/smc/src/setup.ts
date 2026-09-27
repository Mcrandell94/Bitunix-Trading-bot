// Entry model: liquidity sweep → market-structure shift (MSS) with
// displacement → limit entry in the leg's fair value gap (FVG), or an
// inverted FVG (iFVG) when the leg left none. Stop beyond the sweep.
//
// A setup is reported one bar after its MSS (the first close through the
// structure level): a gap needs three candles, so the FVG left by the MSS
// candle itself only exists once the next one closes. Each setup is seen
// exactly once while stepping bars.

import type { Candle } from '@bot/marketdata';
import { buildContext, knownCount, mirror, type Context, type Gap, type StructureConfig, type Swing } from './context';

export interface SetupConfig {
  /** How far back (bars) from the MSS bar the sweep may be. */
  maxLegBars: number;
  /** How far before the sweep the swept swing may sit. */
  liquidityLookback: number;
  /** Displacement candle: body >= this × ATR... */
  displacementAtr: number;
  /** ...and body / range >= this. */
  displacementBodyRatio: number;
  /** Where in the gap to enter: 0 = far edge, 0.5 = middle (CE), 1 = near edge. */
  entryFraction: number;
  /** Stop this many ATRs beyond the sweep extreme. */
  stopBufferAtr: number;
  /** How far before the sweep a gap may sit to count as an iFVG. */
  ifvgLookback: number;
  /** false = only real FVGs; setups that would need an iFVG are skipped. */
  allowIfvg: boolean;
  /** Displacement candle volume must be >= this x the mean of the previous 20 bars (0 = off; bars without volume pass). */
  displacementVolumeMult: number;
}

export const DEFAULT_SETUP: SetupConfig = {
  maxLegBars: 20,
  liquidityLookback: 50,
  // Tuned 2026-09-26 (1.2 → 1.0): +1.6R on the Sep–May train window, and
  // slightly better on the held-out Jun–Sep test window.
  displacementAtr: 1,
  displacementBodyRatio: 0.6,
  entryFraction: 0.5,
  stopBufferAtr: 0.1,
  ifvgLookback: 20,
  allowIfvg: true,
  displacementVolumeMult: 0,
};

export type Side = 'long' | 'short';

export interface Setup {
  side: Side;
  /** Bar the setup is known at: the bar after the MSS. */
  index: number;
  mssIndex: number;
  entry: number;
  stop: number;
  sweepIndex: number;
  sweptLevel: number;
  mssLevel: number;
  displacementIndex: number;
  zone: { kind: 'fvg' | 'ifvg'; top: number; bottom: number };
}

/** Structure for both sides of one series; build once, query per bar. */
export interface SeriesAnalysis {
  long: Context;
  /** Built on the mirrored series. */
  short: Context;
}

export function analyze(candles: ReadonlyArray<Candle>, structure?: StructureConfig): SeriesAnalysis {
  return { long: buildContext(candles, structure), short: buildContext(mirror(candles), structure) };
}

function isDisplacement(ctx: Context, d: number, cfg: SetupConfig): boolean {
  const c = ctx.candles[d]!;
  const atr = ctx.atr[d - 1];
  const body = c.close - c.open;
  const range = c.high - c.low;
  if (!(atr != null && body > 0 && body >= cfg.displacementAtr * atr && range > 0 && body / range >= cfg.displacementBodyRatio)) return false;
  if (cfg.displacementVolumeMult > 0 && c.volume != null) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, d - 20); j < d; j++) {
      const v = ctx.candles[j]!.volume;
      if (v != null) { sum += v; n++; }
    }
    if (n >= 5 && c.volume < cfg.displacementVolumeMult * (sum / n)) return false;
  }
  return true;
}

/** The sweep → MSS → displacement part of a setup, without the entry zone. */
export interface Shift { side: Side; sweepIndex: number; mssIndex: number; displacementIndex: number }

/**
 * Long setup known at bar t (MSS on t - 1), in a context built for longs.
 * `shiftOnly` (owner, 2026-09-27, confluence model C4): stop after the
 * displacement check, so no FVG, entry or stop is needed. Off for setups.
 */
function findLong(ctx: Context, t: number, cfg: SetupConfig, shiftOnly = false): Omit<Setup, 'side'> | null {
  const c = ctx.candles;
  const m = t - 1;
  const atrT = ctx.atr[t];
  if (m < 1 || atrT == null) return null;
  // Necessary for an MSS on m: close[m-1] is at or below the broken level and close[m] above it.
  if (c[m]!.close <= c[m - 1]!.close) return null;
  const { lows, highs } = ctx;
  const nLows = knownCount(lows, m);
  const nHighs = knownCount(highs, m);

  for (let s = m - 1; s >= Math.max(1, m - cfg.maxLegBars); s--) {
    const sweepBar = c[s]!;
    // The sweep bar is the extreme of the leg up to t.
    let extreme = true;
    for (let j = s + 1; j <= t; j++) if (c[j]!.low < sweepBar.low) { extreme = false; break; }
    if (!extreme) continue;

    // It took out a swing low known before it, and closed back above it.
    // Lows are in confirmation (= index) order, so walk back until out of range.
    let sweptLevel = Infinity;
    for (let i = nLows - 1; i >= 0; i--) {
      const p = lows[i]!;
      if (p.index < s - cfg.liquidityLookback) break;
      if (p.confirmedAt < s && sweepBar.low < p.price && sweepBar.close > p.price) sweptLevel = Math.min(sweptLevel, p.price);
    }
    if (sweptLevel === Infinity) continue;

    // MSS: m is the first close above the last swing high before the sweep.
    let level: Swing | undefined;
    for (let i = nHighs - 1; i >= 0; i--) if (highs[i]!.index < s) { level = highs[i]; break; }
    if (!level || c[m]!.close <= level.price) return null;
    for (let j = s; j < m; j++) if (c[j]!.close > level.price) return null;

    let d = -1;
    for (let j = m; j > s; j--) if (isDisplacement(ctx, j, cfg)) { d = j; break; }
    if (d < 0) return null;
    if (shiftOnly) {
      return { index: t, mssIndex: m, entry: NaN, stop: NaN, sweepIndex: s, sweptLevel, mssLevel: level.price, displacementIndex: d, zone: { kind: 'fvg', top: NaN, bottom: NaN } };
    }

    const zone = pickZone(ctx, s, t, d, cfg);
    if (!zone) return null;
    const entry = zone.bottom + cfg.entryFraction * (zone.top - zone.bottom);
    const stop = sweepBar.low - cfg.stopBufferAtr * atrT;
    if (!(entry < c[t]!.close && entry > stop)) return null;
    return { index: t, mssIndex: m, entry, stop, sweepIndex: s, sweptLevel, mssLevel: level.price, displacementIndex: d, zone };
  }
  return null;
}

function pickZone(ctx: Context, s: number, t: number, d: number, cfg: SetupConfig): Setup['zone'] | null {
  // FVGs formed inside the leg: middle candle after the sweep, third candle
  // no later than t (the bar after the MSS).
  const leg = ctx.gaps.filter((g) => g.kind === 'bull' && g.index >= s + 2 && g.index <= t);
  const chosen = leg.find((g) => g.index - 1 === d) ?? leg[leg.length - 1];
  if (chosen) return { kind: 'fvg', top: chosen.top, bottom: chosen.bottom };
  if (cfg.allowIfvg === false) return null;

  // iFVG: a bearish gap from the move down that the leg closed back above.
  const c = ctx.candles;
  const inverted = ctx.gaps.filter((g: Gap) => {
    if (g.kind !== 'bear' || g.index < s - cfg.ifvgLookback || g.index > t) return false;
    for (let j = Math.max(g.index + 1, s + 1); j <= t; j++) if (c[j]!.close > g.top) return true;
    return false;
  });
  const inv = inverted[inverted.length - 1];
  return inv ? { kind: 'ifvg', top: inv.top, bottom: inv.bottom } : null;
}

const unmirror = (x: number) => -x;

/** The setup whose MSS closes on bar t, if any (long checked first). */
export function detectSetup(a: SeriesAnalysis, t: number, cfg: SetupConfig = DEFAULT_SETUP): Setup | null {
  const long = findLong(a.long, t, cfg);
  if (long) return { side: 'long', ...long };
  const m = findLong(a.short, t, cfg);
  if (!m) return null;
  return {
    side: 'short',
    ...m,
    entry: unmirror(m.entry),
    stop: unmirror(m.stop),
    sweptLevel: unmirror(m.sweptLevel),
    mssLevel: unmirror(m.mssLevel),
    zone: { kind: m.zone.kind, top: unmirror(m.zone.bottom), bottom: unmirror(m.zone.top) },
  };
}

/**
 * A sweep of a swing followed by a market structure shift with a
 * displacement candle, the MSS closing on bar t - 1 (known at bar t). Same
 * rules as detectSetup without the entry zone. Long checked first.
 */
export function detectShift(a: SeriesAnalysis, t: number, cfg: SetupConfig = DEFAULT_SETUP): Shift | null {
  const long = findLong(a.long, t, cfg, true);
  if (long) return { side: 'long', sweepIndex: long.sweepIndex, mssIndex: long.mssIndex, displacementIndex: long.displacementIndex };
  const short = findLong(a.short, t, cfg, true);
  return short ? { side: 'short', sweepIndex: short.sweepIndex, mssIndex: short.mssIndex, displacementIndex: short.displacementIndex } : null;
}

/**
 * A setup in the making, for display: liquidity was swept on bar s and the
 * leg is still the extreme, but no close has broken structure (MSS) yet.
 */
export interface SweepWatch {
  side: Side;
  sweepIndex: number;
  sweptLevel: number;
  /** A close beyond this level would be the MSS. */
  mssLevel: number;
  /** Bars left for the MSS before the sweep is too old to count. */
  barsLeft: number;
}

function watchLong(ctx: Context, t: number, cfg: SetupConfig): Omit<SweepWatch, 'side'> | null {
  const c = ctx.candles;
  const nLows = knownCount(ctx.lows, t);
  const nHighs = knownCount(ctx.highs, t);
  for (let s = t; s >= Math.max(1, t - cfg.maxLegBars + 1); s--) {
    const sweepBar = c[s]!;
    let extreme = true;
    for (let j = s + 1; j <= t; j++) if (c[j]!.low < sweepBar.low) { extreme = false; break; }
    if (!extreme) continue;
    let sweptLevel = Infinity;
    for (let i = nLows - 1; i >= 0; i--) {
      const p = ctx.lows[i]!;
      if (p.index < s - cfg.liquidityLookback) break;
      if (p.confirmedAt < s && sweepBar.low < p.price && sweepBar.close > p.price) sweptLevel = Math.min(sweptLevel, p.price);
    }
    if (sweptLevel === Infinity) continue;
    let level: Swing | undefined;
    for (let i = nHighs - 1; i >= 0; i--) if (ctx.highs[i]!.index < s) { level = ctx.highs[i]; break; }
    if (!level) return null;
    // Already broken: that's a setup (or a spent one), not a watch.
    for (let j = s; j <= t; j++) if (c[j]!.close > level.price) return null;
    return { sweepIndex: s, sweptLevel, mssLevel: level.price, barsLeft: s + cfg.maxLegBars - t };
  }
  return null;
}

/** Sweeps waiting for an MSS as of bar t, long and/or short. Display only: never used to trade. */
export function watchSweeps(a: SeriesAnalysis, t: number, cfg: SetupConfig = DEFAULT_SETUP): SweepWatch[] {
  const out: SweepWatch[] = [];
  const long = watchLong(a.long, t, cfg);
  if (long) out.push({ side: 'long', ...long });
  const short = watchLong(a.short, t, cfg);
  if (short) out.push({ side: 'short', ...short, sweptLevel: unmirror(short.sweptLevel), mssLevel: unmirror(short.mssLevel) });
  return out;
}

/**
 * Room to the liquidity the move is heading for, in R: from the entry to the
 * nearest known swing high above the current close (swing low below, for a
 * short), within `lookback` bars. Infinity when there's none in range.
 */
export function roomToLiquidity(a: SeriesAnalysis, t: number, setup: Pick<Setup, 'side' | 'entry' | 'stop'>, lookback = 100): number {
  const long = setup.side === 'long';
  const ctx = long ? a.long : a.short;
  const entry = long ? setup.entry : -setup.entry;
  const stop = long ? setup.stop : -setup.stop;
  const close = ctx.candles[t]!.close;
  let target = Infinity;
  for (const h of ctx.highs) {
    if (h.confirmedAt > t) break;
    if (h.index >= t - lookback && h.price > close) target = Math.min(target, h.price);
  }
  return target === Infinity ? Infinity : (target - entry) / (entry - stop);
}
