import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { features, forward, LS, lsComboReport, lsReport, parseHistory, setups, squeezeDays, type LsDay } from '../src/screen/liqsqueeze';

const DAY = 86_400_000, T0 = Date.UTC(2026, 3, 1);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Daily bars: green unless listed in `red`; price steps 1 a day. */
const bars = (n: number, red: number[] = []): Candle[] => Array.from({ length: n }, (_, k) => {
  const o = 100 + k, c = red.includes(k) ? o - 2 : o + 1;
  return { openTime: T0 + k * DAY, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 1 };
});
/** Days with 10 + 10 of liquidations, funding 0.01, OI 100, except the overrides. */
const days = (n: number, over: Record<number, Partial<LsDay>> = {}): LsDay[] => Array.from({ length: n }, (_, k) => ({ t: T0 + k * DAY, long: 10, short: 10, funding: 0.01, oi: 100, ...over[k] }));

describe('liquidation squeeze study', () => {
  test('the archive: liquidation days with full coverage only, funding and OI by date', () => {
    const j = { data: {
      liquidations: [{ d: '2026-04-02', longUsd: 5, shortUsd: 1, cov: 'full' }, { d: '2026-04-01', longUsd: 2, shortUsd: 3 }, { d: '2026-04-03', longUsd: 9, shortUsd: 9, cov: 'partial' }],
      funding: [{ d: '2026-04-01', avg: 0.01 }], open_interest: [{ d: '2026-04-02', usd: 7 }],
    } };
    expect(parseHistory(j)).toEqual([
      { t: T0, long: 2, short: 3, funding: 0.01, oi: null },
      { t: T0 + DAY, long: 5, short: 1, funding: null, oi: 7 },
    ]);
  });

  test('a squeeze day: 3x the median of the 30 days before it, one-sided, the right colour; never against itself or later days', () => {
    const d = days(40, { 35: { long: 70, short: 5, oi: 95 }, 36: { short: 70, long: 5 }, 37: { long: 70, short: 50 }, 38: { long: 70, short: 5 } });
    const sq = squeezeDays(d, bars(40, [35]));
    // Day 35 long squeeze (red, OI −5%); day 36 short squeeze (green); 37 is two-sided; 38 is green so not a long squeeze.
    expect(sq.map((s) => [iso(s.t), s.side, Math.round(s.mult * 10) / 10, s.oiChg == null ? null : Math.round(s.oiChg)])).toEqual([[iso(T0 + 35 * DAY), 'long', 3.5, -5], [iso(T0 + 36 * DAY), 'short', 3.5, 5]]);
    // Fewer than 15 earlier days: no normal yet.
    expect(squeezeDays(days(20, { 10: { long: 900 } }), bars(20, [10]))).toEqual([]);
    // The same answer from the days up to the event as from the full list.
    expect(squeezeDays(d.slice(0, 36), bars(40, [35]))).toEqual(sq.slice(0, 1));
  });

  test('outcome from the next day open; setups from funding ranks and OI growth', () => {
    const c = bars(10);
    expect(forward(c, T0, 1)).toBeCloseTo((c[1]!.close / c[1]!.open - 1) * 100, 9);
    expect(forward(c, T0, 3)).toBeCloseTo((c[3]!.close / c[1]!.open - 1) * 100, 9);
    expect(forward(c, T0 + 8 * DAY, 3)).toBeNull();
    // 60 days of low funding, then 3 days of high funding with OI up 10%: crowded longs at day 62.
    const f = days(70, Object.fromEntries([60, 61, 62].map((k) => [k, { funding: 0.05, oi: k === 62 ? 110 : 100 }])));
    expect(setups(f).map((s) => [iso(s.t), s.side])).toEqual([[iso(T0 + 62 * DAY), 'long']]);
    const g = days(70, Object.fromEntries([60, 61, 62].map((k) => [k, { funding: -0.05, oi: k === 62 ? 110 : 100 }])));
    expect(setups(g).map((s) => s.side)).toEqual(['short']);
  });

  test('the report: both periods, both sides, the base lines', () => {
    const d = days(120, { 40: { long: 90, short: 1 }, 100: { short: 90, long: 1 } });
    const out = lsReport([{ coin: 'TEST', days: d, d1: bars(130, [40]) }]).join('\n');
    for (const p of LS.periods) expect(out).toContain(`--- ${p.name} ---`);
    expect(out).toContain('Long squeeze days (longs forced out, red day): 1 on 1 coins');
    expect(out).toContain('| base (all days) n ');
    expect(out).toContain('Setup "crowded longs"');
    expect(out).toContain(' TEST long squeeze · 4.5x normal'); // 90 against a normal of 20
  });

  test('round 2: the look-back and open-interest versions, and each condition from the day itself', () => {
    const d = days(100, { 80: { long: 70, short: 5, oi: 90 } });
    const c = bars(100, [80]);
    expect(squeezeDays(d, c, { normalDays: 14 }).map((s) => s.t)).toEqual([T0 + 80 * DAY]);
    expect(squeezeDays(d, c, { normalDays: 90 }).map((s) => s.t)).toEqual([T0 + 80 * DAY]); // 45 counted days are enough
    // Against open interest: the same day, 75 / 90 against 20 / 100.
    expect(squeezeDays(d, c, { perOi: true })[0]!.mult).toBeCloseTo((75 / 90) / (20 / 100) * (70 / 75), 6);
    // Twice the liquidations but twice the open interest: no squeeze against OI.
    expect(squeezeDays(days(100, { 80: { long: 70, short: 5, oi: 400 } }), c, { perOi: true })).toEqual([]);
    // Features: a red day after a steady rise is above its EMA 50 (a long squeeze with the trend), OI −10%, a sweep only if under the 20-day low.
    const s = squeezeDays(d, c)[0]!, f = features({ coin: 'X', days: d, d1: c }, s);
    expect(f).toMatchObject({ trendWith: true, flush: true, sweep: false, rsiExtreme: false });
    const low = c.map((b, k) => (k === 80 ? { ...b, low: 50 } : b)), f2 = features({ coin: 'X', days: d, d1: low }, s);
    expect([f2.sweep, f2.wick]).toEqual([true, true]); // the long lower wick reaches 50
  });

  test('round 2 report: the look-back rows, every condition, the POI rows for BTC / ETH only', () => {
    const d = days(140, { 40: { long: 90, short: 1 }, 100: { long: 90, short: 1 } });
    const c = bars(150, [40, 100]);
    const out = lsComboReport([{ coin: 'BTC', days: d, d1: c }], new Map([[`BTC|${T0 + 40 * DAY}`, true], [`BTC|${T0 + 100 * DAY}`, false]])).join('\n');
    for (const k of ['normal over 14 days', 'normal over 90 days', 'against open interest (30 days)', 'with the trend (EMA 50)', 'capitulation (long wick + sweep)', 'BTC / ETH: into a card POI: n 1', 'BTC / ETH: no card POI reached: n 1', 'base (all days, the same direction)']) expect(out).toContain(k);
  });
});
