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
  /**
   * Structure (the latest confirmed break) on each of these timeframes must
   * already point the trade's way when the setup is taken. Unset = none.
   */
  confirmTfs?: Tf[];
  /** 'off': skip the HTF bias check (the confluence score's Mode X gates setups instead). Default: required. */
  bias?: 'required' | 'off';
  /**
   * Stop moves once the trade has reached `atR` (replaces breakevenAtR when
   * set): to entry + toR x R, or to entry +/- toPct % in the trade's favour.
   * Only ever tightens. Confluence SPEC §5: -0.5R at +1R, +0.1% at +2R.
   */
  stopSteps?: { atR: number; toR?: number; toPct?: number }[];
  /** Chandelier trail from +activateR: highest high since entry - mult x Wilder ATR(atrLen, atrTf), updated on atrTf closes. */
  chandelier?: { activateR: number; atrTf: Tf; atrLen: number; mult: number };
  /** Exit at market at a barTf close once checkBars have passed with less than minMfeR reached; always by maxBars. */
  timeStop?: { barTf: Tf; checkBars: number; minMfeR: number; maxBars: number };
  /** Cancel a resting limit when price reaches the 1R level first (backtest SPEC F1). */
  cancelOn1RTouch?: boolean;
  /** Cancel a resting limit when an entry-timeframe bar closes beyond the gap's far edge (F1). */
  cancelOnZoneClose?: boolean;
  /** Only these symbols may enter on this tier (unset = the whole universe). */
  symbols?: string[];
  /**
   * Entry model: the SMC sweep/MSS/FVG setup (default), the EMA + MACD +
   * Stochastic momentum model, the trend / mean-reversion model, or a
   * screened signal from screen/signals.ts (`signal`).
   */
  model?: 'smc' | 'momentum' | 'trend' | 'signal';
  momentum?: MomentumConfig;
  trend?: TrendConfig;
  /**
   * model 'signal': the screened signal's id, and its ATR bracket: market
   * entry at the next 15m open after the entry-timeframe close, stop and
   * target at these multiples of ATR(14) on the entry timeframe.
   */
  signal?: {
    id: string; stopAtr: number; targetAtr: number;
    /** Use the signal's own structure stop (SignalDef.stop; no trade when it has none); the target is then capR x that distance. */
    structureStop?: { capR: number };
  };
  /** What the dashboard calls this slot when it runs a named strategy (e.g. "EMA 50 trend · target 1 ATR"). */
  label?: string;
}

/**
 * Owner's LTF proposal (SoftKill's "EMA STOCH" Pine script): a trigger
 * (one of the last `crossLookback` closes crossed the fast EMA either way,
 * or a wick touched it within `touchLookback` bars), then for a long: close
 * above the fast EMA, fast EMA above the slow, MACD histogram >= 0, and
 * Stochastic %K crossing up through oversold on this bar. Shorts mirror it.
 * An opposite signal flips the position (no pyramiding in the script).
 * Exits by % move (tpPct / slPct) or, when null, our ATR-based bracket.
 */
export interface MomentumConfig {
  fastEma: number;
  slowEma: number;
  macd: [number, number, number];
  stoch: [number, number, number];
  oversold: number;
  overbought: number;
  crossLookback: number;
  /** Bars back a wick touching the fast EMA also counts as the trigger (0 = off). */
  touchLookback: number;
  /** Stochastic cross must be on the current bar (the script) or anywhere in the lookback. */
  stochCrossNow: boolean;
  /** An opposite signal closes the open position at market and opens the new one. */
  reverse: boolean;
  /** Take-profit distance as % of entry (null = the tier's rewardR times the stop distance). */
  tpPct: number | null;
  /** Stop distance as % of entry (null = stop 1 ATR beyond the slow EMA). */
  slPct: number | null;
  /** Keep the SMC bias and RRG gates on top of the model. */
  useBias: boolean;
  useRrg: boolean;
}

