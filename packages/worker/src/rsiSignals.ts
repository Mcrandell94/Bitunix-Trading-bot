// The RSI models' signals (owner 2026-10-03), shown on the dashboard and traded live by rsiLive.ts for the models
// switched on there. Every model scans the same list: core plus every API-tradable crypto USDT perp with $0.5M+ 24h
// volume, up to RSI_MAX_COINS extras (owner 2026-10-06). Candles live in the worker's memory (candleMemory.ts); a coin is
// only checked once its history is downloaded. After each 4H close the framework models run on the ready coins
// (@bot/backtest rsiFrameworkSignals); after every 15m close 15M-RSI10 does (rsi10LiveSignals). Both save their rows in
// the 'rsi-signals' snapshot. A coin not checked this time (still downloading, or its fetch failed) keeps its previous
// rows, except "enter" rows: an old entry signal must never look like a fresh one.

import { rsi10LiveSignals, rsiFrameworkSignals, type RsiSignalRow } from '@bot/backtest';
import type { BitunixClient } from '@bot/bitunix';
import type { Candle } from '@bot/marketdata';
import { loadSnapshot, openBotPositions, pruneCandles, saveSnapshot, type Db } from '@bot/store';
import { HISTORY_DAYS, TFS, candles, isReady, memoryStats, setWanted, update } from './candleMemory';
import type { Logger } from './log';

export const RSI_SIGNALS_KEY = 'rsi-signals';
const DAY = 86_400_000;
const BTC = 'BTCUSDT', BTC_HISTORY_DAYS = 120; // enough for the 50-day SMA (BTC filter on shorts)
/** The scan list (owner 2026-10-06: "Reduce volume requirements to 0.5mil", then the same for every model). */
export const RSI_MIN_VOLUME = 500_000, RSI_MAX_COINS = 300;
export const RSI10_MODEL = '15m-rsi10';
/** 15M-RSI10 gets the 4H / daily history it ran with (400 days); the framework models get all of it. */
const RSI10_SLOW_DAYS = 400;

/**
 * `time` = the 4H close of the framework refresh, `coins` = coins it checked; `fastTime` / `fastCoins` = the same for
 * the last 15M-RSI10 refresh (its rows are merged in); `loading` = coins downloaded of those wanted.
 */
export interface RsiSignalsSnapshot { time: number; coins: number; rows: RsiSignalRow[]; fastTime?: number; fastCoins?: number; loading?: { ready: number; wanted: number } }

export interface RsiSignalsDeps { client: BitunixClient; db: Db; log: Logger }

/** The last 4H close at or before `now`. */
export const last4hClose = (now: number) => Math.floor(now / (4 * 3_600_000)) * 4 * 3_600_000;
const M15 = 15 * 60_000;
export const last15mClose = (now: number) => Math.floor(now / M15) * M15;

/** Rows kept for coins not checked this time: everything but entry signals. */
const carried = (rows: ReadonlyArray<RsiSignalRow>, checked: ReadonlySet<string>) => rows.filter((r) => !checked.has(r.symbol) && r.status !== 'enter');

/**
 * Sets the coins the models want, in download order: BTC, coins the bot holds, coins with rows, then the list (most
 * liquid first). Returns that order.
 */
export async function wantCoins(deps: { db: Db }, list: ReadonlyArray<string>): Promise<string[]> {
  const held = (await openBotPositions(deps.db)).map((p) => p.symbol);
  const rows = (await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY))?.rows.map((r) => r.symbol) ?? [];
  const order = [...new Set([BTC, ...held, ...rows, ...list])];
  setWanted(order);
  return order;
}

// Candles the earlier versions kept in Postgres are deleted once per start (then VACUUM, so the space is reused).
let dbCleaned = false;
export const resetDbCleaned = () => { dbCleaned = false; };
export async function cleanCandleTables(deps: { db: Db; log: Logger }): Promise<void> {
  if (dbCleaned) return;
  dbCleaned = true;
  let n = 0;
  for (const tf of TFS) n += await pruneCandles(deps.db, tf, Number.MAX_SAFE_INTEGER);
  if (n) {
    await deps.db.query('vacuum candles');
    deps.log.info('candles: removed from the database (kept in memory now)', { rows: n });
  }
}

/** BTC's closed daily candles for the BTC filter on shorts (empty while BTC is not downloaded: no short is shown). */
function btcDaily(to: number): Candle[] {
  return candles(BTC, '1d', to - BTC_HISTORY_DAYS * DAY, to);
}

