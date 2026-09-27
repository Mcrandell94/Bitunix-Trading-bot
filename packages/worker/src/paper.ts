// Paper trading: every 15 minutes, sync the session's data and replay the
// backtest engine from the session start to the last closed 15m bar. The
// replay is the same code, config and fills as a backtest, so paper results
// are directly comparable to backtests.
//
// Honesty rules:
// - The session's universe and config are frozen when it starts. To trade
//   different settings, start a new session.
// - Closed trades are appended once, stamped with the code version, and
//   never rewritten, even if a later code version would replay them
//   differently.
// No API keys and no exchange orders: this never touches an account.

import {
  fetchCandles, fetchFundingHistory, fetchTickers, fetchTradingPairs, type BitunixClient, type Interval, type KlineType,
} from '@bot/bitunix';
import {
  BOT_MODEL, botConfig, runBacktest, type BotModel, type BacktestConfig, type BacktestResult, type SymbolData, type Tf,
} from '@bot/backtest';
import { closedOnly, intervalMs, type Candle, type IntervalName } from '@bot/marketdata';
import {
  activePaperSession, createPaperSession, endPaperSession, latestOpenTimes, loadCandles, loadContractSpecs, loadControls, loadFundingHistory,
  paperSummary, pausedAt, recordPaperTrades, savePaperSnapshot, saveSnapshot, upsertCandles, upsertContractSpecs, upsertFundingHistory,
  type Db, type PaperSession, type PriceKind,
} from '@bot/store';
import type { Logger } from './log';
import { loadRrgInfluence, rrgOnAt, sameHistory } from './rrgInfluence';
import { loadSelection, selectionAt, type SelectionSlot } from './selection';
import { apiTradable, selectUniverse } from './scan';

const DAY = 86_400_000;
const Q = intervalMs('15m');

/** Warm-up kept before the session start, per timeframe (RRG needs 120 daily bars). */
export const PAPER_WARMUP_DAYS: Record<Tf, number> = { '15m': 3, '1h': 10, '4h': 30, '1d': 140 };

export interface PaperDeps {
  client: BitunixClient;
  db: Db;
  log: Logger;
  paper: { startEquity: number; extras: number; minQuoteVolume24h: number };
  /** Code version stamped on trades (Railway sets RAILWAY_GIT_COMMIT_SHA). */
  codeSha: string | null;
  /** What to trade; defaults to BOT_MODEL (tests pass their own). */
  model?: BotModel;
  /**
   * Also replay under the live RRG switch when it differs from paper's, for
   * the live executor (PaperStepResult.liveResult). Only worth it while a live
   * model can trade; otherwise live copies paper's picks.
   */
  liveReplay?: boolean;
}

export interface PaperStepResult {
  session: PaperSession;
  time: number;
  newTrades: number;
  result: BacktestResult;
  /** The candles the replay ran on (the live executor trails stops on them). */
  data: Record<string, SymbolData>;
  /** The same replay under the live RRG switch, when it differs from paper's (see PaperDeps.liveReplay). */
  liveResult?: BacktestResult;
}

/** The last 15m close at or before `now`. */
export const lastQuarterClose = (now: number) => Math.floor(now / Q) * Q;

async function startSession(deps: PaperDeps, at: number): Promise<PaperSession> {
  const symbols = selectUniverse(
    await fetchTickers(deps.client),
    { universe: 'all', minQuoteVolume24h: deps.paper.minQuoteVolume24h, maxExtraSymbols: deps.paper.extras },
    await apiTradable(deps.client),
  );
  const model = deps.model ?? BOT_MODEL;
  const { from: _f, to: _t, ...config } = botConfig(at, at, model);
  const session = await createPaperSession(deps.db, {
    startedAt: at, startEquity: deps.paper.startEquity, symbols, config: { ...config, botModel: model } as unknown as Record<string, unknown>, codeSha: deps.codeSha,
  });
  deps.log.info('paper: session started', { sessionId: session.id, startedAt: new Date(at).toISOString(), symbols, startEquity: session.startEquity });
  return session;
}

async function syncCandleRange(deps: PaperDeps, symbol: string, tf: IntervalName, kind: PriceKind, from: number, to: number): Promise<void> {
  const ms = intervalMs(tf);
  const have = (await latestOpenTimes(deps.db, tf, [symbol], kind)).get(symbol);
  const start = Math.max(Math.floor(from / ms) * ms, have != null ? have + ms : -Infinity);
  if (start >= to) return;
  const type: KlineType = kind === 'mark' ? 'MARK_PRICE' : 'LAST_PRICE';
  const candles = closedOnly(await fetchCandles(deps.client, { symbol, interval: tf as Interval, from: start, to, type }), tf, to);
  await upsertCandles(deps.db, symbol, tf, candles, kind);
}

