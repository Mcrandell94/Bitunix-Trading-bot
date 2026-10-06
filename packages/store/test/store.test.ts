import type { Candle } from '@bot/marketdata';
import type { Watchlist, WatchlistEntry } from '@bot/signals';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  insertFunding, latestFunding, latestOpenTimes, latestScan, loadCandles, migrate, pruneCandles, saveScan,
  upsertCandles, upsertContractSpecs,
} from '../src/index';
import { MIGRATIONS } from '../src/migrations';
import { TEST_DATABASE_URL, freshSchema } from './testDb';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 20);
const bar = (i: number, close: number, volume: number | null = 10): Candle => ({ openTime: T0 + i * H, open: close, high: close + 1, low: close - 1, close, volume });

describe.skipIf(!TEST_DATABASE_URL)('store (Postgres)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ pool, drop } = await freshSchema());
  });
  afterAll(async () => drop?.());

  test('migrate applies everything once, then nothing', async () => {
    expect(await migrate(pool)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await migrate(pool)).toEqual([]);
    // Concurrent starts are serialized by the advisory lock.
    expect(await Promise.all([migrate(pool), migrate(pool)])).toEqual([[], []]);
  });

  test('candles: upsert is idempotent and corrects bars; load is per symbol, oldest first', async () => {
    await upsertCandles(pool, 'BTCUSDT', '1h', [bar(1, 101), bar(0, 100)]);
    await upsertCandles(pool, 'BTCUSDT', '1h', [bar(1, 105, null), bar(2, 102)]);
    await upsertCandles(pool, 'BTCUSDT', '4h', [bar(0, 999)]);
    await upsertCandles(pool, 'ETHUSDT', '1h', [bar(2, 50)]);
    expect(await upsertCandles(pool, 'ETHUSDT', '1h', [])).toBe(0);

    const got = await loadCandles(pool, '1h', ['BTCUSDT', 'ETHUSDT', 'NONEUSDT'], T0 + H);
    expect(got.BTCUSDT).toEqual([bar(1, 105, null), bar(2, 102)]);
    expect(got.ETHUSDT).toEqual([bar(2, 50)]);
    expect(got.NONEUSDT).toEqual([]);
    expect(await latestOpenTimes(pool, '1h', ['BTCUSDT', 'ETHUSDT', 'NONEUSDT'])).toEqual(new Map([['BTCUSDT', T0 + 2 * H], ['ETHUSDT', T0 + 2 * H]]));
    // Prune: only the timeframe asked for, only bars that opened before the cut.
    expect(await pruneCandles(pool, '1h', T0 + 2 * H)).toBe(2);
    expect((await loadCandles(pool, '1h', ['BTCUSDT', 'ETHUSDT'], 0))).toEqual({ BTCUSDT: [bar(2, 102)], ETHUSDT: [bar(2, 50)] });
    expect((await loadCandles(pool, '4h', ['BTCUSDT'], 0)).BTCUSDT).toEqual([bar(0, 999)]);
  });

  test('funding: latest snapshot per symbol', async () => {
    await insertFunding(pool, T0, [{ symbol: 'BTCUSDT', rate: 0.0001, intervalHours: 8, nextFundingTime: T0 + 8 * H, markPrice: 60000 }]);
    await insertFunding(pool, T0 + H, [
      { symbol: 'BTCUSDT', rate: 0.0003, intervalHours: 8, nextFundingTime: null, markPrice: null },
      { symbol: 'XRPUSDT', rate: -0.0001, intervalHours: 4, nextFundingTime: T0 + 4 * H, markPrice: 0.5 },
    ]);
    const f = await latestFunding(pool, ['BTCUSDT', 'XRPUSDT', 'ETHUSDT']);
    expect(f.get('BTCUSDT')).toEqual({ symbol: 'BTCUSDT', rate: 0.0003, intervalHours: 8, nextFundingTime: null, markPrice: null, observedAt: T0 + H });
    expect(f.get('XRPUSDT')).toMatchObject({ rate: -0.0001, intervalHours: 4, nextFundingTime: T0 + 4 * H });
    expect(f.has('ETHUSDT')).toBe(false);
  });

  test('contract specs upsert', async () => {
    const spec = { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: 0.0001, basePrecision: 4, quotePrecision: 1, minLeverage: 1, maxLeverage: 125, raw: { a: 1 } };
    await upsertContractSpecs(pool, [spec]);
    await upsertContractSpecs(pool, [{ ...spec, maxLeverage: 100, raw: { a: 2 } }]);
    const { rows } = await pool.query('select max_leverage, raw from contract_specs');
    expect(rows).toEqual([{ max_leverage: 100, raw: { a: 2 } }]);
  });

  test('scans: saved with ranked entries; re-running the same bar replaces it', async () => {
    const entry = (symbol: string, score: number): WatchlistEntry => ({
      symbol, timeframe: '4h', signal: 'LEADING_ENTRY', direction: 'long', tiers: ['MTF'], core: false, score,
      components: { agreement: 1, velocity: 1, timeInQuadrant: 1, relativeVolume: 1, absoluteTrend: 1, funding: 1 },
      firedOn: ['BTC', 'ETH'], readings: {}, filters: { relativeVolume: null, absoluteTrend: null, funding: null, fundingAnnualizedPct: null },
      reasons: ['vs BTC: Improving→Leading this bar'],
    });
    const wl = (entries: WatchlistEntry[]): Watchlist => ({ timeframe: '4h', entries, skipped: [] });
    const barTime = T0 + 8 * H;
    const first = await saveScan(pool, { timeframe: '4h', barTime, symbolsScanned: 3, dropped: [{ symbol: 'NEWUSDT', reason: 'short' }], watchlist: wl([entry('AUSDT', 80), entry('BUSDT', 60)]) });
    const second = await saveScan(pool, { timeframe: '4h', barTime, symbolsScanned: 3, dropped: [], watchlist: wl([entry('CUSDT', 70)]) });
    expect(second).not.toBe(first);
    const s = await latestScan(pool, '4h');
    expect(s).toMatchObject({ id: second, barTime, symbolsScanned: 3, dropped: [] });
    expect(s!.entries).toEqual([{ rank: 1, symbol: 'CUSDT', signal: 'LEADING_ENTRY', direction: 'long', tiers: ['MTF'], score: 70, firedOn: ['BTC', 'ETH'] }]);
    const { rows } = await pool.query('select count(*)::int as n from watchlist_entries');
    expect(rows[0].n).toBe(1);
    expect(await latestScan(pool, '1d')).toBeNull();
  });
});
