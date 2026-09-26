// Bitunix futures API facts, and where each one came from.
//
// VERIFIED: stated in Bitunix's official SDK/demo repository,
//   github.com/BitunixOfficial/open-api (Demo/Node, Demo/Python).
// DOCS-QUOTED: from openapidoc.bitunix.com as quoted by web search; the
//   docs site itself was not reachable from the build environment.
// LIVE: confirmed by `npm run probe` against the live API (2026-09-26).
// ASSUMED: not confirmed anywhere yet. `npm run probe` re-checks every
//   LIVE, ASSUMED and DOCS-QUOTED item against the live API.

/** VERIFIED (Demo/Node/config.json). */
export const BASE_URL = 'https://fapi.bitunix.com';

export const PATHS = {
  /** VERIFIED. Params: symbol, interval, limit (max 200), startTime, endTime (ms), type. */
  kline: '/api/v1/futures/market/kline',
  /** VERIFIED. Optional `symbols` (comma-separated); all symbols without it. */
  tickers: '/api/v1/futures/market/tickers',
  /** VERIFIED. Optional `symbols` (Python demo passes it). */
  fundingRateBatch: '/api/v1/futures/market/funding_rate/batch',
  /** LIVE: returns every pair with its specs and `symbolStatus`. */
  tradingPairs: '/api/v1/futures/market/trading_pairs',
  /** DOCS-QUOTED path (docs: "10 req/sec/ip"). Params and fields ASSUMED; the probe checks them. */
  fundingRateHistory: '/api/v1/futures/market/get_funding_rate_history',
} as const;

/** VERIFIED: "1m, 5m, 15m, 30m, 1h, 4h, 1d". */
export const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

/** VERIFIED: "default 100, max 200". */
export const KLINE_MAX_LIMIT = 200;

/** VERIFIED: LAST_PRICE (default) or MARK_PRICE. */
export type KlineType = 'LAST_PRICE' | 'MARK_PRICE';

/** VERIFIED (errorCodes.js): code 10006 "Request too frequently". */
export const CODE_TOO_FREQUENT = 10006;

/**
 * VERIFIED: every response is { code, msg, data } and code 0 is success
 * (both demos throw on code !== 0).
 */
export interface Envelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

/**
 * ASSUMED: rate limits aren't in the SDK. Stay well under any sane limit
 * until the docs are checked: one request per 200 ms.
 */
export const DEFAULT_MIN_REQUEST_GAP_MS = 200;
