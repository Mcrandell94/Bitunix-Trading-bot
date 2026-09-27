// Kill switches end to end: Postgres state, the order gate, flatten, and a
// paper replay that honours a pause exactly when it was in force.
import { PRIVATE_PATHS, createTradeApi, type PrivateClient, type WriteMode } from '@bot/bitunix';
import { loadControls, loadDashboard, migrate, pausedAt, recentControlEvents } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeExchange } from '../../bitunix/test/fakeExchange';
import { START } from '../../backtest/test/market';
import { syntheticMarket } from '../../backtest/test/synthetic';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { ControlError, applyControl, effectiveMode, paperStep, parseControl, silentLogger, type ControlDeps } from '../src/index';

const DAY = 86_400_000;

test('parseControl accepts only known actions', () => {
  expect(parseControl({ action: 'pause', scope: 'LTF' })).toEqual({ action: 'pause', scope: 'LTF' });
  expect(parseControl({ action: 'halt-live' })).toEqual({ action: 'halt-live' });
  expect(parseControl({ action: 'new-paper-session' })).toEqual({ action: 'new-paper-session' });
  expect(() => parseControl({ action: 'pause', scope: 'BTC' })).toThrow(ControlError);
  expect(() => parseControl({ action: 'flatten' })).toThrow(/FLATTEN/);
  expect(() => parseControl({ action: 'enable-live' })).toThrow(/unknown action/); // no way to switch live ON
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

  test('pauses are time windows; repeats are no-ops; everything is logged', async () => {
    expect((await applyControl(deps, { action: 'pause', scope: 'LTF' }, 'test')).message).toMatch(/paused/);
    expect((await applyControl(deps, { action: 'pause', scope: 'LTF' }, 'test')).message).toBe('Already paused.');
    t += 3_600_000;
    await applyControl(deps, { action: 'resume', scope: 'LTF' }, 'test');
    const { pauses } = await loadControls(pool);
    expect(pauses).toEqual([{ id: expect.any(Number), scope: 'LTF', pausedAt: 1_790_000_000_000, resumedAt: 1_790_003_600_000 }]);
    expect(pausedAt(pauses, 'LTF', 1_790_000_000_000)).toMatch(/paused/);
    expect(pausedAt(pauses, 'LTF', 1_790_003_600_000)).toBeNull(); // resumed
    expect(pausedAt(pauses, 'MTF', 1_790_001_000_000)).toBeNull(); // other tier
    expect((await recentControlEvents(pool)).map((e) => e.action)).toEqual(['resume-entries', 'pause-entries']);
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

describe.skipIf(!TEST_DATABASE_URL)('paper trading honours pauses (Postgres)', { timeout: 120_000 }, () => {
  const market = syntheticMarket(120, 5);
  const symbols = Object.keys(market);
  const exchange = () => fakeExchange({
    candles: Object.fromEntries(symbols.map((s) => [s, market[s]!.candles])),
    tickers: [{ symbol: 'SOLUSDT', quoteVol: '9e8', lastPrice: '150' }, { symbol: 'DOGEUSDT', quoteVol: '5e8', lastPrice: '0.2' }],
    tradingPairs: symbols.map((symbol) => ({ symbol, basePrecision: 3, minTradeVolume: '0.001', isApiSupported: true })),
  });
  const run = async (pause: boolean) => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const deps = { client: exchange(), db: pool, log: silentLogger, codeSha: null, paper: { startEquity: 10_000, extras: 10, minQuoteVolume24h: 1e7 }, model: 'mtf' as const };
      await paperStep(deps, START + 10 * DAY);
      if (pause) {
        await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => START + 60 * DAY }, { action: 'pause', scope: 'ALL' }, 'test');
      }
      const r = await paperStep(deps, START + 120 * DAY);
      return { r, dash: await loadDashboard(pool) };
    } finally {
      await drop();
    }
  };

  test('"new paper session" ends the current one; the next step starts one with the current settings', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const deps = { client: exchange(), db: pool, log: silentLogger, codeSha: null, paper: { startEquity: 10_000, extras: 10, minQuoteVolume24h: 1e7 }, model: 'mtf' as const };
      const first = (await paperStep(deps, START + 10 * DAY)).session;
      // Pretend it was started under the old settings.
      await pool.query(`update paper_sessions set config = jsonb_set(config, '{risk,tiers,MTF,riskPct}', '0.5') where id = $1`, [first.id]);
      const ctl = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => START + 11 * DAY };
      expect((await applyControl(ctl, { action: 'new-paper-session' }, 'test')).message).toMatch(/session #1 ended/);
      const second = (await paperStep(deps, START + 11 * DAY)).session;
      expect(second.id).toBe(first.id + 1);
      expect(second.startedAt).toBe(START + 11 * DAY);
      expect((second.config as { risk: { tiers: { MTF: { riskPct: number } } } }).risk.tiers.MTF.riskPct).toBe(2);
      const { rows } = await pool.query('select id, active from paper_sessions order by id');
      expect(rows).toEqual([{ id: String(first.id), active: false }, { id: String(second.id), active: true }]);
    } finally {
      await drop();
    }
  });

  test('entries stop when the pause starts; trades opened before it are untouched; the radar is saved', async () => {
    const free = await run(false);
    const paused = await run(true);
    const before = (x: typeof free) => x.r.result.trades.filter((tr) => tr.openedAt < START + 60 * DAY);
    expect(before(paused)).toEqual(before(free));
    expect(paused.r.result.trades.every((tr) => tr.openedAt < START + 60 * DAY + 3_600_000)).toBe(true);
    expect(paused.r.result.rejected.some((x) => /paused from the dashboard/.test(x.reason))).toBe(true);
    const radar = paused.dash.radar as { time: number; rows: { gates: string[] }[] };
    expect(radar.time).toBe(START + 120 * DAY);
    expect(radar.rows.every((x) => x.gates.some((g) => /paused/.test(g)))).toBe(true);
  });
});
