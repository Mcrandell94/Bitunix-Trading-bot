import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taAtr } from '../src/screen/pine';
import { ltHeat, LTHEAT } from '../src/screen/ltheat';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number, v = 1000, o = c): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v });

describe('Liquidity Trend Heatmap [BigBeluga]', () => {
  test('flat bars: range = high + ATR .. low - ATR, 26 nodes, all volume at the node on hl2, the trend line on the close', () => {
    const c = Array.from({ length: 700 }, (_, i) => bar(i, 101, 99, 100)), r = ltHeat(c)!;
    expect(r.atr).toBeCloseTo(2, 10);
    expect([r.upper, r.lower]).toEqual([103, 97]);
    expect(r.step).toBeCloseTo(6 / 26, 12);
    expect(r.nodes).toHaveLength(26);
    expect(r.poc!.k).toBe(13);
    expect(r.poc!.level).toBeCloseTo(100, 10);
    expect(r.poc!.vol).toBeCloseTo(501 * 10, 8); // the last bar and the 500 before it, 1000 / typical price 100 each
    expect(r.shown.map((x) => x.k)).toEqual([13]);
    expect(r.middle).toBeCloseTo(100, 10);
    expect([r.trend, r.dash]).toEqual(['neutral', 'Bearish']);
  });

  test('each node takes the bars whose hl2 is within half a step; drawn from 50% of the POC; nothing before 500 bars', () => {
    let s = 3, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const c = Array.from({ length: 900 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.02); return bar(i, Math.max(o, p) * (1 + 0.003 * rnd()), Math.min(o, p) * (1 - 0.003 * rnd()), p, 1000 * (0.5 + rnd()), o); });
    const i = 850, r = ltHeat(c, i)!, atr = taAtr(c.slice(0, i + 1), LTHEAT.atrLen);
    let up = -Infinity, lo = Infinity;
    for (let k = i - 499; k <= i; k++) { up = Math.max(up, c[k]!.high + atr[k]!); lo = Math.min(lo, c[k]!.low - atr[k]!); }
    expect([r.upper, r.lower]).toEqual([up, lo]);
    for (const x of r.nodes) {
      let v = 0;
      for (let j = 0; j <= 500; j++) { const b = c[i - j]!, tp = (b.high + b.low + b.close) / 3; if (Math.abs((b.high + b.low) / 2 - x.level) <= r.step / 2) v += b.volume! / tp; }
      expect(x.vol).toBeCloseTo(v, 6);
    }
    expect(r.shown.every((x) => x.share >= 0.5)).toBe(true);
    expect(r.nodes.filter((x) => x.share >= 0.5).length).toBe(r.shown.length);
    expect(r.shown.length).toBeGreaterThan(1);
    expect(ltHeat(c, LTHEAT.lookback - 1)).toBeNull();
    // No look-ahead: the map at bar i equals the map from the bars up to it.
    expect(ltHeat(c, i)).toEqual(ltHeat(c.slice(0, i + 1)));
  });
});
