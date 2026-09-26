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

/** Numbers arrive as JSON numbers or numeric strings (DOCS-QUOTED: both occur); accept either. */
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
 * Klines. LIVE fields: open, high, low, close, time, quoteVol, baseVol.
 * LIVE: `time` is the bar's open time in ms, on UTC 1h/4h/1d boundaries;
 * rows come newest first and exclude the still-open bar. quoteVol is USDT
 * volume (quoteVol / baseVol ≈ close), despite the docs example.
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
    // LIVE: Bitunix sometimes returns a high/low that doesn't cover the
    // open/close (seen 2026-09-26). Widen the range to the body rather than
    // reject the bar: a wick can't be shorter than the body it contains.
    const hi = Math.max(high!, open!, close!);
    const lo = Math.min(low!, open!, close!);
    const volume = num(row.quoteVol);
    byTime.set(openTime, { openTime, open: open!, high: hi, low: lo, close: close!, volume: volume != null && volume >= 0 ? volume : null });
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
 * LIVE: fundingRate is a PERCENT per interval ("0.01" = 0.01%). The median
 * |fundingRate| over 895 symbols was 0.005, i.e. 0.005%; as a fraction that
 * would be 0.5% per interval. Parsed rates are converted to fractions.
 */
export const FUNDING_RATE_IS_PERCENT = true;
/** LIVE values 1, 2, 4, 8, read as hours (fits nextFundingTime on the hour); 8 when absent. */
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

/**
 * Batch funding. LIVE fields: symbol, markPrice, fundingRate,
 * fundingInterval, nextFundingTime (plus lastPrice, indexPrice,
 * maxFundingRate, minFundingRate, unused here). Malformed rows are skipped and counted,
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
  /** 24h volume in USDT (LIVE field quoteVol). */
  quoteVolume24h: number | null;
  lastPrice: number | null;
}

/** Tickers. LIVE fields: symbol, quoteVol, lastPrice. */
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
  /** LIVE field isApiSupported: false means Bitunix refuses API trading (error 20015). */
  apiSupported: boolean | null;
  /** LIVE field symbolStatus; its values aren't documented yet. */
  status: string | null;
  /** The full row, for fields not mapped yet (order limits...). */
  raw: Record<string, unknown>;
}

/**
 * Trading pairs. LIVE fields: symbol, base, quote, minTradeVolume,
 * basePrecision, quotePrecision, minLeverage, maxLeverage. Also present and
 * kept in `raw` until an order stage needs them: symbolStatus,
 * isApiSupported, launchTime, order-volume limits, default leverage/margin.
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
    apiSupported: typeof r.isApiSupported === 'boolean' ? r.isApiSupported : null,
    status: r.symbolStatus == null ? null : String(r.symbolStatus),
    raw: r,
  }));
}

export interface FundingPoint {
  /** Settlement time, ms. */
  time: number;
  /** Per-settlement rate as a fraction. */
  rate: number;
}

// LIVE (2026-09-26): rows are { fundingRate, fundingTime, markPrice }.
// The other names are kept as fallbacks in case a row uses them.
const FUNDING_TIME_FIELDS = ['fundingTime', 'settleTime', 'time', 'ts', 'ctime'] as const;

/**
 * LIVE (2026-09-26): unlike the batch endpoint, history rates are plain
 * FRACTIONS. BTC's latest was -0.0000058 (-0.00058%) and the median |rate|
 * 0.00001; read as percents they'd be ~100x smaller than any real funding.
 */
export const FUNDING_HISTORY_RATE_IS_PERCENT = false;

/**
 * Funding history: an array (or { list: [...] }) of rows with fundingRate
 * and fundingTime. Rows without both are skipped. Sorted oldest first.
 */
export function parseFundingHistory(data: unknown): FundingPoint[] {
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.list) ? data.list : null;
  if (!rows) throw new ParseError('funding history is not an array');
  const out = new Map<number, FundingPoint>();
  for (const r of rows) {
    if (!isObj(r)) continue;
    const rate = num(r.fundingRate);
    const field = FUNDING_TIME_FIELDS.find((f) => num(r[f]) != null);
    const time = field ? num(r[field]) : null;
    if (rate == null || time == null) continue;
    out.set(time, { time, rate: FUNDING_HISTORY_RATE_IS_PERCENT ? rate / 100 : rate });
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}
