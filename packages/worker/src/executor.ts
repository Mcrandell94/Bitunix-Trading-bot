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
// Daily loss stop on the real account: no new entries once equity is down the
// tier's limit (LTF 9%, MTF 15%) from the first step of the UTC day. It counts
// the whole account, so the owner's own losses count too (the safe side).
//
// Not yet: partial targets, breakeven and trailing on live positions (the
// attached stop and target protect them meanwhile).

import { DEFAULT_TIERS, type BacktestResult, type PendingView, type SymbolData, type Tf } from '@bot/backtest';
import { barAt, analyze, swingsKnownAt } from '@bot/smc';
import { intervalMs } from '@bot/marketdata';
import {
  BitunixError, NotOwnedError, TradingDisabledError, fmt, planEntry, planTarget, rulesFromSpec,
  type Account, type ContractSpec, type OpenOrder, type Position, type PositionTpslBody, type SymbolRules, type TradeApi,
} from '@bot/bitunix';
import { CLASS_LEVERAGE, DEFAULT_RISK, MAX_RISK_PCT, capClass, type RiskConfig, type Tier } from '@bot/risk';
import {
  claimLiveOrder, closeBotPosition, loadContractSpecs, loadSnapshot, openBotPositions, openLiveOrders, registerBotPosition,
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
export function liveClientId(tier: string, symbol: string, placedAt: number): string {
  return `bot-${tier.charAt(0).toLowerCase()}-${Math.floor(placedAt / 60_000).toString(36)}-${symbol.replace(/USDT$/, '').toLowerCase()}`;
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

  // 2. Manage the bot's open positions: partials, breakeven, trailing, cleanup.
  summary.managed = await manageAll(deps, await api.positions(), await api.pendingOrders(), input.time, input.data);

  // 3. New intents: entries the strategy placed at this close.
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
  const cls = capClass(p.symbol, spec?.maxLeverage ?? null);
  const leverage = Math.min(CLASS_LEVERAGE[cls], live.leverage, spec?.maxLeverage ?? Infinity);
  try {
    const current = await api.leverageMarginMode(p.symbol);
    if (current.marginMode !== live.marginMode) await api.setMarginMode(p.symbol, live.marginMode);
    if (current.leverage !== leverage) await api.setLeverage(p.symbol, leverage);
  } catch (err) {
    const e = explainError(err);
    const why = err instanceof NotOwnedError ? `can't set ${leverage}x ${live.marginMode.toLowerCase()} without changing your own trade (${err.message})` : e.reason;
    return done(e.status === 'unknown' ? 'failed' : e.status, { reason: `leverage setup: ${why}` });
  }

  const riskUsd = riskBudget(equity, p.tier, p.entry, p.stop, leverage, deps.risk);
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
      const candidates = positions.filter((x) => x.symbol === o.symbol && x.side === o.side && !owned.has(x.positionId));
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
      // Closed (stop, target, or by hand): record it and clear its leftover partial targets.
      await closeBotPosition(db, m.positionId);
      const leftovers = pending.filter((o) => o.symbol === m.symbol && o.clientId?.endsWith(`-${m.positionId.slice(-12)}`) && o.clientId.startsWith('bot-t'));
      if (leftovers.length) {
        await api.cancelOrders(m.symbol, leftovers.map((o) => ({ clientId: o.clientId! })))
          .catch((err: Error) => log.warn('live: cancel leftovers failed', { positionId: m.positionId, error: err.message }));
      }
      log.info('live: position closed', { positionId: m.positionId, symbol: m.symbol, cancelled: leftovers.length });
      actions++;
      continue;
    }
    if (!m.tier || m.entry == null || m.initialStop == null || m.qtyInitial == null) continue; // registered before plans were stored
    const spec = specs.get(m.symbol);
    const rules = spec ? rulesFromSpec(toSpec(spec)) : null;
    if (!rules) continue;
    const plan = DEFAULT_TIERS[m.tier];
    const trail = plan.trailTf ? trailSwing(data, m.symbol, plan.trailTf, m.side, time) : { swing: null, close: null };
    const todo = planManagement({
      pos: { side: m.side, entry: m.entry, initialStop: m.initialStop, qtyInitial: m.qtyInitial, stop: m.stop ?? m.initialStop, partialsPlaced: m.partialsPlaced },
      qtyNow: live.qty, plan, trailSwing: trail.swing, lastClose: trail.close,
    });
    for (const a of todo) {
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

/** Moves the position's stop (MARK price), keeping its target. Modifies the position TP/SL, or places one if there is none. */
async function moveStop(
  deps: ExecutorDeps, symbol: string, positionId: string, side: 'long' | 'short', stop: number, takeProfit: number | null, rules: SymbolRules,
): Promise<boolean> {
  const d = rules.priceDecimals;
  const round = (x: number, down: boolean) => (down ? Math.floor(x * 10 ** d) : Math.ceil(x * 10 ** d)) / 10 ** d;
  const body: PositionTpslBody = {
    symbol, positionId,
    // A long's stop rounds down, a short's up: never tighter than planned.
    slPrice: fmt(round(stop, side === 'long'), d), slStopType: 'MARK_PRICE',
    ...(takeProfit != null ? { tpPrice: fmt(round(takeProfit, side === 'long'), d), tpStopType: 'MARK_PRICE' as const } : {}),
  };
  try {
    await deps.api.modifyPositionTpsl(body);
    return true;
  } catch (err) {
    if (err instanceof BitunixError && !err.ambiguous) {
      try {
        await deps.api.placePositionTpsl(body);
        return true;
      } catch (err2) {
        deps.log.error('live: stop move failed', { positionId, error: (err2 as Error).message });
        return false;
      }
    }
    deps.log.error('live: stop move failed', { positionId, error: (err as Error).message });
    return false;
  }
}
