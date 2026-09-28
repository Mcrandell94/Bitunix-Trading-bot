// The account side of Bitunix: typed reads, gated writes, and pure order
// planning. Nothing here decides WHAT to trade; that's the strategy's job.
//
// The gate. Every write (orders, leverage, modes) goes through one place:
// - 'disabled' (default): refused before any network call.
// - 'dry-run': the exact request is reported and nothing is sent.
// - 'live': sent. Needs TRADING_ENABLED=true AND LIVE_DRY_RUN=false.
// Reads (balance, positions, orders) are allowed in every mode.
//
// Sources for each fact are tagged as in api.ts. Request fields: VERIFIED
// from the SDK request classes (Demo/Java/.../request/*.java) and the Node
// demo's placeOrder. Response fields: VERIFIED from the SDK response classes
// (Demo/Java/.../response/*.java). Enum values: VERIFIED from
// Demo/Java/.../enums. Anything else is marked.

import { PRIVATE_PATHS } from './api';
import type { PrivateClient } from './client';
import { ParseError, num, type ContractSpec } from './parse';

// ---- The gate -----------------------------------------------------------------

export type WriteMode = 'live' | 'dry-run' | 'disabled';

/** Live only when the master switch is on AND dry-run is off. */
export function writeMode(opts: { tradingEnabled: boolean; dryRun: boolean }): WriteMode {
  if (opts.dryRun) return 'dry-run';
  return opts.tradingEnabled ? 'live' : 'disabled';
}

export class TradingDisabledError extends Error {
  constructor(readonly path: string) {
    super(`trading is disabled (TRADING_ENABLED is not true): refused ${path}`);
    this.name = 'TradingDisabledError';
  }
}

export interface WriteRequest {
  path: string;
  body: Record<string, unknown>;
}

export type WriteOutcome<T> = { status: 'sent'; request: WriteRequest; data: T } | { status: 'dry-run'; request: WriteRequest };

// ---- Ownership ----------------------------------------------------------------
//
// The account is shared with the owner's own trading. The bot may only touch
// what it created: orders whose clientId starts with BOT_CLIENT_PREFIX, and
// positions whose positionId it registered when its own entry filled. Every
// write is checked here, before the gate, whatever the mode:
// - opening: needs a bot clientId, and is refused while the owner holds a
//   position on the same symbol and side (hedge mode could merge them);
// - closing, TP/SL, market-close: only positions the bot owns;
// - cancelling: only bot orders;
// - leverage / margin mode: refused on a symbol where the owner has a
//   position or an order (they would change the owner's position too);
// - position mode: refused while the owner has any position.

export const BOT_CLIENT_PREFIX = 'bot-';
export const isBotClientId = (id: string | null | undefined) => typeof id === 'string' && id.startsWith(BOT_CLIENT_PREFIX);

export class NotOwnedError extends Error {
  constructor(message: string) {
    super(`refused, not the bot's: ${message}`);
    this.name = 'NotOwnedError';
  }
}

// ---- Parsed responses -------------------------------------------------------

export type PositionMode = 'HEDGE' | 'ONE_WAY';
export type MarginMode = 'ISOLATION' | 'CROSS';
export type StopType = 'MARK_PRICE' | 'LAST_PRICE';
export type Side = 'long' | 'short';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const req = (v: unknown, what: string): number => {
  const n = num(v);
  if (n == null) throw new ParseError(`${what} is missing or not a number`);
  return n;
};

export interface Account {
  marginCoin: string;
  available: number;
  frozen: number | null;
  margin: number | null;
  transfer: number | null;
  positionMode: PositionMode | null;
  crossUnrealizedPnl: number | null;
  isolationUnrealizedPnl: number | null;
  bonus: number | null;
}

