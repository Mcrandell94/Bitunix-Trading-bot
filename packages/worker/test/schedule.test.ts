import { describe, expect, test } from 'vitest';
import { closingAt, loadConfig, nextRun, nextWake, selectUniverse } from '../src/index';

const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 8, 26, h, m, s);
const ALL = ['1h', '4h', '1d'] as const;

describe('schedule', () => {
  test('which timeframes close at an instant', () => {
    expect(closingAt(at(0), ALL)).toEqual(['1d', '4h', '1h']);
    expect(closingAt(at(8), ALL)).toEqual(['4h', '1h']);
    expect(closingAt(at(9), ALL)).toEqual(['1h']);
    expect(closingAt(at(9, 30), ALL)).toEqual([]);
    expect(closingAt(at(8), ['1d'])).toEqual([]);
  });

  test('next run is the next close plus the delay', () => {
    expect(nextRun(at(9, 30), ALL, 20_000)).toEqual({ at: at(10, 0, 20), closeTime: at(10), timeframes: ['1h'] });
    // Inside the delay after a close, that close is still ahead of us.
    expect(nextRun(at(12, 0, 5), ALL, 20_000)).toMatchObject({ at: at(12, 0, 20), timeframes: ['4h', '1h'] });
    // Daily only: skip ahead to 00:00 UTC.
    expect(nextRun(at(9, 30), ['1d'], 0)).toMatchObject({ closeTime: Date.UTC(2026, 8, 27), timeframes: ['1d'] });
  });
});

describe('nextWake (paper trading wakes every 15 minutes)', () => {
  test('every quarter hour, with the RRG scans due at that close', () => {
    expect(nextWake(at(9, 5), ALL, 20_000, true)).toEqual({ at: at(9, 15, 20), closeTime: at(9, 15), timeframes: [] });
    expect(nextWake(at(11, 50), ALL, 20_000, true)).toEqual({ at: at(12, 0, 20), closeTime: at(12), timeframes: ['4h', '1h'] });
    expect(nextWake(at(9, 5), ALL, 20_000, false)).toMatchObject({ closeTime: at(10) }); // paper off: hourly as before
  });
});

describe('config', () => {
  test('defaults, and DATABASE_URL is required', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: 'postgres://x' })).toMatchObject({
      timeframes: ['1h', '4h', '1d'], historyBars: 120, universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: 100,
      tradingEnabled: false,
    });
  });

  test('rejects bad values instead of guessing', () => {
    const base = { DATABASE_URL: 'postgres://x' };
    expect(() => loadConfig({ ...base, TIMEFRAMES: '1h,2h' })).toThrow(/TIMEFRAMES/);
    expect(() => loadConfig({ ...base, UNIVERSE: 'some' })).toThrow(/UNIVERSE/);
    expect(() => loadConfig({ ...base, HISTORY_BARS: '30' })).toThrow(/HISTORY_BARS/);
    // The master switch: anything but exactly "true"/"false" is refused, not guessed.
    for (const v of ['TRUE', 'yes', '1', 'ture']) expect(() => loadConfig({ ...base, TRADING_ENABLED: v })).toThrow(/TRADING_ENABLED/);
    expect(loadConfig({ ...base, TRADING_ENABLED: 'true', BITUNIX_API_KEY: 'k', BITUNIX_API_SECRET: 's' }).tradingEnabled).toBe(true);
    expect(loadConfig({ ...base, TRADING_ENABLED: 'false' }).tradingEnabled).toBe(false);
    expect(loadConfig(base).paper).toEqual({ enabled: false, startEquity: 10_000, extras: 10 });
    expect(loadConfig({ ...base, PAPER_TRADING: 'true', PAPER_EQUITY: '5000', PAPER_EXTRAS: '5' }).paper).toEqual({ enabled: true, startEquity: 5000, extras: 5 });
    expect(() => loadConfig({ ...base, PAPER_TRADING: 'yes' })).toThrow(/PAPER_TRADING/);
    expect(loadConfig({ ...base, TIMEFRAMES: '4h, 1d', UNIVERSE: 'core' })).toMatchObject({ timeframes: ['4h', '1d'], universe: 'core' });
  });

  test('dashboard: off without a password; PORT from Railway', () => {
    const base = { DATABASE_URL: 'postgres://x' };
    expect(loadConfig(base).dashboard).toEqual({ password: null, port: 8080 });
    expect(loadConfig({ ...base, DASHBOARD_PASSWORD: '', PORT: '' }).dashboard).toEqual({ password: null, port: 8080 });
    expect(loadConfig({ ...base, DASHBOARD_PASSWORD: 'correct horse battery', PORT: '3000' }).dashboard)
      .toEqual({ password: 'correct horse battery', port: 3000 });
    expect(() => loadConfig({ ...base, PORT: 'eighty' })).toThrow(/PORT/);
  });
});

describe('selectUniverse', () => {
  const tickers = [
    { symbol: 'SOLUSDT', quoteVolume24h: 5e8, lastPrice: 1 },
    { symbol: 'DOGEUSDT', quoteVolume24h: 9e8, lastPrice: 1 },
    { symbol: 'TINYUSDT', quoteVolume24h: 1e5, lastPrice: 1 },
    { symbol: 'NOVOLUSDT', quoteVolume24h: null, lastPrice: 1 },
    { symbol: 'XRPUSDT', quoteVolume24h: 1e3, lastPrice: 1 },
    { symbol: 'BTCUSD', quoteVolume24h: 1e10, lastPrice: 1 },
  ];
  const cfg = { universe: 'all' as const, minQuoteVolume24h: 1e7, maxExtraSymbols: 10 };

  test('core always; extras are liquid USDT perps, most liquid first, capped', () => {
    expect(selectUniverse(tickers, cfg)).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT', 'SOLUSDT']);
    expect(selectUniverse(tickers, { ...cfg, maxExtraSymbols: 1 })).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT']);
    expect(selectUniverse(tickers, { ...cfg, universe: 'core' })).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']);
    // Symbols Bitunix won't let the API trade are left out.
    expect(selectUniverse(tickers, cfg, new Set(['SOLUSDT']))).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT']);
  });
});
