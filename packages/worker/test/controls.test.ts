// Dashboard controls end to end: Postgres state, the order gate, flatten, and the RSI models' live switches.
import { PRIVATE_PATHS, createTradeApi, type PrivateClient, type WriteMode } from '@bot/bitunix';
import { loadControls, loadDashboard, migrate, recentControlEvents } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { ControlError, applyControl, effectiveMode, parseControl, silentLogger, type ControlDeps } from '../src/index';
import { loadRsiLive, loadRsiRiskPct } from '../src/rsiLive';

test('parseControl accepts only known actions', () => {
  expect(parseControl({ action: 'halt-live' })).toEqual({ action: 'halt-live' });
  expect(parseControl({ action: 'rsi-live', model: 'bottom-div', on: true })).toEqual({ action: 'rsi-live', model: 'bottom-div', on: true });
  expect(parseControl({ action: 'rsi-live', model: 'd-fail-short', plan: 'no exceptions', variant: 1 })).toEqual({ action: 'rsi-live', model: 'd-fail-short', plan: 'no exceptions', variant: 1 });
  expect(() => parseControl({ action: 'rsi-live', model: 'momentum', on: true })).toThrow(/live RSI models/); // dropped models never trade
  expect(() => parseControl({ action: 'rsi-live', model: 'bottom-div', plan: 'best' })).toThrow(/rule set/);
  expect(() => parseControl({ action: 'rsi-live', model: 'bottom-div', variant: 2 })).toThrow(/exit/);
  expect(() => parseControl({ action: 'rsi-live', model: 'bottom-div' })).toThrow(/nothing to change/);
  expect(() => parseControl({ action: 'rsi-live', model: 'bottom-div', on: 'yes' })).toThrow(/true or false/);
  expect(parseControl({ action: 'set-rsi-risk', riskPct: '1.25' })).toEqual({ action: 'set-rsi-risk', riskPct: 1.3 });
  expect(() => parseControl({ action: 'set-rsi-risk', riskPct: 6 })).toThrow(/0.5% and 5%/);
  expect(parseControl({ action: 'set-breaker', drawdownPct: '12.5', pauseDays: 3 })).toEqual({ action: 'set-breaker', drawdownPct: 12.5, pauseDays: 3 });
  expect(() => parseControl({ action: 'set-breaker', drawdownPct: 60, pauseDays: 3 })).toThrow(/between 5% and 50%/);
  expect(() => parseControl({ action: 'set-breaker', drawdownPct: 15, pauseDays: 0.5 })).toThrow(/1 to 30/);
  expect(parseControl({ action: 'breaker-override', on: true })).toEqual({ action: 'breaker-override', on: true });
  expect(() => parseControl({ action: 'breaker-override', on: 'yes' })).toThrow(/true or false/);
  expect(parseControl({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: 'btc, ethUSDT  sol' }))
    .toEqual({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: ['BTC', 'ETH', 'SOL'] });
  expect(() => parseControl({ action: 'set-leverage', large: 25, mid: 3, small: 2, largeCaps: 'BTC' })).toThrow(/1 to 20/);
  expect(() => parseControl({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: 'BT$C' })).toThrow(/tickers/);
  // The retired EMA controls are gone.
  for (const action of ['pause', 'live-slot-on', 'rrg-on', 'set-selection', 'set-live-risk', 'new-paper-session']) expect(() => parseControl({ action, scope: 'MTF' })).toThrow(/unknown action/);
  expect(() => parseControl({ action: 'flatten' })).toThrow(/FLATTEN/);
  expect(() => parseControl({ action: 'enable-live' })).toThrow(/unknown action/); // no way to switch the account's live trading ON
  expect(() => parseControl(null)).toThrow(ControlError);
});

test('a halt beats any environment mode', () => {
  for (const m of ['live', 'dry-run', 'disabled'] as WriteMode[]) {
    expect(effectiveMode(m, { haltLive: true })).toBe('disabled');
    expect(effectiveMode(m, { haltLive: false })).toBe(m);
  }
});