/** VERIFIED fields (response/Account.java). The SDK reads one object; an array is accepted too (ASSUMED harmless). */
export function parseAccount(data: unknown, marginCoin = 'USDT'): Account {
  const row = Array.isArray(data) ? data.filter(isObj).find((r) => r.marginCoin === marginCoin) ?? data[0] : data;
  if (!isObj(row)) throw new ParseError('account data is not an object');
  const mode = str(row.positionMode);
  return {
    marginCoin: str(row.marginCoin) ?? marginCoin,
    available: req(row.available, 'account.available'),
    frozen: num(row.frozen),
    margin: num(row.margin),
    transfer: num(row.transfer),
    positionMode: mode === 'HEDGE' || mode === 'ONE_WAY' ? mode : null,
    crossUnrealizedPnl: num(row.crossUnrealizedPNL),
    isolationUnrealizedPnl: num(row.isolationUnrealizedPNL),
    bonus: num(row.bonus),
  };
}

export interface Position {
  positionId: string;
  symbol: string;
  side: Side;
  qty: number;
  avgOpenPrice: number;
  leverage: number | null;
  marginMode: string | null;
  positionMode: string | null;
  margin: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  fee: number | null;
  funding: number | null;
  liqPrice: number | null;
  openedAt: number | null;
  updatedAt: number | null;
}

/**
 * Position side. LIVE (2026-09-26, the owner's account): LONG / SHORT, and
 * hedge mode holds several same-direction positions on one symbol, each
 * with its own positionId. BUY/SELL is accepted too as a fallback.
 * Anything else is refused rather than guessed.
 */
export function parseSide(v: unknown): Side {
  const s = String(v ?? '').toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'long';
  if (s === 'SHORT' || s === 'SELL') return 'short';
  throw new ParseError(`unknown position side "${String(v)}"`);
}

/**
 * A closed position's net result from position history: realized P&L less the
 * trading fee (counted as a cost whatever its sign). Funding is left out
 * (small, and its sign isn't verified). Null when the position isn't listed.
 * The list may come bare or as { positionList: [...] }.
 */
export function parseClosedPositionPnl(data: unknown, positionId: string): number | null {
  const rows = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.positionList) ? data.positionList : null;
  if (!rows) return null;
  const r = rows.filter(isObj).find((x) => String(x.positionId) === positionId);
  const pnl = r ? num(r.realizedPNL) : null;
  if (pnl == null) return null;
  return pnl - Math.abs(num(r!.fee) ?? 0);
}

/** VERIFIED fields (response/PositionPendingResp.java). */
export function parsePositions(data: unknown): Position[] {
  if (data == null) return [];
  if (!Array.isArray(data)) throw new ParseError('positions data is not an array');
  return data.filter(isObj).map((r) => ({
    positionId: String(r.positionId),
    symbol: String(r.symbol),
    side: parseSide(r.side),
    qty: req(r.qty, 'position.qty'),
    avgOpenPrice: req(r.avgOpenPrice, 'position.avgOpenPrice'),
    leverage: num(r.leverage),
    marginMode: str(r.marginMode),
    positionMode: str(r.positionMode),
    margin: num(r.margin),
    unrealizedPnl: num(r.unrealizedPNL),
    realizedPnl: num(r.realizedPNL),
    fee: num(r.fee),
    funding: num(r.funding),
    liqPrice: num(r.liqPrice),
    openedAt: num(r.ctime),
    updatedAt: num(r.mtime),
  }));
}

export interface OpenOrder {
  orderId: string;
  clientId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string | null;
  qty: number;
  filledQty: number;
  price: number | null;
  status: string | null;
  reduceOnly: boolean | null;
  slPrice: number | null;
  tpPrice: number | null;
  createdAt: number | null;
}

