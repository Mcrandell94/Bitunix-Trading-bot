import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { smcLux, type SmcZone } from '../src/screen/smclux';
import { htfCursor, htfOf, lastClosed, poisFor, topDownSetups, type Break, type Poi } from '../src/screen/smctopdown';

const H4 = 4 * 3_600_000, DAY = 86_400_000;
const bar = (t: number, o: number, h: number, l: number, c: number, len = H4): Candle => ({ openTime: t * len, open: o, high: h, low: l, close: c, volume: 1 });
const zone = (bias: 1 | -1, bottom: number, top: number, kind: SmcZone['kind'] = 'ob-internal'): SmcZone => ({ kind, bias, top, bottom, created: 0, removed: Infinity, from: 0 });
/** 4H bars from lows (longs) with highs 3 above, or from highs (shorts) with lows 3 below. */
const fromLows = (lows: number[]) => lows.map((l, t) => bar(t, l + 1, l + 3, l, l + 2));
const fromHighs = (highs: number[]) => highs.map((h, t) => bar(t, h - 1, h, h - 3, h - 2));
const atr2 = (n: number) => Array.from({ length: n }, () => 2);
const up = (t: number, kind: 'BOS' | 'CHoCH' = 'CHoCH'): Break => ({ t, dir: 1, kind, level: 0 });
const dn = (t: number, kind: 'BOS' | 'CHoCH' = 'CHoCH'): Break => ({ t, dir: -1, kind, level: 0 });

describe('SMC top-down: higher timeframe state without lookahead', () => {
  test('lastClosed: the last bar closed at or before T', () => {
    const d = Array.from({ length: 10 }, (_, i) => bar(i, 1, 1, 1, 1, DAY));
    expect(lastClosed(d, DAY, 5 * DAY)).toBe(4);
    expect(lastClosed(d, DAY, 5 * DAY + H4)).toBe(4);
    expect(lastClosed(d, DAY, 5 * DAY - 1)).toBe(3);
    expect(lastClosed(d, DAY, 0)).toBe(-1);
  });

  test('a daily zone is used only after the daily bar that created it has closed; weeks are complete weeks', () => {
    const flat = Array.from({ length: 40 }, (_, i) => bar(i, 100, 100.5, 99.5, 100, DAY));
    const d = [...flat, bar(40, 100, 104.5, 99.8, 104, DAY), bar(41, 104, 105, 101, 104, DAY), ...Array.from({ length: 20 }, (_, i) => bar(42 + i, 104, 106, 103, 105, DAY))];
    const h = htfOf(d), g = h.ds.zones.find((z) => z.kind === 'fvg')!;
    expect(g).toMatchObject({ bias: 1, created: 41 });
    const cur = htfCursor(h);
    expect(cur(41 * DAY + H4).daily).not.toContain(g); // day 41 still open
    expect(cur(42 * DAY).daily).toContain(g); // day 41 closed
    for (const w of h.w) expect((w.openTime / DAY - 4) % 7).toBe(0); // Mondays
    const at = cur(42 * DAY);
    expect(h.w[at.kw]!.openTime + 7 * DAY).toBeLessThanOrEqual(42 * DAY);
    expect(at.kw + 1 >= h.w.length || h.w[at.kw + 1]!.openTime + 7 * DAY > 42 * DAY).toBe(true);
  });
});

describe('SMC top-down: POI variants', () => {
  test('weekly / daily / either / nested, one side only', () => {
    const W = zone(1, 90, 100), A = zone(1, 95, 98), B = zone(1, 80, 85), S = zone(-1, 120, 130);
    const at = { weekly: [W, S], daily: [A, B] };
    const tfz = (ps: Poi[]) => ps.map((p) => [p.tf, p.z]);
    expect(tfz(poisFor('weekly', 1, at))).toEqual([['weekly', W]]);
    expect(tfz(poisFor('daily', 1, at))).toEqual([['daily', A], ['daily', B]]);
    expect(tfz(poisFor('either', 1, at))).toEqual([['weekly', W], ['daily', A], ['daily', B]]);
    expect(tfz(poisFor('nested', 1, at))).toEqual([['daily', A]]);
    expect(tfz(poisFor('weekly', -1, at))).toEqual([['weekly', S]]);
  });
});

