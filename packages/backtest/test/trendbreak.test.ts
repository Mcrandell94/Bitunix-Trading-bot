import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { atrWilder } from '../src/indicators';
import { specTrade } from '../src/screen/exits';
import { capped, coinTrendTrades, correlation, dailyReturns, dailySide, seriesStats, TREND_BREAK, trendSignals, trendSpec, type Pos } from '../src/screen/trendbreak';

const H4 = 4 * 3_600_000, DAY = 86_400_000, T0 = Date.UTC(2025, 0, 1);
const h4bar = (i: number, h: number, l: number, c: number, v = 1000, o = c): Candle => ({ openTime: T0 + i * H4, open: o, high: h, low: l, close: c, volume: v });
const dbar = (k: number, c: number): Candle => ({ openTime: T0 - 60 * DAY + k * DAY, open: c, high: c, low: c, close: c, volume: 1 });
/** Flat 4H bars: high 101, low 99, close 100. */
const flat = (n: number) => Array.from({ length: n }, (_, i) => h4bar(i, 101, 99, 100));
/** Daily bars from 60 days before T0, rising (so the close sits over its EMA 26 throughout). */
const risingDays = (n: number) => Array.from({ length: n }, (_, k) => dbar(k, 100 + k));
const ones = (n: number, v: 1 | -1 = 1) => new Int8Array(n).fill(v);

