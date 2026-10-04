// Shared live-account plumbing (used by the RSI live executor, rsiLive.ts): the order ledger's reconcile step,
// stop moves read back from the exchange, the bot's own equity and its drawdown breaker, leverage by coin size,
// and the max-open setting. The EMA strategies that first used it were removed (owner, 2026-10-04).
//
// Every intent is claimed in the ledger (live_orders) BEFORE anything is sent, keyed by a deterministic clientId,
// so a restart never sends it twice. Sending goes through the trade API: the gate (disabled / dry-run / live, plus
// the dashboard halt) and the ownership rules (the owner's positions and orders are never touched).

import {
  BitunixError, NotOwnedError, TradingDisabledError, fmt, liquidationSafe,
  type Account, type ContractSpec, type Position, type PositionTpslBody, type SymbolRules, type TradeApi,
} from '@bot/bitunix';
import { CLASS_LEVERAGE, LARGE_CAPS, type CapClass } from '@bot/risk';
import {
  botClosedPnl, closeBotPosition, setBotPositionPnl, loadSnapshot, openBotPositions, registerBotPosition,
  saveSnapshot, updateLiveOrder,
  type Db, type LiveOrder, type SpecRow,
} from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';

export interface ExecutorDeps {
  api: TradeApi;
  db: Db;
  log: Logger;
  live: WorkerConfig['live'];
}

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

/**
 * Owner (2026-10-02): a switch to trade through the breaker's pause. While on, a tripped breaker still tracks the
 * peak and the pause, but no longer blocks new live entries. Off by default; switch it off again to restore the pause.
 */
export const LIVE_BREAKER_OVERRIDE_KEY = 'live-breaker-override';
export async function loadBreakerOverride(db: Db): Promise<boolean> {
  return (await loadSnapshot<{ on: boolean }>(db, LIVE_BREAKER_OVERRIDE_KEY))?.on === true;
}

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
 * Most live trades open at once (owner, adjustable 1-20; default 3): the bot's
 * open positions plus its entries still waiting to fill, all strategies
 * together. The owner's own positions never count.
 */
export const LIVE_MAX_OPEN_KEY = 'live-max-open';
export const DEFAULT_LIVE_MAX_OPEN = 3;
export async function loadLiveMaxOpen(db: Db): Promise<number> {
  return (await loadSnapshot<{ maxOpen: number }>(db, LIVE_MAX_OPEN_KEY))?.maxOpen ?? DEFAULT_LIVE_MAX_OPEN;
}

/**
 * Owner (2026-09-28 / 2026-10-02): coins with wide stops trade at lower leverage instead of being skipped. When the
 * stop is too far for the coin's class leverage (liquidation must sit at least twice as far as the stop), step down
 * to the highest safe leverage, as far as 1x. Risk per trade is unchanged: size comes from the stop.
 */
export const MIN_STEP_DOWN_LEVERAGE = 1;
export function safeLeverage(entry: number, stop: number, classLeverage: number): number {
  for (let l = Math.floor(classLeverage); l >= MIN_STEP_DOWN_LEVERAGE; l--) if (liquidationSafe(entry, stop, l)) return l;
  return classLeverage;
}

/** Account equity: free balance, margin in use and open profit or loss. */
export function accountEquity(a: Account): number {
  return a.available + (a.margin ?? 0) + (a.crossUnrealizedPnl ?? 0) + (a.isolationUnrealizedPnl ?? 0);
}

/**
 * The bot's own equity (where tracking began plus the bot's results; the owner's trades and transfers don't move
 * it), its value at the start of the UTC day, and the drawdown breaker's verdict (`blocked` = why no new entries).
 */
