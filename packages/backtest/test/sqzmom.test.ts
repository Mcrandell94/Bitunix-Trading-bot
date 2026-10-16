import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taLinreg, taSma, taStdev, trueRange } from '../src/screen/pine';
import { sqzMom } from '../src/screen/sqzmom';

const H4 = 4 * 3_600_000;
const bar = (i: number, c: number, h = c + 1, l = c - 1, o = c): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: 1000 });

describe('Squeeze Momentum Indicator [LazyBear]', () => {
  test('linreg is the least-squares line at the current bar', () => {
    expect(taLinreg([1, 3, 2], 3)).toEqual([NaN, NaN, 2.5]); // slope 0.5, intercept 1.5, at x = 2
    const line = taLinreg(Array.from({ length: 30 }, (_, i) => 5 + 2 * i), 20);
    expect(line[29]).toBeCloseTo(63, 10);
    expect(taLinreg([1, 3, 2], 3, 1)[2]).toBeCloseTo(2, 12);
  });

  test('a steady climb: momentum = 9.5 (close over the midline of range and mean), lime on its first bar, then green', () => {
    const s = sqzMom(Array.from({ length: 60 }, (_, i) => bar(i, 100 + i)));
    expect(s.val.slice(0, 38).every(Number.isNaN)).toBe(true);
    expect(s.val[38]).toBeCloseTo(9.5, 9);
    expect(s.val[59]).toBeCloseTo(9.5, 9);
    expect([s.color[37], s.color[38], s.color[39]]).toEqual([null, 'lime', 'green']);
  });

  test('squeeze on when 1.5 stdev sits inside 1.5 x the average true range, off when outside, none on warm-up', () => {
    let s0 = 4, p = 100;
    const rnd = () => { s0 = (s0 * 1664525 + 1013904223) % 4294967296; return s0 / 4294967296; };
    // Quiet closes in wide bars (squeeze on), then a trend in narrow bars (squeeze off), then noise.
    const c = Array.from({ length: 300 }, (_, i) => {
      const o = p;
      p = i < 100 ? 100 + (rnd() - 0.5) * 0.2 : i < 160 ? o * 1.01 : o * (1 + (rnd() - 0.5) * 0.03);
      const w = i < 100 ? 3 : i < 160 ? 0.05 : 0.01 * p * rnd();
      return bar(i, p, Math.max(o, p) + w, Math.min(o, p) - w, o);
    });
    const s = sqzMom(c), cl = c.map((b) => b.close), sd = taStdev(cl, 20), ma = taSma(cl, 20), tr = trueRange(c).map((x, i) => (i === 0 ? NaN : x)), rm = taSma(tr, 20);
    expect(s.state.slice(0, 20).every((x) => x === 'none')).toBe(true); // the true range is na on the first bar
    for (let i = 20; i < c.length; i++) {
      const bb = 1.5 * sd[i]!, kc = 1.5 * rm[i]!;
      expect(s.upperBB[i]).toBeCloseTo(ma[i]! + bb, 9);
      expect(s.state[i]).toBe(ma[i]! - bb > ma[i]! - kc && ma[i]! + bb < ma[i]! + kc ? 'on' : ma[i]! - bb < ma[i]! - kc && ma[i]! + bb > ma[i]! + kc ? 'off' : 'none');
    }
    expect(s.state[90]).toBe('on');
    expect(s.state[150]).toBe('off');
    for (let i = 1; i < c.length; i++) if (s.color[i]) expect(s.color[i]).toBe(s.val[i]! > 0 ? (s.val[i]! > (Number.isNaN(s.val[i - 1]!) ? 0 : s.val[i - 1]!) ? 'lime' : 'green') : s.val[i]! < (Number.isNaN(s.val[i - 1]!) ? 0 : s.val[i - 1]!) ? 'red' : 'maroon');
    // No look-ahead.
    const cut = sqzMom(c.slice(0, 201));
    for (const k of ['val', 'color', 'state'] as const) expect(cut[k]).toEqual(s[k].slice(0, 201));
  });
});
