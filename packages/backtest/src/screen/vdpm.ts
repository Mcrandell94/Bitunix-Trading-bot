// This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Volume Delta Pivot Matrix [BigBeluga]" (Pine
// v6, © BigBeluga) for the owner's ETH / BTC cards (owner 2026-10-17, cards v3). Calculations only (no lines or
// labels), default inputs: pivot length 5, 10 levels, minimum delta 20%. This port is shared under the same licence:
// non-commercial use only.
//
// Bar-for-bar notes:
// - The script runs on the chart's last 5000 bars only (calc_bars_count), so its state starts 4999 bars before bar i.
// - Pivots: pivothigh(high, 5, 5) is a resistance level, pivotlow(low, 5, 5) a support level, each with the delta of
//   the 11 bars around it (the pivot ± 5): volume x (2 x (close - low) / (high - low) - 1), or ±volume by the candle's
//   colour when the bar has no range.
// - A support is removed once a close is at or under it, a resistance once a close is at or over it.
// - Shown (the last bar): the 10 newest levels left; each one's delta as a % of the largest |delta| of those 10; levels
//   under 20% are not drawn.
// - The card takes the shown levels as S/R levels.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';
import { pinePivot } from './srbreaks';

export const VDPM = { len: 5, maxLevels: 10, minPct: 20, window: 5000 } as const;

export interface VdpmLevel { level: number; delta: number; support: boolean; /** The pivot bar. */ at: number; /** |delta| as a % of the largest of the 10 kept. */ pct: number }

/** The levels at the close of bar i (bars up to i only): those not broken, and the ones drawn (newest first). */
export function vdpm(c: ReadonlyArray<Candle>, i: number = c.length - 1): { open: VdpmLevel[]; shown: VdpmLevel[] } {
  const { len, maxLevels, minPct, window } = VDPM;
  if (i < 0 || i >= c.length) return { open: [], shown: [] };
  const start = Math.max(0, i - window + 1), cc = c.slice(start, i + 1), vol = coinVolume(cc), hi = cc.map((b) => b.high), lo = cc.map((b) => b.low);
  const delta = (k: number) => {
    let d = 0;
    for (let q = 0; q <= 2 * len; q++) {
      const b = cc[k - q]!, r = b.high - b.low;
      d += r > 0 ? vol[k - q]! * (((b.close - b.low) / r) * 2 - 1) : b.close >= b.open ? vol[k - q]! : -vol[k - q]!;
    }
    return d;
  };
  let open: VdpmLevel[] = [];
  for (let k = 0; k < cc.length; k++) {
    const ph = pinePivot(hi, k, len, len, true), pl = pinePivot(lo, k, len, len, false);
    if (ph != null) open.push({ level: ph, delta: delta(k), support: false, at: start + k - len, pct: NaN });
    if (pl != null) open.push({ level: pl, delta: delta(k), support: true, at: start + k - len, pct: NaN });
    const close = cc[k]!.close;
    open = open.filter((x) => !(x.support ? close <= x.level : close >= x.level));
  }
  const kept = open.slice(-maxLevels), max = Math.max(0.0001, ...kept.map((x) => Math.abs(x.delta)));
  const scored = kept.map((x) => ({ ...x, pct: (Math.abs(x.delta) / max) * 100 }));
  return { open: scored, shown: [...scored].reverse().filter((x) => !(x.pct < minPct)) };
}
