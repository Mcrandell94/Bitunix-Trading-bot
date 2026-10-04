// The RSI framework's live signals for the dashboard (owner 2026-10-03). Display only: nothing here trades.
// After each 4H close the worker brings ~3 years of daily and 4H candles up to date for the paper session's
// coins (the first run backfills them; later runs fetch only the new bars), runs the framework's models on
// them (@bot/backtest rsiFrameworkSignals) and saves the rows as the 'rsi-signals' snapshot the dashboard reads.

import { rsiFrameworkSignals, type RsiSignalRow } from '@bot/backtest';
import { fetchCandles, type BitunixClient, type Interval } from '@bot/bitunix';
import { closedOnly, intervalMs, type Candle, type IntervalName } from '@bot/marketdata';
import { activePaperSession, loadCandles, loadSnapshot, saveSnapshot, upsertCandles, type Db } from '@bot/store';
import type { Logger } from './log';

export const RSI_SIGNALS_KEY = 'rsi-signals';
const DAY = 86_400_000;
/** History the models need: weekly RSI and the per-coin 4H RSI floor were tested on ~3 years. */
export const RSI_HISTORY_DAYS: Record<'1d' | '4h', number> = { '1d': 1100, '4h': 1095 };
const BTC = 'BTCUSDT', BTC_HISTORY_DAYS = 120; // enough for the 50-day SMA

export interface RsiSignalsSnapshot { time: number; coins: number; rows: RsiSignalRow[] }

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

/** One full refresh at `now` (the paper session's coins); returns the snapshot it saved, or null without a session. */
export async function refreshRsiSignals(deps: RsiSignalsDeps, now: number): Promise<RsiSignalsSnapshot | null> {
  const session = await activePaperSession(deps.db);
  if (!session) return null;
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
  for (const symbol of session.symbols) {
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
  const snap: RsiSignalsSnapshot = { time: to, coins, rows };
  await saveSnapshot(deps.db, RSI_SIGNALS_KEY, snap);
  deps.log.info('rsi signals: refreshed', {
    at: new Date(to).toISOString(), coins,
    waiting: rows.filter((r) => r.status === 'waiting').length, enter: rows.filter((r) => r.status === 'enter').length,
    open: rows.filter((r) => r.status === 'open').length, closed: rows.filter((r) => r.status === 'closed').length,
  });
  return snap;
}

/**
 * Called every wake-up: starts a refresh in the background when a 4H bar closed since the last snapshot, never two
 * at once, and never blocking the paper step (the first run backfills years of candles and takes a few minutes).
 */
export function rsiSignalsRunner(deps: RsiSignalsDeps): (now: number) => Promise<void> | null {
  let running: Promise<void> | null = null;
  return (now) => {
    if (running) return null;
    running = (async () => {
      const snap = await loadSnapshot<RsiSignalsSnapshot>(deps.db, RSI_SIGNALS_KEY);
      if (snap && snap.time >= last4hClose(now)) return;
      await refreshRsiSignals(deps, now);
    })().catch((err: Error) => { deps.log.error('rsi signals: refresh failed', { error: err.message }); })
      .finally(() => { running = null; });
    return running;
  };
}
