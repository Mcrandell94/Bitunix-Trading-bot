// Same-direction alts cap (owner, 2026-09-28): how many altcoin positions (not
// BTC/ETH) one strategy may hold in the same direction, open or pending. The
// config's default is 2. Kept as dated changes, so the paper replay applies each
// close with the cap that stood then, and live follows paper.

import { loadSnapshot, saveSnapshot, type Db } from '@bot/store';

export const ALTS_CAP_KEY = 'alts-cap';
export const DEFAULT_ALTS_CAP = 2;
export type AltsCapChange = { at: number; n: number };

export async function loadAltsCap(db: Db): Promise<AltsCapChange[]> {
  return (await loadSnapshot<AltsCapChange[]>(db, ALTS_CAP_KEY)) ?? [];
}

/** The cap at `time`, or null before the first change (the config's default applies). */
export function altsCapAt(history: ReadonlyArray<AltsCapChange>, time: number): number | null {
  let n: number | null = null;
  for (const c of history) if (c.at <= time) n = c.n;
  return n;
}

export const altsCapNow = (history: ReadonlyArray<AltsCapChange>): number => history.at(-1)?.n ?? DEFAULT_ALTS_CAP;

/** Sets the cap from `now` on; false when it already is that. */
export async function setAltsCap(db: Db, n: number, now: number): Promise<boolean> {
  const cur = await loadAltsCap(db);
  if (altsCapNow(cur) === n) return false;
  await saveSnapshot(db, ALTS_CAP_KEY, [...cur, { at: now, n }]);
  return true;
}
