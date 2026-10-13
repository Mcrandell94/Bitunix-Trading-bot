import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { autoFib, autoFibAt, autoFibPrice } from '../src/screen/autofib';
import { fibToolkit, luxFibLive, luxFibPrice } from '../src/screen/fibtoolkit';
import { liqMap } from '../src/screen/liqmap';
import { taAtr } from '../src/screen/pine';
import { volDivergence } from '../src/screen/voldiv';
import { heatmapVolume, volLevel } from '../src/screen/volheatmap';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number, v = 10_000, o = c): Candle => ({ openTime: Date.UTC(2025, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v });
/** Flat bars: high 101, low 99, close 100 (typical price 100, so coin volume = volume / 100). */
const flat = (n: number, v = 10_000) => Array.from({ length: n }, (_, i) => bar(i, 101, 99, 100, v));
/** A random walk with random volume (for the no-look-ahead checks). */
function walk(n: number, seed = 3): Candle[] {
  let s = seed, p = 100;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  return Array.from({ length: n }, (_, i) => {
    const o = p, c = o * (1 + (r() - 0.5) * 0.04 + Math.sin(i / 40) * 0.004);
    p = c;
    return bar(i, Math.max(o, c) * (1 + 0.01 * r()), Math.min(o, c) * (1 - 0.01 * r()), c, 1e4 * (0.5 + r()) * (r() < 0.03 ? 5 : 1), o);
  });
}
/** Bars on straight legs between turning prices (high = low = close), `step` bars a leg. */
function legs(points: number[], step = 3): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k < points.length - 1; k++) for (let j = 0; j < step; j++) { const p = points[k]! + ((points[k + 1]! - points[k]!) * j) / step; out.push(bar(out.length, p, p, p)); }
  const last = points.at(-1)!;
  out.push(bar(out.length, last, last, last));
  return out;
}

describe('Heatmap Volume [xdecow]', () => {
  test('the score is deviations from the mean over the bars there are (up to 610); levels by the thresholds', () => {
    const c = [...flat(4), bar(4, 101, 99, 100, 50_000)];
    const z = heatmapVolume(c).z;
    expect(z[0]).toBeNaN(); // one bar: no deviation
    expect(z[4]).toBeCloseTo(2, 10); // [10,10,10,10,50]: mean 18, deviation 16
    expect(heatmapVolume(c).level[4]).toBe('medium');
    expect([4.01, 4, 2.6, 2.5, 1.2, 1, 0, -0.5, NaN].map(volLevel)).toEqual(['extra high', 'high', 'high', 'medium', 'medium', 'normal', 'normal', 'low', 'low']);
    // The window stops growing at 610 bars: the first bar's volume no longer counts at bar 699.
    const a = flat(700).map((b, i) => ({ ...b, volume: 10_000 + (i % 7) * 1000 })), b2 = a.map((x, i) => (i === 0 ? { ...x, volume: 90_000 } : x));
    expect(heatmapVolume(b2).z[699]).toBe(heatmapVolume(a).z[699]);
    expect(heatmapVolume(b2).z[600]).not.toBe(heatmapVolume(a).z[600]);
  });
});

describe('Volume HeatMap Divergence [BigBeluga]', () => {
  test('a higher volume peak into a lower low is bullish, a lower peak into a higher high bearish, 5..60 bars apart', () => {
    const c = flat(160);
    c[5] = { ...c[5]!, volume: 100_000 }; // the 1000-bar high (too early to be a peak)
    c[20] = { ...c[20]!, volume: 50_000, low: 95 };
    c[40] = { ...c[40]!, volume: 80_000, low: 90 };
    c[60] = { ...c[60]!, volume: 30_000, high: 110 };
    c[140] = { ...c[140]!, volume: 20_000, high: 120 }; // 79 bars after the last confirmation: out of range
    const { divs } = volDivergence(c);
    expect(divs.map((d) => [d.dir, d.i, d.at, d.price, d.prevAt, d.prevPrice])).toEqual([[1, 45, 40, 90, 20, 95], [-1, 65, 60, 110, 40, 101]]);
    expect(divs[0]!.vol).toBeGreaterThan(divs[0]!.prevVol);
  });
});

describe('Liquidation HeatMap [BigBeluga]', () => {
  test('a pivot high leaves 3 zones (its bar and the next two), ATR(200) x 0.2 tall; a bar through the middle ends them', () => {
    const c = flat(260);
    c[230] = { ...c[230]!, high: 110 };
    c[240] = { ...c[240]!, high: 112 };
    const atr = taAtr(c, 200), m = liqMap(c, 239, '4H');
    expect(m.live.map((z) => [z.side, z.left, z.createdAt, z.bot])).toEqual([[1, 230, 232, 110], [1, 231, 233, 101], [1, 232, 234, 101]]);
    expect(m.live[0]!.top).toBeCloseTo(110 + atr[230]! * 0.2, 10);
    expect(liqMap(c, 239, 'W').live[0]!.top).toBeCloseTo(110 + atr[230]! * 0.4, 10);
    const after = liqMap(c, 241, '4H');
    expect(after.live).toEqual([]);
    expect(after.zones.slice(0, 3).map((z) => z.removedAt)).toEqual([240, 240, 240]);
  });

  test('only the last 500 bars of the chart make zones', () => {
    const c = flat(800);
    c[230] = { ...c[230]!, high: 110 };
    expect(liqMap(c, 731, '4H').live.map((z) => z.createdAt)).toEqual([232, 233, 234]);
    expect(liqMap(c, 732, '4H').live.map((z) => z.createdAt)).toEqual([233, 234]);
  });
});

