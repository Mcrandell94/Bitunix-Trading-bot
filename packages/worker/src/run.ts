// The worker loop (owner, 2026-10-04: the EMA strategies and their paper replay are retired; the RSI framework is
// the only strategy). Every 15 minutes, just after the bar closes: after a 4H close, refresh the RSI signals; then
// one live step (reconcile, follow open RSI trades, new entries for the models switched on).

import type { BitunixClient } from '@bot/bitunix';
import type { Db } from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';
import { RSI_FULL_VOLUME, RSI_MAX_COINS, RSI_MIN_VOLUME, cleanCandleTables, setThinCoins, currentRsiSignals, refreshRsi10Signals, wantCoins, type RsiSignalsSnapshot } from './rsiSignals';
import { nextWake } from './schedule';
import { resolveStickyUniverse } from './scan';

export interface LoopDeps { client: BitunixClient; db: Db; config: WorkerConfig; log: Logger }

export interface LoopOptions {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  /** Told each wake-up time before sleeping (the dashboard shows it). */
  onWait?: (at: number) => void;
  /** The live step, with the current signals. Errors are logged. */
  live?: (input: { now: number; snapshot: RsiSignalsSnapshot | null; entries: boolean }) => Promise<unknown>;
  /** Live signal alerts, with the current signals. Errors are logged. */
  alerts?: (snapshot: RsiSignalsSnapshot | null) => Promise<unknown>;
  /** Runs after each wake-up's work (e.g. refreshing the account view). Errors are logged. */
  afterWake?: () => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * The coins every RSI model watches: core plus every API-tradable crypto USDT perp with $0.35M+ 24h volume, most liquid
 * first (up to 300), kept until its volume stays under $0.2M for 3 days in a row (owner 2026-10-07; scan.ts stickyList).
 */
export const rsiCoins = (deps: LoopDeps) => () => resolveStickyUniverse(deps, { joinVolume: RSI_MIN_VOLUME, maxExtra: RSI_MAX_COINS, fullVolume: RSI_FULL_VOLUME });

/** One wake-up's work: the coin list, signals (framework after a 4H close, 15M-RSI10 after every 15m close), then the live step and alerts. */
export async function wake(deps: LoopDeps, opts: Pick<LoopOptions, 'live' | 'alerts'>, now: number): Promise<void> {
  let snapshot: RsiSignalsSnapshot | null = null;
  let coins: string[] = [];
  try {
    await cleanCandleTables(deps);
  } catch (err) {
    deps.log.warn('candles: removing the database copies failed', { error: (err as Error).message });
  }
  try {
    const universe = await rsiCoins(deps)();
    setThinCoins(universe.thin);
    coins = await wantCoins(deps, universe.list); // also tells the background download what to fetch
    snapshot = await currentRsiSignals(deps, now, async () => coins);
  } catch (err) {
    deps.log.error('rsi signals: refresh failed', { error: (err as Error).message });
  }
  // 15M-RSI10 runs after every 15m close; its rows are merged into the same snapshot.
  try {
    snapshot = await refreshRsi10Signals(deps, now, coins, snapshot);
  } catch (err) {
    deps.log.error('rsi10 signals: refresh failed', { error: (err as Error).message });
  }
  if (opts.live) {
    try {
      await opts.live({ now: Date.now(), snapshot, entries: true });
    } catch (err) {
      deps.log.error('live: step failed', { error: (err as Error).message });
    }
  }
  if (opts.alerts) {
    try {
      await opts.alerts(snapshot);
    } catch (err) {
      deps.log.error('alerts: step failed', { error: (err as Error).message });
    }
  }
}

export async function loop(deps: LoopDeps, opts: LoopOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  while (!opts.signal.aborted) {
    const next = nextWake(now(), [], deps.config.closeDelayMs, true);
    deps.log.info('waiting for bar close', { at: new Date(next.at).toISOString() });
    opts.onWait?.(next.at);
    await sleep(Math.max(0, next.at - now()), opts.signal);
    if (opts.signal.aborted) break;
    await wake(deps, opts, now());
    if (opts.afterWake) {
      try {
        await opts.afterWake();
      } catch (err) {
        deps.log.error('after-wake task failed', { error: (err as Error).message });
      }
    }
  }
  deps.log.info('worker stopped', {});
}
