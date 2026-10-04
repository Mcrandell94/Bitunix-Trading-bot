import { describe, expect, test } from 'vitest';
import { adx } from '../src/indicators';
import { capPerDay } from '../src/screen/fixes';

describe('ADX and the per-day cap', () => {
  test('ADX is high with +DI over -DI in a steady uptrend, low in a flat market', () => {
    const up = Array.from({ length: 120 }, (_, i) => ({ openTime: i, open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.8 + i, volume: 1 }));
    const a = adx(up, 14);
    expect(a.adx[119]!).toBeGreaterThan(40);
    expect(a.pdi[119]!).toBeGreaterThan(a.mdi[119]!);
    const flat = Array.from({ length: 120 }, (_, i) => ({ openTime: i, open: 100, high: 101 + (i % 2), low: 99 - (i % 2), close: 100, volume: 1 }));
    expect(adx(flat, 14).adx[119]!).toBeLessThan(15);
  });
  test('capPerDay keeps the 2 earliest-run entries per day and side', () => {
    const D = 86_400_000;
    const ts = [{ t: 0, d: 1 as const, run: 3 }, { t: 10, d: 1 as const, run: 1 }, { t: 20, d: 1 as const, run: 2 }, { t: 30, d: -1 as const, run: 5 }, { t: D, d: 1 as const, run: 9 }];
    const kept = capPerDay(ts, 2);
    expect(kept.filter((x) => x.t < D && x.d === 1).map((x) => x.run).sort()).toEqual([1, 2]);
    expect(kept).toHaveLength(4);
  });
});
