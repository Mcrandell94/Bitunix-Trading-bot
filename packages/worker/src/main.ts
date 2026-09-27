// CLI entry point.
//   npm run migrate          apply database migrations
//   npm run scan -- 4h       one scan of the last closed bar, then exit
//   npm start                migrate, then scan every bar close until stopped
//                            (and serve the dashboard if DASHBOARD_PASSWORD is set)
//   npm run account          read-only check of the linked Bitunix account

import { BOT_MODEL, HOLDOUT_RESULT_PATH, LIVE_MODEL, botConfig } from '@bot/backtest';
import { createClient, writeMode } from '@bot/bitunix';
import type { Timeframe } from '@bot/signals';
import { createPool, loadControls, migrate, type Db } from '@bot/store';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { accountApi, accountSnapshot, logSnapshot } from './account';
import { loadConfig, type WorkerConfig } from './config';
import { executorStep, loadLiveSlots } from './executor';
import { applyControl, effectiveMode, parseControl, type ControlDeps, type LiveControls } from './controls';
import { startDashboard, type WorkerStatus } from './dashboard';
import { jsonLogger } from './log';
import { loop, runClose } from './run';

const log = jsonLogger();
const [command = 'run', arg] = process.argv.slice(2);

async function main(): Promise<number> {
  const config = loadConfig();
  const mode = writeMode({ tradingEnabled: config.tradingEnabled, dryRun: config.live.dryRun });
  log.info('starting', {
    command, tradingEnabled: config.tradingEnabled, writeMode: mode, accountLinked: config.live.credentials != null,
    universe: config.universe, timeframes: config.timeframes,
  });
  if (command === 'account') {
    const api = accountApi(config, log);
    if (!api) {
      log.error('account: no API keys', { hint: 'set BITUNIX_API_KEY and BITUNIX_API_SECRET' });
      return 2;
    }
    const snap = await accountSnapshot(api, Date.now());
    logSnapshot(log, snap, mode);
    return snap.ok ? 0 : 1;
  }
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
      // Kill switches live in the database; `live` is the copy the order gate reads at every write.
      const live: LiveControls = { haltLive: (await loadControls(db)).haltLive };
      const api = accountApi(config, log, live, db);
      const bot = botConfig(0, 0);
      const status: WorkerStatus = {
        startedAt: Date.now(), paperEnabled: config.paper.enabled, tradingEnabled: config.tradingEnabled, writeMode: mode,
        tiersEnabled: { LTF: bot.tiers.LTF.enabled, MTF: bot.tiers.MTF.enabled, HTF: bot.tiers.HTF.enabled }, botModel: BOT_MODEL,
        slotLabels: slotLabels(), liveModel: LIVE_MODEL, liveSlots: await loadLiveSlots(db), holdout: holdoutState(),
        codeSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, nextWakeAt: null, account: null,
      };
      const refreshAccount = async () => {
        live.haltLive = (await loadControls(db)).haltLive;
        status.liveSlots = await loadLiveSlots(db);
        if (!api) return;
        status.account = await accountSnapshot(api, Date.now());
        logSnapshot(log, status.account, effectiveMode(mode, live));
      };
      const controls: ControlDeps = { db, log, live, flattenApi: accountApi(config, log, undefined, db), now: Date.now };
      const dashboard = await openDashboard(
        db, config.dashboard,
        () => ({ ...status, writeMode: effectiveMode(mode, live) }),
        async (body, source) => {
          const r = await applyControl(controls, parseControl(body), source);
          status.liveSlots = await loadLiveSlots(db);
          return r;
        },
      );
      await refreshAccount();
      try {
        await loop(deps, {
          signal: stop.signal, onWait: (at) => { status.nextWakeAt = at; }, afterWake: refreshAccount,
          afterPaper: api ? (step) => executorStep({ api, db, log, live: config.live }, { sessionId: step.session.id, result: step.result, time: step.time, data: step.data }).then(() => {}) : undefined,
        });
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

/**
 * Strategy names for the dashboard: the paper model's named slots, else the
 * live model's; while both are idle, the EMA 50 strategies waiting on the 6-month check.
 */
function slotLabels(): Partial<Record<'LTF' | 'MTF' | 'HTF', string>> {
  const out: Partial<Record<'LTF' | 'MTF' | 'HTF', string>> = {};
  const models = BOT_MODEL === 'none' && LIVE_MODEL === 'none' ? (['ema50'] as const) : [LIVE_MODEL, BOT_MODEL];
  for (const m of models) {
    const tiers = botConfig(0, 0, m).tiers;
    for (const t of ['LTF', 'MTF', 'HTF'] as const) if (tiers[t]?.label) out[t] = tiers[t].label;
  }
  return out;
}

/** The 6-month check's result, committed to the repo once it has run (research/holdout-ema50.json). */
function holdoutState(): NonNullable<WorkerStatus['holdout']> {
  if (!existsSync(HOLDOUT_RESULT_PATH)) return { state: 'locked' };
  try {
    const r = JSON.parse(readFileSync(HOLDOUT_RESULT_PATH, 'utf8')) as { ranAt?: string; verdict?: { pass?: boolean } };
    return { state: r.verdict?.pass ? 'passed' : 'failed', ranAt: r.ranAt };
  } catch {
    return { state: 'locked' };
  }
}

/** The dashboard is optional: a bad setting or a busy port is logged, never fatal to the worker. */
async function openDashboard(
  db: Db, cfg: WorkerConfig['dashboard'], status: () => WorkerStatus,
  control: (body: unknown, source: string) => Promise<{ message: string }>,
): Promise<Server | null> {
  if (!cfg.password) {
    log.info('dashboard off', { reason: 'DASHBOARD_PASSWORD is not set' });
    return null;
  }
  if (cfg.password.length < 12) {
    log.warn('dashboard off', { reason: 'DASHBOARD_PASSWORD must be at least 12 characters' });
    return null;
  }
  try {
    return await startDashboard({ db, password: cfg.password, port: cfg.port, status, control, log });
  } catch (err) {
    log.error('dashboard failed to start', { error: (err as Error).message });
    return null;
  }
}

main().then((code) => process.exit(code), (err) => {
  log.error('fatal', { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
