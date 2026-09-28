// Room-to-TP1 filter per strategy (owner, 2026-09-28): skip a new entry when
// daily resistance (support for a short) sits between the entry and the first
// target. `zones`: only levels where 2+ daily swings cluster within 0.5 daily
// ATR count; otherwise any daily swing high/low does. Kept as dated changes per
// strategy, so the paper replay applies each close with the setting that stood
// then; live follows paper. With the RSI filter (62/70) it cut the 4H
// pullback's drawdown from about 23% to 16-18% at the same return (docs/RESULTS.md).

import { TIERS_ALL, type Tier } from '@bot/risk';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export const ROOM_FILTER_KEY = 'room-filter';
export type RoomMode = 'zones' | 'swing';
export const ROOM_MODES: readonly RoomMode[] = ['zones', 'swing'];
export type RoomFilterChange = { at: number; on: boolean; mode: RoomMode };
export type RoomFilters = Record<Tier, RoomFilterChange[]>;

export async function loadRoomFilters(db: Db): Promise<RoomFilters> {
  const s = await loadSnapshot<Partial<RoomFilters>>(db, ROOM_FILTER_KEY);
  return Object.fromEntries(TIERS_ALL.map((t) => [t, s?.[t] ?? []])) as RoomFilters;
}

/** The engine's setting at `time` (swings needed per level), or null when off (off until first switched on). */
export function roomFilterAt(history: ReadonlyArray<RoomFilterChange>, time: number): { minTouches: number } | null {
  let cur: RoomFilterChange | null = null;
  for (const c of history) if (c.at <= time) cur = c;
  return cur?.on ? { minTouches: cur.mode === 'zones' ? 2 : 1 } : null;
}

export function roomFilterNow(history: ReadonlyArray<RoomFilterChange>): { on: boolean; mode: RoomMode } {
  const c = history.at(-1);
  return c ? { on: c.on, mode: c.mode } : { on: false, mode: 'zones' };
}

/** Sets one strategy's filter from `now` on; false when nothing changes. */
export async function setRoomFilter(db: Db, slot: Tier, v: { on: boolean; mode: RoomMode }, now: number): Promise<boolean> {
  const cur = await loadRoomFilters(db);
  const n = roomFilterNow(cur[slot]);
  if (n.on === v.on && (!v.on || n.mode === v.mode)) return false;
  await saveSnapshot(db, ROOM_FILTER_KEY, { ...cur, [slot]: [...cur[slot], { at: now, ...v }] });
  return true;
}
