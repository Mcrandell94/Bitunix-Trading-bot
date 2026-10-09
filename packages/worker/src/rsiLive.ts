// RSI framework live trading (owner, 2026-10-04: "move rsi framework into the dashboard with signal list with
// toggles to turn on live trading"). The only strategy that trades the real account.
//
// Each model has its own switch on the dashboard: live on / off (off by default). Every model follows rule set
// option 1 and its one exit, without a time limit (owner 2026-10-09; SIGNAL_EXITS in @bot/backtest). Risk per trade:
// 2% of the account at the stop (owner, 2026-10-04), adjustable on the dashboard (0.5-5%).
//
// After each 4H close, once the signal refresh (rsiSignals.ts) has run on that close:
//  1. Reconcile the ledger: an entry that left the book became a bot position (registered with its RSI tag) or
//     was cancelled elsewhere.
//  2. Manage each open RSI position by following its own signal row, recomputed on closed bars by the same code
//     that backtested it: when the row's stop moved (breakeven at +2R, ATR trail) the exchange stop moves with it
//     (never loosened); when the row closed (time exit, or a stop / target the exchange hasn't filled yet on its
//     mark price), the position is closed at market. Stop and target ride on the order itself from the start.
//  3. New entries: every row that says "enter at the next open" for a model switched on is sent as a market order
//     with its stop (and target, if the exit has one) attached. Only on a
//     fresh snapshot (this close, within ENTRY_WINDOW_MS): a missed close is never chased later.
//
// Safety, as for every live order: the ledger claims each order before sending (deterministic clientId, so a
// restart never sends twice); the trade API's gate (Railway TRADING_ENABLED / LIVE_DRY_RUN, plus the dashboard
// halt) and ownership rules (the owner's positions and orders are never touched, and the bot never adds to a
// coin and side the owner holds); the drawdown breaker, the daily loss stop, max open trades and leverage by coin
// size. One bot position per coin and side: hedge mode would merge a second one into the first.
//
// Positions the removed EMA strategies opened carry an EMA tier name: they keep their exchange stop and target,
// and are only recorded when they close (owner, 2026-10-04: "let them run").

import { RSI_MODELS, RULE_PLANS, isSignalRow, type RsiModelId, type RsiSignalRow, type RulePlan } from '@bot/backtest';
import { NotOwnedError, fmt, liquidationSafe, rulesFromSpec, type PlaceOrderBody, type SymbolRules } from '@bot/bitunix';
import { capClass } from '@bot/risk';
import {
  claimLiveOrder, loadContractSpecs, loadControls, loadSnapshot, openBotPositions, openLiveOrders, updateBotPosition, updateLiveOrder,
  type Db,
} from '@bot/store';
import {
  accountEquity, botState, explainError, loadLiveLeverage, loadLiveMaxOpen, moveStop, reconcile, recordClosed, safeLeverage, toSpec,
  type ExecutorDeps,
} from './executor';
import { RSI10_MODEL, type RsiSignalsSnapshot } from './rsiSignals';

const H4 = 4 * 3_600_000;

/**
 * The models that may trade live (dropped models never do). A function, not a constant: the backtest package
 * imports the worker for its coin list, so nothing here may read @bot/backtest while modules load.
 */
export const liveRsiModels = (): RsiModelId[] => (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped);

export interface RsiModelLive { on: boolean }
export type RsiLiveSettings = Record<RsiModelId, RsiModelLive>;
export const RSI_LIVE_KEY = 'rsi-live';
export const DEFAULT_RSI_MODEL_LIVE: RsiModelLive = { on: false };

/**
 * Owner 2026-10-04: "bring all the defaults to on, all RSI models at their optimal setting from testing": every live
 * model on (its rule set and exit were picked here too until 2026-10-09; now each model has one of each). Applied once
 * at startup (OPTIMAL_PRESET_ID) through the dashboard controls; later dashboard changes stay.
 */
export const OPTIMAL_RSI_LIVE: Partial<Record<RsiModelId, RsiModelLive>> = {
  'bottom-div': { on: true }, 'triple-div': { on: true }, 'under-floor': { on: true }, 'w-bear-div': { on: true },
  'w-top-div': { on: true }, 'w-dbl-bottom': { on: true }, 'd-fail-short': { on: true }, '4h-fail-short': { on: true },
};
/** The MACD divergence boost at its recommended setting (docs/RESULTS.md "MACD divergence boost vs filter"). */
export const OPTIMAL_DIV_BOOST = 1.5;
export const OPTIMAL_PRESET_ID = '2026-10-04-rsi-optimal-on';
export const PRESETS_KEY = 'owner-presets-applied';

