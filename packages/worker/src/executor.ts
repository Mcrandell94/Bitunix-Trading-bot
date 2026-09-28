// Live executor: follows the paper replay's decisions onto the real account.
//
// Each 15-minute step, after the paper replay:
//  1. Reconcile what it placed before: an entry still resting past its expiry
//     is cancelled; one that left the book became a position (registered as
//     the bot's) or was cancelled elsewhere; an unclear reply is looked up by
//     clientId.
//  2. Every entry the strategy placed at this close becomes a live intent,
//     sized from the REAL account: the owner's risk per tier (3% / 5%, never
//     above 5%) of equity at the stop, capped by the coin's leverage class
//     (10x large caps, 5x mid, 3x small, set as the pair's leverage too), then
//     rounded to the pair's precision and minimum by planEntry. The stop and
//     final target ride on the order itself (MARK-price triggers), so a fill
//     is protected from its first moment.
//
// Every intent is claimed in the ledger (live_orders) BEFORE anything is
// sent, keyed by a deterministic clientId, so a restart never sends it twice.
// Sending goes through the trade API: the gate (disabled / dry-run / live,
// plus the dashboard halt) and the ownership rules (the owner's positions
// and orders are never touched).
//
// Daily loss stop: no new entries once the bot's own trades are down the
// tier's limit (% of the account) since the first step of the UTC day. The
// owner's own trades never count (owner, 2026-09-27: their trades tripped it).
//
// Not yet: partial targets, breakeven and trailing on live positions (the
// attached stop and target protect them meanwhile).

import { DEFAULT_LIVE_SLOTS, DEFAULT_TIERS, LIVE_MODEL, atrWilder, botConfig, type BacktestResult, type BotModel, type PendingView, type SymbolData, type Tf, type TierPlan } from '@bot/backtest';
import { barAt, analyze, swingsKnownAt } from '@bot/smc';
import { intervalMs } from '@bot/marketdata';
import {
  BitunixError, NotOwnedError, TradingDisabledError, fmt, liquidationSafe, planEntry, planTarget, rulesFromSpec,
  type Account, type ContractSpec, type OpenOrder, type Position, type PositionTpslBody, type SymbolRules, type TradeApi,
} from '@bot/bitunix';
import { CLASS_LEVERAGE, DEFAULT_RISK, LARGE_CAPS, MAX_RISK_PCT, capClass, type CapClass, type RiskConfig, type Tier } from '@bot/risk';
import {
  botClosedPnl, claimLiveOrder, closeBotPosition, setBotPositionPnl, loadContractSpecs, loadSnapshot, openBotPositions, openLiveOrders, registerBotPosition,
  saveSnapshot, updateBotPosition, updateLiveOrder,
  type Db, type LiveOrder, type SpecRow,
} from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';
import { planManagement } from './manage';

export interface ExecutorDeps {
  api: TradeApi;
  db: Db;
  log: Logger;
  live: WorkerConfig['live'];
  risk?: RiskConfig;
  /**
   * What may trade on the real account; defaults to LIVE_MODEL, which stays
   * 'none' until the holdout check passes and the owner approves (tests pass their own).
   */
  model?: BotModel;
}

/** The owner's per-strategy live switches (dashboard), stored as a snapshot; default: the target-1-ATR strategy only. */
export const LIVE_SLOTS_KEY = 'live-slots';
export type LiveSlots = Record<Tier, boolean>;

export async function loadLiveSlots(db: Db): Promise<LiveSlots> {
  return { ...DEFAULT_LIVE_SLOTS, ...((await loadSnapshot<Partial<LiveSlots>>(db, LIVE_SLOTS_KEY)) ?? {}) };
}

/** The plan a live position follows: its slot in the live model, else the old tier defaults (positions opened before the model). */
const livePlan = (model: BotModel, tier: Tier): TierPlan => {
  const p = botConfig(0, 0, model).tiers[tier];
  return p?.model === 'signal' ? p : DEFAULT_TIERS[tier];
};

/**
 * Live drawdown breaker (owner): when the bot's own equity falls
 * `drawdownPct` % below its peak, no new live entries for `pauseDays`; then
 * the peak resets at the resume. Open positions keep their stops and
 * targets. Same rule as the paper engine's circuitBreaker; adjustable from the
 * dashboard.
 *
 * The bot's equity counts only the bot's trades (owner, 2026-09-27: their own
 * trades tripped the breaker): the account's size when tracking began, plus
 * the results of the positions the bot opened (closed ones from position
 * history, open ones as they stand, net of fees). Deposits, withdrawals and
 * the owner's trades don't move it.
 */
