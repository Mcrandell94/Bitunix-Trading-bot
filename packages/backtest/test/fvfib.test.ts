import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { FV_FIB, fvFibReport, fvFibTrades } from '../src/screen/fundvol';
import type { FundingPoint } from '../src/types';

const H = 3_600_000, H4 = 4 * H, T0 = Date.UTC(2025, 0, 1);
type Ohlc = [number, number, number, number];
const bar = (t: number, [o, h, l, c]: Ohlc, v: number): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });

/**
 * 20 flat 4H candles at 100, a squeeze candle up 40% on 5x volume while shorts pay 0.1% a settlement, then the 1H path
 * `after` (4H candles built from it). `mirror` reflects every price around 200 and flips funding: the long case.
 */
function scenario(after: Ohlc[], mirror = false) {
  const m = ([o, h, l, c]: Ohlc): Ohlc => (mirror ? [200 - o, 200 - l, 200 - h, 200 - c] : [o, h, l, c]);
  const c4: Candle[] = Array.from({ length: 20 }, (_, i) => bar(T0 + i * H4, m([100, 100.5, 99.5, 100]), 1000));
  c4.push(bar(T0 + 20 * H4, m([100, 145, 99.5, 140]), 5000));
  const close4 = T0 + 21 * H4, h1 = after.map((x, k) => bar(close4 + k * H, m(x), 250));
  for (let k = 0; k + 4 <= h1.length; k += 4) {
    const g = h1.slice(k, k + 4);
    c4.push({ openTime: g[0]!.openTime, open: g[0]!.open, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)), close: g[3]!.close, volume: 1000 });
  }
  const fs: FundingPoint[] = Array.from({ length: 60 }, (_, k) => ({ time: T0 + k * 8 * H, rate: mirror ? 0.001 : -0.001 }));
  return { c4, h1, fs };
}
// New high 160, first drop to 120 (through the leg's 0.382 at 136.9: armed), a bounce, then the drop through the targets.
const up: Ohlc[] = [[140, 160, 139, 150], [150, 151, 120, 121], [121, 140, 119, 138], [138, 146, 137, 145], [145, 146, 100, 101], [101, 102, 100, 101], [101, 102, 100, 101], [101, 102, 100, 101]];
// The same, but the bounce waits until the 4H candle after the squeeze has closed (its gap, the FVG, is then known).
const up2: Ohlc[] = [[140, 160, 139, 150], [150, 151, 120, 121], [121, 125, 119, 122], [122, 124, 118, 123], [123, 140, 122, 138], [138, 146, 137, 145], [145, 146, 100, 101], [101, 102, 100, 101]];

