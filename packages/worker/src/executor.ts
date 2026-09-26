// Live executor: follows the paper replay's decisions onto the real account.
//
// Each 15-minute step, after the paper replay:
//  1. Reconcile what it placed before: an entry still resting past its expiry
//     is cancelled; one that left the book became a position (registered as
//     the bot's) or was cancelled elsewhere; an unclear reply is looked up by
//     clientId.
//  2. Every entry the strategy placed at this close becomes a live intent,
//     sized from the REAL account: the owner's risk per tier (1% / 2%, never
//     above 3%) of equity at the stop, capped at 3x effective leverage, then
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
// Daily loss stop on the real account: no new entries once equity is down the
// tier's limit (LTF 4%, MTF 8%) from the first step of the UTC day. It counts
// the whole account, so the owner's own losses count too (the safe side).
//
// Not yet: partial targets, breakeven and trailing on live positions (the
// attached stop and target protect them meanwhile).

import type { BacktestResult, PendingView } from '@bot/backtest';
import {
  BitunixError, NotOwnedError, TradingDisabledError, planEntry, rulesFromSpec,
  type Account, type ContractSpec, type Position, type TradeApi,
} from '@bot/bitunix';
import { DEFAULT_RISK, MAX_RISK_PCT, type RiskConfig } from '@bot/risk';
import {
  claimLiveOrder, loadContractSpecs, loadSnapshot, openLiveOrders, registerBotPosition, saveSnapshot, updateLiveOrder,
  type Db, type LiveOrder, type SpecRow,
} from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';

export interface ExecutorDeps {
  api: TradeApi;
  db: Db;
  log: Logger;
  live: WorkerConfig['live'];
  risk?: RiskConfig;
}

export interface ExecutorSummary {
  equity: number;
  placed: number;
  skipped: number;
  reconciled: number;
}

/** Deterministic and short: bot-<tier>-<placed minute, base 36>-<coin>. */
export function liveClientId(tier: string, symbol: string, placedAt: number): string {
  return `bot-${tier.charAt(0).toLowerCase()}-${Math.floor(placedAt / 60_000).toString(36)}-${symbol.replace(/USDT$/, '').toLowerCase()}`;
}

/** Account equity: free balance, margin in use and open profit or loss. */
export function accountEquity(a: Account): number {
  return a.available + (a.margin ?? 0) + (a.crossUnrealizedPnl ?? 0) + (a.isolationUnrealizedPnl ?? 0);
}

