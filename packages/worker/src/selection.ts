// Selection filter switch for the pullback slots (owner, 2026-09-27): per slot
// (1H, 4H), choose which layer picks the coins its signals may trade:
//   none  - every signal,
//   range - the daily close in the upper 55% of its last 20 daily bars (short: lower),
//   rrg   - the coin's daily RRG vs BTC strong the trade's way.
// Kept as a history of flips so the paper replay applies each choice exactly
// from when it was made (like the entry pauses); until the first flip the
// slot's code default applies (1H: rrg, 4H: none).

import type { Selection } from '@bot/backtest';
import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export type SelectionSlot = 'P1H' | 'P4H';
export const SELECTION_SLOTS: readonly SelectionSlot[] = ['P1H', 'P4H'];
export const SELECTIONS: readonly Selection[] = ['none', 'range', 'rrg'];
export type SelectionFlip = { at: number; value: Selection };
export type SelectionHistory = Record<SelectionSlot, SelectionFlip[]>;

export const SELECTION_KEY = 'selection';

export async function loadSelection(db: Db): Promise<SelectionHistory> {
  const s = await loadSnapshot<Partial<SelectionHistory>>(db, SELECTION_KEY);
  return { P1H: s?.P1H ?? [], P4H: s?.P4H ?? [] };
}

/** The switch's value at `time`, or null before the first flip (the code default applies). */
export function selectionAt(history: ReadonlyArray<SelectionFlip>, time: number): Selection | null {
  let v: Selection | null = null;
  for (const f of history) if (f.at <= time) v = f.value;
  return v;
}

/** Sets a slot's filter from `now` on; false when it already was that. `current` is the value in force (default included). */
export async function setSelection(db: Db, slot: SelectionSlot, value: Selection, current: Selection, now: number): Promise<boolean> {
  if (current === value) return false;
  const h = await loadSelection(db);
  await saveSnapshot(db, SELECTION_KEY, { ...h, [slot]: [...h[slot], { at: now, value }] });
  return true;
}