export async function botState(deps: ExecutorDeps, equity: number, time: number): Promise<{ botEquity: number; dayStartEquity: number; blocked: string | null }> {
  const { api, db, log } = deps;
  const pnl = await botPnl(db, await api.positions());
  let base = (await loadSnapshot<{ equity: number }>(db, LIVE_BOT_BASE_KEY))?.equity;
  if (base == null) { base = equity - pnl; await saveSnapshot(db, LIVE_BOT_BASE_KEY, { equity: base }); }
  const botEquity = base + pnl;
  const day = Math.floor(time / 86_400_000);
  const stored = await loadSnapshot<{ day: number; equity: number }>(db, 'live-bot-day-start');
  let dayStartEquity = botEquity;
  if (stored?.day === day) dayStartEquity = stored.equity;
  else await saveSnapshot(db, 'live-bot-day-start', { day, equity: botEquity });
  const breaker = await loadLiveBreaker(db);
  const bs = breakerStep(await loadSnapshot<LivePeak>(db, LIVE_PEAK_KEY), botEquity, time, breaker);
  await saveSnapshot(db, LIVE_PEAK_KEY, { peak: bs.peak, trippedAt: bs.trippedAt });
  if (bs.justTripped) log.warn('live: drawdown breaker tripped', { botEquity, peak: bs.peak, drawdownPct: breaker.drawdownPct, until: new Date(bs.until!).toISOString() });
  const blocked = bs.until != null && !(await loadBreakerOverride(db))
    ? `drawdown breaker: the bot's trades are ${(((bs.peak - botEquity) / bs.peak) * 100).toFixed(1)}% below their peak $${bs.peak.toFixed(2)} (limit ${breaker.drawdownPct}%); no new live entries until ${new Date(bs.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
  return { botEquity, dayStartEquity, blocked };
}

/** A bot position no longer on the exchange: record its final result and clear leftover bot orders tied to it. */
export async function recordClosed(deps: ExecutorDeps, m: { positionId: string; symbol: string }): Promise<void> {
  const { api, db, log } = deps;
  const final = await api.closedPositionPnl(m.symbol, m.positionId).catch((err: Error) => {
    log.warn('live: closed position result not found; keeping the last one seen', { positionId: m.positionId, error: err.message });
    return null;
  });
  await closeBotPosition(db, m.positionId, final);
  log.info('live: position closed', { positionId: m.positionId, symbol: m.symbol, pnl: final });
}

export const toSpec = (s: SpecRow): ContractSpec => ({
  ...s,
  apiSupported: typeof s.raw.isApiSupported === 'boolean' ? s.raw.isApiSupported : null,
  status: s.raw.symbolStatus == null ? null : String(s.raw.symbolStatus),
});

export const explainError = (err: unknown): { status: 'refused' | 'skipped' | 'unknown' | 'failed'; reason: string } => {
  if (err instanceof TradingDisabledError) return { status: 'refused', reason: 'live orders are off or halted' };
  if (err instanceof NotOwnedError) return { status: 'skipped', reason: err.message };
  if (err instanceof BitunixError && err.ambiguous) return { status: 'unknown', reason: `no clear reply (${err.message}); checked next step` };
  return { status: 'failed', reason: (err as Error).message };
};

/** Net result of an open position so far: open P&L plus what partial closes realized, less fees. */
export const openPositionPnl = (p: Position): number => (p.unrealizedPnl ?? 0) + (p.realizedPnl ?? 0) - Math.abs(p.fee ?? 0);

/** The bot's own result (USDT): its closed positions plus its open ones as they stand; records each open one's latest. */
export async function botPnl(db: Db, positions: ReadonlyArray<Position>): Promise<number> {
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

/** Returns true when the order's status changed. */
export async function reconcile(
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
          tier: o.tier, entry: c.avgOpenPrice, initialStop: o.stop, takeProfit: o.takeProfit ?? undefined, qtyInitial: c.qty,
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

/**
 * Moves the position's stop (MARK price), keeping its target. The entry order's attached stop lives as a
 * TP/SL order with quantities: modify that order; only when the position has no stop order at all, set a
 * position TP/SL. Then read the orders back: the move counts only when the exchange shows the new stop
 * (LIVE 2026-09-28: a position-TP/SL modify answered success and LINK's stop stayed at the old price).
 */
export async function moveStop(
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
