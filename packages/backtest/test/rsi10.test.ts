import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { ZONE_ADDONS, dailyDivOk, entryOk, phaseDivs, stopFor, touches, turnedUp, windowOk, windowStarts, type Coin } from '../src/screen/rsi10';

const M15 = 15 * 60_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
const bars = (n: number, bar: number, t0: number, low: (k: number) => number = () => 100): Candle[] =>
  Array.from({ length: n }, (_, k) => ({ openTime: t0 + k * bar, open: 101, high: 102, low: low(k), close: 101, volume: 1 }));
const T0 = 60 * DAY; // window start used below

/** A coin over 120 days with chosen RSI paths. */
function coin(o: { r4?: (t: number) => number; r1?: (t: number) => number; r15?: (t: number) => number; rd?: (t: number) => number; low15?: (t: number) => number; lowD?: (t: number) => number } = {}): Coin {
  const mk = (bar: number, n: number, rf: (t: number) => number, lowf?: (t: number) => number) => {
    const c = bars(n, bar, 0, lowf ? (k) => lowf(k * bar) : undefined);
    return { c, r: c.map((b) => rf(b.openTime + bar)), bar };
  };
  const h1 = mk(H, 120 * 24, o.r1 ?? (() => 36));
  return {
    sym: 'X', m15: mk(M15, 120 * 96, o.r15 ?? (() => 40), o.low15), h1: { ...h1, atr: h1.c.map(() => 1) },
    h4: mk(H4, 120 * 6, o.r4 ?? (() => 34)), d1: mk(DAY, 120, o.rd ?? (() => 45), o.lowD),
  };
}

