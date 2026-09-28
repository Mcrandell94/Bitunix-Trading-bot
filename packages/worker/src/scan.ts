// One scan: sync closed candles, snapshot funding, align, classify, save.

import {
  fetchCandles, fetchFunding, fetchTickers, fetchTradingPairs, type BitunixClient, type Ticker,
} from '@bot/bitunix';
import { alignSeries, closedOnly, intervalMs, lastClosedOpenTime } from '@bot/marketdata';
import { annualizeFundingRate } from '@bot/rrg';
import { BENCHMARKS, CORE_SYMBOLS, buildWatchlist, type SymbolSeries, type Timeframe, type Watchlist } from '@bot/signals';
import {
  insertFunding, latestFunding, latestOpenTimes, loadCandles, saveScan, upsertCandles, type Db,
} from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';

export interface ScanDeps {
  client: BitunixClient;
  db: Db;
  config: WorkerConfig;
  log: Logger;
}

const BENCH_SYMBOLS = Object.values(BENCHMARKS);

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
  // ETFs and leveraged ETFs.
  'SPY', 'QQQ', 'SOXL', 'SOXS', 'KORU', 'SNXX', 'TQQQ', 'SQQQ', 'IWM', 'ARKK',
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

/** Fetches any closed bars missing from the database. Returns symbols that failed. */
export async function syncCandles(deps: ScanDeps, timeframe: Timeframe, symbols: ReadonlyArray<string>, now: number): Promise<string[]> {
  const ms = intervalMs(timeframe);
  const lastClosed = lastClosedOpenTime(timeframe, now);
  const windowStart = lastClosed - (deps.config.historyBars - 1) * ms;
  const stored = await latestOpenTimes(deps.db, timeframe, symbols);
  const failed: string[] = [];
  for (const symbol of symbols) {
    const have = stored.get(symbol);
    const from = have == null ? windowStart : Math.max(windowStart, have + ms);
    if (from > lastClosed) continue;
    try {
      const candles = closedOnly(await fetchCandles(deps.client, { symbol, interval: timeframe, from, to: lastClosed + ms }), timeframe, now);
      await upsertCandles(deps.db, symbol, timeframe, candles);
    } catch (err) {
      failed.push(symbol);
      deps.log.warn('candles: sync failed', { symbol, timeframe, error: (err as Error).message });
    }
  }
  return failed;
}

/** Stores a funding snapshot. Failure is logged, not fatal: funding only scores. */
export async function syncFunding(deps: ScanDeps, symbols: ReadonlyArray<string>, now: number): Promise<void> {
  try {
    const { items, rejected } = await fetchFunding(deps.client);
    const wanted = new Set(symbols);
    await insertFunding(deps.db, now, items.filter((f) => wanted.has(f.symbol)));
    if (rejected) deps.log.warn('funding: rows rejected by the parser', { rejected });
  } catch (err) {
    deps.log.warn('funding: snapshot failed', { error: (err as Error).message });
  }
}

export interface ScanSummary {
  timeframe: Timeframe;
  barTime: number;
  scanId: number;
  symbolsScanned: number;
  dropped: { symbol: string; reason: string }[];
  watchlist: Watchlist;
}

export class ScanError extends Error {}

/**
 * Scans one timeframe as of `now`. `symbols` and the funding snapshot can
 * be passed in when several timeframes run at the same close.
 */
export async function runScan(deps: ScanDeps, timeframe: Timeframe, now: number, symbols?: ReadonlyArray<string>): Promise<ScanSummary> {
  const universe = symbols ?? await resolveUniverse(deps);
  if (!symbols) await syncFunding(deps, universe, now);
  await syncCandles(deps, timeframe, universe, now);

  const ms = intervalMs(timeframe);
  const barTime = lastClosedOpenTime(timeframe, now);
  const from = barTime - (deps.config.historyBars - 1) * ms;
  const aligned = alignSeries(await loadCandles(deps.db, timeframe, universe, from), timeframe, deps.config.historyBars, now);
  const missingBench = BENCH_SYMBOLS.filter((b) => !aligned.series[b]);
  if (missingBench.length) {
    const why = aligned.dropped.filter((d) => missingBench.includes(d.symbol));
    throw new ScanError(`benchmark data incomplete for ${timeframe}: ${JSON.stringify(why)}`);
  }

  const funding = await latestFunding(deps.db, Object.keys(aligned.series));
  const series: Record<string, SymbolSeries> = {};
  for (const [symbol, s] of Object.entries(aligned.series)) {
    const f = funding.get(symbol);
    const fresh = f && now - f.observedAt <= deps.config.maxFundingAgeMs;
    series[symbol] = {
      close: s.close,
      volume: s.volume,
      fundingAnnualizedPct: fresh ? annualizeFundingRate(f.rate, f.intervalHours) : null,
    };
  }

  const watchlist = buildWatchlist({ timeframe, series });
  const scanId = await saveScan(deps.db, {
    timeframe, barTime, symbolsScanned: Object.keys(series).length, dropped: aligned.dropped, watchlist,
  });
  deps.log.info('scan saved', {
    timeframe, barTime: new Date(barTime).toISOString(), scanId,
    scanned: Object.keys(series).length, dropped: aligned.dropped.length, signals: watchlist.entries.length,
  });
  return { timeframe, barTime, scanId, symbolsScanned: Object.keys(series).length, dropped: aligned.dropped, watchlist };
}
