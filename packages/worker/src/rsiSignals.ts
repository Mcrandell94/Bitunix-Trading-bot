// The RSI framework's signals (owner 2026-10-03), shown on the dashboard and traded live by rsiLive.ts for the
// models switched on there. After each 4H close the worker brings ~3 years of daily and 4H candles up to date for
// the coin list (the first run backfills them; later runs fetch only the new bars), runs the framework's models on
// them (@bot/backtest rsiFrameworkSignals) and saves the rows as the 'rsi-signals' snapshot.

import { rsi10LiveSignals, rsiFrameworkSignals, type RsiSignalRow } from '@bot/backtest';
import { fetchCandles, type BitunixClient, type Interval } from '@bot/bitunix';
import { closedOnly, intervalMs, type Candle, type IntervalName } from '@bot/marketdata';
import { loadCandles, loadSnapshot, openBotPositions, saveSnapshot, upsertCandles, type Db } from '@bot/store';
import type { Logger } from './log';

export const RSI_SIGNALS_KEY = 'rsi-signals';
const DAY = 86_400_000;
/** History the models need: weekly RSI and the per-coin 4H RSI floor were tested on ~3 years. */
export const RSI_HISTORY_DAYS: Record<'1d' | '4h', number> = { '1d': 1100, '4h': 1095 };
const BTC = 'BTCUSDT', BTC_HISTORY_DAYS = 120; // enough for the 50-day SMA

/** `time` = the 4H close of the framework refresh; `fastTime` = the 15m close of the last 15M-RSI10 refresh (its rows are merged in). */
export interface RsiSignalsSnapshot { time: number; coins: number; rows: RsiSignalRow[]; fastTime?: number }

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
  const snap: RsiSignalsSnapshot = { time: to, coins, rows: [...rows, ...fast], ...(prev?.fastTime != null ? { fastTime: prev.fastTime } : {}) };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, snap);
  deps.log.info('rsi signals: refreshed', {
    at: new Date(to).toISOString(), coins,
    waiting: rows.filter((r) => r.status === 'waiting').length, enter: rows.filter((r) => r.status === 'enter').length,
    open: rows.filter((r) => r.status === 'open').length, closed: rows.filter((r) => r.status === 'closed').length,
  });
  return snap;
}

// ---------------------------------------------------------------------------------------------------------------
// 15M-RSI10 (owner 2026-10-06): a 15m model, so it is refreshed after every 15m close, on its own: 15m and 1h candles for
// the coin list are kept up to date (the first run backfills RSI10_HISTORY_DAYS; later runs fetch only the new bars), the
// 4H and daily candles come from the framework refresh above, and its rows replace the model's rows in the snapshot.
export const RSI10_MODEL = '15m-rsi10';
export const RSI10_HISTORY_DAYS: Record<'15m' | '1h' | '4h' | '1d', number> = { '15m': 75, '1h': 75, '4h': 400, '1d': 400 };
const M15 = 15 * 60_000;
export const last15mClose = (now: number) => Math.floor(now / M15) * M15;

export async function refreshRsi10Signals(deps: RsiSignalsDeps, now: number, list: ReadonlyArray<string>, snap: RsiSignalsSnapshot | null): Promise<RsiSignalsSnapshot | null> {
  const to = last15mClose(now);
  if (!snap || snap.fastTime === to) return snap;
  const symbols = [...new Set([...list, ...(await openBotPositions(deps.db)).map((p) => p.symbol)])];
  const btcD1 = ((await loadCandles(deps.db, '1d', [BTC], to - BTC_HISTORY_DAYS * DAY))[BTC] ?? []).filter((c) => c.openTime + DAY <= to);
  const rows: RsiSignalRow[] = [];
  for (const symbol of symbols) {
    try {
      const got: Partial<Record<'15m' | '1h' | '4h' | '1d', Candle[]>> = {};
      for (const tf of ['15m', '1h', '4h', '1d'] as const) {
        const from = to - RSI10_HISTORY_DAYS[tf] * DAY;
        if (tf === '15m' || tf === '1h') await syncRange(deps, symbol, tf, from, to);
        got[tf] = ((await loadCandles(deps.db, tf, [symbol], from))[symbol] ?? []).filter((c) => c.openTime + intervalMs(tf) <= to);
      }
      rows.push(...rsi10LiveSignals(symbol, got['1d']!, got['4h']!, got['1h']!, got['15m']!, to, 14, btcD1));
    } catch (err) {
      deps.log.warn('rsi10 signals: coin failed', { symbol, error: (err as Error).message });
    }
  }
  const out: RsiSignalsSnapshot = { ...snap, rows: [...snap.rows.filter((r) => r.model !== RSI10_MODEL), ...rows], fastTime: to };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, out);
  const enter = rows.filter((r) => r.status === 'enter').length, open = rows.filter((r) => r.status === 'open').length;
  if (enter || open) deps.log.info('rsi10 signals: refreshed', { at: new Date(to).toISOString(), enter, open, closed: rows.filter((r) => r.status === 'closed').length });
  return out;
}

/** The latest snapshot, refreshed first when a 4H bar has closed since it was taken. */
export async function currentRsiSignals(deps: RsiSignalsDeps, now: number, coins: () => Promise<ReadonlyArray<string>>): Promise<RsiSignalsSnapshot> {
  const snap = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
  if (snap && snap.time >= last4hClose(now)) return snap;
  return refreshRsiSignals(deps, now, await coins());
}
