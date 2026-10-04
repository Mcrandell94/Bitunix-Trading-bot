import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { waveTrend, wtCrosses } from '../src/screen/wavetrend';

const wave = (n: number): Candle[] => Array.from({ length: n }, (_, i) => {
  const p = 100 + 10 * Math.sin(i / 8);
  return { openTime: i, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 };
});

describe('WaveTrend [LazyBear]', () => {
  test('matches a direct computation of the Pine formula', () => {
    const c = wave(200), { wt1, wt2 } = waveTrend(c);
    // Direct: EMA seeded with the first value, as Pine.
    const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); const o: number[] = []; xs.forEach((x, i) => o.push(i === 0 || !Number.isFinite(o[i - 1]!) ? x : x * k + o[i - 1]! * (1 - k))); return o; }; // bar 0 has no deviation (0 / 0): seed after it
    const ap = c.map((b) => (b.high + b.low + b.close) / 3), esa = ema(ap, 10), d = ema(ap.map((x, i) => Math.abs(x - esa[i]!)), 10);
    const ci = ap.map((x, i) => (x - esa[i]!) / (0.015 * d[i]!)), tci = ema(ci, 21);
    // Early bars differ only by the warm-up; by bar 150 the two agree.
    expect(wt1[150]).toBeCloseTo(tci[150]!, 1);
    expect(wt2[150]).toBeCloseTo((tci[147]! + tci[148]! + tci[149]! + tci[150]!) / 4, 1);
  });
  test('crosses alternate on a sine wave and sit below zero for longs at the troughs', () => {
    const c = wave(400), { wt1, wt2 } = waveTrend(c), xs = wtCrosses(wt1, wt2).filter((x) => x.i > 100);
    expect(xs.length).toBeGreaterThan(4);
    for (let k = 1; k < xs.length; k++) expect(xs[k]!.d).toBe(-xs[k - 1]!.d as 1 | -1);
    expect(xs.filter((x) => x.d === 1).every((x) => x.level < 0)).toBe(true);
  });
});
