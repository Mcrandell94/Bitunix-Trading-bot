// Kill switches, driven from the dashboard. They can only make the bot
// safer: pause entries, halt live orders, or close everything. Turning live
// trading ON is deliberately not possible from here; it stays in the
// Railway variables (TRADING_ENABLED and LIVE_DRY_RUN).
//
// One exception, at the owner's request (2026-09-27): which of the live
// model's strategies trade live (live-slot-on / live-slot-off). It only picks
// among strategies the code already allows live (LIVE_MODEL, locked until the
// holdout check passes and the owner approves); the master live switch stays
// in Railway. Likewise the RRG magnifying glass (rrg-on / rrg-off, paper or
// live): it only reorders which signals get a full slot, never adds one.
// And the live drawdown breaker's settings (set-breaker), kept within bounds.

import { DEFAULT_RSI_LEVELS, loadRsiFilters, rsiFilterNow, setRsiFilter } from './rsiFilter';
import { DEFAULT_SHORT_W, loadShortFilters, setShortFilter, shortFilterNow } from './shortFilter';
import { ROOM_MODES, loadRoomFilters, roomFilterNow, setRoomFilter, type RoomMode } from './roomFilter';
import { altsCapNow, loadAltsCap, setAltsCap } from './altsCap';
import { BOT_MODEL, LIVE_MODEL, botConfig } from '@bot/backtest';
import { isBotClientId, type TradeApi, type WriteMode } from '@bot/bitunix';
import type { Tier } from '@bot/risk';
import { endPaperSession, logControlEvent, saveSnapshot, setEntryPause, setHaltLive, type Db, type PauseScope } from '@bot/store';
import { LIVE_BREAKER_KEY, LIVE_BREAKER_OVERRIDE_KEY, LIVE_LEVERAGE_KEY, LIVE_MAX_OPEN_KEY, LIVE_RISK_KEY, loadLiveMaxOpen, LIVE_SLOTS_KEY, loadLiveBreaker, loadLiveLeverage, loadLiveRiskPct, loadLiveSlots } from './executor';
import { RRG_RANKS, setRankSlot, setRrgInfluence, type RrgWhere } from './rrgInfluence';
import { SELECTIONS, SELECTION_SLOTS, loadSelection, selectionAt, setSelection, type SelectionSlot } from './selection';
import type { RrgRank, Selection } from '@bot/backtest';
import type { Logger } from './log';

export type ControlAction =
  | { action: 'pause'; scope: PauseScope }
  | { action: 'resume'; scope: PauseScope }
  | { action: 'halt-live' }
  | { action: 'resume-live' }
  | { action: 'flatten'; confirm: 'FLATTEN' }
  | { action: 'new-paper-session' }
  /** The master switch: off = pause all entries AND halt live orders; on = lift both. */
  | { action: 'trading-off' }
  | { action: 'trading-on' }
  /** Which of the live model's strategies trade on the real account. */
  | { action: 'live-slot-on'; scope: Tier }
  | { action: 'live-slot-off'; scope: Tier }
  /** RRG magnifying glass for paper or live (see rrgInfluence.ts). */
  | { action: 'rrg-on'; scope: RrgWhere; by?: RrgRank }
  | { action: 'rrg-off'; scope: RrgWhere }
  /** Whether one strategy uses the RRG ranking card (off = first come, first served for that strategy). */
  | { action: 'rank-slot-on'; scope: Tier }
  | { action: 'rank-slot-off'; scope: Tier }
  /** The live drawdown breaker: drawdown % from the peak that stops new live entries, and for how many days. */
  | { action: 'set-breaker'; drawdownPct: number; pauseDays: number }
  /** Trade through the breaker's pause (on) or let the pause block new live entries again (off). */
  | { action: 'breaker-override'; on: boolean }
  /** Leverage by coin size (1-20x each, still capped by LIVE_LEVERAGE and the pair) and the large-cap list. */
  | { action: 'set-leverage'; large: number; mid: number; small: number; largeCaps: string[] }
  /** Live risk per trade, % of the account (0.5-5). */
  | { action: 'set-live-risk'; riskPct: number }
  /** Which layer picks the coins for a pullback slot: none, daily range location, or RRG vs BTC. */
  | { action: 'set-selection'; scope: SelectionSlot; value: Selection }
  /** Most live trades open at once (1-20). */
  | { action: 'set-max-open'; maxOpen: number }
  /** Overbought filter on one strategy's longs: weekly / daily RSI levels (paper and live). */
  | { action: 'set-rsi-filter'; scope: Tier; on: boolean; w: number; d: number }
  /** Room-to-TP1 filter on one strategy: skip entries with daily resistance (support for shorts) before the first target (paper and live). */
  | { action: 'set-room-filter'; scope: Tier; on: boolean; mode: RoomMode }
  /** Short filter on one strategy: no short while the weekly RSI is at or above w (paper and live). */
  | { action: 'set-short-filter'; scope: Tier; on: boolean; w: number }
  /** Same-direction alts per strategy (paper and live). */
  | { action: 'set-max-alts'; maxAlts: number };

