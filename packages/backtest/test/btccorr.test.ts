import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { bandOf, btcCorrelation, btcCorrReport, btcCorrTable, closedWeeks, corrRow, noticeLines, parseBinanceKlines, rollingCorrelation, SCAN_NON_CRYPTO, windowChange, type CorrTf } from '../src/screen/btccorr';

const H = 3_600_000, DAY = 86_400_000, T0 = Date.UTC(2026, 8, 7); // a Monday
/** Hourly bars at the given closes. */
const bars = (closes: number[], step = H, t0 = T0): Candle[] => closes.map((c, k) => ({ openTime: t0 + k * step, open: c, high: c, low: c, close: c, volume: 1 }));
/** A seeded zig-zag path (the BTC side). */
const path = (n: number, seed = 3) => { let s = seed, px = 100; return Array.from({ length: n }, () => (px *= 1 + (((s = (s * 16807) % 2147483647) / 2147483647) - 0.5) * 0.04)); };

describe('BTC Correlation (the owner\'s script)', () => {
  test('Pearson r over the window: a hand value, ±1, missing values and a flat side', () => {
    expect(rollingCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5], 5).at(-1)).toBeCloseTo(0.8, 12);
    expect(rollingCorrelation([1, 2, 3, 4], [3, 5, 7, 9], 4).at(-1)).toBeCloseTo(1, 12);
    expect(rollingCorrelation([1, 2, 3, 4], [4, 3, 2, 1], 4).at(-1)).toBeCloseTo(-1, 12);
    expect(rollingCorrelation([null, 2, 3, 4, 5], [1, 2, 3, 5, 4], 4)).toEqual([null, null, null, null, expect.closeTo(0.8, 12)]);
    expect(rollingCorrelation([1, 2, 3], [5, 5, 5], 3).at(-1)).toBeNull();
  });

  test('on returns: the first reading needs `period` returns; a coin moving opposite to BTC reads −1', () => {
    const b = path(60), btc = bars(b), mirror = bars(b.map((_, i) => (i ? 100 * b.slice(1, i + 1).reduce((m, px, k) => m * (1 - (px / b[k]! - 1)), 1) : 100)));
    const r = btcCorrelation(mirror, btc, 50);
    expect(r.slice(0, 50).every((v) => v == null)).toBe(true);
    expect(r[50]).toBeCloseTo(-1, 9);
    expect(btcCorrelation(btc, btc, 50).at(-1)).toBeCloseTo(1, 12);
  });

  test('BTC is read at each coin bar: the same open time, else the last BTC close before it', () => {
    const b = path(30), btc = bars(b), holed = btc.filter((_, i) => i !== 10); // BTC misses bar 10
    const coin = bars(b.map((x) => x * 2));
    // With bar 10 missing, BTC's bar-10 close is bar 9's: its return there is 0 and bar 11's covers two bars.
    const at = (t: number) => [...holed].reverse().find((x) => x.openTime <= t)!.close;
    const expected = rollingCorrelation(
      coin.map((c, i) => (i ? (c.close - coin[i - 1]!.close) / coin[i - 1]!.close : null)),
      coin.map((c, i) => (i ? (at(c.openTime) - at(coin[i - 1]!.openTime)) / at(coin[i - 1]!.openTime) : null)), 20);
    expect(btcCorrelation(coin, holed, 20)).toEqual(expected);
    expect(expected.at(-1)).not.toBeCloseTo(1, 3);
    // A coin with a missing bar uses BTC at its own bars, so a coin that is BTC × 2 still reads 1.
    expect(btcCorrelation(coin.filter((_, i) => i !== 5), btc, 20).at(-1)).toBeCloseTo(1, 12);
  });

  test('weeks: Monday 00:00 UTC, closed only once the Sunday bar is in', () => {
    const d = bars(Array.from({ length: 16 }, (_, k) => 100 + k), DAY); // Monday 09-07 to Tuesday 09-22
    const w = closedWeeks(d);
    expect(w.map((x) => new Date(x.openTime).toISOString().slice(0, 10))).toEqual(['2026-09-07', '2026-09-14']);
    expect(w.map((x) => [x.open, x.close])).toEqual([[100, 106], [107, 113]]);
    expect(closedWeeks(d.slice(0, 14))).toHaveLength(2);
    expect(closedWeeks(d.slice(0, 13))).toHaveLength(1);
  });

  test('a row: the reading at the last bar, the lowest of the last days and the change over the window', () => {
    const b = path(120), btc = bars(b), coin = bars(b.map((x, i) => (i < 100 ? x : 2 * b[99]! - x)));
    const row = corrRow('XUSDT', 2e6, coin, btc, H, 10, 1)!;
    const r = btcCorrelation(coin, btc, 10);
    expect(row.now).toBe(r.at(-1));
    expect(row.at).toBe(coin.at(-1)!.openTime);
    const last24 = r.slice(-24) as number[];
    expect(row.low).toBe(Math.min(...last24));
    expect(row.lowAt).toBe(coin[coin.length - 24 + last24.indexOf(row.low!)]!.openTime);
    expect(row.chg).toBeCloseTo(coin.at(-1)!.close / coin.at(-11)!.close - 1, 12);
    expect(windowChange(btc, 10)).toBeCloseTo(b.at(-1)! / b.at(-11)! - 1, 12);
    expect(corrRow('NEWUSDT', 1, coin.slice(0, 10), btc, H, 10, 1)).toBeNull();
  });

  test('Binance klines: strings to numbers, quote volume, bad rows dropped', () => {
    expect(parseBinanceKlines([[T0, '1.5', '2', '1', '1.8', '10', T0 + H - 1, '18', 5], 'x', [T0 + H, 'a', '1', '1', 'nope']])).toEqual([
      { openTime: T0, open: 1.5, high: 2, low: 1, close: 1.8, volume: 18 },
    ]);
    expect(() => parseBinanceKlines({ code: 0 })).toThrow();
  });

  test('the report: the script\'s bands, the coins at −0.7 or lower, the lowest and the last 14 days', () => {
    expect([0.7, 0.69, 0, -0.01, -0.4, -0.41, -0.7, -0.71].map(bandOf)).toEqual([0, 1, 2, 3, 3, 4, 4, 5]);
    const row = (symbol: string, now: number | null, low: number | null) => ({ symbol, vol24h: 1.25e6, now, at: T0, chg: -0.05, low, lowAt: T0 - 4 * H });
    const tf: CorrTf = { tf: '4H', barMs: 4 * H, btcChg: 0.031, tooNew: 2, stale: 1, rows: [row('AUSDT', -0.74, -0.8), row('BUSDT', -0.2, -0.72), row('CUSDT', 0.9, 0.5), row('DUSDT', null, null)] };
    const text = btcCorrReport({ now: T0, period: 50, days: 14, minVol: 1e5, btcSource: 'Binance BTCUSDT spot', scanned: 4, thin: 9, failed: [], tfs: [tf, { ...tf, tf: '1W', rows: [row('CUSDT', 0.9, 0.5)] }] }).join('\n');
    expect(text).toContain('4H (BTC +3.1% over the window)');
    expect(text).toMatch(/4H \(BTC \+3\.1% over the window\)\s+1\s+0\s+0\s+1\s+0\s+1/);
    expect(text).toContain('4H  A −0.74 (−5.0%, $1.3M)');
    expect(text).toContain('1W  none');
    expect(text).toContain('4H  A −0.74 · B −0.20 · C 0.90');
    expect(text).toContain('4H  B low −0.72 (bar of 09-06 20:00), now −0.20, $1.3M');
    expect(text).toContain('4 Bitunix USDT perps with $0.1M+ 24h volume');
    expect(text).toContain('9 thinner coins left out');
    expect(text).not.toContain('left out by hand');
    const withExcl = btcCorrReport({ now: T0, period: 50, days: 14, minVol: 1e5, btcSource: 'x', scanned: 1, thin: 0, failed: [], excluded: ['PEP', 'KO'], tfs: [tf] }).join('\n');
    expect(withExcl).toContain("Also left out by hand (stock / ETF tokens not on the bot's list yet): PEP, KO.");
  });

  test('crypto only: the scan\'s own stock / ETF list, and its report as Actions notices', () => {
    for (const s of ['PEP', 'UVXY', 'ANTHROPIC', 'TENCENT']) expect(SCAN_NON_CRYPTO.has(s)).toBe(true);
    for (const s of ['BTC', 'ETH', 'BR', 'TRUTH', 'HANA', 'DIA', 'ON', 'XAU', 'XAUT', 'PAXG']) expect(SCAN_NON_CRYPTO.has(s)).toBe(false);
    const n = noticeLines(['a 50%', 'b', 'c'.repeat(10)], 'T', 8);
    expect(n).toEqual(['::notice title=T (1/2)::a 50%25%0Ab', '::notice title=T (2/2)::cccccccccc']);
  });

  test('the full listing: every coin once, the lowest 4H first, – where a timeframe has no reading', () => {
    const row = (symbol: string, now: number) => ({ symbol, vol24h: 1, now, at: T0, chg: null, low: now, lowAt: T0 });
    const t = (tf: string, rows: ReturnType<typeof row>[]): CorrTf => ({ tf, barMs: H, btcChg: null, tooNew: 0, stale: 0, rows });
    expect(btcCorrTable([t('1H', [row('AUSDT', 0.5), row('BUSDT', -0.1)]), t('4H', [row('BUSDT', 0.2), row('AUSDT', -0.3)]), t('1W', [row('AUSDT', 0.9)])])).toEqual([
      'All coins, the lowest 4H first (1H / 4H / 1W):',
      '  A                0.50  −0.30   0.90',
      '  B               −0.10   0.20      –',
    ]);
  });
});
