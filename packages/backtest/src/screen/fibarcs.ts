// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Swing Fibonacci Arcs & Volume Profile
// [BigBeluga]" (© BigBeluga, TradingView Pine Script v6), shared under the same license: non-commercial use only (fine
// for the owner's own group, not for a paid one). Ported for the owner's ETH card (2026-10-11). Calculations only (no
// arcs, boxes or labels drawn), default inputs: swing structure 70, x / y scale 1.5, volume profile on.
//
// Bar-for-bar notes (Pine semantics kept):
// - A bar whose high equals the 70-bar highest high marks a swing high and turns the direction up; one whose low equals
//   the 70-bar lowest low marks a swing low and turns it down (both on one bar: down). On a direction change the swing
//   anchor is the opposite swing point (up: the last swing low; down: the last swing high), and the leg before it (the
//   previous swing point) sets the minimum arc height. The current extreme ("change") follows each new 70-bar high (up)
//   or low (down).
// - Arcs: half-ellipses centred on the anchor (bar, price), radii dx x r and dy x r for r in 0.236 .. 1, opening
//   upward when the extreme is at or above the anchor; dx = max(bars from anchor to extreme, 70) x 1.5, dy = max(the
//   swing's height, the previous leg's height) x 1.5. The card reports each arc's price at the last bar (where the arc
//   still spans it).
// - Volume profile from the anchor to the last bar: rows = clamp(range / (0.15 x ATR(100)), 10, 100), each bar's volume
//   spread over the rows within 2 row heights of its close (linear weight); the POC is the fullest row (first on ties).
//   Bitunix gives quote volume; it is turned into coin units with each bar's typical price.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taHighest, taLowest } from './pine';

export const FIBARCS = { swingLength: 70, xScale: 1.5, yScale: 1.5, ratios: [0.236, 0.382, 0.5, 0.618, 0.786, 1] as const } as const;
export interface FibArcs {
  /** 1 = the swing runs up from the anchor (a low), -1 = down from a high. */
  dir: 1 | -1;
  anchorBar: number;
  anchor: number;
  extremeBar: number;
  extreme: number;
  /** The previous leg's height (the arcs' minimum height before the 1.5 scale). */
  leg: number;
  /** Each arc's price at the last bar, or null when the arc no longer spans it. */
  arcs: { ratio: number; price: number | null }[];
  poc: number | null;
}
export interface FibSwingFlip { i: number; dir: 1 | -1; anchorBar: number; anchor: number }

/** The swing state after every bar (its flips) and the arcs / POC at the last bar. Null before a swing exists. */
export function fibArcs(c: ReadonlyArray<Candle>): { flips: FibSwingFlip[]; last: FibArcs | null } {
  const F = FIBARCS, H = taHighest(c.map((b) => b.high), F.swingLength), L = taLowest(c.map((b) => b.low), F.swingLength);
  const flips: FibSwingFlip[] = [];
  if (!c.length) return { flips, last: null };
  let Hi = 0, Hv = c[0]!.high, Li = 0, Lv = c[0]!.low, direction = false, prevDir = false;
  let prevHv = Hv, prevLv = Lv;
  let swingPrice = NaN, swingIndex = NaN, lockedY1 = NaN, lockedY2 = NaN, changeY = c[0]!.high, changeX = 0;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!;
    // Hv / Lv as they stood after the previous bar (Hv[1], Lv[1]).
    prevHv = Hv; prevLv = Lv;
    if (b.high === H[i]) { Hi = i; Hv = b.high; direction = true; }
    if (b.low === L[i]) { Li = i; Lv = b.low; direction = false; }
    if (i > 0 && direction !== prevDir) {
      if (direction) { changeY = b.high; swingPrice = Lv; swingIndex = Li; lockedY1 = Lv; lockedY2 = prevHv; }
      else { changeY = b.low; swingIndex = Hi; swingPrice = Hv; lockedY1 = Hv; lockedY2 = prevLv; }
      flips.push({ i, dir: direction ? 1 : -1, anchorBar: swingIndex, anchor: swingPrice });
    }
    if (!direction && b.low === L[i] && b.low <= changeY) { changeY = b.low; changeX = i; }
    if (direction && b.high === H[i] && b.high >= changeY) { changeY = b.high; changeX = i; }
    prevDir = direction;
  }
  if (Number.isNaN(swingIndex)) return { flips, last: null };
  const last = c.length - 1, rawDx = Math.abs(changeX - swingIndex), rawDy = Math.abs(changeY - swingPrice);
  const dx = Math.max(rawDx, 70) * F.xScale, dy = Math.max(rawDy, Math.abs(lockedY1 - lockedY2)) * F.yScale, up = changeY >= swingPrice;
  const arcs = F.ratios.map((r) => {
    const rx = dx * r, ry = dy * r, u = (last - swingIndex) / rx;
    return { ratio: r, price: rawDx > 0 && rawDy > 0 && rx > 0 && Math.abs(u) <= 1 ? swingPrice + (up ? 1 : -1) * ry * Math.sqrt(1 - u * u) : null };
  });
  return { flips, last: { dir: up ? 1 : -1, anchorBar: swingIndex, anchor: swingPrice, extremeBar: changeX, extreme: changeY, leg: Math.abs(lockedY1 - lockedY2), arcs, poc: volumePoc(c, swingIndex) } };
}

/** The script's volume-profile POC from bar `start` to the last bar. */
export function volumePoc(c: ReadonlyArray<Candle>, start: number): number | null {
  const last = c.length - 1, s = Math.min(start, last);
  if (last <= s) return null;
  let pMin = c[last]!.high, pMax = c[last]!.low;
  for (let i = s; i <= last; i++) { pMin = Math.min(pMin, c[i]!.low); pMax = Math.max(pMax, c[i]!.high); }
  if (!(pMax > pMin)) return null;
  const a = taAtr(c, 100)[last]! * 0.3, span = pMax - pMin, atrUse = Number.isNaN(a) ? span / 50 : a;
  const rows = Math.trunc(Math.min(Math.max(span / (atrUse * 0.5), 10), 100)), h = span / rows, bins = new Array<number>(rows).fill(0), vol = coinVolume(c);
  for (let i = s; i <= last; i++) {
    const cl = c[i]!.close, v = Number.isNaN(vol[i]!) ? 1 : vol[i]!, win = h * 2;
    for (let r = 0; r < rows; r++) { const d = Math.abs(cl - (pMin + r * h + h / 2)); if (d <= win) bins[r]! += v * Math.max(0, 1 - d / win); }
  }
  let best = 0, poc = 0;
  for (let r = 0; r < rows; r++) if (bins[r]! > best) { best = bins[r]!; poc = r; }
  return best > 0 ? pMin + (poc + 0.5) * h : null;
}
