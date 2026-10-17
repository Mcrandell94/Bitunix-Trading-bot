import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { momShift, momShiftLines } from '../src/screen/momshift';
import { taHma, taSma } from '../src/screen/pine';

const H4 = 4 * 3_600_000;
function walk(n: number, seed = 17): Candle[] {
  let s = seed, p = 2000;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(50, p + (r() - 0.5) * 30 + Math.sin(k / 35) * 9); return { openTime: k * H4, open: o, high: Math.max(o, p) + r() * 8, low: Math.min(o, p) - r() * 8, close: p, volume: 1 }; });
}

describe('Momentum Shift [BigBeluga]', () => {
  const c = walk(1200), s = momShift(c);

  test('momentum = HMA 50 of the 50-bar change; shifts = crossing its value 2 bars back; dist = SMA 100 of the range', () => {
    const cl = c.map((b) => b.close);
    expect(s.mom).toEqual(taHma(cl.map((x, i) => (i >= 50 ? x - cl[i - 50]! : NaN)), 50));
    expect(s.dist).toEqual(taSma(c.map((b) => b.high - b.low), 100));
    for (let i = 3; i < c.length; i++) {
      expect(s.rising[i]).toBe(s.mom[i]! > s.mom[i - 2]! && s.mom[i - 1]! <= s.mom[i - 3]!);
      expect(s.falling[i]).toBe(s.mom[i]! < s.mom[i - 2]! && s.mom[i - 1]! >= s.mom[i - 3]!);
    }
    expect(s.rising.filter(Boolean).length).toBeGreaterThan(5);
  });

  test('lines from the last shift: 6 at its high + dist x 0..5 (or low - ...); line 0 stops at once; each stops when reached', () => {
    const at = 1150, last = Math.max(s.rising.lastIndexOf(true, at), s.falling.lastIndexOf(true, at)), up = s.rising[last]!;
    const lines = momShiftLines(c, at, s);
    expect(lines.length).toBe(6);
    lines.forEach((l, k) => {
      const b = c[last]!, y = up ? b.high + s.dist[last]! * k : b.low - s.dist[last]! * k;
      expect([l.side, l.k, l.from]).toEqual([up ? 1 : -1, k, last]);
      expect(l.y).toBeCloseTo(y, 9);
      let hit: number | null = null;
      for (let i = last; i <= at && hit == null; i++) if (up ? c[i]!.high >= y : c[i]!.low <= y) hit = i;
      expect(l.hitAt).toBe(hit);
    });
    expect(lines[0]!.hitAt).toBe(last);
    expect(lines[0]!.fromOpposite).toBe(up ? s.mom[last]! < 0 : s.mom[last]! > 0);
  });

  test('no look-ahead: bars after `at` change nothing', () => {
    expect(momShiftLines(c, 900)).toEqual(momShiftLines(c.slice(0, 901), 900));
  });
});
