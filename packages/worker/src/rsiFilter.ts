// Overbought filter per strategy (owner, 2026-09-28): no new long when the
// coin's weekly RSI(14) is at or above `w` or its daily RSI(14) at or above `d`.
// Shorts are never filtered. Kept as dated changes per strategy, so the paper
// replay applies each close with the setting that stood then; live follows paper.

import { TIERS_ALL, type Tier } from '@bot/risk';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export const RSI_FILTER_KEY = 'rsi-filter';
/** Tested best on the 4H pullback (weekly 62 / daily 70; 60 / 68 about the same, docs/RESULTS.md): the levels offered by default. */
export const DEFAULT_RSI_LEVELS = { w: 62, d: 70 } as const;
export type RsiFilterChange = { at: number; on: boolean; w: number; d: number };
export type RsiFilters = Record<Tier, RsiFilterChange[]>;

export async function loadRsiFilters(db: Db): Promise<RsiFilters> {
  const s = await loadSnapshot<Partial<RsiFilters>>(db, RSI_FILTER_KEY);
  return Object.fromEntries(TIERS_ALL.map((t) => [t, s?.[t] ?? []])) as RsiFilters;
}

/** The levels in force at `time`, or null when the filter was off (off until first switched on). */
export function rsiFilterAt(history: ReadonlyArray<RsiFilterChange>, time: number): { w: number; d: number } | null {
  let cur: RsiFilterChange | null = null;
  for (const c of history) if (c.at <= time) cur = c;
  return cur?.on ? { w: cur.w, d: cur.d } : null;
}

export function rsiFilterNow(history: ReadonlyArray<RsiFilterChange>): { on: boolean; w: number; d: number } {
  const c = history.at(-1);
  return c ? { on: c.on, w: c.w, d: c.d } : { on: false, ...DEFAULT_RSI_LEVELS };
}

/** Sets one strategy's filter from `now` on; false when nothing changes. */
export async function setRsiFilter(db: Db, slot: Tier, v: { on: boolean; w: number; d: number }, now: number): Promise<boolean> {
  const cur = await loadRsiFilters(db);
  const n = rsiFilterNow(cur[slot]);
  if (n.on === v.on && (!v.on || (n.w === v.w && n.d === v.d))) return false;
  await saveSnapshot(db, RSI_FILTER_KEY, { ...cur, [slot]: [...cur[slot], { at: now, ...v }] });
  return true;
}