export const LIVE_BREAKER_KEY = 'live-breaker';
/** Bot-only peak (the old 'live-peak' measured the whole account and is no longer read). */
export const LIVE_PEAK_KEY = 'live-bot-peak';
/** Where the bot's own equity curve starts: account equity less the bot's results when tracking began. */
export const LIVE_BOT_BASE_KEY = 'live-bot-base';
export interface LiveBreakerSettings { drawdownPct: number; pauseDays: number }
export const DEFAULT_LIVE_BREAKER: LiveBreakerSettings = { drawdownPct: 15, pauseDays: 7 };
export interface LivePeak { peak: number; trippedAt: number | null }

export async function loadLiveBreaker(db: Db): Promise<LiveBreakerSettings> {
  return { ...DEFAULT_LIVE_BREAKER, ...((await loadSnapshot<Partial<LiveBreakerSettings>>(db, LIVE_BREAKER_KEY)) ?? {}) };
}

/** Pure: the peak and breaker after seeing `equity` at `time`; `until` is when entries resume (null = not tripped). */
export function breakerStep(prev: LivePeak | null, equity: number, time: number, b: LiveBreakerSettings): LivePeak & { until: number | null; justTripped: boolean } {
  const pause = b.pauseDays * 86_400_000;
  if (prev?.trippedAt != null) {
    if (time < prev.trippedAt + pause) return { ...prev, until: prev.trippedAt + pause, justTripped: false };
    return { peak: equity, trippedAt: null, until: null, justTripped: false }; // resumed: the peak starts over
  }
  const peak = Math.max(prev?.peak ?? equity, equity);
  if (peak > 0 && equity <= peak * (1 - b.drawdownPct / 100)) return { peak, trippedAt: time, until: time + pause, justTripped: true };
  return { peak, trippedAt: null, until: null, justTripped: false };
}

/**
 * Leverage by coin size (owner, adjustable from the dashboard): the leverage
 * each size class gets, and which coins count as large caps. Mid = Bitunix
 * allows 50x or more on the pair; small = everything else. Always capped by
 * LIVE_LEVERAGE and the pair's own maximum.
 */
export const LIVE_LEVERAGE_KEY = 'live-leverage';
export interface LiveLeverageSettings { byClass: Record<CapClass, number>; largeCaps: string[] }
export const DEFAULT_LIVE_LEVERAGE: LiveLeverageSettings = { byClass: { ...CLASS_LEVERAGE }, largeCaps: [...LARGE_CAPS] };

export async function loadLiveLeverage(db: Db): Promise<LiveLeverageSettings> {
  const s = await loadSnapshot<Partial<LiveLeverageSettings>>(db, LIVE_LEVERAGE_KEY);
  return { byClass: { ...DEFAULT_LIVE_LEVERAGE.byClass, ...(s?.byClass ?? {}) }, largeCaps: s?.largeCaps ?? DEFAULT_LIVE_LEVERAGE.largeCaps };
}

/**
 * Live risk per trade for the named strategies (owner, 2026-09-27: 3%, so small
 * accounts clear the exchange's minimum order size), adjustable from the
 * dashboard within 0.5-5%. Paper keeps its own 1% (the forward test).
 */
export const LIVE_RISK_KEY = 'live-risk';
export const DEFAULT_LIVE_RISK_PCT = 3;
export async function loadLiveRiskPct(db: Db): Promise<number> {
  return (await loadSnapshot<{ riskPct: number }>(db, LIVE_RISK_KEY))?.riskPct ?? DEFAULT_LIVE_RISK_PCT;
}

/**
 * Most live trades open at once (owner, adjustable 1-20; default 3): the bot's
 * open positions plus its entries still waiting to fill, all strategies
 * together. The owner's own positions never count.
 */
export const LIVE_MAX_OPEN_KEY = 'live-max-open';
export const DEFAULT_LIVE_MAX_OPEN = 3;
export async function loadLiveMaxOpen(db: Db): Promise<number> {
  return (await loadSnapshot<{ maxOpen: number }>(db, LIVE_MAX_OPEN_KEY))?.maxOpen ?? DEFAULT_LIVE_MAX_OPEN;
}

export interface ExecutorSummary {
  equity: number;
  placed: number;
  skipped: number;
  reconciled: number;
  /** Management actions taken on the bot's open positions. */
  managed: number;
}