/** VERIFIED fields (response/OrderResp.java, OrderPageResp.java: { orderList, total }). */
export function parseOrders(data: unknown): OpenOrder[] {
  const list = Array.isArray(data) ? data : isObj(data) ? data.orderList ?? [] : null;
  if (!Array.isArray(list)) throw new ParseError('orders data is neither a list nor { orderList }');
  return list.filter(isObj).map((r) => {
    const side = String(r.side ?? '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') throw new ParseError(`unknown order side "${String(r.side)}"`);
    return {
      orderId: String(r.orderId),
      clientId: str(r.clientId),
      symbol: String(r.symbol),
      side,
      orderType: str(r.orderType),
      qty: req(r.qty, 'order.qty'),
      filledQty: num(r.tradeQty) ?? 0,
      price: num(r.price),
      status: str(r.status),
      reduceOnly: typeof r.reduceOnly === 'boolean' ? r.reduceOnly : null,
      slPrice: num(r.slPrice),
      tpPrice: num(r.tpPrice),
      createdAt: num(r.ctime),
    };
  });
}

export interface TpslOrder {
  id: string;
  positionId: string | null;
  symbol: string;
  tpPrice: number | null;
  tpStopType: string | null;
  slPrice: number | null;
  slStopType: string | null;
  tpQty: number | null;
  slQty: number | null;
}

/** VERIFIED fields (response/TpslPendingOrderResp.java). */
export function parseTpslOrders(data: unknown): TpslOrder[] {
  if (data == null) return [];
  if (!Array.isArray(data)) throw new ParseError('tp/sl orders data is not an array');
  return data.filter(isObj).map((r) => ({
    id: String(r.id),
    positionId: str(r.positionId),
    symbol: String(r.symbol),
    tpPrice: num(r.tpPrice),
    tpStopType: str(r.tpStopType),
    slPrice: num(r.slPrice),
    slStopType: str(r.slStopType),
    tpQty: num(r.tpQty),
    slQty: num(r.slQty),
  }));
}

export interface LeverageMarginMode {
  symbol: string;
  leverage: number | null;
  marginMode: MarginMode | null;
}

/** VERIFIED fields (response/MarketSetting.java). */
export function parseLeverageMarginMode(data: unknown, symbol: string): LeverageMarginMode {
  const row = Array.isArray(data) ? data.filter(isObj).find((r) => r.symbol === symbol) ?? data[0] : data;
  if (!isObj(row)) throw new ParseError('leverage/margin data is not an object');
  const m = str(row.marginMode);
  return { symbol, leverage: num(row.leverage), marginMode: m === 'ISOLATION' || m === 'CROSS' ? m : null };
}

export interface OrderId {
  orderId: string | null;
  clientId: string | null;
}

export function parseOrderId(data: unknown): OrderId {
  if (!isObj(data)) throw new ParseError('order response is not an object');
  return { orderId: str(data.orderId), clientId: str(data.clientId) };
}

// ---- Request bodies ---------------------------------------------------------

/** VERIFIED fields (request/PlaceOrderRequest.java; the Node demo sends numbers as strings). */
export interface PlaceOrderBody {
  symbol: string;
  side: 'BUY' | 'SELL';
  tradeSide: 'OPEN' | 'CLOSE';
  orderType: 'LIMIT' | 'MARKET';
  qty: string;
  price?: string;
  /** Required with tradeSide CLOSE in hedge mode. */
  positionId?: string;
  effect?: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';
  clientId?: string;
  reduceOnly?: boolean;
  tpPrice?: string;
  tpStopType?: StopType;
  tpOrderType?: 'LIMIT' | 'MARKET';
  tpOrderPrice?: string;
  slPrice?: string;
  slStopType?: StopType;
  slOrderType?: 'LIMIT' | 'MARKET';
  slOrderPrice?: string;
}

/** VERIFIED fields (request/PlacePositionTpslOrderRequest.java): TP/SL for the whole position. */
export interface PositionTpslBody {
  symbol: string;
  positionId: string;
  slPrice?: string;
  slStopType?: StopType;
  tpPrice?: string;
  tpStopType?: StopType;
}

/**
 * Modify one TP/SL order by its id (tpsl/modify_order). The entry order's attached stop and target live as
 * such an order, with quantities; the position TP/SL endpoints don't change it (LIVE 2026-09-28: a
 * position-TP/SL modify answered success and the order's stop stayed where it was).
 */
