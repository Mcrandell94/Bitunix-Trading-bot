// The RSI framework's signals (owner 2026-10-03), shown on the dashboard and traded live by rsiLive.ts for the
// models switched on there. After each 4H close the worker brings ~3 years of daily and 4H candles up to date for
// the coin list (the first run backfills them; later runs fetch only the new bars), runs the framework's models on
// them (@bot/backtest rsiFrameworkSignals) and saves the rows as the 'rsi-signals' snapshot.

import { rsi10LiveSignals, rsiFrameworkSignals, type RsiSignalRow } from '@bot/backtest';
import { fetchCandles, type BitunixClient, type Interval } from '@bot/bitunix';
import { closedOnly, intervalMs, type Candle, type IntervalName } from '@bot/marketdata';
import { loadCandles, loadSnapshot, openBotPositions, pruneCandles, saveSnapshot, upsertCandles, type Db } from '@bot/store';
import type { Logger } from './log';

export const RSI_SIGNALS_KEY = 'rsi-signals';
const DAY = 86_400_000;
/** History the models need: weekly RSI and the per-coin 4H RSI floor were tested on ~3 years. */
export const RSI_HISTORY_DAYS: Record<'1d' | '4h', number> = { '1d': 1100, '4h': 1095 };
const BTC = 'BTCUSDT', BTC_HISTORY_DAYS = 120; // enough for the 50-day SMA

/** `time` = the 4H close of the framework refresh; `fastTime` = the 15m close of the last 15M-RSI10 refresh (its rows are merged in). */
export interface RsiSignalsSnapshot { time: number; coins: number; rows: RsiSignalRow[]; fastTime?: number; /** Coins 15M-RSI10 checked at fastTime. */ fastCoins?: number }

export interface RsiSignalsDeps { client: BitunixClient; db: Db; log: Logger }

/** The last 4H close at or before `now`. */
export const last4hClose = (now: number) => Math.floor(now / (4 * 3_600_000)) * 4 * 3_600_000;

/** Fills [from, to) for one coin and timeframe: the older history once, then only the new bars. */
async function syncRange(deps: RsiSignalsDeps, symbol: string, tf: IntervalName, from: number, to: number): Promise<void> {
  const ms = intervalMs(tf);
  const start = Math.floor(from / ms) * ms;
  const have = (await loadCandles(deps.db, tf, [symbol], start))[symbol] ?? [];
  const ranges: [number, number][] = have.length
    ? [[start, have[0]!.openTime], [have.at(-1)!.openTime + ms, to]]
    : [[start, to]];
  for (const [a, b] of ranges) {
    if (b - a < ms) continue;
    const candles = closedOnly(await fetchCandles(deps.client, { symbol, interval: tf as Interval, from: a, to: b, type: 'LAST_PRICE' }), tf, to);
    if (candles.length) await upsertCandles(deps.db, symbol, tf, candles);
  }
}

/**
 * One full refresh at `now` for `symbols`, plus every coin the bot holds a position on (its trade keeps being
 * followed even if the coin drops out of the list). Returns the snapshot it saved.
 */
