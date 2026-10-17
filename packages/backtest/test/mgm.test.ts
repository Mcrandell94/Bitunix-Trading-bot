import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taWma } from '../src/screen/pine';
import { mgm, mgmCoefficients } from '../src/screen/mgm';

const H4 = 4 * 3_600_000;
const bar = (i: number, c: number): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 });

describe('Momentum Ghost Machine [ChartPrime]', () => {
  const co = mgmCoefficients(), norm = co.reduce((a, b) => a + b, 0);

  test('100 windowed-sinc taps; a flat price has no momentum; a straight climb has a steady one (the taps\' centroid / 49)', () => {
    expect(co).toHaveLength(100);
    expect(co[49]).toBeCloseTo(0.42 - 0.5 * Math.cos((2 * Math.PI * 49.5) / 99) + 0.08 * Math.cos((4 * Math.PI * 49.5) / 99), 12); // sinc(0) = 1
    const flat = mgm(Array.from({ length: 300 }, (_, i) => bar(i, 100)));
    expect(flat.filter.slice(0, 101).every(Number.isNaN)).toBe(true);
    expect(flat.filter[101]).toBeCloseTo(100, 9);
    expect(flat.delta[299]).toBeCloseTo(0, 9);
    const centroid = co.reduce((a, w, k) => a + w * k, 0) / norm, ramp = mgm(Array.from({ length: 300 }, (_, i) => bar(i, 100 + 2 * i)));
    expect(ramp.delta[299]).toBeCloseTo((2 * centroid) / 49, 9);
    expect(ramp.momo[299]).toBeCloseTo(0, 6); // the MA has caught up with a constant momentum
  });

  test('random walk: the filter, momentum, MA, colours and ghost as defined; no look-ahead', () => {
    let sd = 3, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const c = Array.from({ length: 700 }, (_, i) => { p = p * (1 + (rnd() - 0.5) * 0.03); return bar(i, p); });
    const s = mgm(c), src = c.map((b) => b.close);
    for (let i = 101; i < c.length; i++) {
      let f = 0;
      for (let k = 0; k < 100; k++) f += co[k]! * src[i - k]!;
      expect(s.filter[i]).toBeCloseTo(f / norm, 9);
    }
    const d = taWma(src.map((x, i) => (x - s.filter[i]!) / 49), 4);
    let e1 = NaN, e2 = NaN;
    for (let i = 0; i < c.length; i++) {
      expect(s.delta[i]).toBe(d[i]);
      e1 = (2 / 3) * d[i]! + (1 / 3) * (Number.isNaN(e1) ? d[i]! : e1);
      e2 = (2 / 25) * e1 + (23 / 25) * (Number.isNaN(e2) ? e1 : e2);
      if (i < 110) continue;
      expect(s.ma[i]).toBeCloseTo(e2, 9);
      const m = s.momo[i]!, pm = s.momo[i - 1]!;
      expect(s.color[i]).toBe(m > 0 ? (m > pm ? 'bullish up' : 'bullish down') : m < pm ? 'bearish down' : 'bearish up');
      const pr = (x: number[]) => (x[i]! - x[i - 1]! + (x[i]! - x[i - 2]!) / 2) / 2;
      expect(s.ghost2[i]).toBeCloseTo(s.delta[i]! + 2 * pr(s.delta) - s.ma[i]! - 2 * pr(s.ma), 9);
    }
    expect(new Set(s.color.slice(120)).size).toBe(4);
    const cut = mgm(c.slice(0, 501));
    for (const k of ['filter', 'delta', 'ma', 'momo', 'color', 'ghost1', 'ghost2'] as const) expect(cut[k]).toEqual(s[k].slice(0, 501));
  });
});
