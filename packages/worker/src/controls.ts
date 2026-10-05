// Dashboard controls. The kill switches can only make the bot safer: halt live orders, switch trading off, close
// everything the bot opened. Turning live trading ON for the account stays in the Railway variables
// (TRADING_ENABLED and LIVE_DRY_RUN).
//
// At the owner's request (2026-10-04: "signal list with toggles to turn on live trading"): which RSI framework
// models trade live, with which rule set and exit (rsi-live), and the risk per live RSI trade (set-rsi-risk).
// Also the live drawdown breaker, leverage by coin size and max open trades, kept within bounds.

import { RSI_MODELS, RULE_PLANS, type RsiModelId, type RulePlan } from '@bot/backtest';
import { isBotClientId, type TradeApi, type WriteMode } from '@bot/bitunix';
import { loadSnapshot, logControlEvent, saveSnapshot, setEntryPause, setHaltLive, type Db } from '@bot/store';
import { LIVE_BREAKER_KEY, LIVE_BREAKER_OVERRIDE_KEY, LIVE_LEVERAGE_KEY, LIVE_MAX_OPEN_KEY, loadLiveBreaker, loadLiveLeverage, loadLiveMaxOpen } from './executor';
import { DEFAULT_RSI_RISK_PCT, DIV_BOOST_KEY, DIV_BOOSTS, OPTIMAL_DIV_BOOST, OPTIMAL_PRESET_ID, RISK_PRESET_ID, OPTIMAL_RSI_LIVE, PRESETS_KEY, liveRsiModels, RSI_LIVE_KEY, RSI_RISK_KEY, loadDivBoost, loadRsiLive, loadRsiRiskPct } from './rsiLive';
import type { Logger } from './log';
import { setRsiAlert } from './telegram';

export type ControlAction =
  | { action: 'halt-live' }
  | { action: 'resume-live' }
  | { action: 'flatten'; confirm: 'FLATTEN' }
  /** The master switch: off = pause all entries AND halt live orders; on = lift both. */
  | { action: 'trading-off' }
  | { action: 'trading-on' }
  /** One RSI model's live settings: on / off, rule set, exit (0 = A main, 1 = B alternative). */
  | { action: 'rsi-live'; model: RsiModelId; on?: boolean; plan?: RulePlan; variant?: 0 | 1 }
  /** One RSI model's live signal alerts to Telegram: on / off (separate from live trading). */
  | { action: 'rsi-alert'; model: RsiModelId; on: boolean }
  /** Risk per live RSI trade, % of the account (0.5-5). */
  | { action: 'set-rsi-risk'; riskPct: number }
  /** Risk multiple on signals with a daily MACD divergence: 1 (off), 1.5 or 2. */
  | { action: 'set-div-boost'; mult: number }
  /** The live drawdown breaker: drawdown % from the peak that stops new live entries, and for how many days. */
  | { action: 'set-breaker'; drawdownPct: number; pauseDays: number }
  /** Trade through the breaker's pause (on) or let the pause block new live entries again (off). */
  | { action: 'breaker-override'; on: boolean }
  /** Leverage by coin size (1-20x each, still capped by LIVE_LEVERAGE and the pair) and the large-cap list. */
  | { action: 'set-leverage'; large: number; mid: number; small: number; largeCaps: string[] }
  /** Most live trades open at once (1-20). */
  | { action: 'set-max-open'; maxOpen: number };

export class ControlError extends Error {}