function fakeAccount(): PrivateClient & { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  return {
    posts,
    async get<T>(path: string): Promise<T> {
      // The bot's order o1 and position p1, next to the owner's manual order m1 and position u1.
      if (path === PRIVATE_PATHS.pendingOrders) {
        return { orderList: [
          { orderId: 'o1', clientId: 'bot-1', symbol: 'ETHUSDT', side: 'BUY', qty: '1' },
          { orderId: 'm1', clientId: null, symbol: 'ETHUSDT', side: 'SELL', qty: '1' },
        ] } as T;
      }
      if (path === PRIVATE_PATHS.pendingPositions) {
        return [
          { positionId: 'p1', symbol: 'BTCUSDT', side: 'LONG', qty: '0.01', avgOpenPrice: '100000' },
          { positionId: 'u1', symbol: 'XRPUSDT', side: 'SHORT', qty: '100', avgOpenPrice: '2.5' },
        ] as T;
      }
      return {} as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> { posts.push({ path, body }); return {} as T; },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('kill switches (Postgres)', { timeout: 120_000 }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let deps: ControlDeps;
  let t = 1_790_000_000_000;
  beforeAll(async () => {
    ({ pool, drop } = await freshSchema());
    await migrate(pool);
    deps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => t };
  });
  afterAll(async () => drop?.());

  test('RSI model switches: off by default, change one field at a time, logged; risk setting', async () => {
    expect((await loadRsiLive(pool))['bottom-div']).toEqual({ on: false, plan: 'option 1', variant: 0 });
    expect((await applyControl(deps, { action: 'rsi-live', model: 'bottom-div', on: true }, 'test')).message).toMatch(/live trading ON \(option 1, exit A/);
    await applyControl(deps, { action: 'rsi-live', model: 'bottom-div', variant: 1 }, 'test');
    await applyControl(deps, { action: 'rsi-live', model: 'd-fail-short', plan: 'no exceptions' }, 'test');
    const s = await loadRsiLive(pool);
    expect(s['bottom-div']).toEqual({ on: true, plan: 'option 1', variant: 1 });
    expect(s['d-fail-short']).toEqual({ on: false, plan: 'no exceptions', variant: 0 });
    expect(s.momentum.on).toBe(false);
    expect((await applyControl(deps, { action: 'rsi-live', model: 'bottom-div', on: false }, 'test')).message).toMatch(/live trading OFF/);
    expect(await loadRsiRiskPct(pool)).toBe(1);
    await applyControl(deps, { action: 'set-rsi-risk', riskPct: 2 }, 'test');
    expect(await loadRsiRiskPct(pool)).toBe(2);
    expect((await recentControlEvents(pool)).map((e) => e.action)).toEqual(expect.arrayContaining(['rsi-live', 'set-rsi-risk']));
    const dash = await loadDashboard(pool);
    expect(dash).toMatchObject({ botPositions: [], botClosed: [], liveOrders: [] });
  });

  test('the master switch: OFF pauses everything and halts live orders; ON lifts both', async () => {
    const live = { haltLive: false };
    const d = { ...deps, live };
    expect((await applyControl(d, { action: 'trading-off' }, 'test')).message).toMatch(/Trading is OFF/);
    let c = await loadControls(pool);
    expect(c.haltLive).toBe(true);
    expect(live.haltLive).toBe(true);
    expect(c.pauses.some((p) => p.scope === 'ALL' && p.resumedAt == null)).toBe(true);
    expect((await applyControl(d, { action: 'trading-on' }, 'test')).message).toMatch(/Trading is ON/);
    c = await loadControls(pool);
    expect(c.haltLive).toBe(false);
    expect(live.haltLive).toBe(false);
    expect(c.pauses.every((p) => p.scope !== 'ALL' || p.resumedAt != null)).toBe(true);
    expect(parseControl({ action: 'trading-off' })).toEqual({ action: 'trading-off' });
  });

  test('halting live orders blocks the gate at once, and survives a restart', async () => {
    const client = fakeAccount();
    const api = createTradeApi(client, { mode: () => effectiveMode('live', deps.live), ownedPositions: async () => new Set(['p1']) });
    await applyControl(deps, { action: 'halt-live' }, 'test');
    await expect(api.flashClose('p1')).rejects.toThrow(/disabled/);
    expect(client.posts).toEqual([]);
    expect((await loadControls(pool)).haltLive).toBe(true);
    await applyControl(deps, { action: 'resume-live' }, 'test');
    expect(deps.live.haltLive).toBe(false);
    expect((await api.flashClose('p1')).status).toBe('sent');
  });

  test('flatten: pauses, halts, then closes only the bot\'s trades (dry run only reports)', async () => {
    const owned = { ownedPositions: async () => new Set(['p1']) };
    const dry = fakeAccount();
    const r = await applyControl({ ...deps, flattenApi: createTradeApi(dry, { mode: 'dry-run', ...owned }) }, { action: 'flatten', confirm: 'FLATTEN' }, 'test');
    expect(r.message).toMatch(/would cancel ETHUSDT orders; would close BTCUSDT long\. Your own 1 position left untouched/);
    expect(dry.posts).toEqual([]);
    const c = await loadControls(pool);
    expect(c.haltLive).toBe(true);
    expect(c.pauses.some((p) => p.scope === 'ALL' && p.resumedAt == null)).toBe(true);

    const live = fakeAccount();
    await applyControl({ ...deps, flattenApi: createTradeApi(live, { mode: 'live', ...owned }) }, { action: 'flatten', confirm: 'FLATTEN' }, 'test');
    // Only the bot's order o1 and position p1: the manual order m1 and position u1 are untouched.
    expect(live.posts).toEqual([
      { path: PRIVATE_PATHS.cancelOrders, body: { symbol: 'ETHUSDT', orderList: [{ orderId: 'o1' }] } },
      { path: PRIVATE_PATHS.flashClosePosition, body: { positionId: 'p1' } },
    ]);
    expect((await applyControl(deps, { action: 'flatten', confirm: 'FLATTEN' }, 'test')).message).toMatch(/No Bitunix account is linked/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('dashboard data (Postgres)', { timeout: 60_000 }, () => {
  test('live orders list only the RSI framework\'s orders, not the retired EMA strategies\'', async () => {
    const { claimLiveOrder } = await import('@bot/store');
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const o = { sessionId: null, symbol: 'SOLUSDT', side: 'long' as const, entry: 150, stop: 147, takeProfit: 165, placedAt: 1, expiresAt: 2 };
      await claimLiveOrder(pool, { ...o, clientId: 'bot-m-x-sol', tier: 'MTF' });
      await claimLiveOrder(pool, { ...o, clientId: 'bot-r00-x-sol', tier: 'rsi|bottom-div|0|option 1|1' });
      expect((await loadDashboard(pool)).liveOrders.map((x) => x.clientId)).toEqual(['bot-r00-x-sol']);
    } finally {
      await drop();
    }
  });
});