const SCOPES: readonly PauseScope[] = ['ALL', 'LTF', 'MTF', 'HTF', 'P4H', 'P1H'];
const SLOTS: readonly Tier[] = ['LTF', 'MTF', 'HTF', 'P4H', 'P1H'];

export class ControlError extends Error {}

/** Validates a request body; anything unexpected is refused. */
export function parseControl(body: unknown): ControlAction {
  if (typeof body !== 'object' || body === null) throw new ControlError('expected a JSON object');
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'pause':
    case 'resume':
      if (!SCOPES.includes(b.scope as PauseScope)) throw new ControlError('scope must be ALL, LTF, MTF, HTF, P4H or P1H');
      return { action: b.action, scope: b.scope as PauseScope };
    case 'halt-live':
    case 'resume-live':
    case 'new-paper-session':
    case 'trading-off':
    case 'trading-on':
      return { action: b.action };
    case 'live-slot-on':
    case 'live-slot-off':
      if (!SLOTS.includes(b.scope as Tier)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      return { action: b.action, scope: b.scope as Tier };
    case 'rank-slot-on':
    case 'rank-slot-off':
      if (!SLOTS.includes(b.scope as Tier)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      return { action: b.action, scope: b.scope as Tier };
    case 'rrg-on':
    case 'rrg-off':
      if (b.scope !== 'paper' && b.scope !== 'live') throw new ControlError('scope must be paper or live');
      if (b.action === 'rrg-on' && b.by != null) {
        if (!RRG_RANKS.includes(b.by as RrgRank)) throw new ControlError('ranking must be position, heading or fastslow');
        return { action: 'rrg-on', scope: b.scope, by: b.by as RrgRank };
      }
      return { action: b.action, scope: b.scope };
    case 'set-breaker': {
      const dd = Number(b.drawdownPct), days = Number(b.pauseDays);
      if (!Number.isFinite(dd) || dd < 5 || dd > 50) throw new ControlError('drawdown must be between 5% and 50%');
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new ControlError('pause must be a whole number of days from 1 to 30');
      return { action: 'set-breaker', drawdownPct: Math.round(dd * 10) / 10, pauseDays: days };
    }
    case 'breaker-override':
      if (typeof b.on !== 'boolean') throw new ControlError('on must be true or false');
      return { action: 'breaker-override', on: b.on };
    case 'set-selection':
      if (!SELECTION_SLOTS.includes(b.scope as SelectionSlot)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      if (!SELECTIONS.includes(b.value as Selection)) throw new ControlError('value must be none, range, rrg, heading, fastslow or btcregime');
      return { action: 'set-selection', scope: b.scope as SelectionSlot, value: b.value as Selection };
    case 'set-max-open': {
      const v = Number(b.maxOpen);
      if (!Number.isInteger(v) || v < 1 || v > 20) throw new ControlError('max open trades must be a whole number from 1 to 20');
      return { action: 'set-max-open', maxOpen: v };
    }
    case 'set-rsi-filter': {
      if (!SLOTS.includes(b.scope as Tier)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      const on = b.on === true || b.on === 'true';
      const w = Number(b.w ?? DEFAULT_RSI_LEVELS.w), d = Number(b.d ?? DEFAULT_RSI_LEVELS.d);
      if (!Number.isFinite(w) || !Number.isFinite(d) || w < 50 || w > 95 || d < 50 || d > 95) throw new ControlError('RSI levels must be between 50 and 95');
      return { action: 'set-rsi-filter', scope: b.scope as Tier, on, w: Math.round(w * 10) / 10, d: Math.round(d * 10) / 10 };
    }
    case 'set-short-filter': {
      if (!SLOTS.includes(b.scope as Tier)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      const w = Number(b.w ?? DEFAULT_SHORT_W);
      if (!Number.isFinite(w) || w < 30 || w > 90) throw new ControlError('weekly RSI level must be between 30 and 90');
      return { action: 'set-short-filter', scope: b.scope as Tier, on: b.on === true || b.on === 'true', w: Math.round(w * 10) / 10 };
    }
    case 'set-room-filter': {
      if (!SLOTS.includes(b.scope as Tier)) throw new ControlError('scope must be LTF, MTF, HTF, P4H or P1H');
      const mode = (b.mode ?? 'zones') as RoomMode;
      if (!ROOM_MODES.includes(mode)) throw new ControlError('mode must be zones or swing');
      return { action: 'set-room-filter', scope: b.scope as Tier, on: b.on === true || b.on === 'true', mode };
    }
    case 'set-max-alts': {
      const v = Number(b.maxAlts);
      if (!Number.isInteger(v) || v < 1 || v > 10) throw new ControlError('same-direction alts must be a whole number from 1 to 10');
      return { action: 'set-max-alts', maxAlts: v };
    }
    case 'set-live-risk': {
      const v = Number(b.riskPct);
      if (!Number.isFinite(v) || v < 0.5 || v > 5) throw new ControlError('live risk must be between 0.5% and 5% per trade');
      return { action: 'set-live-risk', riskPct: Math.round(v * 10) / 10 };
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
    case 'trading-off':
      await setEntryPause(db, 'ALL', true, deps.now(), source);
      await setHaltLive(db, true, source);
      deps.live.haltLive = true;
      return { message: 'Trading is OFF: no new trades (paper or live) and nothing is sent to Bitunix. Open positions keep their stops and targets.' };
    case 'trading-on':
      await setEntryPause(db, 'ALL', false, deps.now(), source);
      await setHaltLive(db, false, source);
      deps.live.haltLive = false;
      return { message: 'Trading is ON: the bot takes new trades again (tier switches still apply).' };
    case 'rank-slot-on':
    case 'rank-slot-off': {
      const on = a.action === 'rank-slot-on';
      const name = cap(strategyName(a.scope));
      if (!(await setRankSlot(db, a.scope, on, deps.now()))) return { message: `${name} ${on ? 'already uses' : 'already ignores'} the RRG ranking card.` };
      await logControlEvent(db, a.action, { scope: a.scope }, source);
      return {
        message: on
          ? `${name} now uses the RRG ranking card, from now on (paper and live): when its cap is full, the card's top-ranked coins get the slot. The card itself must be on for it to do anything.`
          : `${name} no longer uses the RRG ranking card: first come, first served for this strategy.`,
      };
    }
    case 'live-slot-on':
    case 'live-slot-off': {
      const slots = await loadLiveSlots(db);
      const on = a.action === 'live-slot-on';
      if (slots[a.scope] === on) return { message: `Already ${on ? 'on' : 'off'} for live trading.` };
      await saveSnapshot(db, LIVE_SLOTS_KEY, { ...slots, [a.scope]: on });
      await logControlEvent(db, a.action, { scope: a.scope }, source);
      const name = strategyName(a.scope);
      return { message: on ? `${cap(name)} strategy switched ON for live trading (it trades live only while live trading is on in Railway and the strategy is approved in the code).` : `${cap(name)} strategy switched OFF for live trading. Its open positions keep their stops and targets.` };
    }
    case 'rrg-on':
    case 'rrg-off': {
      const on = a.action === 'rrg-on';
      const by: RrgRank = a.action === 'rrg-on' ? a.by ?? 'position' : 'position';
      if (!(await setRrgInfluence(db, a.scope, on, deps.now(), by))) return { message: on ? `RRG ranking for ${a.scope} already ranks by ${RANK_TEXT[by]}.` : `RRG ranking is already off for ${a.scope}.` };
      await logControlEvent(db, a.action, on ? { scope: a.scope, by } : { scope: a.scope }, source);
      return {
        message: on
          ? `RRG ranking ON for ${a.scope}, by ${RANK_TEXT[by]}: from now on, when a cap is full, those coins get the slot first. No trade is added or dropped.`
          : `RRG ranking OFF for ${a.scope}: first come, first served again. RRG is still recorded on every trade.`,
      };
    }
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
    case 'set-selection': {
      const current = selectionAt((await loadSelection(db))[a.scope], deps.now()) ?? botConfig(0, 0, shownModel).tiers[a.scope]?.signal?.selection ?? 'none';
      if (!(await setSelection(db, a.scope, a.value, current, deps.now()))) return { message: `${cap(strategyName(a.scope))} already uses ${SELECTION_TEXT[a.value]}.` };
      await logControlEvent(db, 'set-selection', { scope: a.scope, before: current, value: a.value }, source);
      return { message: `${cap(strategyName(a.scope))} now picks coins by ${SELECTION_TEXT[a.value]}, from now on (paper and live).` };
    }
    case 'set-rsi-filter': {
      const name = cap(strategyName(a.scope));
      const before = rsiFilterNow((await loadRsiFilters(db))[a.scope]);
      if (!(await setRsiFilter(db, a.scope, { on: a.on, w: a.w, d: a.d }, deps.now()))) {
        return { message: a.on ? `${name} already skips longs at weekly RSI ${a.w} / daily RSI ${a.d}.` : `${name}'s RSI filter is already off.` };
      }
      await logControlEvent(db, 'set-rsi-filter', { scope: a.scope, before, on: a.on, w: a.w, d: a.d }, source);
      return {
        message: a.on
          ? `${name} now skips new longs when the weekly RSI is at or above ${a.w} or the daily RSI at or above ${a.d}, from now on (paper and live). Shorts are not filtered.`
          : `${name}'s RSI filter is off: longs are no longer filtered by RSI.`,
      };
    }
    case 'set-short-filter': {
      const name = cap(strategyName(a.scope));
      const before = shortFilterNow((await loadShortFilters(db))[a.scope]);
      if (!(await setShortFilter(db, a.scope, { on: a.on, w: a.w }, deps.now()))) {
        return { message: a.on ? `${name} already skips shorts at weekly RSI ${a.w}.` : `${name}'s short filter is already off.` };
      }
      await logControlEvent(db, 'set-short-filter', { scope: a.scope, before, on: a.on, w: a.w }, source);
      return {
        message: a.on
          ? `${name} now skips new shorts while the weekly RSI is at or above ${a.w}, from now on (paper and live). Longs are not affected.`
          : `${name}'s short filter is off: shorts are no longer filtered by RSI.`,
      };
    }
    case 'set-room-filter': {
      const name = cap(strategyName(a.scope));
      const what = a.mode === 'zones' ? 'a daily resistance zone (2+ swing highs; support for shorts)' : 'any daily swing high (swing low for shorts)';
      const before = roomFilterNow((await loadRoomFilters(db))[a.scope]);
      if (!(await setRoomFilter(db, a.scope, { on: a.on, mode: a.mode }, deps.now()))) {
        return { message: a.on ? `${name} already skips entries with ${what} before TP1.` : `${name}'s room-to-TP1 filter is already off.` };
      }
      await logControlEvent(db, 'set-room-filter', { scope: a.scope, before, on: a.on, mode: a.mode }, source);
      return {
        message: a.on
          ? `${name} now skips new entries when ${what} sits between the entry and TP1, from now on (paper and live).`
          : `${name}'s room-to-TP1 filter is off.`,
      };
    }
    case 'set-max-alts': {
      const before = altsCapNow(await loadAltsCap(db));
      if (!(await setAltsCap(db, a.maxAlts, deps.now()))) return { message: `Each strategy already holds at most ${a.maxAlts} altcoin trade${a.maxAlts === 1 ? '' : 's'} in the same direction.` };
      await logControlEvent(db, 'set-max-alts', { before, maxAlts: a.maxAlts }, source);
      return { message: `Each strategy may now hold up to ${a.maxAlts} altcoin trade${a.maxAlts === 1 ? '' : 's'} in the same direction (BTC and ETH don't count), from now on (paper and live).` };
    }
    case 'set-max-open': {
      const before = await loadLiveMaxOpen(db);
      await saveSnapshot(db, LIVE_MAX_OPEN_KEY, { maxOpen: a.maxOpen });
      await logControlEvent(db, 'set-max-open', { before, maxOpen: a.maxOpen }, source);
      return { message: `Max open live trades: ${a.maxOpen}. Trades already open stay open; new entries wait for a free slot.` };
    }
    case 'set-live-risk': {
      const before = await loadLiveRiskPct(db);
      await saveSnapshot(db, LIVE_RISK_KEY, { riskPct: a.riskPct });
      await logControlEvent(db, 'set-live-risk', { before, riskPct: a.riskPct }, source);
      return { message: `Live risk per trade: ${a.riskPct}% of the account (paper stays at 1%). New live entries only.` };
    }
    case 'set-leverage': {
      const before = await loadLiveLeverage(db);
      await saveSnapshot(db, LIVE_LEVERAGE_KEY, { byClass: { large: a.large, mid: a.mid, small: a.small }, largeCaps: a.largeCaps });
      await logControlEvent(db, 'set-leverage', { before, large: a.large, mid: a.mid, small: a.small, largeCaps: a.largeCaps }, source);
      return { message: `Leverage by coin size: large caps ${a.large}x, mid ${a.mid}x, small ${a.small}x (never above LIVE_LEVERAGE or the pair's maximum). Applies to new live entries; open positions keep theirs.` };
    }
    case 'new-paper-session': {
      const ended = await endPaperSession(db, source);
      return { message: `${ended != null ? `Paper session #${ended} ended (its trades stay on record). ` : ''}A new session with the current settings starts at the next 15-minute step.` };
    }
  }
}

/** A strategy's short name (e.g. "hybrid"); the slot name only for tiers without one. */
const shownModel = BOT_MODEL !== 'none' ? BOT_MODEL : LIVE_MODEL !== 'none' ? LIVE_MODEL : 'ema50';
const strategyName = (t: Tier) => botConfig(0, 0, shownModel).tiers[t]?.label?.split(' · ').pop() ?? t;
const RANK_TEXT: Record<RrgRank, string> = { position: 'position (strongest vs BTC)', heading: 'heading (RRG tail turning hardest the trade\'s way)', fastslow: 'fast + slow (both RRG presets turning)' };
const SELECTION_TEXT: Record<Selection, string> = { none: 'no filter (every signal)', range: 'daily range location', rrg: 'RRG vs BTC (position)', heading: 'RRG heading (tail turning the trade\'s way)', fastslow: 'RRG fast + slow agreeing', btcregime: 'BTC regime (BTC vs USD turning the trade\'s way)' };
const label = (s: PauseScope) => (s === 'ALL' ? 'all' : strategyName(s));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
