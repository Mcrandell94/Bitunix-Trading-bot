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
  expect(riskBudget(51, 'MTF', 150, 147, 10)).toBeCloseTo(1.02, 9); // 2%
  expect(riskBudget(51, 'LTF', 150, 147, 10)).toBeCloseTo(0.51, 9); // 1%
  expect(riskBudget(51, 'MTF', 150, 149.9, 3)).toBeCloseTo((3 * 51 * 0.1) / 150, 9); // tight stop on a small cap: 3x binds
  expect(riskBudget(51, 'MTF', 150, 149.9, 10)).toBeCloseTo((10 * 51 * 0.1) / 150, 9); // large cap: 10x
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
    db: pool, log: silentLogger, live: { credentials: null, dryRun: mode !== 'live', leverage: 10, marginMode: 'ISOLATION' },
    model: 'mtf', // these tests exercise the executor with MTF orders; the code default trades nothing
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
    expect(byS.SOLUSDT!.reason).toMatch(/can't set 10x isolation without changing your own trade.*you have a position on SOLUSDT/);
    expect(byS.BTCUSDT).toMatchObject({ status: 'skipped' });
    expect(byS.BTCUSDT!.reason).toMatch(/below the pair's minimum.*risk budget \$1\.02 on \$51\.00, large cap 10x/);
    expect(x.state.posts).toEqual([]);
  });

  test('live: sets isolated 10x on a large cap, places the entry, registers the fill as the bot\'s, never touches the owner\'s', async () => {
    const x = fakeBitunix();
    x.state.positions.push({ positionId: 'owner-eth', symbol: 'ETHUSDT', side: 'LONG', qty: '0.06', avgOpenPrice: '4000' });
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    expect(x.state.posts.map((p) => p.path)).toEqual([PRIVATE_PATHS.changeMarginMode, PRIVATE_PATHS.changeLeverage, PRIVATE_PATHS.placeOrder]);
    expect(x.state.posts[1]!.body).toMatchObject({ symbol: 'SOLUSDT', leverage: 10 });
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

  test('live management: partials rest after the fill, stop to breakeven after the first, leftovers cancelled on close', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    x.fill(liveClientId('MTF', 'SOLUSDT', T), 'pos-7777');
    x.state.posts = [];
    // Step 2: the fill is registered with its plan, and the two partial targets go on the book.
    await executorStep(d, { sessionId: 1, result: result([]), time: T + Q });
    const partials = x.state.posts.filter((p) => p.path === PRIVATE_PATHS.placeOrder).map((p) => p.body);
    expect(partials).toEqual([
      { symbol: 'SOLUSDT', side: 'BUY', tradeSide: 'CLOSE', positionId: 'pos-7777', orderType: 'LIMIT', effect: 'POST_ONLY', qty: '0.1', price: '153', clientId: 'bot-t1-pos-7777' },
      { symbol: 'SOLUSDT', side: 'BUY', tradeSide: 'CLOSE', positionId: 'pos-7777', orderType: 'LIMIT', effect: 'POST_ONLY', qty: '0.1', price: '156', clientId: 'bot-t2-pos-7777' },
    ]);
    // Step 3: nothing new (partials already resting, not re-sent).
    x.state.posts = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 2 * Q });
    expect(x.state.posts).toEqual([]);
    // The 1R partial fills: the position shrinks and that order leaves the book.
    x.state.positions[0]!.qty = '0.2';
    x.state.orders = x.state.orders.filter((o) => o.clientId !== 'bot-t1-pos-7777');
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 3 * Q });
    expect(x.state.posts).toEqual([{
      path: PRIVATE_PATHS.modifyPositionTpsl,
      body: { symbol: 'SOLUSDT', positionId: 'pos-7777', slPrice: '150', slStopType: 'MARK_PRICE', tpPrice: '165', tpStopType: 'MARK_PRICE' },
    }]);
    // Once at breakeven, it stays put.
    x.state.posts = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 4 * Q });
    expect(x.state.posts).toEqual([]);
    // The rest closes at the stop: record it and clear the leftover 2R target.
    x.state.positions = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 5 * Q });
    expect(x.state.posts).toEqual([{ path: PRIVATE_PATHS.cancelOrders, body: { symbol: 'SOLUSDT', orderList: [{ clientId: 'bot-t2-pos-7777' }] } }]);
    expect(await ownedPositionIds(pool)).toEqual(new Set());
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

  test('never trades at leverage it didn\'t set: if the owner trades the pair, it skips', async () => {
    const x = fakeBitunix();
    x.state.positions.push({ positionId: 'owner-sol-short', symbol: 'SOLUSDT', side: 'SHORT', qty: '2', avgOpenPrice: '160' });
    await executorStep(deps(x.client, 'live'), { sessionId: 1, result: result([sol()]), time: T });
    expect(x.state.posts).toEqual([]); // no leverage change, no order
    const [o] = await recentLiveOrders(pool);
    expect(o).toMatchObject({ status: 'skipped' });
    expect(o!.reason).toMatch(/leverage setup: can't set 10x isolation without changing your own trade/);
    // Already at 10x isolated: nothing to change, so it trades (the owner's short is a separate hedge position).
    x.state.settings.SOLUSDT = { leverage: 10, marginMode: 'ISOLATION' };
    await executorStep(deps(x.client, 'live'), { sessionId: 1, result: result([sol({ placedAt: T + Q })]), time: T + Q });
    expect(x.state.posts.map((p) => p.path)).toEqual([PRIVATE_PATHS.placeOrder]);
  });

  test('daily loss stop on the real account', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'dry-run');
    await executorStep(d, { sessionId: 1, result: result([]), time: T }); // first step of the day: $51 recorded
    x.state.available = '25'; // equity $46: down 9.8%
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + Q }), sol({ symbol: 'BTCUSDT', tier: 'LTF', placedAt: T + Q })]), time: T + Q });
    const byS = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(byS.SOLUSDT!.reason).toMatch(/daily loss stop: account down 9\.8% today \(MTF limit 8%\)/);
    // LTF is switched off in the code: refused before the daily loss check, whatever the paper session placed.
    expect(byS.BTCUSDT!.reason).toMatch(/LTF is switched off in the code/);
    // A new UTC day starts from the current equity.
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 86_400_000 })]), time: T + 86_400_000 });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'dry-run' });
  });

  test('halted or trading off: refused before anything is sent', async () => {
    const x = fakeBitunix();
    await executorStep(deps(x.client, 'disabled'), { sessionId: 1, result: result([sol()]), time: T });
    expect(x.state.posts).toEqual([]);
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'refused', reason: expect.stringMatching(/off or halted/) });
  });

  test('an unclear reply is not resent; the next step finds the order by clientId', async () => {
    const x = fakeBitunix();
    x.state.settings.SOLUSDT = { leverage: 10, marginMode: 'ISOLATION' }; // nothing to set: the first post is the order
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
