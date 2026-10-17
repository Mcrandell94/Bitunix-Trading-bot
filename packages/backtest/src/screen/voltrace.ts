// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Dynamic Volume Trace Profile [ChartPrime]" (Pine v6, © ChartPrime) for the owner's ETH / BTC
// cards (owner 2026-10-17, cards v3). Calculations only (no plots or boxes), default inputs: lookback 200, 25 bins,
// dynamic traces and the max volume trace on.
//
// Bar-for-bar notes:
// - Range: the highest high and lowest low of the last 100 bars (not the lookback); step = range / 25.
// - Traces i = 1 .. 24 at low + step x i (the script never sets trace 0, and trace 25 would be the high): each holds the
//   volume of the last 200 bars whose close is within one step of it (a close can count for two traces).
// - The traces are drawn with a gradient from no colour (no volume) to teal (the most); the trace(s) holding the most
//   volume are the max volume trace (POC, orange). The boxes on the last bar show each trace's volume and % of the max.
// - The card takes, on 4H and daily, the traces at 50% of the max or more (the bright ones) as liquidity levels.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';

export const VOLTRACE = { lookback: 200, range: 100, bins: 25, cardPct: 50 } as const;

export interface VolTrace { price: number; vol: number; pct: number; poc: boolean }
export interface VolTraceProfile { hi: number; lo: number; step: number; traces: VolTrace[] }

/** The traces as drawn on bar `at` (only bars up to it are read). */
export function volTrace(c: ReadonlyArray<Candle>, at: number): VolTraceProfile {
  const V = VOLTRACE, from = Math.max(0, at - V.range + 1), vol = coinVolume(c.slice(Math.max(0, at - V.lookback + 1), at + 1));
  let hi = -Infinity, lo = Infinity;
  for (let k = from; k <= at; k++) { hi = Math.max(hi, c[k]!.high); lo = Math.min(lo, c[k]!.low); }
  const step = (hi - lo) / V.bins, first = at - vol.length + 1, traces: VolTrace[] = [];
  for (let i = 1; i < V.bins; i++) {
    const price = lo + step * i;
    let v = 0;
    for (let k = first; k <= at; k++) if (Math.abs(c[k]!.close - price) <= step) v += vol[k - first] || 0;
    traces.push({ price, vol: v, pct: 0, poc: false });
  }
  const max = Math.max(...traces.map((x) => x.vol));
  for (const x of traces) { x.pct = max > 0 ? (x.vol / max) * 100 : 0; x.poc = max > 0 && x.vol === max; }
  return { hi, lo, step, traces };
}
