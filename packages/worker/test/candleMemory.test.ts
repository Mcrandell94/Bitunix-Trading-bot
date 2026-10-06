import { afterEach, describe, expect, test } from 'vitest';
import type { BitunixClient } from '@bot/bitunix';
import type { RsiSignalRow } from '@bot/backtest';
import type { Candle } from '@bot/marketdata';
import { loadCandles, migrate, saveSnapshot, upsertCandles } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { backfillLoop, candles, download, isReady, memoryStats, nextToDownload, resetMemory, setWanted, update } from '../src/candleMemory';
import { silentLogger } from '../src/index';
import { cleanCandleTables, refreshRsi10Signals, refreshRsiSignals, resetDbCleaned, wantCoins } from '../src/rsiSignals';

const M15 = 15 * 60_000, H = 3_600_000, DAY = 86_400_000, NOW = Date.UTC(2026, 9, 6, 12) + 60_000;
const MS: Record<string, number> = { '15m': M15, '1h': H, '4h': 4 * H, '1d': DAY };

/** A fake exchange: flat candles for every coin and timeframe; counts kline requests; `down` coins fail. */
function fakeClient(down = new Set<string>()) {
  const calls: { symbol: string; interval: string }[] = [];
  const client: BitunixClient = {
    get: async <T,>(_p: string, q?: Record<string, unknown>) => {
      const { symbol, interval, startTime, endTime } = q as { symbol: string; interval: string; startTime: number; endTime: number };
      if (down.has(symbol)) throw new Error('exchange down');
      calls.push({ symbol, interval });
      const out = [];
      for (let t = Math.ceil(startTime / MS[interval]!) * MS[interval]!; t <= endTime; t += MS[interval]!) out.push({ time: t, open: 1, high: 1, low: 1, close: 1 });
      return out as T;
    },
  };
  return { client, calls };
}
const row = (symbol: string, o: Partial<RsiSignalRow> = {}): RsiSignalRow => ({
  symbol, model: 'bottom-div', variant: 0, exitName: 'x', side: 'long', signalAt: 1, status: 'open', entry: 1, enteredAt: 1, stop: 0.9,
  target: 2, lastPrice: 1, r: 0, exit: null, until: null, closedAt: null, stopPct: 10, plans: ['option 1'], ...o,
});

afterEach(() => resetMemory());

describe('candles in memory', () => {
  test('a coin is ready only once every timeframe is in; later updates fetch only the bars that closed', async () => {
    const { client, calls } = fakeClient();
    setWanted(['AUSDT', 'BUSDT']);
    expect(nextToDownload(NOW)).toBe('AUSDT');
    await download(client, 'AUSDT', NOW);
    expect(isReady('AUSDT')).toBe(true);
    expect(nextToDownload(NOW)).toBe('BUSDT');
    const d1 = candles('AUSDT', '1d', 0, NOW);
    expect(d1).toHaveLength(1100); // 3 years of daily
    expect(d1.at(-1)!.openTime + DAY).toBeLessThanOrEqual(NOW); // closed bars only
    expect(candles('AUSDT', '15m', 0, NOW)).toHaveLength(75 * 96);
    calls.length = 0;
    await update(client, 'AUSDT', ['15m', '1h', '4h', '1d'], NOW + M15);
    expect(calls.map((c) => c.interval)).toEqual(['15m']); // nothing else closed
    expect(candles('AUSDT', '15m', 0, NOW + M15)).toHaveLength(75 * 96); // one new bar, one trimmed
    expect(memoryStats()).toMatchObject({ ready: 1, wanted: 2 });
    setWanted(['BUSDT']); // A left the list: its candles are freed
    expect(isReady('AUSDT')).toBe(false);
  });

  test('the background download fetches wanted coins in order and retries a failed one later', async () => {
    const { client } = fakeClient(new Set(['BADUSDT']));
    setWanted(['BADUSDT', 'AUSDT']);
    const stop = new AbortController();
    let idles = 0;
    await backfillLoop({ client, log: silentLogger }, stop.signal, { now: () => NOW, idle: async () => { if (++idles >= 1) stop.abort(); } });
    expect(isReady('AUSDT')).toBe(true);
    expect(isReady('BADUSDT')).toBe(false);
    expect(nextToDownload(NOW)).toBeNull(); // BAD waits before another try
    expect(nextToDownload(NOW + 31 * 60_000)).toBe('BADUSDT');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('signals from memory (Postgres)', { timeout: 120_000 }, () => {
  test('database candles removed; only ready coins checked; others keep their rows except entry signals', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      resetDbCleaned();
      for (const tf of ['15m', '1h', '4h', '1d'] as const) await upsertCandles(pool, 'OLDUSDT', tf, [{ openTime: NOW - 10 * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 } as Candle]);
      await cleanCandleTables({ db: pool, log: silentLogger });
      for (const tf of ['15m', '1h', '4h', '1d'] as const) expect((await loadCandles(pool, tf, ['OLDUSDT'], 0)).OLDUSDT).toEqual([]);

      const { client } = fakeClient();
      const deps = { client, db: pool, log: silentLogger };
      const order = await wantCoins(deps, ['AUSDT', 'BUSDT']);
      expect(order[0]).toBe('BTCUSDT');
      await download(client, 'BTCUSDT', NOW);
      await download(client, 'AUSDT', NOW);
      const prev = [row('AUSDT'), row('BUSDT'), row('BUSDT', { status: 'enter', signalAt: 2 }), row('BUSDT', { model: '15m-rsi10', status: 'enter' }), row('BUSDT', { model: '15m-rsi10', signalAt: 3 })];
      await saveSnapshot(pool, 'rsi-signals', { time: 0, coins: 0, rows: prev });
      const a = await refreshRsiSignals(deps, NOW, order);
      expect(a.coins).toBe(2); // BTC and A (flat candles: no setups)
      const fw = a.rows.filter((r) => r.model !== '15m-rsi10');
      expect(fw).toEqual([row('BUSDT')]); // A re-checked (row gone), B kept but not its entry signal
      const b = (await refreshRsi10Signals(deps, NOW, order, a))!;
      expect(b.fastCoins).toBe(2);
      expect(b.rows.filter((r) => r.model === '15m-rsi10')).toEqual([row('BUSDT', { model: '15m-rsi10', signalAt: 3 })]);
      expect(b.loading).toEqual({ ready: 2, wanted: 3, candles: expect.any(Number) });
    } finally {
      await drop();
    }
  });
});