/** Deterministic and short: bot-<tier>-<placed minute, base 36>-<coin>. */
/** One letter per slot in order clientIds (P1H would clash with P4H's 'p'). */
const TIER_LETTER: Record<string, string> = { P1H: 'i' };
export function liveClientId(tier: string, symbol: string, placedAt: number): string {
  return `bot-${TIER_LETTER[tier] ?? tier.charAt(0).toLowerCase()}-${Math.floor(placedAt / 60_000).toString(36)}-${symbol.replace(/USDT$/, '').toLowerCase()}`;
}

/**
 * Owner (2026-09-28): coins with wide stops trade at 3-5x instead of being skipped. When the stop is too far for
 * the coin's class leverage (liquidation must sit at least twice as far as the stop), step down to the highest
 * leverage that is safe, never below MIN_STEP_DOWN_LEVERAGE (then planEntry skips it as before). Risk per trade is
 * unchanged: size comes from the stop; leverage only sets the margin and where liquidation sits.
 */
export const MIN_STEP_DOWN_LEVERAGE = 3;
export function safeLeverage(entry: number, stop: number, classLeverage: number): number {
  for (let l = Math.floor(classLeverage); l >= MIN_STEP_DOWN_LEVERAGE; l--) if (liquidationSafe(entry, stop, l)) return l;
  return classLeverage;
}

/** Account equity: free balance, margin in use and open profit or loss. */
export function accountEquity(a: Account): number {
  return a.available + (a.margin ?? 0) + (a.crossUnrealizedPnl ?? 0) + (a.isolationUnrealizedPnl ?? 0);
}

/** The owner's risk budget for one trade, in USDT: tier % of equity (never above 5%), capped so the position stays within `maxLeverage` x equity. */
export function riskBudget(
  equity: number, tier: Tier, entry: number, stop: number, maxLeverage: number, risk: RiskConfig = DEFAULT_RISK,
): number {
  const t = risk.tiers[tier];
  const byRisk = (equity * Math.min(t.riskPct, MAX_RISK_PCT)) / 100;
  const byLeverage = (maxLeverage * equity * Math.abs(entry - stop)) / entry;
  return Math.min(byRisk, byLeverage);
}

const toSpec = (s: SpecRow): ContractSpec => ({
  ...s,
  apiSupported: typeof s.raw.isApiSupported === 'boolean' ? s.raw.isApiSupported : null,
  status: s.raw.symbolStatus == null ? null : String(s.raw.symbolStatus),
});

const explainError = (err: unknown): { status: 'refused' | 'skipped' | 'unknown' | 'failed'; reason: string } => {
  if (err instanceof TradingDisabledError) return { status: 'refused', reason: 'live orders are off or halted' };
  if (err instanceof NotOwnedError) return { status: 'skipped', reason: err.message };
  if (err instanceof BitunixError && err.ambiguous) return { status: 'unknown', reason: `no clear reply (${err.message}); checked next step` };
  return { status: 'failed', reason: (err as Error).message };
};

/** Net result of an open position so far: open P&L plus what partial closes realized, less fees. */
export const openPositionPnl = (p: Position): number => (p.unrealizedPnl ?? 0) + (p.realizedPnl ?? 0) - Math.abs(p.fee ?? 0);

/** The bot's own result (USDT): its closed positions plus its open ones as they stand; records each open one's latest. */
async function botPnl(db: Db, positions: ReadonlyArray<Position>): Promise<number> {
  let total = await botClosedPnl(db);
  for (const m of await openBotPositions(db)) {
    const live = positions.find((p) => p.positionId === m.positionId);
    if (!live) continue; // closed since: recorded at the next management pass
    const pnl = openPositionPnl(live);
    await setBotPositionPnl(db, m.positionId, pnl);
    total += pnl;
  }
  return total;
}

