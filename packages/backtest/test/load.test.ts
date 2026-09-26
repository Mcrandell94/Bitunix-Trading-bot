import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { candlesFrom, fakeExchange } from '../../bitunix/test/fakeExchange';
import { loadMarket } from '../src/load';
import { HOUR, Q, START } from './market';

const DAY = 24 * HOUR;
const from = START + 150 * DAY;
const to = START + 160 * DAY;
const series = (ms: number) => candlesFrom(Array.from({ length: Math.ceil((to - START) / ms) + 5 }, (_, i) => 100 + Math.sin(i / 7)), START, ms);

describe('loadMarket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-cache-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ex = fakeExchange({
    candles: { SOLUSDT: { '15m': series(Q), '1h': series(HOUR), '4h': series(4 * HOUR), '1d': series(DAY) } },
    fundingHistory: { SOLUSDT: Array.from({ length: 100 }, (_, i) => ({ fundingTime: to - (i + 1) * 4 * HOUR, fundingRate: '0.01' })) },
    tradingPairs: [{ symbol: 'SOLUSDT', basePrecision: 2, minTradeVolume: '0.1' }],
  });

  test('downloads closed bars with warm-up, mark prices, funding and contract limits', async () => {
    const { data, notes } = await loadMarket({ client: ex, cacheDir: dir, symbols: ['SOLUSDT'], from, to });
    const d = data.SOLUSDT!;
    expect(notes).toEqual([]);
    expect(d.candles['1d']![0]!.openTime).toBe(from - 140 * DAY); // daily warm-up for RRG
    expect(d.candles['15m']!.at(-1)!.openTime).toBe(to - Q); // nothing still open at `to`
    expect(d.mark15m?.length).toBe(d.candles['15m']!.length);
    expect(d.funding![0]).toEqual({ time: expect.any(Number), rate: 0.0001 }); // percent → fraction
    expect(d.fundingIntervalHours).toBe(4);
    expect(d.limits).toEqual({ qtyStep: 0.01, minQty: 0.1 });
  });

  test('a second run is served from the cache', async () => {
    const before = ex.calls.filter((c) => c.path.endsWith('/kline')).length;
    await loadMarket({ client: ex, cacheDir: dir, symbols: ['SOLUSDT'], from, to });
    expect(ex.calls.filter((c) => c.path.endsWith('/kline')).length).toBe(before);
  });

  test('a later end date fetches only the new bars', async () => {
    const before = ex.calls.length;
    await loadMarket({ client: ex, cacheDir: dir, symbols: ['SOLUSDT'], from, to: to + HOUR });
    const klines = ex.calls.slice(before).filter((c) => c.path.endsWith('/kline'));
    expect(klines.every((c) => Number(c.params.startTime) >= to)).toBe(true);
  });
});

describe('loadMarket when a symbol fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bt-cache-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('an extra symbol is skipped with a note; a missing benchmark stops the run', async () => {
    const ok = { '15m': series(Q), '1h': series(HOUR), '4h': series(4 * HOUR), '1d': series(DAY) };
    const broken = [{ open: 'x', high: 1, low: 1, close: 1, time: START }];
    const ex = fakeExchange({ candles: { BTCUSDT: ok, ETHUSDT: ok } });
    const withBroken = { ...ex, get: async <T,>(path: string, params: Record<string, string | number | undefined> = {}) =>
      (params.symbol === 'BADUSDT' ? broken : await ex.get(path, params)) as T };
    const { data, notes } = await loadMarket({ client: withBroken, cacheDir: dir, symbols: ['BTCUSDT', 'ETHUSDT', 'BADUSDT'], from, to });
    expect(Object.keys(data)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(notes.some((n) => n.startsWith('BADUSDT: skipped'))).toBe(true);
    const noEth = { ...ex, get: async <T,>(path: string, params: Record<string, string | number | undefined> = {}) =>
      (params.symbol === 'ETHUSDT' ? broken : await ex.get(path, params)) as T };
    await expect(loadMarket({ client: noEth, cacheDir: mkdtempSync(join(tmpdir(), 'bt-')), symbols: ['BTCUSDT', 'ETHUSDT'], from, to })).rejects.toThrow(/ETHUSDT/);
  });
});
