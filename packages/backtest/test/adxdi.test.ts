import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taRma, trueRange } from '../src/screen/pine';
import { adxDi } from '../src/screen/adxdi';

const H4 = 4 * 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: 1000 });

describe('ADX and DI [xdecow]', () => {
  test('a steady climb: -DI 0, ADX at 100 (so not rising: it must beat its 2 previous values), trend up; a steady fall: trend down', () => {
    const s = adxDi(Array.from({ length: 80 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i)));
    expect(s.plus.slice(0, 8).every(Number.isNaN)).toBe(true); // the true range's RMA starts on bar 8
    expect(s.minus[79]).toBe(0);
    expect(s.plus[79]).toBeCloseTo(50, 2); // +DM 1 a bar over a true range of 2 (the first bar's 0 still fading out of the RMA)
    expect(s.adx[79]).toBeCloseTo(100, 6);
    expect([s.trend[79], s.rising[30]]).toEqual([1, false]);
    expect(adxDi(Array.from({ length: 80 }, (_, i) => bar(i, 200 - i, 201 - i, 199 - i, 199.5 - i))).trend[79]).toBe(-1);
  });

  test('random walk: DI, ADX, trend and rising as defined; no look-ahead', () => {
    let sd = 5, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const c = Array.from({ length: 600 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return bar(i, o, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd()), p); });
    const s = adxDi(c), tr = taRma(trueRange(c).map((x, i) => (i ? x : NaN)), 8);
    const pdm = taRma(c.map((b, i) => { const u = i ? b.high - c[i - 1]!.high : NaN, d = i ? c[i - 1]!.low - b.low : NaN; return u > d && u > 0 ? u : 0; }), 8);
    for (let i = 20; i < c.length; i++) {
      expect(s.plus[i]).toBeCloseTo((100 * pdm[i]!) / tr[i]!, 9);
      expect(s.trend[i]).toBe(s.adx[i]! > 25 ? (s.plus[i]! > s.minus[i]! ? 1 : -1) : 0);
      expect(s.rising[i]).toBe(s.adx[i]! > s.adx[i - 1]! && s.adx[i]! > s.adx[i - 2]!);
    }
    expect(new Set(s.trend.slice(20))).toEqual(new Set([1, -1, 0]));
    const cut = adxDi(c.slice(0, 401));
    for (const k of ['adx', 'plus', 'minus', 'trend', 'rising'] as const) expect(cut[k]).toEqual(s[k].slice(0, 401));
  });
});
