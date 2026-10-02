// The live executor against a fake Bitunix account and real Postgres:
// sizing from the real balance, the ledger (no double sends), dry run,
// fills becoming bot-owned positions, expiry, halts, and the owner's trades.
import type { BacktestResult, PendingView } from '@bot/backtest';
import { BitunixError, PRIVATE_PATHS, createTradeApi, type PrivateClient, type WriteMode } from '@bot/bitunix';
import { loadSnapshot, migrate, ownedPositionIds, recentLiveOrders, registerBotPosition, upsertContractSpecs } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { accountEquity, applyControl, executorStep, liveClientId, parseControl, riskBudget, silentLogger, type ExecutorDeps } from '../src/index';
import { breakerStep, DEFAULT_LIVE_BREAKER, LIVE_PEAK_KEY, loadLiveSlots, safeLeverage } from '../src/executor';

const T = 1_790_000_100_000 - (1_790_000_100_000 % 900_000); // a 15m close
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
  // Every slot has its own letter (P1H must not share P4H's 'p').
  expect(new Set(['LTF', 'MTF', 'HTF', 'P4H', 'P1H'].map((t) => liveClientId(t, 'SOLUSDT', T).split('-')[1])).size).toBe(5);
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

  test('stop move modifies the entry order\'s own TP/SL order, is read back, and is restored if the exchange lost it', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T });
    x.fill(liveClientId('MTF', 'SOLUSDT', T), 'pos-link');
    // The entry's attached stop and target live as one TP/SL order with quantities (as on Bitunix).
    x.state.tpsl.push({ id: 'tpsl-1', positionId: 'pos-link', symbol: 'SOLUSDT', slPrice: '147', slStopType: 'MARK_PRICE', slQty: '0.2', tpPrice: '165', tpStopType: 'MARK_PRICE', tpQty: '0.2' });
    await executorStep(d, { sessionId: 1, result: result([]), time: T + Q });
    // First partial fills; the exchange answers the first move with success but changes nothing.
    x.state.positions[0]!.qty = '0.2';
    x.state.orders = x.state.orders.filter((o) => o.clientId !== 'bot-t1-pos-link');
    x.state.ignoreTpslWrites = true;
    x.state.posts = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 2 * Q });
    expect(x.state.posts).toEqual([{ path: PRIVATE_PATHS.modifyTpsl, body: { orderId: 'tpsl-1', slPrice: '150', slStopType: 'MARK_PRICE', slQty: '0.2', tpPrice: '165', tpStopType: 'MARK_PRICE', tpQty: '0.2' } }]);
    expect(x.state.tpsl[0]!.slPrice).toBe('147'); // not confirmed, so not recorded: tried again next step
    x.state.ignoreTpslWrites = false;
    x.state.posts = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 3 * Q });
    expect(x.state.posts.map((p) => p.path)).toEqual([PRIVATE_PATHS.modifyTpsl]);
    expect(x.state.tpsl).toHaveLength(1);
    expect(x.state.tpsl[0]!.slPrice).toBe('150');
    // Confirmed: nothing more to do.
    x.state.posts = [];
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 4 * Q });
    expect(x.state.posts).toEqual([]);
    // If the exchange's stop ever falls behind the recorded one, it is put back.
    x.state.tpsl[0]!.slPrice = '147';
    await executorStep(d, { sessionId: 1, result: result([]), time: T + 5 * Q });
    expect(x.state.tpsl[0]!.slPrice).toBe('150');
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

  /** A position the bot opened (registered as its own), with its open result. */
  const botPosition = async (x: ReturnType<typeof fakeBitunix>, positionId: string, unrealizedPNL: string) => {
    x.state.positions.push({ positionId, symbol: 'ETHUSDT', side: 'LONG', qty: '0.01', avgOpenPrice: '4000', unrealizedPNL });
    await registerBotPosition(pool, { positionId, symbol: 'ETHUSDT', side: 'long', clientId: `bot-h-x-${positionId}` });
  };

  test('daily loss stop counts only the bot\'s own trades', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'dry-run');
    await botPosition(x, 'bot-eth', '0');
    await executorStep(d, { sessionId: 1, result: result([]), time: T }); // first step of the day: $51 recorded
    x.state.positions[0]!.unrealizedPNL = '-5'; // the bot's position: down $5, 9.8%
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + Q }), sol({ symbol: 'BTCUSDT', tier: 'LTF', placedAt: T + Q })]), time: T + Q });
    const byS = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(byS.SOLUSDT!.reason).toMatch(/daily loss stop: the bot's trades are down 9\.8% today \(MTF limit 8%\)/);
    // LTF is switched off in the code: refused before the daily loss check, whatever the paper session placed.
    expect(byS.BTCUSDT!.reason).toMatch(/LTF is switched off for live trading in the code/);
    // A new UTC day starts from the current equity.
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 86_400_000 })]), time: T + 86_400_000 });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'dry-run' });
  });

  test('live gate: EMA 50 is allowed in the code, but nothing trades live until the owner switches a strategy on', async () => {
    const x = fakeBitunix();
    const d = { ...deps(x.client, 'dry-run'), model: undefined }; // the code's LIVE_MODEL (ema50), dashboard defaults (all off)
    const at = T;
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: at }), sol({ symbol: 'BTCUSDT', tier: 'HTF', entry: 100_000, stop: 98_000, takeProfit: 108_000, placedAt: at })]), time: at });
    let byS = Object.fromEntries((await recentLiveOrders(pool)).filter((o) => o.placedAt === at).map((o) => [o.symbol, o]));
    expect(byS.SOLUSDT).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/target 1 ATR is not switched on for live trading/) });
    expect(byS.BTCUSDT).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/4H EMA 5\/20 cross is not switched on for live trading/) });
    expect(x.state.posts).toEqual([]);

    // The owner switches the HTF strategy (now the 4H crossover) on from the dashboard: only it trades.
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => at }, parseControl({ action: 'live-slot-on', scope: 'HTF' }), 'test');
    expect(await loadLiveSlots(pool)).toEqual({ LTF: false, MTF: false, HTF: true, P4H: false, P1H: false });
    const at2 = at + Q;
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: at2 }), sol({ symbol: 'SOLUSDT', tier: 'HTF', placedAt: at2 })]), time: at2 });
    const now = (await recentLiveOrders(pool)).filter((o) => o.placedAt === at2);
    expect(now.find((o) => o.tier === 'HTF')).toMatchObject({ status: 'dry-run' });
    // Live sizes at the owner's live risk: 3% of $51 = $1.53 -> 0.5 SOL x $3 stop = $1.50 (paper stays at 1%).
    expect(now.find((o) => o.tier === 'HTF')!.riskUsd).toBeCloseTo(1.5, 9);
    expect(now.find((o) => o.tier === 'MTF')).toMatchObject({ status: 'skipped' });
    // Adjusted from the dashboard: 1% -> $0.51 -> 0.1 SOL x $3 = $0.30.
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => at }, parseControl({ action: 'set-live-risk', riskPct: 1 }), 'test');
    const at3 = at2 + Q;
    await executorStep(d, { sessionId: 1, result: result([sol({ symbol: 'SOLUSDT', tier: 'HTF', placedAt: at3 })]), time: at3 });
    expect((await recentLiveOrders(pool)).find((o) => o.placedAt === at3)!.riskUsd).toBeCloseTo(0.3, 9);
    expect(() => parseControl({ action: 'set-live-risk', riskPct: 6 })).toThrow(/0.5% and 5%/);
  });

  test('never adopts the owner\'s position: an entry that vanishes unfilled leaves the owner\'s same-side position alone', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'live');
    await executorStep(d, { sessionId: 1, result: result([sol()]), time: T }); // bot's SOL long entry rests (0.3 SOL)
    // The owner opens their own SOL long by hand, then the bot's order disappears without filling.
    x.state.orders = [];
    x.state.positions.push({ positionId: 'owner-sol', symbol: 'SOLUSDT', side: 'LONG', qty: '0.3', avgOpenPrice: '150', ctime: String(T - 3_600_000) });
    await executorStep(d, { sessionId: 1, result: result([]), time: T + Q });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'gone' });
    expect(await ownedPositionIds(pool)).toEqual(new Set()); // opened before the bot's order: not the bot's
    await expect(d.api.flashClose('owner-sol')).rejects.toThrow(/not the bot's/);
    // Same with a bigger position opened after the order: bigger than the bot's order, so not its fill.
    const y = fakeBitunix();
    const e = deps(y.client, 'live');
    await executorStep(e, { sessionId: 2, result: result([sol({ placedAt: T + 2 * Q })]), time: T + 2 * Q });
    y.state.orders = [];
    y.state.positions.push({ positionId: 'owner-sol-2', symbol: 'SOLUSDT', side: 'LONG', qty: '5', avgOpenPrice: '150', ctime: String(T + 2 * Q + 60_000) });
    await executorStep(e, { sessionId: 2, result: result([]), time: T + 3 * Q });
    expect(await ownedPositionIds(pool)).toEqual(new Set());
    y.state.posts = [];
    await executorStep(e, { sessionId: 2, result: result([]), time: T + 4 * Q });
    expect(y.state.posts).toEqual([]); // nothing sent about the owner's position
  });

  test('max open live trades: entries past the limit are skipped; the owner\'s positions don\'t count', async () => {
    const x = fakeBitunix();
    x.state.positions.push({ positionId: 'owner-eth', symbol: 'ETHUSDT', side: 'LONG', qty: '0.06', avgOpenPrice: '4000' });
    const spec = (symbol: string) => ({ symbol, base: null, quote: 'USDT', minTradeVolume: 0.1, basePrecision: 1, quotePrecision: 3, minLeverage: 1, maxLeverage: 50, raw: { isApiSupported: true } });
    await upsertContractSpecs(pool, [spec('AUSDT'), spec('BUSDT')]);
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T }, parseControl({ action: 'set-max-open', maxOpen: 2 }), 'test');
    await executorStep(deps(x.client, 'dry-run'), { sessionId: 1, time: T, result: result(['AUSDT', 'BUSDT', 'SOLUSDT'].map((symbol) => sol({ symbol }))) });
    const orders = await recentLiveOrders(pool);
    const skipped = orders.filter((o) => /max open live trades reached \(2 of 2/.test(o.reason ?? ''));
    expect(skipped).toHaveLength(1); // the third entry; the owner's ETH position isn't counted
    expect(() => parseControl({ action: 'set-max-open', maxOpen: 0 })).toThrow(/1 to 20/);
  });

  test('live drawdown breaker: trips at the limit, blocks new entries for the pause, then resumes from a fresh peak', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'dry-run');
    await botPosition(x, 'bot-eth', '0');
    await executorStep(d, { sessionId: 1, result: result([]), time: T }); // peak $51
    // Tighten the breaker from the dashboard: 5% drop, 2 days.
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T }, parseControl({ action: 'set-breaker', drawdownPct: 5, pauseDays: 2 }), 'test');
    x.state.positions[0]!.unrealizedPNL = '-3'; // the bot's trades: $48, 5.9% below the peak (the daily loss stop is 8%, so this is the breaker)
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + Q })]), time: T + Q });
    const [o] = await recentLiveOrders(pool);
    expect(o).toMatchObject({ status: 'skipped', leverage: 10, capClass: 'large' });
    expect(o!.reason).toMatch(/drawdown breaker: the bot's trades are 5\.9% below their peak \$51\.00 \(limit 5%\)/);
    // Owner's switch: trade through the pause; entries go ahead while it's on, and are blocked again once it's off.
    const ctl = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T };
    await applyControl(ctl, parseControl({ action: 'breaker-override', on: true }), 'test');
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 2 * Q })]), time: T + 2 * Q });
    expect((await recentLiveOrders(pool)).find((r) => r.placedAt === T + 2 * Q)).toMatchObject({ status: 'dry-run' });
    await applyControl(ctl, parseControl({ action: 'breaker-override', on: false }), 'test');
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 3 * Q })]), time: T + 3 * Q });
    expect((await recentLiveOrders(pool)).find((r) => r.placedAt === T + 3 * Q)!.reason).toMatch(/drawdown breaker/);
    // Two days later it resumes, measuring from the equity at the resume.
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 2 * 86_400_000 + Q })]), time: T + 2 * 86_400_000 + Q });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'dry-run', leverage: 10 });
  });

  test('leverage by coin size follows the dashboard setting, never above LIVE_LEVERAGE', async () => {
    const x = fakeBitunix();
    const ctl = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => T };
    // SOL out of the large caps: it's small here (its pair allows 50x, so mid) -> the mid setting.
    await applyControl(ctl, parseControl({ action: 'set-leverage', large: 20, mid: 4, small: 2, largeCaps: 'BTC, ETH' }), 'test');
    await executorStep(deps(x.client, 'dry-run'), { sessionId: 1, result: result([sol(), sol({ symbol: 'BTCUSDT', entry: 100_000, stop: 98_000, takeProfit: 108_000 })]), time: T });
    const byS = Object.fromEntries((await recentLiveOrders(pool)).map((o) => [o.symbol, o]));
    expect(byS.SOLUSDT).toMatchObject({ capClass: 'mid', leverage: 4 });
    expect(byS.BTCUSDT).toMatchObject({ capClass: 'large', leverage: 10 }); // 20x asked, LIVE_LEVERAGE is 10
  });

  test('the owner\'s own losses, deposits and withdrawals never trip the breaker or the daily loss stop', async () => {
    const x = fakeBitunix();
    const d = deps(x.client, 'dry-run');
    await botPosition(x, 'bot-eth', '0');
    await executorStep(d, { sessionId: 1, result: result([]), time: T }); // account $51, the bot's peak $51
    // The owner's own trade loses $12 (-24% of the account) and they withdraw $5: nothing the bot did.
    x.state.positions.push({ positionId: 'owner-btc', symbol: 'BTCUSDT', side: 'LONG', qty: '0.001', avgOpenPrice: '100000', unrealizedPNL: '-12' });
    x.state.available = '13'; // account $34
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + Q })]), time: T + Q });
    expect((await recentLiveOrders(pool))[0]).toMatchObject({ status: 'dry-run' }); // not blocked
    expect(await loadSnapshot(pool, LIVE_PEAK_KEY)).toMatchObject({ peak: 51, trippedAt: null });

    // The bot's position closes at -$9 net (position history: -$8.80 realized, $0.20 fee): 17.6% below its peak, so it trips.
    x.state.positions = x.state.positions.filter((p) => p.positionId !== 'bot-eth');
    x.state.history.push({ positionId: 'bot-eth', symbol: 'ETHUSDT', realizedPNL: '-8.8', fee: '-0.2' });
    await executorStep(d, { sessionId: 1, result: result([sol({ placedAt: T + 2 * Q })]), time: T + 2 * Q });
    const o = (await recentLiveOrders(pool)).find((r) => r.placedAt === T + 2 * Q)!;
    expect(o.reason).toMatch(/drawdown breaker: the bot's trades are 17\.6% below their peak \$51\.00/);
  });

  test('breaker rule (pure)', () => {
    const b = DEFAULT_LIVE_BREAKER;
    let s = breakerStep(null, 100, 0, b);
    expect(s).toMatchObject({ peak: 100, until: null });
    s = breakerStep(s, 120, 1, b);
    expect(s.peak).toBe(120);
    s = breakerStep(s, 102.1, 2, b); // 14.9% down: not yet
    expect(s.until).toBeNull();
    s = breakerStep(s, 102, 3, b); // 15%: trips
    expect(s).toMatchObject({ justTripped: true, until: 3 + 7 * 86_400_000 });
    expect(breakerStep(s, 150, 4, b).until).toBe(3 + 7 * 86_400_000); // stays tripped even if equity recovers
    expect(breakerStep(s, 90, 3 + 7 * 86_400_000, b)).toMatchObject({ peak: 90, until: null });
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

test('wide stops step leverage down (never below 3x) instead of skipping the trade', () => {
  expect(safeLeverage(100, 97, 10)).toBe(10); // 3% stop: 10x is safe
  expect(safeLeverage(5.144, 4.76246, 10)).toBeLessThanOrEqual(6); // NEAR's 7.4% stop: steps down
  expect(safeLeverage(5.144, 4.76246, 10)).toBeGreaterThanOrEqual(3);
  expect(safeLeverage(100, 80, 10)).toBe(2); // 20% stop: down to 2x
  expect(safeLeverage(0.0269134, 0.0161524, 10)).toBe(1); // USUS's 40% stop: 1x (was skipped at the old 3x floor)
  expect(safeLeverage(100, 45, 10)).toBe(10); // 55% stop: not safe even at 1x, left as is (planEntry skips it)
});
