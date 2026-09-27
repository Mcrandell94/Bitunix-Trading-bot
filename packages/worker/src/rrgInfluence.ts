// RRG as a magnifying glass (owner): when several coins signal at the same
// close, try the ones strongest against BTC the trade's way first. It never
// adds or drops a signal; it only decides who gets a slot when a portfolio
// cap is full. One switch for paper, one for live, set from the dashboard.
// Each is kept as a history of flips so a paper replay applies the switch
// exactly when it was in force (like the entry pauses).
//
// In the 36-month backtest this ordering did worse than first come, first
// served (docs/RESULTS.md). Both switches start off (owner, 2026-09-27); RRG
// is still recorded on every trade for the forward test.
//
// How it ranks (owner, 2026-09-27): position = strongest vs BTC (the
// original); heading = the daily RRG tail turning hardest the trade's way;
// fastslow = the Balanced and Fast presets both turning (the weaker of the
// two). In the backtest none beat first come, first served reliably and all
// had larger drawdowns (docs/RESULTS.md). Flips made before the choice
// existed have no `by` and mean position.
//
// Which strategies use it (owner, 2026-09-27): each strategy card has its own
// RRG ranking switch, off by default; the card's ranking applies only to the
// strategies switched on (e.g. the 4H alone). Shared by paper and live, and
// dated like the card so a replay applies each flip from when it was made.

import type { RrgRank } from '@bot/backtest';
import { TIERS_ALL, type Tier } from '@bot/risk';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export type RrgWhere = 'paper' | 'live';
export type RrgFlip = { at: number; on: boolean; by?: RrgRank };
export const RRG_RANKS: readonly RrgRank[] = ['position', 'heading', 'fastslow'];
export type RrgInfluence = Record<RrgWhere, RrgFlip[]>;

export const RRG_INFLUENCE_KEY = 'rrg-influence';
export const DEFAULT_RRG_INFLUENCE: RrgInfluence = { paper: [{ at: 0, on: false }], live: [{ at: 0, on: false }] };

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

const rankOf = (f: RrgFlip | undefined): RrgRank | null => (f?.on ? f.by ?? 'position' : null);

/** How the switch ranked at `time` (the last flip at or before it); null = off (first come, first served). */
export function rrgRankAt(history: ReadonlyArray<RrgFlip>, time: number): RrgRank | null {
  let last: RrgFlip | undefined;
  for (const f of history) if (f.at <= time) last = f;
  return rankOf(last);
}

export const rrgRankNow = (history: ReadonlyArray<RrgFlip>) => rankOf(history.at(-1));

/** Sets a switch (and how it ranks) from `now` on; returns false when it was already there. */
export async function setRrgInfluence(db: Db, where: RrgWhere, on: boolean, now: number, by: RrgRank = 'position'): Promise<boolean> {
  const cur = await loadRrgInfluence(db);
  if (rrgRankNow(cur[where]) === (on ? by : null)) return false;
  await saveSnapshot(db, RRG_INFLUENCE_KEY, { ...cur, [where]: [...cur[where], on ? { at: now, on, by } : { at: now, on }] });
  return true;
}

export const RRG_RANK_SLOTS_KEY = 'rrg-rank-slots';
export type RankSlotFlip = { at: number; on: boolean };
export type RankSlots = Record<Tier, RankSlotFlip[]>;

export async function loadRankSlots(db: Db): Promise<RankSlots> {
  const s = await loadSnapshot<Partial<RankSlots>>(db, RRG_RANK_SLOTS_KEY);
  return Object.fromEntries(TIERS_ALL.map((t) => [t, s?.[t] ?? []])) as RankSlots;
}

/** Whether a strategy used the RRG ranking card at `time` (off until first switched on). */
export function rankSlotOnAt(history: ReadonlyArray<RankSlotFlip>, time: number): boolean {
  let on = false;
  for (const f of history) if (f.at <= time) on = f.on;
  return on;
}

export const rankSlotOnNow = (history: ReadonlyArray<RankSlotFlip>) => history.at(-1)?.on ?? false;

/** Switches one strategy's use of the ranking card from `now` on; false when it already was. */
export async function setRankSlot(db: Db, slot: Tier, on: boolean, now: number): Promise<boolean> {
  const cur = await loadRankSlots(db);
  if (rankSlotOnNow(cur[slot]) === on) return false;
  await saveSnapshot(db, RRG_RANK_SLOTS_KEY, { ...cur, [slot]: [...cur[slot], { at: now, on }] });
  return true;
}

/** Same flip history for paper and live (switch and ranking): one replay serves both. */
export const sameHistory = (a: ReadonlyArray<RrgFlip>, b: ReadonlyArray<RrgFlip>) =>
  a.length === b.length && a.every((f, i) => f.at === b[i]!.at && rankOf(f) === rankOf(b[i]!));
