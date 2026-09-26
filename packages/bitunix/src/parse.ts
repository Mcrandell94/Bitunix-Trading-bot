// Response parsers. The only code that knows Bitunix's field names, so
// when `npm run probe` finds a field differs, this is the file to fix.
// Provenance tags as in api.ts.

import type { Candle } from '@bot/marketdata';

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Numbers arrive as JSON numbers or numeric strings (DOCS-QUOTED: both occur). */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Klines. DOCS-QUOTED fields: open, high, low, close, time, quoteVol,
 * baseVol, type. ASSUMED: `time` is the bar's OPEN time in ms (the probe
 * checks it lands on interval boundaries). Volume uses quoteVol; the docs
 * example looks like it swaps quoteVol and baseVol, but relative volume is a
 * ratio of one series, so either works if it's used consistently.
 * Returns bars sorted by open time, duplicates removed (last one wins).
 */
export function parseKlines(data: unknown): Candle[] {
  if (!Array.isArray(data)) throw new ParseError('kline data is not an array');
  const byTime = new Map<number, Candle>();
  data.forEach((row, i) => {
    if (!isObj(row)) throw new ParseError(`kline[${i}] is not an object`);
    const openTime = num(row.time);
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    if (openTime == null || !Number.isInteger(openTime) || openTime <= 0) throw new ParseError(`kline[${i}].time is not a ms timestamp: ${String(row.time)}`);
    for (const [k, v] of [['open', open], ['high', high], ['low', low], ['close', close]] as const) {
      if (v == null || v <= 0) throw new ParseError(`kline[${i}].${k} is not a positive number: ${String(row[k])}`);
    }
    if (high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) {
      throw new ParseError(`kline[${i}] high/low don't bracket open/close`);
    }
    const volume = num(row.quoteVol);
    byTime.set(openTime, { openTime, open: open!, high: high!, low: low!, close: close!, volume: volume != null && volume >= 0 ? volume : null });
  });
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export interface FundingInfo {
  symbol: string;
  /** Per-interval rate as a fraction (0.0001 = 0.01%). */
  rate: number;
  intervalHours: number;
  nextFundingTime: number | null;
  markPrice: number | null;
}

/**
 * ASSUMED: fundingRate is a fraction, not a percent. The probe flags it if
 * typical magnitudes look like percents.
 */
export const FUNDING_RATE_IS_PERCENT = false;
/** ASSUMED: fundingInterval is in hours; 8 when absent. */
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

/**
 * Batch funding. DOCS-QUOTED fields: symbol, markPrice, fundingRate,
 * fundingInterval, nextFundingTime. Malformed rows are skipped and counted,
 * so one bad symbol doesn't sink the scan.
 */
export function parseFundingBatch(data: unknown): { items: FundingInfo[]; rejected: number } {
  if (!Array.isArray(data)) throw new ParseError('funding data is not an array');
  const items: FundingInfo[] = [];
  let rejected = 0;
  for (const row of data) {
    const rate = isObj(row) ? num(row.fundingRate) : null;
    if (!isObj(row) || typeof row.symbol !== 'string' || rate == null) { rejected++; continue; }
    const interval = num(row.fundingInterval);
    items.push({
      symbol: row.symbol,
      rate: FUNDING_RATE_IS_PERCENT ? rate / 100 : rate,
      intervalHours: interval != null && interval > 0 ? interval : DEFAULT_FUNDING_INTERVAL_HOURS,
      nextFundingTime: num(row.nextFundingTime),
      markPrice: num(row.markPrice),
    });
  }
  return { items, rejected };
}

export interface Ticker {
  symbol: string;
  /** 24h volume in USDT. ASSUMED field: quoteVol. */
  quoteVolume24h: number | null;
  lastPrice: number | null;
}

/** Tickers. ASSUMED fields: symbol, quoteVol, lastPrice. */
export function parseTickers(data: unknown): Ticker[] {
  if (!Array.isArray(data)) throw new ParseError('ticker data is not an array');
  return data.filter(isObj).filter((r) => typeof r.symbol === 'string').map((r) => ({
    symbol: r.symbol as string,
    quoteVolume24h: num(r.quoteVol),
    lastPrice: num(r.lastPrice),
  }));
}

export interface ContractSpec {
  symbol: string;
  base: string | null;
  quote: string | null;
  minTradeVolume: number | null;
  basePrecision: number | null;
  quotePrecision: number | null;
  minLeverage: number | null;
  maxLeverage: number | null;
  /** The full row, for fields not mapped yet (status, order limits...). */
  raw: Record<string, unknown>;
}

/**
 * Trading pairs. DOCS-QUOTED fields: symbol, base, quote, minTradeVolume,
 * basePrecision, quotePrecision, minLeverage, maxLeverage. The status field
 * name isn't known yet, so it stays in `raw`.
 */
export function parseTradingPairs(data: unknown): ContractSpec[] {
  if (!Array.isArray(data)) throw new ParseError('trading pairs data is not an array');
  return data.filter(isObj).filter((r) => typeof r.symbol === 'string').map((r) => ({
    symbol: r.symbol as string,
    base: typeof r.base === 'string' ? r.base : null,
    quote: typeof r.quote === 'string' ? r.quote : null,
    minTradeVolume: num(r.minTradeVolume),
    basePrecision: num(r.basePrecision),
    quotePrecision: num(r.quotePrecision),
    minLeverage: num(r.minLeverage),
    maxLeverage: num(r.maxLeverage),
    raw: r,
  }));
}