export const DEFAULT_MOMENTUM: MomentumConfig = {
  fastEma: 50, slowEma: 100, macd: [12, 26, 9], stoch: [5, 3, 3], oversold: 20, overbought: 80, crossLookback: 5,
  touchLookback: 4, stochCrossNow: true, reverse: true, tpPct: 10, slPct: 10, useBias: false, useRrg: false,
};

/**
 * Owner's LTF proposal #2 (2026-09-27): trend + momentum + volume with an
 * ATR stop. Long when the close is above the slow EMA (fast above slow),
 * Supertrend is up, the session VWAP agrees (optional), the RSI just
 * crossed 50 or came back out of oversold, the MACD histogram agrees
 * (optional) and volume is a multiple of its average. Shorts mirror it.
 * `mode: 'meanrev'` swaps the trend trigger for a Bollinger re-entry: the
 * close comes back inside the band with the RSI out of oversold/overbought.
 * Market entry on the close; stop `stopAtr` ATRs away; target in R.
 */
export interface TrendConfig {
  mode: 'trend' | 'meanrev';
  fastEma: number;
  slowEma: number;
  /** [period, multiplier]; null = not required. */
  supertrend: [number, number] | null;
  /** Price must be on the trade's side of the session VWAP. */
  vwap: boolean;
  rsiPeriod: number;
  /** 'cross50': RSI crossed 50 the trade's way; 'oversold': RSI came back out of the oversold/overbought zone; 'either'. */
  rsiTrigger: 'cross50' | 'oversold' | 'either';
  oversold: number;
  overbought: number;
  /** Bars (including this one) in which the RSI trigger may have fired. */
  rsiLookback: number;
  /** MACD histogram must agree; null = not required. */
  macd: [number, number, number] | null;
  /** Bar volume must be at least this many times its `volumeMa`-bar average (0 = off). */
  volumeMult: number;
  volumeMa: number;
  /** Bollinger [period, mult] for the mean-reversion mode. */
  bollinger: [number, number];
  atrPeriod: number;
  /** Stop distance in ATRs. */
  stopAtr: number;
  /** Target in R (null = the tier's rewardR). */
  rewardR: number | null;
  /** Close the position at market when the Supertrend flips against it. */
  exitOnFlip: boolean;
  /** Keep the SMC bias and RRG gates on top of the model. */
  useBias: boolean;
  useRrg: boolean;
}

export const DEFAULT_TREND: TrendConfig = {
  mode: 'trend', fastEma: 9, slowEma: 21, supertrend: [10, 3], vwap: false, rsiPeriod: 12, rsiTrigger: 'either',
  oversold: 35, overbought: 65, rsiLookback: 3, macd: null, volumeMult: 1.5, volumeMa: 20, bollinger: [20, 2],
  atrPeriod: 14, stopAtr: 1.2, rewardR: null, exitOnFlip: true, useBias: false, useRrg: false,
};

