import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taHighest, taHma, taLowest, taSwma, taWma } from '../src/screen/pine';
import { dvama, dvamaBands, DVAMA } from '../src/screen/dvama';

const H4 = 4 * 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v * (h + l + c) / 3 });

describe('MZ DVAMA [MightyZinger]', () => {
  test('WMA, SWMA and HMA as Pine', () => {
    expect(taWma([1, 2, 3], 3)[2]).toBeCloseTo(14 / 6, 12);
    expect(taSwma([1, 2, 3, 4, 5])[4]).toBeCloseTo(2 / 6 + 6 / 6 + 8 / 6 + 5 / 6, 12);
    const x = Array.from({ length: 40 }, (_, i) => i * i), h = taHma(x, 14), a = taWma(x, 7), b = taWma(x, 14);
    expect(h[39]).toBeCloseTo((1 * (2 * a[37]! - b[37]!) + 2 * (2 * a[38]! - b[38]!) + 3 * (2 * a[39]! - b[39]!)) / 6, 9);
  });

  test('a flat market: the line settles on the price (it starts from 0), the slope is flat (yellow), no signals once settled', () => {
    const s = dvama(Array.from({ length: 600 }, (_, i) => bar(i, 100, 100.5, 99.5, 100)));
    expect(s.line[599]).toBeCloseTo(100, 6);
    expect(s.slope[599]).toBe(0);
    expect(s.color[599]).toBe('yellow');
    expect(s.long.slice(300).some(Boolean) || s.short.slice(300).some(Boolean)).toBe(false);
  });

  test('random walk: the AMA recursion, the slow length, colours from the slope, alternating Long / Short; no look-ahead', () => {
    let sd = 7, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const c = Array.from({ length: 1500 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.48 + 0.04 * Math.sin(i / 60)) * 0.03); return bar(i, o, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd()), p, 500 + 1000 * rnd()); });
    const s = dvama(c), hh = taHighest(c.map((b) => b.high), 366), ll = taLowest(c.map((b) => b.low), 366);
    let len = 10.5;
    for (let i = 0; i < c.length; i++) {
      len = s.rvsi[i]! > 50 ? Math.max(7, len * (1 - DVAMA.adapt)) : Math.min(14, len * (1 + DVAMA.adapt));
      expect(s.slow[i]).toBeCloseTo(len, 12);
      if (i < 4) continue;
      const maj = 2 / (Math.trunc(len) + 1), r = hh[i]! - ll[i]!, m = Number.isNaN(r) ? 0 : Math.abs(2 * s.src[i]! - ll[i]! - hh[i]!) / r, a = m * (2 / 7 - maj) + maj;
      expect(s.line[i]).toBeCloseTo(s.line[i - 1]! + a * a * (s.src[i]! - s.line[i - 1]!), 9);
      const sl = s.slope[i]!, up = s.rvsi[i]! > 50;
      expect(s.color[i]).toBe(Number.isNaN(sl) ? 'green' : sl > 17 ? (up ? 'green' : 'lime') : sl > -17 ? 'yellow' : s.rvsi[i]! < 50 ? 'red' : 'gray');
    }
    expect(s.slow.some((x) => x < 8) && s.slow.some((x) => x > 13.5)).toBe(true);
    const sig = s.long.map((l, i) => (l ? 1 : s.short[i] ? -1 : 0)).filter((x) => x !== 0);
    expect(sig.length).toBeGreaterThan(4);
    expect(sig.every((x, k) => k === 0 || x !== sig[k - 1])).toBe(true);
    const b = dvamaBands(s, 1499);
    expect(b.upper - b.line).toBeCloseTo(2.5 * s.atr[1499]!, 9);
    expect(b.outerTop[1] - b.line).toBeCloseTo(5 * s.atr[1499]!, 9);
    const cut = dvama(c.slice(0, 1001));
    for (const k of ['line', 'slope', 'color', 'long', 'short', 'rvsi'] as const) expect(cut[k]).toEqual(s[k].slice(0, 1001));
  });
});