export interface TpslModifyBody {
  orderId: string;
  slPrice?: string;
  slStopType?: StopType;
  slQty?: string;
  tpPrice?: string;
  tpStopType?: StopType;
  tpQty?: string;
}

// ---- The API ------------------------------------------------------------------

export interface TradeApiOptions {
  /** Fixed, or read at every write (so a kill switch takes effect at once). */
  mode: WriteMode | (() => WriteMode);
  /** Told about every write: sent, dry-run or refused. */
  onWrite?: (event: { mode: WriteMode; request: WriteRequest }) => void;
  marginCoin?: string;
  /** positionIds the bot opened. Default: none, so no existing position can be touched. */
  ownedPositions?: () => Promise<ReadonlySet<string>>;
}

export function createTradeApi(client: PrivateClient, opts: TradeApiOptions) {
  const coin = opts.marginCoin ?? 'USDT';

  const currentMode = (): WriteMode => (typeof opts.mode === 'function' ? opts.mode() : opts.mode);
  const owned = opts.ownedPositions ?? (async () => new Set<string>());
  const readPositions = async (symbol?: string) => parsePositions(await client.get(PRIVATE_PATHS.pendingPositions, { symbol }));
  const readOrders = async (symbol?: string) => parseOrders(await client.get(PRIVATE_PATHS.pendingOrders, { symbol }));

  async function ownerPositions(symbol?: string): Promise<Position[]> {
    const mine = await owned();
    return (await readPositions(symbol)).filter((p) => !mine.has(p.positionId));
  }
  async function requireOwnedPosition(positionId: string | undefined): Promise<void> {
    if (!positionId || !(await owned()).has(positionId)) throw new NotOwnedError(`position ${positionId ?? '(none)'}`);
  }
  async function requireNoOwnerActivity(symbol: string, what: string): Promise<void> {
    if ((await ownerPositions(symbol)).length) throw new NotOwnedError(`${what}: you have a position on ${symbol}`);
    if ((await readOrders(symbol)).some((o) => !isBotClientId(o.clientId))) throw new NotOwnedError(`${what}: you have open orders on ${symbol}`);
  }
  async function checkPlaceOrder(body: PlaceOrderBody): Promise<void> {
    if (body.tradeSide === 'CLOSE' || body.reduceOnly) return requireOwnedPosition(body.positionId);
    if (!isBotClientId(body.clientId)) throw new NotOwnedError(`an opening order needs a clientId starting with "${BOT_CLIENT_PREFIX}"`);
    const side: Side = body.side === 'BUY' ? 'long' : 'short';
    if ((await ownerPositions(body.symbol)).some((p) => p.side === side)) {
      throw new NotOwnedError(`you have a ${side} position on ${body.symbol}; the bot won't add to it`);
    }
  }
  async function checkCancel(symbol: string, orders: ReadonlyArray<{ orderId: string } | { clientId: string }>): Promise<void> {
    const pending = await readOrders(symbol);
    for (const o of orders) {
      const ok = 'clientId' in o ? isBotClientId(o.clientId) : isBotClientId(pending.find((p) => p.orderId === o.orderId)?.clientId);
      if (!ok) throw new NotOwnedError(`order ${'clientId' in o ? o.clientId : o.orderId} on ${symbol}`);
    }
  }
  async function checkTpslOrder(symbol: string, orderId: string): Promise<void> {
    const t = parseTpslOrders(await client.get(PRIVATE_PATHS.pendingTpsl, { symbol })).find((x) => x.id === orderId);
    await requireOwnedPosition(t?.positionId ?? undefined);
  }

  /** Disabled refuses before any network call; then the ownership check (dry runs too); then send or report. */
  async function write<T>(
    path: string, body: Record<string, unknown>, parse: (d: unknown) => T, check: () => Promise<void> = async () => {},
  ): Promise<WriteOutcome<T>> {
    const request = { path, body };
    const mode = currentMode();
    opts.onWrite?.({ mode, request });
    if (mode !== 'live' && mode !== 'dry-run') throw new TradingDisabledError(path);
    await check();
    if (mode === 'dry-run') return { status: 'dry-run', request };
    return { status: 'sent', request, data: parse(await client.post(path, body)) };
  }
  const ignore = () => undefined;

  return {
    get mode() { return currentMode(); },

    // Reads: allowed in every mode.
    account: async () => parseAccount(await client.get(PRIVATE_PATHS.account, { marginCoin: coin }), coin),
    leverageMarginMode: async (symbol: string) =>
      parseLeverageMarginMode(await client.get(PRIVATE_PATHS.leverageMarginMode, { symbol, marginCoin: coin }), symbol),
    positions: readPositions,
    pendingOrders: readOrders,
    pendingTpsl: async (symbol?: string, positionId?: string) =>
      parseTpslOrders(await client.get(PRIVATE_PATHS.pendingTpsl, { symbol, positionId })),

    /** Net result of a closed position (position history), or null if not found. */
    closedPositionPnl: async (symbol: string, positionId: string) =>
      parseClosedPositionPnl(await client.get(PRIVATE_PATHS.historyPositions, { symbol, positionId }), positionId),

    /** Positions the bot did not open (the owner's). */
    ownerPositions: () => ownerPositions(),
    ownedPositionIds: () => owned(),

    // Writes: the gate (disabled refuses at once), then the ownership check, then send or report.
    setPositionMode: (positionMode: PositionMode) => write(PRIVATE_PATHS.changePositionMode, { positionMode }, ignore, async () => {
      if ((await ownerPositions()).length) throw new NotOwnedError('position mode: you have open positions');
    }),
    setMarginMode: (symbol: string, marginMode: MarginMode) => {
      return write(PRIVATE_PATHS.changeMarginMode, { marginMode, symbol, marginCoin: coin }, ignore, () => requireNoOwnerActivity(symbol, 'margin mode'));
    },
    setLeverage: (symbol: string, leverage: number) => {
      if (!Number.isInteger(leverage) || leverage < 1) throw new Error(`leverage must be a whole number >= 1, got ${leverage}`);
      return write(PRIVATE_PATHS.changeLeverage, { marginCoin: coin, symbol, leverage }, ignore, () => requireNoOwnerActivity(symbol, 'leverage'));
    },
    placeOrder: (body: PlaceOrderBody) => {
      return write(PRIVATE_PATHS.placeOrder, { ...body }, parseOrderId, () => checkPlaceOrder(body));
    },
    cancelOrders: (symbol: string, orders: ReadonlyArray<{ orderId: string } | { clientId: string }>) => {
      return write(PRIVATE_PATHS.cancelOrders, { symbol, orderList: orders.map((o) => ({ ...o })) }, (d) => d, () => checkCancel(symbol, orders));
    },
    placePositionTpsl: (body: PositionTpslBody) => {
      return write(PRIVATE_PATHS.placePositionTpsl, { ...body }, parseOrderId, () => requireOwnedPosition(body.positionId));
    },
    modifyPositionTpsl: (body: PositionTpslBody) => {
      return write(PRIVATE_PATHS.modifyPositionTpsl, { ...body }, parseOrderId, () => requireOwnedPosition(body.positionId));
    },
    modifyTpsl: (symbol: string, body: TpslModifyBody) => {
      return write(PRIVATE_PATHS.modifyTpsl, { ...body }, parseOrderId, () => checkTpslOrder(symbol, body.orderId));
    },
    cancelTpsl: (symbol: string, orderId: string) => {
      return write(PRIVATE_PATHS.cancelTpsl, { symbol, orderId }, (d) => d, () => checkTpslOrder(symbol, orderId));
    },
    /** Market-closes one position the bot owns. */
    flashClose: (positionId: string) => {
      return write(PRIVATE_PATHS.flashClosePosition, { positionId }, ignore, () => requireOwnedPosition(positionId));
    },
  };
}