export interface BacktestConfig {
  /** Trading window, ms. Earlier candles serve as warm-up only. */
  from: number;
  to: number;
  startEquity: number;
  /** Bitunix base tier: 0.02% maker, 0.06% taker. */
  fees: { maker: number; taker: number };
  /** Adverse slippage on taker fills (stops, targets, gapped entries), in basis points. */
  slippageBps: number;
  /**
   * Fill realism (docs/backtest/SPEC.md §6, TASKS T3), off in the baseline:
   * a resting limit entry fills only when price trades through it by at
   * least one tick (a touch is not enough).
   */
  fillRealism: boolean;
  /** No entry fills from this many minutes before to this many after a funding settlement. Unset = off. */
  fundingFillBlackoutMinutes?: number;
  /** Portfolio caps (backtest SPEC §6): total open risk and same-direction alts beyond BTC/ETH. Unset = off. */
  portfolio?: {
    maxOpenRiskPct: number; maxSameDirAlts: number;
    /** Count each tier's own positions only (strategies sharing one account, each with its own caps). */
    perTier?: boolean;
  } | null;
  /**
   * RRG as a magnifying glass, never a gate (owner): when several coins signal
   * at the same close, the ones strongest against BTC the trade's way (RRG
   * RS-Ratio + RS-Momentum on `rrgTf`) are tried first. It never adds or drops
   * a signal; it only decides who gets a slot when a portfolio cap is full.
   * Unset = symbol order (first come, first served).
   */
  entryPriority?: { rrgTf: Tf } | null;
  /** Record each entry's RRG strength vs BTC on this timeframe (Trade.rrg), for forward testing. Logging only. Unset = off. */
  rrgLogTf?: Tf | null;
  /**
   * Drawdown circuit breaker (owner's portfolio layer): when realized equity
   * falls `drawdownPct` % below its peak, no new entries for `pauseDays`; the
   * peak then resets to equity at the resume. Open trades are managed as usual. Unset = off.
   */
  circuitBreaker?: { drawdownPct: number; pauseDays: number } | null;
  defaultFunding: { rate: number; intervalHours: number };
  risk: RiskConfig;
  structure: StructureConfig;
  setup: SetupConfig;
  bias: BiasConfig;
  rrg: Partial<ClassifierConfig>;
  rrgHistoryBars: number;
  tiers: Record<Tier, TierPlan>;
  /**
   * Setups whose stop is closer than this % of the entry are skipped. 0 = off.
   * 0.5 since 2026-09-27 (owner): in every window tested, stops under 0.3%
   * were the biggest single loss (gaps through a tiny stop cost 10-20R each).
   */
  minStopPct: number;
  /**
   * How targets and partials fill. 'taker': mark-price trigger → market
   * order (the spec). 'maker': resting reduce-only limit orders at the level.
   */
  targetFill: 'taker' | 'maker';
  /** 'veto': the lower bias timeframe can veto the higher; 'higher': only the higher counts; 'both': both must agree. */
  biasCombine: 'veto' | 'higher' | 'both';
  /** Skip setups with less than this many R to the nearest opposing swing (the liquidity target). 0 = off. */
  minRoomR: number;
  /** BTC/ETH/XRP: skip a setup when an RRG signal points the other way. */
  coreRrgVeto: boolean;
  /**
   * How RRG gates extra (non-core) symbols. 'required': a same-direction
   * signal is needed (original); 'veto': trade on bias, skip only against an
   * opposite signal; 'guide': RRG only picks the universe, extras trade on
   * bias like the core symbols.
   */
  extrasRrg: 'required' | 'veto' | 'guide';
  /** Win-rate filters (research 2026-09-27). All off by default. */
  filters: EntryFilters;
}

export interface EntryFilters {
  /**
   * Volatility regime: the entry-timeframe ATR must rank between these
   * percentiles of its previous `lookback` bars (dead chop and blow-off
   * volatility both skipped). null = off.
   */
  atrRegime: { lookback: number; minPct: number; maxPct: number } | null;
  /**
   * The sweep must land inside an unmitigated FVG or order block of the
   * trade's direction on this bias timeframe ('higher' or 'lower'). null = off.
   */
  htfZone: 'higher' | 'lower' | null;
  /** Price on the higher bias timeframe must be on the right side of a rising/falling EMA of this length. null = off. */
  emaTrend: number | null;
  /** Alts only trade when BTC's own bias on the tier's lower bias timeframe isn't the opposite. */
  btcGate: boolean;
  /** No entries within this many minutes of an FOMC statement. 0 = off. */
  fomcBlackoutMinutes: number;
}

export const NO_FILTERS: EntryFilters = { atrRegime: null, htfZone: null, emaTrend: null, btcGate: false, fomcBlackoutMinutes: 0 };

/**
 * FOMC statement times (14:00 New York). 2024-2025 from the Fed's published
 * calendar; 2026 from the announced schedule (verify against
 * federalreserve.gov before relying on late-2026 dates).
 */
export const FOMC_TIMES: number[] = [
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
].map((d) => {
  // 14:00 New York = 18:00 UTC in daylight time (Mar-Nov), 19:00 UTC otherwise.
  const m = Number(d.slice(5, 7));
  const dst = m >= 4 && m <= 10 || (m === 3 && Number(d.slice(8)) >= 15) || (m === 11 && Number(d.slice(8)) < 7);
  return Date.parse(`${d}T${dst ? '18' : '19'}:00:00Z`);
});

