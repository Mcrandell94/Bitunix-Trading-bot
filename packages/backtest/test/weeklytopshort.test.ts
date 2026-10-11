import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { rsi } from '../src/indicators';
import { WTS, WTS_EXITS, WTS_MAINS, WTS_R3, WTS_VARIANTS, divergenceAt, emptyFunnel, liveRsi, rsiNow, rsiPeaks, seriesEntries, wilderState, wtsCoin, wtsEntries, wtsFrame, wtsGate, wtsReport, type WtsVariant } from '../src/screen/weeklytopshort';

const M15 = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H, T0 = Date.UTC(2024, 0, 1); // a Monday
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: 1 });
function agg(c: ReadonlyArray<Candle>, n: number): Candle[] {
  const out: Candle[] = [];
  for (let k = 0; k + n <= c.length; k += n) { const g = c.slice(k, k + n); out.push(bar(g[0]!.openTime, g[0]!.open, Math.max(...g.map((b) => b.high)), Math.min(...g.map((b) => b.low)), g[n - 1]!.close)); }
  return out;
}
/** 15m candles: a drift per bar, noise, and a 5% jump about every 500 bars (mulberry32). */
function path(seed: number, days: number, drift: number, vol: number, px = 1): Candle[] {
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const c: Candle[] = [];
  for (let k = 0; k < days * 96; k++) { const o = px; px = o * Math.exp(drift + vol * (rnd() - 0.5) + (rnd() < 0.002 ? 0.05 : 0)); c.push(bar(T0 + k * M15, o, Math.max(o, px) * (1 + 0.002 * rnd()), Math.min(o, px) * (1 - 0.002 * rnd()), px)); }
  return c;
}
const coinOf = (c15: Candle[]) => wtsCoin('XUSDT', agg(c15, 96), agg(c15, 16), agg(c15, 4), c15);

describe('weekly top short: RSI pieces', () => {
  test('the live RSI with the candle\'s own close is the closed RSI', () => {
    const closes = path(3, 20, 0.0001, 0.01).map((b) => b.close), r = rsi(closes, 14), st = wilderState(closes, 14);
    for (let i = 14; i + 1 < closes.length; i += 37) expect(liveRsi(closes, st, i, closes[i + 1]!)).toBeCloseTo(r[i + 1]!, 9);
    expect(liveRsi(closes, st, 5, 1)).toBeNull(); // warming up
  });

  test('rsiNow: the bar that just closed, the forming bar at a price, nothing across a gap', () => {
    const d = agg(path(4, 60, 0.0001, 0.01), 96), f = wtsFrame(d, DAY);
    expect(rsiNow(f, d[40]!.openTime + DAY, 123)).toBe(f.r[40]);
    expect(rsiNow(f, d[41]!.openTime + 5 * H, d[41]!.close)).toBeCloseTo(f.r[41]!, 9);
    const gap = wtsFrame([...d.slice(0, 41), ...d.slice(42)], DAY);
    expect(rsiNow(gap, d[42]!.openTime + 5 * H, d[42]!.close)).toBeNull();
  });

  test('peaks: above the left bars (ties to the earlier), at least the right ones, only with the right bars there', () => {
    expect(rsiPeaks([50, 51, 52, 60, 55, 54, 53, 70, 70, 69], 3, 1)).toEqual([3, 7]);
    expect(rsiPeaks([50, 51, 52, 60], 3, 1)).toEqual([]);
  });

  // A 4H frame: a peak at bar 20 (RSI 85, high 100), RSI 60 elsewhere, 78 at bar 52.
  const c4 = Array.from({ length: 60 }, (_, k) => bar(T0 + k * H4, 95, k === 20 ? 100 : 96, 94, 95));
  const r4 = Array.from({ length: 60 }, (_, k) => (k === 20 ? 85 : k === 52 ? 78 : 60));
  const f4 = wtsFrame(c4, H4, 5, 3, r4), t = c4[55]!.openTime + H4;
  test('divergence: an earlier extreme peak topped by price with a lower RSI', () => {
    expect(divergenceAt(f4, t, t - DAY, 110, null, WTS.h4)).toBe(true);
    expect(divergenceAt(f4, t, t - DAY, 110, 86, WTS.h4)).toBe(false); // RSI not lower
    expect(divergenceAt(f4, t, t - DAY, 99, null, WTS.h4)).toBe(false); // price not higher
    expect(divergenceAt(f4, t, t - 8 * H, 110, 72, WTS.h4)).toBe(false); // RSI now under 75 (bar 52 is outside 8h)
    expect(divergenceAt(f4, t, t - DAY, 110, null, { ...WTS.h4, max: 5 * DAY })).toBe(false); // the peak is 6 days old
    expect(divergenceAt(f4, t, t - DAY, 110, null, { ...WTS.h4, min: 7 * DAY })).toBe(false);
    // A peak counts only once its 3 right bars closed.
    const r = Array.from({ length: 60 }, (_, k) => (k === 53 ? 85 : 60)), c = c4.map((b, k) => (k === 53 ? { ...b, high: 100 } : { ...b, high: 96 }));
    const f = wtsFrame(c, H4, 5, 3, r), p = { ...WTS.h4, min: 0 };
    expect(divergenceAt(f, c[54]!.openTime + H4, c[54]!.openTime, 110, 78, p)).toBe(false);
    expect(divergenceAt(f, c[56]!.openTime + H4, c[56]!.openTime, 110, 78, p)).toBe(true);
  });

  test('round 2: with a range, an equal-level RSI (up to b above the earlier peak) still counts, and the levels drop by b', () => {
    expect(divergenceAt(f4, t, t - DAY, 110, 86, WTS.h4)).toBe(false); // no range: 86 is not below 85
    expect(divergenceAt(f4, t, t - DAY, 110, 86, WTS.h4, 2.5)).toBe(true);
    expect(divergenceAt(f4, t, t - DAY, 110, 88, WTS.h4, 2.5)).toBe(false); // more than 2.5 above
    expect(divergenceAt(f4, t, t - DAY, 110, 88, WTS.h4, 5)).toBe(true);
    // "Now" at 72: under 75, but within 75 - 5.
    expect(divergenceAt(f4, t, t - 8 * H, 110, 72, WTS.h4, 2.5)).toBe(false);
    expect(divergenceAt(f4, t, t - 8 * H, 110, 72, WTS.h4, 5)).toBe(true);
  });
});

