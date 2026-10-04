// The RSI live executor against a fake Bitunix account and real Postgres: model switches, sizing from the real
// balance (1% risk), market entries with the stop attached, the ledger (never twice), fills becoming the bot's,
// following the signal (stop moves, closes), and the owner's trades left alone.
import type { RsiSignalRow } from '@bot/backtest';
import { PRIVATE_PATHS, createTradeApi, type PrivateClient, type WriteMode } from '@bot/bitunix';
import { migrate, openBotPositions, ownedPositionIds, recentLiveOrders, registerBotPosition, saveSnapshot, setHaltLive, upsertContractSpecs } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { accountEquity, silentLogger, type ExecutorDeps } from '../src/index';
import { breakerStep, DEFAULT_LIVE_BREAKER, LIVE_MAX_OPEN_KEY, safeLeverage } from '../src/executor';
import { DIV_BOOST_KEY, RSI_LIVE_KEY, RSI_RISK_KEY, parseRsiTag, planMarketEntry, rsiClientId, rsiLiveStep, rsiTag } from '../src/rsiLive';
import type { RsiSignalsSnapshot } from '../src/rsiSignals';

const H4 = 4 * 3_600_000, DAY = 86_400_000;
const T = 1_790_000_000_000 - (1_790_000_000_000 % H4); // a 4H close
const Q = 900_000;

interface FakePos { positionId: string; symbol: string; side: 'LONG' | 'SHORT'; qty: string; avgOpenPrice: string; ctime?: string; unrealizedPNL?: string; realizedPNL?: string; fee?: string }
interface FakeOrder { orderId: string; clientId: string | null; symbol: string; side: 'BUY' | 'SELL'; qty: string }

function fakeBitunix() {
  const state = {
    available: '30', margin: '21',
    positions: [] as FakePos[],
    orders: [] as FakeOrder[],
    settings: {} as Record<string, { leverage: number; marginMode: string }>,
    posts: [] as { path: string; body: Record<string, unknown> }[],
    failNextPost: null as Error | null,
    nextId: 1,
    /** TP/SL orders; `ignoreTpslWrites` makes the exchange answer success and change nothing (seen live 2026-09-28). */
    tpsl: [] as { id: string; positionId: string; symbol: string; slPrice?: string; slStopType?: string; slQty?: string; tpPrice?: string; tpStopType?: string; tpQty?: string }[],
    ignoreTpslWrites: false,
    /** Position history (closed positions). */
    history: [] as { positionId: string; symbol: string; realizedPNL: string; fee: string }[],
  };
  const client: PrivateClient = {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      const sym = params?.symbol as string | undefined;
      switch (path) {
        case PRIVATE_PATHS.account: return { marginCoin: 'USDT', available: state.available, margin: state.margin, positionMode: 'HEDGE' } as T;
        case PRIVATE_PATHS.pendingPositions: return state.positions.filter((p) => !sym || p.symbol === sym) as T;
        case PRIVATE_PATHS.pendingOrders: return { orderList: state.orders.filter((o) => !sym || o.symbol === sym) } as T;
        case PRIVATE_PATHS.pendingTpsl: return state.tpsl.filter((t) => (!sym || t.symbol === sym) && (!params?.positionId || t.positionId === params.positionId)) as T;
        case PRIVATE_PATHS.historyPositions: return { positionList: state.history.filter((h) => !params?.positionId || h.positionId === params.positionId), total: state.history.length } as T;
        case PRIVATE_PATHS.leverageMarginMode: return { symbol: sym, ...(state.settings[sym!] ?? { leverage: 20, marginMode: 'CROSS' }) } as T;
        default: return [] as T;
      }
    },
    async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
      if (state.failNextPost) { const e = state.failNextPost; state.failNextPost = null; state.posts.push({ path, body }); throw e; }
      state.posts.push({ path, body });
      const sym = body.symbol as string;
      if (path === PRIVATE_PATHS.changeLeverage) state.settings[sym] = { ...(state.settings[sym] ?? { marginMode: 'CROSS' }), leverage: body.leverage as number };
      if (path === PRIVATE_PATHS.changeMarginMode) state.settings[sym] = { ...(state.settings[sym] ?? { leverage: 20 }), marginMode: body.marginMode as string };
      if (path === PRIVATE_PATHS.placeOrder) {
        const orderId = `ex-${state.nextId++}`;
        state.orders.push({ orderId, clientId: body.clientId as string, symbol: sym, side: body.side as 'BUY' | 'SELL', qty: body.qty as string });
        return { orderId, clientId: body.clientId } as T;
      }
      if (!state.ignoreTpslWrites && path === PRIVATE_PATHS.modifyTpsl) {
        const t = state.tpsl.find((x) => x.id === body.orderId);
        if (t) Object.assign(t, Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'orderId')));
      }
      if (!state.ignoreTpslWrites && (path === PRIVATE_PATHS.modifyPositionTpsl || path === PRIVATE_PATHS.placePositionTpsl)) {
        const t = state.tpsl.find((x) => x.positionId === body.positionId && x.id.startsWith('pos-tpsl'));
        const { positionId, symbol: s2, ...rest } = body as Record<string, string> & { positionId: string; symbol: string };
        if (t) Object.assign(t, rest); else state.tpsl.push({ id: `pos-tpsl-${state.nextId++}`, positionId, symbol: s2, ...rest });
      }
      if (path === PRIVATE_PATHS.cancelOrders) {
        const ids = (body.orderList as { clientId?: string }[]).map((o) => o.clientId);
        state.orders = state.orders.filter((o) => !ids.includes(o.clientId ?? undefined));
      }
      return {} as T;
    },
  };
  /** The exchange fills a resting order: it leaves the book and a position appears. */
  const fill = (clientId: string, positionId: string) => {
    const o = state.orders.find((x) => x.clientId === clientId)!;
    state.orders = state.orders.filter((x) => x !== o);
    state.positions.push({ positionId, symbol: o.symbol, side: o.side === 'BUY' ? 'LONG' : 'SHORT', qty: o.qty, avgOpenPrice: '150' });
  };
  return { state, client, fill };
}

