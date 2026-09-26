// Per-symbol, per-benchmark signal classifier. Reads the RRG position from
// closes only; volume, trend and funding never enter here (they only score).

import {
  computeSeries, firstValidIndex, heading, quadrantOf, quadrantStreak,
  type Heading, type Quadrant, type RrgPoint,
} from '@bot/rrg';
import type { ClassifierConfig } from './config';
import { barsToQuadrant, endsWith, momentumTroughInside, quadrantRuns, tailVelocity } from './geometry';
import type { Benchmark, Classification, RrgReading } from './types';

// Enough runs for the longest rule (Leading→Weakening→Lagging) plus one
// for context.
const PATH_RUNS = 4;

const LABEL: Record<Quadrant, string> = {
  leading: 'Leading', weakening: 'Weakening', lagging: 'Lagging', improving: 'Improving',
};

/**
 * RRG reading of `asset` against `bench` at the last bar. Points built from
 * partial rolling windows are dropped first, as on the dashboard. null when
 * too little valid history is left.
 */
export function readRrg(
  asset: ReadonlyArray<number>,
  bench: ReadonlyArray<number>,
  benchmark: Benchmark,
  cfg: ClassifierConfig,
): RrgReading | null {
  const settings = {
    trendWindow: cfg.trendWindow,
    momentumWindow: cfg.momentumWindow,
    smoothing: cfg.smoothing,
    zscore: cfg.zscore,
  };
  return readPoints(computeSeries(asset, bench, settings).slice(firstValidIndex(settings)), benchmark, cfg);
}

/** Same as readRrg, from RRG points that are already all valid. */
export function readPoints(
  history: ReadonlyArray<RrgPoint>,
  benchmark: Benchmark,
  cfg: ClassifierConfig,
): RrgReading | null {
  if (history.length < Math.max(cfg.tailLength, cfg.headingLookbackBars) + 1) return null;
  const last = history[history.length - 1]!;
  const runs = quadrantRuns(history);
  return {
    benchmark,
    point: { ...last },
    quadrant: quadrantOf(last.x, last.y),
    barsInQuadrant: quadrantStreak(history).days,
    cameFrom: runs[runs.length - 2]?.quadrant ?? null,
    heading: heading(history, cfg.headingLookbackBars),
    tailVelocity: tailVelocity(history, cfg.tailLength),
    path: runs.slice(-PATH_RUNS),
    tail: history.slice(-(cfg.tailLength + 1)).map((p) => ({ ...p })),
  };
}

function isSteepNE(h: Heading, minDeg: number): boolean {
  return h.dx >= 0 && h.dy > 0 && h.deg >= minDeg && h.deg <= 90;
}

function describeHeading(h: Heading): string {
  return `heading ${h.arrow} ${h.deg.toFixed(0)}°`;
}

function describeEntry(r: RrgReading): string {
  const n = r.barsInQuadrant - 1;
  const ago = n === 0 ? 'this bar' : `${n} bar${n === 1 ? '' : 's'} ago`;
  return `vs ${r.benchmark}: ${LABEL[r.cameFrom ?? r.quadrant]}→${LABEL[r.quadrant]} ${ago}`;
}

/**
 * Classifies one reading. At most one signal fires, since each lives in a
 * different quadrant:
 * - LEADING_ENTRY (long): Improving→Leading within `freshBars`, heading rising.
 * - LAGGING_BREAKOUT (long, mainly MTF): Lagging→Improving within `freshBars`
 *   (that transition is RS-Momentum crossing 100 from below), heading steep
 *   NE, tail velocity at or above `breakoutMinVelocity`.
 * - WEAKENING_HOOK (long): RS-Ratio >= 100, RS-Momentum < 100, heading turned
 *   up: dy > 0 now after falling into a momentum trough inside the tail.
 * - SHORT_ROLLOVER (short): entered Lagging within `freshBars`, either via
 *   Leading→Weakening→Lagging (however long it sat in Weakening) or as a
 *   failed Improving→Lagging.
 * Transitions are read from consecutive quadrant runs, so a diagonal
 * one-bar jump counts as passing through the quadrant between (see
 * quadrantRuns).
 */
export function classifyReading(r: RrgReading, cfg: ClassifierConfig): Classification | null {
  const main = classifyMain(r, cfg);
  if (main || !cfg.earlySignals) return main;
  return classifyEarly(r, cfg);
}

