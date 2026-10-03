import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { scalpSignals, scalpTrade } from '../src/screen/scalp';

const bar = (i: number, cl: number, lo = cl - 0.5, hi = cl + 0.5): Candle => ({ openTime: i, open: cl, high: hi, low: lo, close: cl, volume: 1 });

describe('15m / 1h scalp signals', () => {
  test('a higher RSI low after an oversold low is a long; with a lower price low it is also a divergence', () => {
    const c = Array.from({ length: 40 }, (_, i) => bar(i, 100));
    const r: (number | null)[] = c.map(() => 50);
    r[10] = 22; c[10] = bar(10, 95, 94); // pivot A: RSI 22
    r[25] = 33; c[25] = bar(25, 94, 93); // pivot B: higher RSI, lower price low
    const s = scalpSignals(c, r).filter((x) => x.d === 1 && x.grid === 'loose');
    expect(s.map((x) => x.family).sort()).toEqual(['div', 'hl']);
    expect(s[0]).toMatchObject({ i: 27, b: 25, a: 10 }); // known two bars after the pivot
    expect(scalpSignals(c, r).some((x) => x.grid === 'tight' && x.d === 1)).toBe(true); // 22 <= 25 and 33 <= 35
  });
  test('falling RSI highs from overbought are a short', () => {
    const c = Array.from({ length: 40 }, (_, i) => bar(i, 100));
    const r: (number | null)[] = c.map(() => 50);
    r[10] = 80; c[10] = bar(10, 103, 102, 104); r[25] = 68;
    const s = scalpSignals(c, r).filter((x) => x.d === -1 && x.grid === 'loose');
    expect(s.map((x) => x.family)).toEqual(['hl']); // price high not higher: no divergence
  });
  test('2R target, and the RSI exit at 70', () => {
    const c = [bar(0, 100), bar(1, 101), bar(2, 104, 103, 105), bar(3, 104)];
    const r = [50, 60, 65, 72];
    expect(scalpTrade(c, r, 0, 98, 1, 4, '2R')!.gross).toBeCloseTo(2, 6);
    expect(scalpTrade(c, r, 0, 98, 1, 4, 'RSI')!.gross).toBeCloseTo(2, 6); // exits at the close of bar 3 (RSI 72): +4 / 2
  });
});