export async function executorStep(
  deps: ExecutorDeps,
  input: { sessionId: number; result: BacktestResult; time: number; data?: Readonly<Record<string, SymbolData>> },
): Promise<ExecutorSummary> {
  const { api, db, log } = deps;
  const account = await api.account();
  const equity = accountEquity(account);
  const positions = await api.positions();
  const pending = await api.pendingOrders();
  const summary: ExecutorSummary = { equity, placed: 0, skipped: 0, reconciled: 0, managed: 0 };

  // 1. Reconcile.
  for (const o of await openLiveOrders(db)) {
    if (await reconcile(deps, o, input.time, positions, pending)) summary.reconciled++;
  }

  // 2. Manage the bot's open positions: partials, breakeven, trailing, cleanup (closed ones get their final result).
  summary.managed = await manageAll(deps, await api.positions(), await api.pendingOrders(), input.time, input.data);

  // The bot's own equity: where tracking began plus the bot's results. The owner's trades don't move it.
  const pnl = await botPnl(db, await api.positions());
  let base = (await loadSnapshot<{ equity: number }>(db, LIVE_BOT_BASE_KEY))?.equity;
  if (base == null) { base = equity - pnl; await saveSnapshot(db, LIVE_BOT_BASE_KEY, { equity: base }); }
  const botEquity = base + pnl;

  // The bot's equity at the start of the UTC day: the first step of each day records it.
  const day = Math.floor(input.time / 86_400_000);
  const stored = await loadSnapshot<{ day: number; equity: number }>(db, 'live-bot-day-start');
  let dayStartEquity = botEquity;
  if (stored?.day === day) dayStartEquity = stored.equity;
  else await saveSnapshot(db, 'live-bot-day-start', { day, equity: botEquity });

  // Drawdown breaker on the bot's own trades.
  const breaker = await loadLiveBreaker(db);
  const bs = breakerStep(await loadSnapshot<LivePeak>(db, LIVE_PEAK_KEY), botEquity, input.time, breaker);
  await saveSnapshot(db, LIVE_PEAK_KEY, { peak: bs.peak, trippedAt: bs.trippedAt });
  if (bs.justTripped) log.warn('live: drawdown breaker tripped', { botEquity, peak: bs.peak, drawdownPct: breaker.drawdownPct, until: new Date(bs.until!).toISOString() });
  const blocked = bs.until != null
    ? `drawdown breaker: the bot's trades are ${(((bs.peak - botEquity) / bs.peak) * 100).toFixed(1)}% below their peak $${bs.peak.toFixed(2)} (limit ${breaker.drawdownPct}%); no new live entries until ${new Date(bs.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;

  // 3. New intents: entries the strategy placed at this close.
  const fresh = input.result.open.pending.filter((p) => p.placedAt === input.time);
  const specs = await loadContractSpecs(db, [...new Set(fresh.map((p) => p.symbol))]);
  // Max open live trades: the bot's open positions plus its entries still in play.
  const mine = await api.ownedPositionIds();
  const open = { count: (await api.positions()).filter((x) => mine.has(x.positionId)).length + (await openLiveOrders(db)).length, max: await loadLiveMaxOpen(db) };
  for (const p of fresh) {
    const status = await place(deps, input.sessionId, p, equity, botEquity, dayStartEquity, specs.get(p.symbol), blocked, open);
    if (status === 'dry-run' || status === 'sent' || status === 'unknown') open.count++;
    if (status === 'dry-run' || status === 'sent') summary.placed++;
    else if (status) summary.skipped++;
  }
  log.info('live: step', { mode: api.mode, ...summary, equity: Number(equity.toFixed(2)), botEquity: Number(botEquity.toFixed(2)) });
  return summary;
}

async function place(
  deps: ExecutorDeps, sessionId: number, p: PendingView, equity: number, botEquity: number, dayStartEquity: number, spec: SpecRow | undefined,
  breakerBlock: string | null = null, open: { count: number; max: number } | null = null,
): Promise<string | null> {
  const { api, db, log, live } = deps;
  const clientId = liveClientId(p.tier, p.symbol, p.placedAt);
  const claimed = await claimLiveOrder(db, {
    clientId, sessionId, symbol: p.symbol, tier: p.tier, side: p.side,
    entry: p.entry, stop: p.stop, takeProfit: p.takeProfit, placedAt: p.placedAt, expiresAt: p.expiresAt,
  });
  if (!claimed) return null; // handled on an earlier run

  // Leverage by coin size (large caps 10x, mid 5x, small 3x), never above LIVE_LEVERAGE or the pair's own maximum; recorded on every decision.
  const levSet = await loadLiveLeverage(db);
  const cls = capClass(p.symbol, spec?.maxLeverage ?? null, levSet.largeCaps);
  const classLeverage = Math.min(levSet.byClass[cls], live.leverage, spec?.maxLeverage ?? Infinity);
  const leverage = safeLeverage(p.entry, p.stop, classLeverage);
  const done = async (status: Parameters<typeof updateLiveOrder>[2]['status'], extra: Omit<Parameters<typeof updateLiveOrder>[2], 'status'> = {}) => {
    await updateLiveOrder(db, clientId, { status, leverage, capClass: cls, ...extra });
    log.info(`live: ${status}`, { clientId, symbol: p.symbol, tier: p.tier, side: p.side, ...extra, request: undefined });
    return status;
  };

  // A slot the live model doesn't trade never trades live, whatever the paper session was started with
  // (LIVE_MODEL stays 'none' until the holdout check passes and the owner approves).
  const liveModel = deps.model ?? LIVE_MODEL;
  const slot = botConfig(0, 0, liveModel).tiers[p.tier];
  if (!slot?.enabled) return done('skipped', { reason: `${p.tier} is switched off for live trading in the code` });
  // The owner's per-strategy live switches (dashboard); only the default strategy is on unless switched on.
  if (slot.model === 'signal' && !(await loadLiveSlots(db))[p.tier]) {
    return done('skipped', { reason: `${slot.label ?? p.tier} is not switched on for live trading (dashboard)` });
  }

  if (breakerBlock) return done('skipped', { reason: breakerBlock });
  if (open && open.count >= open.max) return done('skipped', { reason: `max open live trades reached (${open.count} of ${open.max}; change it on the dashboard)` });

  const rules = spec ? rulesFromSpec(toSpec(spec)) : null;
  if (!rules) return done('skipped', { reason: 'no contract rules for this pair (or it refuses API trading)' });

  // Daily loss stop on the bot's own trades: down the tier's limit since the UTC day began.
  // A named strategy sizes by its own risk settings (the EMA 50 slots: 1% each, 8% daily loss), as in its backtest.
  let risk = deps.risk ?? (slot.model === 'signal' ? botConfig(0, 0, liveModel).risk : DEFAULT_RISK);
  if (!deps.risk && slot.model === 'signal') {
    const pct = await loadLiveRiskPct(db);
    risk = { ...risk, tiers: { ...risk.tiers, [p.tier]: { ...risk.tiers[p.tier], riskPct: pct } } };
  }
  const limitPct = risk.tiers[p.tier].dailyLossPct;
  if (dayStartEquity > 0 && dayStartEquity - botEquity >= (limitPct / 100) * dayStartEquity) {
    return done('skipped', { reason: `daily loss stop: the bot's trades are down ${(((dayStartEquity - botEquity) / dayStartEquity) * 100).toFixed(1)}% today (${p.tier} limit ${limitPct}%)` });
  }

  // The bot always trades at the leverage and margin mode it set itself. If it can't set them (the owner
  // trades this pair, so changing them would change the owner's position), it skips the trade.
  try {
    const current = await api.leverageMarginMode(p.symbol);
    if (current.marginMode !== live.marginMode) await api.setMarginMode(p.symbol, live.marginMode);
    if (current.leverage !== leverage) await api.setLeverage(p.symbol, leverage);
  } catch (err) {
    const e = explainError(err);
    const why = err instanceof NotOwnedError ? `can't set ${leverage}x ${live.marginMode.toLowerCase()} without changing your own trade (${err.message})` : e.reason;
    return done(e.status === 'unknown' ? 'failed' : e.status, { reason: `leverage setup: ${why}` });
  }

  const riskUsd = riskBudget(equity, p.tier, p.entry, p.stop, leverage, risk);
  const plan = planEntry({ symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, takeProfit: p.takeProfit, riskUsd, clientId, leverage }, rules);
  if (!plan.ok) return done('skipped', { reason: `${plan.reason} (risk budget $${riskUsd.toFixed(2)} on $${equity.toFixed(2)}, ${cls} cap ${leverage}x)` });

  try {
    const r = await api.placeOrder(plan.body);
    if (r.status === 'dry-run') return done('dry-run', { qty: plan.qty, riskUsd: plan.riskUsd, request: plan.body });
    return done('sent', { qty: plan.qty, riskUsd: plan.riskUsd, request: plan.body, orderId: r.data.orderId });
  } catch (err) {
    const e = explainError(err);
    return done(e.status, { reason: e.reason, qty: plan.qty, riskUsd: plan.riskUsd, request: plan.body });
  }
}