export async function refreshRsiSignals(deps: RsiSignalsDeps, now: number, list: ReadonlyArray<string>): Promise<RsiSignalsSnapshot> {
  const symbols = [...new Set([...list, ...(await openBotPositions(deps.db)).map((p) => p.symbol)])];
  const to = last4hClose(now);
  const rows: RsiSignalRow[] = [];
  let coins = 0;
  // BTC's daily candles for the BTC filter on shorts (owner 2026-10-04). Without them no short is shown.
  let btcD1: Candle[] = [];
  try {
    await syncRange(deps, BTC, '1d', to - BTC_HISTORY_DAYS * DAY, to);
    btcD1 = ((await loadCandles(deps.db, '1d', [BTC], to - BTC_HISTORY_DAYS * DAY))[BTC] ?? []).filter((c) => c.openTime + DAY <= to);
  } catch (err) {
    deps.log.warn('rsi signals: BTC daily failed, shorts held back', { error: (err as Error).message });
  }
  for (const symbol of symbols) {
    try {
      for (const tf of ['1d', '4h'] as const) await syncRange(deps, symbol, tf, to - RSI_HISTORY_DAYS[tf] * DAY, to);
      const d1 = ((await loadCandles(deps.db, '1d', [symbol], to - RSI_HISTORY_DAYS['1d'] * DAY))[symbol] ?? []).filter((c) => c.openTime + DAY <= to);
      const h4 = ((await loadCandles(deps.db, '4h', [symbol], to - RSI_HISTORY_DAYS['4h'] * DAY))[symbol] ?? []).filter((c) => c.openTime + 4 * 3_600_000 <= to);
      rows.push(...rsiFrameworkSignals(symbol, d1, h4, to, 14, btcD1));
      coins++;
    } catch (err) {
      deps.log.warn('rsi signals: coin failed', { symbol, error: (err as Error).message });
    }
  }
  // The 15M-RSI10 rows of the last 15m refresh stay until that refresh runs again (right after this one, in the same wake-up).
  const prev = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
  const fast = prev?.rows.filter((r) => r.model === RSI10_MODEL) ?? [];
  const snap: RsiSignalsSnapshot = { time: to, coins, rows: [...rows, ...fast], ...(prev?.fastTime != null ? { fastTime: prev.fastTime, fastCoins: prev.fastCoins } : {}) };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, snap);
  deps.log.info('rsi signals: refreshed', {
    at: new Date(to).toISOString(), coins,
    waiting: rows.filter((r) => r.status === 'waiting').length, enter: rows.filter((r) => r.status === 'enter').length,
    open: rows.filter((r) => r.status === 'open').length, closed: rows.filter((r) => r.status === 'closed').length,
  });
  return snap;
}

// ---------------------------------------------------------------------------------------------------------------
// 15M-RSI10 (owner 2026-10-06): a 15m model, refreshed after every 15m close on its own wider coin list (every API-tradable
// crypto USDT perp with $0.5M+ 24h volume, owner: "Reduce volume requirements to 0.5mil"). Its candles are kept in the
// worker's memory, not the database (the Postgres volume is 500 MB): the first wake-ups after a start download
// RSI10_NEW_PER_WAKE coins each, then each wake-up fetches only the bars that closed since. Its rows replace the model's rows
// in the snapshot; a coin not evaluated this time (not downloaded yet, or failed) keeps its previous rows.
export const RSI10_MODEL = '15m-rsi10';
type Tf = '15m' | '1h' | '4h' | '1d';
const TFS: readonly Tf[] = ['15m', '1h', '4h', '1d'];
export const RSI10_HISTORY_DAYS: Record<Tf, number> = { '15m': 75, '1h': 75, '4h': 400, '1d': 400 };
export const RSI10_MIN_VOLUME = 500_000, RSI10_MAX_COINS = 300, RSI10_NEW_PER_WAKE = 25;
const M15 = 15 * 60_000;
export const last15mClose = (now: number) => Math.floor(now / M15) * M15;

/**
 * symbol -> timeframe -> closed candles, oldest first, packed 6 numbers per candle (openTime, open, high, low, close,
 * volume; NaN = no volume): ~48 bytes a candle instead of ~180 as objects, so 300 coins fit in ~170 MB. Module state:
 * rebuilt after a restart.
 */
const memory = new Map<string, Partial<Record<Tf, Float64Array>>>();
const pack = (cs: ReadonlyArray<Candle>): Float64Array => {
  const a = new Float64Array(cs.length * 6);
  cs.forEach((c, i) => a.set([c.openTime, c.open, c.high, c.low, c.close, c.volume ?? NaN], i * 6));
  return a;
};
const unpack = (a: Float64Array | undefined): Candle[] => {
  const out: Candle[] = [];
  if (a) for (let i = 0; i < a.length; i += 6) out.push({ openTime: a[i]!, open: a[i + 1]!, high: a[i + 2]!, low: a[i + 3]!, close: a[i + 4]!, volume: Number.isNaN(a[i + 5]!) ? null : a[i + 5]! });
  return out;
};
export const rsi10Memory = () => ({ coins: memory.size, candles: [...memory.values()].reduce((n, x) => n + TFS.reduce((k, tf) => k + (x[tf]?.length ?? 0) / 6, 0), 0) });
export const resetRsi10Memory = () => { memory.clear(); dbCleaned = false; };

