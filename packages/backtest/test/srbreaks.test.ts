import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { pinePivot, srBreaks, srBreaksReport, srbContext, srbEvents, type SrbSeries } from '../src/screen/srbreaks';
import { pivotAt } from '../src/screen/srchannels';

const H = 3_600_000, DAY = 24 * H;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000, ms = DAY): Candle => ({ openTime: Date.UTC(2025, 0, 1) + i * ms, open: o, high: h, low: l, close: c, volume: v });
/** Flat bars at 100 with a pivot high of 110 on bar 20 and a pivot low of 90 on bar 16; `edit` changes bars. */
function flat(n: number, edit: Record<number, Partial<Candle>> = {}): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const b = bar(i, 100, i === 20 ? 110 : 100.5, i === 16 ? 90 : 99.5, 100);
    return { ...b, ...edit[i] };
  });
}

describe('the script', () => {
  test('pivots match pivotAt (srchannels.ts) when left = right', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const src = Array.from({ length: 400 }, () => Math.round(rnd() * 20)); // coarse values, so ties happen
    for (let i = 0; i < src.length; i++) for (const high of [true, false]) expect(pinePivot(src, i, 15, 15, high)).toBe(pivotAt(src, i, 15, high));
  });

  test('a level starts the bar after its pivot is confirmed (fixnan(pivothigh(15, 15)[1])) and carries forward', () => {
    const sr = srBreaks(flat(60));
    expect(sr.res[35]).toBeNull(); // the pivot on bar 20 is confirmed at bar 35
    expect(sr.res[36]).toBe(110);
    expect(sr.resAt[36]).toBe(20);
    expect(sr.res[59]).toBe(110);
    expect(sr.sup[31]).toBeNull(); // a pivot needs 15 bars on both sides: bar 16 is confirmed at bar 31
    expect(sr.sup[32]).toBe(90);
  });

  test('a close over resistance: "B" with volume and a solid body, a Bull Wick with a long lower wick, nothing without volume', () => {
    const solid = srBreaks(flat(60, { 40: { open: 100, high: 112.5, low: 99.8, close: 112, volume: 20_000 } }));
    expect(solid.up[40]).toBe('B');
    expect(solid.osc[40]!).toBeGreaterThan(20);
    const wick = srBreaks(flat(60, { 40: { open: 105, high: 111.5, low: 95, close: 111 } })); // lower wick 10 > body 6, no volume
    expect(wick.up[40]).toBe('wick');
    const quiet = srBreaks(flat(60, { 40: { open: 100, high: 112.5, low: 99.8, close: 112 } }));
    expect(quiet.up[40]).toBeNull();
    expect(quiet.up.filter(Boolean)).toHaveLength(0);
  });

  test('a close under support: "B" with volume, a Bear Wick when the part above the open beats the body', () => {
    const solid = srBreaks(flat(60, { 45: { open: 100, high: 100.2, low: 84, close: 85, volume: 20_000 } }));
    expect(solid.down[45]).toBe('B');
    const wick = srBreaks(flat(60, { 45: { open: 92, high: 99, low: 87, close: 88 } })); // high - open 7 > body 4
    expect(wick.down[45]).toBe('wick');
  });

  test('crossover compares each bar with its own level (Pine), so a lower new level can be crossed on the bar it appears', () => {
    // A second pivot high (105) on bar 50 is confirmed at bar 65: resistance drops from 110 to 105 on bar 66.
    const sr = srBreaks(flat(80, { 50: { high: 105 }, 66: { open: 100, high: 107.5, low: 99.8, close: 107, volume: 20_000 } }));
    expect(sr.res[65]).toBe(110);
    expect(sr.res[66]).toBe(105);
    expect(sr.up[66]).toBe('B');
  });

  test('a bounce: the low trades to support, the close holds above it, the bar before above it too', () => {
    const c = flat(60, { 40: { open: 99, high: 100, low: 89.5, close: 95 } });
    const sr = srBreaks(c);
    expect(srbEvents(c, sr, 40)).toContain('bounce-sup');
    expect(srbEvents(c, sr, 41)).not.toContain('bounce-sup');
    const r = flat(60, { 40: { open: 101, high: 110.4, low: 100, close: 104 } });
    expect(srbEvents(r, srBreaks(r), 40)).toContain('bounce-res');
  });

  test('context buckets for a trade', () => {
    const n = 30, c = Array.from({ length: n }, (_, i) => bar(i, 100, 101, 99, 100));
    const sr: SrbSeries = { res: Array(n).fill(104), sup: Array(n).fill(99.5), resAt: Array(n).fill(0), supAt: Array(n).fill(0), osc: Array(n).fill(0), up: Array(n).fill(null), down: Array(n).fill(null) };
    const atr = Array(n).fill(1);
    sr.up[25] = 'B';
    // Long: a resistance "B" 4 bars ago is with it; support 0.5 ATR under the close; resistance 4 above the entry = 2R.
    expect(srbContext(c, sr, atr, 29, 1, 100, 2)).toEqual({ brk: 'with', own: 'at the level', room: 'in the way' });
    // Short: the same "B" is against it; resistance 4 ATR over the close = away; support 0.5 under the entry = in the way.
    expect(srbContext(c, sr, atr, 29, -1, 100, 2)).toEqual({ brk: 'against', own: 'away', room: 'in the way' });
    // A wider stop (1.5) puts resistance 2.7R from the entry: clear.
    expect(srbContext(c, sr, atr, 29, 1, 100, 1.5).room).toBe('clear');
    // The window is the signal bar and the 9 before it (bars 20-29).
    sr.up[25] = null; sr.down[19] = 'B';
    expect(srbContext(c, sr, atr, 29, 1, 100, 2).brk).toBe('none');
    sr.down[20] = 'B';
    expect(srbContext(c, sr, atr, 29, 1, 100, 2).brk).toBe('against');
    expect(srbContext(c, { ...sr, sup: Array(n).fill(103) }, atr, 29, 1, 100, 2).own).toBe('broken');
    expect(srbContext(c, { ...sr, sup: Array(n).fill(null) }, atr, 29, 1, 100, 2).own).toBe('none');
  });
});

