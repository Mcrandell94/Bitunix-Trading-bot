import { describe, expect, test } from 'vitest';
import type { BitunixClient } from '@bot/bitunix';
import type { RsiSignalRow } from '@bot/backtest';
import type { Candle } from '@bot/marketdata';
import { loadCandles, migrate, upsertCandles } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { silentLogger } from '../src/index';
import { RSI10_NEW_PER_WAKE, refreshRsi10Signals, resetRsi10Memory, rsi10Memory } from '../src/rsiSignals';

const M15 = 15 * 60_000, DAY = 86_400_000, NOW = Date.UTC(2026, 9, 6, 12) + 60_000;
const bar = (t: number): Candle => ({ openTime: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });

/** A fake exchange: flat candles for every coin and timeframe; counts kline requests. */
function fakeClient() {
  const calls: { symbol: string; interval: string; startTime: number }[] = [];
  const ms: Record<string, number> = { '15m': M15, '1h': 4 * M15, '4h': 16 * M15, '1d': DAY };
  const client: BitunixClient = {
    get: async <T,>(_p: string, q?: Record<string, unknown>) => {
      const { symbol, interval, startTime, endTime } = q as { symbol: string; interval: string; startTime: number; endTime: number };
      if (symbol === 'BADUSDT') throw new Error('exchange down');
      calls.push({ symbol, interval, startTime });
      const out = [];
      for (let t = Math.ceil(startTime / ms[interval]!) * ms[interval]!; t <= endTime; t += ms[interval]!) out.push({ time: t, open: 1, high: 1, low: 1, close: 1 });
      return out as T;
    },
  };
  return { client, calls };
}
const row = (symbol: string): RsiSignalRow => ({
  symbol, model: '15m-rsi10', variant: 0, exitName: '10R target, no time stop', side: 'long', signalAt: 1, status: 'open', entry: 1, enteredAt: 1, stop: 0.9,
  target: 2, lastPrice: 1, r: 0, exit: null, until: null, closedAt: null, stopPct: 10, plans: ['option 1'],
});

describe.skipIf(!TEST_DATABASE_URL)('15M-RSI10 candles in memory (Postgres)', { timeout: 120_000 }, () => {
  test('clears the old 15m / 1h rows, downloads new coins in batches, then only new bars; unchecked coins keep their rows', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      resetRsi10Memory();
      for (const tf of ['15m', '1h', '4h'] as const) await upsertCandles(pool, 'OLDUSDT', tf, [bar(NOW - 10 * DAY)]);
      const { client, calls } = fakeClient();
      const deps = { client, db: pool, log: silentLogger };
      const list = Array.from({ length: RSI10_NEW_PER_WAKE + 5 }, (_, i) => `C${i}USDT`);
      const snap = { time: 0, coins: 0, rows: [row('C29USDT'), row('BADUSDT')] };

      const a = (await refreshRsi10Signals(deps, NOW, list, snap))!;
      // Coins with rows go first (C29 although it is last in the list); BADUSDT fails and keeps its row; flat candles give no setup.
      expect(rsi10Memory().coins).toBe(RSI10_NEW_PER_WAKE - 1);
      expect(calls.some((c) => c.symbol === 'C29USDT')).toBe(true);
      expect(a.fastCoins).toBe(RSI10_NEW_PER_WAKE - 1);
      expect(a.rows.map((r) => r.symbol)).toEqual(['BADUSDT']);
      for (const tf of ['15m', '1h'] as const) expect((await loadCandles(pool, tf, ['OLDUSDT'], 0)).OLDUSDT).toEqual([]);
      expect((await loadCandles(pool, '4h', ['OLDUSDT'], 0)).OLDUSDT).toHaveLength(1); // 4H / daily stay in the database

      calls.length = 0;
      const b = (await refreshRsi10Signals(deps, NOW + M15, list, a))!;
      expect(rsi10Memory().coins).toBe(list.length);
      expect(b.rows.map((r) => r.symbol)).toEqual(['BADUSDT']);
      // Coins already in memory: one 15m request each (the 1h / 4h / daily bars have not closed again).
      const known = calls.filter((c) => c.symbol === 'C1USDT');
      expect(known.map((c) => c.interval)).toEqual(['15m']);
      expect(rsi10Memory().candles).toBeLessThan(list.length * 12_000);
      // A coin that leaves the list is dropped from memory.
      await refreshRsi10Signals(deps, NOW + 2 * M15, list.slice(1), b);
      expect(rsi10Memory().coins).toBe(list.length - 1);
    } finally {
      resetRsi10Memory();
      await drop();
    }
  });
});