describe('Trend breakout (owner 2026-10-16)', () => {
  test('daily side: the last daily close known at the 4H close, against its EMA 26', () => {
    // 40 days at 100, day 40 closes 200 (over its EMA), day 41 closes 50 (under).
    const d1 = Array.from({ length: 42 }, (_, k) => ({ ...dbar(k, k === 40 ? 200 : k === 41 ? 50 : 100), openTime: T0 + k * DAY }));
    const h4 = Array.from({ length: 6 * 43 }, (_, i) => h4bar(i, 101, 99, 100));
    const side = dailySide(h4, d1);
    expect(side[6 * 40 - 1]).toBe(0); // day 39 closed at 100 = its EMA: neither side
    expect(side[6 * 40 + 5]).toBe(1); // the bar closing at day 40's close
    expect(side[6 * 41 + 2]).toBe(1); // during day 41: day 40's close is the last known
    expect(side[6 * 41 + 4]).toBe(1); // the bar closing at 20:00 on day 41: day 41 not closed yet
    expect(side[6 * 41 + 5]).toBe(-1); // the bar closing at day 41's close
    expect(dailySide(h4, d1.slice(0, 10))[0]).toBe(0); // EMA 26 not ready
  });

  test('signals: long needs coin and BTC over the EMA, a close over the 20-bar high and volume over 1.5x; short only the coin and the low', () => {
    const base = flat(30);
    const up = (v: number) => base.map((b, i) => (i === 25 ? h4bar(25, 104, 100, 103, v) : b));
    expect(trendSignals(up(1600), ones(30), ones(30))).toEqual([{ i: 25, d: 1 }]);
    expect(trendSignals(up(1500), ones(30), ones(30))).toEqual([]); // 1.5x exactly is not above
    expect(trendSignals(up(1600), ones(30), ones(30, -1))).toEqual([]); // BTC under its EMA
    expect(trendSignals(up(1600), ones(30, -1), ones(30))).toEqual([]); // coin under: no long, and 103 is no new low
    expect(trendSignals(base.map((b, i) => (i === 25 ? h4bar(25, 101, 101, 101, 5000) : b)), ones(30), ones(30))).toEqual([]); // 101 = the high, not over it
    const down = base.map((b, i) => (i === 25 ? h4bar(25, 100, 96, 97, 10) : b));
    expect(trendSignals(down, ones(30, -1), ones(30))).toEqual([{ i: 25, d: -1 }]); // no volume or BTC rule for shorts
    expect(trendSignals(down, ones(30, 1), ones(30))).toEqual([]);
    expect(trendSignals(up(1600).map((b, i) => (i === 10 ? { ...b, volume: null } : b)) as Candle[], ones(30), ones(30))).toEqual([]); // a missing volume fails the rule
  });

  test('a long: entry at the next open, first stop 4 ATR of the breakout bar under it, trailed under the highest close; one trade at a time', () => {
    // Flat, a breakout at bar 30, a climb to 130 by bar 60, a second breakout at bar 45 (while open), then a slide.
    const c: Candle[] = flat(30);
    c.push(h4bar(30, 106, 100, 105, 5000));
    for (let i = 31; i <= 60; i++) { const p = 105 + (i - 30); c.push(h4bar(i, p + 1, p - 1, p, i === 45 ? 9000 : 1000, p - 1)); }
    for (let i = 61; i <= 100; i++) { const p = 135 - 2 * (i - 60); c.push(h4bar(i, p + 1, p - 1, p, 1000, p + 1)); }
    const d1 = risingDays(90), trades = coinTrendTrades('AUSDT', c, d1, ones(c.length), 0, false);
    const atr = atrWilder(c, 14), entry = c[31]!.open, stop0 = entry - 4 * atr[30]!;
    const x = specTrade(c, atr, {}, 31, stop0, 1, trendSpec(1))!;
    expect(trades).toHaveLength(1); // the bar-45 breakout comes while the trade is open
    const t = trades[0]!;
    expect(t).toMatchObject({ sym: 'AUSDT', d: 1, entryT: c[31]!.openTime, entryPx: entry, how: 'stop', open: false, r: x.r });
    expect(t.risk).toBeCloseTo(4 * atr[30]!, 10);
    expect(t.exitPx).toBeCloseTo(x.stop, 8); // the exit price is the trailed stop
    expect(t.exitT).toBe(c[x.end]!.openTime + H4);
    expect(x.stop).toBeGreaterThan(130 - 4 * atr[60]! - 1e-9); // trailed from the highest close, 135 at bar 60
    expect(t.r).toBeGreaterThan(1);
  });

  test('a short trails 2 ATR over the lowest close; a trade still running after 60 days ends at the close', () => {
    const c: Candle[] = flat(30);
    c.push(h4bar(30, 100, 94, 95, 10));
    for (let i = 31; i < 420; i++) { const p = 95 * 0.999 ** (i - 30); c.push(h4bar(i, p * 1.001, p * 0.999, p, 10, p * 1.0005)); }
    const t = coinTrendTrades('BUSDT', c, risingDays(90).map((b, k) => ({ ...b, close: 200 - k })), ones(c.length), 0, false)[0]!;
    expect(t.d).toBe(-1);
    expect(t.how).toBe('time');
    expect(t.exitT - t.entryT).toBe(TREND_BREAK.capBars * H4); // 60 days
    expect(t.exitPx).toBeCloseTo(c[31 + TREND_BREAK.capBars - 1]!.close, 8);
    expect(t.risk).toBeCloseTo(2 * atrWilder(c, 14)[30]!, 10);
  });

  test('the book: at most 5 open, one per coin, a slot frees at the exit', () => {
    const p = (sym: string, entryT: number, exitT: number): Pos => ({ sym, d: 1, entryT, exitT, entryPx: 1, exitPx: 1, risk: 0.1, cost: 0 });
    const xs = [p('A', 0, 100), p('B', 0, 100), p('C', 1, 100), p('A', 2, 50), p('D', 3, 100), p('E', 4, 100), p('F', 5, 100), p('G', 100, 200)];
    expect(capped(xs, 5).map((x) => x.sym)).toEqual(['A', 'B', 'C', 'D', 'E', 'G']); // A again: held; F: 5 open; G: after the exits
  });

  test('daily marks add up to the trade: R x risk %, less the costs, on the exit day', () => {
    const closes = new Map([['A', new Map([[T0, 105], [T0 + DAY, 98], [T0 + 2 * DAY, 112]])]]);
    const pos: Pos = { sym: 'A', d: 1, entryT: T0 + 8 * 3_600_000, exitT: T0 + 2 * DAY + 12 * 3_600_000, entryPx: 100, exitPx: 110, risk: 5, cost: 0.0022 };
    const { days, ret } = dailyReturns([pos], 1, closes, T0 - DAY, T0 + 3 * DAY);
    expect(days).toHaveLength(5);
    expect(ret[1]).toBeCloseTo(0.01 * (105 - 100) / 5, 12);
    expect(ret[2]).toBeCloseTo(0.01 * (98 - 105) / 5, 12);
    expect(ret[3]).toBeCloseTo(0.01 * ((110 - 98) / 5 - (0.0022 * 100) / 5), 12); // the exit day ends at the exit price
    expect(ret.reduce((a, b) => a + b, 0)).toBeCloseTo(0.01 * (2 - 0.044), 12); // +2R less costs, at 1%
    const short = dailyReturns([{ ...pos, d: -1, exitPx: 95 }], 2, closes, T0, T0 + 3 * DAY).ret;
    expect(short.reduce((a, b) => a + b, 0)).toBeCloseTo(0.02 * (1 - 0.044), 12);
  });

  test('series stats and correlation', () => {
    const r = [0.01, -0.005, 0.02, 0, -0.01];
    const s = seriesStats(r), mean = 0.003, sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / 4);
    expect(s.sharpe).toBeCloseTo((mean / sd) * Math.sqrt(365), 10);
    expect(s.total).toBeCloseTo(1.5, 10);
    expect(s.maxDd).toBeCloseTo(1.0, 10); // from +2.5% down to +1.5%
    expect(correlation(r, r.map((x) => 2 * x))).toBeCloseTo(1, 12);
    expect(correlation(r, r.map((x) => -x))).toBeCloseTo(-1, 12);
  });

  test('no look-ahead: signals and trades from bars up to a cut equal the full run up to it', () => {
    let s = 9, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const c = Array.from({ length: 1500 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.48) * 0.03); return h4bar(i, Math.max(o, p) * (1 + 0.005 * rnd()), Math.min(o, p) * (1 - 0.005 * rnd()), p, 1000 * (0.5 + rnd() * (rnd() < 0.1 ? 4 : 1)), o); });
    const d1 = Array.from({ length: 250 }, (_, k) => { const day = c.slice(6 * k, 6 * k + 6); return { openTime: T0 + k * DAY, open: day[0]!.open, high: Math.max(...day.map((b) => b.high)), low: Math.min(...day.map((b) => b.low)), close: day.at(-1)!.close, volume: 1 }; });
    const cut = 1234, part = c.slice(0, cut + 1), closedD1 = d1.filter((b) => b.openTime + DAY <= part.at(-1)!.openTime + H4);
    const full = trendSignals(c, dailySide(c, d1), ones(c.length)), cutSigs = trendSignals(part, dailySide(part, closedD1), ones(part.length));
    expect(full.length).toBeGreaterThan(5);
    expect(cutSigs).toEqual(full.filter((x) => x.i <= cut));
    // Trades closed before the cut are the same.
    const a = coinTrendTrades('X', c, d1, ones(c.length), 0, false), b = coinTrendTrades('X', part, closedD1, ones(part.length), 0, false);
    const done = (xs: typeof a) => xs.filter((x) => !x.open && x.exitT <= part.at(-1)!.openTime + H4).map((x) => [x.entryT, x.r]);
    expect(done(b)).toEqual(done(a).slice(0, done(b).length));
    expect(done(b).length).toBeGreaterThan(2);
  });
});
