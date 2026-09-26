// Paper trading end to end: fake Bitunix → real Postgres → replayed engine.
import { runBacktest } from '@bot/backtest';
import { activePaperSession, loadDashboard, migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeExchange } from '../../bitunix/test/fakeExchange';
import { START } from '../../backtest/test/market';
import { syntheticMarket } from '../../backtest/test/synthetic';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { loadPaperData, paperStep, sessionConfig, silentLogger, type PaperDeps } from '../src/index';

const DAY = 86_400_000;
const market = syntheticMarket(120, 5);
const symbols = Object.keys(market);

const exchange = () => fakeExchange({
  // Mark-price requests get the same candles (the fake ignores `type`).
  candles: Object.fromEntries(symbols.map((s) => [s, market[s]!.candles])),
  tickers: [
    { symbol: 'SOLUSDT', quoteVol: '9e8', lastPrice: '150' },
    { symbol: 'DOGEUSDT', quoteVol: '5e8', lastPrice: '0.2' },
  ],
  tradingPairs: symbols.map((symbol) => ({ symbol, basePrecision: 3, minTradeVolume: '0.001', isApiSupported: true })),
  fundingHistory: Object.fromEntries(symbols.map((s) => [s,
    Array.from({ length: 360 }, (_, i) => ({ fundingTime: START + i * 8 * 3_600_000, fundingRate: '0.0001' }))])),
});

describe.skipIf(!TEST_DATABASE_URL)('paper trading (Postgres)', { timeout: 120_000 }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let deps: PaperDeps;
  beforeAll(async () => {
    ({ pool, drop } = await freshSchema());
    await migrate(pool);
    deps = { client: exchange(), db: pool, log: silentLogger, codeSha: 'abc123', paper: { startEquity: 10_000, extras: 10, minQuoteVolume24h: 1e7 } };
  });
  afterAll(async () => drop?.());

  const startAt = START + 10 * DAY + 5 * 60_000; // 5 minutes past a quarter hour
  const later = START + 120 * DAY;

  test('the first step starts a session with a frozen universe and config', async () => {
    const r = await paperStep(deps, startAt);
    expect(r.session).toMatchObject({ startedAt: START + 10 * DAY, startEquity: 10_000, codeSha: 'abc123' });
    expect(r.session.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT']);
    expect(r.session.config).toMatchObject({ targetFill: 'maker', minStopPct: 0 });
    expect(r.result.trades).toEqual([]); // nothing has happened yet
  });

  test('a later step replays the engine and matches a backtest over the same data exactly', async () => {
    const r = await paperStep(deps, later);
    expect(r.session.id).toBe((await activePaperSession(pool))!.id);
    expect(r.result.trades.length).toBeGreaterThan(0);
    expect(r.newTrades).toBe(r.result.trades.length);

    const data = await loadPaperData(pool, r.session);
    const replay = runBacktest(data, sessionConfig(r.session, later), undefined, { closeAtEnd: false });
    expect(replay.trades).toEqual(r.result.trades);
    expect(replay.open).toEqual(r.result.open);

    const { rows } = await pool.query('select count(*)::int as n, sum(net_usd) as net from paper_trades');
    expect(rows[0].n).toBe(r.result.trades.length);
    expect(rows[0].net).toBeCloseTo(r.result.trades.reduce((a, t) => a + t.netPnl, 0), 6);
    const pos = await pool.query('select count(*)::int as n from paper_positions');
    expect(pos.rows[0].n).toBe(r.result.open.positions.length);
    const eq = await pool.query('select count(*)::int as n from paper_equity');
    expect(eq.rows[0].n).toBe(2);
  });

  test('the dashboard reads the session back', async () => {
    const session = (await activePaperSession(pool))!;
    const d = await loadDashboard(pool);
    expect(d.session).toEqual(session);
    expect(d.equity).toHaveLength(2);
    expect(d.lastStepAt).toBe(later);
    expect(d.equity[0]).toEqual({ time: startAt - 5 * 60_000, realized: 10_000, total: 10_000 });
    const { rows } = await pool.query('select count(*)::int as n, sum(net_usd) as net, sum(r) as r from paper_trades');
    expect(d.summary.trades).toBe(rows[0].n);
    expect(d.summary.netUsd).toBeCloseTo(rows[0].net, 6);
    expect(d.summary.totalR).toBeCloseTo(rows[0].r, 6);
    expect(d.trades).toHaveLength(Math.min(rows[0].n, 200));
    expect(d.trades[0]!.closedAt).toBeGreaterThanOrEqual(d.trades.at(-1)!.closedAt); // newest first
    expect(typeof d.trades[0]!.openedAt).toBe('number');
    const pos = await pool.query('select count(*)::int as n from paper_positions');
    expect(d.positions).toHaveLength(pos.rows[0].n);
  });

  test('recorded trades are never rewritten', async () => {
    await pool.query('update paper_trades set net_usd = 999 where ctid = (select ctid from paper_trades limit 1)');
    const r = await paperStep(deps, later);
    expect(r.newTrades).toBe(0);
    const { rows } = await pool.query('select count(*)::int as n from paper_trades where net_usd = 999');
    expect(rows[0].n).toBe(1);
  });
});
