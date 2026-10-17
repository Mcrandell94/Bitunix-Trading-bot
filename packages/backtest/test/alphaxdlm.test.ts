import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { ALPHAX_DLM, dlmGaps, dlmProfile } from '../src/screen/alphaxdlm';
import { liqHeatCore } from '../src/screen/liqheat';

const H4 = 4 * 3_600_000;
const bar = (k: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: k * H4, open: o, high: h, low: l, close: c, volume: 1000 * c });
function walk(n: number, seed = 7): Candle[] {
  let s = seed, p = 2000;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(50, p + (r() - 0.5) * 30 + Math.sin(k / 40) * 5); return { openTime: k * H4, open: o, high: Math.max(o, p) + r() * 8, low: Math.min(o, p) - r() * 8, close: p, volume: 1000 * (1 + 5 * r()) * p }; });
}

describe('AlphaX Dynamic Liquidity Matrix', () => {
  test('FVGs: 3-candle gaps of 0.1 ATR or more, removed once fully filled', () => {
    const c: Candle[] = Array.from({ length: 30 }, (_, k) => bar(k, 100, 101, 99, 100));
    c.push(bar(30, 100, 101, 99, 100.5), bar(31, 100.5, 106, 100.5, 105.5), bar(32, 105.5, 108, 104, 107)); // bull gap 101..104
    c.push(bar(33, 107, 107.5, 106, 106.5), bar(34, 106.5, 106.6, 104.9, 105), bar(35, 105, 105.2, 103, 103.5));
    const g = dlmGaps(c, 32), bull = { top: 104, bot: 101, bull: true, start: 32 };
    expect(g.fvgs).toEqual([bull]);
    expect(dlmGaps(c, 34).fvgs).toEqual([bull]); // a low of 104.9 is inside the gap, not through it
    expect(dlmGaps(c, 35).fvgs).toEqual([bull, { top: 106, bot: 105.2, bull: false, start: 35 }]); // high 105.2 under low[2] 106
    c.push(bar(36, 103.5, 104, 100.8, 101)); // a low under the bull gap's bottom: filled
    expect(dlmGaps(c, 36).fvgs.some((x) => x.bull)).toBe(false);
  });

  test('FVGs: only the 8 newest are kept; a gap under 0.1 ATR is skipped', () => {
    const c: Candle[] = [];
    let p = 100;
    for (let k = 0; k < 40; k++) { c.push(bar(k, p, p + 1, p - 1, p)); }
    for (let k = 40; k < 70; k++) { p += 3; c.push(bar(k, p - 3, p + 0.5, p - 3, p)); } // each bar's low clears the high two bars back
    const g = dlmGaps(c, 69);
    expect(g.fvgs.length).toBe(ALPHAX_DLM.maxFvgs);
    expect(g.fvgs.at(-1)!.start).toBe(69);
    const tiny: Candle[] = Array.from({ length: 30 }, (_, k) => bar(k, 100, 110, 90, 100));
    tiny.push(bar(30, 100, 100.2, 99.8, 100), bar(31, 100, 100.3, 99.9, 100.3), bar(32, 100.3, 100.5, 100.21, 100.4)); // 0.01 gap, ATR ~ 19
    expect(dlmGaps(tiny, 32).fvgs).toEqual([]);
  });

  test('sweeps: a low under the 5 bars before, closing back over it on an up candle (and the mirror)', () => {
    const c: Candle[] = Array.from({ length: 10 }, (_, k) => bar(k, 100, 101, 99, 100));
    c.push(bar(10, 99.5, 100.2, 98, 100), bar(11, 100.5, 102, 99.5, 100.1), bar(12, 100, 103, 99.6, 100.5));
    const g = dlmGaps(c, 12);
    expect([g.bullSweep[10], g.bearSweep[10]]).toEqual([true, false]);
    expect([g.bullSweep[11], g.bearSweep[11]]).toEqual([false, true]); // high 102 over 101, close 100.1 under it, down candle
    expect(g.bearSweep[12]).toBe(false); // up candle
  });

  test('profile: BigBeluga\'s engine with ATR 14; the POC is the biggest bin; buy + sell = the bin', () => {
    const c = walk(1200, 41), at = c.length - 1, p = dlmProfile(c, at), core = liqHeatCore(c, at, 14, 1);
    expect(p.bins.length).toBeGreaterThan(0);
    for (const b of p.bins) expect(b.buy + b.sell).toBeCloseTo(b.vol, 6);
    const max = Math.max(...core.all.map((b) => b.vol));
    expect(p.poc!.vol).toBe(max);
    expect(p.buyPivots + p.sellPivots).toBe(core.pivots.length);
    for (const b of p.bins) expect(c[at]!.close < b.hi && c[at]!.close > b.lo).toBe(false);
    expect(p.pricePos).toBeGreaterThan(0);
    expect(p.pricePos).toBeLessThan(100);
  });

  test('no look-ahead: bars after the evaluation bar change nothing', () => {
    const c = walk(900, 5);
    for (const k of [400, 650]) {
      expect(dlmGaps(c, k)).toEqual(dlmGaps(c.slice(0, k + 1), k));
      expect(dlmProfile(c, k)).toEqual(dlmProfile(c.slice(0, k + 1), k));
    }
  });
});