/** Validates a request body; anything unexpected is refused. */
export function parseControl(body: unknown): ControlAction {
  if (typeof body !== 'object' || body === null) throw new ControlError('expected a JSON object');
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'halt-live':
    case 'resume-live':
    case 'trading-off':
    case 'trading-on':
      return { action: b.action };
    case 'rsi-live': {
      if (!liveRsiModels().includes(b.model as RsiModelId)) throw new ControlError('model must be one of the live RSI models');
      const out: Extract<ControlAction, { action: 'rsi-live' }> = { action: 'rsi-live', model: b.model as RsiModelId };
      if (b.on != null) { if (typeof b.on !== 'boolean') throw new ControlError('on must be true or false'); out.on = b.on; }
      if (b.plan != null) { if (!RULE_PLANS.includes(b.plan as RulePlan)) throw new ControlError('rule set must be "option 1" or "no exceptions"'); out.plan = b.plan as RulePlan; }
      if (b.variant != null) { if (b.variant !== 0 && b.variant !== 1) throw new ControlError('exit must be 0 (A) or 1 (B)'); out.variant = b.variant; }
      if (out.on == null && out.plan == null && out.variant == null) throw new ControlError('nothing to change');
      return out;
    }
    case 'rsi-alert':
      if (!liveRsiModels().includes(b.model as RsiModelId)) throw new ControlError('model must be one of the live RSI models');
      if (typeof b.on !== 'boolean') throw new ControlError('on must be true or false');
      return { action: 'rsi-alert', model: b.model as RsiModelId, on: b.on };
    case 'set-rsi-risk': {
      const v = Number(b.riskPct);
      if (!Number.isFinite(v) || v < 0.5 || v > 5) throw new ControlError('risk must be between 0.5% and 5% per trade');
      return { action: 'set-rsi-risk', riskPct: Math.round(v * 10) / 10 };
    }
    case 'set-div-boost': {
      const v = Number(b.mult);
      if (!(DIV_BOOSTS as readonly number[]).includes(v)) throw new ControlError('the MACD divergence boost must be 1 (off), 1.5 or 2');
      return { action: 'set-div-boost', mult: v };
    }
    case 'set-breaker': {
      const dd = Number(b.drawdownPct), days = Number(b.pauseDays);
      if (!Number.isFinite(dd) || dd < 5 || dd > 50) throw new ControlError('drawdown must be between 5% and 50%');
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new ControlError('pause must be a whole number of days from 1 to 30');
      return { action: 'set-breaker', drawdownPct: Math.round(dd * 10) / 10, pauseDays: days };
    }
    case 'breaker-override':
      if (typeof b.on !== 'boolean') throw new ControlError('on must be true or false');
      return { action: 'breaker-override', on: b.on };
    case 'set-max-open': {
      const v = Number(b.maxOpen);
      if (!Number.isInteger(v) || v < 1 || v > 20) throw new ControlError('max open trades must be a whole number from 1 to 20');
      return { action: 'set-max-open', maxOpen: v };
    }
    case 'set-leverage': {
      const lev = (k: 'large' | 'mid' | 'small') => {
        const v = Number(b[k]);
        if (!Number.isInteger(v) || v < 1 || v > 20) throw new ControlError(`${k} cap leverage must be a whole number from 1 to 20`);
        return v;
      };
      const raw = Array.isArray(b.largeCaps) ? b.largeCaps : String(b.largeCaps ?? '').split(/[\s,]+/);
      const largeCaps = [...new Set(raw.map((x) => String(x).trim().toUpperCase().replace(/USDT$/, '')).filter(Boolean))];
      if (largeCaps.length > 60 || largeCaps.some((c) => !/^[A-Z0-9]{1,20}$/.test(c))) throw new ControlError('large caps: up to 60 coin tickers like BTC, ETH');
      return { action: 'set-leverage', large: lev('large'), mid: lev('mid'), small: lev('small'), largeCaps };
    }
    case 'flatten':
      if (b.confirm !== 'FLATTEN') throw new ControlError('type FLATTEN to confirm');
      return { action: 'flatten', confirm: 'FLATTEN' };
    default:
      throw new ControlError('unknown action');
  }
}

/** Shared with the order gate: read at every write. */
export interface LiveControls {
  haltLive: boolean;
}

/** The mode orders actually get: the environment's, unless halted from the dashboard. */
export const effectiveMode = (envMode: WriteMode, live: LiveControls): WriteMode => (live.haltLive ? 'disabled' : envMode);

export interface ControlDeps {
  db: Db;
  log: Logger;
  live: LiveControls;
  /** Account API that ignores the halt (closing is always allowed), or null without keys. */
  flattenApi: TradeApi | null;
  now: () => number;
}

