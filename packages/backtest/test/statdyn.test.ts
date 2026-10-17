import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { staticDynamicLevels, weekOf } from '../src/screen/statdyn';

const H4 = 4 * 3_600_000, DAY = 86_400_000;
const bar = (t: number, open: number, close = open + 1): Candle => ({ openTime: t, open, high: Math.max(open, close) + 5, low: Math.min(open, close) - 5, close, volume: 1 });
/** Daily bars built from 4H bars (open of the first, high / low over the day, close of the last). */
const daily = (h: Candle[]) => {
  const out: Candle[] = [];
  for (const b of h) {
    const s = Math.floor(b.openTime / DAY) * DAY, l = out.at(-1);
    if (l && l.openTime === s) { l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; }
    else out.push({ ...b, openTime: s });
  }
  return out;
};
const get = (r: ReturnType<typeof staticDynamicLevels>) => Object.fromEntries(r.levels.map((x) => [x.note, x.v]));

describe('Static + Dynamic Levels', () => {
  // 4H bars from Monday 2025-12-29 00:00 to Friday 2026-01-02 20:00, each opening 10 higher.
  const t0 = Date.UTC(2025, 11, 29), h4 = Array.from({ length: 30 }, (_, k) => bar(t0 + k * H4, 1000 + 10 * k)), d1 = daily(h4);

  test('opens of this and the last day / week / month / year, the previous day high / low; missing periods are not drawn', () => {
    expect(weekOf(Date.UTC(2026, 0, 2, 12))).toBe(t0);
    const t = Date.UTC(2026, 0, 2, 12), at = (d: number, k: number) => 1000 + 10 * (d * 6 + k); // the k-th 4H bar of day d
    const r = staticDynamicLevels(h4, d1, t);
    expect(get(r)).toEqual({ DO: at(4, 0), PDO: at(3, 0), WO: at(0, 0), MO: at(3, 0), YO: at(3, 0), PDH: at(3, 5) + 1 + 5, PDL: at(3, 0) - 5 });
    expect(r.levels.find((x) => x.note === 'WO')!.tf).toBe('W');
    expect(r.levels.find((x) => x.note === 'PDH')!.tf).toBe('D');
    // Bars after t change nothing (only closed bars are read).
    const later = Array.from({ length: 12 }, (_, k) => bar(t0 + (30 + k) * H4, 5000));
    expect(staticDynamicLevels([...h4, ...later], daily([...h4, ...later]), t)).toEqual(staticDynamicLevels(h4.filter((b) => b.openTime + H4 <= t), d1.filter((b) => b.openTime + DAY <= t), t));
  });

  test('a day that starts at t has no closed bar: its open is the last close', () => {
    const t = Date.UTC(2026, 0, 3), L = get(staticDynamicLevels(h4, d1, t));
    expect(L.DO).toBe(h4.at(-1)!.close);
    expect(L.PDO).toBe(1000 + 10 * 24);
    expect(L.PDH).toBe(1000 + 10 * 29 + 1 + 5);
  });

  test('100 / 200 DMA and WMA: the n - 1 closed days or weeks before and the last price (as live on the chart)', () => {
    const s = Date.UTC(2023, 0, 2); // a Monday
    const d = Array.from({ length: 800 }, (_, k) => bar(s + k * DAY, 100 + k, 100 + k + 0.5));
    const day0 = s + 800 * DAY, h = [bar(day0, 950, 960), bar(day0 + H4, 960, 970)], t = day0 + 2 * H4;
    const L = get(staticDynamicLevels(h, d, t)), cl = d.map((b) => b.close), price = 970;
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(L['100DMA']).toBeCloseTo(avg([...cl.slice(-99), price]), 9);
    expect(L['200DMA']).toBeCloseTo(avg([...cl.slice(-199), price]), 9);
    const weeks = cl.filter((_, k) => k % 7 === 6 && s + k * DAY < weekOf(t)); // Sunday closes of the weeks before this one
    expect(L['100WMA']).toBeCloseTo(avg([...weeks.slice(-99), price]), 9);
    expect(L['200WMA']).toBeUndefined(); // 114 weeks: not enough
    expect(L.DO).toBe(950);
    expect(L.PDH).toBe(d.at(-1)!.high);
  });
});
