import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taAtr } from '../src/screen/pine';
import { LUXBSL, luxBsl } from '../src/screen/luxbsl';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: c, high: h, low: l, close: c, volume: 1000 });

describe('Buyside & Sellside Liquidity [LuxAlgo]', () => {
  // Equal highs at bars 10, 20 and 30 (100), swing lows between them at 15 and 25 (97); a high of 101 at bar 36.
  const c = Array.from({ length: 41 }, (_, i) => ([10, 20, 30].includes(i) ? bar(i, 100, 98, 98.5) : [15, 25].includes(i) ? bar(i, 99, 97, 98.5) : i === 36 ? bar(i, 101, 98, 98.5) : bar(i, 99, 98, 98.5)));

  test('the third equal high draws a buyside level at the oldest one; a high over its box sweeps it', () => {
    expect(luxBsl(c, 30).buy).toEqual([]);
    const at31 = luxBsl(c, 31), atr = taAtr(c, 10), m = atr[31]! / LUXBSL.mar;
    expect(at31.buy).toHaveLength(1);
    const z = at31.buy[0]!;
    expect([z.side, z.left, z.level, z.at, z.swept]).toEqual([1, 10, 100, 31, false]);
    expect([z.top, z.bottom]).toEqual([100 + m, 100 - m]);
    expect(at31.sell).toEqual([]); // two swing lows only
    const at40 = luxBsl(c, 40).buy[0]!;
    expect([at40.swept, at40.sweptAt]).toEqual([true, 36]);
    expect(at40.zone!.lo).toBe(100);
    expect(at40.zone!.hi).toBeCloseTo(Math.min(100 + 2.3 * atr[36]!, 101), 12);
  });

  test('random walk: at most 3 levels a side, unswept ones beyond the price, levels only from the last 500 bars; no look-ahead', () => {
    let sd = 17, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const w = Array.from({ length: 2000 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.012); return bar(i, Math.max(o, p) * (1 + 0.002 * rnd()), Math.min(o, p) * (1 - 0.002 * rnd()), p); });
    let seen = 0;
    for (let i = 600; i < w.length; i += 50) {
      const r = luxBsl(w, i);
      expect(r.buy.length).toBeLessThanOrEqual(3);
      expect(r.sell.length).toBeLessThanOrEqual(3);
      for (const z of [...r.buy, ...r.sell]) {
        seen++;
        expect(i - z.at).toBeLessThanOrEqual(500);
        let hiMax = -Infinity, loMin = Infinity;
        for (let k = z.at; k <= i; k++) { hiMax = Math.max(hiMax, w[k]!.high); loMin = Math.min(loMin, w[k]!.low); }
        if (!z.swept) expect(z.side > 0 ? hiMax <= z.top : loMin >= z.bottom).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(luxBsl(w, 1500)).toEqual(luxBsl(w.slice(0, 1501)));
  });
});
