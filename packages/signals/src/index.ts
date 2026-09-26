export { buildWatchlist, type ScanInput } from './watchlist';
export { classifyReading, readPoints, readRrg } from './classify';
export {
  BENCHMARKS, CORE_SYMBOLS, DEFAULT_CONFIG, RRG_TIER, resolveConfig, routeSignal,
  type ClassifierConfig, type ScoreWeights,
} from './config';
export { crossedThrough, endsWith, momentumTroughInside, quadrantRuns, tailVelocity } from './geometry';
export {
  AGREEMENT, absoluteTrendScore, agreementScore, fundingScore, relativeVolumeScore,
  timeInQuadrantScore, velocityScore, weightedScore, type OtherBenchmark,
} from './score';
export type * from './types';