const row = (over: Partial<RsiSignalRow> = {}): RsiSignalRow => ({
  symbol: 'SOLUSDT', model: 'bottom-div', variant: 0, exitName: '20R target, no time stop', side: 'long', signalAt: T - DAY, status: 'enter',
  entry: 150, enteredAt: null, stop: 147, target: 165, lastPrice: 150, r: null, exit: null, until: null, closedAt: null, stopPct: 2,
  plans: ['option 1', 'no exceptions'], ...over,
});
const snap = (rows: RsiSignalRow[], time = T): RsiSignalsSnapshot => ({ time, coins: 2, rows });

test('helpers: equity, clientId, tag, market entry plan', () => {
  expect(accountEquity({ marginCoin: 'USDT', available: 30, frozen: 0, margin: 21, transfer: 0, positionMode: 'HEDGE', crossUnrealizedPnl: -1, isolationUnrealizedPnl: 0.5, bonus: 0 })).toBe(50.5);
  const id = rsiClientId('4h-fail-short', 1, 'PENGUUSDT', T);
  expect(id).toMatch(/^bot-r[0-9a-z]1-[0-9a-z]+-pengu$/);
  expect(id.length).toBeLessThanOrEqual(32);
  expect(new Set((['bottom-div', 'triple-div', 'under-floor', 'd-fail-short'] as const).map((m) => rsiClientId(m, 0, 'SOLUSDT', T))).size).toBe(4);
  const tag = rsiTag(row(), 'no exceptions');
  expect(parseRsiTag(tag)).toEqual({ model: 'bottom-div', variant: 0, plan: 'no exceptions', signalAt: T - DAY });
  expect(parseRsiTag('MTF')).toBeNull();
  const rules = { symbol: 'SOLUSDT', qtyDecimals: 1, priceDecimals: 3, minQty: 0.1, maxLeverage: 50 };
  const p = planMarketEntry({ symbol: 'SOLUSDT', side: 'short', entry: 150, stop: 153, target: null, riskUsd: 1, leverage: 10, clientId: 'bot-x' }, rules);
  expect(p).toMatchObject({ ok: true, qty: 0.3, body: { orderType: 'MARKET', side: 'SELL', slPrice: '153', qty: '0.3' } });
  expect((p as unknown as { body: Record<string, unknown> }).body.tpPrice).toBeUndefined();
  expect(planMarketEntry({ symbol: 'SOLUSDT', side: 'long', entry: 150, stop: 151, target: 160, riskUsd: 1, leverage: 10, clientId: 'b' }, rules).ok).toBe(false);
  expect(planMarketEntry({ symbol: 'SOLUSDT', side: 'long', entry: 150, stop: 147, target: 160, riskUsd: 0.1, leverage: 10, clientId: 'b' }, rules)).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/) });
  expect(safeLeverage(100, 60, 10)).toBeLessThan(10);
});

