// Downloads backtest data from Bitunix into a local cache folder (JSON
// files), so reruns only fetch what's new. No database needed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchCandles, fetchFundingHistory, fetchTradingPairs, type BitunixClient, type KlineType,
} from '@bot/bitunix';
import { closedOnly, intervalMs, type Candle } from '@bot/marketdata';
import type { FundingPoint, SymbolData, Tf } from './types';

interface CacheFile<T> { coveredFrom: number; coveredTo: number; rows: T[] }

function readCache<T>(path: string): CacheFile<T> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheFile<T>;
  } catch {
    return null;
  }
}

/** Rows for [from, to): cached ranges reused, missing head/tail fetched and merged. */
async function cached<T extends object>(
  path: string, from: number, to: number, key: (r: T) => number, fetch: (from: number, to: number) => Promise<T[]>,
): Promise<T[]> {
  const c = readCache<T>(path);
  let rows = c?.rows ?? [];
  let coveredFrom = c?.coveredFrom ?? to;
  let coveredTo = c?.coveredTo ?? to;
  if (!c) {
    rows = await fetch(from, to);
    coveredFrom = from;
    coveredTo = to;
  } else {
    if (from < coveredFrom) { rows = [...(await fetch(from, coveredFrom)), ...rows]; coveredFrom = from; }
    if (to > coveredTo) { rows = [...rows, ...(await fetch(coveredTo, to))]; coveredTo = to; }
  }
  const byKey = new Map(rows.map((r) => [key(r), r]));
  rows = [...byKey.values()].sort((a, b) => key(a) - key(b));
  writeFileSync(path, JSON.stringify({ coveredFrom, coveredTo, rows }));
  return rows.filter((r) => key(r) >= from && key(r) < to);
}

/** Warm-up before `from` per timeframe: RRG needs 120 bars, bias needs structure. */
export const WARMUP_DAYS: Record<Tf, number> = { '15m': 3, '1h': 10, '4h': 30, '1d': 140 };

export interface LoadOptions {
  client: BitunixClient;
  cacheDir: string;
  symbols: string[];
  from: number;
  to: number;
  log?: (msg: string) => void;
  /** Load only these timeframes, with no mark-price candles or funding (research studies that need no fills). */
  onlyTfs?: Tf[];
}

export async function loadMarket(o: LoadOptions): Promise<{ data: Record<string, SymbolData>; notes: string[] }> {
  mkdirSync(o.cacheDir, { recursive: true });
  const log = o.log ?? (() => {});
  const notes: string[] = [];
  const DAY = 86_400_000;

  const specs = await fetchTradingPairs(o.client).catch((err: Error) => {
    notes.push(`trading pairs unavailable (${err.message}): quantities not rounded to exchange steps`);
    return [];
  });

  const data: Record<string, SymbolData> = {};
  for (const [n, symbol] of o.symbols.entries()) {
    log(`[${n + 1}/${o.symbols.length}] ${symbol}`);
    const candles: Partial<Record<Tf, Candle[]>> = {};
    const get = async (tf: Tf, type: KlineType) => {
      const from = Math.floor((o.from - WARMUP_DAYS[tf] * DAY) / intervalMs(tf)) * intervalMs(tf);
      const rows = await cached<Candle>(
        join(o.cacheDir, `${symbol}_${type}_${tf}.json`), from, o.to, (c) => c.openTime,
        (a, b) => fetchCandles(o.client, { symbol, interval: tf, from: a, to: b, type }),
      );
      return closedOnly(rows, tf, o.to);
    };
    try {
      for (const tf of o.onlyTfs ?? (['15m', '1h', '4h', '1d'] as Tf[])) candles[tf] = await get(tf, 'LAST_PRICE');
    } catch (err) {
      // BTC and ETH are the benchmarks: without them there is no backtest.
      if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') throw new Error(`${symbol}: ${(err as Error).message}`);
      notes.push(`${symbol}: skipped, candles unavailable (${(err as Error).message})`);
      log(`  skipped: ${(err as Error).message}`);
      continue;
    }
    if (o.onlyTfs) { data[symbol] = { candles }; continue; }
    let mark15m: Candle[] = [];
    try {
      mark15m = await get('15m', 'MARK_PRICE');
    } catch (err) {
      notes.push(`${symbol}: mark-price candles unavailable (${(err as Error).message}); stops use last price`);
    }

    let funding: FundingPoint[] | undefined;
    try {
      funding = await cached<FundingPoint>(join(o.cacheDir, `${symbol}_funding_v2.json`), o.from - 3 * DAY, o.to, (f) => f.time,
        (a, b) => fetchFundingHistory(o.client, symbol, a, b));
      if (funding.length === 0) funding = undefined;
    } catch (err) {
      notes.push(`${symbol}: funding history unavailable (${(err as Error).message})`);
    }

    const spec = specs.find((s) => s.symbol === symbol);
    const step = spec?.basePrecision != null ? 10 ** -spec.basePrecision : null;
    const gaps = funding && funding.length > 1 ? funding.slice(1).map((f, i) => f.time - funding![i]!.time) : [];
    const typical = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! / 3_600_000 : undefined;
    data[symbol] = {
      candles,
      mark15m: mark15m.length ? mark15m : undefined,
      funding,
      fundingIntervalHours: typical,
      limits: step ? { qtyStep: step, minQty: spec?.minTradeVolume ?? step, priceTick: spec?.quotePrecision != null ? 10 ** -spec.quotePrecision : undefined } : undefined,
    };
  }
  return { data, notes };
}

/** Funding settlements for one coin over [from, to), cached like the candles (research studies that load no fills). */
export async function loadFunding(client: BitunixClient, cacheDir: string, symbol: string, from: number, to: number): Promise<FundingPoint[]> {
  mkdirSync(cacheDir, { recursive: true });
  return cached<FundingPoint>(join(cacheDir, `${symbol}_funding_v2.json`), from, to, (f) => f.time, (a, b) => fetchFundingHistory(client, symbol, a, b));
}
