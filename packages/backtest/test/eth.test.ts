import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import type { BinanceCandle } from '../src/binancevision';
import { ETH_LINES, ETH_PERIODS, ethDataCheck, ethScreenReport, ethTrades, failures, lineStats, type EthSeries, type EthTrade } from '../src/screen/eth';
import { fvConfluenceTrades } from '../src/screen/fundvol';
import type { Tf } from '../src/types';

const H = 3_600_000, DAY = 86_400_000;
/** A seeded random walk of 1h bars. */
function walk(n: number, seed = 7): Candle[] {
  let s = seed, px = 2000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const nx = px * (1 + ((s / 2 ** 31) - 0.5) * 0.02);
    out.push({ openTime: Date.UTC(2023, 0, 1) + i * H, open: px, high: Math.max(px, nx) * 1.001, low: Math.min(px, nx) * 0.999, close: nx, volume: 1 });
    px = nx;
  }
  return out;
}
const fund = (days: number, sign: (d: number) => number) => Array.from({ length: days * 3 }, (_, k) => ({ time: Date.UTC(2023, 0, 1) + k * 8 * H, rate: 0.0001 * sign(Math.floor(k / 3)) }));
const gaps = [{ name: 'ETHUSDT 1h', missing: 3, span: 1000 }];

describe('ETH data check', () => {
  test('the same prices and funding pass; a gap breaks the return pair but not the match', () => {
    const b = walk(500), x = b.map((c) => ({ ...c, close: c.close * 1.0003 })).filter((_, i) => i !== 100);
    const r = ethDataCheck(b, x, fund(20, () => 1), fund(20, () => 1), gaps);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toContain('499 matched 1h bars');
    expect(r.lines[0]).toContain('497 return pairs');
    expect(r.lines.at(-1)).toContain('stands in');
  });

  test('unrelated prices, a price offset, opposite funding or too many missing bars each fail', () => {
    const b = walk(500);
    expect(ethDataCheck(b, walk(500, 99), fund(20, () => 1), fund(20, () => 1), gaps).ok).toBe(false);
    const off = ethDataCheck(b, b.map((c) => ({ ...c, close: c.close * 1.005 })), fund(20, () => 1), fund(20, () => 1), gaps);
    expect(off.ok).toBe(false);
    expect(off.lines.find((l) => l.includes('median'))).toMatch(/^ {2}FAIL/);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, (d) => (d % 3 ? -1 : 1)), gaps).ok).toBe(false);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, () => 1), [{ name: 'BTCUSDT 15m', missing: 20, span: 1000 }]).ok).toBe(false);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, () => 1), [{ name: 'BTCUSDT 15m', missing: 0, span: 0 }]).ok).toBe(false); // nothing loaded
  });

  test('fixed periods: development before validation, the holdout after', () => {
    expect(ETH_PERIODS.dev.to).toBe(ETH_PERIODS.val.from);
    expect(ETH_PERIODS.val.to).toBe(ETH_PERIODS.holdoutFrom);
    expect((ETH_PERIODS.holdoutFrom - Date.UTC(2026, 3, 12)) / DAY).toBe(0);
  });
});

/** Correlated 15m random walks with trend regimes and impulse bars (as test/synthetic.ts), resampled in one pass. */
function series(days: number, seed: number, beta: number, own: number, start: number): EthSeries {
  let a = seed >>> 0, b = (seed * 7 + 3) >>> 0;
  const r1 = () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; };
  const r2 = () => { b = (b * 22695477 + 1) % 4294967296; return b / 4294967296; };
  const Q = 900_000, t0 = Date.UTC(2020, 0, 1), m15: BinanceCandle[] = [];
  let p = start;
  for (let i = 0; i < days * 96; i++) {
    const common = Math.sin(i / 300) * 0.0006 + (r1() < 0.02 ? (r1() < 0.5 ? -1 : 1) * 0.012 : 0) + (r1() - 0.5) * 0.006;
    const ret = beta * common + (r2() < 0.015 ? (r2() < 0.5 ? -1 : 1) * own * 3 : 0) + (r2() - 0.5) * own, o = p, c = o * (1 + ret), w = Math.abs(ret) * 0.5 + own * 0.3 * r2();
    p = c;
    m15.push({ openTime: t0 + i * Q, open: o, high: Math.max(o, c) * (1 + w * r2()), low: Math.min(o, c) * (1 - w * r2()), close: c, volume: 1000 * (1 + r2()) * (r2() < 0.006 ? 80 : 1), buy: 500 });
  }
  const up = (ms: number) => {
    const out: BinanceCandle[] = [];
    for (const x of m15) {
      const ot = Math.floor(x.openTime / ms) * ms, l = out[out.length - 1];
      if (l && l.openTime === ot) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume! += x.volume!; } else out.push({ ...x, openTime: ot });
    }
    return out;
  };
  const candles = { '15m': m15, '1h': up(3_600_000), '4h': up(14_400_000), '1d': up(DAY) } as Record<Tf, BinanceCandle[]>;
  // Funding regimes every 8h: long stretches of crowded longs or shorts, some beyond 0.05% per 8h.
  const funding = Array.from({ length: days * 3 }, (_, k) => ({ time: t0 + (k + 1) * 8 * H, rate: Math.sin(k / 40) * 0.0009 }));
  return { candles, funding };
}

