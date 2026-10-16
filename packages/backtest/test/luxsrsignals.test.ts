import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { luxSrActive, luxSrSignals } from '../src/screen/luxsrsignals';

const H4 = 4 * 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v * (h + l + c) / 3 });

describe('Support and Resistance Signals MTF [LuxAlgo]', () => {
  // Flat bars, a pivot high at bar 20 (105, confirmed at 35), a breakout close at bar 40, a dip into the zone at bar 45,
  // a long lower shadow on 5x volume at bar 50. (Bar 39 is a pivot low, confirmed at bar 54: the checks stop at 53.)
  const c: Candle[] = Array.from({ length: 60 }, (_, i) =>
    i === 20 ? bar(i, 100, 105, 99.5, 100) : i === 40 ? bar(i, 104.5, 106.5, 104, 106) : i === 45 ? bar(i, 106, 106.5, 104.9, 106) : i === 50 ? bar(i, 106, 106.5, 101, 106, 5000) : i > 40 ? bar(i, 106, 106.5, 105.5, 106) : bar(i, 100, 100.5, 99.5, 100));
  const m = 1 / 100.5; // the 15-bar range over its high at bar 35

  test('a pivot high draws a resistance zone down m x 0.34 from it; a close past top + m x 0.17 breaks it and draws a support there', () => {
    const at36 = luxSrSignals(c, 36);
    expect(at36.R).toHaveLength(2); // the zone and the start-up entry
    const z = at36.R[0]!;
    expect([z.kind, z.top, z.left, z.at, z.b]).toEqual(['R', 105, 20, 35, false]);
    expect(z.bottom).toBeCloseTo(105 * (1 - m * 0.34), 12);
    expect(luxSrActive(at36).map((x) => x.kind)).toEqual(['R']);
    expect(luxSrSignals(c, 40).R[0]!.b).toBe(false); // the close is checked on the next bar
    const r = luxSrSignals(c, 53);
    expect(r.R[0]!.b).toBe(true);
    const s = r.S[0]!;
    expect([s.kind, s.from, s.top, s.left, s.b, s.r]).toEqual(['S', 'flip', 105, 40, false, true]);
    expect(s.bottom).toBe(r.R[0]!.bottom);
    expect(r.events.map((e) => [e.kind, e.i, e.dir])).toEqual([['breakout', 40, 1], ['retest', 45, 1], ['rejection', 50, 1]]); // bar 45 opens over, wicks in, closes over
    expect(luxSrSignals(c, 54).S[0]!.left).toBe(39); // the pivot low's support, drawn at once (the second support always is)
    expect(luxSrActive(r).map((x) => `${x.kind} ${x.from}`)).toEqual(['S flip']);
  });

  test('random walk: zones are well formed, broken ones flip, signals sit on past bars; no look-ahead', () => {
    let sd = 13, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const w = Array.from({ length: 1600 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return bar(i, o, Math.max(o, p) * (1 + 0.005 * rnd()), Math.min(o, p) * (1 - 0.005 * rnd()), p, 500 + 1000 * rnd() + (rnd() < 0.03 ? 4000 : 0)); });
    const r = luxSrSignals(w);
    for (const z of [...r.R, ...r.S].filter((x) => !x.empty)) {
      expect(z.top).toBeGreaterThan(z.bottom);
      expect(z.left).toBeLessThanOrEqual(z.at);
    }
    expect(r.R.filter((x) => x.from === 'flip').length + r.S.filter((x) => x.from === 'flip').length).toBe(r.events.filter((e) => e.kind === 'breakout').length);
    for (const k of ['breakout', 'test', 'retest'] as const) for (const d of [1, -1]) expect(r.events.some((e) => e.kind === k && e.dir === d)).toBe(true);
    expect(r.events.every((e) => e.i >= 0 && e.i < w.length - 1)).toBe(true);
    expect(luxSrActive(r).every((z) => !z.b)).toBe(true);
    expect(luxSrSignals(w, 1100)).toEqual(luxSrSignals(w.slice(0, 1101)));
  });
});
