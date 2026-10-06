import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { loadCandles, migrate, upsertCandles } from '@bot/store';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { silentLogger } from '../src/index';
import { PRUNE_EVERY_MS, pruneFastCandles } from '../src/rsiSignals';

const DAY = 86_400_000, NOW = Date.UTC(2026, 9, 6);
const bar = (t: number): Candle => ({ openTime: t, open: 1, high: 1, low: 1, close: 1, volume: 1 });

describe.skipIf(!TEST_DATABASE_URL)('15m / 1h candle pruning (Postgres)', { timeout: 60_000 }, () => {
  test('keeps the 75 days (+2 slack) the model needs, leaves 4H / daily alone, runs at most every 6 hours', async () => {
    const { pool, drop } = await freshSchema();
    try {
      await migrate(pool);
      const old = NOW - 80 * DAY, kept = NOW - 76 * DAY;
      for (const tf of ['15m', '1h', '4h'] as const) await upsertCandles(pool, 'SOLUSDT', tf, [bar(old), bar(kept)]);
      const deps = { db: pool, log: silentLogger, client: null as never };
      expect(await pruneFastCandles(deps, NOW, true)).toBe(2);
      for (const tf of ['15m', '1h'] as const) expect((await loadCandles(pool, tf, ['SOLUSDT'], 0)).SOLUSDT!.map((c) => c.openTime)).toEqual([kept]);
      expect((await loadCandles(pool, '4h', ['SOLUSDT'], 0)).SOLUSDT).toHaveLength(2);
      await upsertCandles(pool, 'SOLUSDT', '15m', [bar(old)]);
      expect(await pruneFastCandles(deps, NOW + 15 * 60_000)).toBe(0); // too soon
      expect(await pruneFastCandles(deps, NOW + PRUNE_EVERY_MS)).toBe(1);
    } finally {
      await drop();
    }
  });
});
