// CLI entry point.
//   npm run migrate          apply database migrations
//   npm start                migrate, then run the RSI framework every 15 minutes until stopped
//                            (and serve the dashboard if DASHBOARD_PASSWORD is set)
//   npm run account          read-only check of the linked Bitunix account

import { LIVE_EXITS } from '@bot/backtest';
import { createClient, writeMode } from '@bot/bitunix';
import { createPool, loadControls, loadSnapshot, migrate, type Db } from '@bot/store';
import type { Server } from 'node:http';
import { accountApi, accountSnapshot, logSnapshot } from './account';
import { loadConfig, type WorkerConfig } from './config';
import { LIVE_PEAK_KEY, loadBreakerOverride, loadLiveBreaker, loadLiveLeverage, loadLiveMaxOpen, type LivePeak } from './executor';
import { applyControl, applyBottomDivExitAPreset, applyOptimalPreset, applyRiskPreset, applyRsi10SignalPreset, effectiveMode, parseControl, type ControlDeps, type LiveControls } from './controls';
import { startDashboard, type WorkerStatus } from './dashboard';
import { jsonLogger } from './log';
import { liveRsiModels, loadDivBoost, loadRsiLive, loadRsiRiskPct, rsiLiveStep } from './rsiLive';
import { loadRsiAlerts, rsiAlertStep } from './telegram';
import { loop, rsiCoins } from './run';
import { backfillLoop } from './candleMemory';
import { wantCoins } from './rsiSignals';

const log = jsonLogger();
const [command = 'run'] = process.argv.slice(2);

async function main(): Promise<number> {
  const config = loadConfig();
  const mode = writeMode({ tradingEnabled: config.tradingEnabled, dryRun: config.live.dryRun });
  log.info('starting', { command, tradingEnabled: config.tradingEnabled, writeMode: mode, accountLinked: config.live.credentials != null, universe: config.universe });
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
    if (command !== 'run') {
      log.error('unknown command', { command });
      return 2;
    }
    const deps = { client: createClient({ baseUrl: config.bitunixBaseUrl }), db, config, log };
    const stop = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { log.info('stopping', { signal: sig }); stop.abort(); });
    // Kill switches live in the database; `live` is the copy the order gate reads at every write.
    const live: LiveControls = { haltLive: (await loadControls(db)).haltLive };
    const api = accountApi(config, log, live, db);
    const status: WorkerStatus = {
      startedAt: Date.now(), tradingEnabled: config.tradingEnabled, writeMode: mode,
      rsiExits: Object.fromEntries(liveRsiModels().map((m) => [m, [LIVE_EXITS[m][0].spec.name, LIVE_EXITS[m][1].spec.name]])),
      codeSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null, nextWakeAt: null, account: null,
    };
    const refreshSettings = async () => {
      status.rsiLive = await loadRsiLive(db);
      status.rsiAlerts = await loadRsiAlerts(db);
      status.telegram = config.telegram != null;
      status.rsiRiskPct = await loadRsiRiskPct(db);
      status.divBoost = await loadDivBoost(db);
      const b = await loadLiveBreaker(db);
      const pk = await loadSnapshot<LivePeak>(db, LIVE_PEAK_KEY);
      const until = pk?.trippedAt != null ? pk.trippedAt + b.pauseDays * 86_400_000 : null;
      status.liveBreaker = { ...b, peak: pk?.peak ?? null, until: until != null && until > Date.now() ? until : null, override: await loadBreakerOverride(db) };
      const lv = await loadLiveLeverage(db);
      status.liveLeverage = { max: config.live.leverage, marginMode: config.live.marginMode, byClass: lv.byClass, largeCaps: lv.largeCaps };
      status.liveMaxOpen = await loadLiveMaxOpen(db);
    };
    const refreshAccount = async () => {
      live.haltLive = (await loadControls(db)).haltLive;
      await refreshSettings();
      if (!api) return;
      status.account = await accountSnapshot(api, Date.now());
      logSnapshot(log, status.account, effectiveMode(mode, live));
    };
    const controls: ControlDeps = { db, log, live, flattenApi: accountApi(config, log, undefined, db), now: Date.now, telegram: config.telegram };
    await applyOptimalPreset(controls);
    await applyRiskPreset(controls);
    await applyRsi10SignalPreset(controls);
    await applyBottomDivExitAPreset(controls);
    const dashboard = await openDashboard(
      db, config.dashboard,
      () => ({ ...status, writeMode: effectiveMode(mode, live) }),
      async (body, source) => {
        const r = await applyControl(controls, parseControl(body), source);
        await refreshSettings();
        return r;
      },
    );
    await refreshAccount();
    // Candles live in memory: start downloading the coin list now, in the background (the wake-ups keep the list current).
    try {
      await wantCoins(deps, (await rsiCoins(deps)()).list);
    } catch (err) {
      log.warn('candles: first coin list failed (the first wake-up retries)', { error: (err as Error).message });
    }
    const backfill = backfillLoop(deps, stop.signal).catch((err) => log.error('candles: download task stopped', { error: (err as Error).message }));
    try {
      await loop(deps, {
        signal: stop.signal, onWait: (at) => { status.nextWakeAt = at; }, afterWake: refreshAccount,
        live: api ? (input) => rsiLiveStep({ api, db, log, live: config.live }, input) : undefined,
        alerts: (snapshot) => rsiAlertStep({ db, log, telegram: config.telegram }, snapshot),
      });
    } finally {
      stop.abort();
      await backfill;
      await new Promise((r) => (dashboard ? dashboard.close(r) : r(undefined)));
    }
    return 0;
  } finally {
    await db.end();
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
    return await startDashboard({ db, password: cfg.password, user: cfg.user, port: cfg.port, status, control, log });
  } catch (err) {
    log.error('dashboard failed to start', { error: (err as Error).message });
    return null;
  }
}

main().then((code) => process.exit(code), (err) => {
  log.error('fatal', { error: (err as Error).stack ?? String(err) });
  process.exit(1);
});