describe('15M-RSI10', () => {
  test('window starts: first 4H dip to 30 or below, none in the 3 days before', () => {
    const dips = new Set([T0, T0 + 2 * DAY, T0 + 8 * DAY]);
    const c = coin({ r4: (t) => (dips.has(t) ? 29 : 40) });
    expect(windowStarts(c)).toEqual([T0, T0 + 8 * DAY]); // the day-2 dip belongs to the first window
  });

  test('entry ranges: 4H 31-37, 1H 33-39, 15m 35-50, daily above 37', () => {
    expect(entryOk(coin(), T0)).toBe(true);
    expect(entryOk(coin({ r4: () => 38 }), T0)).toBe(false);
    expect(entryOk(coin({ r1: () => 32 }), T0)).toBe(false);
    expect(entryOk(coin({ r15: () => 51 }), T0)).toBe(false);
    expect(entryOk(coin({ rd: () => 37 }), T0)).toBe(false);
  });

  test('core window: lower lows in phases 2 and 3; a 4H close under 30 after day 3 cancels', () => {
    const steps = (t: number) => (t < T0 - H4 ? 100 : t < T0 + 2 * DAY ? 90 : t < T0 + 5 * DAY ? 85 : t < T0 + 6 * DAY ? 80 : 95);
    const flush = (t: number) => (t <= T0 + 2 * DAY ? 29 : t === T0 + 6 * DAY ? 32 : 34); // phase-3 low 32 on day 6, then back to 34
    const t = T0 + 7 * DAY;
    expect(windowOk(coin({ r4: flush, low15: steps }), T0, t, 'core')).toBe(true);
    expect(windowOk(coin({ r4: (x) => (x === T0 + 4 * DAY ? 29 : flush(x)), low15: steps }), T0, t, 'core')).toBe(false); // day 4 close under 30
    expect(windowOk(coin({ r4: (x) => (x === T0 + 3 * DAY ? 29 : flush(x)), low15: steps }), T0, t, 'core')).toBe(true); // day 3: inside the buffer
    expect(windowOk(coin({ r4: flush, low15: (x) => (x >= T0 + 5 * DAY && x < T0 + 6 * DAY ? 88 : steps(x)) }), T0, t, 'core')).toBe(false); // no lower low in phase 3
    expect(windowOk(coin({ r4: flush, low15: steps }), T0, T0 + 4 * DAY, 'core')).toBe(false); // too early
    expect(windowOk(coin({ r4: () => 31, low15: steps }), T0, t, 'core')).toBe(false); // no flush
  });

  test('daily divergence month over month: lower low, higher daily RSI', () => {
    const lowD = (t: number) => (t === T0 - 20 * DAY ? 90 : 100);
    const rd = (t: number) => (t === T0 - 19 * DAY ? 30 : 45); // RSI of the day that closes at T0-19d (the prior low's day)
    const c = coin({ lowD, rd });
    expect(dailyDivOk(c, T0, T0 + 7 * DAY, { px: 85, t: T0 + 5 * DAY })).toBe(true);
    expect(dailyDivOk(c, T0, T0 + 7 * DAY, { px: 95, t: T0 + 5 * DAY })).toBe(false); // not a lower low
    expect(dailyDivOk(coin({ lowD, rd: (t) => (t === T0 - 19 * DAY ? 50 : 45) }), T0, T0 + 7 * DAY, { px: 85, t: T0 + 5 * DAY })).toBe(false); // RSI not higher
  });

  test('phase 1 -> phase 3 divergence: the lowest RSI in phase 3 above phase 1\'s', () => {
    const r = (t: number) => (t <= T0 + 2 * DAY ? 22 : t >= T0 + 5 * DAY ? 28 : 40);
    expect(phaseDivs(coin({ r1: r, r4: r, r15: r }), T0, T0 + 7 * DAY)).toMatchObject({ 'RSI 4H': true, 'RSI 1H': true, 'RSI 15m': true });
    expect(phaseDivs(coin({ r1: (t) => (t >= T0 + 5 * DAY ? 20 : r(t)) }), T0, T0 + 7 * DAY)['RSI 1H']).toBe(false);
  });

  test('stops: window low minus ATR, or a fixed % under the entry', () => {
    const s = { sym: 'X', t0: 0, t: 0, j: 0, low: 90, atr1h: 2, atr4h: 4 };
    expect(stopFor(s, 100, 'low-1h')).toBe(89.5);
    expect(stopFor(s, 100, 'low-4h')).toBe(86);
    expect(stopFor(s, 100, 'pct4')).toBe(96);
  });

  test('turned up: phase-3 low in range, not the last bar, last bar 2 points above it', () => {
    const at = (vals: Record<number, number>) => coin({ r4: (t) => vals[(t - T0) / H4] ?? 40 });
    expect(turnedUp(at({ 31: 32, 32: 35 }).h4, T0, T0 + 32 * H4, 30, 35)).toBe(true); // low 32 at bar 31, 35 now
    expect(turnedUp(at({ 31: 36, 32: 34 }).h4, T0, T0 + 32 * H4, 30, 35)).toBe(false); // still falling: the low is the last bar
    expect(turnedUp(at({ 31: 32, 32: 33 }).h4, T0, T0 + 32 * H4, 30, 35)).toBe(false); // only 1 point up
    expect(turnedUp(at({ 31: 28, 32: 34 }).h4, T0, T0 + 32 * H4, 30, 35)).toBe(false); // low under 30
  });

  test('zone touch: the zone overlaps the range from the 24h low up to the entry', () => {
    const z = { top: 100, bottom: 95 };
    expect(touches(z, 90, 96)).toBe(true); // entry inside the zone
    expect(touches(z, 90, 99)).toBe(true); // range crosses the whole zone
    expect(touches(z, 101, 105)).toBe(false); // zone below the range
    expect(touches(z, 80, 94)).toBe(false); // zone above the range
  });

  test('zone add-ons: confluence needs two different 4H / 1D zones; 1H order blocks do not count towards the 4H / 1D rule', () => {
    const by = (name: string) => ZONE_ADDONS.find((a) => a.name.startsWith(name))!.ok;
    expect(by('confluence: 2+')(['S/R deep 4H', 'demand 1D'])).toBe(true);
    expect(by('confluence: 2+')(['S/R deep 4H', 'order block 1H'])).toBe(false);
    expect(by('confluence: 3+')(['S/R deep 4H', 'order block 1H', 'demand 4H'])).toBe(true);
    expect(by('any 4H')(['S/R any 1D'])).toBe(false); // "any strength" channels alone are not a zone
    expect(by('order block 1H')(['order block 1H'])).toBe(true);
  });
});
