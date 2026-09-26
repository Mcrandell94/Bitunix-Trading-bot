// The worker loop: sleep until the next bar close, scan what closed, repeat.

import type { Timeframe } from '@bot/signals';
import { nextRun } from './schedule';
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
}

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export async function loop(deps: ScanDeps, opts: LoopOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  while (!opts.signal.aborted) {
    const next = nextRun(now(), deps.config.timeframes, deps.config.closeDelayMs);
    deps.log.info('waiting for bar close', { at: new Date(next.at).toISOString(), timeframes: next.timeframes });
    await sleep(Math.max(0, next.at - now()), opts.signal);
    if (opts.signal.aborted) break;
    await runClose(deps, next.timeframes, now());
  }
  deps.log.info('worker stopped', {});
}
