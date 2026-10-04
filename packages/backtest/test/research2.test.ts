import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { tripleTopEvents } from '../src/screen/research2';

describe('RSI triple top', () => {
  test('RSI pivots 78 -> 74 -> 70.5 within the span is a triple top; price rule needs the third high near the first', () => {
    const c: Candle[] = Array.from({ length: 60 }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const r: (number | null)[] = c.map(() => 50);
    r[10] = 78; r[20] = 74; r[30] = 70.5;
    c[10] = { ...c[10]!, high: 110 }; c[30] = { ...c[30]!, high: 111 };
    const e = tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, true);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ i: 33, a: 10 });
    c[30] = { ...c[30]!, high: 105 };
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, true)).toHaveLength(0);
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, false)).toHaveLength(1);
    r[30] = 73; // third too strong
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, false)).toHaveLength(0);
  });
});

describe('exit engine', () => {
  test('half at 2R then the rest stopped at breakeven-ish: 0.5 x 2 + 0.5 x rest', async () => {
    const { specTrade } = await import('../src/screen/exits');
    const bar = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 1 });
    // Long from 100, stop 90 (risk 10): high 121 (> 2R = 120), then back down through the stop at 90.
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 121, 100, 118), bar(2, 118, 118, 85, 86)];
    const t = specTrade(c, c.map(() => 1), {}, 0, 90, 1, { name: 'x', partial: 2, trail: { kind: 'atr', k: 5, arm: 1 } }, 0)!;
    // After bar 1 the best close is 118, trail = 118 - 5 = 113 > 90: the rest exits at 113 (+1.3R).
    expect(t.r).toBeCloseTo(0.5 * 2 + 0.5 * 1.3, 6);
  });
  test('a target with no time cap; still open at the end is marked at the last close', async () => {
    const { specTrade } = await import('../src/screen/exits');
    const bar = (i: number, cl: number): Candle => ({ openTime: i, open: cl, high: cl + 1, low: cl - 1, close: cl, volume: 1 });
    const c = [bar(0, 100), bar(1, 105), bar(2, 108)];
    const t = specTrade(c, c.map(() => 1), {}, 0, 90, 1, { name: 'x', target: 10 }, 0)!;
    expect(t.open).toBe(true);
    expect(t.r).toBeCloseTo(0.8, 6);
  });
});

describe('exit engine time cap', () => {
  test('a trade still running at its cap exits at that bar\'s close with how = time', async () => {
    const { specTrade } = await import('../src/screen/exits');
    const bar = (i: number, cl: number): Candle => ({ openTime: i, open: cl, high: cl + 1, low: cl - 1, close: cl, volume: 1 });
    const c = [bar(0, 100), bar(1, 103), bar(2, 104), bar(3, 120)];
    const t = specTrade(c, c.map(() => 1), {}, 0, 90, 1, { name: 'x', target: 10, cap: 3 }, 0)!;
    expect(t.how).toBe('time');
    expect(t.end).toBe(2);
    expect(t.r).toBeCloseTo(0.4, 6);
  });
});
