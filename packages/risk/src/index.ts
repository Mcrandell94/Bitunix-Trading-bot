// Risk engine: every entry passes checkEntry() before it can become an
// order, in the backtest now and live later. Pure: state and time come in.

export type Tier = 'LTF' | 'MTF';
export type Side = 'long' | 'short';

export interface Killzone {
  name: string;
  /** Local New York time, "HH:MM"; end may be "24:00". */
  start: string;
  end: string;
}

export interface TierRisk {
  /** % of equity lost if the stop is hit. */
  riskPct: number;
  /** New entries stop for the rest of the UTC day once the tier's realized loss reaches this % of day-start equity. */
  dailyLossPct: number;
  /** Position notional / equity, per position. */
  maxEffectiveLeverage: number;
  /** Entry windows (New York time, DST-aware); null = any time. */
  killzones: Killzone[] | null;
}

export interface RiskConfig {
  tiers: Record<Tier, TierRisk>;
  /** BTC/ETH/XRP share one cap across both tiers. */
  coreSymbols: string[];
  /** Combined notional of core positions and pending entries / equity. */
  coreExposureCap: number;
  /** No new entries this many minutes before a funding settlement. */
  fundingGapMinutes: number;
  /** LTF may only trade in the direction of an open MTF position on the same symbol (owner's rule). */
  ltfRequiresMtf: boolean;
  /**
   * Positions (plus pending entries) allowed per symbol per tier. Bitunix
   * supports several same-direction positions on one symbol; 1 = no stacking.
   */
  maxPositionsPerSymbolTier: number;
}

// Owner's choices. 2026-09-26, first: LTF killzones London, NY AM and Asia,
// 15 min funding gap. Revised the same day for the small live account: risk
// at the stop LTF 1% / MTF 2% (never above MAX_RISK_PCT), daily loss limits
// LTF 4% / MTF 8% (four full losses per tier; "a bit more loss to stay
// active" than three). Was 0.25% / 0.5% risk and 1.5% / 3% daily.
// Leverage and the core cap weren't specified beyond "MTF max 2-3x": 3x is
// used for both tiers and for the core cap until decided otherwise.
export const DEFAULT_RISK: RiskConfig = {
  tiers: {
    LTF: {
      riskPct: 1,
      dailyLossPct: 4,
      maxEffectiveLeverage: 3,
      killzones: [
        { name: 'London', start: '02:00', end: '05:00' },
        { name: 'New York AM', start: '07:00', end: '10:00' },
        { name: 'Asia', start: '20:00', end: '24:00' },
      ],
    },
    MTF: { riskPct: 2, dailyLossPct: 8, maxEffectiveLeverage: 3, killzones: null },
  },
  coreSymbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'],
  coreExposureCap: 3,
  fundingGapMinutes: 15,
  ltfRequiresMtf: true,
  maxPositionsPerSymbolTier: 1,
};

const nyClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Minutes past midnight, New York time. */
export function nyMinutes(time: number): number {
  const [h, m] = nyClock.format(time).split(':').map(Number);
  return h! * 60 + m!;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** The killzone `time` falls in (start inclusive, end exclusive), or null. */
export function killzoneAt(time: number, zones: ReadonlyArray<Killzone>): Killzone | null {
  const m = nyMinutes(time);
  return zones.find((z) => m >= toMinutes(z.start) && m < toMinutes(z.end)) ?? null;
}

/** Next funding settlement strictly after `time`, when settlements fall every `intervalHours` from 00:00 UTC. */
export function nextFundingAfter(time: number, intervalHours: number): number {
  const ms = intervalHours * 3_600_000;
  return Math.floor(time / ms) * ms + ms;
}

export const utcDay = (time: number) => Math.floor(time / 86_400_000);

export interface ContractLimits {
  /** Quantity step (10^-basePrecision). */
  qtyStep: number;
  minQty: number;
}

export interface Sizing {
  qty: number;
  notional: number;
  /** Loss at the stop, before fees. */
  riskAmount: number;
  cappedBy: 'risk' | 'leverage' | 'core-cap';
}

function roundDown(x: number, step: number): number {
  const n = Math.floor(x / step + 1e-9);
  return Number((n * step).toFixed(12));
}

/** Owner's ceiling: no trade risks more than this % of equity at its stop, whatever the config says. */
export const MAX_RISK_PCT = 3;

/** Size from stop distance, capped by effective leverage, rounded down to the contract's step. */
export function sizePosition(p: {
  equity: number; riskPct: number; entry: number; stop: number; maxEffectiveLeverage: number; limits: ContractLimits;
}): Sizing | null {
  const dist = Math.abs(p.entry - p.stop);
  if (!(dist > 0) || !(p.equity > 0)) return null;
  const byRisk = (p.equity * Math.min(p.riskPct, MAX_RISK_PCT)) / 100 / dist;
  const byLev = (p.equity * p.maxEffectiveLeverage) / p.entry;
  const raw = Math.min(byRisk, byLev);
  const qty = roundDown(raw, p.limits.qtyStep);
  if (qty < p.limits.minQty || qty <= 0) return null;
  return { qty, notional: qty * p.entry, riskAmount: qty * dist, cappedBy: byLev < byRisk ? 'leverage' : 'risk' };
}

export interface Bracket {
  entry: number;
  stop: number;
  takeProfit: number;
  /** Both exits trigger on mark price. */
  trigger: 'MARK_PRICE';
}

export function bracket(side: Side, entry: number, stop: number, rewardR: number): Bracket {
  const risk = Math.abs(entry - stop);
  return { entry, stop, takeProfit: side === 'long' ? entry + rewardR * risk : entry - rewardR * risk, trigger: 'MARK_PRICE' };
}

export interface OpenPosition {
  symbol: string;
  tier: Tier;
  side: Side;
  qty: number;
  entry: number;
}

export interface PendingEntry {
  symbol: string;
  tier: Tier;
  side: Side;
  qty: number;
  entry: number;
}

export interface AccountState {
  equity: number;
  /** Equity at the start of the current UTC day. */
  dayStartEquity: number;
  /** Realized PnL today per tier, after fees and funding. */
  realizedToday: Record<Tier, number>;
  positions: ReadonlyArray<OpenPosition>;
  pending: ReadonlyArray<PendingEntry>;
}

export interface EntryIntent {
  symbol: string;
  tier: Tier;
  side: Side;
  bracket: Bracket;
  limits: ContractLimits;
}

export type Rejection =
  | 'invalid-bracket' | 'daily-loss-limit' | 'outside-killzone' | 'funding-gap'
  | 'ltf-needs-mtf-position' | 'already-open' | 'below-min-qty' | 'core-exposure-cap';

export type EntryDecision = { ok: true; sizing: Sizing; killzone: string | null } | { ok: false; reason: Rejection };

export function checkEntry(
  intent: EntryIntent,
  state: AccountState,
  env: { time: number; nextFundingTime: number | null },
  cfg: RiskConfig = DEFAULT_RISK,
): EntryDecision {
  const tier = cfg.tiers[intent.tier];
  const { entry, stop, takeProfit, trigger } = intent.bracket;
  const long = intent.side === 'long';
  const orderedOk = long ? stop < entry && entry < takeProfit : takeProfit < entry && entry < stop;
  if (!orderedOk || trigger !== 'MARK_PRICE') return { ok: false, reason: 'invalid-bracket' };

  if (state.realizedToday[intent.tier] <= -(tier.dailyLossPct / 100) * state.dayStartEquity) {
    return { ok: false, reason: 'daily-loss-limit' };
  }

  let killzone: string | null = null;
  if (tier.killzones) {
    const kz = killzoneAt(env.time, tier.killzones);
    if (!kz) return { ok: false, reason: 'outside-killzone' };
    killzone = kz.name;
  }

  if (env.nextFundingTime != null) {
    const until = env.nextFundingTime - env.time;
    if (until >= 0 && until < cfg.fundingGapMinutes * 60_000) return { ok: false, reason: 'funding-gap' };
  }

  const same = (p: { symbol: string; tier: Tier }) => p.symbol === intent.symbol && p.tier === intent.tier;
  const open = state.positions.filter(same).length + state.pending.filter(same).length;
  if (open >= cfg.maxPositionsPerSymbolTier) return { ok: false, reason: 'already-open' };
  // Stacked positions must point the same way.
  if ([...state.positions, ...state.pending].some((p) => same(p) && p.side !== intent.side)) return { ok: false, reason: 'already-open' };

  // LTF only trades in the direction of an open MTF position on the same symbol.
  if (cfg.ltfRequiresMtf && intent.tier === 'LTF' && !state.positions.some((p) => p.symbol === intent.symbol && p.tier === 'MTF' && p.side === intent.side)) {
    return { ok: false, reason: 'ltf-needs-mtf-position' };
  }

  let sizing = sizePosition({
    equity: state.equity, riskPct: tier.riskPct, entry, stop, maxEffectiveLeverage: tier.maxEffectiveLeverage, limits: intent.limits,
  });
  if (!sizing) return { ok: false, reason: 'below-min-qty' };

  if (cfg.coreSymbols.includes(intent.symbol)) {
    const used = [...state.positions, ...state.pending]
      .filter((p) => cfg.coreSymbols.includes(p.symbol))
      .reduce((a, p) => a + Math.abs(p.qty * p.entry), 0);
    const room = cfg.coreExposureCap * state.equity - used;
    if (sizing.notional > room) {
      const qty = roundDown(Math.max(0, room) / entry, intent.limits.qtyStep);
      if (qty < intent.limits.minQty || qty <= 0) return { ok: false, reason: 'core-exposure-cap' };
      sizing = { qty, notional: qty * entry, riskAmount: qty * Math.abs(entry - stop), cappedBy: 'core-cap' };
    }
  }
  return { ok: true, sizing, killzone };
}
