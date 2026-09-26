import type { Candle } from '@bot/marketdata';
import { DEFAULT_RISK, type ContractLimits, type RiskConfig, type Side, type Tier } from '@bot/risk';
import type { ClassifierConfig, SignalType } from '@bot/signals';
import { DEFAULT_BIAS, DEFAULT_SETUP, DEFAULT_STRUCTURE, type BiasConfig, type SetupConfig, type StructureConfig } from '@bot/smc';

export type Tf = '15m' | '1h' | '4h' | '1d';

export interface FundingPoint {
  /** Settlement time, ms. */
  time: number;
  /** Per-settlement rate as a fraction (0.0001 = 0.01%). */
  rate: number;
}

export interface SymbolData {
  /** Last-price candles per timeframe, oldest first, closed bars only. */
  candles: Partial<Record<Tf, Candle[]>>;
  /** 15m mark-price candles for stop/target triggers. Last price is used if absent. */
  mark15m?: Candle[];
  /** Funding settlement history. Without it, `defaultFunding` is assumed. */
  funding?: FundingPoint[];
  fundingIntervalHours?: number;
  limits?: ContractLimits;
}

export interface TierPlan {
  enabled: boolean;
  /** Timeframe setups are detected on. */
  entryTf: Tf;
  /** [higher, lower]: the higher decides the bias, the lower can veto it. */
  biasTfs: [Tf, Tf];
  /** RRG timeframes whose signals admit extra (non-core) symbols for this tier. */
  rrgTfs: Tf[];
  /** Unfilled limit entries are cancelled after this many entry-timeframe bars. */
  expiryBars: number;
  /** Take-profit attached to every order, in R. For MTF it caps the trailing runner. */
  rewardR: number;
  /** Scale-outs at these R multiples, as fractions of the starting size. */
  partials: { atR: number; fraction: number }[];
  /** Move the stop to entry once this R is reached (null = never). */
  breakevenAtR: number | null;
  /** Trail the stop on this timeframe's confirmed swings after the first partial (null = no trail). */
  trailTf: Tf | null;
}

export interface BacktestConfig {
  /** Trading window, ms. Earlier candles serve as warm-up only. */
  from: number;
  to: number;
  startEquity: number;
  /** Bitunix base tier: 0.02% maker, 0.06% taker. */
  fees: { maker: number; taker: number };
  /** Adverse slippage on taker fills (stops, targets, gapped entries), in basis points. */
  slippageBps: number;
  defaultFunding: { rate: number; intervalHours: number };
  risk: RiskConfig;
  structure: StructureConfig;
  setup: SetupConfig;
  bias: BiasConfig;
  rrg: Partial<ClassifierConfig>;
  rrgHistoryBars: number;
  tiers: Record<Tier, TierPlan>;
  /** Setups whose stop is closer than this % of the entry are skipped (fees would eat them). 0 = off. */
  minStopPct: number;
  /**
   * How targets and partials fill. 'taker': mark-price trigger → market
   * order (the spec). 'maker': resting reduce-only limit orders at the level.
   */
  targetFill: 'taker' | 'maker';
  /** 'veto': the lower bias timeframe can veto the higher; 'higher': only the higher counts. */
  biasCombine: 'veto' | 'higher';
}

export const DEFAULT_TIERS: Record<Tier, TierPlan> = {
  LTF: {
    enabled: true, entryTf: '15m', biasTfs: ['4h', '1h'], rrgTfs: ['1h'], expiryBars: 8,
    rewardR: 2, partials: [], breakevenAtR: null, trailTf: null,
  },
  MTF: {
    enabled: true, entryTf: '1h', biasTfs: ['1d', '4h'], rrgTfs: ['4h', '1d', '1h'], expiryBars: 6,
    rewardR: 5, partials: [{ atR: 1, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }], breakevenAtR: 1, trailTf: '4h',
  },
};

