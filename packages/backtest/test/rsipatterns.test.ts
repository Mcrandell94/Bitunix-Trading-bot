import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { rsiPatterns } from '../src/screen/rsipatterns';

const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
const atr = (n: number) => Array.from({ length: n }, () => 1);

describe('RSI pattern catalogue', () => {
  test('oversold reclaim fires on the close back above 30; the short mirror on the close back under 70', () => {
    const r: (number | null)[] = Array.from({ length: 40 }, () => 50);
    r[10] = 28; r[11] = 25; r[12] = 31; // long reclaim at 12
    r[20] = 72; r[21] = 75; r[22] = 69; // short at 22
    const e = rsiPatterns(flat(40), r, atr(40));
    expect(e.filter((x) => x.pat === 'oversold reclaim').map((x) => [x.i, x.d])).toEqual([[12, 1], [22, -1]]);
    const long = e.find((x) => x.d === 1 && x.pat === 'oversold reclaim')!;
    expect(long.stop).toBeCloseTo(99 - 0.2, 6);
    expect(e.find((x) => x.d === -1 && x.pat === 'oversold reclaim')!.stop).toBeCloseTo(101 + 0.2, 6);
  });
  test('failure swing: under 30, interim high 42, pullback to 35 (above 30), then a close above 42', () => {
    const r: (number | null)[] = Array.from({ length: 40 }, () => 50);
    const seq = [45, 28, 25, 33, 42, 38, 35, 40, 43];
    seq.forEach((v, k) => { r[5 + k] = v; });
    const e = rsiPatterns(flat(40), r, atr(40)).filter((x) => x.d === 1);
    expect(e.find((x) => x.pat === 'failure swing')?.i).toBe(13);
    expect(e.some((x) => x.pat === 'double bottom')).toBe(false);
  });
  test('double bottom: the second trough dips under 30 but stays above the first; a lower low resets', () => {
    const r: (number | null)[] = Array.from({ length: 40 }, () => 50);
    [45, 26, 22, 33, 41, 35, 28, 34, 42].forEach((v, k) => { r[5 + k] = v; });
    expect(rsiPatterns(flat(40), r, atr(40)).find((x) => x.d === 1 && x.pat === 'double bottom')?.i).toBe(13);
    const r2 = [...r];
    r2[11] = 20; // second trough under the first: no signal from the first trough
    expect(rsiPatterns(flat(40), r2, atr(40)).some((x) => x.d === 1 && (x.pat === 'double bottom' || x.pat === 'failure swing'))).toBe(false);
  });
});
