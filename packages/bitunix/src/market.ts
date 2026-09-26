// Market-data fetchers on top of the client.

import { intervalMs, type Candle } from '@bot/marketdata';
import { KLINE_MAX_LIMIT, PATHS, type Interval, type KlineType } from './api';
import type { BitunixClient } from './client';
import {
  parseFundingBatch, parseFundingHistory, parseKlines, parseTickers, parseTradingPairs,
  type ContractSpec, type FundingInfo, type FundingPoint, type Ticker,
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

/**
 * Funding settlements with from <= time < to. ASSUMED params: symbol,
 * startTime, endTime, limit (checked by the probe). Pages back from `to`
 * using the oldest time returned until it passes `from` or runs dry.
 */
export async function fetchFundingHistory(client: BitunixClient, symbol: string, from: number, to: number): Promise<FundingPoint[]> {
  const byTime = new Map<number, FundingPoint>();
  let end = to - 1;
  for (let page = 0; page < 200 && end >= from; page++) {
    const rows = parseFundingHistory(await client.get(PATHS.fundingRateHistory, { symbol, startTime: from, endTime: end, limit: 100 }));
    const fresh = rows.filter((f) => f.time >= from && f.time < to && !byTime.has(f.time));
    for (const f of fresh) byTime.set(f.time, f);
    if (fresh.length === 0) break;
    end = Math.min(...fresh.map((f) => f.time)) - 1;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export type { ContractSpec, FundingInfo, FundingPoint, Ticker };