export const DEFAULT_TIERS: Record<Tier, TierPlan> = {
  // Off since 2026-09-27 (owner): two years of backtests found no edge in the
  // 15m tier on its own (31-37% wins at 2R). Kept for research on new LTF models.
  LTF: {
    enabled: false, entryTf: '15m', biasTfs: ['4h', '1h'], rrgTfs: ['1h'], expiryBars: 8,
    rewardR: 2, partials: [], breakevenAtR: null, trailTf: null,
  },
  // Off since 2026-09-27 (owner): no more separate timeframe bots. 36-month
  // walk-forward: -0.05R per trade out of sample, 2 of 8 test quarters
  // positive. The one bot is the confluence model (confluenceConfig below),
  // which reuses this slot for its 1H entries.
  MTF: {
    enabled: false, entryTf: '1h', biasTfs: ['1d', '4h'], rrgTfs: ['4h', '1d', '1h'], expiryBars: 6,
    rewardR: 5, partials: [{ atR: 1, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }], breakevenAtR: 1, trailTf: '4h',
  },
  // Added 2026-09-27 (owner: "adapt to a HTF"): the MTF plan one step up.
  // Setups on 4H, daily bias (4H can veto), RRG on daily, a day to fill,
  // partials at 1R and 2R, then a daily-swing trail capped at 5R.
  // Off until the backtests say otherwise (owner, same day): research
  // --tier htf switches it on alone.
  HTF: {
    enabled: false, entryTf: '4h', biasTfs: ['1d', '4h'], rrgTfs: ['1d'], expiryBars: 6,
    rewardR: 5, partials: [{ atR: 1, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }], breakevenAtR: 1, trailTf: '1d',
  },
  // The 4H pullback slot (owner, 2026-09-27): off unless a model switches it on (ema50Config does).
  P4H: {
    enabled: false, entryTf: '4h', biasTfs: ['1d', '4h'], rrgTfs: [], expiryBars: 2,
    rewardR: 100, partials: [], breakevenAtR: null, trailTf: null,
  },
};

/**
 * The confluence bot (owner, 2026-09-27): one strategy where every timeframe
 * has to agree, instead of separate timeframe bots.
 *  - Daily: the bias (structure plus discount/premium, a zone tap or SMT).
 *  - 4H: its own bias must agree with the daily (not just not object), and
 *    the 1H sweep must land inside an unmitigated 4H FVG or order block of
 *    the trade's direction (the point of interest).
 *  - 1H: the setup: sweep of a swing, market structure shift with
 *    displacement, limit entry in the FVG, stop beyond the sweep.
 *  - 15m: structure already turned the trade's way when the setup is taken.
 * Exits as the MTF plan: a third off at 1R and 2R, breakeven at 1R, trail on
 * 4H swings, 5R cap. Runs in the MTF slot (risk settings, pauses, ledger).
 */
export function confluenceConfig(base: BacktestConfig): BacktestConfig {
  return {
    ...base,
    biasCombine: 'both',
    filters: { ...base.filters, htfZone: 'lower' },
    tiers: {
      LTF: { ...base.tiers.LTF, enabled: false },
      HTF: { ...base.tiers.HTF, enabled: false },
      MTF: { ...base.tiers.MTF, enabled: true, entryTf: '1h', biasTfs: ['1d', '4h'], confirmTfs: ['15m'] },
      P4H: { ...base.tiers.P4H, enabled: false },
    },
  };
}

/** The 4H pullback strategy's signal (owner, 2026-09-27; docs/RESULTS.md). */
export const PB4H_SIGNAL = 'pb_13_34_50_4h';

/**
 * The 4H 13/34/50 pullback (owner, 2026-09-27), its own slot (P4H): entry on
 * 4H closes (pb_13_34_50_4h), structure stop 1.0-2.0 ATR, 50% off at 1.6R,
 * stop to entry + 0.2R at +1R, the rest trails 2.0 x 4H ATR from +1.6R, cap
 * 6R, out after 14 4H bars. The r4h exit of the screen.
 */