export async function loadRsiLive(db: Db): Promise<RsiLiveSettings> {
  const s = (await loadSnapshot<Partial<Record<RsiModelId, Partial<RsiModelLive>>>>(db, RSI_LIVE_KEY)) ?? {};
  return Object.fromEntries((Object.keys(RSI_MODELS) as RsiModelId[]).map((m) => {
    // Settings saved before 2026-10-09 also hold a rule set and an exit; both are gone (one of each per model).
    return [m, { on: s[m]?.on === true && !RSI_MODELS[m].dropped }];
  })) as RsiLiveSettings;
}

/** Risk per live RSI trade, % of the account at the stop (owner, 2026-10-04: 1%, then "adjust minimum risk to 2%"). */
export const RSI_RISK_KEY = 'rsi-live-risk';
export const DEFAULT_RSI_RISK_PCT = 2;
/** One-time preset that sets the live risk to 2% (owner 2026-10-04), applied after the optimal-settings preset. */
export const RISK_PRESET_ID = '2026-10-04-rsi-risk-2';
export async function loadRsiRiskPct(db: Db): Promise<number> {
  return (await loadSnapshot<{ riskPct: number }>(db, RSI_RISK_KEY))?.riskPct ?? DEFAULT_RSI_RISK_PCT;
}

/**
 * Risk multiple on signals with a daily MACD divergence (owner 2026-10-04; docs/RESULTS.md "MACD divergence boost":
 * 1.5x-2x raised total R on both coin sets). 1 = off (the default); 1.5 or 2. Never above 5% of the account.
 */
export const DIV_BOOST_KEY = 'rsi-div-boost';
export const DIV_BOOSTS = [1, 1.5, 2] as const;
export async function loadDivBoost(db: Db): Promise<number> {
  const m = (await loadSnapshot<{ mult: number }>(db, DIV_BOOST_KEY))?.mult;
  return m != null && (DIV_BOOSTS as readonly number[]).includes(m) ? m : 1;
}

/** No new entries once the bot's own trades are down this much since the UTC day began. */
export const DAILY_LOSS_PCT = 8;
/** Entries go out only this soon after the close that triggered them. */
export const ENTRY_WINDOW_MS = 30 * 60_000;
/** The same for 15M-RSI10: its entry is the next 15m open, so only a refresh of the 15m bar that just closed counts. */
export const FAST_ENTRY_WINDOW_MS = 15 * 60_000;
/** A market entry still on the book after this long is cancelled at the next step. */
const ENTRY_EXPIRY_MS = 15 * 60_000;

/** Ledger tag of an RSI trade: which model, exit, rule set and signal it follows. */
export const rsiTag = (r: { model: RsiModelId; variant: 0 | 1; signalAt: number }, plan: RulePlan) => `rsi|${r.model}|${r.variant}|${plan}|${r.signalAt}`;
export function parseRsiTag(tag: string | null): { model: RsiModelId; variant: 0 | 1; plan: RulePlan; signalAt: number } | null {
  const p = tag?.split('|');
  if (!p || p.length !== 5 || p[0] !== 'rsi' || !(p[1]! in RSI_MODELS) || !RULE_PLANS.includes(p[3] as RulePlan)) return null;
  return { model: p[1] as RsiModelId, variant: p[2] === '1' ? 1 : 0, plan: p[3] as RulePlan, signalAt: Number(p[4]) };
}

/** Deterministic and at most 32 characters: bot-r<model><exit>-<signal minute, base 36>-<coin>. */
export function rsiClientId(model: RsiModelId, variant: 0 | 1, symbol: string, signalAt: number): string {
  const code = (Object.keys(RSI_MODELS) as RsiModelId[]).indexOf(model).toString(36);
  return `bot-r${code}${variant}-${Math.floor(signalAt / 60_000).toString(36)}-${symbol.replace(/USDT$/, '').toLowerCase()}`.slice(0, 32);
}

/** The row an RSI position follows in the latest snapshot. */
export const rowFor = (rows: ReadonlyArray<RsiSignalRow>, symbol: string, tag: NonNullable<ReturnType<typeof parseRsiTag>>) =>
  rows.find((r) => r.symbol === symbol && r.model === tag.model && r.variant === tag.variant && r.signalAt === tag.signalAt && r.plans.includes(tag.plan));

