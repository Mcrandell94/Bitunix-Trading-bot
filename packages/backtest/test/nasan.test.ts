import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { NASAN, nasan } from '../src/screen/nasan';
import { taAtr, taMedian } from '../src/screen/pine';

const H4 = 4 * 3_600_000;
function walk(n: number, seed = 13): Candle[] {
  let s = seed, p = 2000;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(50, p + (r() - 0.5) * 30 + Math.sin(k / 25) * 8); return { openTime: k * H4, open: o, high: Math.max(o, p) + 1 + r() * 6, low: Math.min(o, p) - 1 - r() * 6, close: p, volume: 1000 * (1 + 4 * r()) * p }; });
}

describe('Nasan Momentum Oscillator (Dynamic Volume-Volatility Adjusted Momentum)', () => {
  test('ta.median: the middle value, the mean of the two middle ones for an even length', () => {
    expect(taMedian([5, 1, 3], 3)[2]).toBe(3);
    expect(taMedian([4, 1, 3, 2], 4)[3]).toBe(2.5);
    expect(Number.isNaN(taMedian([1, NaN, 3], 3)[2]!)).toBe(true);
  });

  test('the averaged momentum and its dynamic-length SMA, written out by hand at a bar', () => {
    const c = walk(700), s = nasan(c), i = 650;
    const tp = c.map((b) => (b.high + b.low + b.close) / 3), vol = c.map((b) => b.volume! / ((b.high + b.low + b.close) / 3)), idv = c.map((b) => (b.high - b.low) / b.close);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const med = (xs: number[]) => { const w = [...xs].sort((a, b) => a - b), m = w.length; return m % 2 ? w[(m - 1) / 2]! : (w[m / 2 - 1]! + w[m / 2]!) / 2; };
    const term = (k: number, L: number) => {
      const win = (xs: number[], j: number) => xs.slice(j - L + 1, j + 1);
      const mad = mean(Array.from({ length: L }, (_, q) => { const j = k - L + 1 + q; return Math.abs(tp[j]! - med(win(tp, j))); }));
      return (((tp[k]! - mean(win(tp, k))) / mad) * (vol[k]! / mean(win(vol, k)))) / (idv[k]! / mean(win(idv, k)));
    };
    const ave = (k: number) => (term(k, 5) + term(k, 8) + term(k, 13)) / 3;
    const atr = taAtr(c, 5), rv = mean(atr.slice(i - 9, i + 1)) / atr[i]!, dl = Math.min(Math.max(Math.trunc(14 / rv), 5), 30);
    expect(s.dl[i]).toBe(dl);
    expect(s.ma[i]!).toBeCloseTo(mean(Array.from({ length: dl }, (_, q) => ave(i - dl + 1 + q))), 9);
  });

  test('z-score over 500 bars of it, HMA 5 smoothing, the crosses; na with too few bars; no look-ahead', () => {
    const c = walk(1400, 5), s = nasan(c), i = 1300;
    const w = s.ma.slice(i - NASAN.zLen + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / w.length, sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    expect(s.z[i]!).toBeCloseTo((s.ma[i]! - m) / sd, 9);
    for (const x of s.dl) if (!Number.isNaN(x)) { expect(x).toBeGreaterThanOrEqual(5); expect(x).toBeLessThanOrEqual(30); }
    expect(s.up0.filter(Boolean).length).toBeGreaterThan(3);
    for (let k = 1; k < s.z.length; k++) expect(s.intoOb[k]).toBe(s.z[k]! > 1.5 && s.z[k - 1]! <= 1.5);
    expect(nasan(c.slice(0, 400)).z.every((x) => Number.isNaN(x))).toBe(true); // under 500 bars of the momentum average
    const part = nasan(c.slice(0, 1000));
    expect(part.z).toEqual(s.z.slice(0, 1000));
    expect(part.smooth).toEqual(s.smooth.slice(0, 1000));
  });
});
