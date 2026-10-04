import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { limitFill } from '../src/screen/ltfcost';
import { scalp2Trade } from '../src/screen/scalp2';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: i * H, open: o, high: h, low: l, close: c, volume: 1 });

describe('maker fill model', () => {
  test('a long limit at the signal close fills only when price trades through it, within the wait', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 102, 100, 101), bar(2, 101, 101, 99.5, 100)];
    expect(limitFill(c, 0, 1, 1)).toBeNull(); // bar 1 touched 100 but did not trade under it
    expect(limitFill(c, 0, 1, 2)).toEqual({ q: 2, px: 100 });
  });
  test('a short limit fills when the high trades over the close', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 100.5, 99, 99.5)];
    expect(limitFill(c, 0, -1, 1)).toEqual({ q: 1, px: 100 });
  });
  test('on the fill bar a stop counts but a target does not', () => {
    // Long filled at 100 inside bar 1; stop 98; 2R target 104. Bar 1 reaches 105 (ignored), bar 2 reaches 104.
    const c = [bar(0, 100, 101, 99, 100), bar(1, 101, 105, 99.5, 103), bar(2, 103, 104.5, 102, 104), bar(3, 104, 104, 103, 103.5)];
    const t = scalp2Trade(c, [], [], 1, 98, 1, 3, '2R', [], 100)!;
    expect(t.gross).toBeCloseTo(2);
    expect(t.end).toBe(2);
    const c2 = [bar(0, 100, 101, 99, 100), bar(1, 101, 105, 97, 103), bar(2, 103, 104, 102, 103), bar(3, 103, 104, 102, 103)];
    expect(scalp2Trade(c2, [], [], 1, 98, 1, 3, '2R', [], 100)!.gross).toBeCloseTo(-1);
  });
});
