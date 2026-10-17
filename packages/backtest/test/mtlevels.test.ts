import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { mtlLines } from '../src/screen/mtlevels';
import { taEma } from '../src/screen/pine';

const H4 = 4 * 3_600_000;
function walk(n: number, seed = 23): Candle[] {
  let s = seed, p = 2000;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(50, p + (r() - 0.5) * 30 + Math.sin(k / 12) * 9); return { openTime: k * H4, open: o, high: Math.max(o, p) + r() * 8, low: Math.min(o, p) - r() * 8, close: p, volume: 1 }; });
}

describe('Market Trend Levels Detector [BigBeluga]', () => {
  test('a level at the 25-bar extreme on each EMA 12 / 25 cross; broken by a later high over / low under; the last 50', () => {
    const c = walk(4000), at = 3990, lines = mtlLines(c, at), cl = c.map((b) => b.close), e1 = taEma(cl, 12), e2 = taEma(cl, 25);
    expect(lines.length).toBe(50); // more than 50 made: only the last 50
    expect(mtlLines(c, 300).length).toBeLessThan(50);
    for (const l of lines) {
      const i = l.cross, w = c.slice(Math.max(0, i - 24), i + 1);
      if (l.side < 0) {
        expect(e1[i]! > e2[i]! && e1[i - 1]! <= e2[i - 1]!).toBe(true);
        expect(l.y).toBe(Math.min(...w.map((b) => b.low)));
        expect(c[l.at]!.low).toBe(l.y);
      } else {
        expect(e1[i]! < e2[i]! && e1[i - 1]! >= e2[i - 1]!).toBe(true);
        expect(l.y).toBe(Math.max(...w.map((b) => b.high)));
        expect(c[l.at]!.high).toBe(l.y);
      }
      expect(l.at).toBeGreaterThanOrEqual(i - 25);
      let br: number | null = null;
      for (let k = i; k <= at && br == null; k++) if (l.side > 0 ? c[k]!.high > l.y : c[k]!.low < l.y) br = k;
      expect(l.brokenAt).toBe(br);
    }
    expect(lines.some((l) => l.brokenAt == null)).toBe(true);
    expect(lines.some((l) => l.brokenAt != null)).toBe(true);
  });

  test('every bar tied at the extreme gets a line, a bar 25 back included', () => {
    // A flat run with two equal lows, then a turn up that crosses the EMAs.
    const c: Candle[] = [];
    for (let k = 0; k < 80; k++) { const p = 200 - k; c.push({ openTime: k * H4, open: p + 1, high: p + 1.5, low: p - 0.5, close: p, volume: 1 }); }
    const base = c.at(-1)!.low;
    for (let k = 80; k < 110; k++) { const p = 122 + (k - 80) * 2; c.push({ openTime: k * H4, open: p - 1, high: p + 0.5, low: k === 81 || k === 84 ? base : p - 1, close: p, volume: 1 }); } // lows over the base but bars 81 and 84 (and 79) at it
    const cross = mtlLines(c, 109).filter((l) => l.side < 0).at(-1)!;
    const ties = mtlLines(c, 109).filter((l) => l.cross === cross.cross);
    expect(ties.map((l) => l.y).every((y) => y === ties[0]!.y)).toBe(true);
    expect(ties.map((l) => l.at).sort((x, y) => x - y)).toEqual([79, 81, 84]);
  });

  test('no look-ahead', () => {
    const c = walk(1200, 4);
    expect(mtlLines(c, 800)).toEqual(mtlLines(c.slice(0, 801), 800));
  });
});
