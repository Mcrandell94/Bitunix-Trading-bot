// Short filter per strategy (owner, 2026-09-28): no new short while the coin's
// weekly RSI(14) is at or above `w` (its bigger trend still strong). Longs are
// never filtered. On the 4H pullback, 55 was best tested (+34.5% -> +38.6%,
// same drawdown) though 53 and 57 did not help (docs/RESULTS.md). Kept as dated
// changes per strategy, so the paper replay applies each close with the
// setting that stood then; live follows paper.

import { TIERS_ALL, type Tier } from '@bot/risk';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export const SHORT_FILTER_KEY = 'short-filter';
export const DEFAULT_SHORT_W = 55;
export type ShortFilterChange = { at: number; on: boolean; w: number };
export type ShortFilters = Record<Tier, ShortFilterChange[]>;

export async function loadShortFilters(db: Db): Promise<ShortFilters> {
  const s = await loadSnapshot<Partial<ShortFilters>>(db, SHORT_FILTER_KEY);
  return Object.fromEntries(TIERS_ALL.map((t) => [t, s?.[t] ?? []])) as ShortFilters;
}

/** The level in force at `time`, or null when the filter was off (off until first switched on). */
export function shortFilterAt(history: ReadonlyArray<ShortFilterChange>, time: number): { w: number } | null {
  let cur: ShortFilterChange | null = null;
  for (const c of history) if (c.at <= time) cur = c;
  return cur?.on ? { w: cur.w } : null;
}

export function shortFilterNow(history: ReadonlyArray<ShortFilterChange>): { on: boolean; w: number } {
  const c = history.at(-1);
  return c ? { on: c.on, w: c.w } : { on: false, w: DEFAULT_SHORT_W };
}

/** Sets one strategy's filter from `now` on; false when nothing changes. */
export async function setShortFilter(db: Db, slot: Tier, v: { on: boolean; w: number }, now: number): Promise<boolean> {
  const cur = await loadShortFilters(db);
  const n = shortFilterNow(cur[slot]);
  if (n.on === v.on && (!v.on || n.w === v.w)) return false;
  await saveSnapshot(db, SHORT_FILTER_KEY, { ...cur, [slot]: [...cur[slot], { at: now, ...v }] });
  return true;
}