describe('weekly top short: the 15m series', () => {
  /** 60 flat 15m candles (high 96, RSI 50) with the given bars set to [RSI, high]. */
  function series(set: Record<number, [number, number]>, n = 60) {
    const c = Array.from({ length: n }, (_, k) => bar(T0 + k * M15, 95, 96, 94, 95)), r: (number | null)[] = Array(n).fill(50);
    for (const [k, [v, hi]] of Object.entries(set)) { r[+k] = v; c[+k] = { ...c[+k]!, high: hi }; }
    return { c, r, atr: Array(n).fill(1), peaks: rsiPeaks(r, 3, 1) };
  }
  // The owner's STRK 15m: 86.4 -> 78.8 -> 72.9 at higher highs, then a spike to a new high with RSI 70, then RSI 66.
  const strk: Record<number, [number, number]> = { 10: [86.4, 100], 20: [78.8, 101], 30: [72.9, 101.5], 40: [70, 102.5], 41: [66, 99] };
  const ok = () => 'ok' as const, no1h = () => false, v8 = { lower: 2, windowH: 8 };

  test('the STRK shape enters at the open after the RSI closes under 70', () => {
    const f = emptyFunnel();
    expect(seriesEntries(series(strk), v8, no1h, ok, -Infinity, f)).toEqual([42]);
    expect(f).toEqual({ series: 1, triggers: 1, below70: 1, weekly: 1, daily: 1, h4: 1, h1: 1 });
    expect(seriesEntries(series({ ...strk, 10: [80, 100] }), v8, (q) => q === 10, ok)).toEqual([42]); // the anchor from the 1H RSI
  });

  test('no entry: too few lower peaks, a higher RSI peak, past the window, the trigger RSI out of range, no new high', () => {
    const { 30: _, ...one } = strk;
    expect(seriesEntries(series(one), v8, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(one), { lower: 1, windowH: 8 }, no1h, ok)).toEqual([42]);
    expect(seriesEntries(series({ ...strk, 30: [80, 101.5] }), v8, no1h, ok)).toEqual([]);
    const late = { 10: strk[10]!, 20: strk[20]!, 30: strk[30]!, 45: [70, 102.5] as [number, number], 46: [66, 99] as [number, number] }; // 8.75 hours
    expect(seriesEntries(series(late), v8, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(late), { lower: 2, windowH: 12 }, no1h, ok)).toEqual([47]);
    expect(seriesEntries(series({ ...strk, 40: [60, 102.5], 41: [55, 99] }), v8, no1h, ok)).toEqual([]);
    expect(seriesEntries(series({ ...strk, 40: [70, 101.2] }), v8, no1h, ok)).toEqual([]);
  });

  test('waiting for the RSI to close under 70; a new high cancels; a failed check stops it', () => {
    const wait: Record<number, [number, number]> = { 10: [86.4, 100], 20: [78.8, 101], 30: [76, 101.5], 40: [74, 102.5], 41: [72, 99], 42: [68, 99] };
    expect(seriesEntries(series(wait), v8, no1h, ok)).toEqual([43]);
    expect(seriesEntries(series({ ...wait, 42: [68, 103] }), v8, no1h, ok)).toEqual([]);
    const f = emptyFunnel();
    expect(seriesEntries(series(strk), v8, no1h, () => '4h', -Infinity, f)).toEqual([]);
    expect(f).toMatchObject({ triggers: 1, below70: 1, weekly: 1, daily: 1, h4: 0, h1: 0 });
  });

  test('round 2: equal-level peaks within the range continue the series; the anchor and trigger levels widen', () => {
    // 86.4 then 87.4 (1 above): with no range it ends the series (87.4 starts a new one, too short); within ±2.5 it goes on.
    const equal: Record<number, [number, number]> = { ...strk, 20: [87.4, 101], 30: [78, 101.5] };
    expect(seriesEntries(series(equal), v8, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(equal), { ...v8, band: 2.5 }, no1h, ok)).toEqual([42]);
    // 84 then 87 (3 above): ends the series at ±2.5, not at ±5.
    const three: Record<number, [number, number]> = { 10: [84, 100], 20: [87, 101], 30: [76, 101.5], 40: [70, 102.5], 41: [66, 99] };
    expect(seriesEntries(series(three), { ...v8, band: 2.5 }, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(three), { ...v8, band: 5 }, no1h, ok)).toEqual([42]);
    // An anchor at 81: under 85 - 2.5, within 85 - 5.
    const low = { ...strk, 10: [81, 100] as [number, number] };
    expect(seriesEntries(series(low), { ...v8, band: 2.5 }, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(low), { ...v8, band: 5 }, no1h, ok)).toEqual([42]);
    // A trigger at 77 (above 75) and an RSI closing at 71 (above 70): only within the range.
    const hi: Record<number, [number, number]> = { 10: [88, 100], 20: [84, 101], 30: [80, 101.5], 40: [77, 102.5], 41: [71, 99] };
    expect(seriesEntries(series(hi), v8, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(hi), { ...v8, band: 2.5 }, no1h, ok)).toEqual([42]);
  });

  test('round 3: the trigger RSI must sit in 68-73; "below 68" waits for a close under 68, "turn down" enters after the next lower close', () => {
    const r3 = { ...v8, band: 2.5, trig: WTS_R3.trig, belowLevel: WTS_R3.belowLevel };
    const below = { ...r3, entry: 'below' as const }, turn = { ...r3, entry: 'turn' as const };
    expect(seriesEntries(series({ ...strk, 40: [70.5, 102.5] }), below, no1h, ok)).toEqual([42]);
    expect(seriesEntries(series({ ...strk, 40: [66, 102.5], 41: [60, 99] }), below, no1h, ok)).toEqual([]); // under 68
    expect(seriesEntries(series({ ...strk, 30: [76, 101.5], 40: [75, 102.5] }), below, no1h, ok)).toEqual([]); // above 73
    // RSI 70 at the spike, then 69 (lower, still above 68), then 67.
    const fail: Record<number, [number, number]> = { ...strk, 41: [69, 99], 42: [67, 99] };
    expect(seriesEntries(series(fail), turn, no1h, ok)).toEqual([42]);
    expect(seriesEntries(series(fail), below, no1h, ok)).toEqual([43]);
    // A new high on the candle after the peak cancels both.
    const higher = { ...fail, 41: [69, 103] as [number, number] };
    expect(seriesEntries(series(higher), turn, no1h, ok)).toEqual([]);
    expect(seriesEntries(series(higher), below, no1h, ok)).toEqual([]);
  });
});