describe('the Fibonacci plan (fifth round)', () => {
  test('first drop: the 0.382 edge of the drop\'s zone, 1R to the high, the 1.272 extension', () => {
    // Before candle 3 the drop's low is 119: the zone edge is 160 - 0.382 x 41 = 144.338; candle 3 trades to 146.
    const { trades } = fvFibTrades(...[scenario(up)].map((s) => [s.c4, s.h1, s.fs] as const)[0]!, 0, 'first drop', '1.272 extension');
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t).toMatchObject({ d: -1, how: 'target', entryAt: T0 + 21 * H4 + 3 * H });
    expect(t.entry).toBeCloseTo(144.338, 6);
    expect(t.risk).toBeCloseTo(15.662, 6);
    expect(t.target).toBeCloseTo(119 - 0.272 * 41, 9);
    expect(t.r).toBeCloseTo((144.338 - (119 - 0.272 * 41)) / 15.662 - (0.0022 * 144.338) / 15.662, 6);
  });

  test('whole leg: the leg\'s 0.382 edge (the leg starts at the low 99.5), filled on the first bounce', () => {
    const s = scenario(up);
    const t = fvFibTrades(s.c4, s.h1, s.fs, 0, 'whole leg', '1.272 extension').trades[0]!;
    expect(t.entry).toBeCloseTo(160 - 0.382 * 60.5, 9);
    expect(t.entryAt).toBe(T0 + 21 * H4 + 2 * H);
    expect(t.target).toBeCloseTo(120 - 0.272 * 40, 9); // the drop's low before the entry candle: 120
    expect(t.how).toBe('target');
    // The FVG is known only once the candle after the squeeze closes: an entry before that has no FVG target.
    expect(fvFibTrades(s.c4, s.h1, s.fs, 0, 'whole leg', 'FVG').trades).toEqual([]);
    const s2 = scenario(up2);
    for (const [tg, level] of [['golden pocket', 160 - 0.618 * 60.5], ['0.786', 160 - 0.786 * 60.5], ['FVG', 100.5]] as const) {
      const x = fvFibTrades(s2.c4, s2.h1, s2.fs, 0, 'whole leg', tg).trades[0]!;
      expect(x.target).toBeCloseTo(level, 9);
      expect(x).toMatchObject({ how: 'target', entryAt: T0 + 22 * H4 });
    }
  });

  test('a 4H close above the high stops it at that close; a wick above does not', () => {
    const s = scenario([...up.slice(0, 4), [145, 150, 144, 149], [149, 158, 148, 157], [157, 163, 156, 162], [162, 165, 161, 164]]);
    const t = fvFibTrades(s.c4, s.h1, s.fs, 0, 'first drop', '1.618 extension').trades[0]!;
    expect(t).toMatchObject({ how: 'stop', exit: 164, exitAt: T0 + 21 * H4 + 7 * H }); // candle 6's wick to 163 is not a close
    expect(t.r).toBeCloseTo(-(164 - 144.338) / 15.662 - (0.0022 * 144.338) / 15.662, 6);
  });

  test('no bounce into the zone within 7 days: no trade', () => {
    const flatAfter: Ohlc[] = Array.from({ length: 24 * FV_FIB.expiryDays + 8 }, () => [121, 122, 120, 121]);
    const s = scenario([...up.slice(0, 2), ...flatAfter]);
    expect(fvFibTrades(s.c4, s.h1, s.fs, 0, 'first drop', '1.272 extension')).toEqual({ trades: [], setups: 1 });
  });

  test('longs mirror shorts: the same levels reflected, the same R before costs', () => {
    const a = scenario(up2), b = scenario(up2, true);
    for (const rd of FV_FIB.readings) for (const tg of FV_FIB.targets) {
      const x = fvFibTrades(a.c4, a.h1, a.fs, 0, rd, tg).trades[0]!, y = fvFibTrades(b.c4, b.h1, b.fs, 0, rd, tg).trades[0]!;
      expect(y.d).toBe(1);
      expect(y.entry).toBeCloseTo(200 - x.entry, 9);
      expect(y.target).toBeCloseTo(200 - x.target, 9);
      expect(y.r + (0.0022 * y.entry) / y.risk).toBeCloseTo(x.r + (0.0022 * x.entry) / x.risk, 9);
    }
  });

  test('the report runs on a random walk and prints every line', () => {
    let seed = 7; // mulberry32
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const h1: Candle[] = [];
    let px = 100;
    for (let k = 0; k < 4 * 6 * 400; k++) {
      const spike = Math.floor(k / 4) % 23 === 5 || rnd() < 0.004, o = px;
      px = o * Math.exp((rnd() - 0.5) * (spike ? 0.12 : 0.02));
      h1.push(bar(T0 + k * H, [o, Math.max(o, px) * (1 + 0.004 * rnd()), Math.min(o, px) * (1 - 0.004 * rnd()), px], (spike ? 700 : 100) + 50 * rnd()));
    }
    const c4: Candle[] = [];
    for (let k = 0; k + 4 <= h1.length; k += 4) { const g = h1.slice(k, k + 4); c4.push({ openTime: g[0]!.openTime, open: g[0]!.open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), close: g[3]!.close, volume: g.reduce((p, x) => p + (x.volume ?? 0), 0) }); }
    const fs: FundingPoint[] = [];
    let rate = 0.0001;
    for (let t = T0; t < T0 + 400 * 24 * H; t += 8 * H) { if (rnd() < 0.15) rate = rnd() < 0.35 ? (rnd() < 0.5 ? 1 : -1) * (0.0006 + 0.001 * rnd()) : 0.0001; fs.push({ time: t, rate }); }
    const out = fvFibReport({ XUSDT: { candles: { '4h': c4, '1h': h1 }, funding: fs } }, ['XUSDT'], T0, T0 + 400 * 24 * H, T0 + 200 * 24 * H);
    const fib = out.filter((l) => l.startsWith('FIB ')).map((l) => JSON.parse(l.slice(4)) as { k: string; n: number });
    expect(fib).toHaveLength(1 + FV_FIB.readings.length * FV_FIB.targets.length);
    expect(fib.find((x) => x.k === 'current')!.n).toBeGreaterThan(5);
    expect(fib.some((x) => x.k !== 'current' && x.n > 0)).toBe(true);
  });
});