/** Returns true when the order's status changed. */
async function reconcile(
  deps: ExecutorDeps, o: LiveOrder, now: number,
  positions: ReadonlyArray<Position>, pending: ReadonlyArray<{ orderId: string; clientId: string | null; symbol: string }>,
): Promise<boolean> {
  const { api, db, log } = deps;
  const set = async (status: Parameters<typeof updateLiveOrder>[2]['status'], extra: Omit<Parameters<typeof updateLiveOrder>[2], 'status'> = {}) => {
    await updateLiveOrder(db, o.clientId, { status, ...extra });
    log.info(`live: ${status}`, { clientId: o.clientId, symbol: o.symbol, tier: o.tier, ...extra });
    return true;
  };
  const resting = pending.find((x) => x.clientId === o.clientId);

  switch (o.status) {
    case 'planning': // interrupted between claim and send: never sent by this code path's own record
      return set('failed', { reason: 'interrupted before sending; not retried' });
    case 'dry-run':
      return now >= o.expiresAt ? set('expired', { reason: 'entry window passed (dry run)' }) : false;
    case 'unknown':
      if (resting) return set('sent', { orderId: resting.orderId, reason: 'found on the book by clientId' });
      return now >= o.expiresAt ? set('gone', { reason: 'unclear reply and never seen on the book' }) : false;
    case 'sent': {
      if (resting) {
        if (now < o.expiresAt) return false;
        try {
          await api.cancelOrders(o.symbol, [{ clientId: o.clientId }]);
          return set('expired', { reason: 'entry window passed; cancelled' });
        } catch (err) {
          log.warn('live: cancel failed', { clientId: o.clientId, error: (err as Error).message });
          return false;
        }
      }
      // Left the book: filled (a new position of ours) or cancelled elsewhere.
      const owned = await api.ownedPositionIds();
      // Only a position that can be this order's fill: same coin and side, not already the bot's, opened after the
      // order was placed, and no bigger than the order. Anything else is the owner's and is never adopted.
      const candidates = positions.filter((x) => x.symbol === o.symbol && x.side === o.side && !owned.has(x.positionId)
        && (x.openedAt == null || x.openedAt >= o.placedAt - 60_000)
        && o.qty != null && x.qty <= o.qty * (1 + 1e-9));
      if (candidates.length === 1) {
        const c = candidates[0]!;
        await registerBotPosition(db, {
          positionId: c.positionId, symbol: o.symbol, side: o.side, clientId: o.clientId,
          tier: o.tier, entry: c.avgOpenPrice, initialStop: o.stop, takeProfit: o.takeProfit, qtyInitial: c.qty,
        });
        return set('filled', { positionId: candidates[0]!.positionId });
      }
      return set('gone', {
        reason: candidates.length ? 'filled, but more than one unowned position matches: left alone (not registered as the bot\'s)' : 'no longer on the book and no matching position (cancelled, or filled and already closed)',
      });
    }
    default:
      return false;
  }
}

