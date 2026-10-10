import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { atrWilder } from '../src/indicators';
import { FV_GRID, FV_LIVE, fvConfluenceTrades, fvGridReport, fvLiveSignals } from '../src/screen/fundvol';
import type { FundingPoint } from '../src/types';

const H = 3_600_000, H4 = 4 * H, T0 = Date.UTC(2025, 0, 1);
const bar = (t: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
/** 4H candles from 1H ones (4 per 4H, aligned to T0). */
const to4h = (h1: ReadonlyArray<Candle>) => {
  const out: Candle[] = [];
  for (let k = 0; k + 4 <= h1.length; k += 4) {
    const g = h1.slice(k, k + 4);
    out.push(bar(g[0]!.openTime, g[0]!.open, Math.max(...g.map((b) => b.high)), Math.min(...g.map((b) => b.low)), g[3]!.close, g.reduce((a, b) => a + (b.volume ?? 0), 0)));
  }
  return out;
};

describe('fvLiveSignals', () => {
  test('the open and closed rows are the backtest trades (fvConfluenceTrades) one for one', () => {
    let seed = 7; // mulberry32
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const h1: Candle[] = [];
    let px = 100;
    for (let k = 0; k < 4 * 6 * 400; k++) { // 400 days
      const spike = Math.floor(k / 4) % 23 === 5 || rnd() < 0.004;
      const o = px;
      px = o * Math.exp((rnd() - 0.5) * (spike ? 0.12 : 0.02));
      h1.push(bar(T0 + k * H, o, Math.max(o, px) * (1 + 0.004 * rnd()), Math.min(o, px) * (1 - 0.004 * rnd()), px, (spike ? 700 : 100) + 50 * rnd()));
    }
    const fs: FundingPoint[] = [];
    let rate = 0.0001;
    for (let t = T0; t < T0 + 400 * 24 * H; t += 8 * H) {
      if (rnd() < 0.15) rate = rnd() < 0.35 ? (rnd() < 0.5 ? 1 : -1) * (0.0006 + 0.001 * rnd()) : 0.0001;
      fs.push({ time: t, rate });
    }
    const c4 = to4h(h1), now = h1[h1.length - 1]!.openTime + H;
    const { trades } = fvConfluenceTrades(c4, h1, fs, H, 0);
    const rows = fvLiveSignals('XUSDT', c4, h1, fs, now, 1e6).filter((r) => r.status === 'open' || r.status === 'closed');
    expect(trades.length).toBeGreaterThanOrEqual(10);
    expect(rows.map((r) => [r.enteredAt, r.side, r.entry, r.r, r.exit])).toEqual(trades.map((t) => [h1[t.j]!.openTime, t.d > 0 ? 'long' : 'short', h1[t.j]!.open, Number(t.t.r.toFixed(2)), t.t.open ? null : t.t.how]));
    expect(new Set(rows.map((r) => r.side)).size).toBe(2); // longs and shorts
  });

  test('the fourth round grid: every cell printed; the 3x / 0.05% cell is the live line; requirements filter', () => {
    let seed = 7; // mulberry32, the same walk as above
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const h1: Candle[] = [];
    let px = 100;
    for (let k = 0; k < 4 * 6 * 400; k++) {
      const spike = Math.floor(k / 4) % 23 === 5 || rnd() < 0.004;
      const o = px;
      px = o * Math.exp((rnd() - 0.5) * (spike ? 0.12 : 0.02));
      h1.push(bar(T0 + k * H, o, Math.max(o, px) * (1 + 0.004 * rnd()), Math.min(o, px) * (1 - 0.004 * rnd()), px, (spike ? 700 : 100) + 50 * rnd()));
    }
    const fs: FundingPoint[] = [];
    let rate = 0.0001;
    for (let t = T0; t < T0 + 400 * 24 * H; t += 8 * H) {
      if (rnd() < 0.15) rate = rnd() < 0.35 ? (rnd() < 0.5 ? 1 : -1) * (0.0006 + 0.001 * rnd()) : 0.0001;
      fs.push({ time: t, rate });
    }
    const c4 = to4h(h1);
    const base = fvConfluenceTrades(c4, h1, fs, H, 0).trades;
    expect(fvConfluenceTrades(c4, h1, fs, H, 0, { rate: 0.0005, vol: 3, minBody: 0 }).trades).toEqual(base);
    expect(fvConfluenceTrades(c4, h1, fs, H, 0, { minBody: 50 }).trades).toEqual([]);
    expect(fvConfluenceTrades(c4, h1, fs, H, 0, { vol: 2 }).trades.length).toBeGreaterThanOrEqual(base.length - 2); // looser: about as many or more
    const out = fvGridReport({ XUSDT: { candles: { '4h': c4, '1h': h1 }, funding: fs } }, ['XUSDT'], T0, T0 + 400 * 24 * H, T0 + 200 * 24 * H);
    const cells = out.filter((l) => l.startsWith('CELL ')).map((l) => JSON.parse(l.slice(5)) as { vol: number; rate: number; body: number; n: number });
    expect(cells).toHaveLength(FV_GRID.vols.length * FV_GRID.rates.length + FV_GRID.bodies.length - 1);
    expect(cells.find((c) => c.vol === 3 && c.rate === 0.0005 && c.body === 0)!.n).toBe(base.length);
    // Each cell is the line under its own requirements, the body floor included.
    for (const c of cells) expect(c.n).toBe(fvConfluenceTrades(c4, h1, fs, H, T0, { rate: c.rate, vol: c.vol, minBody: c.body }).trades.length);
    const bodyN = cells.filter((c) => c.vol === 3 && c.rate === 0.0005).map((c) => c.n);
    expect(bodyN[bodyN.length - 1]).toBeLessThan(bodyN[0]!); // the 2 ATR floor removes some trades here
    for (const s of ['Avg R with funding (trades):', 'Candle size at 3x / 0.05%']) expect(out.some((l) => l.startsWith(s))).toBe(true);
  });

  // 40 flat 4H candles, then a squeeze: shorts crowded (funding -0.1% a settlement) and the 41st candle up 10% on 5x volume.
  const flat4 = Array.from({ length: 40 }, (_, i) => bar(T0 + i * H4, 100, 100.5, 99.5, 100, 1000));
  const c4 = [...flat4, bar(T0 + 40 * H4, 100, 110.5, 99.5, 110, 5000)];
  const close = T0 + 41 * H4, fs = Array.from({ length: 50 }, (_, k) => ({ time: T0 + k * 8 * H, rate: -0.001 }));
  const h1Before = Array.from({ length: 41 * 4 }, (_, k) => bar(T0 + k * H, 100, 100.5, 99.5, 100, 250));
  const risk = 2 * atrWilder(c4, 14)[40]!;
  const after = (...xs: [number, number][]) => [...h1Before, ...xs.map(([o, c], k) => bar(close + k * H, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, c, 250))];

  test('waiting for a 1H candle closing the crowd\'s way, then enter at the next 1H open, then the trade', () => {
    const w = fvLiveSignals('XUSDT', c4, h1Before, fs, close);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ status: 'waiting', side: 'short', crowd: 'short', signalAt: close, until: close + 4 * H, rvol: 5 });
    expect(w[0]!.rate8).toBeCloseTo(-0.001, 10);
    expect(w[0]!.move).toBeCloseTo(0.1, 10);
    // An up candle does not confirm a short: still waiting.
    expect(fvLiveSignals('XUSDT', c4, after([110, 111]), fs, close + H)[0]!.status).toBe('waiting');
    // A down candle confirms: enter at the next open (estimate: its close), stop 2 ATR(4H) above, 2R target.
    const e = fvLiveSignals('XUSDT', c4, after([110, 111], [111, 109]), fs, close + 2 * H)[0]!;
    expect(e).toMatchObject({ status: 'enter', entry: 109, confirmedAt: close + 2 * H, enteredAt: null });
    expect(e.stop).toBeCloseTo(109 + risk, 10);
    expect(e.target).toBeCloseTo(109 - 2 * risk, 10);
    // The next candle opens the trade at its open.
    const o = fvLiveSignals('XUSDT', c4, after([110, 111], [111, 109], [108.8, 108]), fs, close + 3 * H)[0]!;
    expect(o).toMatchObject({ status: 'open', entry: 108.8, enteredAt: close + 2 * H, exit: null, closedAt: null });
    expect(o.stop).toBeCloseTo(108.8 + risk, 10);
    expect(o.r).toBeCloseTo((108.8 - 108) / risk - (0.0022 * 108.8) / risk, 2);
    expect(o.fundingR).toBe(0); // no settlement since the entry
  });

  test('no confirmation in the 4 candles: no trade; a target hit closes it', () => {
    expect(fvLiveSignals('XUSDT', c4, after([110, 111], [111, 112], [112, 113], [113, 114]), fs, close + 4 * H)).toEqual([]);
    const won = fvLiveSignals('XUSDT', c4, after([110, 109], [109, 109.5], [109.5, 100]), fs, close + 3 * H)[0]!;
    expect(won).toMatchObject({ status: 'closed', exit: 'target', closedAt: close + 3 * H });
    expect(won.r).toBeCloseTo(2 - (0.0022 * 109) / risk, 2);
  });

  test('a squeeze candle is judged only once funding was read 10 minutes after its close', () => {
    expect(fvLiveSignals('XUSDT', c4, h1Before, fs, close, 14, close + FV_LIVE.settleMs - 1)).toEqual([]);
    expect(fvLiveSignals('XUSDT', c4, h1Before, fs, close, 14, close + FV_LIVE.settleMs)).toHaveLength(1);
  });

  test('funding paid while open, in R; closed trades older than keepDays are dropped', () => {
    // Entered at close + H; settlements every 8h from T0, so one falls at close + 8h (41 x 4h = 164h, 168h is a settlement).
    const h1 = after([110, 109], ...Array.from({ length: 10 }, (): [number, number] => [109, 109]));
    const o = fvLiveSignals('XUSDT', c4, h1, fs, close + 11 * H)[0]!;
    expect(o.status).toBe('open');
    expect(o.fundingR).toBeCloseTo(Number(((-0.001 * 109) / risk).toFixed(2)), 10); // shorts pay when funding is negative
    const won = after([110, 109], [109, 100]);
    expect(fvLiveSignals('XUSDT', c4, won, fs, close + 2 * H + 15 * 86_400_000, 14)).toEqual([]);
    expect(fvLiveSignals('XUSDT', c4, won, fs, close + 2 * H + 13 * 86_400_000, 14)).toHaveLength(1);
  });
});
