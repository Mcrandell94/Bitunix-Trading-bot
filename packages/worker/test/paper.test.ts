// Paper trading end to end: fake Bitunix → real Postgres → replayed engine.
import { runBacktest } from '@bot/backtest';
import { activePaperSession, loadDashboard, migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeExchange } from '../../bitunix/test/fakeExchange';
import { START } from '../../backtest/test/market';
import { syntheticMarket } from '../../backtest/test/synthetic';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { applyControl, loadPaperData, paperStep, parseControl, sessionConfig, silentLogger, type PaperDeps } from '../src/index';

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
    deps = { client: exchange(), db: pool, log: silentLogger, codeSha: 'abc123', paper: { startEquity: 10_000, extras: 10, minQuoteVolume24h: 1e7 }, model: 'mtf' };
  });
  afterAll(async () => drop?.());

  const startAt = START + 10 * DAY + 5 * 60_000; // 5 minutes past a quarter hour
  const later = START + 120 * DAY;

  test('the first step starts a session with a frozen universe and config', async () => {
    const r = await paperStep(deps, startAt);
    expect(r.session).toMatchObject({ startedAt: START + 10 * DAY, startEquity: 10_000, codeSha: 'abc123' });
    expect(r.session.symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT']);
    expect(r.session.config).toMatchObject({ targetFill: 'maker', minStopPct: 0.5, botModel: 'mtf' });
    expect(r.result.trades).toEqual([]); // nothing has happened yet
  });

  test('a later step replays the engine and matches a backtest over the same data exactly', async () => {
    const r = await paperStep(deps, later);
    expect(r.session.id).toBe((await activePaperSession(pool))!.id);
    expect(r.result.trades.length).toBeGreaterThan(0);
    expect(r.newTrades).toBe(r.result.trades.length);

    const data = await loadPaperData(pool, r.session);
    const replay = runBacktest(data, sessionConfig(r.session, later, 'mtf'), undefined, { closeAtEnd: false, radar: true, entriesBlocked: () => null });
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
    // Per strategy (tier): adds up to the session totals.
    expect(d.byTier.reduce((a, x) => a + x.trades, 0)).toBe(d.summary.trades);
    expect(d.byTier.reduce((a, x) => a + x.totalR, 0)).toBeCloseTo(d.summary.totalR, 6);
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

  test('a new model in the code ends the session (trades kept) and starts one under that model', async () => {
    const before = (await activePaperSession(pool))!;
    const r = await paperStep({ ...deps, model: 'ema50' }, later + 15 * 60_000);
    expect(r.session.id).not.toBe(before.id);
    expect(r.session.config).toMatchObject({ botModel: 'ema50' });
    const { rows } = await pool.query('select count(*)::int as n from paper_trades where session_id = $1', [before.id]);
    expect(rows[0].n).toBeGreaterThan(0);
    // Same model next step: same session. RRG switches: both off by default, so one replay serves paper and live.
    const again = await paperStep({ ...deps, model: 'ema50', liveReplay: true }, later + 30 * 60_000);
    expect(again.session.id).toBe(r.session.id);
    expect(again.liveResult).toBeUndefined();
    // Switched on for paper only: live gets its own replay under its own switch.
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => later }, parseControl({ action: 'rrg-on', scope: 'paper' }), 'test');
    expect((await paperStep({ ...deps, model: 'ema50', liveReplay: true }, later + 30 * 60_000)).liveResult).toBeDefined();
    // One strategy switched to use the card: the replay runs with it (the others stay first come, first served).
    await applyControl({ db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => later }, parseControl({ action: 'rank-slot-on', scope: 'P4H' }), 'test');
    expect((await paperStep({ ...deps, model: 'ema50', liveReplay: true }, later + 30 * 60_000)).liveResult).toBeDefined();
    expect((await paperStep({ ...deps, model: 'ema50' }, later + 45 * 60_000)).liveResult).toBeUndefined(); // no live replay asked
    const logged = await pool.query('select count(*)::int as n from paper_trades where session_id = $1 and rrg is null', [r.session.id]);
    expect(logged.rows[0].n).toBe(0); // every EMA 50 paper trade records RRG at entry
  });
});

test('radar top: active rows in the dashboard order, blocked ones left out', async () => {
  const { radarTop } = await import('../src/paper');
  const row = (symbol: string, tier: string, status: string, note: string, gates: string[] = []) =>
    ({ symbol, tier, status, note, gates, core: false, bias: { combined: 'long', byTf: [] }, rrg: null, watch: null, recentRejections: [] }) as never;
  const top = radarTop([
    row('ZECUSDT', 'MTF', 'ready', 'in a daily long trend already'),
    row('BTCUSDT', 'MTF', 'blocked', 'no daily trend'),
    row('SOLUSDT', 'P4H', 'watching', '4H pullback long signal on the last 4h close', ['paused from the dashboard']),
    row('ETHUSDT', 'HTF', 'in-position', 'long open from 4000'),
  ], 2);
  expect(top).toEqual([
    'ETHUSDT HTF in-position: long open from 4000',
    'SOLUSDT P4H watching: 4H pullback long signal on the last 4h close (blocked now by: paused from the dashboard)',
  ]);
  // Coins in a trend: strongest daily RRG vs BTC the trade's way first, not alphabetical.
  const scored = (symbol: string, score: number) => ({ ...(row(symbol, 'MTF', 'ready', 'in a daily long trend already') as object), score }) as never;
  expect(radarTop([scored('AAVEUSDT', -0.4), scored('ZECUSDT', 1.25), scored('ADAUSDT', 0.3)], 3)).toEqual([
    'ZECUSDT MTF ready (RRG +1.25): in a daily long trend already',
    'ADAUSDT MTF ready (RRG +0.3): in a daily long trend already',
    'AAVEUSDT MTF ready (RRG -0.4): in a daily long trend already',
  ]);
});