/** clientId of a partial target: bot-t<n>-<end of the positionId>, at most 32 characters. */
export const partialClientId = (index: number, positionId: string) => `bot-t${index + 1}-${positionId.slice(-12)}`;

/** The latest confirmed swing on `tf` (low for a long, high for a short), only if a `tf` bar closed exactly at `time`. */
function trailSwing(data: Readonly<Record<string, SymbolData>> | undefined, symbol: string, tf: Tf, side: 'long' | 'short', time: number): { swing: number | null; close: number | null } {
  const candles = data?.[symbol]?.candles[tf];
  const ms = intervalMs(tf);
  if (!candles?.length || time % ms !== 0) return { swing: null, close: null };
  const i = barAt(candles, ms, time);
  if (i < 0 || candles[i]!.openTime + ms !== time) return { swing: null, close: null };
  const a = analyze(candles);
  const s = swingsKnownAt(a.long, i, side === 'long' ? 'low' : 'high').at(-1);
  return { swing: s?.price ?? null, close: candles[i]!.close };
}

/**
 * ATR-trail input at a close of the trail's timeframe: the best price since
 * entry (15m highs/lows from the fill on) and ATR on the bar that just
 * closed. Null when that timeframe didn't close at `time` or data is missing.
 */
function atrTrailInput(
  data: Readonly<Record<string, SymbolData>> | undefined, symbol: string, ch: NonNullable<TierPlan['chandelier']>,
  side: 'long' | 'short', openedAt: number, time: number,
): { extreme: number; atr: number; close: number } | null {
  const ms = intervalMs(ch.atrTf);
  const bars = data?.[symbol]?.candles[ch.atrTf];
  const q = data?.[symbol]?.candles['15m'];
  if (!bars?.length || !q?.length || time % ms !== 0) return null;
  const i = barAt(bars, ms, time);
  if (i < 0 || bars[i]!.openTime + ms !== time) return null;
  const a = atrWilder(bars, ch.atrLen)[i];
  if (a == null) return null;
  const since = q.filter((c) => c.openTime >= openedAt && c.openTime + intervalMs('15m') <= time);
  if (!since.length) return null;
  const extreme = side === 'long' ? Math.max(...since.map((c) => c.high)) : Math.min(...since.map((c) => c.low));
  return { extreme, atr: a, close: bars[i]!.close };
}

