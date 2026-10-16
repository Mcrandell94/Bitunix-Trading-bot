import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinVolume } from '../src/screen/pine';
import { fluxObs } from '../src/screen/fluxob';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: c, high: h, low: l, close: c, volume: v * (h + l + c) / 3 });

describe('Volumized Order Blocks [Flux Charts]', () => {
  // A swing low at bar 10 (90), a swing high at bar 30 (110), the dip's lowest bar 36 (95-97), a close over 110 at 45.
  const c: Candle[] = Array.from({ length: 60 }, (_, i) => {
    if (i === 10) return bar(i, 100.5, 90, 99);
    if (i === 30) return bar(i, 110, 104, 106);
    if (i > 30 && i < 45) return i === 36 ? bar(i, 97, 95, 96) : bar(i, 103 - Math.abs(i - 37) * 0.2, 98 - Math.abs(i - 36) * 0.1, 100);
    if (i >= 45) return i === 50 ? bar(i, 114, 94, 113) : bar(i, 114, 111, 113);
    return bar(i, 100.5, 99.5, 100, 1000 + i);
  });

  test('the first close over a swing high takes the lowest bar since it as a bullish block; a wick under breaks it, a high over its top removes it', () => {
    const at45 = fluxObs(c, 45), v = coinVolume(c);
    expect(at45.bull).toHaveLength(1);
    const z = at45.bull[0]!;
    expect([z.side, z.top, z.bottom, z.startAt, z.breaker]).toEqual([1, 97, 95, 36, false]);
    expect(z.vol).toBeCloseTo(v[45]! + v[44]! + v[43]!, 9);
    expect([z.highVol, z.lowVol]).toEqual([v[45]! + v[44]!, v[43]!]);
    expect(at45.shown.map((x) => [x.top, x.bottom])).toEqual([[97, 95]]);
    expect(fluxObs(c, 49).bull[0]!.breaker).toBe(false);
    const at50 = fluxObs(c, 50);
    expect([at50.bull[0]!.breaker, at50.bull[0]!.breakTime]).toEqual([true, c[50]!.openTime]); // the wick to 94
    expect(at50.shown[0]!.breaker).toBe(true);
    expect(fluxObs(c, 51).bull).toEqual([]); // high 114 over its top
    expect(fluxObs(c, 44).bull).toEqual([]);
  });

  test('random walk: at most 3 + 3 shown, same-side shown blocks never overlap, each shown original sits inside one; no look-ahead', () => {
    let s = 3, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const w = Array.from({ length: 2600 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return bar(i, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd()), p, 500 + 1000 * rnd()); });
    let merges = 0;
    for (let i = 1800; i < w.length; i += 40) {
      const r = fluxObs(w, i), now = w[i]!.openTime + 1;
      expect(r.shown.length).toBeLessThanOrEqual(6);
      expect(r.bull.length).toBeLessThanOrEqual(30);
      for (const a of r.shown) for (const b of r.shown) {
        if (a === b || a.side !== b.side) continue;
        const t = Math.min(a.breakTime ?? now, b.breakTime ?? now) - Math.max(a.startTime, b.startTime), y = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
        expect(t > 0 && y > 0).toBe(false);
      }
      for (const z of [...r.bull.slice(0, 3), ...r.bear.slice(0, 3)]) expect(r.shown.some((x) => x.side === z.side && x.top >= z.top && x.bottom <= z.bottom)).toBe(true);
      merges += r.shown.filter((x) => x.combined).length;
      for (const z of r.bull) expect(z.top - z.bottom).toBeGreaterThanOrEqual(0);
    }
    expect(merges).toBeGreaterThan(0);
    expect(fluxObs(w, 2000)).toEqual(fluxObs(w.slice(0, 2001)));
  });
});