export function pb4hSlot(base: BacktestConfig): TierPlan {
  return {
    ...base.tiers.P4H,
    enabled: true, model: 'signal', label: '4H 13/34/50 · 4H pullback', entryTf: '4h', rrgTfs: [], expiryBars: 2, rewardR: 100,
    signal: { id: PB4H_SIGNAL, stopAtr: 2, targetAtr: 0, structureStop: { capR: 6 } },
    partials: [{ atR: 1.6, fraction: 0.5 }],
    breakevenAtR: null,
    stopSteps: [{ atR: 1, toR: 0.2 }],
    trailTf: null,
    timeStop: { barTf: '4h', checkBars: 14, minMfeR: -1e9, maxBars: 14 },
    chandelier: { activateR: 1.6, atrTf: '4h', atrLen: 14, mult: 2 },
  };
}

/** The signal the EMA 50 strategies enter on (docs/RESULTS.md): daily close and EMA 50 slope turn the same way, ATR% not in its extreme 10%. */
export const EMA50_SIGNAL = 'ema50_trend_vol';

/**
 * The EMA 50 trend strategies (owner, 2026-09-27): one entry signal, three
 * exits, each in its own slot so every position is tagged with the strategy
 * that took it (the slot names are the old tier names, kept for the
 * dashboard, pauses and ledgers):
 *  - MTF "target 1 ATR" (the default): stop 2 ATR, target 1 ATR, out after 24 days.
 *  - HTF "hybrid": 60% off at 1 ATR, stop to entry, the rest trails 2.5 ATR
 *    behind the best price; cap 8 ATR; out after 72 days.
 *  - LTF "hybrid 1.5": 50% off at 1.5 ATR, stop to entry, trail 3 ATR; cap 8 ATR; 72 days.
 * Each has 1% risk and its own caps (open risk <= 6%, <= 2 same-direction
 * alts); one 15% drawdown breaker (7 days off) and the cost veto cover the
 * account. Matches the portfolio backtests in docs/RESULTS.md (a test holds
 * the default slot to the portfolio runner's trades).
 */
export function ema50Config(base: BacktestConfig): BacktestConfig {
  const slot = (label: string, targetAtr: number, maxBars: number, partial?: { atAtr: number; fraction: number; trail: number }): TierPlan => ({
    ...base.tiers.MTF,
    enabled: true, model: 'signal', label, entryTf: '1d', rrgTfs: [], expiryBars: 2, rewardR: 100,
    signal: { id: EMA50_SIGNAL, stopAtr: 2, targetAtr },
    partials: partial ? [{ atR: partial.atAtr / 2, fraction: partial.fraction }] : [],
    breakevenAtR: partial ? partial.atAtr / 2 : null,
    trailTf: null,
    timeStop: { barTf: '1d', checkBars: maxBars, minMfeR: -1e9, maxBars },
    ...(partial ? { chandelier: { activateR: partial.atAtr / 2, atrTf: '1d' as Tf, atrLen: 14, mult: partial.trail } } : {}),
  });
  const risk = (t: keyof RiskConfig['tiers']) => ({ ...base.risk.tiers[t], riskPct: 1, dailyLossPct: 8, maxEffectiveLeverage: base.risk.tiers.MTF.maxEffectiveLeverage, killzones: null });
  return {
    ...base,
    minStopPct: 0.10 / 0.15, // the cost veto
    fillRealism: true,
    portfolio: { maxOpenRiskPct: 6, maxSameDirAlts: 2, perTier: true },
    circuitBreaker: { drawdownPct: 15, pauseDays: 7 },
    // Forward testing (owner): every entry records the coin's daily RRG strength vs BTC. Logging only.
    rrgLogTf: '1d',
    risk: { ...base.risk, fundingGapMinutes: 0, maxPositionsPerSymbolTier: 1, tiers: { LTF: risk('LTF'), MTF: risk('MTF'), HTF: risk('HTF'), P4H: risk('P4H') } },
    tiers: {
      P4H: pb4hSlot(base),
      MTF: slot('EMA 50 trend · target 1 ATR', 1, 24),
      HTF: slot('EMA 50 trend · hybrid', 8, 72, { atAtr: 1, fraction: 0.6, trail: 2.5 }),
      LTF: slot('EMA 50 trend · hybrid 1.5', 8, 72, { atAtr: 1.5, fraction: 0.5, trail: 3 }),
    },
  };
}

