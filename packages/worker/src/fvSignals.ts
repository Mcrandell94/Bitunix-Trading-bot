// The 4H funding squeeze signal (owner 2026-10-10: "let's just use the most productive model"): a 4H candle on 3x+ its
// normal volume moving against the side funding says is crowded, traded back the crowd's way after a 1H candle closes
// that way (docs/RESULTS.md, funding + volume extremes, third round: the 4H + 1H confirmation line).
//
// DISPLAY ONLY. Its rows are kept in their own snapshot ('fv-signals'), which the live executor (rsiLive.ts) never
// reads, so the bot cannot trade it. They are shown on the dashboard and, when the model's switch is on, posted to
// Telegram (telegram.ts fvAlertStep).
//
// Coins: the scan list's coins with $0.5M+ 24h volume (the range it was tested on), plus coins with rows (followed until
// they age out). Candles come from the worker's memory (candleMemory.ts). Funding settlements are kept in memory too:
// the last FUNDING_DAYS days per coin, read once (FUNDING_READS_PER_WAKE coins a wake, the newest volume spike first),
// then only when a new 4H spike needs judging or a trade is open. A 4H candle is judged once funding was read 10
// minutes after its close (FV_LIVE.settleMs), so its last settlement is in.

import { FV_LIVE, fvLiveSignals, relVolume, type FvSignalRow } from '@bot/backtest';
import { fetchFundingHistory, type BitunixClient, type FundingPoint } from '@bot/bitunix';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';
import type { Candle } from '@bot/marketdata';
import { candles, isReady, update } from './candleMemory';
import type { Logger } from './log';

export const FV_SIGNALS_KEY = 'fv-signals';
/** The volume the model was tested on (fresh coins $0.5M+, and the research coins). */
export const FV_MIN_VOLUME = 500_000;
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
/** Funding kept per coin; signals older than this can't be judged (24h of settlements before the candle are needed). */
export const FUNDING_DAYS = 31;
/** Coins whose funding is read for the first time in one wake-up (5 requests a second are shared with the candles). */
export const FUNDING_READS_PER_WAKE = 60;
const C4_DAYS = 120, H1_DAYS = 40;

/** `time` = the 1H close of the refresh, `coins` = coins it checked, `pending` = coins waiting for their first funding read. */
export interface FvSignalsSnapshot { time: number; coins: number; pending: number; rows: FvSignalRow[] }
export interface FvSignalsDeps { client: BitunixClient; db: Db; log: Logger }

const funding = new Map<string, { fs: FundingPoint[]; readAt: number }>();
export const resetFundingMemory = () => funding.clear();

export const last1hClose = (now: number) => Math.floor(now / H) * H;

/** The close of the newest 4H candle in the funding window with 3x+ volume (a possible signal), or null. */
export function newestSpike(c4: ReadonlyArray<Candle>, to: number): number | null {
  for (let i = c4.length - 1; i >= 0 && c4[i]!.openTime + H4 > to - (FUNDING_DAYS - 1) * DAY; i--) {
    const v = relVolume(c4, i);
    if (v != null && v >= FV_LIVE.vol) return c4[i]!.openTime + H4;
  }
  return null;
}

/** Reads the settlements since the last one kept (all FUNDING_DAYS the first time) and trims to the window. */
async function readFunding(client: BitunixClient, symbol: string, now: number): Promise<void> {
  const had = funding.get(symbol), keepFrom = now - FUNDING_DAYS * DAY;
  const from = had?.fs.length ? had.fs[had.fs.length - 1]!.time + 1 : keepFrom;
  const add = await fetchFundingHistory(client, symbol, from, now + 1);
  const byTime = new Map([...(had?.fs ?? []), ...add].filter((f) => f.time >= keepFrom).map((f) => [f.time, f]));
  funding.set(symbol, { fs: [...byTime.values()].sort((a, b) => a.time - b.time), readAt: now });
}

/**
 * Rows kept for coins not checked this time: open trades, trades closed in the last 14 days and setups still in their
 * window; never entry signals (an old one must never look fresh).
 */
