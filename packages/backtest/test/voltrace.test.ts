import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { volTrace } from '../src/screen/voltrace';

const H4 = 4 * 3_600_000;
const bar = (k: number, close: number, coins: number, hi = close + 1, lo = close - 1): Candle => ({ openTime: k * H4, open: close, high: hi, low: lo, close, volume: coins * (hi + lo + close) / 3 });

describe('Dynamic Volume Trace Profile [ChartPrime]', () => {
  test('24 traces over the 100-bar range; each sums the volume of closes within a step over 200 bars; the POC', () => {
    // 150 quiet bars at 100 (outside the last 100 bars' range only by their closes), then 100 bars between 0 and 250.
    const c: Candle[] = [];
    for (let k = 0; k < 150; k++) c.push(bar(k, 100, 1));
    for (let k = 150; k < 250; k++) c.push(bar(k, k === 150 ? 0 : k === 151 ? 250 : 130, k === 200 ? 50 : 2, k === 151 ? 250 : undefined, k === 150 ? 0 : undefined));
    const p = volTrace(c, 249);
    expect([p.lo, p.hi, p.step]).toEqual([0, 250, 10]);
    expect(p.traces.map((x) => x.price)).toEqual(Array.from({ length: 24 }, (_, i) => 10 * (i + 1)));
    const at = (x: number) => p.traces.find((t) => t.price === x)!;
    // Closes at 100 in the 200-bar window: bars 50..149 (100 bars, 1 coin each) count for the traces at 90, 100 and 110.
    expect(at(100).vol).toBeCloseTo(100, 9);
    expect(at(90).vol).toBeCloseTo(100, 9);
    // Closes at 130: 98 bars, 2 coins each, bar 200 with 50: traces 120, 130, 140.
    expect(at(130).vol).toBeCloseTo(97 * 2 + 50, 9);
    expect(at(130).poc && at(120).poc && at(140).poc).toBe(true);
    expect(at(130).pct).toBe(100);
    expect(at(100).pct).toBeCloseTo((100 / 244) * 100, 9);
    expect(at(240).vol).toBeCloseTo(2, 9); // the close at 250 is within a step of 240
    expect(at(60).vol).toBe(0);
  });

  test('no look-ahead: bars after `at` change nothing', () => {
    let s = 11, p = 2000;
    const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const c: Candle[] = Array.from({ length: 600 }, (_, k) => { p += (r() - 0.5) * 30; return bar(k, p, 1 + 5 * r(), p + r() * 8, p - r() * 8); });
    expect(volTrace(c, 400)).toEqual(volTrace(c.slice(0, 401), 400));
    expect(volTrace(c, 400)).not.toEqual(volTrace(c, 450));
  });
});