test('breaker rule (pure)', () => {
  const b = DEFAULT_LIVE_BREAKER;
  const a = breakerStep(null, 100, 0, b);
  expect(a).toMatchObject({ peak: 100, trippedAt: null });
  const t = breakerStep({ peak: 100, trippedAt: null }, 84, 1, b);
  expect(t.justTripped).toBe(true);
  expect(breakerStep({ peak: 100, trippedAt: 1 }, 84, 1 + b.pauseDays * DAY, b)).toMatchObject({ peak: 84, trippedAt: null });
});

describe.skipIf(!TEST_DATABASE_URL)('RSI live executor (Postgres)', { timeout: 120_000 }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await drop?.();
    ({ pool, drop } = await freshSchema());
    await migrate(pool);
    const spec = (symbol: string, basePrecision: number, min: number) => ({
      symbol, base: null, quote: 'USDT', minTradeVolume: min, basePrecision, quotePrecision: 3, minLeverage: 1, maxLeverage: 50, raw: { isApiSupported: true },
    });
    await upsertContractSpecs(pool, [spec('SOLUSDT', 1, 0.1), spec('BTCUSDT', 3, 0.001), spec('ETHUSDT', 2, 0.01)]);
  });
  const deps = (client: PrivateClient, mode: WriteMode): ExecutorDeps => ({
    api: createTradeApi(client, { mode, ownedPositions: () => ownedPositionIds(pool) }),
    db: pool, log: silentLogger, live: { credentials: null, dryRun: mode !== 'live', leverage: 10, marginMode: 'ISOLATION' },
  });
  const switchOn = (over: Record<string, unknown> = {}) => saveSnapshot(pool, RSI_LIVE_KEY, { 'bottom-div': { on: true, plan: 'option 1', variant: 0 }, ...over });

  test('a model switched off never trades; nothing is claimed', async () => {
    const x = fakeBitunix();
    const s = await rsiLiveStep(deps(x.client, 'live'), { now: T + 60_000, snapshot: snap([row()]), entries: true });
    expect(s.placed).toBe(0);
    expect(await recentLiveOrders(pool)).toEqual([]);
    expect(x.state.posts).toEqual([]);
  });

  test('dry run: market entry with the stop and target attached, 1% of the real balance, never twice; other exits / rule sets ignored', async () => {
    const x = fakeBitunix();
    await switchOn();
    const rows = [row(), row({ variant: 1, exitName: 'alt' }), row({ symbol: 'ETHUSDT', plans: ['no exceptions'] }), row({ symbol: 'BTCUSDT', status: 'waiting', entry: null, stop: null })];
    const s = await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 60_000, snapshot: snap(rows), entries: true });
    expect(s).toMatchObject({ equity: 51, placed: 1 });
    expect(x.state.posts).toEqual([]);
    const [o] = await recentLiveOrders(pool);
    expect(o).toMatchObject({ symbol: 'SOLUSDT', status: 'dry-run', qty: 0.1, tier: rsiTag(row(), 'option 1'), clientId: rsiClientId('bottom-div', 0, 'SOLUSDT', T - DAY) });
    expect(o!.request).toMatchObject({ side: 'BUY', tradeSide: 'OPEN', orderType: 'MARKET', qty: '0.1', slPrice: '147', slStopType: 'MARK_PRICE', tpPrice: '165' });
    // 1% of $51 = $0.51 at a $3 stop = 0.17 SOL, floored to the pair's 0.1.
    await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 120_000, snapshot: snap(rows), entries: true });
    expect(await recentLiveOrders(pool)).toHaveLength(1);
    // A higher risk setting sizes up.
    await saveSnapshot(pool, RSI_RISK_KEY, { riskPct: 3 });
    await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 180_000, snapshot: snap([row({ signalAt: T - 2 * DAY })]), entries: true });
    // One per coin and side: the first is still in play, so the second is skipped (and never retried).
    expect((await recentLiveOrders(pool)).find((r) => r.clientId === rsiClientId('bottom-div', 0, 'SOLUSDT', T - 2 * DAY))).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/one per coin and side/) });
  });

  test('MACD divergence boost: a signal with a divergence risks the multiple, one without does not', async () => {
    const x = fakeBitunix();
    await switchOn();
    await saveSnapshot(pool, DIV_BOOST_KEY, { mult: 2 });
    const rows = [row({ macdDiv: true }), row({ symbol: 'ETHUSDT', entry: 4000, stop: 3990, target: 4400, lastPrice: 4000, macdDiv: false })];
    await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 60_000, snapshot: snap(rows), entries: true });
    const by = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(by.SOLUSDT).toMatchObject({ status: 'dry-run', qty: 0.3 }); // 2% of $51 = $1.02 at a $3 stop = 0.34, floored to 0.3
    expect(by.ETHUSDT).toMatchObject({ status: 'dry-run', qty: 0.05 }); // 1% of $51 = $0.51 at a $10 stop = 0.051, floored to 0.05
  });

  test('no entries from a stale snapshot (a missed close is never chased)', async () => {
    const x = fakeBitunix();
    await switchOn();
    await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 31 * 60_000, snapshot: snap([row()]), entries: true });
    expect(await recentLiveOrders(pool)).toEqual([]);
  });

  test('live: places the market entry, registers the fill with its RSI tag, never touches the owner\'s', async () => {
    const x = fakeBitunix();
    await switchOn();
    x.state.positions.push({ positionId: 'owner-eth', symbol: 'ETHUSDT', side: 'LONG', qty: '0.06', avgOpenPrice: '4000' });
    const d = deps(x.client, 'live');
    await rsiLiveStep(d, { now: T + 60_000, snapshot: snap([row()]), entries: true });
    expect(x.state.posts.map((p) => p.path)).toEqual([PRIVATE_PATHS.changeMarginMode, PRIVATE_PATHS.changeLeverage, PRIVATE_PATHS.placeOrder]);
    const cid = rsiClientId('bottom-div', 0, 'SOLUSDT', T - DAY);
    x.fill(cid, 'pos-sol-1');
    await rsiLiveStep(d, { now: T + Q, snapshot: snap([row({ status: 'open', enteredAt: T })]), entries: true });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'filled', positionId: 'pos-sol-1' });
    const [m] = await openBotPositions(pool);
    expect(m).toMatchObject({ positionId: 'pos-sol-1', tier: rsiTag(row(), 'option 1'), initialStop: 147 });
    await expect(d.api.flashClose('owner-eth')).rejects.toThrow(/not the bot's/);
  });

  test('follows its signal: breakeven at the live fill, trail tighter only, closes at market when the signal closes', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    const tag = rsiTag(row(), 'option 1');
    x.state.positions.push({ positionId: 'p1', symbol: 'SOLUSDT', side: 'LONG', qty: '0.1', avgOpenPrice: '150.4' });
    x.state.tpsl.push({ id: 'o1', positionId: 'p1', symbol: 'SOLUSDT', slPrice: '147', slStopType: 'MARK_PRICE', slQty: '0.1', tpPrice: '165', tpStopType: 'MARK_PRICE', tpQty: '0.1' });
    await registerBotPosition(pool, { positionId: 'p1', symbol: 'SOLUSDT', side: 'long', clientId: 'bot-x', tier: tag, entry: 150.4, initialStop: 147, takeProfit: 165, qtyInitial: 0.1 });
    // The signal moved its stop to its own entry (breakeven): the live stop goes to the live fill.
    await rsiLiveStep(d, { now: T + Q, snapshot: snap([row({ status: 'open', enteredAt: T, stop: 150, lastPrice: 157 })]), entries: false });
    expect(x.state.tpsl[0]!.slPrice).toBe('150.4');
    expect((await openBotPositions(pool))[0]!.stop).toBe(150.4);
    // A looser stop in the signal never loosens the live one.
    const n = x.state.posts.length;
    await rsiLiveStep(d, { now: T + 2 * Q, snapshot: snap([row({ status: 'open', enteredAt: T, stop: 149, lastPrice: 157 })]), entries: false });
    expect(x.state.posts.length).toBe(n);
    // A trail above the fill moves it up.
    await rsiLiveStep(d, { now: T + 3 * Q, snapshot: snap([row({ status: 'open', enteredAt: T, stop: 153.25, lastPrice: 158 })]), entries: false });
    expect(x.state.tpsl[0]!.slPrice).toBe('153.25');
    // The signal closed (time exit): close at market.
    await rsiLiveStep(d, { now: T + 4 * Q, snapshot: snap([row({ status: 'closed', enteredAt: T, exit: 'time', closedAt: T + 4 * Q })]), entries: false });
    expect(x.state.posts.at(-1)!.path).toBe(PRIVATE_PATHS.flashClosePosition);
  });

  test('positions of the retired EMA strategies are left alone and only recorded when they close', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    x.state.positions.push({ positionId: 'ema1', symbol: 'SOLUSDT', side: 'LONG', qty: '0.1', avgOpenPrice: '150' });
    await registerBotPosition(pool, { positionId: 'ema1', symbol: 'SOLUSDT', side: 'long', clientId: 'bot-m-x-sol', tier: 'MTF', entry: 150, initialStop: 147, takeProfit: 165, qtyInitial: 0.1 });
    await rsiLiveStep(d, { now: T + Q, snapshot: snap([row({ status: 'closed', exit: 'time' })]), entries: false });
    expect(x.state.posts).toEqual([]);
    x.state.positions = [];
    x.state.history.push({ positionId: 'ema1', symbol: 'SOLUSDT', realizedPNL: '0.25', fee: '0.05' });
    await rsiLiveStep(d, { now: T + 2 * Q, snapshot: null, entries: false });
    expect(await openBotPositions(pool)).toEqual([]);
  });

  test('skips with the reason: the owner holds that coin and side; max open trades; halted', async () => {
    const x = fakeBitunix();
    await switchOn({ 'd-fail-short': { on: true, plan: 'option 1', variant: 0 } });
    x.state.positions.push({ positionId: 'mine', symbol: 'SOLUSDT', side: 'LONG', qty: '5', avgOpenPrice: '140' });
    await saveSnapshot(pool, LIVE_MAX_OPEN_KEY, { maxOpen: 1 });
    const rows = [row(), row({ symbol: 'ETHUSDT', entry: 4000, stop: 3990, target: 4400, lastPrice: 4000 }), row({ symbol: 'BTCUSDT', model: 'd-fail-short', side: 'short', entry: 100_000, stop: 101_000, target: 97_000, lastPrice: 100_000 })];
    await rsiLiveStep(deps(x.client, 'dry-run'), { now: T + 60_000, snapshot: snap(rows), entries: true });
    const by = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(by.SOLUSDT!.reason).toMatch(/your own trade|you have a long position/);
    expect(by.ETHUSDT, JSON.stringify(by.ETHUSDT)).toMatchObject({ status: "dry-run" });
    expect(by.BTCUSDT!.reason).toMatch(/max open live trades reached \(1 of 1/);

    const y = fakeBitunix();
    await setHaltLive(pool, true, 'test');
    const halted = createTradeApi(y.client, { mode: 'disabled', ownedPositions: () => ownedPositionIds(pool) });
    await rsiLiveStep({ ...deps(y.client, 'live'), api: halted }, { now: T + 61_000, snapshot: snap([row({ signalAt: T - 3 * DAY, symbol: 'ETHUSDT', entry: 4000, stop: 3900, target: 4400, lastPrice: 4000 })]), entries: true });
    expect(y.state.posts).toEqual([]);
  });
});