/** Best price since entry and the last close, from the 15m candles closed by `time` (for stop steps). */
function bestSinceEntry(
  data: Readonly<Record<string, SymbolData>> | undefined, symbol: string, side: 'long' | 'short', openedAt: number, time: number,
): { extreme: number; close: number } | null {
  const q = data?.[symbol]?.candles['15m'];
  const since = q?.filter((c) => c.openTime >= openedAt && c.openTime + intervalMs('15m') <= time) ?? [];
  if (!since.length) return null;
  return { extreme: side === 'long' ? Math.max(...since.map((c) => c.high)) : Math.min(...since.map((c) => c.low)), close: since[since.length - 1]!.close };
}

/** Applies the management plan to every open bot position. Returns how many actions were taken. */
async function manageAll(
  deps: ExecutorDeps, positions: ReadonlyArray<Position>, pending: ReadonlyArray<OpenOrder>, time: number,
  data: Readonly<Record<string, SymbolData>> | undefined,
): Promise<number> {
  const { api, db, log } = deps;
  const mine = await openBotPositions(db);
  if (!mine.length) return 0;
  const specs = await loadContractSpecs(db, [...new Set(mine.map((m) => m.symbol))]);
  let actions = 0;
  for (const m of mine) {
    const live = positions.find((p) => p.positionId === m.positionId);
    if (!live) {
      // Closed (stop, target, or by hand): record it with its final result and clear its leftover partial targets.
      const final = await api.closedPositionPnl(m.symbol, m.positionId).catch((err: Error) => {
        log.warn('live: closed position result not found; keeping the last one seen', { positionId: m.positionId, error: err.message });
        return null;
      });
      await closeBotPosition(db, m.positionId, final);
      const leftovers = pending.filter((o) => o.symbol === m.symbol && o.clientId?.endsWith(`-${m.positionId.slice(-12)}`) && o.clientId.startsWith('bot-t'));
      if (leftovers.length) {
        await api.cancelOrders(m.symbol, leftovers.map((o) => ({ clientId: o.clientId! })))
          .catch((err: Error) => log.warn('live: cancel leftovers failed', { positionId: m.positionId, error: err.message }));
      }
      log.info('live: position closed', { positionId: m.positionId, symbol: m.symbol, cancelled: leftovers.length, pnl: final });
      actions++;
      continue;
    }
    if (!m.tier || m.entry == null || m.initialStop == null || m.qtyInitial == null) continue; // registered before plans were stored
    const spec = specs.get(m.symbol);
    const rules = spec ? rulesFromSpec(toSpec(spec)) : null;
    if (!rules) continue;
    // A stop recorded as moved but not on the exchange (e.g. a move that didn't take): put it back first.
    if (m.stop != null && m.stop !== m.initialStop && api.mode === 'live') {
      const stops = (await api.pendingTpsl(m.symbol, m.positionId).catch(() => null))?.filter((t) => t.positionId === m.positionId && t.slPrice != null);
      const tick = 10 ** -rules.priceDecimals;
      const behind = stops && (!stops.length || stops.some((t) => (m.side === 'long' ? t.slPrice! < m.stop! - tick : t.slPrice! > m.stop! + tick)));
      if (behind && await moveStop(deps, m.symbol, m.positionId, m.side, m.stop, m.takeProfit, rules)) {
        actions++;
        log.info('live: stop restored on the exchange', { positionId: m.positionId, symbol: m.symbol, stop: m.stop, was: stops!.map((t) => t.slPrice) });
      }
    }
    const plan = livePlan(deps.model ?? LIVE_MODEL, m.tier);
    const trail = plan.trailTf ? trailSwing(data, m.symbol, plan.trailTf, m.side, time) : { swing: null, close: null };
    const atr = plan.chandelier ? atrTrailInput(data, m.symbol, plan.chandelier, m.side, m.openedAt, time) : null;
    const barsHeld = plan.timeStop && time % intervalMs(plan.timeStop.barTf) === 0 ? Math.floor((time - m.openedAt) / intervalMs(plan.timeStop.barTf)) : null;
    const best = plan.stopSteps ? bestSinceEntry(data, m.symbol, m.side, m.openedAt, time) : null;
    const todo = planManagement({
      pos: { side: m.side, entry: m.entry, initialStop: m.initialStop, qtyInitial: m.qtyInitial, stop: m.stop ?? m.initialStop, partialsPlaced: m.partialsPlaced },
      qtyNow: live.qty, plan, trailSwing: trail.swing, lastClose: atr?.close ?? trail.close,
      atrTrail: atr, barsHeld, best,
    });
    for (const a of todo) {
      if (a.kind === 'close') {
        try {
          await api.flashClose(m.positionId);
          actions++;
          log.info('live: closed at market (time stop)', { positionId: m.positionId, symbol: m.symbol, barsHeld });
        } catch (err) {
          log.warn('live: time-stop close failed', { positionId: m.positionId, error: (err as Error).message });
        }
        break;
      }
      if (a.kind === 'place-partials') {
        let ok = true;
        for (const t of a.targets) {
          const clientId = partialClientId(t.index, m.positionId);
          if (pending.some((o) => o.clientId === clientId)) continue; // already resting
          const plan = planTarget({ positionId: m.positionId, symbol: m.symbol, side: m.side }, t.price, t.qty, rules, clientId);
          if (!plan.ok) { log.warn('live: partial skipped', { positionId: m.positionId, reason: plan.reason }); continue; }
          try {
            await api.placeOrder(plan.body);
            actions++;
            log.info('live: partial placed', { positionId: m.positionId, symbol: m.symbol, price: plan.body.price, qty: plan.body.qty });
          } catch (err) {
            ok = false;
            log.warn('live: partial failed', { positionId: m.positionId, error: (err as Error).message });
          }
        }
        if (ok) await updateBotPosition(db, m.positionId, { partialsPlaced: true });
      } else {
        if (await moveStop(deps, m.symbol, m.positionId, m.side, a.stop, m.takeProfit, rules)) {
          await updateBotPosition(db, m.positionId, { stop: a.stop });
          actions++;
          log.info(`live: stop to ${a.why}`, { positionId: m.positionId, symbol: m.symbol, stop: a.stop });
        }
      }
    }
  }
  return actions;
}

