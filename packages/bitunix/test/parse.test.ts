import { describe, expect, test } from 'vitest';
import { ParseError, num, parseFundingBatch, parseKlines, parseTickers, parseTradingPairs } from '../src/index';

describe('num', () => {
  test('numbers and numeric strings; everything else is null', () => {
    expect(num(1.5)).toBe(1.5);
    expect(num('60000.1')).toBe(60000.1);
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(null)).toBeNull();
  });
});

describe('parseKlines', () => {
  const H = 3_600_000;
  test('the documented example shape, numbers or strings, sorted and de-duplicated', () => {
    const rows = [
      { open: '101', high: '103', low: '100', close: '102', time: 2 * H, quoteVol: '5000', baseVol: '49', type: 'LAST_PRICE' },
      { open: 100, high: 101, close: 100.5, low: 99.5, time: H, quoteVol: '1', baseVol: '60000', type: 'LAST_PRICE' },
      { open: 101, high: 104, low: 100, close: 103, time: 2 * H, quoteVol: '6000', baseVol: '58', type: 'LAST_PRICE' },
    ];
    expect(parseKlines(rows)).toEqual([
      { openTime: H, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1 },
      { openTime: 2 * H, open: 101, high: 104, low: 100, close: 103, volume: 6000 },
    ]);
  });

  test('missing volume is null, not zero', () => {
    expect(parseKlines([{ open: 1, high: 1, low: 1, close: 1, time: H }])[0]!.volume).toBeNull();
  });

  test('rejects malformed bars loudly', () => {
    expect(() => parseKlines({})).toThrow(ParseError);
    expect(() => parseKlines([{ open: 1, high: 1, low: 1, close: 1, time: 'x' }])).toThrow(/time/);
    expect(() => parseKlines([{ open: 0, high: 1, low: 1, close: 1, time: H }])).toThrow(/open/);
    // A range that doesn't cover the body (Bitunix does this) is widened, not rejected.
    expect(parseKlines([{ open: 1, high: 0.5, low: 0.4, close: 1.2, time: H }])[0]).toMatchObject({ high: 1.2, low: 0.4 });
    expect(parseKlines([{ open: 1, high: 1.3, low: 1.1, close: 1.2, time: H }])[0]).toMatchObject({ high: 1.3, low: 1 });
  });
});

describe('parseFundingBatch', () => {
  test('live fields; the percent rate becomes a fraction; bad rows are skipped and counted', () => {
    const { items, rejected } = parseFundingBatch([
      { symbol: 'BTCUSDT', markPrice: '60000', lastPrice: '60001', fundingRate: '0.01', fundingInterval: 8, nextFundingTime: '1790467200000' },
      { symbol: 'XRPUSDT', fundingRate: '-0.005' },
      { symbol: 'BADUSDT', fundingRate: 'n/a' },
      'junk',
    ]);
    expect(rejected).toBe(2);
    expect(items).toEqual([
      { symbol: 'BTCUSDT', rate: 0.0001, intervalHours: 8, nextFundingTime: 1790467200000, markPrice: 60000 },
      { symbol: 'XRPUSDT', rate: -0.00005, intervalHours: 8, nextFundingTime: null, markPrice: null },
    ]);
  });
});

describe('parseTickers and parseTradingPairs', () => {
  test('map the fields and keep the raw pair row', () => {
    expect(parseTickers([{ symbol: 'BTCUSDT', quoteVol: '123', lastPrice: '1' }, { nope: 1 }]))
      .toEqual([{ symbol: 'BTCUSDT', quoteVolume24h: 123, lastPrice: 1 }]);
    const row = { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: '0.0001', basePrecision: 4, quotePrecision: 1, minLeverage: 1, maxLeverage: 125, symbolStatus: 'OPEN' };
    expect(parseTradingPairs([row])).toEqual([{
      symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', minTradeVolume: 0.0001, basePrecision: 4, quotePrecision: 1,
      minLeverage: 1, maxLeverage: 125, raw: row,
    }]);
  });
});
