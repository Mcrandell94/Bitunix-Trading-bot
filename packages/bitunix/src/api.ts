// Bitunix futures API facts, and where each one came from.
//
// VERIFIED: stated in Bitunix's official SDK/demo repository,
//   github.com/BitunixOfficial/open-api (Demo/Node, Demo/Python).
// DOCS-QUOTED: from openapidoc.bitunix.com as quoted by web search; the
//   docs site itself was not reachable from the build environment.
// LIVE: confirmed by `npm run probe` against the live API (2026-09-26).
// DOCS-QUOTED (3rd party): the docs as quoted by another Bitunix
//   integration (github.com/mydcc/cachy-app issue 3337).
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
/** VERIFIED (errorCodes.js): code 10005 "Too many requests, please try again later". */
export const CODE_TOO_MANY_REQUESTS = 10005;

/**
 * VERIFIED (errorCodes.js). Codes the order code reacts to; the rest are
 * reported as they come.
 */
export const ERROR_CODES = {
  parameterError: 10002,
  ipNotWhitelisted: 10004,
  signatureError: 10007,
  insufficientBalance: 20003,
  invalidLeverage: 20005,
  /** "You can't change leverage or margin mode as there are open orders". */
  cannotChangeLeverage: 20006,
  orderNotFound: 20007,
  /** "Position exists, so positions mode cannot be updated". */
  positionModeLocked: 20009,
  /** LIVE (2026-09-26, AMBUSDT): the symbol refuses API trading. */
  notAllowedToTrade: 20015,
  positionNotExist: 30004,
  /** "The trigger price is closer to the current price and may be triggered immediately". */
  triggerTooClose: 30005,
} as const;

/**
 * Private endpoints. VERIFIED paths: Demo/Java/.../constants/FuturesPath.java
 * (the Node and Python demos use the same paths for the ones they cover).
 * Method per endpoint: GET for reads (Node demo), POST with a JSON body for
 * writes (all demos).
 */
export const PRIVATE_PATHS = {
  account: '/api/v1/futures/account',
  leverageMarginMode: '/api/v1/futures/account/get_leverage_margin_mode',
  changePositionMode: '/api/v1/futures/account/change_position_mode',
  changeLeverage: '/api/v1/futures/account/change_leverage',
  changeMarginMode: '/api/v1/futures/account/change_margin_mode',
  placeOrder: '/api/v1/futures/trade/place_order',
  cancelOrders: '/api/v1/futures/trade/cancel_orders',
  flashClosePosition: '/api/v1/futures/trade/flash_close_position',
  pendingOrders: '/api/v1/futures/trade/get_pending_orders',
  orderDetail: '/api/v1/futures/trade/get_order_detail',
  historyOrders: '/api/v1/futures/trade/get_history_orders',
  pendingPositions: '/api/v1/futures/position/get_pending_positions',
  historyPositions: '/api/v1/futures/position/get_history_positions',
  pendingTpsl: '/api/v1/futures/tpsl/get_pending_orders',
  placeTpsl: '/api/v1/futures/tpsl/place_order',
  modifyTpsl: '/api/v1/futures/tpsl/modify_order',
  cancelTpsl: '/api/v1/futures/tpsl/cancel_order',
  placePositionTpsl: '/api/v1/futures/tpsl/position/place_order',
  modifyPositionTpsl: '/api/v1/futures/tpsl/position/modify_order',
} as const;

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
