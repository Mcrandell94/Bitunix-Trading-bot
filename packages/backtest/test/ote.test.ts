import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { ote } from '../src/screen/ote';

const H4 = 4 * 3_600_000;
/** Closes on straight lines between knots (bar, price); high / low 1 either side. */
function path(knots: [number, number][]): Candle[] {
  const out: Candle[] = [];
  for (let s = 0; s < knots.length - 1; s++) {
    const [b0, p0] = knots[s]!, [b1, p1] = knots[s + 1]!;
    for (let k = s === 0 ? b0 : b0 + 1; k <= b1; k++) {
      const cl = p0 + ((p1 - p0) * (k - b0)) / (b1 - b0), op = out.at(-1)?.close ?? cl;
      out.push({ openTime: k * H4, open: op, high: cl + 1, low: cl - 1, close: cl, volume: 1 });
    }
  }
  return out;
}

describe('Fibonacci Entry Zone [OTE]', () => {
  // Down to a low at bar 30, up to a high at 60, down to a higher low at 90, up past the high (bar 107), then down
  // through the higher low (bar 181).
  const c = path([[0, 150], [30, 100], [60, 130], [90, 110], [130, 160], [200, 90]]), o = ote(c);

  test('a new high over the pivot high is a bullish CHoCH: 50% / 61.8% from the swing low up to the high', () => {
    expect(o[106]!.dir).toBe(0);
    expect(o[107]).toMatchObject({ pos: 1, dir: 1, chochAt: 107, chochLevel: 131, hi: 132.25, lo: 109, hiAt: 107, loAt: 90 });
    expect(o[107]!.l50).toBeCloseTo(132.25 - 23.25 * 0.5, 9);
    expect(o[107]!.l618).toBeCloseTo(132.25 - 23.25 * 0.618, 9);
    // Each new high redraws from the swing low and adds 1 to the count.
    expect(o[130]).toMatchObject({ pos: 24, dir: 1, hi: 161, lo: 109, hiAt: 130 });
    expect(o[130]!.l50).toBeCloseTo(135, 9);
    // No new high after it: the lines stay.
    expect(o[175]).toMatchObject({ pos: 24, dir: 1, l50: o[130]!.l50, l618: o[130]!.l618 });
  });

  test('a new low under the swing low is a bearish CHoCH: levels from the low back up toward the high', () => {
    expect(o[181]).toMatchObject({ pos: -1, dir: -1, chochAt: 181, chochLevel: 109, hi: 161, lo: 108, hiAt: 130, loAt: 181 });
    expect(o[181]!.l50).toBeCloseTo(108 + 53 * 0.5, 9);
    expect(o[181]!.l618).toBeCloseTo(108 + 53 * 0.618, 9);
    expect(o[200]).toMatchObject({ pos: -20, dir: -1, lo: 89 });
    expect(o[200]!.l50).toBeCloseTo(89 + 72 * 0.5, 9);
  });

  test('no look-ahead: bars after a bar change nothing at it', () => {
    let s = 3, p = 2000;
    const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const w: Candle[] = Array.from({ length: 1500 }, (_, k) => { const op = p; p = Math.max(50, p + (r() - 0.5) * 40 + Math.sin(k / 30) * 6); return { openTime: k * H4, open: op, high: Math.max(op, p) + r() * 10, low: Math.min(op, p) - r() * 10, close: p, volume: 1 }; });
    const full = ote(w);
    expect(full.filter((x) => x.chochAt >= 0 && x.chochAt === full.indexOf(x)).length).toBeGreaterThan(5);
    for (const k of [400, 999]) expect(ote(w.slice(0, k + 1))).toEqual(full.slice(0, k + 1));
  });
});
