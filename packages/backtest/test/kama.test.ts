import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { KAMA, heikinAshi, hlc3, kama4h, kamaCrosses, kamaDaily, kamaRecord, kamaStats, kaufman } from '../src/screen/kama';
import { priceCross } from '../src/screen/pricealerts';
import { fibArcHits, fibStates } from '../src/screen/fibarcs';
import { aggregate, mtfUtility, wyckoffEffective, type HtfSeries } from '../src/screen/wyckoffhtf';
import { DIR_ACCUM, DIR_NONE, PHASE_B, PHASE_C, PHASE_D, PHASE_E, type WyckoffBar, type WyckoffResult } from '../src/screen/wyckoff';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });

/** A seeded 4H walk and its daily bars (UTC days). */
function market(days: number, seed = 11) {
  let s = seed >>> 0, p = 2500;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const h4: Candle[] = [];
  for (let i = 0; i < days * 6; i++) { const o = p, c = o * (1 + Math.sin(i / 40) * 0.004 + (r() - 0.5) * 0.02); p = c; h4.push(bar(Date.UTC(2025, 0, 6) + i * H4, o, Math.max(o, c) * (1 + 0.004 * r()), Math.min(o, c) * (1 - 0.004 * r()), c, 1e6 * (1 + r()))); }
  const d1: Candle[] = [];
  for (const x of h4) { const t = Math.floor(x.openTime / DAY) * DAY, l = d1.at(-1); if (l && l.openTime === t) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume! += x.volume!; } else d1.push({ ...x, openTime: t }); }
  return { h4, d1 };
}

describe('KAMA (Heikin/Kaufman)', () => {
  test('Heikin Ashi candles', () => {
    const ha = heikinAshi([bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12)]);
    expect(ha[0]).toEqual({ open: 10.5, high: 12, low: 9, close: 10.5 });
    expect(ha[1]).toEqual({ open: 10.5, high: 13, low: 10, close: 11.5 });
    expect(hlc3(ha[1]!)).toBeCloseTo((13 + 10 + 11.5) / 3, 12);
  });

  test('Kaufman AMA: na for 5 bars, then from 0; ER 1 (trend) and ER 0 (flat) smoothing', () => {
    const fast = (2 / 3.5) ** 2, slow = (2 / 21) ** 2;
    const up = kaufman([1, 2, 3, 4, 5, 6, 7]);
    expect(up.slice(0, 5).every(Number.isNaN)).toBe(true);
    expect(up[5]).toBeCloseTo(fast * 6, 12);
    expect(up[6]).toBeCloseTo(up[5]! + fast * (7 - up[5]!), 12);
    const flat = kaufman([5, 5, 5, 5, 5, 5, 5]);
    expect(flat[5]).toBeCloseTo(slow * 5, 12);
    expect(flat[6]).toBeCloseTo(flat[5]! + slow * (5 - flat[5]!), 12);
  });

  test('crossover / crossunder of the fast line over the slow one', () => {
    const x = kamaCrosses({ fast: [1, 2, 3, 2, 1, 1], slow: [2, 2, 2, 2, 2, 1] }, 1);
    expect(x).toEqual([{ i: 2, dir: 1 }, { i: 4, dir: -1 }]);
  });

  test('4H fast line = the developing daily HA; at the last 4H bar of a day it equals the closed day; no look-ahead', () => {
    const { h4, d1 } = market(200), k4 = kama4h(h4, d1), kd = kamaDaily(d1);
    for (const d of [50, 120, 180]) {
      const last = h4.findIndex((b) => b.openTime === d1[d]!.openTime + 20 * H);
      expect(k4.fast[last]).toBeCloseTo(kd.fast[d]!, 9);
      // Only the days before the 4H bar's day matter: the same value from the daily bars up to the day before.
      const mid = last - 2, cut = kama4h(h4.slice(0, mid + 1), d1.slice(0, d));
      expect(cut.fast[mid]).toBeCloseTo(k4.fast[mid]!, 12);
      expect(cut.slow[mid]).toBeCloseTo(k4.slow[mid]!, 12);
    }
    expect(KAMA.warmup).toBe(300);
  });

  test('record: held to the next opposite cross (taken or not), costs in; open at the end', () => {
    const c = [100, 100, 98, 105, 99, 120].map((p) => ({ high: p + 1, low: p - 1, close: p }));
    const x = [{ i: 1, dir: 1 as const }, { i: 3, dir: -1 as const }, { i: 4, dir: 1 as const }];
    const all = kamaRecord(c, x, () => true);
    expect(all.map((t) => [t.i, t.exitAt])).toEqual([[1, 3], [3, 4], [4, -1]]);
    expect(all[0]!.ret).toBeCloseTo((0.05 - KAMA.cost) * 100, 9);
    expect(all[0]!.mae).toBeCloseTo(-3, 9); // bar 2 low 97 against the 100 entry
    expect(all[1]!.ret).toBeCloseTo(((105 - 99) / 105 - KAMA.cost) * 100, 9);
    const skip = kamaRecord(c, x, (s) => s.dir > 0);
    expect(skip.map((t) => [t.i, t.exitAt])).toEqual([[1, 3], [4, -1]]);
    const st = kamaStats(skip);
    expect(st).toMatchObject({ signals: 2, closed: 1, wins: 1 });
  });
});