export function defaultConfig(from: number, to: number): BacktestConfig {
  return {
    from, to, startEquity: 10_000,
    fees: { maker: 0.0002, taker: 0.0006 },
    slippageBps: 2,
    defaultFunding: { rate: 0.0001, intervalHours: 8 },
    risk: DEFAULT_RISK,
    structure: DEFAULT_STRUCTURE,
    setup: DEFAULT_SETUP,
    bias: DEFAULT_BIAS,
    rrg: {},
    rrgHistoryBars: 120,
    tiers: DEFAULT_TIERS,
    minStopPct: 0,
    // Owner's decision 2026-09-26: targets and partials rest as reduce-only
    // limit orders (maker); the stop stays a mark-price trigger.
    targetFill: 'maker',
    biasCombine: 'veto',
  };
}

/** Why a trade was allowed: a core symbol on bias alone, or the RRG signal that admitted it. */
export type Source = 'core' | SignalType;

export interface Fill {
  time: number;
  price: number;
  qty: number;
  fee: number;
  reason: 'entry' | 'stop' | 'target' | 'partial' | 'end';
}

export interface Trade {
  id: number;
  symbol: string;
  tier: Tier;
  side: Side;
  source: Source;
  openedAt: number;
  closedAt: number;
  entry: number;
  initialStop: number;
  /** Loss at the initial stop, before costs. 1R. */
  riskAmount: number;
  qty: number;
  fills: Fill[];
  grossPnl: number;
  fees: number;
  /** Positive = received. */
  funding: number;
  netPnl: number;
  r: number;
}

export interface Rejected {
  time: number;
  symbol: string;
  tier: Tier;
  reason: string;
}

/** A position still open at the end of a run (paper mode). */
export interface OpenPositionView {
  symbol: string;
  tier: Tier;
  side: Side;
  source: Source;
  openedAt: number;
  entry: number;
  stop: number;
  initialStop: number;
  takeProfit: number;
  qty: number;
  qtyInitial: number;
  riskAmount: number;
  /** Realized so far on partial exits, after fees and funding. */
  realizedNet: number;
  /** At the last close (mark price where available). */
  unrealizedPnl: number;
  lastPrice: number;
}

/** A limit entry still waiting at the end of a run (paper mode). */
export interface PendingView {
  symbol: string;
  tier: Tier;
  side: Side;
  source: Source;
  entry: number;
  stop: number;
  takeProfit: number;
  qty: number;
  expiresAt: number;
}

/** What the bot is waiting for on one symbol and tier at the last close (paper radar). */
export interface RadarRow {
  symbol: string;
  tier: Tier;
  core: boolean;
  /** in-position / order-pending / watching (a sweep, awaiting MSS) / ready (bias set, waiting for a sweep) / blocked. */
  status: 'in-position' | 'order-pending' | 'watching' | 'ready' | 'blocked';
  /** One plain sentence. */
  note: string;
  bias: { combined: 'long' | 'short' | 'neutral'; byTf: { tf: Tf; direction: 'long' | 'short' | 'neutral'; reasons: string[] }[] };
  /** Extras only: the RRG signal allowing a direction, if any. */
  rrg: { side: Side; source: Source } | null;
  watch: { side: Side; sweptLevel: number; mssLevel: number; lastClose: number; distancePct: number; barsLeft: number } | null;
  /** Rules that would stop an entry right now. */
  gates: string[];
  /** Setups found in the last 24h that were rejected, newest first. */
  recentRejections: { time: number; reason: string }[];
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: Trade[];
  /** Filled only when the run leaves positions open (closeAtEnd: false). */
  open: { positions: OpenPositionView[]; pending: PendingView[] };
  /** Realized equity after each change, for drawdown. */
  equityCurve: { time: number; equity: number }[];
  endEquity: number;
  setupsSeen: number;
  expired: number;
  rejected: Rejected[];
  warnings: string[];
  /** Only with RunMode.radar. */
  radar?: { time: number; rows: RadarRow[] };
}