describe('Auto-Fibonacci Levels [ChartWhizzperer]', () => {
  test('drawn when a swing is confirmed (20 bars each side) once both exist; up from the low when the low came first', () => {
    // Down to 100 (bar 30), up to 140 (bar 70), down to 110 (bar 110), up to 120 (bar 130), flat.
    const px: number[] = [];
    for (let i = 0; i <= 160; i++) px.push(i <= 30 ? 120 - (20 * i) / 30 : i <= 70 ? 100 + (i - 30) : i <= 110 ? 140 - ((i - 70) * 30) / 40 : i <= 130 ? 110 + (i - 110) * 0.5 : 120);
    const c = px.map((p, i) => bar(i, p + 0.5, p - 0.5, p));
    const { sets, crosses } = autoFib(c);
    expect(sets.map((s) => [s.at, s.hi, s.lo, s.bull])).toEqual([[90, 140.5, 99.5, true], [130, 140.5, 109.5, false]]);
    expect(autoFibPrice(sets[0]!, 0.618)).toBeCloseTo(99.5 + 41 * 0.618, 10);
    expect(autoFibPrice(sets[1]!, 0.618)).toBeCloseTo(140.5 - 31 * 0.618, 10);
    expect(autoFibAt(sets, 100)).toBe(sets[0]);
    // Close 124.25 at bar 91 under the 61.8% line 124.838 (125 at bar 90).
    expect(crosses.find((x) => x.level === 0.618 && !x.up)?.i).toBe(91);
  });
});

describe('Fibonacci Confluence Toolkit [LuxAlgo]', () => {
  test('short-term swings are the turning bars; intermediate ones the short-term swings past both neighbours', () => {
    // Peaks 110, 108, 104, 112, 111, 120 and troughs 100, 96, 99, 103, 101 (3 bars a leg).
    const c = legs([110, 100, 108, 96, 104, 99, 112, 103, 111, 101, 120]);
    const { swings } = fibToolkit(c);
    expect(swings.st.lo.map((s) => [s.price, s.at])).toEqual([[100, 3], [96, 9], [99, 15], [103, 21], [101, 27]]);
    expect(swings.st.hi.map((s) => [s.price, s.at])).toEqual([[108, 6], [104, 12], [112, 18], [111, 24]]);
    // 96 is under 100 and 99: taken when 99 is recorded (bar 16); 112 over 104 and 111: when 111 is (bar 25).
    expect(swings.it.lo.map((s) => [s.price, s.at, s.i])).toEqual([[96, 9, 16]]);
    expect(swings.it.hi.map((s) => [s.price, s.at, s.i])).toEqual([[112, 18, 25]]);
  });

  test('on a long random walk: CHoCH lows / highs, each retracement from its CHoCH extreme to the next long-term swing', () => {
    const c = walk(3000, 11), { sets, chochs, swings } = fibToolkit(c);
    expect(chochs.length).toBeGreaterThan(3);
    expect(sets.length).toBeGreaterThan(2);
    for (const ch of chochs) {
      const span = c.slice(ch.levelAt, ch.i + 1).map((b) => (ch.dir > 0 ? b.low : b.high));
      expect(ch.extreme).toBe(ch.dir > 0 ? Math.min(...span) : Math.max(...span));
      expect(ch.dir > 0 ? c[ch.i]!.close > ch.level : c[ch.i]!.close < ch.level).toBe(true);
    }
    for (const s of sets) {
      const ch = chochs.filter((x) => x.dir === s.dir && x.i < s.createdAt).at(-1)!;
      expect(s.dir > 0 ? [s.lo, s.loAt] : [s.hi, s.hiAt]).toEqual([ch.extreme, ch.extremeAt]);
      const sw = (s.dir > 0 ? swings.lt.hi : swings.lt.lo).find((x) => x.i === s.createdAt)!;
      expect(s.dir > 0 ? s.hi : s.lo).toBe(sw.price);
      expect(s.lastAt).toBeGreaterThanOrEqual(s.createdAt);
      expect(luxFibPrice(s, 0)).toBe(s.dir > 0 ? s.hi : s.lo);
      expect(luxFibPrice(s, 1)).toBeCloseTo(s.dir > 0 ? s.lo : s.hi, 8);
    }
    expect(luxFibLive(sets, 2999).length).toBeLessThanOrEqual(2);
  });
});

describe('no look-ahead: a run cut at a past bar equals the full run up to it', () => {
  const c = walk(1600, 7), cut = 1234, part = c.slice(0, cut + 1);
  test('volume, divergence, liquidation map, both Fib scripts', () => {
    expect(heatmapVolume(part).z).toEqual(heatmapVolume(c).z.slice(0, cut + 1));
    expect(volDivergence(part).divs).toEqual(volDivergence(c).divs.filter((d) => d.i <= cut));
    expect(liqMap(part, cut, 'D')).toEqual(liqMap(c, cut, 'D'));
    const fa = autoFib(c), fp = autoFib(part);
    expect(fp.sets).toEqual(fa.sets.filter((s) => s.at <= cut));
    expect(fp.crosses).toEqual(fa.crosses.filter((x) => x.i <= cut));
    const la = fibToolkit(c), lp = fibToolkit(part);
    expect(lp.chochs).toEqual(la.chochs.filter((x) => x.i <= cut));
    expect(lp.sets).toEqual(la.sets.filter((s) => s.createdAt <= cut).map((s) => ({ ...s, lastAt: Math.min(s.lastAt, cut) })));
  });
});
