import { describe, expect, test } from 'vitest';
import {
  BitunixError, PRIVATE_PATHS, TradingDisabledError, createPrivateClient, createTradeApi, fmt, liquidationSafe,
  parseAccount, parseOrders, parsePositions, parseSide, planEntry, planStopMove, planTarget, rulesFromSpec, signature,
  sortedQueryString, writeMode, type ContractSpec, type PrivateClient,
} from '../src/index';

type Reply = { status?: number; body?: unknown; throws?: Error };
interface Seen { url: string; method: string; headers: Record<string, string>; body: string | undefined }

function fakeFetch(replies: Reply[]) {
  const seen: Seen[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const r = replies.shift() ?? { body: { code: 0, msg: 'ok', data: null } };
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const creds = { apiKey: 'k', secretKey: 's' };
const noWait = { sleep: async () => {}, minRequestGapMs: 0, now: () => 1_790_000_000_000, nonce: () => 'n'.repeat(32) };
const ok = (data: unknown) => ({ body: { code: 0, msg: 'Success', data } });

describe('private client', () => {
  test('signed GET: sorted query in the URL and the signature; empty params dropped', async () => {
    const f = fakeFetch([ok({ available: '100' })]);
    const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
    await client.get(PRIVATE_PATHS.account, { marginCoin: 'USDT', symbol: undefined, clientId: '' });
    const r = f.seen[0]!;
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://fapi.bitunix.com/api/v1/futures/account?marginCoin=USDT');
    expect(r.headers).toMatchObject({ 'api-key': 'k', nonce: 'n'.repeat(32), timestamp: '1790000000000' });
    expect(r.headers.sign).toBe(signature(creds, 'n'.repeat(32), '1790000000000', sortedQueryString({ marginCoin: 'USDT' }), ''));
  });

  test('signed POST: the signature covers exactly the bytes sent', async () => {
    const f = fakeFetch([ok({ orderId: '1', clientId: 'c' })]);
    const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
    await client.post(PRIVATE_PATHS.placeOrder, { symbol: 'BTCUSDT', qty: '0.001' });
    const r = f.seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.body).toBe('{"symbol":"BTCUSDT","qty":"0.001"}');
    expect(r.headers.sign).toBe(signature(creds, 'n'.repeat(32), '1790000000000', '', r.body!));
    expect(r.body).not.toContain('"s"');
  });

  test('a POST is never retried after an unclear failure, since the order may exist', async () => {
    for (const reply of [{ throws: new Error('ECONNRESET') }, { status: 502 }, { body: 'not an envelope' }] as Reply[]) {
      const f = fakeFetch([reply, ok({ orderId: '2' })]);
      const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
      const err = await client.post<never>(PRIVATE_PATHS.placeOrder, { symbol: 'BTCUSDT' }).catch((e: unknown) => e as BitunixError);
      expect(err).toBeInstanceOf(BitunixError);
      expect(err.ambiguous).toBe(true);
      expect(f.seen).toHaveLength(1);
    }
  });

  test('a POST refused for rate limiting is retried (the exchange did not act on it)', async () => {
    const f = fakeFetch([{ body: { code: 10006, msg: 'Request too frequently', data: null } }, { status: 429 }, ok({ orderId: '3' })]);
    const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
    expect(await client.post(PRIVATE_PATHS.placeOrder, {})).toEqual({ orderId: '3' });
    expect(f.seen).toHaveLength(3);
    expect(new Set(f.seen.map((s) => s.body)).size).toBe(1); // same order each time
  });

  test('an exchange refusal is not ambiguous and not retried', async () => {
    const f = fakeFetch([{ body: { code: 20003, msg: 'Insufficient balance', data: null } }]);
    const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
    await expect(client.post(PRIVATE_PATHS.placeOrder, {})).rejects.toMatchObject({ code: 20003, ambiguous: false });
    expect(f.seen).toHaveLength(1);
  });

  test('reads are retried like public reads', async () => {
    const f = fakeFetch([{ status: 503 }, { throws: new Error('reset') }, ok([])]);
    const client = createPrivateClient({ credentials: creds, fetch: f.fn, ...noWait });
    expect(await client.get(PRIVATE_PATHS.pendingPositions)).toEqual([]);
    expect(f.seen).toHaveLength(3);
    expect(new Set(f.seen.map((s) => s.headers.sign)).size).toBeGreaterThanOrEqual(1);
  });

  test('refuses to start without both keys', () => {
    expect(() => createPrivateClient({ credentials: { apiKey: 'k', secretKey: '' } })).toThrow(/key and secret/);
  });
});

describe('the write gate', () => {
  test('live needs the master switch on and dry-run off', () => {
    expect(writeMode({ tradingEnabled: false, dryRun: false })).toBe('disabled');
    expect(writeMode({ tradingEnabled: false, dryRun: true })).toBe('dry-run');
    expect(writeMode({ tradingEnabled: true, dryRun: true })).toBe('dry-run');
    expect(writeMode({ tradingEnabled: true, dryRun: false })).toBe('live');
  });

  function recorder(): PrivateClient & { posts: unknown[]; gets: unknown[] } {
    const posts: unknown[] = [];
    const gets: unknown[] = [];
    return {
      posts, gets,
      async get<T>(path: string, params?: unknown) { gets.push({ path, params }); return (path === PRIVATE_PATHS.account ? { available: '50' } : []) as T; },
      async post<T>(path: string, body: unknown) { posts.push({ path, body }); return { orderId: '9', clientId: 'x' } as T; },
    };
  }
  const order = { symbol: 'BTCUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'LIMIT', qty: '0.001', price: '1' } as const;

  test('disabled: every write is refused before reaching the network; reads still work', async () => {
    const c = recorder();
    const events: unknown[] = [];
    const api = createTradeApi(c, { mode: 'disabled', onWrite: (e) => events.push(e) });
    await expect(api.placeOrder(order)).rejects.toBeInstanceOf(TradingDisabledError);
    await expect(api.setLeverage('BTCUSDT', 3)).rejects.toBeInstanceOf(TradingDisabledError);
    await expect(api.setPositionMode('HEDGE')).rejects.toBeInstanceOf(TradingDisabledError);
    await expect(api.flashClose('p1')).rejects.toBeInstanceOf(TradingDisabledError);
    await expect(api.cancelOrders('BTCUSDT', [{ orderId: '1' }])).rejects.toBeInstanceOf(TradingDisabledError);
    await expect(api.modifyPositionTpsl({ symbol: 'BTCUSDT', positionId: 'p', slPrice: '1', slStopType: 'MARK_PRICE' })).rejects.toBeInstanceOf(TradingDisabledError);
    expect(c.posts).toEqual([]);
    expect(events).toHaveLength(6);
    expect((await api.account()).available).toBe(50);
  });

  test('dry-run: reports the exact request, sends nothing', async () => {
    const c = recorder();
    const api = createTradeApi(c, { mode: 'dry-run' });
    expect(await api.placeOrder(order)).toEqual({ status: 'dry-run', request: { path: PRIVATE_PATHS.placeOrder, body: order } });
    expect(await api.setMarginMode('BTCUSDT', 'ISOLATION')).toEqual({
      status: 'dry-run', request: { path: PRIVATE_PATHS.changeMarginMode, body: { marginMode: 'ISOLATION', symbol: 'BTCUSDT', marginCoin: 'USDT' } },
    });
    expect(c.posts).toEqual([]);
  });

  test('live: sends and parses', async () => {
    const c = recorder();
    const api = createTradeApi(c, { mode: 'live' });
    expect(await api.placeOrder(order)).toMatchObject({ status: 'sent', data: { orderId: '9', clientId: 'x' } });
    expect(c.posts).toEqual([{ path: PRIVATE_PATHS.placeOrder, body: order }]);
    expect(() => api.setLeverage('BTCUSDT', 2.5)).toThrow(/whole number/);
  });
});

describe('parsing account data', () => {
  test('account (object or list)', () => {
    const row = { marginCoin: 'USDT', available: '1234.5', frozen: '0', margin: '10', transfer: '1200', positionMode: 'HEDGE', crossUnrealizedPNL: '-1.5', isolationUnrealizedPNL: '2', bonus: '0' };
    expect(parseAccount(row)).toMatchObject({ available: 1234.5, positionMode: 'HEDGE', crossUnrealizedPnl: -1.5 });
    expect(parseAccount([{ ...row, marginCoin: 'BTC', available: '1' }, row]).available).toBe(1234.5);
    expect(() => parseAccount({ marginCoin: 'USDT' })).toThrow(/available/);
  });

  test('positions and sides; an unknown side is refused', () => {
    const p = parsePositions([{ positionId: '77', symbol: 'ETHUSDT', side: 'LONG', qty: '0.5', avgOpenPrice: '4000', leverage: 5, unrealizedPNL: '12.5', liqPrice: '3300', ctime: 1790000000000 }]);
    expect(p[0]).toMatchObject({ positionId: '77', side: 'long', qty: 0.5, avgOpenPrice: 4000, leverage: 5, unrealizedPnl: 12.5, openedAt: 1790000000000 });
    expect(parsePositions(null)).toEqual([]);
    expect(parseSide('SELL')).toBe('short');
    expect(() => parseSide('BOTH')).toThrow(/unknown position side/);
  });

  test('pending orders ({ orderList } page or a plain list)', () => {
    const o = { orderId: '5', clientId: 'bot-1', symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', qty: '0.01', tradeQty: '0', price: '100000', status: 'NEW', reduceOnly: false, slPrice: '99000' };
    expect(parseOrders({ orderList: [o], total: 1 })[0]).toMatchObject({ orderId: '5', clientId: 'bot-1', qty: 0.01, filledQty: 0, price: 100000, slPrice: 99000 });
    expect(parseOrders([o])).toHaveLength(1);
    expect(parseOrders({})).toEqual([]);
  });
});

describe('order planning', () => {
  const spec: ContractSpec = {
    symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', minTradeVolume: 0.01, basePrecision: 2, quotePrecision: 2,
    minLeverage: 1, maxLeverage: 100, apiSupported: true, status: 'OPEN', raw: {},
  };
  const rules = rulesFromSpec(spec)!;
  const intent = { symbol: 'ETHUSDT', side: 'long' as const, entry: 4000.004, stop: 3950.126, takeProfit: 4100.999, riskUsd: 50, clientId: 'bot-e1', leverage: 5 };

  test('rules come from the contract spec; pairs closed to the API have none', () => {
    expect(rules).toEqual({ symbol: 'ETHUSDT', qtyDecimals: 2, priceDecimals: 2, minQty: 0.01, maxLeverage: 100 });
    expect(rulesFromSpec({ ...spec, apiSupported: false })).toBeNull();
    expect(rulesFromSpec({ ...spec, quotePrecision: null })).toBeNull();
  });

  test('entry: GTC limit with a MARK-price stop and target attached; risk never exceeds the budget', () => {
    const plan = planEntry(intent, rules);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.body).toEqual({
      symbol: 'ETHUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'LIMIT', effect: 'GTC', qty: '1', price: '4000', clientId: 'bot-e1',
      slPrice: '3950.12', slStopType: 'MARK_PRICE', slOrderType: 'MARKET',
      tpPrice: '4100.99', tpStopType: 'MARK_PRICE', tpOrderType: 'LIMIT', tpOrderPrice: '4100.99',
    });
    // Stop rounded away from entry (3950.126 -> 3950.12), size floored: 50 / 49.88 = 1.0024 -> 1.00.
    expect(plan.riskUsd).toBeCloseTo(49.88, 9);
    expect(plan.riskUsd).toBeLessThanOrEqual(intent.riskUsd);
  });

  test('short entry mirrors it', () => {
    const plan = planEntry({ ...intent, side: 'short', entry: 4000, stop: 4049.991, takeProfit: 3899.001 }, rules);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.body).toMatchObject({ side: 'SELL', tradeSide: 'OPEN', slPrice: '4050', tpPrice: '3899.01', qty: '1' });
  });

  test('refuses what it cannot do safely', () => {
    const no = (p: ReturnType<typeof planEntry>) => (p.ok ? 'ok' : p.reason);
    expect(no(planEntry({ ...intent, stop: 4010 }, rules))).toMatch(/out of order/);
    expect(no(planEntry({ ...intent, riskUsd: 0.1 }, rules))).toMatch(/below the pair's minimum/);
    expect(no(planEntry({ ...intent, leverage: 150 }, rules))).toMatch(/max 100/);
    // A 12% stop at 5x: liquidation (~19% away) is less than twice the stop distance.
    expect(no(planEntry({ ...intent, stop: 3520, takeProfit: 5000 }, rules))).toMatch(/liquidation/);
    expect(no(planEntry({ ...intent, entry: 4000.001, stop: 3999.999, takeProfit: 4000.004 }, rules))).toMatch(/collapse|out of order/);
  });

  test('liquidation check', () => {
    expect(liquidationSafe(100, 98, 10)).toBe(true); // 2% stop, ~9% to liquidation
    expect(liquidationSafe(100, 95, 10)).toBe(false); // 5% stop needs >= 10% of room
    expect(liquidationSafe(100, 95, 3)).toBe(true);
  });

  test('targets are POST_ONLY hedge-mode closes of that position; stop moves use MARK price', () => {
    const pos = { positionId: 'p9', symbol: 'ETHUSDT', side: 'long' as const };
    const t = planTarget(pos, 4050.019, 0.337, rules, 'bot-t1');
    expect(t).toEqual({ ok: true, body: {
      symbol: 'ETHUSDT', side: 'BUY', tradeSide: 'CLOSE', positionId: 'p9', orderType: 'LIMIT', effect: 'POST_ONLY', qty: '0.33', price: '4050.01', clientId: 'bot-t1',
    } });
    expect(planTarget({ ...pos, side: 'short' }, 3950.011, 1, rules, 'x')).toMatchObject({ ok: true, body: { side: 'SELL', price: '3950.02' } });
    expect(planTarget(pos, 4050, 0.004, rules, 'x')).toMatchObject({ ok: false });
    expect(planStopMove(pos, 4000.007, rules)).toEqual({ symbol: 'ETHUSDT', positionId: 'p9', slPrice: '4000', slStopType: 'MARK_PRICE' });
  });

  test('decimal strings without float noise', () => {
    expect(fmt(0.1 + 0.2, 8)).toBe('0.3');
    expect(fmt(25000, 2)).toBe('25000');
    expect(fmt(0.00001123, 8)).toBe('0.00001123');
  });
});

