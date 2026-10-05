import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { to2h } from '../src/screen/tf2h';

const H = 3_600_000;
const b = (h: number, o: number, hi: number, lo: number, c: number, v = 1): Candle => ({ openTime: h * H, open: o, high: hi, low: lo, close: c, volume: v });

describe('2h candles from 1h', () => {
  test('pairs start on even UTC hours; open of the first, extremes of both, close of the second', () => {
    const c = [b(1, 9, 9, 9, 9), b(2, 10, 12, 9, 11, 2), b(3, 11, 13, 8, 12, 3), b(4, 12, 12, 11, 11), b(6, 5, 5, 5, 5)];
    expect(to2h(c)).toEqual([{ openTime: 2 * H, open: 10, high: 13, low: 8, close: 12, volume: 5 }]); // hour 1 odd; 4 has no 5; 6 alone
  });
});