/**
 * Moves the position's stop (MARK price), keeping its target. The entry order's attached stop lives as a
 * TP/SL order with quantities: modify that order; only when the position has no stop order at all, set a
 * position TP/SL. Then read the orders back: the move counts only when the exchange shows the new stop
 * (LIVE 2026-09-28: a position-TP/SL modify answered success and LINK's stop stayed at the old price).
 */
async function moveStop(
  deps: ExecutorDeps, symbol: string, positionId: string, side: 'long' | 'short', stop: number, takeProfit: number | null, rules: SymbolRules,
): Promise<boolean> {
  const { api, log } = deps;
  const d = rules.priceDecimals;
  const round = (x: number, down: boolean) => (down ? Math.floor(x * 10 ** d) : Math.ceil(x * 10 ** d)) / 10 ** d;
  // A long's stop rounds down, a short's up: never tighter than planned.
  const target = round(stop, side === 'long');
  const slPrice = fmt(target, d);
  const stopsOf = async () => (await api.pendingTpsl(symbol, positionId)).filter((t) => t.positionId === positionId && t.slPrice != null);
  try {
    const existing = await stopsOf();
    if (existing.length) {
      for (const t of existing) {
        await api.modifyTpsl(symbol, {
          orderId: t.id, slPrice, slStopType: 'MARK_PRICE',
          ...(t.slQty != null ? { slQty: fmt(t.slQty, rules.qtyDecimals) } : {}),
          ...(t.tpPrice != null ? { tpPrice: fmt(t.tpPrice, d), tpStopType: t.tpStopType === 'LAST_PRICE' ? 'LAST_PRICE' as const : 'MARK_PRICE' as const } : {}),
          ...(t.tpPrice != null && t.tpQty != null ? { tpQty: fmt(t.tpQty, rules.qtyDecimals) } : {}),
        });
      }
    } else {
      const body: PositionTpslBody = {
        symbol, positionId, slPrice, slStopType: 'MARK_PRICE',
        ...(takeProfit != null ? { tpPrice: fmt(round(takeProfit, side === 'long'), d), tpStopType: 'MARK_PRICE' as const } : {}),
      };
      try {
        await api.modifyPositionTpsl(body);
      } catch (err) {
        if (!(err instanceof BitunixError) || err.ambiguous) throw err;
        await api.placePositionTpsl(body);
      }
    }
    if (api.mode !== 'live') return true; // dry run: nothing was sent to read back
    const after = await stopsOf();
    const tick = 10 ** -d / 2;
    if (after.some((t) => Math.abs(t.slPrice! - target) <= tick)) return true;
    log.error('live: stop move not confirmed by the exchange; retried next step', { positionId, symbol, wanted: slPrice, found: after.map((t) => t.slPrice) });
    return false;
  } catch (err) {
    log.error('live: stop move failed', { positionId, error: (err as Error).message });
    return false;
  }
}
