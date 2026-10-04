import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { dayTrade } from '../src/screen/wdbltiming';

const D = 86_400_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: i * D, open: o, high: h, low: l, close: c, volume: 1 });

describe('daily trade from an entry price', () => {
  test('stop on the entry day counts; a target on the entry day does not (intraday fill)', () => {
    const c = [bar(0, 100, 130, 89, 95)];
    expect(dayTrade(c, 0, 100, 90, 1, 2, false)!.r).toBeLessThan(-1);
    const c2 = [bar(0, 100, 125, 95, 110), bar(1, 110, 121, 105, 115)];
    const t = dayTrade(c2, 0, 100, 90, 1, 2, false)!;
    expect(t.r).toBeCloseTo(2 - 0.022, 2); // target 120 hit on day 1, not day 0
  });
  test('breakeven after a close at +2R', () => {
    const c = [bar(0, 100, 121, 99, 121), bar(1, 121, 122, 99, 100)];
    expect(dayTrade(c, 0, 100, 90, 1, 0, true)!.r).toBeCloseTo(-0.022, 2);
  });
});
