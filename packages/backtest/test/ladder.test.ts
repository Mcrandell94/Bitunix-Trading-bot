import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { ladderTrade } from '../src/screen/sdtest';

const bar = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 1 });

describe('scaled entry 10/20/30%', () => {
  test('all three fill, then the 3R target from the planned average: +3R less costs', () => {
    // Long, stop 80, levels 99/98/97 (avg 98, unit 18, target 152).
    const c = [bar(0, 100, 101, 99.5, 100), bar(1, 100, 100, 96.5, 97), bar(2, 97, 160, 97, 155), bar(3, 155, 155, 150, 150)];
    const t = ladderTrade(c, c.map(() => 1), 0, 20, [99, 98, 97], 80, 1, 3, '3R', 0)!;
    expect(t.fills).toBe(3);
    expect(t.r).toBeCloseTo(3, 6);
  });
  test('fills on the way to the stop count; a single fill risks a third', () => {
    const c = [bar(0, 100, 101, 98.8, 99), bar(1, 99, 99, 79, 79), bar(2, 79, 80, 78, 79)];
    const t = ladderTrade(c, c.map(() => 1), 0, 20, [99, 98, 97], 80, 1, 3, '3R', 0)!;
    // Bar 1 fills 98 and 97 too before the stop: all three, -1R.
    expect(t.fills).toBe(3);
    expect(t.r).toBeCloseTo(-1, 6);
    const c2 = [bar(0, 100, 101, 98.8, 99), bar(1, 99, 120, 99, 119), bar(2, 119, 160, 119, 155)];
    const t2 = ladderTrade(c2, c2.map(() => 1), 0, 20, [99, 98, 97], 80, 1, 3, '3R', 0)!;
    expect(t2.fills).toBe(1);
    expect(t2.r).toBeCloseTo((152 - 99) / 54, 6);
  });
  test('no order reached within the wait: no trade', () => {
    const c = [bar(0, 100, 101, 99.5, 100), bar(1, 100, 110, 100, 110)];
    expect(ladderTrade(c, c.map(() => 1), 0, 2, [99, 98, 97], 80, 1, 2, '3R', 0)).toBeNull();
  });
});