/** Brings one coin's candles up to `to` in memory and drops the ones older than the history kept. */
async function syncMemory(deps: RsiSignalsDeps, symbol: string, tf: Tf, to: number): Promise<Candle[]> {
  const ms = intervalMs(tf), start = Math.floor((to - RSI10_HISTORY_DAYS[tf] * DAY) / ms) * ms;
  const per = memory.get(symbol) ?? {};
  let have = unpack(per[tf]).filter((c) => c.openTime >= start);
  const from = have.length ? have.at(-1)!.openTime + ms : start;
  if (to - from >= ms) {
    const add = closedOnly(await fetchCandles(deps.client, { symbol, interval: tf as Interval, from, to, type: 'LAST_PRICE' }), tf, to);
    have = [...have, ...add.filter((c) => c.openTime >= from)];
  }
  per[tf] = pack(have);
  memory.set(symbol, per);
  return have;
}

// The 15m / 1h candles the first version kept in the database are deleted once per start (then VACUUM, so the space is reused).
let dbCleaned = false;
async function cleanDb(deps: RsiSignalsDeps): Promise<void> {
  if (dbCleaned) return;
  dbCleaned = true;
  let n = 0;
  for (const tf of ['15m', '1h'] as const) n += await pruneCandles(deps.db, tf, Number.MAX_SAFE_INTEGER);
  if (n) {
    await deps.db.query('vacuum candles');
    deps.log.info('rsi10: 15m / 1h candles removed from the database (kept in memory now)', { rows: n });
  }
}

export async function refreshRsi10Signals(deps: RsiSignalsDeps, now: number, list: ReadonlyArray<string>, snap: RsiSignalsSnapshot | null): Promise<RsiSignalsSnapshot | null> {
  const to = last15mClose(now);
  if (!snap || snap.fastTime === to) return snap;
  try {
    await cleanDb(deps);
  } catch (err) {
    deps.log.warn('rsi10: removing old candles failed', { error: (err as Error).message });
  }
  const prev = snap.rows.filter((r) => r.model === RSI10_MODEL);
  const held = new Set([...(await openBotPositions(deps.db)).map((p) => p.symbol), ...prev.map((r) => r.symbol)]);
  const symbols = [...new Set([...held, ...list])];
  for (const s of memory.keys()) if (!symbols.includes(s)) memory.delete(s); // dropped off the list: free its candles
  // Coins already in memory first; then up to RSI10_NEW_PER_WAKE new ones (coins the bot holds or had rows for go first).
  const ready = symbols.filter((s) => memory.has(s));
  const fresh = symbols.filter((s) => !memory.has(s)).slice(0, RSI10_NEW_PER_WAKE);
  const btcD1 = ((await loadCandles(deps.db, '1d', [BTC], to - BTC_HISTORY_DAYS * DAY))[BTC] ?? []).filter((c) => c.openTime + DAY <= to);
  const rows: RsiSignalRow[] = [];
  const done = new Set<string>();
  for (const symbol of [...ready, ...fresh]) {
    try {
      const got = {} as Record<Tf, Candle[]>;
      for (const tf of TFS) got[tf] = await syncMemory(deps, symbol, tf, to);
      rows.push(...rsi10LiveSignals(symbol, got['1d'], got['4h'], got['1h'], got['15m'], to, 14, btcD1));
      done.add(symbol);
    } catch (err) {
      deps.log.warn('rsi10 signals: coin failed', { symbol, error: (err as Error).message });
    }
  }
  const kept = prev.filter((r) => !done.has(r.symbol));
  const out: RsiSignalsSnapshot = { ...snap, rows: [...snap.rows.filter((r) => r.model !== RSI10_MODEL), ...rows, ...kept], fastTime: to, fastCoins: done.size };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, out);
  const waiting = symbols.length - memory.size;
  if (fresh.length) deps.log.info('rsi10: coins downloaded', { added: fresh.length, inMemory: memory.size, of: symbols.length, left: Math.max(0, waiting) });
  const enter = rows.filter((r) => r.status === 'enter').length, open = rows.filter((r) => r.status === 'open').length;
  if (enter || open) deps.log.info('rsi10 signals: refreshed', { at: new Date(to).toISOString(), coins: done.size, enter, open, closed: rows.filter((r) => r.status === 'closed').length });
  return out;
}

/** The latest snapshot, refreshed first when a 4H bar has closed since it was taken. */
export async function currentRsiSignals(deps: RsiSignalsDeps, now: number, coins: () => Promise<ReadonlyArray<string>>): Promise<RsiSignalsSnapshot> {
  const snap = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
  if (snap && snap.time >= last4hClose(now)) return snap;
  return refreshRsiSignals(deps, now, await coins());
}
