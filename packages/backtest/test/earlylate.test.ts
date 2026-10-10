import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { earlyLateReport, earlyTest, reachAfter, worstR } from '../src/screen/earlylate';
import { specTrade } from '../src/screen/exits';

const H = 3_600_000, DAY = 24 * H;
const bar = (i: number, o: number, h: number, l: number, c: number, ms = DAY, v = 1000): Candle => ({ openTime: Date.UTC(2025, 0, 1) + i * ms, open: o, high: h, low: l, close: c, volume: v });
/** Bars at `px` (range 0.5 either side) with `edit` changing some. */
const flat = (n: number, px: number, edit: Record<number, Partial<Candle>> = {}) => Array.from({ length: n }, (_, i) => ({ ...bar(i, px, px + 0.5, px - 0.5, px), ...edit[i] }));

describe('the early test', () => {
  test('reachAfter: the first bar after k that trades through the level, -1 if none in the window, -2 past the data', () => {
    const c = flat(20, 100, { 5: { high: 110 }, 8: { low: 90 } });
    expect(reachAfter(c, 2, 1, 109, 5)).toBe(5);
    expect(reachAfter(c, 5, 1, 109, 5)).toBe(-1); // bar 5 itself does not count
    expect(reachAfter(c, 2, -1, 91, 10)).toBe(8);
    expect(reachAfter(c, 15, 1, 109, 10)).toBe(-2);
  });

  test('worstR: the furthest point against the trade between two bars, in R', () => {
    const c = flat(10, 100, { 3: { low: 96 }, 6: { high: 103 } });
    expect(worstR(c, 1, 5, 1, 100, 2)).toBe(2); // (100 - 96) / 2
    expect(worstR(c, 1, 8, -1, 100, 2)).toBe(1.5); // (103 - 100) / 2
  });

  test('a long stopped out, then the target within the window: early, with the stop that would have held', () => {
    // Entry 100 on bar 1, stop 95 (risk 5), 3R target 115. Bar 4 trades to 94 (stopped), bar 9 to 116.
    const c = flat(40, 100, { 4: { low: 94, close: 96 }, 9: { high: 116, close: 115 } });
    const t = specTrade(c, [], {}, 1, 95, 1, { name: '3R target', target: 3 })!;
    expect(t.how).toBe('stop');
    expect(t.end).toBe(4);
    expect(earlyTest(c, 1, 1, 5, t, 10)).toEqual({ early: true, plus2: true, mae: 1.2, days: 5 });
    expect(earlyTest(c, 1, 1, 5, t, 4)).toEqual({ early: false, plus2: false, mae: null, days: null }); // bars 5-8 only
    expect(earlyTest(c, 1, 1, 5, t, 40)).toBeNull(); // the window runs past the last bar
  });

  test('a short stopped out; +2R but not the target', () => {
    const c = flat(40, 100, { 3: { high: 106 }, 6: { low: 89.5 } });
    const t = specTrade(c, [], {}, 1, 105, -1, { name: '3R target', target: 3 })!;
    expect(earlyTest(c, 1, -1, 5, t, 20)).toEqual({ early: false, plus2: true, mae: null, days: null });
  });

  test('only stops at a loss count: a breakeven exit and a target are not tested', () => {
    // Close at 111 (+2.2R) moves the stop to the entry; bar 6 trades back to 99.
    const c = flat(40, 100, { 3: { high: 111.5, close: 111 }, 6: { low: 99 } });
    const be = specTrade(c, [], {}, 1, 95, 1, { name: '3R, breakeven at +2R', target: 3, be: 2 })!;
    expect(be.how).toBe('stop');
    expect(earlyTest(c, 1, 1, 5, be, 10)).toBeNull();
    const won = specTrade(flat(40, 100, { 3: { high: 116 } }), [], {}, 1, 95, 1, { name: '3R target', target: 3 })!;
    expect(won.how).toBe('target');
    expect(earlyTest(c, 1, 1, 5, won, 10)).toBeNull();
  });

  test('a trail with no target (under-floor) is tested against +3R', () => {
    const c = flat(40, 100, { 4: { low: 94 }, 9: { high: 115.5 } });
    const t = specTrade(c, [], {}, 1, 95, 1, { name: 'trail', trail: { kind: 'atr', k: 5, arm: 2 } })!;
    expect(t.target).toBeNull();
    expect(earlyTest(c, 1, 1, 5, t, 10)?.early).toBe(true);
    expect(earlyTest(flat(40, 100, { 4: { low: 94 }, 9: { high: 114 } }), 1, 1, 5, t, 10)?.early).toBe(false);
  });
});

describe('the report', () => {
  test('runs on a random walk: the sections, per-trade lines, and every re-simulated trade matches its live row', () => {
    const coins: Record<string, { candles: Record<string, Candle[]> }> = {};
    let seed = 11; // mulberry32
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      const h4: Candle[] = [];
      let px = 100;
      for (let i = 0; i < 6 * 1500; i++) {
        const o = px;
        px = o * Math.exp((rnd() - 0.5) * 0.05);
        h4.push(bar(i, o, Math.max(o, px) * (1 + 0.01 * rnd()), Math.min(o, px) * (1 - 0.01 * rnd()), px, 4 * H));
      }
      const d1: Candle[] = [];
      for (let k = 0; k + 6 <= h4.length; k += 6) {
        const g = h4.slice(k, k + 6);
        d1.push({ openTime: g[0]!.openTime, open: g[0]!.open, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)), close: g[5]!.close, volume: 1000 });
      }
      coins[sym] = { candles: { '4h': h4, '1d': d1 } };
    }
    const d1 = coins['ETHUSDT']!.candles['1d']!;
    const out = earlyLateReport(coins, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], d1[300]!.openTime, d1[d1.length - 1]!.openTime, d1[900]!.openTime, new Set(['BTCUSDT']));
    expect(out[0]).toContain('EARLY OR LATE');
    expect(out[0]).toContain('2 coins');
    for (const s of ['EARLY:', 'LATE:', 'SKIPPED AS LATE']) expect(out.some((l) => l.startsWith(s))).toBe(true);
    const [, same, resim] = /matching the live rows: (\d+) of (\d+)/.exec(out[0]!)!.map(Number);
    expect(resim).toBeGreaterThan(0);
    expect(same).toBe(resim);
    const elt = out.filter((l) => l.startsWith('ELT ')).map((l) => JSON.parse(l.slice(4)) as { s: string; st: number; e: number; ts: number; te: number });
    expect(elt).toHaveLength(resim!);
    expect(elt.every((x) => x.s !== 'BTCUSDT' && x.e <= x.st && x.te <= x.ts)).toBe(true);
  });
});