/** Market entry with the stop (and target, when the exit has one) attached; null with the reason when it can't be sized. */
export function planMarketEntry(
  o: { symbol: string; side: 'long' | 'short'; entry: number; stop: number; target: number | null; riskUsd: number; leverage: number; clientId: string },
  rules: SymbolRules,
): { ok: true; qty: number; riskUsd: number; body: PlaceOrderBody } | { ok: false; reason: string } {
  const long = o.side === 'long', d = rules.priceDecimals;
  const down = (x: number, n: number) => Math.floor(x * 10 ** n + 1e-9) / 10 ** n, up = (x: number, n: number) => Math.ceil(x * 10 ** n - 1e-9) / 10 ** n;
  const stop = long ? down(o.stop, d) : up(o.stop, d);
  if (!(long ? stop < o.entry : stop > o.entry)) return { ok: false, reason: `stop ${stop} is on the wrong side of the price ${o.entry}` };
  const target = o.target == null ? null : long ? down(o.target, d) : up(o.target, d);
  if (target != null && !(long ? target > o.entry : target < o.entry)) return { ok: false, reason: `target ${target} is already passed (price ${o.entry})` };
  if (rules.maxLeverage != null && o.leverage > rules.maxLeverage) return { ok: false, reason: `leverage ${o.leverage} is above the pair's max ${rules.maxLeverage}` };
  if (!liquidationSafe(o.entry, stop, o.leverage)) return { ok: false, reason: `stop is too far for ${o.leverage}x isolated margin (liquidation could come first)` };
  if (!(o.riskUsd > 0)) return { ok: false, reason: 'risk must be positive' };
  const qty = down(o.riskUsd / Math.abs(o.entry - stop), rules.qtyDecimals);
  if (qty < rules.minQty) return { ok: false, reason: `size ${qty} is below the pair's minimum ${rules.minQty}` };
  return {
    ok: true, qty, riskUsd: qty * Math.abs(o.entry - stop),
    body: {
      symbol: o.symbol, side: long ? 'BUY' : 'SELL', tradeSide: 'OPEN', orderType: 'MARKET', qty: fmt(qty, rules.qtyDecimals), clientId: o.clientId,
      slPrice: fmt(stop, d), slStopType: 'MARK_PRICE', slOrderType: 'MARKET',
      ...(target != null ? { tpPrice: fmt(target, d), tpStopType: 'MARK_PRICE' as const, tpOrderType: 'MARKET' as const } : {}),
    },
  };
}

export interface RsiLiveSummary { equity: number; placed: number; skipped: number; reconciled: number; managed: number }

/**
 * One live step. `snapshot` = the latest signal refresh; `entries` = whether this step may open trades (only right
 * after a 4H close's refresh). Management and reconciling run on every step.
 */
