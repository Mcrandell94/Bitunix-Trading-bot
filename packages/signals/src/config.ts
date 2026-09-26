import { RRG_PRESETS } from '@bot/rrg';
import type { Benchmark, SignalType, Timeframe, Tier } from './types';

export const BENCHMARKS: Readonly<Record<Benchmark, string>> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT' };
export const CORE_SYMBOLS: readonly string[] = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'];

export interface ScoreWeights {
  agreement: number;
  velocity: number;
  timeInQuadrant: number;
  relativeVolume: number;
  absoluteTrend: number;
  funding: number;
}

// Every window and count is in BARS of whatever timeframe is being scanned,
// so the same config runs on 1H, 4H and daily. The velocity thresholds are
// RS points per bar in z-score mode; z-scoring divides out each pair's own
// volatility, which keeps them roughly timeframe-independent.
export interface ClassifierConfig {
  /** RS-Ratio rolling window. */
  trendWindow: number;
  /** RS-Momentum rolling window. */
  momentumWindow: number;
  /** EMA span on the raw ratio; 1 = off. */
  smoothing: number;
  /** Tail used for velocity and the WEAKENING_HOOK trough. */
  tailLength: number;
  zscore: boolean;
  /** Net move used for heading (the dashboard uses 3). */
  headingLookbackBars: number;
  /** A quadrant-change signal stays live this many bars after the change. */
  freshBars: number;
  /** "Steep NE" for LAGGING_BREAKOUT: heading between this and 90°. */
  breakoutMinHeadingDeg: number;
  /** "High tail velocity" gate for LAGGING_BREAKOUT. */
  breakoutMinVelocity: number;
  /** Tail velocity that earns the full velocity score. */
  velocityRef: number;
  /** Time-in-quadrant score falls from 1 (first bar) to 0 over this many bars. */
  timeDecayBars: number;
  relVolShortBars: number;
  relVolLongBars: number;
  /** Relative volume scoring: 0 at or below low, 1 at or above high. */
  relVolLow: number;
  relVolHigh: number;
  /** Absolute-trend SMA window. */
  trendSmaBars: number;
  weights: ScoreWeights;
  /**
   * Early reads that don't wait for the laggy quadrant change: EARLY_TURN
   * (Lagging, momentum bottomed and rising, projected into Improving),
   * IMPROVING_ENTRY (fresh into Improving, tail pointing up and right) and
   * EARLY_ROLLOVER (Weakening, ratio falling, projected into Lagging).
   */
  earlySignals: boolean;
  /** How far ahead the projected tail may cross, in bars. */
  projectionBars: number;
  /** Minimum tail velocity for an early read (filters drifting noise). */
  earlyMinVelocity: number;
}

const balanced = RRG_PRESETS.find((p) => p.key === 'balanced')!.settings;

// RRG windows are the dashboard's Balanced preset, which was tuned on daily
// closes. Velocity gates come from simulated regime-switching paths (median
// tail velocity ~0.72, p75 ~0.91, p90 ~1.11). All of it is a starting point
// to re-tune per timeframe in the backtest stage.
export const DEFAULT_CONFIG: Readonly<ClassifierConfig> = Object.freeze({
  trendWindow: balanced.trendWindow,
  momentumWindow: balanced.momentumWindow,
  smoothing: balanced.smoothing,
  tailLength: balanced.tailLength,
  zscore: true,
  headingLookbackBars: 3,
  freshBars: 3,
  breakoutMinHeadingDeg: 45,
  breakoutMinVelocity: 0.9,
  velocityRef: 1.1,
  timeDecayBars: balanced.tailLength,
  relVolShortBars: 7,
  relVolLongBars: 30,
  relVolLow: 0.8,
  relVolHigh: 1.5,
  trendSmaBars: 20,
  weights: Object.freeze({
    agreement: 0.3,
    velocity: 0.2,
    timeInQuadrant: 0.15,
    relativeVolume: 0.15,
    absoluteTrend: 0.1,
    funding: 0.1,
  }),
  earlySignals: false,
  projectionBars: 3,
  earlyMinVelocity: 0.3,
});

const BAR_COUNTS = [
  'trendWindow', 'momentumWindow', 'smoothing', 'tailLength', 'headingLookbackBars', 'freshBars',
  'timeDecayBars', 'relVolShortBars', 'relVolLongBars', 'trendSmaBars', 'projectionBars',
] as const;

export function resolveConfig(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  const cfg: ClassifierConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_CONFIG.weights, ...overrides.weights },
  };
  for (const k of BAR_COUNTS) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new RangeError(`${k} must be a whole number of bars >= 1, got ${cfg[k]}`);
  }
  if (cfg.relVolShortBars > cfg.relVolLongBars) throw new RangeError('relVolShortBars must not exceed relVolLongBars');
  if (!(cfg.relVolHigh > cfg.relVolLow)) throw new RangeError('relVolHigh must be above relVolLow');
  if (!(cfg.velocityRef > 0)) throw new RangeError('velocityRef must be > 0');
  const w = Object.values(cfg.weights);
  if (w.some((x) => !(x >= 0)) || !(w.reduce((a, b) => a + b, 0) > 0)) throw new RangeError('weights must be >= 0 and not all 0');
  return cfg;
}

/** Which tier an RRG timeframe feeds: LTF reads RRG on 1H, MTF on 4H and daily. */
export const RRG_TIER: Readonly<Record<Timeframe, Tier>> = { '1h': 'LTF', '4h': 'MTF', '1d': 'MTF' };

/**
 * Tiers a signal is for, preferred first. Breakouts from Lagging go mainly
 * to MTF even when spotted on 1H; the MTF tier confirms on its own 4H/daily
 * read before acting (a later stage).
 */
export function routeSignal(signal: SignalType, timeframe: Timeframe): Tier[] {
  const own = RRG_TIER[timeframe];
  if (signal === 'LAGGING_BREAKOUT') return own === 'MTF' ? ['MTF'] : ['MTF', 'LTF'];
  return [own];
}