/** Brings the session's candles, mark candles, funding and contract specs up to `to`. Per-symbol failures are logged, not fatal. */
export async function syncPaperData(deps: PaperDeps, session: PaperSession, to: number): Promise<void> {
  for (const symbol of session.symbols) {
    try {
      for (const tf of ['15m', '1h', '4h', '1d'] as Tf[]) {
        await syncCandleRange(deps, symbol, tf, 'last', session.startedAt - PAPER_WARMUP_DAYS[tf] * DAY, to);
      }
      await syncCandleRange(deps, symbol, '15m', 'mark', session.startedAt - PAPER_WARMUP_DAYS['15m'] * DAY, to);
    } catch (err) {
      deps.log.warn('paper: candle sync failed', { symbol, error: (err as Error).message });
    }
    try {
      const have = await loadFundingHistory(deps.db, [symbol], to - 2 * DAY);
      const last = have[symbol]?.at(-1)?.time;
      const from = last != null ? last + 1 : session.startedAt - 3 * DAY;
      await upsertFundingHistory(deps.db, symbol, await fetchFundingHistory(deps.client, symbol, from, to + 1));
    } catch (err) {
      deps.log.warn('paper: funding sync failed', { symbol, error: (err as Error).message });
    }
  }
  const specs = await loadContractSpecs(deps.db, session.symbols);
  const stale = session.symbols.some((s) => !specs.has(s) || to - specs.get(s)!.updatedAt > DAY);
  if (stale) {
    try {
      const pairs = await fetchTradingPairs(deps.client);
      await upsertContractSpecs(deps.db, pairs.filter((p) => session.symbols.includes(p.symbol)));
    } catch (err) {
      deps.log.warn('paper: contract specs refresh failed', { error: (err as Error).message });
    }
  }
}

export async function loadPaperData(db: Db, session: PaperSession): Promise<Record<string, SymbolData>> {
  const { symbols, startedAt } = session;
  const byTf = {} as Record<Tf, Record<string, Candle[]>>;
  for (const tf of ['15m', '1h', '4h', '1d'] as Tf[]) byTf[tf] = await loadCandles(db, tf, symbols, startedAt - PAPER_WARMUP_DAYS[tf] * DAY);
  const mark = await loadCandles(db, '15m', symbols, startedAt - PAPER_WARMUP_DAYS['15m'] * DAY, 'mark');
  const funding = await loadFundingHistory(db, symbols, startedAt - 3 * DAY);
  const specs = await loadContractSpecs(db, symbols);
  const data: Record<string, SymbolData> = {};
  for (const s of symbols) {
    const spec = specs.get(s);
    const step = spec?.basePrecision != null ? 10 ** -spec.basePrecision : null;
    const f = funding[s] ?? [];
    const gaps = f.slice(1).map((p, i) => p.time - f[i]!.time).sort((a, b) => a - b);
    data[s] = {
      candles: { '15m': byTf['15m'][s], '1h': byTf['1h'][s], '4h': byTf['4h'][s], '1d': byTf['1d'][s] },
      mark15m: mark[s]?.length ? mark[s] : undefined,
      funding: f.length ? f : undefined,
      fundingIntervalHours: gaps.length ? gaps[Math.floor(gaps.length / 2)]! / 3_600_000 : undefined,
      limits: step ? { qtyStep: step, minQty: spec?.minTradeVolume ?? step, priceTick: spec?.quotePrecision != null ? 10 ** -spec.quotePrecision : undefined } : undefined,
    };
  }
  return data;
}

/**
 * The session's frozen config, with defaults filled in for fields added
 * since it started. Tiers and tier risk merge per tier (a session started
 * before a tier existed gets the tier's defaults), and a tier the code's
 * BOT_MODEL doesn't trade is off here too: the code can only switch tiers
 * off, never on.
 */
export function sessionConfig(session: PaperSession, to: number, model: BotModel = BOT_MODEL): BacktestConfig {
  const base = botConfig(session.startedAt, to, model);
  const { botModel: _m, ...frozen } = session.config as Partial<BacktestConfig> & { botModel?: BotModel };
  const tierNames = Object.keys(base.tiers) as (keyof BacktestConfig['tiers'])[];
  const tiers = Object.fromEntries(tierNames.map((t) => {
    const plan = { ...base.tiers[t], ...(frozen.tiers?.[t] ?? {}) };
    return [t, { ...plan, enabled: plan.enabled && base.tiers[t].enabled }];
  })) as BacktestConfig['tiers'];
  const riskTiers = Object.fromEntries(tierNames.map((t) => [t, { ...base.risk.tiers[t], ...(frozen.risk?.tiers?.[t] ?? {}) }])) as BacktestConfig['risk']['tiers'];
  return {
    ...base, ...frozen, tiers, risk: { ...base.risk, ...(frozen.risk ?? {}), tiers: riskTiers },
    from: session.startedAt, to, startEquity: session.startEquity,
  };
}

