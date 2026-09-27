// RRG as a magnifying glass (owner): when several coins signal at the same
// close, try the ones strongest against BTC the trade's way first. It never
// adds or drops a signal; it only decides who gets a slot when a portfolio
// cap is full. One switch for paper, one for live, set from the dashboard.
// Each is kept as a history of flips so a paper replay applies the switch
// exactly when it was in force (like the entry pauses).
//
// In the 36-month backtest this ordering did worse than first come, first
// served (docs/RESULTS.md); paper runs it on (owner's choice) to test it
// forward, live stays off unless switched on.

import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export type RrgWhere = 'paper' | 'live';
export type RrgFlip = { at: number; on: boolean };
export type RrgInfluence = Record<RrgWhere, RrgFlip[]>;

export const RRG_INFLUENCE_KEY = 'rrg-influence';
export const DEFAULT_RRG_INFLUENCE: RrgInfluence = { paper: [{ at: 0, on: true }], live: [{ at: 0, on: false }] };

export async function loadRrgInfluence(db: Db): Promise<RrgInfluence> {
  const s = await loadSnapshot<Partial<RrgInfluence>>(db, RRG_INFLUENCE_KEY);
  return { paper: s?.paper?.length ? s.paper : DEFAULT_RRG_INFLUENCE.paper, live: s?.live?.length ? s.live : DEFAULT_RRG_INFLUENCE.live };
}

/** Whether the switch was on at `time` (the last flip at or before it). */
export function rrgOnAt(history: ReadonlyArray<RrgFlip>, time: number): boolean {
  let on = false;
  for (const f of history) if (f.at <= time) on = f.on;
  return on;
}

export const rrgOnNow = (history: ReadonlyArray<RrgFlip>) => history.at(-1)?.on ?? false;

/** Flips a switch from `now` on; returns false when it was already there. */
export async function setRrgInfluence(db: Db, where: RrgWhere, on: boolean, now: number): Promise<boolean> {
  const cur = await loadRrgInfluence(db);
  if (rrgOnNow(cur[where]) === on) return false;
  await saveSnapshot(db, RRG_INFLUENCE_KEY, { ...cur, [where]: [...cur[where], { at: now, on }] });
  return true;
}

/** Same flip history for paper and live: one replay serves both. */
export const sameHistory = (a: ReadonlyArray<RrgFlip>, b: ReadonlyArray<RrgFlip>) =>
  a.length === b.length && a.every((f, i) => f.at === b[i]!.at && f.on === b[i]!.on);
