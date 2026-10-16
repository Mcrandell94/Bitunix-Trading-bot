import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { trendLines } from '../src/screen/trendlines';

const H4 = 4 * 3_600_000;
const bar = (i: number, c: number, h = c + 0.5, l = c - 0.5): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: c, high: h, low: l, close: c, volume: 1000 });
/** Straight segments through the given (bar, close) points. */
const path = (pts: [number, number][]) => {
  const out: number[] = [];
  for (let k = 0; k < pts.length - 1; k++) { const [x0, y0] = pts[k]!, [x1, y1] = pts[k + 1]!; for (let x = x0; x < x1; x++) out.push(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)); }
  out.push(pts.at(-1)![1]);
  return out;
};

describe('Trend Lines v2 [LonesomeTheBlue]', () => {
  // Lows at bar 40 (99.5) and bar 100 (105.5): an up line rising 0.1 a bar, 111.4 at bar 159.
  const closes = path([[0, 120], [40, 100], [70, 115], [100, 106], [159, 140]]);
  const c = closes.map((x, i) => bar(i, x));

  test('two higher pivot lows draw an up line; a close under it removes it', () => {
    const t = trendLines(c);
    expect(t.down).toEqual([]); // one pivot high only
    expect(t.up).toHaveLength(1);
    const l = t.up[0]!;
    expect([l.side, l.from, l.through]).toEqual([1, { at: 40, v: 99.5 }, { at: 100, v: 105.5 }]);
    expect(l.slope).toBeCloseTo(0.1, 12);
    expect(l.now).toBeCloseTo(99.5 + 0.1 * 119, 9);
    const broken = [...c, bar(160, 105)];
    expect(trendLines(broken).up).toEqual([]);
    expect(trendLines(c, 119).up).toEqual([]); // the low at bar 100 is confirmed at bar 120
  });

  test('mirrored: two lower pivot highs draw a down line', () => {
    const m = c.map((b) => ({ ...b, open: 250 - b.open, close: 250 - b.close, high: 250 - b.low, low: 250 - b.high }));
    const t = trendLines(m);
    expect(t.up).toEqual([]);
    expect(t.down).toHaveLength(1);
    expect([t.down[0]!.from, t.down[0]!.through]).toEqual([{ at: 40, v: 150.5 }, { at: 100, v: 144.5 }]);
    expect(t.down[0]!.now).toBeCloseTo(250 - (99.5 + 0.1 * 119), 9);
  });

  test('on a random walk every line holds from its start to the bar; no look-ahead', () => {
    let s = 21, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const w = Array.from({ length: 1500 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return bar(i, p, Math.max(o, p) * 1.003, Math.min(o, p) * 0.997); });
    let lines = 0;
    for (let i = 300; i < w.length; i += 7) {
      const t = trendLines(w, i);
      for (const l of [...t.up, ...t.down]) {
        lines++;
        expect(l.now).toBeCloseTo(l.from.v + l.slope * (i - l.from.at), 6);
        expect(l.through.v).toBeCloseTo(l.from.v + l.slope * (l.through.at - l.from.at), 6);
        for (let x = l.from.at + 1; x <= i; x++) expect(l.side > 0 ? w[x]!.close >= l.from.v + l.slope * (x - l.from.at) - 1e-9 : w[x]!.close <= l.from.v + l.slope * (x - l.from.at) + 1e-9).toBe(true);
      }
      expect(t.up.length).toBeLessThanOrEqual(2);
      expect(t.down.length).toBeLessThanOrEqual(2);
    }
    expect(lines).toBeGreaterThan(20);
    expect(trendLines(w, 900)).toEqual(trendLines(w.slice(0, 901)));
  });
});
