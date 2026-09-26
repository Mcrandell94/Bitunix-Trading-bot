// The probe itself, against fake APIs that do and don't match the assumptions.
import { describe, expect, test } from 'vitest';
import { formatReport, runProbe } from '../src/probe';
import { candlesFrom, fakeExchange } from './fakeExchange';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.UTC(2026, 8, 26, 16, 30);

function exchange(over: { funding?: unknown[]; offGridHours?: number } = {}) {
  const grid = (ms: number, n: number) => {
    const last = Math.floor(NOW / ms) * ms;
    return candlesFrom(Array.from({ length: n }, (_, i) => 60000 + i), last - (n - 1) * ms + (over.offGridHours ?? 0) * H, ms, Array(n).fill(1e6));
  };
  return fakeExchange({
    candles: { BTCUSDT: { '1h': grid(H, 400), '4h': grid(4 * H, 60), '1d': grid(DAY, 60) } },
    funding: over.funding ?? [
      { symbol: 'BTCUSDT', fundingRate: '0.01', fundingInterval: 8, nextFundingTime: String(NOW + 2 * H), markPrice: '60000' },
      { symbol: 'ETHUSDT', fundingRate: '-0.005', fundingInterval: 8, nextFundingTime: String(NOW + 2 * H), markPrice: '3000' },
    ],
    tickers: [{ symbol: 'BTCUSDT', quoteVol: '1', lastPrice: '1' }],
    tradingPairs: [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: '0.0001', basePrecision: 4, quotePrecision: 1, maxLeverage: 125 }],
  });
}

describe('runProbe', () => {
  test('an API matching every assumption passes', async () => {
    const results = await runProbe(exchange(), NOW);
    expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
    expect(results.find((r) => r.check === 'kline 1h: includes the still-open bar')!.detail).toMatch(/^yes/);
    expect(formatReport(results)).toContain('PASS  kline 1d: time is an open time on the UTC grid');
  });

  test('fraction-style funding and off-grid bar times fail', async () => {
    const results = await runProbe(exchange({
      offGridHours: 1,
      funding: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingInterval: 8, nextFundingTime: String(NOW + H) }],
    }), NOW);
    const failed = results.filter((r) => r.status === 'FAIL').map((r) => r.check);
    expect(failed).toContain('funding: fundingRate is a percent');
    expect(failed).toContain('kline 4h: time is an open time on the UTC grid');
    expect(failed).toContain('kline 1d: time is an open time on the UTC grid');
    expect(failed).not.toContain('kline 1h: time is an open time on the UTC grid');
  });

  test('a failing endpoint is reported, not thrown', async () => {
    const ex = fakeExchange({ candles: {}, failing: ['/api/v1/futures/market/trading_pairs'] });
    const results = await runProbe(ex, NOW);
    expect(results.find((r) => r.check === 'trading pairs')).toMatchObject({ status: 'FAIL' });
  });
});
