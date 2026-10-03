// Prism Adaptive RSI port (NeBlok, MPL-2.0): direction, adaptive length, no look-ahead, twist.
import { describe, expect, test } from 'vitest';
import { prismBaseLen, prismRsi, prismZone } from '../src/screen/prismrsi';

const up = Array.from({ length: 120 }, (_, i) => 100 + i);
const down = Array.from({ length: 120 }, (_, i) => 300 - i);
const chop = Array.from({ length: 120 }, (_, i) => 100 + (i % 2 ? 1 : -1));

describe('Prism Adaptive RSI', () => {
  test('a clean rise reads near 100, a clean fall near 0, an even zigzag near 50', () => {
    expect(prismRsi(up).mid.at(-1)!).toBeGreaterThan(95);
    expect(prismRsi(down).mid.at(-1)!).toBeLessThan(5);
    const z = prismRsi(chop).mid.at(-1)!;
    expect(z).toBeGreaterThan(35);
    expect(z).toBeLessThan(65);
  });

  test('adaptive length: the minimum (8) in a perfect trend, the maximum (34) in pure chop', () => {
    expect(prismBaseLen(up).at(-1)!).toBeCloseTo(8, 6);
    expect(prismBaseLen(chop).at(-1)!).toBeCloseTo(34, 6);
  });

  test('no look-ahead: a truncated series gives the same values on every bar it has', () => {
    const s = Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i * 0.05);
    const full = prismRsi(s), part = prismRsi(s.slice(0, 150));
    for (let i = 0; i < 150; i++) {
      expect(part.mid[i]).toBe(full.mid[i]);
      expect(part.fast[i]).toBe(full.fast[i]);
      expect(part.slow[i]).toBe(full.slow[i]);
    }
  });

  test('after a sharp turn up the fast layer leads the slow one (bull twist)', () => {
    const turn = [...down.slice(0, 80), ...Array.from({ length: 6 }, (_, i) => 221 + 3 * (i + 1))];
    const p = prismRsi(turn);
    expect(p.fast.at(-1)!).toBeGreaterThan(p.slow.at(-1)!);
  });

  test("the owner's zones", () => {
    expect([10, 40, 60, 80].map(prismZone)).toEqual(['optimal', 'safe', 'risky', 'caution']);
  });
});
