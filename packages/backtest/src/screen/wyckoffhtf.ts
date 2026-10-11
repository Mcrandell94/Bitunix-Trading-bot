// The Wyckoff [theUltimator5] script's higher-timeframe override (its default "Allow HTF to Override Current TF" = on,
// mtfLevelsAbove = 3), ported for the owner's ETH card (2026-10-11: "apply Wyckoff and see if we get more complete
// results, if no drop"). Same licence note as wyckoff.ts.
//
// Bar-for-bar notes (Pine semantics kept):
// - The script scans the next three timeframes above the chart's in its list (1, 3, 5, 15, 30, 60, 120, 240, D, W, M):
//   on 4H it runs the engine on D, W and M, on 1D on W and M. Each one's state is `f_engineHTF()` = the engine's value
//   on the previous higher-timeframe bar, read with lookahead_on: the last higher-timeframe bar fully closed by the
//   chart bar's open (no look-ahead).
// - The chart's own structure counts when its phase is past "none" and it has a stop side; its utility gets +5. A higher
//   timeframe's structure (phase past none, a stop side) replaces the current pick when its phase is farther, or equal
//   with a higher utility (f_mtfUtility: validation + phase x 4 - distance outside the range x 12 (max 36) - (age in its
//   bars - 20) x 0.35 (max 25), Phase E -10).
// - Weekly bars start Monday 00:00 UTC and monthly bars on the 1st, both built from the Bitunix daily bars; the last one
//   can be partial (it is only read once it has closed). Timeframe seconds as Pine's timeframe.in_seconds (M =
//   2,628,003).
// Pure.

import type { Candle } from '@bot/marketdata';
import { DIR_NONE, PHASE_E, PHASE_NONE, wyckoff, type WyckoffBar, type WyckoffResult } from './wyckoff';

const DAY = 86_400_000;
export type WyTf = '4H' | '1D' | 'D' | 'W' | 'M';
export const TF_SECS: Record<WyTf, number> = { '4H': 14_400, '1D': 86_400, D: 86_400, W: 604_800, M: 2_628_003 };
export interface HtfSeries { tf: WyTf; c: Candle[]; ends: number[]; wy: WyckoffResult }

/** Weekly (Monday 00:00 UTC) or monthly bars from daily bars, with each bar's end time. */
export function aggregate(d1: ReadonlyArray<Candle>, unit: 'W' | 'M'): { c: Candle[]; ends: number[] } {
  const c: Candle[] = [], ends: number[] = [];
  const start = (t: number) => { const d = new Date(t); if (unit === 'M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); const day = Math.floor(t / DAY) * DAY; return day - ((d.getUTCDay() + 6) % 7) * DAY; };
  const end = (s: number) => { if (unit === 'W') return s + 7 * DAY; const d = new Date(s); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
  for (const b of d1) {
    const s = start(b.openTime), l = c.at(-1);
    if (l && l.openTime === s) { l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; l.volume = (l.volume ?? 0) + (b.volume ?? 0); }
    else { c.push({ ...b, openTime: s }); ends.push(end(s)); }
  }
  return { c, ends };
}

/** The higher-timeframe engines from the daily history: D (the daily bars themselves), W and M. */
export function htfSeries(d1: ReadonlyArray<Candle>, tfs: ReadonlyArray<'D' | 'W' | 'M'>): HtfSeries[] {
  return tfs.map((tf) => {
    const { c, ends } = tf === 'D' ? { c: [...d1], ends: d1.map((b) => b.openTime + DAY) } : aggregate(d1, tf);
    return { tf, c, ends, wy: wyckoff(c, TF_SECS[tf] * 1000) };
  });
}

/** f_mtfUtility for a structure seen at a chart bar (its close and open time). */
export function mtfUtility(b: WyckoffBar, close: number, time: number, secs: number, isChart: boolean, tick = 0.01): number {
  const hasRange = !Number.isNaN(b.rangeHigh) && !Number.isNaN(b.rangeLow), h = hasRange ? Math.max(Math.abs(b.rangeHigh - b.rangeLow), tick) : NaN;
  const d = Number.isNaN(h) ? 0 : close > b.rangeHigh ? (close - b.rangeHigh) / h : close < b.rangeLow ? (b.rangeLow - close) / h : 0;
  const age = !Number.isNaN(b.lastEventTime) ? Math.max((time - b.lastEventTime) / (Math.max(secs, 1) * 1000), 0) : 0;
  const u = b.val + b.phase * 4 - Math.min(d * 12, 36) - Math.min(Math.max(age - 20, 0) * 0.35, 25) + (isChart ? 5 : 0);
  return b.phase === PHASE_E ? u - 10 : u;
}

export interface WyEff { tf: WyTf; bar: WyckoffBar }
/** The structure the script shows at each chart bar: its own, or a higher timeframe's (see the header). */
export function wyckoffEffective(c: ReadonlyArray<Candle>, own: WyckoffResult, ownTf: '4H' | '1D', htfs: ReadonlyArray<HtfSeries>): WyEff[] {
  const out: WyEff[] = [], ptr = htfs.map(() => -1);
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, ob = own.bars[i]!;
    let ef: WyEff = { tf: ownTf, bar: ob }, efU = ob.phase > PHASE_NONE && ob.stop !== DIR_NONE ? mtfUtility(ob, b.close, b.openTime, TF_SECS[ownTf], true) : -1000;
    htfs.forEach((h, k) => {
      while (ptr[k]! + 1 < h.ends.length && h.ends[ptr[k]! + 1]! <= b.openTime) ptr[k] = ptr[k]! + 1;
      const m = ptr[k]! >= 0 ? h.wy.bars[ptr[k]!]! : null;
      if (!m || m.stop === DIR_NONE || !(m.phase > PHASE_NONE)) return;
      const u = mtfUtility(m, b.close, b.openTime, TF_SECS[h.tf], false);
      if (m.phase > ef.bar.phase || (m.phase === ef.bar.phase && u > efU)) { ef = { tf: h.tf, bar: m }; efU = u; }
    });
    out.push(ef);
  }
  return out;
}
