import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { openLiq, OPENLIQ } from '../src/screen/openliq';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: Date.UTC(2025, 0, 1) + i * H4, open: c, high: h, low: l, close: c, volume: v });

describe('Open Liquidity Heatmap [BigBeluga]', () => {
  // 198 flat bars (101 / 99, close 100: coin volume 10 each), a bar with a lower low (98) on double volume, the last bar inside.
  const c = [...Array.from({ length: 198 }, (_, i) => bar(i, 101, 99, 100)), bar(198, 101, 98, 100, 2000), bar(199, 100.5, 99.5, 100)];
  const hs = 101 * 1.045, ls = 98 * 0.955, diff = (hs - ls) / 250, band = (px: number) => Math.floor((hs - px) / diff);

  test('the grid, each bar\'s liquidation levels while no newer bar has traded to them, the POC and the bright zones', () => {
    const r = openLiq(c);
    expect([r.hs, r.ls, r.diff]).toEqual([hs, ls, diff]);
    expect(r.heat).toHaveLength(249);
    // Short side: every bar's high x 1.045; the 101 highs sit on the top line (band 0), the last bar's in band 10.
    expect(r.heat[0]).toBeCloseTo(198 * 10 + 2000 / ((101 + 98 + 100) / 3), 8);
    expect(band(100.5 * 1.045)).toBe(10);
    // Long side: the flat bars' 99 x 0.955 (under the running low 98 from bar 198 on), the last bar's own 99.5 x 0.955.
    expect(r.heat[band(99 * 0.955)]).toBeCloseTo(198 * 10, 8);
    expect(r.heat[10]! + r.heat[band(99.5 * 0.955)]!).toBeCloseTo(20, 8);
    // The lowest low's level is the grid's bottom (ls), under the last line: not counted, as in the script.
    expect(r.heat.reduce((a, b) => a + b, 0)).toBeCloseTo(198 * 10 + 2000 / ((101 + 98 + 100) / 3) + 198 * 10 + 20, 6);
    expect(r.poc).toBe(hs);
    // Bright = over the mean of the bands with volume: band 0 (the POC) and the flat bars' long level, centred on their levels.
    expect(r.zones.map((z) => [z.poc, z.lo, z.hi])).toEqual([[true, hs - diff / 2, hs + diff / 2], [false, hs - diff * band(99 * 0.955) - diff / 2, hs - diff * band(99 * 0.955) + diff / 2]]);
  });

  test('a level a newer bar has already traded through is gone', () => {
    const swept = [...c.slice(0, 199), bar(199, 100.5, 94, 100)]; // the last bar wicks to 94, under 99 x 0.955
    const r = openLiq(swept), lo = 94 * 0.955, h = 101 * 1.045, d = (h - lo) / 250;
    expect(r.heat[Math.floor((h - 99 * 0.955) / d)]).toBe(0);
    expect(r.heat.reduce((a, b) => a + b, 0)).toBeGreaterThan(0); // the short side is still there
  });

  test('nothing before 200 bars; no look-ahead: the map at a past bar equals the map from the bars up to it', () => {
    expect(openLiq(c.slice(0, OPENLIQ.back - 1)).zones).toEqual([]);
    let s = 7, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const w = Array.from({ length: 900 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.03); return { ...bar(i, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd()), p, 1000 * (0.5 + rnd())), open: o }; });
    expect(openLiq(w, 600)).toEqual(openLiq(w.slice(0, 601)));
    expect(openLiq(w, 600).zones.length).toBeGreaterThan(0);
  });
});
