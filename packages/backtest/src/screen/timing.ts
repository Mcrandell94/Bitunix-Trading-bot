// Baselines for one-sided lines (2026-10-09). The same entry in a random direction (scalp2.ts `flip`) cannot see drift:
// R is in price terms, so a long-only line earns about +0.1 R on random-walk prices from drift alone. The timing
// baseline enters the same side at random bars in the span after the entry, with the same stop % and exit; twins from
// before the entry lose by construction for setups that need price to come into a level first. On random walks the
// timing edge averages about 0 (docs/RESULTS.md "SMC top-down model").

import type { Candle } from '@bot/marketdata';
import { specTrade, type ExitSpec } from './exits';
import { flip } from './scalp2';
import { statsLine, type SignalTrade } from './rsitrades';

/** Seeded index in [0, n) per (seed, coin, bar): FNV-1a then the murmur3 finaliser (as `coin` in scalp2.ts). */
export const pick = (seed: number, sym: string, j: number, n: number) => {
  let h = 2166136261 ^ Math.imul(seed, 0x9e3779b1);
  for (const ch of `${sym}|${j}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) % n;
};

/** R of the same entry and stop distance in a random direction, one per seed 1..seeds. */
export function randomDirectionTwins(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, sym: string, j: number, stop: number, side: 1 | -1, spec: ExitSpec, seeds: number): number[] {
  const entry = c[j]!.open, dist = Math.abs(entry - stop), out: number[] = [];
  for (let k = 1; k <= seeds; k++) {
    const d = (flip(k, sym, j) ? -side : side) as 1 | -1, x = specTrade(c, atr, {}, j, entry - d * dist, d, spec);
    if (x) out.push(x.r);
  }
  return out;
}

/**
 * R of the same side entered at random bars in (j, j + span] (not before `minJ`, not past the second-last bar), with the
 * same stop % and exit, one per seed 1..seeds.
 */
export function randomTimeTwins(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, sym: string, j: number, stop: number, side: 1 | -1, spec: ExitSpec, span: number, seeds: number, minJ = 0): number[] {
  const entry = c[j]!.open, dist = Math.abs(entry - stop), lo = Math.max(minJ, j + 1), hi = Math.min(c.length - 2, j + span), out: number[] = [];
  for (let k = 1; k <= seeds && hi >= lo; k++) {
    const j2 = lo + pick(k, sym, j, hi - lo + 1), e2 = c[j2]!.open, x = specTrade(c, atr, {}, j2, e2 - side * e2 * (dist / entry), side, spec);
    if (x) out.push(x.r);
  }
  return out;
}

export interface TimedRow extends SignalTrade { rand: number[]; rtime: number[] }

/** The mean of each trade's R minus the mean of its own random-time twins (trades that have twins), with its t value. */
export function timingEdge(xs: ReadonlyArray<{ r: number; rtime: ReadonlyArray<number> }>): { mean: number; t: number; n: number } {
  const diffs = xs.filter((x) => x.rtime.length).map((x) => x.r - x.rtime.reduce((p, q) => p + q, 0) / x.rtime.length);
  const n = diffs.length, mean = diffs.reduce((p, q) => p + q, 0) / Math.max(1, n);
  const sd = Math.sqrt(diffs.reduce((p, q) => p + (q - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, n };
}

/** statsLine, the random-direction baseline and edge, the random-time baseline, and the timing edge (t; before / after the cut). */
export function timingLine(label: string, xs: ReadonlyArray<TimedRow>, cut: number): string {
  const avg = (a: number[]) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
  const real = avg(xs.map((x) => x.r)), rnd = avg(xs.flatMap((x) => x.rand)), rt = avg(xs.flatMap((x) => x.rtime));
  const all = timingEdge(xs), old = timingEdge(xs.filter((x) => x.t < cut)), neu = timingEdge(xs.filter((x) => x.t >= cut));
  const f = (e: { mean: number; n: number }) => (e.n ? e.mean.toFixed(2) : '-');
  return `${statsLine(label, [...xs], cut)}   random ${rnd.toFixed(2)}, edge ${(real - rnd).toFixed(2)}; random time ${rt.toFixed(2)}, timing edge ${all.mean.toFixed(2)} (t ${all.t.toFixed(1)}), older ${f(old)} / newer ${f(neu)}`;
}