describe('the report', () => {
  test('runs on a random walk with volume spikes and prints parts A, B, C and mergeable sums', () => {
    let seed = 5; // mulberry32 (a float LCG loses precision past 2^53 and repeats)
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const h4: Candle[] = [];
    let px = 100;
    for (let i = 0; i < 6 * 500; i++) {
      const o = px, spike = rnd() < 0.04;
      px = o * Math.exp((rnd() - 0.5) * (spike ? 0.08 : 0.02));
      h4.push(bar(i, o, Math.max(o, px) + rnd(), Math.min(o, px) - rnd(), px, spike ? 9000 : 800 + 400 * rnd(), 4 * H));
    }
    const d1: Candle[] = [];
    for (let k = 0; k + 6 <= h4.length; k += 6) {
      const g = h4.slice(k, k + 6);
      d1.push({ openTime: g[0]!.openTime, open: g[0]!.open, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)), close: g[5]!.close, volume: g.reduce((a, b) => a + (b.volume ?? 0), 0) });
    }
    const from = d1[60]!.openTime, cut = d1[300]!.openTime;
    const out = srBreaksReport({ ETHUSDT: { candles: { '4h': h4, '1d': d1 } } }, ['ETHUSDT'], from, d1[d1.length - 1]!.openTime, cut, new Set(), true);
    for (const s of ['A. THE SCRIPT', 'B. THE OTHER', 'C. CHART CHECK', 'ETHUSDT 4H:', 'ETHUSDT Daily:']) expect(out.some((l) => l.startsWith(s))).toBe(true);
    expect(out.some((l) => l.includes('resistance break "B", trade with it, long, 2R target') && l.includes('timing edge'))).toBe(true);
    const sums = out.filter((l) => l.startsWith('SUM ')).map((l) => JSON.parse(l.slice(4)) as { k: string; n: number });
    expect(sums.some((x) => x.k === 'A|4h|res-B|with|2R target' && x.n > 0)).toBe(true);
    // Each line's count in the dump equals the printed table's.
    const line = out.find((l) => l.trimStart().startsWith('bounce off support, long, 2R target') && l.includes('timing edge'))!;
    expect(Number(/\s{2,}(\d+)\s+\d+%/.exec(line)![1])).toBe(sums.find((x) => x.k === 'A|4h|bounce-sup|with|2R target')!.n);
  });
});