export async function rsiLiveStep(deps: ExecutorDeps, input: { now: number; snapshot: RsiSignalsSnapshot | null; entries: boolean }): Promise<RsiLiveSummary> {
  const { api, db, log } = deps;
  const equity = accountEquity(await api.account());
  const summary: RsiLiveSummary = { equity, placed: 0, skipped: 0, reconciled: 0, managed: 0 };

  // 1. Reconcile the ledger.
  const positions0 = await api.positions(), pending0 = await api.pendingOrders();
  for (const o of await openLiveOrders(db)) if (await reconcile(deps, o, input.now, positions0, pending0)) summary.reconciled++;

  // 2. Manage the bot's positions.
  const positions = await api.positions();
  const mine = await openBotPositions(db);
  const specs = await loadContractSpecs(db, [...new Set(mine.map((m) => m.symbol))]);
  const snap = input.snapshot;
  for (const m of mine) {
    const live = positions.find((p) => p.positionId === m.positionId);
    if (!live) { await recordClosed(deps, m); summary.managed++; continue; }
    const tag = parseRsiTag(m.tier);
    if (!tag || !snap || m.entry == null || m.initialStop == null) continue; // an EMA position: its exchange stop and target stay
    const row = rowFor(snap.rows, m.symbol, tag);
    if (!row) { log.warn('live: rsi position has no signal row; it keeps its exchange stop and target', { positionId: m.positionId, symbol: m.symbol, tag: m.tier }); continue; }
    if (row.status === 'closed') {
      try {
        await api.flashClose(m.positionId);
        summary.managed++;
        log.info('live: rsi position closed at market (its signal closed)', { positionId: m.positionId, symbol: m.symbol, model: tag.model, exit: row.exit });
      } catch (err) {
        log.warn('live: rsi close failed', { positionId: m.positionId, error: (err as Error).message });
      }
      continue;
    }
    if (row.status !== 'open' || row.stop == null || row.entry == null) continue;
    const spec = specs.get(m.symbol), rules = spec ? rulesFromSpec(toSpec(spec)) : null;
    if (!rules) continue;
    // Breakeven in the signal means the signal's own entry: use the live fill instead.
    const want = Math.abs(row.stop - row.entry) <= 1e-12 * Math.max(1, Math.abs(row.entry)) ? m.entry : row.stop;
    const now = m.stop ?? m.initialStop, tick = 10 ** -rules.priceDecimals;
    const tighter = m.side === 'long' ? want > now + tick : want < now - tick;
    const valid = m.side === 'long' ? want < row.lastPrice : want > row.lastPrice; // never a stop the price has already passed
    if (!tighter || !valid) continue;
    if (await moveStop(deps, m.symbol, m.positionId, m.side, want, m.takeProfit, rules)) {
      await updateBotPosition(db, m.positionId, { stop: want });
      summary.managed++;
      log.info('live: rsi stop moved with its signal', { positionId: m.positionId, symbol: m.symbol, model: tag.model, stop: want });
    }
  }

  // The bot's own equity, day start and breaker: tracked every step.
  const state = await botState(deps, equity, input.now);

  // 3. New entries.
  // The framework's rows only right after a 4H close's refresh; 15M-RSI10's only right after a 15m close's refresh.
  const slowOk = !!snap && input.now - snap.time <= ENTRY_WINDOW_MS && snap.time % H4 === 0;
  const fastOk = !!snap && snap.fastTime != null && input.now - snap.fastTime <= FAST_ENTRY_WINDOW_MS;
  if (!input.entries || !snap || (!slowOk && !fastOk)) {
    log.info('live: rsi step', { mode: api.mode, ...summary, equity: Number(equity.toFixed(2)) });
    return summary;
  }
  const settings = await loadRsiLive(db);
  const todo = snap.rows.flatMap((r) => {
    const s = settings[r.model];
    if (!(r.model === RSI10_MODEL ? fastOk : slowOk)) return [];
    return r.status === 'enter' && s.on && isSignalRow(r) ? [{ row: r, plan: 'option 1' as const }] : [];
  });
  if (todo.length) {
    const riskPct = await loadRsiRiskPct(db), boost = await loadDivBoost(db);
    const paused = (await loadControls(db)).pauses.some((p) => p.scope === 'ALL' && p.pausedAt <= input.now && (p.resumedAt == null || input.now < p.resumedAt));
    const owned = await api.ownedPositionIds();
    const openPos = (await api.positions()).filter((x) => owned.has(x.positionId));
    const openOrders = await openLiveOrders(db);
    const busy = new Set([...openPos.map((p) => `${p.symbol}|${p.side}`), ...openOrders.map((o) => `${o.symbol}|${o.side}`)]);
    const open = { count: openPos.length + openOrders.length, max: await loadLiveMaxOpen(db) };
    const rulesBy = await loadContractSpecs(db, [...new Set(todo.map((t) => t.row.symbol))]);
    for (const { row, plan } of todo) {
      const status = await place(deps, row, plan, { equity, riskPct: riskPct * (row.macdDiv ? boost : 1), paused, busy, open, state, spec: rulesBy.get(row.symbol), now: input.now });
      if (status === 'dry-run' || status === 'sent' || status === 'unknown') { open.count++; busy.add(`${row.symbol}|${row.side}`); }
      if (status === 'dry-run' || status === 'sent') summary.placed++;
      else if (status) summary.skipped++;
    }
  }
  log.info('live: rsi step', { mode: api.mode, ...summary, equity: Number(equity.toFixed(2)) });
  return summary;
}

