// The worker loop (owner, 2026-10-04: the EMA strategies and their paper replay are retired; the RSI framework is
// the only strategy). Every 15 minutes, just after the bar closes: after a 4H close, refresh the RSI signals; then
// one live step (reconcile, follow open RSI trades, new entries for the models switched on).

import type { BitunixClient } from '@bot/bitunix';
import type { Db } from '@bot/store';
import type { WorkerConfig } from './config';
import type { Logger } from './log';
import { RSI10_MAX_COINS, RSI10_MIN_VOLUME, currentRsiSignals, refreshRsi10Signals, type RsiSignalsSnapshot } from './rsiSignals';
import { nextWake } from './schedule';
import { resolveUniverse } from './scan';

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

/** The coins the RSI framework watches: core plus the most liquid USDT perps (PAPER_EXTRAS of them, as tested). */
export const rsiCoins = (deps: LoopDeps) => () => resolveUniverse({ ...deps, config: { ...deps.config, maxExtraSymbols: deps.config.paper.extras } });

/** 15M-RSI10's own wider list (owner 2026-10-06): core plus every crypto USDT perp with $0.5M+ 24h volume (up to 300). */
export const rsi10Coins = (deps: LoopDeps) => () => resolveUniverse({ ...deps, config: { ...deps.config, minQuoteVolume24h: RSI10_MIN_VOLUME, maxExtraSymbols: RSI10_MAX_COINS } });

/** One wake-up's work: signals (refreshed after a 4H close), then the live step. */
export async function wake(deps: LoopDeps, opts: Pick<LoopOptions, 'live' | 'alerts'>, now: number): Promise<void> {
  let snapshot: RsiSignalsSnapshot | null = null;
  try {
    snapshot = await currentRsiSignals(deps, now, rsiCoins(deps));
  } catch (err) {
    deps.log.error('rsi signals: refresh failed', { error: (err as Error).message });
  }
  // 15M-RSI10 runs after every 15m close; its rows are merged into the same snapshot.
  try {
    snapshot = await refreshRsi10Signals(deps, now, await rsi10Coins(deps)(), snapshot);
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
