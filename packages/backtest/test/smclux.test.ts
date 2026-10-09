import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { pineAtr, smcLux, smcZoneCursor, smcZonesBefore } from '../src/screen/smclux';
import { zoneScore } from '../src/screen/zonescore';

const H4 = 4 * 3_600_000;
/** A path through `points` (price, bars to get there), each bar 0.2 of wick beyond its body. */
function path(points: [number, number][]): Candle[] {
  const out: Candle[] = [];
  let px = points[0]![0];
  for (const [to, bars] of points) for (let i = 1; i <= bars; i++) {
    const o = px, c = px + ((to - px) * 1) / (bars - i + 1);
    out.push({ openTime: out.length * H4, open: o, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2, close: c, volume: 1 });
    px = c;
  }
  return out;
}
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: t * H4, open: o, high: h, low: l, close: c, volume: 1 });

describe('LuxAlgo Smart Money Concepts port', () => {
  const c = path([[100, 10], [110, 6], [104, 6], [116, 6], [108, 6], [122, 6], [90, 10], [90, 5]]);
  const s = smcLux(c, { swingLen: 4, internalLen: 2 });

  test('structure: the first break is a BOS; breaking down after the uptrend is a CHoCH', () => {
    const swing = s.events.filter((e) => e.scope === 'swing');
    expect(swing.length).toBeGreaterThan(1);
    expect(swing[0]!.kind).toBe('BOS');
    expect(swing[0]!.dir).toBe(1);
    const firstDown = swing.find((e) => e.dir === -1)!;
    expect(firstDown.kind).toBe('CHoCH');
    expect(s.swingTrend[c.length - 1]).toBe(-1);
  });

  test('internal structure: small pullbacks inside a leg give internal breaks at levels the swing pivots do not use', () => {
    const w = path([[100, 10], [106, 4], [104, 2], [110, 4], [104, 6], [109, 3], [107, 2], [116, 5], [100, 10], [100, 5]]);
    const x = smcLux(w, { swingLen: 4, internalLen: 2 });
    const internal = x.events.filter((e) => e.scope === 'internal'), swingLevels = new Set(x.events.filter((e) => e.scope === 'swing').map((e) => e.level));
    expect(internal.length).toBeGreaterThan(0);
    for (const e of internal) expect(swingLevels.has(e.level) && x.events.find((y) => y.scope === 'swing' && y.t === e.t)).toBeFalsy();
  });

  test('order block: the lowest low between the broken swing high and the break; removed when a low goes under it', () => {
    const e = s.events.find((x) => x.scope === 'swing' && x.dir === 1)!;
    const ob = s.zones.find((z) => z.kind === 'ob-swing' && z.bias === 1 && z.created === e.t)!;
    expect(ob).toBeDefined();
    expect(ob.bottom).toBe(c[ob.from]!.low);
    expect(ob.top).toBe(c[ob.from]!.high);
    for (let k = ob.from; k < e.t; k++) expect(c[k]!.low).toBeGreaterThanOrEqual(ob.bottom);
    let k = ob.created;
    while (k < c.length && c[k]!.low >= ob.bottom) k++;
    expect(ob.removed).toBe(k < c.length ? k : Infinity);
  });

  test('no lookahead; the sweep cursor matches the direct lookup', () => {
    for (const z of s.zones) expect(smcZonesBefore(s, z.created)).not.toContain(z);
    const at = smcZoneCursor(s);
    for (let t = 0; t <= c.length; t++) expect(at(t)).toEqual(smcZonesBefore(s, t));
  });

  test('fair value gaps: bullish removed below its bottom; bearish removed on the first touch (as the script)', () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    const up = [...flat, bar(30, 100, 104.5, 99.8, 104), bar(31, 104, 105, 101, 104), bar(32, 104, 104.5, 100.8, 102), bar(33, 102, 102.5, 100.4, 101)];
    const g = smcLux(up).zones.find((z) => z.kind === 'fvg')!;
    expect(g).toMatchObject({ bias: 1, top: 101, bottom: 100.5, created: 31, removed: 33 });
    const down = [...flat, bar(30, 100, 100.2, 95.5, 96), bar(31, 96, 99, 95, 96), bar(32, 96, 99.2, 95.5, 97)];
    const h = smcLux(down).zones.find((z) => z.kind === 'fvg')!;
    expect(h).toMatchObject({ bias: -1, top: 99.5, bottom: 99, created: 31, removed: 32 });
  });

  test('ATR(200): seeded with the mean of the first 200 true ranges', () => {
    const cs = Array.from({ length: 210 }, (_, i) => bar(i, 100, 100.5, 99.5, 100));
    const a = pineAtr(cs, 200);
    expect(a[198]).toBeNaN();
    expect(a[199]).toBeCloseTo(1);
    expect(a[209]).toBeCloseTo(1);
  });
});

describe('zone score', () => {
  test('fixed weights, each kind / timeframe once, capped at 10', () => {
    const hit = (kind: 'ob-swing' | 'ob-internal' | 'fvg' | 'sr-deep', tf: '4h' | '1d', first = false) => ({ kind, tf, first, top: 1, bottom: 0 });
    expect(zoneScore({ hits: [hit('ob-swing', '1d', true), hit('fvg', '4h'), hit('fvg', '4h')], discount: true, trendWith: false })).toEqual({ score: 6, labels: ['1D swing OB', '4H FVG'] });
    expect(zoneScore({ hits: [hit('sr-deep', '4h', true)], discount: false, trendWith: false }).score).toBe(2); // S/R has no first-touch point
    const all = (['ob-swing', 'ob-internal', 'fvg', 'sr-deep'] as const).flatMap((k) => [hit(k, '1d', true), hit(k, '4h')]);
    expect(zoneScore({ hits: all, discount: true, trendWith: true }).score).toBe(10);
  });
});
