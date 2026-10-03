// RSI map study: weekly bars from daily, the first-touch barrier, and per-bin verdicts.
import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { comboTable, mapSamples, mapTable, weeklyAtDaily, weeklyFromDaily, type ComboSample, type MapSample } from '../src/screen/rsimap';
import { prismRsi } from '../src/screen/prismrsi';

const DAY = 86_400_000;
// 1970-01-05 was a Monday.
const MON = 4 * DAY;

describe('RSI map', () => {
  test('weekly bars: Monday-to-Sunday, complete weeks only, OHLC rolled up', () => {
    const d: Candle[] = Array.from({ length: 17 }, (_, i) => ({ openTime: MON - 2 * DAY + i * DAY, open: 10 + i, high: 20 + i, low: 5 + i, close: 11 + i, volume: 1 }));
    const w = weeklyFromDaily(d); // days -2,-1 (partial week) dropped; two full weeks; last day (partial) dropped
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ openTime: MON, open: 12, high: 28, low: 7, close: 19, volume: 7 });
    expect(w[1]!.openTime).toBe(MON + 7 * DAY);
  });

  test('first touch: +1 ATR before -1 ATR counts up; a bar touching both counts as none', () => {
    const H = 3_600_000;
    // A flat start for ATR (range 2 -> ATR ~2), then a rise.
    const flat = Array.from({ length: 40 }, (_, i) => ({ openTime: i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const rise = [{ openTime: 40 * H, open: 100, high: 103, low: 99.5, close: 102.5, volume: 1 }, ...Array.from({ length: 5 }, (_, k) => ({ openTime: (41 + k) * H, open: 102, high: 103, low: 101, close: 102, volume: 1 }))];
    const s = mapSamples([...flat, ...rise], 3, 39 * H, 50 * H, 0);
    expect(s[0]!.first).toBe('up');
    const both = [...flat, { openTime: 40 * H, open: 100, high: 104, low: 96, close: 100, volume: 1 }, ...rise.slice(1)];
    expect(mapSamples(both, 3, 39 * H, 50 * H, 0)[0]!.first).toBe('none');
  });

  test('verdicts: a bin whose long edge beats the base by 3+ points in both periods reads LONG', () => {
    const mk = (rsi: number, first: MapSample['first'], old: boolean): MapSample => ({ rsi, twistUp: true, fwd: 0, first, old });
    const xs: MapSample[] = [];
    for (const old of [true, false]) {
      for (let i = 0; i < 60; i++) xs.push(mk(30, i % 3 ? 'up' : 'down', old)); // low RSI: up 2/3
      for (let i = 0; i < 60; i++) xs.push(mk(70, i % 3 ? 'down' : 'up', old)); // high RSI: down 2/3
      for (let i = 0; i < 60; i++) xs.push(mk(50, i % 2 ? 'up' : 'down', old));
    }
    const t = mapTable(xs, 'T').join('\n');
    expect(t).toMatch(/25-32 .*LONG/);
    expect(t).toMatch(/68-75 .*SHORT/);
    expect(t).not.toMatch(/50-55 .*(LONG|SHORT)/);
  });
});

describe('weekly x daily map', () => {
  const d: Candle[] = Array.from({ length: 400 }, (_, i) => { const x = 100 + 20 * Math.sin(i / 25) + i * 0.05; return { openTime: MON + i * DAY, open: x, high: x + 1, low: x - 1, close: x, volume: 1 }; });

  test('the weekly RSI known on a day: no look-ahead, and on a Sunday it equals the weekly bars\' value', () => {
    const full = weeklyAtDaily(d), part = weeklyAtDaily(d.slice(0, 250));
    for (let i = 0; i < 250; i++) expect(part[i]).toBe(full[i]);
    const wk = prismRsi(weeklyFromDaily(d).map((b) => b.close)).mid;
    expect(full[7 * 30 + 6]).toBeCloseTo(wk[30]!, 9); // the Sunday closing week 31
  });

  test('cells: a weekly-low / daily-low cell that goes up first reads L', () => {
    const xs: ComboSample[] = [];
    for (const old of [true, false]) for (let i = 0; i < 300; i++) {
      xs.push({ w: 30, rsi: 30, twistUp: true, fwd: 0, first: i % 3 ? 'up' : 'down', old });
      xs.push({ w: 60, rsi: 45, twistUp: true, fwd: 0, first: i % 2 ? 'up' : 'down', old });
    }
    const t = comboTable(xs, 150).join('\n');
    expect(t).toMatch(/best LONG cells: W 0-38 & D 0-32/);
  });
});

describe('weekly signal events', () => {
  test('Prism flips: bull only below 50, bear only above 50; exhaustion after touching 20 / 80', async () => {
    const { prismFlipEvents } = await import('../src/screen/rsimap');
    const ev = prismFlipEvents({
      fast: [30, 15, 30, 45, 55, 85, 60, 40],
      slow: [35, 30, 28, 47, 52, 60, 62, 55],
    });
    expect(ev.map((e) => [e.i, e.d, e.kind])).toEqual([[2, 1, 'exhaustion'], [6, -1, 'exhaustion']]);
    // fast crosses up at i=4 too (45 -> 55 over 47 -> 52)? 45 <= 47 and 55 > 52 but slow 52 > 50: filtered out.
  });

  test('RSI divergence: price lower low with an RSI higher low reads bullish, on the bar the pivot is confirmed', async () => {
    const { divergenceEvents } = await import('../src/screen/rsimap');
    const n = 30;
    const low = Array.from({ length: n }, () => 100), r: number[] = Array.from({ length: n }, () => 50);
    low[8] = 90; r[8] = 25; // first low
    low[18] = 85; r[18] = 32; // lower price low, higher RSI low
    const c = low.map((l, i) => ({ openTime: i, open: l + 2, high: l + 4, low: l, close: l + 2, volume: 1 }));
    const ev = divergenceEvents(c, r);
    expect(ev).toEqual([{ i: 21, d: 1, kind: 'divergence' }]);
  });

  test('flip + divergence: a flip the same way within 6 bars after a divergence', async () => {
    const { flipDivEvents } = await import('../src/screen/rsimap');
    const flips = [{ i: 25, d: 1 as const, kind: 'flip' as const }, { i: 40, d: 1 as const, kind: 'flip' as const }, { i: 24, d: -1 as const, kind: 'flip' as const }];
    expect(flipDivEvents(flips, [{ i: 21, d: 1, kind: 'divergence' }]).map((e) => e.i)).toEqual([25]);
  });

  test('RSI floor: prior lowest RSI after warm-up; first entry into floor..floor+5, and a new low reads under-floor', async () => {
    const { rsiFloorEvents } = await import('../src/screen/rsimap');
    const r = [50, 20, 50, 50, 23, 24, 50, 50, 18, 50];
    expect(rsiFloorEvents(r, 5, 2, 1).map((e) => [e.i, e.kind, e.floor])).toEqual([[4, 'floor', 20], [8, 'under-floor', 20]]);
  });

  test('stretch top: RSI higher high >= 70 without a price high, then the next bearish divergence', async () => {
    const { stretchTopEvents } = await import('../src/screen/rsimap');
    const n = 60;
    const high = Array.from({ length: n }, () => 100), r: number[] = Array.from({ length: n }, () => 50);
    high[10] = 120; r[10] = 68; // first RSI high
    high[20] = 121; r[20] = 80; // RSI stretches +12, price only +0.8%
    const c = high.map((h, i) => ({ openTime: i, open: h - 2, high: h, low: h - 4, close: h - 2, volume: 1 }));
    const divs = [{ i: 15, d: -1 as const, kind: 'divergence' as const }, { i: 40, d: -1 as const, kind: 'divergence' as const }, { i: 45, d: -1 as const, kind: 'divergence' as const }];
    expect(stretchTopEvents(c, r, divs).map((e) => [e.i, e.kind])).toEqual([[40, 'stretch-top']]);
  });

  test('top divergence: RSI 85 high, then a higher price high at RSI 79', async () => {
    const { topDivEvents } = await import('../src/screen/rsimap');
    const n = 40;
    const high = Array.from({ length: n }, () => 100), r: number[] = Array.from({ length: n }, () => 50);
    high[10] = 120; r[10] = 85;
    high[25] = 125; r[25] = 79;
    const c = high.map((h, i) => ({ openTime: i, open: h - 2, high: h, low: h - 4, close: h - 2, volume: 1 }));
    expect(topDivEvents(c, r).map((e) => [e.i, e.kind])).toEqual([[28, 'top-div']]);
    r[25] = 72; // second high under 75: only the looser band
    expect(topDivEvents(c, r)).toEqual([]);
    expect(topDivEvents(c, r, 70, 60, 'high-div').map((e) => e.i)).toEqual([28]);
  });

  test('RSI 30-35 support: lost, held divergence, reclaim divergence, reclaim, and the full sequence', async () => {
    const { supportEvents } = await import('../src/screen/rsimap');
    const n = 60;
    const low = Array.from({ length: n }, () => 100), r: number[] = Array.from({ length: n }, () => 50);
    r[9] = 40; r[10] = 28; low[10] = 90; // support lost at 10 (pivot low)
    r[11] = 40;
    r[20] = 22; low[20] = 92; // RSI tanks, price holds: held-div (confirmed at 23)
    r[21] = 33;
    r[30] = 33; low[30] = 88; // price lower low, RSI back above 30: reclaim-div + sequence (confirmed at 33)
    const c = low.map((l, i) => ({ openTime: i, open: l + 2, high: l + 4, low: l, close: l + 2, volume: 1 }));
    const ev = supportEvents(c, r).map((e) => [e.i, e.kind]);
    expect(ev).toContainEqual([10, 'support-lost']);
    expect(ev).toContainEqual([11, 'reclaim']);
    expect(ev).toContainEqual([23, 'held-div']);
    expect(ev).toContainEqual([33, 'reclaim-div']);
    expect(ev).toContainEqual([33, 'sequence']);
  });
});