describe('ETH screen', () => {
  const eth = series(420, 21, 1.1, 0.003, 3000), btc = series(420, 11, 1, 0.002, 60000), from = Date.UTC(2020, 2, 1);
  const { trades, tally } = ethTrades(eth, btc, from);

  test('every trade is a named line, entered from `from`, with costs and both baselines', () => {
    const ids = new Set(ETH_LINES.map((l) => l.id));
    expect(trades.length).toBeGreaterThan(50);
    for (const x of trades) {
      expect(ids.has(x.line)).toBe(true);
      expect(x.t).toBeGreaterThanOrEqual(from);
      expect(x.end).toBeGreaterThanOrEqual(x.t);
      expect(Number.isFinite(x.r) && Number.isFinite(x.f)).toBe(true);
      expect(x.rand.length).toBeGreaterThan(0);
    }
    expect(new Set(trades.map((x) => x.line.split(':')[0])).size).toBeGreaterThanOrEqual(10);
    expect(ethTrades(eth, btc, from).trades).toEqual(trades); // deterministic
  });

  test('the live-model trades re-simulate the live rows; the funding squeeze line is fvConfluenceTrades itself', () => {
    expect(tally.rows).toBeGreaterThan(0);
    expect(tally.same).toBe(tally.rows);
    const fv = fvConfluenceTrades(eth.candles['4h'], eth.candles['1h'], eth.funding, H, from).trades;
    const mine = trades.filter((x) => x.line.startsWith('fv4h:'));
    expect(mine.length).toBe(fv.length);
    expect(mine.map((x) => [x.t, x.d, +x.r.toFixed(6)])).toEqual(fv.map((x) => [eth.candles['1h'][x.j]!.openTime, x.d, +x.t.r.toFixed(6)]));
  });

  test('stats and the fixed rule', () => {
    const mk = (r: number, k: number, rt: number[] = [r - 0.1]): EthTrade => ({ line: 'x', d: 1, t: Date.UTC(2021, 0, 1) + k * DAY, end: 0, r, f: -0.01, rand: [0], rtime: rt });
    const xs = [...Array.from({ length: 27 }, (_, k) => mk(k % 3 ? -1 : 2.5, k)), mk(10, 30), mk(10, 31), mk(10, 32)];
    const s = lineStats(xs);
    expect(s.n).toBe(30);
    expect(s.rf).toBeCloseTo((9 * 2.5 - 18 + 30) / 30 - 0.01, 6);
    expect(s.noTop3).toBeCloseTo((9 * 2.5 - 18) / 27 - 0.01, 6);
    expect(s.edge).toBeCloseTo(s.r, 6);
    expect(s.timing).toBeCloseTo(0.1, 6);
    expect(failures(s, 'swing')).toEqual([]);
    expect(failures(s, 'intraday')).toEqual([]);
    expect(failures(lineStats(xs.slice(0, 27)), 'intraday')).toEqual(['27 trades < 30', '<= 0 without the best 3']);
    expect(failures(lineStats(xs.map((x) => ({ ...x, r: x.r - 2 }))), 'swing')).toContain('avg R with funding <= 0');
    expect(failures(lineStats(xs.map((x) => ({ ...x, rtime: [x.r + 1] }))), 'swing')).toEqual(['timing edge <= 0']);
  });

  test('the report lists every line in both periods and the qualifiers', () => {
    const text = ethScreenReport(trades, eth, btc, tally).join('\n');
    for (const l of ETH_LINES) expect(text).toContain(l.label);
    expect(text).toContain('QUALIFIERS:');
    expect(text.match(/^ {4}dev /gm)?.length).toBe(ETH_LINES.length);
  });
});