/** The owner's risk budget for one trade, in USDT: tier % of equity (never above 3%), capped by effective leverage. */
export function riskBudget(equity: number, tier: 'LTF' | 'MTF', entry: number, stop: number, risk: RiskConfig = DEFAULT_RISK): number {
  const t = risk.tiers[tier];
  const byRisk = (equity * Math.min(t.riskPct, MAX_RISK_PCT)) / 100;
  const byLeverage = (t.maxEffectiveLeverage * equity * Math.abs(entry - stop)) / entry;
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

export async function executorStep(deps: ExecutorDeps, input: { sessionId: number; result: BacktestResult; time: number }): Promise<ExecutorSummary> {
  const { api, db, log } = deps;
  const account = await api.account();
  const equity = accountEquity(account);
  const positions = await api.positions();
  const pending = await api.pendingOrders();
  const summary: ExecutorSummary = { equity, placed: 0, skipped: 0, reconciled: 0 };

  // Equity at the start of the UTC day: the first step of each day records it.
  const day = Math.floor(input.time / 86_400_000);
  const stored = await loadSnapshot<{ day: number; equity: number }>(db, 'live-day-start');
  let dayStartEquity = equity;
  if (stored?.day === day) dayStartEquity = stored.equity;
  else await saveSnapshot(db, 'live-day-start', { day, equity });

  // 1. Reconcile.
  for (const o of await openLiveOrders(db)) {
    if (await reconcile(deps, o, input.time, positions, pending)) summary.reconciled++;
  }

  // 2. New intents: entries the strategy placed at this close.
  const fresh = input.result.open.pending.filter((p) => p.placedAt === input.time);
  const specs = await loadContractSpecs(db, [...new Set(fresh.map((p) => p.symbol))]);
  for (const p of fresh) {
    const status = await place(deps, input.sessionId, p, equity, dayStartEquity, specs.get(p.symbol));
    if (status === 'dry-run' || status === 'sent') summary.placed++;
    else if (status) summary.skipped++;
  }
  log.info('live: step', { mode: api.mode, ...summary, equity: Number(equity.toFixed(2)) });
  return summary;
}

async function place(
  deps: ExecutorDeps, sessionId: number, p: PendingView, equity: number, dayStartEquity: number, spec: SpecRow | undefined,
): Promise<string | null> {
  const { api, db, log, live } = deps;
  const clientId = liveClientId(p.tier, p.symbol, p.placedAt);
  const claimed = await claimLiveOrder(db, {
    clientId, sessionId, symbol: p.symbol, tier: p.tier, side: p.side,
    entry: p.entry, stop: p.stop, takeProfit: p.takeProfit, placedAt: p.placedAt, expiresAt: p.expiresAt,
  });
  if (!claimed) return null; // handled on an earlier run

  const done = async (status: Parameters<typeof updateLiveOrder>[2]['status'], extra: Omit<Parameters<typeof updateLiveOrder>[2], 'status'> = {}) => {
    await updateLiveOrder(db, clientId, { status, ...extra });
    log.info(`live: ${status}`, { clientId, symbol: p.symbol, tier: p.tier, side: p.side, ...extra, request: undefined });
    return status;
  };

  const rules = spec ? rulesFromSpec(toSpec(spec)) : null;
  if (!rules) return done('skipped', { reason: 'no contract rules for this pair (or it refuses API trading)' });

  // Daily loss stop on the real account: equity down the tier's limit since the UTC day began.
  const limitPct = (deps.risk ?? DEFAULT_RISK).tiers[p.tier].dailyLossPct;
  if (dayStartEquity > 0 && dayStartEquity - equity >= (limitPct / 100) * dayStartEquity) {
    return done('skipped', { reason: `daily loss stop: account down ${(((dayStartEquity - equity) / dayStartEquity) * 100).toFixed(1)}% today (${p.tier} limit ${limitPct}%)` });
  }

  // The bot always trades at the leverage and margin mode it set itself. If it can't set them (the owner
  // trades this pair, so changing them would change the owner's position), it skips the trade.
  const leverage = live.leverage;
  try {
    const current = await api.leverageMarginMode(p.symbol);
    if (current.marginMode !== live.marginMode) await api.setMarginMode(p.symbol, live.marginMode);
    if (current.leverage !== live.leverage) await api.setLeverage(p.symbol, live.leverage);
  } catch (err) {
    const e = explainError(err);
    const why = err instanceof NotOwnedError ? `can't set ${live.leverage}x ${live.marginMode.toLowerCase()} without changing your own trade (${err.message})` : e.reason;
    return done(e.status === 'unknown' ? 'failed' : e.status, { reason: `leverage setup: ${why}` });
  }

  const riskUsd = riskBudget(equity, p.tier, p.entry, p.stop, deps.risk);
  const plan = planEntry({ symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, takeProfit: p.takeProfit, riskUsd, clientId, leverage }, rules);
  if (!plan.ok) return done('skipped', { reason: `${plan.reason} (risk budget $${riskUsd.toFixed(2)} on $${equity.toFixed(2)})` });

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
      const candidates = positions.filter((x) => x.symbol === o.symbol && x.side === o.side && !owned.has(x.positionId));
      if (candidates.length === 1) {
        await registerBotPosition(db, { positionId: candidates[0]!.positionId, symbol: o.symbol, side: o.side, clientId: o.clientId });
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
