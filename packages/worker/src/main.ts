// CLI entry point.
//   npm run migrate          apply database migrations
//   npm run scan -- 4h       one scan of the last closed bar, then exit
//   npm start                migrate, then scan every bar close until stopped
//                            (and serve the dashboard if DASHBOARD_PASSWORD is set)

import { createClient } from '@bot/bitunix';
import type { Timeframe } from '@bot/signals';
import { createPool, migrate, type Db } from '@bot/store';
import type { Server } from 'node:http';
import { loadConfig, type WorkerConfig } from './config';
import { startDashboard, type WorkerStatus } from './dashboard';
import { jsonLogger } from './log';
import { loop, runClose } from './run';

const log = jsonLogger();
const [command = 'run', arg] = process.argv.slice(2);

async function main(): Promise<number> {
  const config = loadConfig();
  log.info('starting', { command, tradingEnabled: config.tradingEnabled, universe: config.universe, timeframes: config.timeframes });
  const db = createPool(config.databaseUrl);
  try {
    const applied = await migrate(db);
    if (applied.length) log.info('migrations applied', { applied });
    if (command === 'migrate') return 0;

    const deps = { client: createClient({ baseUrl: config.bitunixBaseUrl }), db, config, log };
    if (command === 'scan') {
      const tfs = (arg ? [arg] : config.timeframes) as Timeframe[];
      const done = await runClose(deps, tfs, Date.now());
      return done.length === tfs.length ? 0 : 1;
    }
    if (command === 'run') {
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { log.info('stopping', { signal: sig }); stop.abort(); });
      const status: WorkerStatus = {
        startedAt: Date.now(), paperEnabled: config.paper.enabled, tradingEnabled: config.tradingEnabled,
        codeSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, nextWakeAt: null,
      };
      const dashboard = await openDashboard(db, config.dashboard, () => status);
      try {
        await loop(deps, { signal: stop.signal, onWait: (at) => { status.nextWakeAt = at; } });
      } finally {
        await new Promise((r) => (dashboard ? dashboard.close(r) : r(undefined)));
      }
      return 0;
    }
    log.error('unknown command', { command });
    return 2;
  } finally {
    await db.end();
  }
}

/** The dashboard is optional: a bad setting or a busy port is logged, never fatal to the worker. */
async function openDashboard(db: Db, cfg: WorkerConfig['dashboard'], status: () => WorkerStatus): Promise<Server | null> {
  if (!cfg.password) {
    log.info('dashboard off', { reason: 'DASHBOARD_PASSWORD is not set' });
    return null;
  }
  if (cfg.password.length < 12) {
    log.warn('dashboard off', { reason: 'DASHBOARD_PASSWORD must be at least 12 characters' });
    return null;
  }
  try {
    return await startDashboard({ db, password: cfg.password, port: cfg.port, status, log });
  } catch (err) {
    log.error('dashboard failed to start', { error: (err as Error).message });
    return null;
  }
}

main().then((code) => process.exit(code), (err) => {
  log.error('fatal', { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
