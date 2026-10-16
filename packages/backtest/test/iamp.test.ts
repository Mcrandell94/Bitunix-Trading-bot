import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { macdHistogram, rsi, stochastic } from '../src/indicators';
import { ampOsc, iAmp } from '../src/screen/iamp';

const H4 = 4 * 3_600_000;
const bar = (i: number, c: number, o = c, h = Math.max(o, c), l = Math.min(o, c)): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: 1000 });
const walk = (n: number, seed = 5) => {
  let s = seed, p = 100;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  return Array.from({ length: n }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return bar(i, p, o, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd())); });
};

describe('RedK Indicator Amplifier', () => {
  test('RSI preset: (RSI - 50) / 50 in 10 blocks up or down, flips at 50, Max crosses at 70 / 30', () => {
    const c = walk(400), a = iAmp(c), r = rsi(c.map((b) => b.close), 14);
    expect([a.mode, a.lo, a.hi, a.base, a.maxHi, a.maxLo, a.levels]).toEqual(['Bounded - Centered', 0, 100, 50, 70, 30, true]);
    for (let i = 0; i < c.length; i++) {
      const v = r[i] ?? NaN, n = Math.max(-1, Math.min(1, (v - 50) / 50));
      expect(a.osc[i]).toBe(v);
      if (Number.isNaN(v)) { expect([a.up[i], a.dn[i]]).toEqual([0, 0]); continue; }
      expect(a.n[i]).toBeCloseTo(n, 12);
      expect([a.up[i], a.dn[i]]).toEqual([n > 0 ? Math.round(n * 10) : 0, n < 0 ? Math.round(-n * 10) : 0]);
      const p = r[i - 1] ?? NaN;
      expect(a.flipUp[i]).toBe(v > 50 && p <= 50);
      expect(a.flipDn[i]).toBe(v < 50 && p >= 50);
      expect(a.hiCross[i]).toBe(v > 70 && p <= 70);
      expect(a.loCross[i]).toBe(v < 30 && p >= 30);
    }
    expect(a.flipUp.some(Boolean) && a.flipDn.some(Boolean)).toBe(true);
    // A straight run up is RSI 100: all 10 blocks up; straight down, all 10 down.
    expect(iAmp(Array.from({ length: 40 }, (_, i) => bar(i, 100 + i))).up.at(-1)).toBe(10);
    expect(iAmp(Array.from({ length: 40 }, (_, i) => bar(i, 100 - i))).dn.at(-1)).toBe(10);
  });

  test('peak hold: the top block stays 3 bars, then falls one block a bar to the level', () => {
    const ext = [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 60];
    const a = iAmp(ext.map((_, i) => bar(i, 1)), { src: 'External Source', ext, mode: 'Bounded - One Direction' });
    expect(a.up).toEqual([0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6]);
    expect(a.upPeak).toEqual([0, 10, 10, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 6]);
    expect(a.dn.every((x) => x === 0)).toBe(true);
  });

  test('one direction Down counts from the High; the baseline is the High', () => {
    const ext = [-30, 5, -98];
    const a = iAmp(ext.map((_, i) => bar(i, 1)), { src: 'External Source', ext, mode: 'Bounded - One Direction', lo: -100, hi: 0, oneDir: 'Down' });
    expect([a.base, a.up, a.dn]).toEqual([0, [0, 0, 0], [3, 0, 10]]);
    expect([a.flipUp, a.flipDn]).toEqual([[false, true, false], [false, false, true]]);
  });

  test('lookback 1 on an unbounded mode = real values (block size x bands), Max levels on', () => {
    const ext = [8, -5, 25, -0.4];
    const a = iAmp(ext.map((_, i) => bar(i, 1)), { src: 'External Source', ext, mode: 'Unbounded - Zero-Centered', rollLen: 1, blkSize: 2, maxHi: 6, maxLo: -2 });
    expect([a.mode, a.lo, a.hi, a.base, a.levels]).toEqual(['Bounded - Centered', -20, 20, 0, true]);
    expect([a.up, a.dn]).toEqual([[4, 0, 10, 0], [0, 3, 0, 0]]); // -5 / 20 = -0.25: 2.5 blocks round up to 3; -0.4 -> 0.2 -> 0
    expect([a.hiCross, a.loCross]).toEqual([[false, false, true, false], [false, true, false, false]]);
  });

  test('CCI and MACD presets: zero-centered on the highest |value| of 100 bars, no Max levels', () => {
    const c = walk(700);
    for (const src of ['CCI (20)', 'MACD Histogram (12,26,9)'] as const) {
      const a = iAmp(c, { src });
      expect([a.mode, a.base, a.levels]).toEqual(['Unbounded - Zero-Centered', 0, false]);
      expect(a.hiCross.some(Boolean) || a.loCross.some(Boolean)).toBe(false);
      for (let i = 300; i < c.length; i++) {
        let mx = 0;
        for (let k = i - 99; k <= i; k++) mx = Math.max(mx, Math.abs(a.osc[k]!));
        expect(a.n[i]).toBeCloseTo(a.osc[i]! / mx, 12);
      }
    }
    // CCI by hand on the last bar; MACD and Stochastic match the bot's own indicators once warmed up.
    const cl = c.map((b) => b.close), w = cl.slice(-20), m = w.reduce((s, x) => s + x, 0) / 20, dev = w.reduce((s, x) => s + Math.abs(x - m), 0) / 20;
    expect(ampOsc(c, 'CCI (20)').at(-1)).toBeCloseTo((cl.at(-1)! - m) / (0.015 * dev), 9);
    expect(ampOsc(c, 'MACD Histogram (12,26,9)').at(-1)).toBeCloseTo(macdHistogram(cl).at(-1)!, 9);
    const st = stochastic(c, 14, 3).k, so = ampOsc(c, 'Stochastic (14,3)');
    for (let i = 20; i < c.length; i++) expect(so[i]).toBeCloseTo(st[i]!, 9);
    const sa = iAmp(c, { src: 'Stochastic (14,3)' });
    expect([sa.mode, sa.maxHi, sa.maxLo, sa.levels]).toEqual(['Bounded - Centered', 80, 20, true]);
  });

  test('unbounded one direction: a stochastic over the lookback, 0.5 when flat', () => {
    const ext = [5, 5, 5, 1, 3];
    const a = iAmp(ext.map((_, i) => bar(i, 1)), { src: 'External Source', ext, mode: 'Unbounded - One Direction', rollLen: 3 });
    expect(a.n).toEqual([0.5, 0.5, 0.5, 0, 0.5]);
    expect(a.up).toEqual([5, 5, 5, 0, 5]);
    expect(a.levels).toBe(false);
  });

  test('no look-ahead: bar i reads only the bars up to it', () => {
    const c = walk(500, 9);
    for (const src of ['RSI (14)', 'Stochastic (14,3)', 'CCI (20)', 'MACD Histogram (12,26,9)'] as const) {
      const full = iAmp(c, { src }), cut = iAmp(c.slice(0, 351), { src });
      for (const k of ['osc', 'n', 'up', 'dn', 'upPeak', 'dnPeak', 'flipUp', 'flipDn', 'hiCross', 'loCross'] as const) expect(cut[k]).toEqual(full[k].slice(0, 351));
    }
  });
});