export async function applyControl(deps: ControlDeps, a: ControlAction, source: string): Promise<{ message: string }> {
  const { db, log } = deps;
  log.info('control', { ...a, source });
  switch (a.action) {
    case 'halt-live':
      await setHaltLive(db, true, source);
      deps.live.haltLive = true;
      return { message: 'Live orders halted. Nothing will be sent to Bitunix until resumed.' };
    case 'resume-live':
      await setHaltLive(db, false, source);
      deps.live.haltLive = false;
      return { message: 'Halt lifted. Orders follow the Railway settings again.' };
    case 'flatten':
      return flatten(deps, source);
    case 'trading-off':
      await setEntryPause(db, 'ALL', true, deps.now(), source);
      await setHaltLive(db, true, source);
      deps.live.haltLive = true;
      return { message: 'Trading is OFF: no new trades and nothing is sent to Bitunix. Open positions keep their stops and targets.' };
    case 'trading-on':
      await setEntryPause(db, 'ALL', false, deps.now(), source);
      await setHaltLive(db, false, source);
      deps.live.haltLive = false;
      return { message: 'Trading is ON: the bot takes new trades again (each RSI model\'s live switch still applies).' };
    case 'set-breaker': {
      const before = await loadLiveBreaker(db);
      await saveSnapshot(db, LIVE_BREAKER_KEY, { drawdownPct: a.drawdownPct, pauseDays: a.pauseDays });
      await logControlEvent(db, 'set-breaker', { before, drawdownPct: a.drawdownPct, pauseDays: a.pauseDays }, source);
      return { message: `Live drawdown breaker: a ${a.drawdownPct}% drop in the bot's own trades from their peak stops new live entries for ${a.pauseDays} day${a.pauseDays === 1 ? '' : 's'}. Open positions keep their stops and targets.` };
    }
    case 'breaker-override': {
      await saveSnapshot(db, LIVE_BREAKER_OVERRIDE_KEY, { on: a.on, at: deps.now() });
      await logControlEvent(db, 'breaker-override', { on: a.on }, source);
      return {
        message: a.on
          ? 'Trading through the drawdown pause: new live entries go ahead even while the breaker is tripped. Switch it off to restore the pause.'
          : 'Drawdown pause restored: while the breaker is tripped, no new live entries.',
      };
    }
    case 'set-max-open': {
      const before = await loadLiveMaxOpen(db);
      await saveSnapshot(db, LIVE_MAX_OPEN_KEY, { maxOpen: a.maxOpen });
      await logControlEvent(db, 'set-max-open', { before, maxOpen: a.maxOpen }, source);
      return { message: `Max open live trades: ${a.maxOpen}. Trades already open stay open; new entries wait for a free slot.` };
    }
    case 'set-leverage': {
      const before = await loadLiveLeverage(db);
      await saveSnapshot(db, LIVE_LEVERAGE_KEY, { byClass: { large: a.large, mid: a.mid, small: a.small }, largeCaps: a.largeCaps });
      await logControlEvent(db, 'set-leverage', { before, large: a.large, mid: a.mid, small: a.small, largeCaps: a.largeCaps }, source);
      return { message: `Leverage by coin size: large caps ${a.large}x, mid ${a.mid}x, small ${a.small}x (never above LIVE_LEVERAGE or the pair's maximum). Applies to new live entries; open positions keep theirs.` };
    }
    case 'rsi-live': {
      const all = await loadRsiLive(db);
      const before = all[a.model];
      const after = { on: a.on ?? before.on, plan: a.plan ?? before.plan, variant: a.variant ?? before.variant };
      await saveSnapshot(db, RSI_LIVE_KEY, { ...all, [a.model]: after });
      await logControlEvent(db, 'rsi-live', { model: a.model, before, ...after }, source);
      const name = RSI_MODELS[a.model].label;
      const how = `${after.plan}, exit ${after.variant === 0 ? 'A (main)' : 'B (alt)'}`;
      return {
        message: after.on
          ? `${name}: live trading ON (${how}). New signals from the next 4H close are traded on the account while live trading is on in Railway. Open positions follow their own signal.`
          : `${name}: live trading OFF (${how}). No new live entries; open positions keep following their signal until they close.`,
      };
    }
    case 'rsi-alert': {
      const after = await setRsiAlert(db, a.model, a.on, deps.now());
      await logControlEvent(db, 'rsi-alert', { model: a.model, on: after.on }, source);
      const name = RSI_MODELS[a.model].label;
      return { message: after.on ? `${name}: live signals ON. New signals from now on are posted to the Telegram group (with the rule set and exit picked for this model). Trading is not affected.` : `${name}: live signals OFF. Nothing more is posted for this model. Trading is not affected.` };
    }
    case 'set-div-boost': {
      const before = await loadDivBoost(db);
      await saveSnapshot(db, DIV_BOOST_KEY, { mult: a.mult });
      await logControlEvent(db, 'set-div-boost', { before, mult: a.mult }, source);
      return { message: a.mult === 1 ? 'MACD divergence boost OFF: every live RSI trade risks the same.' : `MACD divergence boost ${a.mult}x: signals with a daily MACD divergence risk ${a.mult}x the normal risk (never above 5% of the account). New entries only.` };
    }
    case 'set-rsi-risk': {
      const before = await loadRsiRiskPct(db);
      await saveSnapshot(db, RSI_RISK_KEY, { riskPct: a.riskPct });
      await logControlEvent(db, 'set-rsi-risk', { before, riskPct: a.riskPct }, source);
      return { message: `Risk per live RSI trade: ${a.riskPct}% of the account at the stop. New entries only.` };
    }
  }
}

