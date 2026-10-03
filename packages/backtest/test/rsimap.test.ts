// RSI map study: weekly bars from daily, the first-touch barrier, and per-bin verdicts.
import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { mapSamples, mapTable, weeklyFromDaily, type MapSample } from '../src/screen/rsimap';

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