/**
 * Early reads, only when no main signal fired:
 * - EARLY_TURN (long): in Lagging, momentum made a trough inside the tail and
 *   is rising, and the projected tail reaches Improving within projectionBars.
 * - IMPROVING_ENTRY (long): entered Improving within freshBars, heading up
 *   and right (dx > 0, dy > 0), without LAGGING_BREAKOUT's steep/fast gates.
 * - EARLY_ROLLOVER (short): in Weakening, RS-Ratio falling (dx < 0) and the
 *   projected tail reaches Lagging within projectionBars.
 * Each needs tail velocity >= earlyMinVelocity.
 */
function classifyEarly(r: RrgReading, cfg: ClassifierConfig): Classification | null {
  const h = r.heading;
  if (!h || r.tailVelocity < cfg.earlyMinVelocity) return null;
  switch (r.quadrant) {
    case 'lagging': {
      if (!(h.dy > 0) || !momentumTroughInside(r.tail)) return null;
      const bars = barsToQuadrant(r.tail, 'improving', cfg.projectionBars);
      if (bars == null) return null;
      return { signal: 'EARLY_TURN', direction: 'long', reasons: [`vs ${r.benchmark}: Lagging but momentum turned up, ${describeHeading(h)}, projected into Improving in ~${bars} bar(s)`] };
    }
    case 'improving':
      if (r.barsInQuadrant <= cfg.freshBars && h.dx > 0 && h.dy > 0) {
        return { signal: 'IMPROVING_ENTRY', direction: 'long', reasons: [`${describeEntry(r)}, ${describeHeading(h)}`] };
      }
      return null;
    case 'weakening': {
      if (!(h.dx < 0)) return null;
      const bars = barsToQuadrant(r.tail, 'lagging', cfg.projectionBars);
      if (bars == null) return null;
      return { signal: 'EARLY_ROLLOVER', direction: 'short', reasons: [`vs ${r.benchmark}: Weakening with RS-Ratio falling, ${describeHeading(h)}, projected into Lagging in ~${bars} bar(s)`] };
    }
    default:
      return null;
  }
}

function classifyMain(r: RrgReading, cfg: ClassifierConfig): Classification | null {
  const h = r.heading;
  const fresh = r.barsInQuadrant <= cfg.freshBars;

  switch (r.quadrant) {
    case 'leading':
      if (r.cameFrom === 'improving' && fresh && h && h.dy > 0) {
        return {
          signal: 'LEADING_ENTRY',
          direction: 'long',
          reasons: [`${describeEntry(r)}, ${describeHeading(h)}`],
        };
      }
      return null;

    case 'improving':
      if (
        r.cameFrom === 'lagging' && fresh && h
        && isSteepNE(h, cfg.breakoutMinHeadingDeg)
        && r.tailVelocity >= cfg.breakoutMinVelocity
      ) {
        return {
          signal: 'LAGGING_BREAKOUT',
          direction: 'long',
          reasons: [
            `${describeEntry(r)} (RS-Momentum crossed 100), ${describeHeading(h)}, tail velocity ${r.tailVelocity.toFixed(2)}/bar`,
          ],
        };
      }
      return null;

    case 'weakening':
      if (h && h.dy > 0 && momentumTroughInside(r.tail)) {
        return {
          signal: 'WEAKENING_HOOK',
          direction: 'long',
          reasons: [`vs ${r.benchmark}: Weakening for ${r.barsInQuadrant} bars, momentum hooked up, ${describeHeading(h)}`],
        };
      }
      return null;

    case 'lagging': {
      if (!fresh) return null;
      const seq = r.path.map((p) => p.quadrant);
      if (endsWith(seq, ['leading', 'weakening', 'lagging'])) {
        return {
          signal: 'SHORT_ROLLOVER',
          direction: 'short',
          reasons: [`vs ${r.benchmark}: rolled over Leading→Weakening→Lagging, in Lagging ${r.barsInQuadrant} bar(s)`],
        };
      }
      if (endsWith(seq, ['improving', 'lagging'])) {
        return {
          signal: 'SHORT_ROLLOVER',
          direction: 'short',
          reasons: [`vs ${r.benchmark}: failed Improving→Lagging, in Lagging ${r.barsInQuadrant} bar(s)`],
        };
      }
      return null;
    }
  }
}
