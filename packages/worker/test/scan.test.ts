// End to end: fake Bitunix → real Postgres → saved, ranked scan.
import { PATHS } from '@bot/bitunix';
import { intervalMs, lastClosedOpenTime, type Candle } from '@bot/marketdata';
import { latestScan, migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { candlesFrom, fakeExchange } from '../../bitunix/test/fakeExchange';
import { SCENARIOS, totalBars, universe, type Segment } from '../../signals/test/fixtures';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { runClose, runScan, silentLogger, type ScanDeps, type WorkerConfig } from '../src/index';

const H = intervalMs('4h');
const NOW = Date.UTC(2026, 8, 26, 16, 30); // the 12:00 4H bar is the last closed one
const BARS = 64;
const pad = (s: ReadonlyArray<Segment>): Segment[] => [{ bars: BARS - totalBars(s), rel: 0 }, ...s];

// Stage-1 fixtures: LEADUSDT turns Improving→Leading on the last closed bar.
const market = universe({ assets: { LEADUSDT: { segments: pad(SCENARIOS.leadingEntry), noiseSeed: 43 }, XRPUSDT: { segments: [{ bars: BARS, rel: 0.0005 }], noiseSeed: 7 } } });
const lastClosed = lastClosedOpenTime('4h', NOW);
const firstOpen = lastClosed - (BARS - 1) * H;

function candlesOf(symbol: string, extraOpenBar = true): Candle[] {
  const s = market[symbol]!;
  const bars = candlesFrom(s.close, firstOpen, H, s.volume ?? undefined);
  // The exchange also serves the still-open bar, with a wild price.
  return extraOpenBar ? [...bars, { ...bars.at(-1)!, openTime: lastClosed + H, close: 1e9, high: 1e9 }] : bars;
}

const config: WorkerConfig = {
  databaseUrl: '', bitunixBaseUrl: undefined, timeframes: ['4h'], historyBars: BARS, universe: 'all',
  minQuoteVolume24h: 1e6, maxExtraSymbols: 10, closeDelayMs: 0, maxFundingAgeMs: 2 * 3_600_000, tradingEnabled: false,
};

describe.skipIf(!TEST_DATABASE_URL)('runScan end to end (Postgres)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, drop } = await freshSchema());
    await migrate(pool);
  });
  afterAll(async () => drop?.());

  const exchange = (over: Partial<Parameters<typeof fakeExchange>[0]> = {}) => fakeExchange({
    candles: Object.fromEntries(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LEADUSDT'].map((s) => [s, { '4h': candlesOf(s) }])),
    tickers: [
      { symbol: 'LEADUSDT', quoteVol: '5e7', lastPrice: '1' },
      { symbol: 'ILLIQUIDUSDT', quoteVol: '10', lastPrice: '1' },
    ],
    funding: [{ symbol: 'LEADUSDT', fundingRate: '-0.0001', fundingInterval: 8, nextFundingTime: String(NOW + H) }],
    ...over,
  });

  test('syncs closed bars, snapshots funding, and saves the ranked watchlist', async () => {
    const ex = exchange();
    const deps: ScanDeps = { client: ex, db: pool, config, log: silentLogger };
    const [summary] = await runClose(deps, ['4h'], NOW);
    expect(summary!.barTime).toBe(lastClosed);
    expect(summary!.symbolsScanned).toBe(4); // core + LEADUSDT; ILLIQUIDUSDT filtered out
    const lead = summary!.watchlist.entries.find((e) => e.symbol === 'LEADUSDT')!;
    expect(lead).toMatchObject({ signal: 'LEADING_ENTRY', firedOn: ['BTC', 'ETH'], tiers: ['MTF'] });
    // Funding -0.0001 per 8h = -10.95%/yr: shorts paying, good for a long.
    expect(lead.filters.funding).toBe('shorts-paying');
    expect(lead.components.funding).toBe(1);

    // The still-open bar was never stored.
    const { rows } = await pool.query(`select count(*)::int as n, max(close) as m from candles where symbol = 'LEADUSDT'`);
    expect(rows[0]).toMatchObject({ n: BARS });
    expect(rows[0].m).toBeLessThan(1e9);

    const saved = await latestScan(pool, '4h');
    expect(saved!.id).toBe(summary!.scanId);
    expect(saved!.entries.map((e) => e.symbol)).toContain('LEADUSDT');
  });

  test('a second run only asks for bars it does not have', async () => {
    const ex = exchange();
    await runScan({ client: ex, db: pool, config, log: silentLogger }, '4h', NOW, ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LEADUSDT']);
    expect(ex.calls.filter((c) => c.path === PATHS.kline)).toEqual([]);
    // Next bar closes: one request per symbol, starting at the new bar.
    const ex2 = exchange();
    await runScan({ client: ex2, db: pool, config, log: silentLogger }, '4h', NOW + H, ['BTCUSDT']).catch(() => {});
    const k = ex2.calls.filter((c) => c.path === PATHS.kline);
    expect(k).toHaveLength(1);
    expect(k[0]!.params.startTime).toBe(lastClosed + H);
  });

  test('funding and ticker outages are not fatal; missing benchmark data is', async () => {
    const warnings: string[] = [];
    const log = { ...silentLogger, warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) };
    const down = exchange({ failing: [PATHS.fundingRateBatch, PATHS.tickers] });
    const done = await runClose({ client: down, db: pool, config, log }, ['4h'], NOW);
    expect(done).toHaveLength(1);
    expect(warnings).toEqual(expect.arrayContaining(['funding: snapshot failed', 'universe: tickers failed, scanning core symbols only']));

    const { pool: empty, drop: dropEmpty } = await freshSchema();
    try {
      await migrate(empty);
      const noEth = exchange({ candles: { BTCUSDT: { '4h': candlesOf('BTCUSDT') } } });
      await expect(runScan({ client: noEth, db: empty, config: { ...config, universe: 'core' }, log: silentLogger }, '4h', NOW))
        .rejects.toThrow(/benchmark data incomplete/);
    } finally {
      await dropEmpty();
    }
  });
});