describe('price alerts (sweep / break)', () => {
  test('from below: wick through and back = swept, close through = broken; from above mirrored; untouched = null', () => {
    expect(priceCross(99, { high: 101, low: 98, close: 99.5 }, 100)).toEqual({ kind: 'swept', up: true });
    expect(priceCross(99, { high: 101, low: 98, close: 100.5 }, 100)).toEqual({ kind: 'broken', up: true });
    expect(priceCross(101, { high: 102, low: 99, close: 100 }, 100)).toEqual({ kind: 'swept', up: false });
    expect(priceCross(101, { high: 102, low: 99, close: 99.9 }, 100)).toEqual({ kind: 'broken', up: false });
    expect(priceCross(99, { high: 99.9, low: 98, close: 99 }, 100)).toBeNull();
  });

  test('Fib arc hits: each from the swing known after the bar before, once per swing, arc and kind', () => {
    const { h4 } = market(300, 5), st = fibStates(h4).states, hits = fibArcHits(h4, st);
    expect(hits.length).toBeGreaterThan(0);
    const keys = hits.map((h) => `${h.anchorBar}|${h.ratio}|${h.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const h of hits) {
      expect(st[h.i - 1]!.swingIndex).toBe(h.anchorBar);
      expect(priceCross(h4[h.i - 1]!.close, h4[h.i]!, h.price)).toEqual({ kind: h.kind, up: h.up });
    }
  });
});

describe('Wyckoff higher-timeframe override', () => {
  const wb = (o: Partial<WyckoffBar>): WyckoffBar => ({ stop: DIR_ACCUM, outcome: 0, wdir: DIR_ACCUM, type: 0, phase: PHASE_B, ev: 0, conf: 0, val: 50, rangeHigh: 110, rangeLow: 90, sig: 0, entryTime: NaN, entryPrice: NaN, entryKind: 0, lastEventTime: NaN, lastEventPrice: NaN, exc: NaN, ...o });
  const res = (bars: WyckoffBar[]) => ({ bars }) as unknown as WyckoffResult;

  test('weekly bars start Monday 00:00 UTC, monthly on the 1st', () => {
    const d1 = Array.from({ length: 40 }, (_, k) => bar(Date.UTC(2026, 8, 25) + k * DAY, 1, 2, 0.5, 1.5)); // Fri 2026-09-25 on
    const w = aggregate(d1, 'W');
    expect(new Date(w.c[0]!.openTime).toISOString().slice(0, 10)).toBe('2026-09-21');
    expect(new Date(w.c[1]!.openTime).toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(w.ends[0]).toBe(Date.UTC(2026, 8, 28));
    const m = aggregate(d1, 'M');
    expect(m.c.map((b) => new Date(b.openTime).toISOString().slice(0, 10))).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(m.ends[1]).toBe(Date.UTC(2026, 10, 1));
  });

  test('utility: validation + phase x 4 - distance outside the range - age; chart +5; Phase E -10', () => {
    const b = wb({ val: 40, phase: PHASE_C, lastEventTime: 0 });
    expect(mtfUtility(b, 100, 10 * DAY, 86_400, false)).toBeCloseTo(40 + 12, 9);
    expect(mtfUtility(b, 120, 10 * DAY, 86_400, true)).toBeCloseTo(40 + 12 - 6 + 5, 9); // 10 over a 20 range = 0.5 x 12
    expect(mtfUtility({ ...b, lastEventTime: 0 }, 100, 30 * DAY, 86_400, false)).toBeCloseTo(52 - 3.5, 9); // age 30: (30 - 20) x 0.35
    expect(mtfUtility({ ...b, phase: PHASE_E }, 100, 10 * DAY, 86_400, false)).toBeCloseTo(40 + 20 - 10, 9);
  });

  test('a farther phase wins, ties go by utility, and a higher bar is read only once it has closed', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(DAY, 100, 101, 99, 100), bar(2 * DAY, 100, 101, 99, 100)];
    const own = res(c.map(() => wb({ phase: PHASE_B, val: 10 })));
    const W: HtfSeries = { tf: 'W', c: [], ends: [DAY, 3 * DAY], wy: res([wb({ phase: PHASE_D, val: 0 }), wb({ phase: PHASE_E })]) };
    const e = wyckoffEffective(c, own, '1D', [W]);
    expect(e.map((x) => x.tf)).toEqual(['1D', 'W', 'W']); // bar 0 opens before the first W bar has ended
    expect(e[1]!.bar.phase).toBe(PHASE_D);
    const tie: HtfSeries = { tf: 'W', c: [], ends: [0], wy: res([wb({ phase: PHASE_B, val: 30 })]) };
    expect(wyckoffEffective(c, own, '1D', [tie])[0]!.tf).toBe('W'); // 30 + 8 > 10 + 8 + 5
    const low: HtfSeries = { tf: 'W', c: [], ends: [0], wy: res([wb({ phase: PHASE_B, val: 0 })]) };
    expect(wyckoffEffective(c, own, '1D', [low])[0]!.tf).toBe('1D');
    const none: HtfSeries = { tf: 'W', c: [], ends: [0], wy: res([wb({ phase: PHASE_E, stop: DIR_NONE })]) };
    expect(wyckoffEffective(c, own, '1D', [none])[0]!.tf).toBe('1D'); // no stop side: ignored
  });
});
