// Choppiness Index for the ETH card (owner 2026-10-11: "we'd want to know when chop is present and to hold off on longs,
// when chop is gone or fading can look for longs"; the 4H reading decides). The owner could not give a script, so this is
// the standard public formula (E.W. Dreiss; TradingView's built-in "Choppiness Index"):
//   CHOP(n) = 100 x log10( sum of the true range over n bars / (highest high - lowest low over n bars) ) / log10(n), n = 14
// 61.8 and 38.2 are the usual choppy / trending lines. States, fixed before the preview (plan, "chop.ts"):
//   chop      CHOP >= 61.8                                                   -> hold off on longs
//   fading    CHOP < 61.8 with a chop reading in the last 6 bars, or CHOP >= 61.8 and falling for 3 bars -> can look for longs
//   trending  CHOP < 38.2 (and not fading)
//   neutral   otherwise
// Pure.

import type { Candle } from '@bot/marketdata';
import { taHighest, taLowest, taSum, trueRange } from './pine';

export const CHOP = { len: 14, choppy: 61.8, trending: 38.2, fadeBars: 6, fallingBars: 3 } as const;
export type ChopState = 'chop' | 'fading' | 'trending' | 'neutral';

export function chopIndex(c: ReadonlyArray<Candle>, len: number = CHOP.len): number[] {
  const tr = taSum(trueRange(c), len), hh = taHighest(c.map((b) => b.high), len), ll = taLowest(c.map((b) => b.low), len);
  return c.map((_, i) => { const r = hh[i]! - ll[i]!; return r > 0 ? (100 * Math.log10(tr[i]! / r)) / Math.log10(len) : NaN; });
}

/** The state at bar i from the index series (NaN before it exists = 'neutral'). */
export function chopState(x: ArrayLike<number>, i: number): ChopState {
  const v = x[i]!;
  if (Number.isNaN(v)) return 'neutral';
  if (v >= CHOP.choppy) {
    let falling = true;
    for (let k = 0; k < CHOP.fallingBars; k++) { const a = x[i - k]!, b = x[i - k - 1]!; if (!(a < b)) { falling = false; break; } }
    return falling ? 'fading' : 'chop';
  }
  for (let k = 1; k <= CHOP.fadeBars && i - k >= 0; k++) if (x[i - k]! >= CHOP.choppy) return 'fading';
  return v < CHOP.trending ? 'trending' : 'neutral';
}
