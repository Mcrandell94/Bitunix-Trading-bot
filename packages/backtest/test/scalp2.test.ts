import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { dirOk, scalp2Signals } from '../src/screen/scalp2';

const H = 3_600_000;
const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ openTime: i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

/** RSI series at 50 with V-shaped dips: a pivot low at each `at` with the given value. */
function series(n: number, dips: [number, number][]): (number | null)[] {
  const r: (number | null)[] = Array.from({ length: n }, () => 50);
  for (const [at, v] of dips) for (let k = -3; k <= 3; k++) r[at + k] = v + Math.abs(k) * 4;
  return r;
}

describe('anchored RSI scalp signals', () => {
  test('deep low 22 then higher lows 35 and 40: one "first" signal at the first higher low, known 2 bars after it', () => {
    const c = flat(400), r = series(400, [[150, 22], [200, 35], [260, 40]]);
    const s = scalp2Signals(c, r, 30).filter((x) => x.d === 1 && x.family === 'hl');
    expect(s.map((x) => [x.b, x.first])).toEqual([[200, true], [260, false]]);
    expect(s[0]!.i).toBe(202); // known when the 2nd bar after the pivot closes; entry at 203's open
    expect(s[0]!.a).toBe(150);
  });
  test('a lower RSI print before B kills the anchor', () => {
    const c = flat(400), r = series(400, [[150, 22], [200, 35]]);
    r[180] = 20; // under the anchor (not a valid new anchor: not a pivot)
    r[179] = 19; r[181] = 21;
    const s = scalp2Signals(c, r, 30).filter((x) => x.d === 1 && x.a === 150);
    expect(s).toHaveLength(0);
  });
  test('the anchor must be the lowest RSI of the 100 bars before it', () => {
    const c = flat(400), r = series(400, [[120, 18], [170, 24], [220, 35]]);
    // 120 is an anchor; 170 (24) is higher than 18 so it is a B for 120, not an anchor itself.
    const s = scalp2Signals(c, r, 30).filter((x) => x.d === 1 && x.family === 'hl');
    expect(s.every((x) => x.a === 120)).toBe(true);
  });
});

describe('direction filter', () => {
  test('sma200 blocks a long when the last closed daily close is under the 200-day SMA', () => {
    const DAY = 24 * H;
    const c = Array.from({ length: 220 }, (_, i) => ({ openTime: i * DAY, open: 100, high: 101, low: 99, close: i < 219 ? 100 : 90, volume: 1 }));
    const sma = c.map((_, i) => (i >= 199 ? 100 : null));
    const t = 220 * DAY; // all 220 days closed
    expect(dirOk('sma200', 1, t, { c, sma }, { c: [], r: [] })).toBe(false);
    expect(dirOk('sma200', -1, t, { c, sma }, { c: [], r: [] })).toBe(true);
    expect(dirOk('sma200', 1, 219 * DAY, { c, sma }, { c: [], r: [] })).toBe(false); // day 218 close 100 = SMA, not above
  });
});
