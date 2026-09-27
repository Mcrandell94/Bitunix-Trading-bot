import type { AbsoluteTrend, FundingFlag, Heading, Quadrant, RrgPoint } from '@bot/rrg';

/** Timeframes the RRG runs on: 1H feeds the LTF tier, 4H and daily feed MTF, daily also feeds HTF. */
export type Timeframe = '1h' | '4h' | '1d';
export type Tier = 'LTF' | 'MTF' | 'HTF';
export type Benchmark = 'BTC' | 'ETH';
export type Direction = 'long' | 'short';

export type SignalType =
  | 'LEADING_ENTRY'
  | 'LAGGING_BREAKOUT'
  | 'WEAKENING_HOOK'
  | 'SHORT_ROLLOVER'
  // Early reads (config.earlySignals): strength forming before the quadrant change confirms it.
  | 'EARLY_TURN'
  | 'IMPROVING_ENTRY'
  | 'EARLY_ROLLOVER';

export interface QuadrantRun {
  quadrant: Quadrant;
  /** 0 for a quadrant only passed through between two bars (a diagonal jump). */
  bars: number;
}

/** One symbol's RRG position against one benchmark, at the last bar. */
export interface RrgReading {
  benchmark: Benchmark;
  point: RrgPoint;
  quadrant: Quadrant;
  barsInQuadrant: number;
  /**
   * Quadrant before the current one; null if it never changed in the valid
   * history. After a diagonal one-bar jump it's the quadrant passed through.
   */
  cameFrom: Quadrant | null;
  /** Net direction over `headingLookbackBars`. null when the point didn't move. */
  heading: Heading | null;
  /** Mean RS distance travelled per bar over the tail. */
  tailVelocity: number;
  /** The last few quadrant runs, oldest first; the last one is the current quadrant. */
  path: QuadrantRun[];
  /** The last `tailLength + 1` points (tailLength steps). */
  tail: RrgPoint[];
}

export interface Classification {
  signal: SignalType;
  direction: Direction;
  reasons: string[];
}

export interface SymbolSeries {
  /** Closes, aligned bar-for-bar with the benchmark closes. */
  close: ReadonlyArray<number>;
  /** Volumes on the same bars. Optional; missing bars may be null. */
  volume?: ReadonlyArray<number | null> | null;
  /** Latest funding rate, annualized %/yr. Optional. */
  fundingAnnualizedPct?: number | null;
}

export interface ScoreComponents {
  agreement: number;
  velocity: number;
  timeInQuadrant: number;
  relativeVolume: number;
  absoluteTrend: number;
  funding: number;
}

export interface Filters {
  relativeVolume: number | null;
  absoluteTrend: AbsoluteTrend | null;
  funding: FundingFlag | null;
  fundingAnnualizedPct: number | null;
}

export interface WatchlistEntry {
  symbol: string;
  timeframe: Timeframe;
  signal: SignalType;
  direction: Direction;
  /** Tiers this signal is for, preferred first. */
  tiers: Tier[];
  core: boolean;
  /** 0-100. */
  score: number;
  components: ScoreComponents;
  /** Benchmarks the signal fired against. */
  firedOn: Benchmark[];
  /** Readings against every benchmark that could be computed, fired or not. */
  readings: Partial<Record<Benchmark, RrgReading>>;
  filters: Filters;
  reasons: string[];
}

export type SkipReason = 'length-mismatch' | 'bad-data' | 'insufficient-history';

export interface Watchlist {
  timeframe: Timeframe;
  /** Ranked, best first. */
  entries: WatchlistEntry[];
  skipped: { symbol: string; reason: SkipReason }[];
}
