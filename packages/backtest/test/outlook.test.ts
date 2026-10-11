import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { OUTLOOK, outlookAgree, outlookAt, outlookSeries, pctRank, volSeries } from '../src/screen/outlook';

const H = 3_600_000, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
const MON = Date.UTC(2026, 0, 5); // a Monday

describe('Outlook (round 3)', () => {
  test('ETH/BTC ratio: same-day closes, 7-day change, side of its 20-day EMA; BTC ribbon / KAMA read at the last closed day', () => {
    const eth: Candle[] = [], btc: Candle[] = [];
    for (let k = 0; k < 60; k++) { const r = 0.04 * (1 + 0.002 * k); btc.push(bar(MON + k * DAY, 50000, 50500, 49500, 50000)); eth.push(bar(MON + k * DAY, 50000 * r, 50000 * r, 50000 * r, 50000 * r)); }
    const o = outlookSeries(eth, btc, []), t = MON + 60 * DAY, a = outlookAt(o, t);
    expect(a.btc!.ratio).toBeCloseTo(0.04 * (1 + 0.002 * 59), 12);
    expect(a.btc!.ratioChg7).toBeCloseTo(((1 + 0.002 * 59) / (1 + 0.002 * 52) - 1) * 100, 9);
    expect(a.btc!.ratioOverEma).toBe(true); // a rising ratio sits over its EMA
    // Mid-day: the day in progress is not used.
    expect(outlookAt(o, MON + 59 * DAY + 12 * H).btc!.ratio).toBeCloseTo(0.04 * (1 + 0.002 * 58), 12);
  });

  test('weekly RSI / 50-week EMA from closed weeks only', () => {
    const eth: Candle[] = [];
    for (let k = 0; k < 7 * 60; k++) { const p = 1000 + k; eth.push(bar(MON + k * DAY, p, p + 1, p - 1, p)); }
    const o = outlookSeries(eth, [], []);
    const thu = MON + (7 * 59 + 3) * DAY, a = outlookAt(o, thu); // Thursday of week 60: the last closed week is week 59 (index 58)
    expect(a.weekly!.weekOf).toBe(MON + 7 * 58 * DAY);
    expect(a.weekly!.rsi).toBe(100); // closes only rise
    expect(a.weekly!.ema).not.toBeNull();
    expect(outlookAt(o, MON + 7 * 59 * DAY).weekly!.weekOf).toBe(MON + 7 * 58 * DAY); // Monday 00:00: week 59 just closed
    expect(outlookAt(o, MON + 7 * 40 * DAY).weekly!.ema).toBeNull(); // under 50 weeks
  });

  test('bandwidth percentile, relative volume', () => {
    expect(pctRank([1, 2, 3, 4, 5], 4, 5)).toBe(100);
    expect(pctRank([5, 4, 3, 2, 1], 4, 5)).toBe(20);
    expect(pctRank([NaN, NaN, NaN, NaN, 1], 4, 5)).toBeNull(); // too few values
    const c: Candle[] = [];
    for (let k = 0; k < 30; k++) c.push(bar(k * H, 100, 101, 99, 100, k === 29 ? 3000 : 1000));
    const v = volSeries(c);
    expect(v.relVol[29]).toBeCloseTo(3, 9);
    expect(v.relVol[10]).toBeNaN();
    expect(v.width[29]).toBeCloseTo(0, 9); // flat closes: no band
  });

  test('funding: 7-day mean, direction (last 3 days vs the 4 before), 90-day median; settled prints only', () => {
    const t = MON + 100 * DAY, f: { time: number; rate: number }[] = [];
    for (let k = 1; k <= 90 * 3; k++) f.push({ time: t - k * 8 * H, rate: k <= 8 ? 0.0003 : k <= 20 ? 0.0001 : 0.0002 }); // last 3 days: k 1-8; the 4 before: k 9-20 (k 21 = exactly 7 days back, out)
    f.push({ time: t + 8 * H, rate: 0.01 }); // not settled yet at t
    const a = outlookAt(outlookSeries([], [], f), t).funding!;
    expect(a.recent).toBeCloseTo(0.0003, 12);
    expect(a.prior).toBeCloseTo(0.0001, 12);
    expect(a.avg7).toBeCloseTo((8 * 0.0003 + 12 * 0.0001) / 20, 12);
    expect(a.median90).toBeCloseTo(0.0002, 12);
  });

  test('agreement rules (fixed before the run): sides, squeeze, volume, funding vs its median; unavailable = null', () => {
    const at = { btc: { trend: 1, kamaOver: true, ratio: 0.04, ratioChg7: 1, ratioOverEma: true }, weekly: { weekOf: 0, rsi: 55, ema: 2000 }, funding: { avg7: 0.0001, recent: 0.0001, prior: 0.0001, median90: 0.0002 } };
    expect(outlookAgree(at, 1, 2100, 15, 1.6)).toEqual({ 'BTC ribbon': true, 'ETH/BTC': true, 'weekly RSI': true, 'weekly EMA': true, squeeze: true, 'relative volume': true, funding: true });
    expect(outlookAgree(at, -1, 2100, 50, 1.0)).toEqual({ 'BTC ribbon': false, 'ETH/BTC': false, 'weekly RSI': false, 'weekly EMA': false, squeeze: false, 'relative volume': false, funding: false });
    expect(outlookAgree({ btc: null, weekly: null, funding: null }, 1, 2100, null, NaN)).toEqual({ 'BTC ribbon': null, 'ETH/BTC': null, 'weekly RSI': null, 'weekly EMA': null, squeeze: null, 'relative volume': null, funding: null });
    expect(OUTLOOK.squeezePct).toBe(20);
  });
});
