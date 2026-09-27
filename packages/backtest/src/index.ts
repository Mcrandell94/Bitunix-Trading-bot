export { runBacktest, type Candidate, type CandidateOverride, type RunMode } from './engine';
export { formatReport, maxDrawdown, stats, summarize, type Stats, type Summary } from './metrics';
export * from './types';
export { applyRules, loadRules, enabledRules, IMPLEMENTED, type Rules } from './rules';
export { appendRunLog, profitFactor, rowFromTrades, RUN_LOG_PATH, type RunLogRow } from './runlog';
export { baselineFixture, compareFixtures, tierFixture, HOLDOUT_DAYS, type BaselineFixture } from './baseline';
export { audit, explainLoss, formatAudit, type AuditTier, type LossRow } from './audit';
export { addMonths, block, makeFolds, walkForwardBaseline, formatWalkForward, type Fold, type TierWalk } from './walkforward';
