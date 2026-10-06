// Candles for the RSI models, kept in the worker's memory instead of Postgres (owner 2026-10-06: every model scans every
// crypto USDT perp with $0.5M+ daily volume, up to ~300 coins; the database volume is 500 MB). Each coin's candles are
// packed 6 numbers per candle (openTime, open, high, low, close, volume; NaN = no volume), ~48 bytes a candle, so ~300
// coins with 3 years of 4H / daily and 75 days of 1h / 15m take ~240 MB.
//
// A coin is "ready" once all four timeframes are downloaded; until then no model looks at it. After a start, a
// background task (backfillLoop) downloads the wanted coins one at a time in list order (the wake-up puts BTC, coins
// with open trades or rows, then the most liquid first); its requests share the client's throttle with the wake-ups'.
// Ready coins are brought up to date by the wake-ups, which fetch only the bars that closed since.

import { fetchCandles, type BitunixClient, type Interval } from '@bot/bitunix';
import { closedOnly, intervalMs, type Candle } from '@bot/marketdata';
import type { Logger } from './log';

export type Tf = '15m' | '1h' | '4h' | '1d';
export const TFS: readonly Tf[] = ['15m', '1h', '4h', '1d'];
const DAY = 86_400_000;
/** History kept per timeframe: the framework models were tested on ~3 years of 4H / daily; 15M-RSI10 needs 75 days of 15m / 1h. */
export const HISTORY_DAYS: Record<Tf, number> = { '15m': 75, '1h': 75, '4h': 1095, '1d': 1100 };

const store = new Map<string, Record<Tf, Float64Array>>();
let wanted: string[] = [];
const failedAt = new Map<string, number>();
const RETRY_FAILED_MS = 30 * 60_000;

const pack = (cs: ReadonlyArray<Candle>): Float64Array => {
  const a = new Float64Array(cs.length * 6);
  cs.forEach((c, i) => a.set([c.openTime, c.open, c.high, c.low, c.close, c.volume ?? NaN], i * 6));
  return a;
};
/** First candle index with openTime >= t. */
const firstAt = (a: Float64Array, t: number): number => {
  let lo = 0, hi = a.length / 6;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m * 6]! < t) lo = m + 1; else hi = m; }
  return lo;
};

/** The coins the models want, in download order (set by each wake-up). */
export const setWanted = (list: ReadonlyArray<string>) => { wanted = [...new Set(list)]; for (const s of store.keys()) if (!wanted.includes(s)) store.delete(s); };
export const isReady = (symbol: string) => store.has(symbol);
export const memoryStats = () => ({
  ready: store.size, wanted: wanted.length,
  candles: [...store.values()].reduce((n, x) => n + TFS.reduce((k, tf) => k + x[tf].length / 6, 0), 0),
});
export const resetMemory = () => { store.clear(); wanted = []; failedAt.clear(); };

/** One coin's closed candles for `tf` that opened at or after `from` and closed by `to`, oldest first. */
export function candles(symbol: string, tf: Tf, from: number, to: number): Candle[] {
  const a = store.get(symbol)?.[tf];
  if (!a) return [];
  const ms = intervalMs(tf), out: Candle[] = [];
  for (let i = firstAt(a, from) * 6; i < a.length && a[i]! + ms <= to; i += 6) {
    out.push({ openTime: a[i]!, open: a[i + 1]!, high: a[i + 2]!, low: a[i + 3]!, close: a[i + 4]!, volume: Number.isNaN(a[i + 5]!) ? null : a[i + 5]! });
  }
  return out;
}

/** `have` trimmed to the history kept and extended with the bars that closed by `to`. */
async function extend(client: BitunixClient, symbol: string, tf: Tf, have: Float64Array | undefined, to: number): Promise<Float64Array> {
  const ms = intervalMs(tf), start = Math.floor((to - HISTORY_DAYS[tf] * DAY) / ms) * ms;
  let a = have ?? new Float64Array(0);
  const cut = firstAt(a, start);
  if (cut > 0) a = a.slice(cut * 6);
  const from = a.length ? a[a.length - 6]! + ms : start;
  if (to - from < ms) return a;
  const add = closedOnly(await fetchCandles(client, { symbol, interval: tf as Interval, from, to, type: 'LAST_PRICE' }), tf, to).filter((c) => c.openTime >= from);
  if (!add.length) return a;
  const out = new Float64Array(a.length + add.length * 6);
  out.set(a);
  out.set(pack(add), a.length);
  return out;
}

/** Brings a ready coin's timeframes up to `to` (only the bars that closed since are fetched). */
export async function update(client: BitunixClient, symbol: string, tfs: ReadonlyArray<Tf>, to: number): Promise<void> {
  const per = store.get(symbol);
  if (!per) throw new Error(`${symbol} is not downloaded yet`);
  for (const tf of tfs) per[tf] = await extend(client, symbol, tf, per[tf], to);
}

/** Downloads a coin's full history; it becomes ready only once every timeframe is in. */
export async function download(client: BitunixClient, symbol: string, to: number): Promise<void> {
  const per = {} as Record<Tf, Float64Array>;
  for (const tf of TFS) per[tf] = await extend(client, symbol, tf, undefined, to);
  if (wanted.includes(symbol)) store.set(symbol, per);
}

/** The next wanted coin to download, or null (failed coins wait RETRY_FAILED_MS before another try). */
export function nextToDownload(now: number): string | null {
  return wanted.find((s) => !store.has(s) && now - (failedAt.get(s) ?? -Infinity) >= RETRY_FAILED_MS) ?? null;
}

/** Runs until `signal` aborts: downloads wanted coins that are not ready, one at a time. */
export async function backfillLoop(
  deps: { client: BitunixClient; log: Logger }, signal: AbortSignal,
  opts: { now?: () => number; idle?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const idle = opts.idle ?? ((ms, s) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }));
  let done = 0;
  while (!signal.aborted) {
    const symbol = nextToDownload(now());
    if (!symbol) { await idle(60_000, signal); continue; }
    try {
      await download(deps.client, symbol, now());
      failedAt.delete(symbol);
      done++;
      const s = memoryStats();
      if (done % 25 === 0 || s.ready === s.wanted) deps.log.info('candles: coins downloaded', { ready: s.ready, of: s.wanted });
    } catch (err) {
      failedAt.set(symbol, now());
      deps.log.warn('candles: download failed, retried later', { symbol, error: (err as Error).message });
    }
  }
}
