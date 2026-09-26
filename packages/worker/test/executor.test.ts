// The live executor against a fake Bitunix account and real Postgres:
// sizing from the real balance, the ledger (no double sends), dry run,
// fills becoming bot-owned positions, expiry, halts, and the owner's trades.
import type { BacktestResult, PendingView } from '@bot/backtest';
import { BitunixError, PRIVATE_PATHS, createTradeApi, type PrivateClient, type WriteMode } from '@bot/bitunix';
import { migrate, ownedPositionIds, recentLiveOrders, upsertContractSpecs } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { accountEquity, executorStep, liveClientId, riskBudget, silentLogger, type ExecutorDeps } from '../src/index';

const T = 1_790_000_100_000 - (1_790_000_100_000 % 900_000); // a 15m close
const Q = 900_000;

interface FakePos { positionId: string; symbol: string; side: 'LONG' | 'SHORT'; qty: string; avgOpenPrice: string }
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
  };
  const client: PrivateClient = {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      const sym = params?.symbol as string | undefined;
      switch (path) {
        case PRIVATE_PATHS.account: return { marginCoin: 'USDT', available: state.available, margin: state.margin, positionMode: 'HEDGE' } as T;
        case PRIVATE_PATHS.pendingPositions: return state.positions.filter((p) => !sym || p.symbol === sym) as T;
        case PRIVATE_PATHS.pendingOrders: return { orderList: state.orders.filter((o) => !sym || o.symbol === sym) } as T;
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

const sol = (over: Partial<PendingView> = {}): PendingView => ({
  symbol: 'SOLUSDT', tier: 'MTF', side: 'long', source: 'improving' as PendingView['source'],
  entry: 150, stop: 147, takeProfit: 165, qty: 1, placedAt: T, expiresAt: T + 6 * 3_600_000, ...over,
});
const result = (pending: PendingView[]) => ({ open: { pending, positions: [] } }) as unknown as BacktestResult;

test('sizing helpers: equity and the owner\'s risk budget', () => {
  expect(accountEquity({ marginCoin: 'USDT', available: 30, frozen: 0, margin: 21, transfer: 0, positionMode: 'HEDGE', crossUnrealizedPnl: -1, isolationUnrealizedPnl: 0.5, bonus: 0 })).toBe(50.5);
  expect(riskBudget(51, 'MTF', 150, 147)).toBeCloseTo(1.02, 9); // 2%
  expect(riskBudget(51, 'LTF', 150, 147)).toBeCloseTo(0.51, 9); // 1%
  expect(riskBudget(51, 'MTF', 150, 149.9)).toBeCloseTo((3 * 51 * 0.1) / 150, 9); // tight stop: 3x leverage cap binds
  expect(liveClientId('MTF', 'SOLUSDT', T)).toMatch(/^bot-m-[0-9a-z]+-sol$/);
  expect(liveClientId('MTF', 'SOLUSDT', T).length).toBeLessThanOrEqual(32);
});

describe.skipIf(!TEST_DATABASE_URL)('live executor (Postgres)', { timeout: 120_000 }, () => {
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
    await upsertContractSpecs(pool, [spec('SOLUSDT', 1, 0.1), spec('BTCUSDT', 3, 0.01)]);
  });
  const deps = (client: PrivateClient, mode: WriteMode): ExecutorDeps => ({
    api: createTradeApi(client, { mode, ownedPositions: () => ownedPositionIds(pool) }),
    db: pool, log: silentLogger, live: { credentials: null, dryRun: mode !== 'live', leverage: 5, marginMode: 'ISOLATION' },
  });

  test('dry run: the order it would send, sized from the real balance; nothing sent; never twice', async () => {
    const x = fakeBitunix();
    const s = await executorStep(deps(x.client, 'dry-run'), { sessionId: 1, result: result([sol(), sol({ symbol: 'ETHUSDT', placedAt: T - Q })]), time: T });
    expect(s).toMatchObject({ equity: 51, placed: 1 });
    expect(x.state.posts).toEqual([]);
    const [o] = await recentLiveOrders(pool);
    expect(o).toMatchObject({ symbol: 'SOLUSDT', status: 'dry-run', qty: 0.3 });
    expect(o!.riskUsd).toBeCloseTo(0.9, 9); // 2% of $51 = $1.02, floored to 0.3 SOL x $3 stop
    expect(o!.request).toMatchObject({
      symbol: 'SOLUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'LIMIT', price: '150', qty: '0.3',
      slPrice: '147', slStopType: 'MARK_PRICE', tpPrice: '165', tpStopType: 'MARK_PRICE', clientId: liveClientId('MTF', 'SOLUSDT', T),
    });
    // The next step at the same close (a restart) does nothing new.
    await executorStep(deps(x.client, 'dry-run'), { sessionId: 1, result: result([sol()]), time: T });
    expect(await recentLiveOrders(pool)).toHaveLength(1);
    // Past its window, a dry-run entry expires.
    await executorStep(deps(x.client, 'dry-run'), { sessionId: 1, result: result([]), time: T + 6 * 3_600_000 });
    expect((await recentLiveOrders(pool))[0]!.status).toBe('expired');
  });

  test('skips, with the reason: too small for the pair, or the owner holds that side', async () => {
    const x = fakeBitunix();
    x.state.positions.push({ positionId: 'mine', symbol: 'SOLUSDT', side: 'LONG', qty: '5', avgOpenPrice: '140' });
    await executorStep(deps(x.client, 'dry-run'), {
      sessionId: 1, time: T,
      result: result([sol(), sol({ symbol: 'BTCUSDT', entry: 100_000, stop: 99_000, takeProfit: 105_000 })]),
    });
    const byS = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(byS.SOLUSDT).toMatchObject({ status: 'skipped' });
    expect(byS.SOLUSDT!.reason).toMatch(/you have a long position on SOLUSDT/);
    expect(byS.BTCUSDT).toMatchObject({ status: 'skipped' });
    expect(byS.BTCUSDT!.reason).toMatch(/below the pair's minimum.*risk budget \$1\.02 on \$51\.00/);
    expect(x.state.posts).toEqual([]);
  });

  test('live: sets isolated 5x, places the entry, registers the fill as the bot\'s, never touches the owner\'s', async () => {
    const x = fakeBitunix();
    x.state.positions.push({ positionId: 'owner-eth', symbol: 'ETHUSDT', side: 'LONG', qty: '0.06', avgOpenPrice: '4000' });
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    expect(x.state.posts.map((p) => p.path)).toEqual([PRIVATE_PATHS.changeMarginMode, PRIVATE_PATHS.changeLeverage, PRIVATE_PATHS.placeOrder]);
    const cid = liveClientId('MTF', 'SOLUSDT', T);
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'sent', orderId: 'ex-1' });

    x.fill(cid, 'pos-sol-1');
    await executorStep(d, { sessionId: 1, result: result([]), time: T + Q });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'filled', positionId: 'pos-sol-1' });
    expect(await ownedPositionIds(pool)).toEqual(new Set(['pos-sol-1']));
    // Now the bot may close its own position, and still not the owner's.
    await expect(d.api.flashClose('owner-eth')).rejects.toThrow(/not the bot's/);
    expect((await d.api.flashClose('pos-sol-1')).status).toBe('sent');
  });

  test('live: an entry still resting past its window is cancelled by its clientId', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 6 * 3_600_000 });
    expect(x.state.posts.at(-1)).toEqual({ path: PRIVATE_PATHS.cancelOrders, body: { symbol: 'SOLUSDT', orderList: [{ clientId: liveClientId('MTF', 'SOLUSDT', T) }] } });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'expired' });
    expect(x.state.orders).toEqual([]);
  });

  test('halted or trading off: refused before anything is sent', async () => {
    const x = fakeBitunix();
    await executorStep(deps(x.client, 'disabled'), { sessionId: 1, result: result([sol()]), time: T });
    expect(x.state.posts).toEqual([]);
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'refused', reason: expect.stringMatching(/off or halted/) });
  });

  test('an unclear reply is not resent; the next step finds the order by clientId', async () => {
    const x = fakeBitunix();
    x.state.settings.SOLUSDT = { leverage: 5, marginMode: 'ISOLATION' }; // nothing to set: the first post is the order
    const d = deps(x.client, 'live');
    x.state.failNextPost = new BitunixError('network error: socket hang up', null, null, true, true);
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'unknown' });
    // The exchange did take it, despite the error.
    x.state.orders.push({ orderId: 'ex-9', clientId: liveClientId('MTF', 'SOLUSDT', T), symbol: 'SOLUSDT', side: 'BUY', qty: '0.3' });
    const posts = x.state.posts.length;
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T + Q });
    expect(x.state.posts.length).toBe(posts); // nothing resent
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'sent', orderId: 'ex-9' });
  });
});