describe('weekly top short: the higher timeframes', () => {
  test('the first check that fails: weekly, daily, 4H', () => {
    const flat = coinOf(path(5, 200, -0.00005, 0.01)), e = flat.m15.c.length - 2;
    expect(rsiNow(flat.w, flat.m15.c[e]!.openTime + M15, flat.m15.c[e]!.close)!).toBeLessThan(WTS.weekly);
    expect(wtsGate(flat, e, 'A')).toBe('weekly');
    // A steady rise: every RSI at 100, so there are no peaks and no divergence.
    const up = Array.from({ length: 200 * 96 }, (_, k) => { const o = 1.0003 ** k; return bar(T0 + k * M15, o, o * 1.0003, o, o * 1.0003); });
    expect(wtsGate(coinOf(up), up.length - 2, 'A')).toBe('4h');
    // Then four days down: the daily RSI falls under 75, the weekly stays above 72.5.
    const last = up[up.length - 1]!.close, down = [...up, ...Array.from({ length: 4 * 96 }, (_, k) => { const o = last * 0.9995 ** k; return bar(T0 + (up.length + k) * M15, o, o, o * 0.9995, o * 0.9995); })];
    const x = coinOf(down), j = down.length - 2, tj = down[j]!.openTime + M15;
    expect(rsiNow(x.w, tj, down[j]!.close)!).toBeGreaterThan(WTS.weekly);
    expect(rsiNow(x.d1, tj, down[j]!.close)!).toBeLessThan(WTS.daily);
    expect(wtsGate(x, j, 'A')).toBe('daily');
  });

  test('round 2: the weekly check drops by the range', () => {
    const flat = coinOf(path(5, 200, -0.00005, 0.01));
    let seen = 0;
    for (let e = 120 * 96; e < flat.m15.c.length - 1; e += 37) {
      const w = rsiNow(flat.w, flat.m15.c[e]!.openTime + M15, flat.m15.c[e]!.close);
      if (w == null) continue;
      for (const b of [0, 2.5, 5]) expect(wtsGate(flat, e, 'A', b) === 'weekly').toBe(w < WTS.weekly - b);
      for (const b of [2.5, 5]) expect(wtsGate(flat, e, 'A', b, WTS_R3.weeklyFloor) === 'weekly').toBe(w < WTS_R3.weeklyFloor); // round 3: a flat floor
      if (w >= WTS.weekly - 5 && w < WTS.weekly - 2.5) seen++;
    }
    expect(seen).toBeGreaterThan(0); // some closes sit between the two ranges' levels
  });

  test('end to end on a rising random path: every entry passed its checks at the close before it', () => {
    let n = 0;
    const earlier: WtsVariant[] = ([0, 2.5, 5] as const).flatMap((band) => (['A', 'B'] as const).flatMap((daily) => ([2, 1] as const).flatMap((lower) => ([8, 12] as const).map((windowH) => ({ daily, lower, windowH, band })))));
    for (const seed of [1, 5, 9, 11]) {
      const x = coinOf(path(seed, 300, 0.0003, 0.012));
      for (const v of [...earlier, ...WTS_VARIANTS]) for (const j of wtsEntries(x, v)) {
        n++;
        expect(wtsGate(x, j - 1, v.daily, v.band, v.weeklyFloor)).toBe('ok');
        if (v.entry === 'turn') expect(x.m15.r[j - 1]!).toBeLessThan(x.m15.r[j - 2]!);
        else expect(x.m15.r[j - 1]!).toBeLessThan(v.belowLevel ?? WTS.below + v.band);
      }
    }
    expect(n).toBeGreaterThan(5);
  });

  test('the report: every cell printed, and the dumped trades are the cells\' trades', () => {
    const data: Record<string, { candles: Record<string, Candle[]>; funding: [] }> = {};
    for (const seed of [1, 5, 9]) { const c15 = path(seed, 300, 0.0003, 0.012); data[`S${seed}USDT`] = { candles: { '1d': agg(c15, 96), '4h': agg(c15, 16), '1h': agg(c15, 4), '15m': c15 }, funding: [] }; }
    const out = wtsReport(data, Object.keys(data), T0 + 30 * DAY, T0 + 300 * DAY, T0 + 150 * DAY, true);
    const cells = out.filter((l) => l.startsWith('CELL ')).map((l) => JSON.parse(l.slice(5)) as { v: number; x: number; n: number });
    expect(cells).toHaveLength(WTS_VARIANTS.length * WTS_EXITS.length);
    const trades = out.filter((l) => l.startsWith('TRADE ')).map((l) => JSON.parse(l.slice(6)) as { v: number; x: number });
    expect(trades.length).toBeGreaterThan(0);
    for (const c of cells) expect(trades.filter((t) => t.v === c.v && t.x === c.x)).toHaveLength(c.n);
    expect(out.filter((l) => l.startsWith('Named cell'))).toHaveLength(WTS_MAINS.length);
    const only = out.filter((l) => l.startsWith('ONLY ')).map((l) => JSON.parse(l.slice(5)) as { i: number; band: number; entry: string; n: number });
    expect(only.map((o) => `${o.band} ${o.entry}`)).toEqual(['2.5 below', '2.5 turn', '5 below', '5 turn']);
    for (const o of only) expect(out.filter((l) => l.startsWith('TRADE15 ') && (JSON.parse(l.slice(8)) as { i: number }).i === o.i)).toHaveLength(o.n);
    expect(only[0]!.n).toBeGreaterThan(0); // the 15m entry alone trades on these rising paths
  }, 60_000);
});