describe('SMC top-down: arm, trigger, cancel, expire', () => {
  const P: Poi[] = [{ tf: 'daily', z: zone(1, 95, 100) }];

  test('touch, then a bullish internal break: entry next open, stop under the low since arming - 0.25 ATR', () => {
    const c = fromLows([105, 99, 97, 98, 101, 103]);
    const s = topDownSetups(c, atr2(c.length), [dn(2), up(3)], () => P, 1, 42);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ touch: 1, trig: 3, j: 4, stop: 97 - 0.5, kind: 'CHoCH' });
  });

  test('the touch bar itself can trigger; no break, no setup', () => {
    const c = fromLows([105, 99, 103, 104]);
    expect(topDownSetups(c, atr2(4), [up(1, 'BOS')], () => P, 1, 42)[0]).toMatchObject({ touch: 1, trig: 1, j: 2, stop: 98.5, kind: 'BOS' });
    expect(topDownSetups(c, atr2(4), [], () => P, 1, 42)).toHaveLength(0);
  });

  test('a low under the POI cancels; the next touch arms again', () => {
    const c = fromLows([105, 99, 94, 101, 99, 100, 102]);
    const s = topDownSetups(c, atr2(c.length), [up(3), up(5)], () => P, 1, 42);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ touch: 4, trig: 5, j: 6, stop: 99 - 0.5 });
  });

  test('the setup lapses `expire` bars after the last touch', () => {
    const c = fromLows([105, 99, 101, 102, 103, 104, 105, 106]);
    expect(topDownSetups(c, atr2(c.length), [up(6)], () => P, 1, 4)).toHaveLength(0); // 5 bars after the touch
    expect(topDownSetups(c, atr2(c.length), [up(5)], () => P, 1, 4)).toHaveLength(1); // 4 bars after
  });

  test('shorts mirror longs', () => {
    const Q: Poi[] = [{ tf: 'weekly', z: zone(-1, 100, 105) }];
    const c = fromHighs([95, 101, 103, 102, 99, 97]);
    const s = topDownSetups(c, atr2(c.length), [up(2), dn(3)], () => Q, -1, 42);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ touch: 1, trig: 3, j: 4, stop: 103 + 0.5 });
    expect(topDownSetups(fromHighs([95, 101, 106, 108, 107, 106]), atr2(6), [dn(3)], () => Q, -1, 42)).toHaveLength(0); // went through
  });
});

describe('LuxAlgo port: order block lists keep 100', () => {
  test('the oldest block leaves when the 101st comes in', () => {
    // A swing high first (so internal breaks can fire), then a rising staircase: each cycle breaks the last internal
    // high and leaves a bullish internal order block that is never mitigated.
    const c: Candle[] = [];
    let px = 100;
    const go = (to: number, bars: number) => { for (let i = 1; i <= bars; i++) { const o = px, x = px + (to - px) / (bars - i + 1); c.push({ openTime: c.length * H4, open: o, high: Math.max(o, x) + 0.2, low: Math.min(o, x) - 0.2, close: x, volume: 1 }); px = x; } };
    go(200, 20); go(100, 60);
    for (let k = 0; k < 115; k++) { go(px + 12, 6); go(px - 6, 6); }
    const s = smcLux(c), obs = s.zones.filter((z) => z.kind === 'ob-internal').sort((a, b) => a.created - b.created);
    expect(obs.length).toBeGreaterThan(100);
    const end = c.length;
    expect(obs.filter((z) => z.created < end && z.removed >= end).length).toBeLessThanOrEqual(100);
    expect(obs[0]!.removed).toBe(obs[100]!.created);
  });
});