/**
 * What the worker trades.
 *  - 'none': nothing; the bot idles.
 *  - 'ema50': the EMA 50 trend strategies (ema50Config), all three slots,
 *    plus the 4H pullback in its own slot (P4H).
 *  - 'confluence': the retired confluence gate.
 *  - 'mtf': the old MTF tier alone (kept for tests and as a way back).
 * BOT_MODEL drives the paper replay. LIVE_MODEL is what may reach the real
 * account. Within the live model, the owner's dashboard switches choose which
 * slots go live (default: none).
 *
 * 2026-09-27: the default exit (target 1 ATR) failed the 6-month check
 * (docs/RESULTS.md). The owner put all three strategies on paper as the
 * forward test: fresh, unseen data is the only clean test left.
 */
export type BotModel = 'none' | 'confluence' | 'mtf' | 'ema50';
export const BOT_MODEL: BotModel = 'ema50';
// Owner, 2026-09-27: live allowed in the code for the EMA 50 strategies, every
// one switched OFF on the dashboard until the owner turns it on. Hybrid (HTF) is
// the preferred one; target 1 ATR (MTF) failed the 6-month check.
export const LIVE_MODEL: BotModel = 'ema50';

/** Slots that trade live until the owner flips a dashboard switch: none. */
export const DEFAULT_LIVE_SLOTS: Record<Tier, boolean> = { MTF: false, HTF: false, LTF: false, P4H: false };
/** The strategy marked "preferred" on the dashboard (hybrid). */
export const PREFERRED_LIVE_SLOT: Tier = 'HTF';

export function botConfig(from: number, to: number, model: BotModel = BOT_MODEL): BacktestConfig {
  const base = defaultConfig(from, to);
  if (model === 'confluence') return confluenceConfig(base);
  if (model === 'ema50') return ema50Config(base);
  const on = (t: keyof BacktestConfig['tiers']) => model === 'mtf' && t === 'MTF';
  return { ...base, tiers: { LTF: { ...base.tiers.LTF, enabled: on('LTF') }, MTF: { ...base.tiers.MTF, enabled: on('MTF') }, HTF: { ...base.tiers.HTF, enabled: on('HTF') }, P4H: { ...base.tiers.P4H, enabled: false } } };
}

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
    minStopPct: 0.5,
    // Owner's decision 2026-09-26: targets and partials rest as reduce-only
    // limit orders (maker); the stop stays a mark-price trigger.
    targetFill: 'maker',
    biasCombine: 'veto',
    minRoomR: 0,
    coreRrgVeto: false,
    extrasRrg: 'required',
    filters: NO_FILTERS,
    fillRealism: false,
  };
}

/** Why a trade was allowed: a core symbol on bias alone, or the RRG signal that admitted it. */
export type Source = 'core' | SignalType;

export interface Fill {
  /** 'reverse': closed by the opposite momentum signal. */
  time: number;
  price: number;
  qty: number;
  fee: number;
  reason: 'entry' | 'stop' | 'target' | 'partial' | 'end' | 'reverse' | 'time';
  /** Where the price came from: the order's own level, the bar's open (gapped past it, or a market order), or the bar's close. */
  from?: 'level' | 'open' | 'close';
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
  /** Whatever the entry gate attached (the confluence score S at the MSS close). */
  tag?: number;
  /** RRG strength vs BTC the trade's way at the signal close (cfg.rrgLogTf); logged, never used to decide unless entryPriority is on. */
  rrg?: number;
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
  rrg?: number;
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
  /** The close the order was placed at. */
  placedAt: number;
  expiresAt: number;
  rrg?: number;
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
  /** 'signal': a screened-signal strategy (EMA 50); `shared` = the waiting state applies to every strategy on that signal. */
  model?: 'signal';
  shared?: boolean;
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
