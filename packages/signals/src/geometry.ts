// Tail geometry on top of the dashboard's RRG points. Pure, bar-indexed.

import { quadrantOf, type Quadrant, type RrgPoint } from '@bot/rrg';
import type { QuadrantRun } from './types';

/** Mean distance travelled per bar over the last `bars` steps. */
export function tailVelocity(pts: ReadonlyArray<RrgPoint>, bars: number): number {
  const n = Math.min(bars, pts.length - 1);
  if (n <= 0) return 0;
  let d = 0;
  for (let i = pts.length - n; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    d += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return d / n;
}

/**
 * The quadrant a one-bar move passed through when it jumped diagonally
 * (e.g. Lagging straight to Leading), taken from the straight line between
 * the two points: whichever axis it crossed 100 on first. null when the
 * move isn't diagonal or goes exactly through 100/100.
 */
export function crossedThrough(a: RrgPoint, b: RrgPoint): Quadrant | null {
  const crossesX = (a.x >= 100) !== (b.x >= 100);
  const crossesY = (a.y >= 100) !== (b.y >= 100);
  if (!crossesX || !crossesY) return null;
  const tx = (100 - a.x) / (b.x - a.x);
  const ty = (100 - a.y) / (b.y - a.y);
  if (tx === ty) return null;
  return ty < tx ? quadrantOf(a.x, b.y) : quadrantOf(b.x, a.y);
}

/**
 * Run-length encoding of the quadrants visited, oldest first. A diagonal
 * one-bar jump gets a zero-bar run for the quadrant it passed through, so
 * Lagging→Leading in one bar still reads as Lagging→Improving→Leading.
 */
export function quadrantRuns(pts: ReadonlyArray<RrgPoint>): QuadrantRun[] {
  const runs: QuadrantRun[] = [];
  let prev: RrgPoint | undefined;
  for (const p of pts) {
    const q = quadrantOf(p.x, p.y);
    const via = prev ? crossedThrough(prev, p) : null;
    if (via) runs.push({ quadrant: via, bars: 0 });
    const last = runs[runs.length - 1];
    if (last && last.quadrant === q) last.bars++;
    else runs.push({ quadrant: q, bars: 1 });
    prev = p;
  }
  return runs;
}

/**
 * RS-Momentum fell into a trough and has come back up: the tail's lowest
 * momentum is neither its first point (it was falling into it) nor its last
 * (it has risen since).
 */
export function momentumTroughInside(tail: ReadonlyArray<RrgPoint>): boolean {
  if (tail.length < 3) return false;
  let j = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i]!.y < tail[j]!.y) j = i;
  return j > 0 && j < tail.length - 1;
}

export function endsWith<T>(seq: ReadonlyArray<T>, suffix: ReadonlyArray<T>): boolean {
  if (suffix.length > seq.length) return false;
  const off = seq.length - suffix.length;
  return suffix.every((v, i) => seq[off + i] === v);
}

/**
 * Where the tail is heading: the next `horizon` points, extrapolated from the
 * recent velocity (mean step over the last `steps` bars) plus half the recent
 * change in velocity (curvature: RRG tails rotate). The acceleration term is
 * capped at the velocity's own size so one jerky bar can't fling the path.
 */
export function projectPath(tail: ReadonlyArray<RrgPoint>, horizon: number, steps = 3): RrgPoint[] {
  const n = tail.length;
  if (n < 2) return [];
  const k = Math.min(steps, n - 1);
  const last = tail[n - 1]!;
  const from = tail[n - 1 - k]!;
  const v = { x: (last.x - from.x) / k, y: (last.y - from.y) / k };
  let a = { x: 0, y: 0 };
  if (n >= 3) {
    const p1 = tail[n - 2]!;
    const p0 = tail[n - 3]!;
    a = { x: (last.x - p1.x) - (p1.x - p0.x), y: (last.y - p1.y) - (p1.y - p0.y) };
    const vs = Math.hypot(v.x, v.y);
    const as = Math.hypot(a.x, a.y);
    if (as > vs && as > 0) a = { x: (a.x / as) * vs, y: (a.y / as) * vs };
  }
  const out: RrgPoint[] = [];
  for (let h = 1; h <= horizon; h++) {
    out.push({ ...last, x: last.x + v.x * h + 0.5 * a.x * h * h, y: last.y + v.y * h + 0.5 * a.y * h * h });
  }
  return out;
}

/** Bars until the projected path first enters `target` (1..horizon), or null if it doesn't. */
export function barsToQuadrant(tail: ReadonlyArray<RrgPoint>, target: Quadrant, horizon: number): number | null {
  const path = projectPath(tail, horizon);
  const i = path.findIndex((p) => quadrantOf(p.x, p.y) === target);
  return i < 0 ? null : i + 1;
}
