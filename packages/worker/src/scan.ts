// The coin list: core symbols plus the most liquid USDT perps Bitunix lets the API trade.

import { fetchTickers, fetchTradingPairs, type BitunixClient, type Ticker } from '@bot/bitunix';
import { CORE_SYMBOLS } from '@bot/signals';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';

export interface ScanDeps {
  client: BitunixClient;
  db: Db;
  config: WorkerConfig;
  log: Logger;
}

/**
 * Not crypto (owner, 2026-09-28): stock, ETF and commodity tokens Bitunix lists
 * as USDT perps. They have little history and trade on stock-market hours, and
 * they crowded the most-liquid list (the 4H backtest fell from +25.5% to +6.5%
 * when they joined). Gold (XAU / XAUT) stays in. Bitunix doesn't mark asset
 * type, so this is a list: add new listings here.
 */
export const NON_CRYPTO_BASES: ReadonlySet<string> = new Set([
  // Stocks and pre-IPO tokens.
  'NVDA', 'INTC', 'MU', 'SAMSUNG', 'SKHY', 'SKHYNIX', 'SNDK', 'MSTR', 'CRCL', 'SPCX', 'TSLA', 'AAPL', 'AMZN', 'GOOGL', 'GOOG',
  'META', 'MSFT', 'NFLX', 'AMD', 'COIN', 'HOOD', 'PLTR', 'ORCL', 'AVGO', 'TSM', 'BABA', 'GME', 'AMC', 'CIRCLE', 'OPENAI',
  'WDC', 'AAOI', 'BMNR', 'STRC', 'STXX',
  // ETFs and leveraged ETFs.
  'SPY', 'QQQ', 'SOXL', 'SOXS', 'KORU', 'SNXX', 'TQQQ', 'SQQQ', 'IWM', 'ARKK', 'MUU',
  // Commodities other than gold.
  'XAG', 'XAGT', 'CL', 'BZ', 'WTI', 'BRENT', 'NATGAS', 'NG', 'XPT', 'XPD', 'COPPER', 'HG',
]);
export const isNonCrypto = (symbol: string): boolean => NON_CRYPTO_BASES.has(symbol.replace(/USDT$/, ''));

/**
 * Core symbols always; with universe 'all', plus USDT perps with enough
 * 24h volume, most liquid first, up to maxExtraSymbols. Stock, ETF and
 * non-gold commodity tokens are left out (NON_CRYPTO_BASES).
 */
export function selectUniverse(
  tickers: ReadonlyArray<Ticker>,
  config: Pick<WorkerConfig, 'universe' | 'minQuoteVolume24h' | 'maxExtraSymbols'>,
  /** Symbols Bitunix lets the API trade; when given, extras must be in it. */
  tradable?: ReadonlySet<string>,
): string[] {
  const core = [...CORE_SYMBOLS];
  if (config.universe === 'core') return core;
  const extras = tickers
    .filter((t) => t.symbol.endsWith('USDT') && !core.includes(t.symbol) && !isNonCrypto(t.symbol))
    .filter((t) => !tradable || tradable.has(t.symbol))
    .filter((t) => t.quoteVolume24h != null && t.quoteVolume24h >= config.minQuoteVolume24h)
    .sort((a, b) => b.quoteVolume24h! - a.quoteVolume24h! || a.symbol.localeCompare(b.symbol))
    .slice(0, config.maxExtraSymbols)
    .map((t) => t.symbol);
  return [...core, ...extras];
}

/** Pairs Bitunix allows API trading on (isApiSupported not false), or undefined if the list is unavailable. */
export async function apiTradable(client: BitunixClient): Promise<Set<string> | undefined> {
  try {
    const pairs = await fetchTradingPairs(client);
    // An empty list means "unknown", not "nothing is tradable".
    return pairs.length ? new Set(pairs.filter((p) => p.apiSupported !== false).map((p) => p.symbol)) : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveUniverse(deps: ScanDeps): Promise<string[]> {
  if (deps.config.universe === 'core') return [...CORE_SYMBOLS];
  try {
    const symbols = selectUniverse(await fetchTickers(deps.client), deps.config, await apiTradable(deps.client));
    if (symbols.length === CORE_SYMBOLS.length) deps.log.warn('universe: no extra symbols passed the volume filter', {});
    return symbols;
  } catch (err) {
    deps.log.error('universe: tickers failed, scanning core symbols only', { error: (err as Error).message });
    return [...CORE_SYMBOLS];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The RSI models' coin list, "sticky" (owner 2026-10-07): a coin joins at the join floor and only leaves after its 24h
// volume has stayed under the stay floor for STICKY_DAYS in a row (or it is delisted / no longer API-tradable), so a
// coin hovering around the line keeps its place and its setups. The state is kept in the database between restarts.
export const STICKY_KEY = 'scan-sticky';
export const STICKY_STAY_VOLUME = 200_000, STICKY_DAYS = 3;
export type StickyState = Record<string, { lowSince: number | null }>;

/** The list (joiners most liquid first, then kept coins) and the new state. Pure. */
export function stickyList(
  tickers: ReadonlyArray<Ticker>, tradable: ReadonlySet<string> | undefined, prev: StickyState, now: number,
  opts: { joinVolume: number; maxExtra: number; stayVolume?: number; days?: number },
): { list: string[]; state: StickyState } {
  const stay = opts.stayVolume ?? STICKY_STAY_VOLUME, days = opts.days ?? STICKY_DAYS;
  const joined = selectUniverse(tickers, { universe: 'all', minQuoteVolume24h: opts.joinVolume, maxExtraSymbols: opts.maxExtra }, tradable);
  const vol = new Map(tickers.map((t) => [t.symbol, t.quoteVolume24h ?? 0]));
  const state: StickyState = {};
  for (const s of joined) state[s] = { lowSince: null };
  const kept: string[] = [];
  for (const [s, x] of Object.entries(prev)) {
    if (state[s] || !vol.has(s) || isNonCrypto(s) || (tradable && !tradable.has(s))) continue; // on the list anyway, or gone
    const lowSince = vol.get(s)! >= stay ? null : (x.lowSince ?? now);
    if (lowSince != null && now - lowSince >= days * 86_400_000) continue; // quiet for STICKY_DAYS: leaves
    state[s] = { lowSince };
    kept.push(s);
  }
  return { list: [...joined, ...kept], state };
}

/** The sticky list now (state loaded and saved in the database); core only if the tickers fail. */
export async function resolveStickyUniverse(deps: ScanDeps, opts: { joinVolume: number; maxExtra: number }, now = Date.now()): Promise<string[]> {
  if (deps.config.universe === 'core') return [...CORE_SYMBOLS];
  try {
    const prev = (await loadSnapshot<StickyState>(deps.db, STICKY_KEY)) ?? {};
    const { list, state } = stickyList(await fetchTickers(deps.client), await apiTradable(deps.client), prev, now, opts);
    await saveSnapshot(deps.db, STICKY_KEY, state);
    return list;
  } catch (err) {
    deps.log.error('universe: tickers failed, scanning core symbols only', { error: (err as Error).message });
    return [...CORE_SYMBOLS];
  }
}