/** One framework refresh at the last 4H close for the ready coins of `symbols`. Returns the snapshot it saved. */
export async function refreshRsiSignals(deps: RsiSignalsDeps, now: number, symbols: ReadonlyArray<string>): Promise<RsiSignalsSnapshot> {
  const to = last4hClose(now);
  const rows: RsiSignalRow[] = [];
  const checked = new Set<string>();
  if (isReady(BTC)) {
    try { await update(deps.client, BTC, ['1d'], to); } catch (err) { deps.log.warn('rsi signals: BTC daily failed', { error: (err as Error).message }); }
  } else deps.log.warn('rsi signals: BTC not downloaded yet, shorts held back', {});
  const btcD1 = btcDaily(to);
  for (const symbol of symbols.filter(isReady)) {
    try {
      await update(deps.client, symbol, ['4h', '1d'], to);
      const d1 = candles(symbol, '1d', to - HISTORY_DAYS['1d'] * DAY, to), h4 = candles(symbol, '4h', to - HISTORY_DAYS['4h'] * DAY, to);
      rows.push(...rsiFrameworkSignals(symbol, d1, h4, to, 14, btcD1));
      checked.add(symbol);
    } catch (err) {
      deps.log.warn('rsi signals: coin failed', { symbol, error: (err as Error).message });
    }
  }
  const prev = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
  const prevRows = prev?.rows ?? [];
  const fast = prevRows.filter((r) => r.model === RSI10_MODEL); // 15M-RSI10's rows stay until its own refresh (right after this one)
  const kept = carried(prevRows.filter((r) => r.model !== RSI10_MODEL), checked);
  const snap: RsiSignalsSnapshot = {
    time: to, coins: checked.size, rows: [...rows, ...kept, ...fast], loading: memoryStats(),
    ...(prev?.fastTime != null ? { fastTime: prev.fastTime, fastCoins: prev.fastCoins } : {}),
  };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, snap);
  deps.log.info('rsi signals: refreshed', {
    at: new Date(to).toISOString(), coins: checked.size, of: symbols.length,
    waiting: rows.filter((r) => r.status === 'waiting').length, enter: rows.filter((r) => r.status === 'enter').length,
    open: rows.filter((r) => r.status === 'open').length, closed: rows.filter((r) => r.status === 'closed').length,
  });
  return snap;
}

/** One 15M-RSI10 refresh at the last 15m close for the ready coins of `symbols`; its rows replace the model's rows. */
export async function refreshRsi10Signals(deps: RsiSignalsDeps, now: number, symbols: ReadonlyArray<string>, snap: RsiSignalsSnapshot | null): Promise<RsiSignalsSnapshot | null> {
  const to = last15mClose(now);
  if (!snap || snap.fastTime === to) return snap;
  const btcD1 = btcDaily(to);
  const rows: RsiSignalRow[] = [];
  const checked = new Set<string>();
  for (const symbol of symbols.filter(isReady)) {
    try {
      await update(deps.client, symbol, TFS, to);
      const slow = to - RSI10_SLOW_DAYS * DAY;
      rows.push(...rsi10LiveSignals(symbol, candles(symbol, '1d', slow, to), candles(symbol, '4h', slow, to),
        candles(symbol, '1h', to - HISTORY_DAYS['1h'] * DAY, to), candles(symbol, '15m', to - HISTORY_DAYS['15m'] * DAY, to), to, 14, btcD1));
      checked.add(symbol);
    } catch (err) {
      deps.log.warn('rsi10 signals: coin failed', { symbol, error: (err as Error).message });
    }
  }
  const prev = snap.rows.filter((r) => r.model === RSI10_MODEL);
  const out: RsiSignalsSnapshot = {
    ...snap, rows: [...snap.rows.filter((r) => r.model !== RSI10_MODEL), ...rows, ...carried(prev, checked)],
    fastTime: to, fastCoins: checked.size, loading: memoryStats(),
  };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, out);
  const enter = rows.filter((r) => r.status === 'enter').length, open = rows.filter((r) => r.status === 'open').length;
  if (enter || open) deps.log.info('rsi10 signals: refreshed', { at: new Date(to).toISOString(), coins: checked.size, enter, open, closed: rows.filter((r) => r.status === 'closed').length });
  return out;
}

/** The latest snapshot, refreshed first when a 4H bar has closed since it was taken. */
export async function currentRsiSignals(deps: RsiSignalsDeps, now: number, coins: () => Promise<ReadonlyArray<string>>): Promise<RsiSignalsSnapshot> {
  const snap = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
  if (snap && snap.time >= last4hClose(now)) return snap;
  return refreshRsiSignals(deps, now, await coins());
}