/**
 * The session in force: the active one, unless it was started under a
 * different model (its frozen plans belong to that model), in which case it
 * ends (its trades stay on record) and a new one starts.
 */
async function currentSession(deps: PaperDeps, to: number): Promise<PaperSession> {
  const model = deps.model ?? BOT_MODEL;
  const active = await activePaperSession(deps.db);
  if (active && (active.config as { botModel?: BotModel }).botModel === model) return active;
  if (active) {
    await endPaperSession(deps.db, `model changed to ${model}`);
    deps.log.info('paper: session ended', { sessionId: active.id, reason: `model changed to ${model}`, was: (active.config as { botModel?: string }).botModel ?? 'unknown' });
  }
  return startSession(deps, to);
}

/** One paper step at `now`: start a session if none is active (or the model changed), sync, replay, persist. */
export async function paperStep(deps: PaperDeps, now: number): Promise<PaperStepResult> {
  const to = lastQuarterClose(now);
  const session = await currentSession(deps, to);
  await syncPaperData(deps, session, to);
  const data = await loadPaperData(deps.db, session);
  if (!data.BTCUSDT?.candles['15m']?.length || !data.ETHUSDT?.candles['15m']?.length) {
    throw new Error('paper: BTC/ETH 15m candles missing; nothing to replay yet');
  }
  // Dashboard pauses are time windows, so the replay applies each one exactly when it was in force.
  const { pauses } = await loadControls(deps.db);
  const cfg = sessionConfig(session, to, deps.model ?? BOT_MODEL);
  // RRG magnifying glass: strategies on a screened signal try the strongest-vs-BTC coins first while the switch is on.
  const signalModel = Object.values(cfg.tiers).some((t) => t.enabled && t.model === 'signal');
  const rrg = await loadRrgInfluence(deps.db);
  const sel = await loadSelection(deps.db);
  const replay = (history: typeof rrg.paper, radar: boolean) => runBacktest(data, signalModel ? { ...cfg, entryPriority: { rrgTf: '1d' } } : cfg, undefined, {
    closeAtEnd: false, radar, entriesBlocked: (tier, time) => pausedAt(pauses, tier, time), rrgPriorityAt: (time) => rrgOnAt(history, time),
    selectionAt: (tier, time) => (tier === 'P1H' || tier === 'P4H' ? selectionAt(sel[tier as SelectionSlot], time) : null),
  });
  const result = replay(rrg.paper, true);
  const liveResult = signalModel && deps.liveReplay && !sameHistory(rrg.paper, rrg.live) ? replay(rrg.live, false) : undefined;
  if (result.radar) await saveSnapshot(deps.db, 'radar', result.radar);

  const newTrades = await recordPaperTrades(deps.db, session.id, result.trades.map((t) => ({
    symbol: t.symbol, tier: t.tier, side: t.side, source: t.source, openedAt: t.openedAt, closedAt: t.closedAt,
    entry: t.entry, initialStop: t.initialStop, qty: t.qty, riskAmount: t.riskAmount, grossPnl: t.grossPnl,
    fees: t.fees, funding: t.funding, netPnl: t.netPnl, r: t.r, fills: t.fills, rrg: t.rrg ?? null,
  })), deps.codeSha);
  const unrealized = result.open.positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  await savePaperSnapshot(deps.db, session.id, {
    time: to, realizedEquity: result.endEquity, totalEquity: result.endEquity + unrealized,
    positions: result.open.positions, pending: result.open.pending,
  });
  const summary = await paperSummary(deps.db, session.id);
  deps.log.info('paper: step', {
    sessionId: session.id, at: new Date(to).toISOString(),
    equity: Number(result.endEquity.toFixed(2)), withOpen: Number((result.endEquity + unrealized).toFixed(2)),
    openPositions: result.open.positions.length, pendingOrders: result.open.pending.length,
    newTrades, trades: summary.trades, wins: summary.wins, totalR: Number(summary.totalR.toFixed(2)), netUsd: Number(summary.netUsd.toFixed(2)),
  });
  return { session, time: to, newTrades, result, data, ...(liveResult ? { liveResult } : {}) };
}