export type TradeApi = ReturnType<typeof createTradeApi>;

// ---- Order planning (pure) ------------------------------------------------------

export interface SymbolRules {
  symbol: string;
  /** Decimals allowed in qty (basePrecision). */
  qtyDecimals: number;
  /** Decimals allowed in price (quotePrecision). */
  priceDecimals: number;
  minQty: number;
  maxLeverage: number | null;
}

/** Null when the pair lacks the precision fields or refuses API trading. */
export function rulesFromSpec(spec: ContractSpec): SymbolRules | null {
  if (spec.basePrecision == null || spec.quotePrecision == null || spec.apiSupported === false) return null;
  return {
    symbol: spec.symbol,
    qtyDecimals: spec.basePrecision,
    priceDecimals: spec.quotePrecision,
    minQty: spec.minTradeVolume ?? 10 ** -spec.basePrecision,
    maxLeverage: spec.maxLeverage,
  };
}

// Decimal rounding without float drift: scale, nudge by a tiny epsilon, round.
const scale = (d: number) => 10 ** d;
const floorTo = (x: number, d: number) => Math.floor(x * scale(d) * (1 + 1e-12)) / scale(d);
const ceilTo = (x: number, d: number) => Math.ceil(x * scale(d) * (1 - 1e-12)) / scale(d);
const roundTo = (x: number, d: number) => Math.round(x * scale(d)) / scale(d);
/** A decimal string with at most `d` decimals and no trailing zeros. */
export const fmt = (x: number, d: number) => {
  const s = x.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/**
 * Maintenance margin assumed when checking liquidation distance (ASSUMED:
 * conservative for small positions; the real rate is per tier, see
 * get_position_tiers).
 */
export const ASSUMED_MAINTENANCE_MARGIN = 0.01;

/**
 * With isolated margin at `leverage`, liquidation sits roughly 1/leverage
 * minus maintenance margin away from entry. Require at least twice the stop
 * distance, so the stop always triggers well before liquidation.
 */
export function liquidationSafe(entry: number, stop: number, leverage: number, mmr = ASSUMED_MAINTENANCE_MARGIN): boolean {
  const stopFrac = Math.abs(entry - stop) / entry;
  return 1 / leverage - mmr >= 2 * stopFrac;
}

export interface EntryIntent {
  symbol: string;
  side: Side;
  /** Limit price. */
  entry: number;
  stop: number;
  /** Final target, attached to the order as its TP. */
  takeProfit: number;
  /** Most the trade may lose at the stop, before costs. */
  riskUsd: number;
  /** Idempotency key: lets a retry after an unclear failure find the order. */
  clientId: string;
  leverage: number;
}

export type EntryPlan =
  | { ok: true; body: PlaceOrderBody; qty: number; entry: number; stop: number; takeProfit: number; riskUsd: number }
  | { ok: false; reason: string };

/**
 * The opening order: a GTC limit at the entry with the stop and target
 * attached, both triggered by MARK price. The stop fills at market; the
 * target places a limit at the target price.
 *
 * Prices are rounded to the pair's precision first (stop away from entry,
 * target toward it), then the size is floored so the loss at the stop never
 * exceeds `riskUsd`.
 */
export function planEntry(intent: EntryIntent, rules: SymbolRules): EntryPlan {
  const { side, riskUsd } = intent;
  const long = side === 'long';
  const pd = rules.priceDecimals;
  if (!(riskUsd > 0)) return { ok: false, reason: 'risk must be positive' };
  if (long ? !(intent.stop < intent.entry && intent.entry < intent.takeProfit) : !(intent.takeProfit < intent.entry && intent.entry < intent.stop)) {
    return { ok: false, reason: `prices out of order for a ${side}: stop ${intent.stop}, entry ${intent.entry}, target ${intent.takeProfit}` };
  }
  const entry = roundTo(intent.entry, pd);
  const stop = long ? floorTo(intent.stop, pd) : ceilTo(intent.stop, pd);
  const takeProfit = long ? floorTo(intent.takeProfit, pd) : ceilTo(intent.takeProfit, pd);
  if (long ? !(stop < entry && entry < takeProfit) : !(takeProfit < entry && entry < stop)) {
    return { ok: false, reason: 'prices collapse at the pair\'s price precision' };
  }
  if (rules.maxLeverage != null && intent.leverage > rules.maxLeverage) {
    return { ok: false, reason: `leverage ${intent.leverage} is above the pair's max ${rules.maxLeverage}` };
  }
  if (!liquidationSafe(entry, stop, intent.leverage)) {
    return { ok: false, reason: `stop is too far for ${intent.leverage}x isolated margin (liquidation could come first)` };
  }
  const qty = floorTo(riskUsd / Math.abs(entry - stop), rules.qtyDecimals);
  if (qty < rules.minQty) return { ok: false, reason: `size ${qty} is below the pair's minimum ${rules.minQty}` };
  return {
    ok: true, qty, entry, stop, takeProfit, riskUsd: qty * Math.abs(entry - stop),
    body: {
      symbol: intent.symbol, side: long ? 'BUY' : 'SELL', tradeSide: 'OPEN', orderType: 'LIMIT', effect: 'GTC',
      qty: fmt(qty, rules.qtyDecimals), price: fmt(entry, pd), clientId: intent.clientId,
      slPrice: fmt(stop, pd), slStopType: 'MARK_PRICE', slOrderType: 'MARKET',
      tpPrice: fmt(takeProfit, pd), tpStopType: 'MARK_PRICE', tpOrderType: 'LIMIT', tpOrderPrice: fmt(takeProfit, pd),
    },
  };
}

/**
 * Hedge mode closes a position with tradeSide CLOSE, its positionId, and
 * the position's own direction as `side` (close long = BUY, close short =
 * SELL). DOCS-QUOTED (3rd party), not yet seen live: check with a small
 * position before trusting it with a real one.
 */
export const HEDGE_CLOSE_SIDE: Record<Side, 'BUY' | 'SELL'> = { long: 'BUY', short: 'SELL' };

/**
 * A resting take-profit (a partial or the final target): a POST_ONLY limit
 * that closes `qty` of the position, so it always pays the maker fee. A
 * limit that would cross the book is rejected by the exchange rather than
 * filled as taker.
 */
export function planTarget(
  position: { positionId: string; symbol: string; side: Side },
  price: number, qty: number, rules: SymbolRules, clientId: string,
): { ok: true; body: PlaceOrderBody } | { ok: false; reason: string } {
  const q = floorTo(qty, rules.qtyDecimals);
  if (q < rules.minQty) return { ok: false, reason: `size ${q} is below the pair's minimum ${rules.minQty}` };
  const p = position.side === 'long' ? floorTo(price, rules.priceDecimals) : ceilTo(price, rules.priceDecimals);
  return {
    ok: true,
    body: {
      symbol: position.symbol, side: HEDGE_CLOSE_SIDE[position.side], tradeSide: 'CLOSE', positionId: position.positionId,
      orderType: 'LIMIT', effect: 'POST_ONLY', qty: fmt(q, rules.qtyDecimals), price: fmt(p, rules.priceDecimals), clientId,
    },
  };
}

/** Moves the whole position's stop (breakeven, trailing). Mark-price trigger, as always. */
export function planStopMove(position: { positionId: string; symbol: string; side: Side }, stop: number, rules: SymbolRules): PositionTpslBody {
  const s = position.side === 'long' ? floorTo(stop, rules.priceDecimals) : ceilTo(stop, rules.priceDecimals);
  return { symbol: position.symbol, positionId: position.positionId, slPrice: fmt(s, rules.priceDecimals), slStopType: 'MARK_PRICE' };
}
