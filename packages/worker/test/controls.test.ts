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
import { loadSelection, selectionAt } from '../src/selection';
import { ControlError, applyControl, effectiveMode, paperStep, parseControl, silentLogger, type ControlDeps } from '../src/index';

const DAY = 86_400_000;

test('parseControl accepts only known actions', () => {
  expect(parseControl({ action: 'pause', scope: 'LTF' })).toEqual({ action: 'pause', scope: 'LTF' });
  expect(parseControl({ action: 'halt-live' })).toEqual({ action: 'halt-live' });
  expect(parseControl({ action: 'new-paper-session' })).toEqual({ action: 'new-paper-session' });
  expect(parseControl({ action: 'live-slot-on', scope: 'HTF' })).toEqual({ action: 'live-slot-on', scope: 'HTF' });
  expect(() => parseControl({ action: 'live-slot-on', scope: 'ALL' })).toThrow(ControlError);
  expect(parseControl({ action: 'rrg-on', scope: 'live' })).toEqual({ action: 'rrg-on', scope: 'live' });
  expect(() => parseControl({ action: 'rrg-off', scope: 'MTF' })).toThrow(ControlError);
  expect(parseControl({ action: 'set-breaker', drawdownPct: '12.5', pauseDays: 3 })).toEqual({ action: 'set-breaker', drawdownPct: 12.5, pauseDays: 3 });
  expect(() => parseControl({ action: 'set-breaker', drawdownPct: 60, pauseDays: 3 })).toThrow(/between 5% and 50%/);
  expect(() => parseControl({ action: 'set-breaker', drawdownPct: 15, pauseDays: 0.5 })).toThrow(/1 to 30/);
  expect(parseControl({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: 'btc, ethUSDT  sol' }))
    .toEqual({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: ['BTC', 'ETH', 'SOL'] });
  expect(() => parseControl({ action: 'set-leverage', large: 25, mid: 3, small: 2, largeCaps: 'BTC' })).toThrow(/1 to 20/);
  expect(() => parseControl({ action: 'set-leverage', large: 5, mid: 3, small: 2, largeCaps: 'BT$C' })).toThrow(/tickers/);
  expect(parseControl({ action: 'set-selection', scope: 'P1H', value: 'range' })).toEqual({ action: 'set-selection', scope: 'P1H', value: 'range' });
  expect(parseControl({ action: 'set-selection', scope: 'HTF', value: 'heading' })).toEqual({ action: 'set-selection', scope: 'HTF', value: 'heading' });
  expect(() => parseControl({ action: 'set-selection', scope: 'ALL', value: 'rrg' })).toThrow(/LTF, MTF, HTF, P4H or P1H/);
  expect(() => parseControl({ action: 'set-selection', scope: 'P4H', value: 'best' })).toThrow(/none, range, rrg, heading, fastslow or btcregime/);
  expect(parseControl({ action: 'set-selection', scope: 'P4H', value: 'fastslow' })).toEqual({ action: 'set-selection', scope: 'P4H', value: 'fastslow' });
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

  test('coin selection per pullback slot: starts at the code default, flips are dated, repeats are no-ops', async () => {
    expect((await applyControl(deps, { action: 'set-selection', scope: 'P1H', value: 'rrg' }, 'test')).message).toMatch(/already uses/); // 1H default is rrg
    const at = t;
    expect((await applyControl(deps, { action: 'set-selection', scope: 'P1H', value: 'range' }, 'test')).message).toMatch(/now picks coins/);
    expect((await applyControl(deps, { action: 'set-selection', scope: 'P4H', value: 'rrg' }, 'test')).message).toMatch(/now picks coins/);
    const h = await loadSelection(pool);
    expect(h.P1H).toEqual([{ at, value: 'range' }]);
    expect(selectionAt(h.P1H, at - 1)).toBeNull(); // before the flip: the code default applies
    expect(selectionAt(h.P1H, at)).toBe('range');
    expect(selectionAt(h.P4H, at)).toBe('rrg');
    expect((await recentControlEvents(pool)).map((e) => e.action)).toContain('set-selection');
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

describe.skipIf(!TEST_DATABASE_URL)('alts cap (Postgres)', { timeout: 120_000 }, () => {
  const t = 1_790_000_000_000;
  const deps = { log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => t } as Omit<ControlDeps, 'db'>;
  test('same-direction alts cap: dated changes, validated, logged', async () => {
    const { altsCapAt, loadAltsCap } = await import('../src/altsCap');
    const t0 = t;
    const { pool: own, drop: dropOwn } = await freshSchema();
    await migrate(own);
    const deps2 = { ...deps, db: own } as ControlDeps;
    expect((await applyControl(deps2, parseControl({ action: 'set-max-alts', maxAlts: 2 }), 'test')).message).toMatch(/already holds at most 2/);
    expect((await applyControl(deps2, parseControl({ action: 'set-max-alts', maxAlts: 4 }), 'test')).message).toMatch(/up to 4 altcoin trades/);
    const h = await loadAltsCap(own);
    expect(altsCapAt(h, t0 - 1)).toBeNull(); // before the change: the config's 2
    expect(altsCapAt(h, t0)).toBe(4);
    expect((await recentControlEvents(own, 5)).some((e) => e.action === 'set-max-alts')).toBe(true);
    expect(() => parseControl({ action: 'set-max-alts', maxAlts: 0 })).toThrow(/1 to 10/);
    expect(() => parseControl({ action: 'set-max-alts', maxAlts: 2.5 })).toThrow(/1 to 10/);
    await dropOwn();
  });


  test('RSI filter per strategy: dated, validated, off by default, logged', async () => {
    const { rsiFilterAt, rsiFilterNow, loadRsiFilters } = await import('../src/rsiFilter');
    const { pool: own, drop: dropOwn } = await freshSchema();
    await migrate(own);
    const d2 = { ...deps, db: own } as ControlDeps;
    expect(rsiFilterNow((await loadRsiFilters(own)).P4H)).toEqual({ on: false, w: 62, d: 70 });
    expect((await applyControl(d2, parseControl({ action: 'set-rsi-filter', scope: 'P4H', on: true, w: 65, d: 72 }), 'test')).message).toMatch(/weekly RSI is at or above 65 or the daily RSI at or above 72/);
    expect((await applyControl(d2, parseControl({ action: 'set-rsi-filter', scope: 'P4H', on: true, w: 65, d: 72 }), 'test')).message).toMatch(/already skips/);
    const h = (await loadRsiFilters(own)).P4H;
    expect(rsiFilterAt(h, t - 1)).toBeNull();
    expect(rsiFilterAt(h, t)).toEqual({ w: 65, d: 72 });
    expect(rsiFilterAt((await loadRsiFilters(own)).HTF, t)).toBeNull(); // other strategies untouched
    expect((await recentControlEvents(own, 5)).some((e) => e.action === 'set-rsi-filter')).toBe(true);
    expect(() => parseControl({ action: 'set-rsi-filter', scope: 'P4H', on: true, w: 40, d: 72 })).toThrow(/between 50 and 95/);
    expect(() => parseControl({ action: 'set-rsi-filter', scope: 'XX', on: true })).toThrow(/scope/);
    await dropOwn();
  });

  test('room-to-TP1 filter per strategy: dated, validated, off by default, logged', async () => {
    const { roomFilterAt, roomFilterNow, loadRoomFilters } = await import('../src/roomFilter');
    const { pool: own, drop: dropOwn } = await freshSchema();
    await migrate(own);
    const d2 = { ...deps, db: own } as ControlDeps;
    expect(roomFilterNow((await loadRoomFilters(own)).P4H)).toEqual({ on: false, mode: 'zones' });
    expect((await applyControl(d2, parseControl({ action: 'set-room-filter', scope: 'P4H', on: true, mode: 'zones' }), 'test')).message).toMatch(/resistance zone/);
    expect((await applyControl(d2, parseControl({ action: 'set-room-filter', scope: 'P4H', on: true, mode: 'zones' }), 'test')).message).toMatch(/already skips/);
    const h = (await loadRoomFilters(own)).P4H;
    expect(roomFilterAt(h, t - 1)).toBeNull();
    expect(roomFilterAt(h, t)).toEqual({ minTouches: 2 });
    expect(roomFilterAt((await loadRoomFilters(own)).HTF, t)).toBeNull();
    expect((await recentControlEvents(own, 5)).some((e) => e.action === 'set-room-filter')).toBe(true);
    expect(() => parseControl({ action: 'set-room-filter', scope: 'P4H', on: true, mode: 'wall' })).toThrow(/zones or swing/);
    await dropOwn();
  });

  test('owner presets apply once through the control actions', async () => {
    const { applyOwnerPresets } = await import('../src/presets');
    const { loadRoomFilters, roomFilterNow } = await import('../src/roomFilter');
    const { loadRsiFilters, rsiFilterNow } = await import('../src/rsiFilter');
    const { loadRrgInfluence, rrgRankNow } = await import('../src/rrgInfluence');
    const { pool: own, drop: dropOwn } = await freshSchema();
    await migrate(own);
    const d2 = { ...deps, db: own } as ControlDeps;
    expect(await applyOwnerPresets(d2)).toEqual(['2026-09-28-p4h-rsi-room-heading', '2026-09-28-p1h-rsi', '2026-09-28-p4h-short55', '2026-09-29-retire-htf', '2026-09-29-htf-crossover-paper']);
    const { loadShortFilters, shortFilterNow, shortFilterAt } = await import('../src/shortFilter');
    expect(shortFilterNow((await loadShortFilters(own)).P4H)).toEqual({ on: true, w: 55 });
    expect(shortFilterAt((await loadShortFilters(own)).P4H, 0)).toBeNull();
    expect(() => parseControl({ action: 'set-short-filter', scope: 'P4H', on: true, w: 20 })).toThrow(/between 30 and 90/);
    expect(rsiFilterNow((await loadRsiFilters(own)).P1H)).toEqual({ on: true, w: 62, d: 70 });
    expect(rsiFilterNow((await loadRsiFilters(own)).P4H)).toEqual({ on: true, w: 62, d: 70 });
    expect(roomFilterNow((await loadRoomFilters(own)).P4H)).toEqual({ on: true, mode: 'zones' });
    expect(rrgRankNow((await loadRrgInfluence(own)).live)).toBe('heading');
    // A later dashboard change survives restarts: the preset is not re-applied.
    await applyControl(d2, parseControl({ action: 'set-room-filter', scope: 'P4H', on: false }), 'test');
    expect(await applyOwnerPresets(d2)).toEqual([]);
    expect(roomFilterNow((await loadRoomFilters(own)).P4H).on).toBe(false);
    await dropOwn();
  });
});
