// Signal scoring. Each component is 0..1; the score is their weighted mean
// scaled to 0..100. Volume, trend and funding only ever land here.

import type { Quadrant } from '@bot/rrg';
import type { ClassifierConfig, ScoreWeights } from './config';
import type {
  Classification, Direction, Filters, RrgReading, ScoreComponents, SignalType,
} from './types';

/** Agreement credit from the benchmark(s) a signal did NOT fire on. */
export const AGREEMENT = {
  /** Fired on both BTC and ETH. */
  both: 1,
  /** The other benchmark fired a different signal in the same direction. */
  sameDirection: 0.75,
  /** The other benchmark sits in a quadrant that supports the direction. */
  supportiveQuadrant: 0.5,
  /** No second read: the symbol is itself a benchmark, or too little history. */
  unavailable: 0.4,
  /** The other benchmark says the opposite. */
  opposed: 0,
} as const;

const SUPPORTIVE: Record<Direction, ReadonlySet<Quadrant>> = {
  long: new Set(['leading', 'improving']),
  short: new Set(['lagging', 'weakening']),
};

export interface OtherBenchmark {
  reading: RrgReading | null;
  classification: Classification | null;
}

export function agreementScore(signal: SignalType, direction: Direction, others: ReadonlyArray<OtherBenchmark>): number {
  if (others.length === 0) return AGREEMENT.both;
  // Several "other" benchmarks: the weakest one decides.
  return Math.min(...others.map(({ reading, classification }) => {
    if (!reading) return AGREEMENT.unavailable;
    if (classification?.signal === signal) return AGREEMENT.both;
    if (classification?.direction === direction) return AGREEMENT.sameDirection;
    // An opposite signal outranks the quadrant: a WEAKENING_HOOK (long)
    // sits in Weakening, which would otherwise pass as support for a short.
    if (classification) return AGREEMENT.opposed;
    if (SUPPORTIVE[direction].has(reading.quadrant)) return AGREEMENT.supportiveQuadrant;
    return AGREEMENT.opposed;
  }));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function velocityScore(fired: ReadonlyArray<RrgReading>, cfg: ClassifierConfig): number {
  const v = fired.reduce((a, r) => a + r.tailVelocity, 0) / fired.length;
  return clamp01(v / cfg.velocityRef);
}

/** Earlier in the quadrant scores higher: 1 on the first bar, 0 after `timeDecayBars`. */
export function timeInQuadrantScore(fired: ReadonlyArray<RrgReading>, cfg: ClassifierConfig): number {
  const bars = Math.max(...fired.map((r) => r.barsInQuadrant));
  return clamp01(1 - (bars - 1) / cfg.timeDecayBars);
}

/** Unknown filters score a neutral 0.5 rather than counting for or against. */
export function relativeVolumeScore(rv: number | null, cfg: ClassifierConfig): number {
  if (rv == null) return 0.5;
  return clamp01((rv - cfg.relVolLow) / (cfg.relVolHigh - cfg.relVolLow));
}

export function absoluteTrendScore(trend: Filters['absoluteTrend'], direction: Direction): number {
  if (!trend) return 0.5;
  return trend.above === (direction === 'long') ? 1 : 0;
}

/** Crowded funding on the side you'd join scores 0; the other side paying scores 1. */
export function fundingScore(flag: Filters['funding'], direction: Direction): number {
  if (!flag) return 0.5;
  if (flag === 'neutral') return 0.7;
  const favours = direction === 'long' ? 'shorts-paying' : 'crowded-long';
  return flag === favours ? 1 : 0;
}

export function weightedScore(c: ScoreComponents, w: ScoreWeights): number {
  const keys = Object.keys(w) as (keyof ScoreWeights)[];
  const total = keys.reduce((a, k) => a + w[k], 0);
  return (100 * keys.reduce((a, k) => a + w[k] * c[k], 0)) / total;
}
