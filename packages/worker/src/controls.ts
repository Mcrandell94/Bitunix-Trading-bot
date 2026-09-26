// Kill switches, driven from the dashboard. They can only make the bot
// safer: pause entries, halt live orders, or close everything. Turning live
// trading ON is deliberately not possible from here; it stays in the
// Railway variables (TRADING_ENABLED and LIVE_DRY_RUN).

import type { TradeApi, WriteMode } from '@bot/bitunix';
import { logControlEvent, setEntryPause, setHaltLive, type Db, type PauseScope } from '@bot/store';
import type { Logger } from './log';

export type ControlAction =
  | { action: 'pause'; scope: PauseScope }
  | { action: 'resume'; scope: PauseScope }
  | { action: 'halt-live' }
  | { action: 'resume-live' }
  | { action: 'flatten'; confirm: 'FLATTEN' };

const SCOPES: readonly PauseScope[] = ['ALL', 'LTF', 'MTF'];

export class ControlError extends Error {}

/** Validates a request body; anything unexpected is refused. */
export function parseControl(body: unknown): ControlAction {
  if (typeof body !== 'object' || body === null) throw new ControlError('expected a JSON object');
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'pause':
    case 'resume':
      if (!SCOPES.includes(b.scope as PauseScope)) throw new ControlError('scope must be ALL, LTF or MTF');
      return { action: b.action, scope: b.scope as PauseScope };
    case 'halt-live':
    case 'resume-live':
      return { action: b.action };
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
    case 'pause':
      return { message: (await setEntryPause(db, a.scope, true, deps.now(), source)) ? `New ${label(a.scope)} entries paused.` : 'Already paused.' };
    case 'resume':
      return { message: (await setEntryPause(db, a.scope, false, deps.now(), source)) ? `${cap(label(a.scope))} entries resumed.` : 'Was not paused.' };
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
  }
}

const label = (s: PauseScope) => (s === 'ALL' ? 'all' : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Emergency: pause all entries, halt live orders, then cancel every open
 * order and market-close every position on the account (manual ones too).
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
  const orders = await api.pendingOrders();
  for (const symbol of [...new Set(orders.map((o) => o.symbol))]) {
    try {
      const r = await api.cancelOrders(symbol, orders.filter((o) => o.symbol === symbol).map((o) => ({ orderId: o.orderId })));
      done.push(`${r.status === 'dry-run' ? 'would cancel' : 'cancelled'} ${symbol} orders`);
    } catch (err) {
      failed.push(`${symbol} orders: ${(err as Error).message}`);
    }
  }
  for (const p of await api.positions()) {
    try {
      const r = await api.flashClose(p.positionId);
      done.push(`${r.status === 'dry-run' ? 'would close' : 'closed'} ${p.symbol} ${p.side}`);
    } catch (err) {
      failed.push(`${p.symbol} ${p.side}: ${(err as Error).message}`);
    }
  }
  await logControlEvent(db, 'flatten', { mode: api.mode, done, failed }, source);
  const summary = done.length ? done.join('; ') : 'nothing was open';
  return { message: `Entries paused, live orders halted. ${summary}.${failed.length ? ` FAILED: ${failed.join('; ')}. Check Bitunix now.` : ''}` };
}
