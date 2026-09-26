import { describe, expect, test } from 'vitest';
import { KLINE_MAX_LIMIT, PATHS, fetchCandles, fetchFunding, fetchTickers } from '../src/index';
import { candlesFrom, fakeExchange } from './fakeExchange';

const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H);
const closes = Array.from({ length: 700 }, (_, i) => 100 + Math.sin(i / 10) * 5);
const all = candlesFrom(closes, T0, H);

describe('fetchCandles', () => {
  test('pages a long range in windows of at most 200 bars, whatever the API does with caps, order and endTime', async () => {
    for (const capKeeps of ['earliest', 'latest'] as const) {
      for (const order of ['asc', 'desc'] as const) {
        for (const endTimeInclusive of [true, false]) {
          const ex = fakeExchange({ candles: { BTCUSDT: { '1h': all } }, capKeeps, order, endTimeInclusive });
          const got = await fetchCandles(ex, { symbol: 'BTCUSDT', interval: '1h', from: T0 + 50 * H, to: T0 + 650 * H });
          expect(got.map((c) => c.openTime), `${capKeeps}/${order}/${endTimeInclusive}`)
            .toEqual(Array.from({ length: 600 }, (_, i) => T0 + (50 + i) * H));
          for (const call of ex.calls) {
            const span = Number(call.params.endTime) - Number(call.params.startTime) + 1;
            expect(span).toBeLessThanOrEqual(KLINE_MAX_LIMIT * H);
            expect(call.params).toMatchObject({ symbol: 'BTCUSDT', interval: '1h', limit: 200, type: 'LAST_PRICE' });
          }
          expect(ex.calls).toHaveLength(3);
        }
      }
    }
  });

  test('a range before the listing just comes back short; MARK_PRICE passes through', async () => {
    const ex = fakeExchange({ candles: { NEWUSDT: { '1h': all.slice(690) } } });
    const got = await fetchCandles(ex, { symbol: 'NEWUSDT', interval: '1h', from: T0, to: T0 + 700 * H, type: 'MARK_PRICE' });
    expect(got).toHaveLength(10);
    expect(ex.calls[0]!.params.type).toBe('MARK_PRICE');
  });
});

describe('funding and tickers', () => {
  test('call the verified paths and parse', async () => {
    const ex = fakeExchange({
      candles: {},
      funding: [{ symbol: 'BTCUSDT', fundingRate: '0.01', fundingInterval: 8 }],
      tickers: [{ symbol: 'BTCUSDT', quoteVol: '1e9', lastPrice: '60000' }],
    });
    expect((await fetchFunding(ex)).items[0]).toMatchObject({ symbol: 'BTCUSDT', rate: 0.0001, intervalHours: 8 });
    expect(await fetchTickers(ex, ['BTCUSDT'])).toEqual([{ symbol: 'BTCUSDT', quoteVolume24h: 1e9, lastPrice: 60000 }]);
    expect(ex.calls.map((c) => c.path)).toEqual([PATHS.fundingRateBatch, PATHS.tickers]);
    expect(ex.calls[1]!.params).toEqual({ symbols: 'BTCUSDT' });
  });
});