const carried = (rows: ReadonlyArray<FvSignalRow>, checked: ReadonlySet<string>, to: number) => rows.filter((r) => !checked.has(r.symbol) &&
  (r.status === 'open' || (r.status === 'closed' && r.closedAt != null && r.closedAt >= to - 14 * DAY) || (r.status === 'waiting' && r.until != null && r.until > to)));

/**
 * One refresh at the last 1H close. `fresh` = the coins new setups may start on ($0.5M+ volume, scan-list order); coins
 * with rows are followed too, but there only open and closed trades are kept. Coins not ready (candles still
 * downloading) or whose funding is not read yet keep their previous rows.
 */
export async function refreshFvSignals(deps: FvSignalsDeps, now: number, fresh: ReadonlyArray<string>): Promise<FvSignalsSnapshot> {
  const to = last1hClose(now);
  const before = await loadSnapshot<FvSignalsSnapshot>(deps.db, FV_SIGNALS_KEY), prev = before?.rows ?? [];
  const mayStart = new Set(fresh), withRows = new Set(prev.map((r) => r.symbol)), inTrade = new Set(prev.filter((r) => r.status === 'open' || r.status === 'enter').map((r) => r.symbol));
  const coins = [...new Set([...fresh, ...withRows])].filter(isReady);
  // Which coins need funding read now, newest spike first: never read, a spike not judged yet, or a trade on (hourly).
  const want: { symbol: string; at: number }[] = [];
  const c4s = new Map<string, ReturnType<typeof candles>>();
  for (const symbol of coins) {
    try {
      await update(deps.client, symbol, ['4h', '1h'], to);
    } catch (err) {
      deps.log.warn('fv signals: candles failed', { symbol, error: (err as Error).message });
      continue;
    }
    const c4 = candles(symbol, '4h', to - C4_DAYS * DAY, to);
    c4s.set(symbol, c4);
    const spike = newestSpike(c4, to), f = funding.get(symbol);
    if (spike == null && !inTrade.has(symbol)) continue;
    const stale = !f || (spike != null && f.readAt < spike + FV_LIVE.settleMs) || (inTrade.has(symbol) && to - f.readAt >= H);
    if (stale) want.push({ symbol, at: spike ?? to });
  }
  let firstReads = 0;
  for (const w of want.sort((a, b) => b.at - a.at)) {
    if (!funding.has(w.symbol) && ++firstReads > FUNDING_READS_PER_WAKE) continue;
    try {
      await readFunding(deps.client, w.symbol, now);
    } catch (err) {
      deps.log.warn('fv signals: funding failed', { symbol: w.symbol, error: (err as Error).message });
    }
  }
  const rows: FvSignalRow[] = [];
  const checked = new Set<string>();
  let pending = 0;
  for (const [symbol, c4] of c4s) {
    const f = funding.get(symbol);
    if (!f && newestSpike(c4, to) != null) { pending++; continue; } // funding not read yet: keep the coin's rows for now
    const h1 = candles(symbol, '1h', to - H1_DAYS * DAY, to);
    rows.push(...fvLiveSignals(symbol, c4, h1, f?.fs ?? [], to, 14, f?.readAt ?? -Infinity)
      .filter((r) => mayStart.has(symbol) || (r.status !== 'waiting' && r.status !== 'enter')));
    checked.add(symbol);
  }
  const snap: FvSignalsSnapshot = { time: to, coins: checked.size, pending, rows: [...rows, ...carried(prev, checked, to)] };
  await saveSnapshot(deps.db, FV_SIGNALS_KEY, snap);
  const enter = rows.filter((r) => r.status === 'enter');
  if (enter.length) deps.log.info('fv signals: entry signals', { at: new Date(to).toISOString(), symbols: enter.map((r) => `${r.symbol} ${r.side}`) });
  // Once an hour (each new 1H close): what the refresh covered.
  if (before?.time !== to) {
    const n = (st: FvSignalRow['status']) => snap.rows.filter((r) => r.status === st).length;
    deps.log.info('fv signals: refreshed', { at: new Date(to).toISOString(), coins: checked.size, of: coins.length, pending, waiting: n('waiting'), enter: n('enter'), open: n('open'), closed: n('closed') });
  }
  return snap;
}
