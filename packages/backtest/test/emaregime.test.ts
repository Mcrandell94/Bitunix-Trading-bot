import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { closeVs, cross, NOTES, REGIME, regimeRow, regimeTables, regimeText, shortPf } from '../src/screen/emaregime';

const DAY = 86_400_000, T0 = Date.UTC(2020, 0, 6);
const bar = (k: number, c: number): Candle => ({ openTime: T0 + k * DAY, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 });

describe('EMA regime books (owner notes, round 4)', () => {
  // 41 closes: +1% a day to bar 20, then -1% a day. The condition is unknown at bar 0, true to bar 19, false from 20.
  const closes = Array.from({ length: 41 }, (_, k) => (k <= 20 ? 100 * 1.01 ** k : 100 * 1.01 ** 20 * 0.99 ** (k - 20)));
  const c = closes.map((x, k) => bar(k, x)), cond = closes.map((_, k) => (k === 0 ? null : k < 20));
  // 39 steps (bar 1 -> 40); perYear = 39 makes CAGR the total growth - 1.
  const r = regimeRow('test', c, cond, 39), f = REGIME.costPerSide;

  test('a condition at close k sets the position for k -> k+1; one flip; starts where the condition is known', () => {
    expect(r.flips).toBe(1);
    expect(r.from).toBe(c[1]!.openTime);
    expect(r.ls.cagr!).toBeCloseTo(1.01 ** 39 - 1, 10); // long on the rise, short on the fall
    expect(r.lf.cagr!).toBeCloseTo(1.01 ** 19 - 1, 10); // flat on the fall
  });

  test('costs: 0.11% per side per unit of position change (entry 1 unit, long -> short 2, long -> flat 1)', () => {
    expect(r.lsCost.cagr!).toBeCloseTo((1.01 - f) * 1.01 ** 18 * (1.01 - 2 * f) * 1.01 ** 19 - 1, 10);
    expect(r.lfCost.cagr!).toBeCloseTo((1.01 - f) * 1.01 ** 18 * (1 - f) - 1, 10);
  });

  test('Sharpe = mean / sd (sample) x sqrt(perYear)', () => {
    const x = [...Array(19).fill(0.01), ...Array(20).fill(0)], m = x.reduce((p, y) => p + y, 0) / x.length;
    const sd = Math.sqrt(x.reduce((p, y) => p + (y - m) ** 2, 0) / (x.length - 1));
    expect(r.lf.sharpe!).toBeCloseTo((m / sd) * Math.sqrt(39), 8);
  });

  test('fewer than 30 steps -> no figures', () => {
    const s = regimeRow('short', c.slice(0, 20), cond.slice(0, 20), 365);
    expect(s.ls).toEqual({ sharpe: null, cagr: null });
  });
});

describe('short-rule profit factor', () => {
  test('entered at the signal close, closed at the first close back over EMA 26; an open trade is not counted', () => {
    const closes = [100, 94, 80, 86, 100, 94, 97, 93], e26 = [95, 95, 95, 85, 85, 95, 95, 95];
    const c = closes.map((x) => ({ close: x })), enter = (k: number) => k > 0 && closes[k]! < e26[k]! && closes[k - 1]! >= e26[k - 1]!;
    const s = shortPf(c, enter, e26), w = 1 - 86 / 94, l = 1 - 97 / 94;
    expect(s.trades).toBe(2);
    expect(s.pf!).toBeCloseTo(w / -l, 10);
    expect(s.pfCost!).toBeCloseTo((w - 2 * REGIME.costPerSide) / -(l - 2 * REGIME.costPerSide), 10);
    expect(s.avg!).toBeCloseTo(((w + l) / 2) * 100, 10);
  });
});

describe('tables and text', () => {
  const d1 = Array.from({ length: 700 }, (_, k) => bar(k, 100 + 30 * Math.sin(k / 25) + k * 0.05));
  const h4 = Array.from({ length: 600 }, (_, k) => ({ ...bar(0, 100 + 5 * Math.sin(k / 10)), openTime: T0 + k * 4 * 3_600_000 }));

  test('each coin gets the notes\' rows, our earlier findings and the short rules', () => {
    const e = regimeTables('ETHUSDT', d1, h4), b = regimeTables('BTCUSDT', d1, h4);
    expect(e.daily.map((x) => x.name)).toEqual(expect.arrayContaining(['buy and hold', 'close vs 26', '13 cross 21', '21 cross 50', 'earlier ema50_trend (held)']));
    expect(b.daily.map((x) => x.name)).toEqual(expect.arrayContaining(['close vs 144', '9 cross 89', '5 cross 8', 'earlier ema50_trend (held)']));
    expect(b.weekly.map((x) => x.name)).toEqual(expect.arrayContaining(['weekly close vs W5', 'weekly close vs W34', 'weekly 5 cross 21']));
    expect(e.h4.map((x) => x.name)).toEqual(['earlier 4H EMA 5 cross 20']);
    expect(e.shorts).toHaveLength(2);
    expect(b.shorts).toHaveLength(2);
  });

  test('every notes key names a row we print (no figure is left without its row)', () => {
    for (const coin of ['ETHUSDT', 'BTCUSDT'] as const) {
      const t = regimeTables(coin, d1, h4), names = new Set([...t.daily, ...t.weekly, ...t.h4].map((x) => x.name));
      for (const k of Object.keys(NOTES[coin])) if (k !== 'short') expect(names.has(k), `${coin} ${k}`).toBe(true);
      const text = regimeText(coin, t).join('\n');
      expect(text).toContain('notes:');
    }
  });

  test('a value at bar k uses closes up to k only (a cut run equals the full run up to the cut)', () => {
    const cut = d1.slice(0, 500);
    expect(closeVs(cut, 26)).toEqual(closeVs(d1, 26).slice(0, 500));
    expect(cross(cut, 9, 89)).toEqual(cross(d1, 9, 89).slice(0, 500));
    const a = regimeTables('BTCUSDT', cut, []).daily.find((x) => x.name === 'close vs 26')!, b = regimeRow('close vs 26', cut, closeVs(d1, 26).slice(0, 500), 365);
    expect(a).toEqual(b);
  });
});