async function place(
  deps: ExecutorDeps, row: RsiSignalRow, plan: RulePlan,
  ctx: {
    equity: number; riskPct: number; paused: boolean; busy: Set<string>; open: { count: number; max: number };
    state: Awaited<ReturnType<typeof botState>>; spec: Parameters<typeof toSpec>[0] | undefined; now: number;
  },
): Promise<string | null> {
  const { api, db, log, live } = deps;
  if (row.entry == null || row.stop == null) return null;
  const clientId = rsiClientId(row.model, row.variant, row.symbol, row.signalAt);
  const claimed = await claimLiveOrder(db, {
    clientId, sessionId: null, symbol: row.symbol, tier: rsiTag(row, plan), side: row.side,
    entry: row.entry, stop: row.stop, takeProfit: row.target, placedAt: ctx.now, expiresAt: ctx.now + ENTRY_EXPIRY_MS,
  });
  if (!claimed) return null; // handled on an earlier run

  const levSet = await loadLiveLeverage(db);
  const cls = capClass(row.symbol, ctx.spec?.maxLeverage ?? null, levSet.largeCaps);
  const classLeverage = Math.min(levSet.byClass[cls], live.leverage, ctx.spec?.maxLeverage ?? Infinity);
  const leverage = safeLeverage(row.entry, row.stop, classLeverage);
  const name = `${RSI_MODELS[row.model].label} (${row.exitName})`;
  const done = async (status: Parameters<typeof updateLiveOrder>[2]['status'], extra: Omit<Parameters<typeof updateLiveOrder>[2], 'status'> = {}) => {
    await updateLiveOrder(db, clientId, { status, leverage, capClass: cls, ...extra });
    log.info(`live: ${status}`, { clientId, symbol: row.symbol, model: row.model, side: row.side, ...extra, request: undefined });
    return status;
  };

  if (ctx.paused) return done('skipped', { reason: 'entries paused from the dashboard (trading off)' });
  if (ctx.state.blocked) return done('skipped', { reason: ctx.state.blocked });
  if (ctx.busy.has(`${row.symbol}|${row.side}`)) return done('skipped', { reason: `the bot already has a ${row.side} on ${row.symbol} (one per coin and side)` });
  if (ctx.open.count >= ctx.open.max) return done('skipped', { reason: `max open live trades reached (${ctx.open.count} of ${ctx.open.max}; change it on the dashboard)` });
  const { botEquity, dayStartEquity } = ctx.state;
  if (dayStartEquity > 0 && dayStartEquity - botEquity >= (DAILY_LOSS_PCT / 100) * dayStartEquity) {
    return done('skipped', { reason: `daily loss stop: the bot's trades are down ${(((dayStartEquity - botEquity) / dayStartEquity) * 100).toFixed(1)}% today (limit ${DAILY_LOSS_PCT}%)` });
  }
  const rules = ctx.spec ? rulesFromSpec(toSpec(ctx.spec)) : null;
  if (!rules) return done('skipped', { reason: 'no contract rules for this pair (or it refuses API trading)' });

  // The bot trades at the leverage and margin mode it set itself; if that would change the owner's trade, skip.
  try {
    const current = await api.leverageMarginMode(row.symbol);
    if (current.marginMode !== live.marginMode) await api.setMarginMode(row.symbol, live.marginMode);
    if (current.leverage !== leverage) await api.setLeverage(row.symbol, leverage);
  } catch (err) {
    const e = explainError(err);
    const why = err instanceof NotOwnedError ? `can't set ${leverage}x ${live.marginMode.toLowerCase()} without changing your own trade (${err.message})` : e.reason;
    return done(e.status === 'unknown' ? 'failed' : e.status, { reason: `leverage setup: ${why}` });
  }

  const byRisk = (ctx.equity * Math.min(ctx.riskPct, 5)) / 100;
  const byLeverage = (leverage * ctx.equity * Math.abs(row.entry - row.stop)) / row.entry;
  const riskUsd = Math.min(byRisk, byLeverage);
  const plan2 = planMarketEntry({ symbol: row.symbol, side: row.side, entry: row.entry, stop: row.stop, target: row.target, riskUsd, leverage, clientId }, rules);
  if (!plan2.ok) return done('skipped', { reason: `${plan2.reason} (risk budget $${riskUsd.toFixed(2)} on $${ctx.equity.toFixed(2)}, ${cls} cap ${leverage}x)` });
  try {
    const r = await api.placeOrder(plan2.body);
    log.info('live: rsi entry', { clientId, name, symbol: row.symbol, side: row.side, qty: plan2.qty, riskUsd: Number(plan2.riskUsd.toFixed(2)) });
    if (r.status === 'dry-run') return done('dry-run', { qty: plan2.qty, riskUsd: plan2.riskUsd, request: plan2.body });
    return done('sent', { qty: plan2.qty, riskUsd: plan2.riskUsd, request: plan2.body, orderId: r.data.orderId });
  } catch (err) {
    const e = explainError(err);
    return done(e.status, { reason: e.reason, qty: plan2.qty, riskUsd: plan2.riskUsd, request: plan2.body });
  }
}

/** Which rows are traded live under `settings`: the model's one exit, for a model switched on. */
export const isLiveRow = (r: RsiSignalRow, settings: RsiLiveSettings) => settings[r.model].on && isSignalRow(r);
