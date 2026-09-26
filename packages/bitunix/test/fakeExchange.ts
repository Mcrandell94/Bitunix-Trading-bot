// An in-memory Bitunix for tests. Serves the documented response shapes
// and can mimic each undocumented behavior fetchCandles must survive.

import type { Candle, IntervalName } from '@bot/marketdata';
import { KLINE_MAX_LIMIT, PATHS, type BitunixClient, type Params } from '../src/index';

export interface FakeExchangeOptions {
  /** candles[symbol][interval], any order; may include a still-open bar. */
  candles: Record<string, Partial<Record<IntervalName, Candle[]>>>;
  funding?: unknown[];
  tickers?: unknown[];
  tradingPairs?: unknown[];
  /** Funding history rows per symbol, any order; served newest first, `limit` at a time, within startTime/endTime. */
  fundingHistory?: Record<string, { fundingTime: number; fundingRate: string }[]>;
  /** Which bars a range holding more than `limit` returns. */
  capKeeps?: 'earliest' | 'latest';
  order?: 'asc' | 'desc';
  endTimeInclusive?: boolean;
  /** Paths that fail with a server error. */
  failing?: string[];
}

export interface FakeExchange extends BitunixClient {
  calls: { path: string; params: Params }[];
}

export function fakeExchange(opts: FakeExchangeOptions): FakeExchange {
  const calls: FakeExchange['calls'] = [];
  return {
    calls,
    async get<T>(path: string, params: Params = {}): Promise<T> {
      calls.push({ path, params });
      if (opts.failing?.includes(path)) throw new Error(`fake ${path} is down`);
      switch (path) {
        case PATHS.kline: {
          const list = opts.candles[String(params.symbol)]?.[params.interval as IntervalName] ?? [];
          const start = params.startTime == null ? -Infinity : Number(params.startTime);
          const end = params.endTime == null ? Infinity : Number(params.endTime);
          const limit = Math.min(Number(params.limit ?? 100), KLINE_MAX_LIMIT);
          let rows = list
            .filter((c) => c.openTime >= start && (opts.endTimeInclusive === false ? c.openTime < end : c.openTime <= end))
            .sort((a, b) => a.openTime - b.openTime);
          rows = (opts.capKeeps ?? 'latest') === 'latest' ? rows.slice(-limit) : rows.slice(0, limit);
          if (opts.order === 'desc') rows.reverse();
          return rows.map((c) => ({
            open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close),
            time: c.openTime, quoteVol: c.volume == null ? undefined : String(c.volume),
            baseVol: c.volume == null ? undefined : String(c.volume / c.close), type: params.type ?? 'LAST_PRICE',
          })) as T;
        }
        case PATHS.fundingRateBatch: return (opts.funding ?? []) as T;
        case PATHS.tickers: return (opts.tickers ?? []) as T;
        case PATHS.tradingPairs: return (opts.tradingPairs ?? []) as T;
        case PATHS.fundingRateHistory: {
          const rows = opts.fundingHistory?.[String(params.symbol)] ?? [];
          const start = Number(params.startTime ?? -Infinity);
          const end = Number(params.endTime ?? Infinity);
          return rows.filter((r) => r.fundingTime >= start && r.fundingTime <= end)
            .sort((a, b) => b.fundingTime - a.fundingTime).slice(0, Number(params.limit ?? 100)) as T;
        }
        default: throw new Error(`fake exchange: unknown path ${path}`);
      }
    },
  };
}

/** Hourly-style candles on an interval grid from closes. */
export function candlesFrom(closes: ReadonlyArray<number>, firstOpen: number, stepMs: number, volumes?: ReadonlyArray<number | null>): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      openTime: firstOpen + i * stepMs, open, close,
      high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999,
      volume: volumes ? volumes[i] ?? null : 1000,
    };
  });
}
