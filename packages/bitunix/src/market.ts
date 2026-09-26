// Market-data fetchers on top of the client.

import { intervalMs, type Candle } from '@bot/marketdata';
import { KLINE_MAX_LIMIT, PATHS, type Interval, type KlineType } from './api';
import type { BitunixClient } from './client';
import {
  parseFundingBatch, parseKlines, parseTickers, parseTradingPairs,
  type ContractSpec, type FundingInfo, type Ticker,
} from './parse';

export interface CandleRange {
  symbol: string;
  interval: Interval;
  /** First open time wanted (inclusive), ms. */
  from: number;
  /** Open times before this (exclusive), ms. */
  to: number;
  type?: KlineType;
}

/**
 * Candles with from <= openTime < to. It isn't documented which 200 bars
 * come back when a range holds more, so every request asks for a window of
 * at most KLINE_MAX_LIMIT bars with both startTime and endTime set. Either
 * inclusivity of endTime is fine: overlaps are de-duplicated.
 */
export async function fetchCandles(client: BitunixClient, range: CandleRange): Promise<Candle[]> {
  const ms = intervalMs(range.interval);
  const span = KLINE_MAX_LIMIT * ms;
  const byTime = new Map<number, Candle>();
  for (let start = range.from; start < range.to; start += span) {
    const end = Math.min(start + span, range.to) - 1;
    const data = await client.get(PATHS.kline, {
      symbol: range.symbol,
      interval: range.interval,
      limit: KLINE_MAX_LIMIT,
      startTime: start,
      endTime: end,
      type: range.type ?? 'LAST_PRICE',
    });
    for (const c of parseKlines(data)) {
      if (c.openTime >= range.from && c.openTime < range.to) byTime.set(c.openTime, c);
    }
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export async function fetchFunding(client: BitunixClient, symbols?: ReadonlyArray<string>) {
  const data = await client.get(PATHS.fundingRateBatch, symbols?.length ? { symbols: symbols.join(',') } : {});
  return parseFundingBatch(data);
}

export async function fetchTickers(client: BitunixClient, symbols?: ReadonlyArray<string>): Promise<Ticker[]> {
  return parseTickers(await client.get(PATHS.tickers, symbols?.length ? { symbols: symbols.join(',') } : {}));
}

export async function fetchTradingPairs(client: BitunixClient): Promise<ContractSpec[]> {
  return parseTradingPairs(await client.get(PATHS.tradingPairs));
}

export type { ContractSpec, FundingInfo, Ticker };