/**
 * Emergency: pause all entries, halt live orders, then cancel the bot's open
 * orders and market-close the bot's positions. The owner's own orders and
 * positions are never touched (and the trade API would refuse anyway).
 * Obeys the environment's mode: in dry-run it only reports what it would do.
 */
async function flatten(deps: ControlDeps, source: string): Promise<{ message: string }> {
  const { db } = deps;
  await setEntryPause(db, 'ALL', true, deps.now(), source);
  await setHaltLive(db, true, source);
  deps.live.haltLive = true;
  const api = deps.flattenApi;
  if (!api) {
    await logControlEvent(db, 'flatten', { result: 'no account linked' }, source);
    return { message: 'Entries paused and live orders halted. No Bitunix account is linked, so there was nothing to close.' };
  }
  if (api.mode === 'disabled') {
    await logControlEvent(db, 'flatten', { result: 'live trading off' }, source);
    return { message: 'Entries paused and live orders halted. Live trading is off in Railway, so the bot has no positions to close.' };
  }
  const done: string[] = [];
  const failed: string[] = [];
  const orders = (await api.pendingOrders()).filter((o) => isBotClientId(o.clientId));
  const mine = await api.ownedPositionIds();
  const untouched = (await api.positions()).filter((p) => !mine.has(p.positionId)).length;
  for (const symbol of [...new Set(orders.map((o) => o.symbol))]) {
    try {
      const r = await api.cancelOrders(symbol, orders.filter((o) => o.symbol === symbol).map((o) => ({ orderId: o.orderId })));
      done.push(`${r.status === 'dry-run' ? 'would cancel' : 'cancelled'} ${symbol} orders`);
    } catch (err) {
      failed.push(`${symbol} orders: ${(err as Error).message}`);
    }
  }
  for (const p of (await api.positions()).filter((x) => mine.has(x.positionId))) {
    try {
      const r = await api.flashClose(p.positionId);
      done.push(`${r.status === 'dry-run' ? 'would close' : 'closed'} ${p.symbol} ${p.side}`);
    } catch (err) {
      failed.push(`${p.symbol} ${p.side}: ${(err as Error).message}`);
    }
  }
  await logControlEvent(db, 'flatten', { mode: api.mode, done, failed }, source);
  const summary = done.length ? done.join('; ') : 'the bot had nothing open';
  const yours = untouched ? ` Your own ${untouched} position${untouched === 1 ? '' : 's'} left untouched.` : '';
  return { message: `Entries paused, live orders halted. ${summary}.${yours}${failed.length ? ` FAILED: ${failed.join('; ')}. Check Bitunix now.` : ''}` };
}

/**
 * Owner 2026-10-04: every RSI model on at its tested optimal setting, and the MACD divergence boost at 1.5x. Applied
 * once (remembered in PRESETS_KEY) through the same control actions as the dashboard, so it is logged and a later
 * dashboard change is never overwritten.
 */
export async function applyOptimalPreset(controls: ControlDeps): Promise<boolean> {
  const done = (await loadSnapshot<string[]>(controls.db, PRESETS_KEY)) ?? [];
  if (done.includes(OPTIMAL_PRESET_ID)) return false;
  for (const [model, s] of Object.entries(OPTIMAL_RSI_LIVE)) {
    await applyControl(controls, parseControl({ action: 'rsi-live', model, on: s.on, plan: s.plan, variant: s.variant }), `preset ${OPTIMAL_PRESET_ID}`);
  }
  await applyControl(controls, parseControl({ action: 'set-div-boost', mult: OPTIMAL_DIV_BOOST }), `preset ${OPTIMAL_PRESET_ID}`);
  await saveSnapshot(controls.db, PRESETS_KEY, [...done, OPTIMAL_PRESET_ID]);
  controls.log.info('preset: applied', { preset: OPTIMAL_PRESET_ID });
  return true;
}

/** Owner 2026-10-04: "adjust minimum risk to 2%". Sets the live risk per trade once; a later dashboard change stays. */
export async function applyRiskPreset(controls: ControlDeps): Promise<boolean> {
  const done = (await loadSnapshot<string[]>(controls.db, PRESETS_KEY)) ?? [];
  if (done.includes(RISK_PRESET_ID)) return false;
  await applyControl(controls, parseControl({ action: 'set-rsi-risk', riskPct: DEFAULT_RSI_RISK_PCT }), `preset ${RISK_PRESET_ID}`);
  await saveSnapshot(controls.db, PRESETS_KEY, [...done, RISK_PRESET_ID]);
  controls.log.info('preset: applied', { preset: RISK_PRESET_ID });
  return true;
}
