// The worker loop: sleep until the next bar close, scan what closed, repeat.

import type { Timeframe } from '@bot/signals';
import { paperStep, type PaperStepResult } from './paper';
import { nextWake } from './schedule';
import { resolveUniverse, runScan, syncFunding, type ScanDeps, type ScanSummary } from './scan';

/** Every timeframe closing together shares one universe and funding snapshot. A failed timeframe doesn't stop the others. */
export async function runClose(deps: ScanDeps, timeframes: ReadonlyArray<Timeframe>, now: number): Promise<ScanSummary[]> {
  const universe = await resolveUniverse(deps);
  await syncFunding(deps, universe, now);
  const done: ScanSummary[] = [];
  for (const tf of timeframes) {
    try {
      done.push(await runScan(deps, tf, now, universe));
    } catch (err) {
      deps.log.error('scan failed', { timeframe: tf, error: (err as Error).message });
    }
  }
  return done;
}

export interface LoopOptions {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  /** Told each wake-up time before sleeping (the dashboard shows it). */
  onWait?: (at: number) => void;
  /** Runs after each wake-up's work (e.g. refreshing the account view). Errors are logged. */
  afterWake?: () => Promise<void>;
  /** Runs after each successful paper step (the live executor). Errors are logged. */
  afterPaper?: (step: PaperStepResult) => Promise<void>;
  /** Also replay under the live RRG switch (PaperDeps.liveReplay). */
  liveReplay?: boolean;
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export async function loop(deps: ScanDeps, opts: LoopOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  while (!opts.signal.aborted) {
    const paper = deps.config.paper.enabled;
    const next = nextWake(now(), deps.config.timeframes, deps.config.closeDelayMs, paper);
    deps.log.info('waiting for bar close', { at: new Date(next.at).toISOString(), timeframes: next.timeframes, paper });
    opts.onWait?.(next.at);
    await sleep(Math.max(0, next.at - now()), opts.signal);
    if (opts.signal.aborted) break;
    if (next.timeframes.length) await runClose(deps, next.timeframes, now());
    if (paper) {
      try {
        const step = await paperStep({
          client: deps.client, db: deps.db, log: deps.log, codeSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
          paper: { ...deps.config.paper, minQuoteVolume24h: deps.config.minQuoteVolume24h }, liveReplay: opts.liveReplay,
        }, now());
        if (opts.afterPaper) {
          try {
            await opts.afterPaper(step);
          } catch (err) {
            deps.log.error('live: step failed', { error: (err as Error).message });
          }
        }
      } catch (err) {
        deps.log.error('paper: step failed', { error: (err as Error).message });
      }
    }
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
