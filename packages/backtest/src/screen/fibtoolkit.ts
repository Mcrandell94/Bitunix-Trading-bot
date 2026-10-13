// TypeScript port of "Fibonacci Confluence Toolkit [LuxAlgo]" (Pine v5) for the owner's ETH / BTC cards (owner
// 2026-10-13, cards v2, second batch). Calculations only (no lines, boxes, labels or engulfing marks), default inputs:
// both structures on, levels 0 / 0.382 / 0.5 / 0.618 / 0.786 / 1 shown (0.236 and 0.65 off).
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© LuxAlgo). Non-commercial: fine for the owner's
// own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes (the order inside a bar follows the script):
// - Short-term swings: a low under the lows on each side (low[2] > low[1] <= low) records low[1]; highs mirrored.
// - Intermediate swings: a short-term low under the short-term lows on each side (prev > mid <= last), taken once on
//   the bar it first holds; highs mirrored. Long-term swings: the same one level up, from the intermediate swings.
// - Structure: a close over the last long-term high (once per high) is a bullish break; it is a CHoCH when the last
//   break was bearish (otherwise a BOS). On a bullish CHoCH the lowest low from the broken high's bar to this bar
//   (the latest of equal lows) is the CHoCH low; the "area of interest" lasts while lows stay over it. Bearish mirrored
//   (closes under the last long-term low, the highest high).
// - Fibs: when the next long-term high is recorded after a bullish CHoCH (no other break since, not drawn yet for that
//   CHoCH), a retracement is drawn from the CHoCH low (1) up to that high (0): level x = high - (high - low) x x. The
//   lines extend while the area of interest lasts; when it ends they stay where they stopped. Bearish mirrored: from the
//   CHoCH high (1) down to the next long-term low (0), level x = low + (high - low) x x.
// Pure.

import type { Candle } from '@bot/marketdata';

export const LUXFIB = { levels: [0, 0.382, 0.5, 0.618, 0.786, 1] } as const;

export interface LuxFibSet {
  dir: 1 | -1; hi: number; hiAt: number; lo: number; loAt: number;
  /** The bar it was drawn and the last bar its lines reached (they stop when the CHoCH's area of interest ends). */
  createdAt: number; lastAt: number;
}
export interface LuxChoch { dir: 1 | -1; i: number; level: number; levelAt: number; extreme: number; extremeAt: number }
export interface LuxSwing { price: number; at: number; i: number }

export const luxFibPrice = (s: LuxFibSet, x: number) => (s.dir > 0 ? s.hi - (s.hi - s.lo) * x : s.lo + (s.hi - s.lo) * x);
/** The sets whose lines reach bar i (at most one per side). */
export const luxFibLive = (sets: ReadonlyArray<LuxFibSet>, i: number) => sets.filter((s) => s.createdAt <= i && s.lastAt >= i);

interface Tri { last: number; mid: number; prev: number; lastI: number; midI: number; prevI: number }
const tri = (): Tri => ({ last: NaN, mid: NaN, prev: NaN, lastI: -1, midI: -1, prevI: -1 });
const push = (t: Tri, p: number, i: number) => { t.prev = t.mid; t.mid = t.last; t.last = p; t.prevI = t.midI; t.midI = t.lastI; t.lastI = i; };
/** queryPatterns: the middle one is a swing (comparisons with na are false). */
const q = (t: Tri, high: boolean) => (high ? t.prev < t.mid && t.mid >= t.last : t.prev > t.mid && t.mid <= t.last);

interface Lt { price: number; at: number; crossed: boolean; choch: boolean; measure: boolean | null; lwest: number; hghst: number; zoneTop: number; zoneBot: number; extremeAt: number }
const lt = (): Lt => ({ price: NaN, at: -1, crossed: false, choch: false, measure: null, lwest: NaN, hghst: NaN, zoneTop: NaN, zoneBot: NaN, extremeAt: -1 });

export function fibToolkit(c: ReadonlyArray<Candle>): { sets: LuxFibSet[]; chochs: LuxChoch[]; swings: { st: { lo: LuxSwing[]; hi: LuxSwing[] }; it: { lo: LuxSwing[]; hi: LuxSwing[] }; lt: { lo: LuxSwing[]; hi: LuxSwing[] } } } {
  const stL = tri(), stH = tri(), itL = tri(), itH = tri(), ltL = lt(), ltH = lt();
  const ms = { last: 0, prev: 0 }, sets: LuxFibSet[] = [], chochs: LuxChoch[] = [];
  const swings = { st: { lo: [] as LuxSwing[], hi: [] as LuxSwing[] }, it: { lo: [] as LuxSwing[], hi: [] as LuxSwing[] }, lt: { lo: [] as LuxSwing[], hi: [] as LuxSwing[] } };
  let cITL = false, cITH = false, cLTL = false, cLTH = false, bull: LuxFibSet | null = null, bear: LuxFibSet | null = null;
  for (let i = 2; i < c.length; i++) {
    const b = c[i]!, b1 = c[i - 1]!, b2 = c[i - 2]!;
    if (b2.low > b1.low && b1.low <= b.low) { push(stL, b1.low, i - 1); swings.st.lo.push({ price: b1.low, at: i - 1, i }); }
    if (b2.high < b1.high && b1.high >= b.high) { push(stH, b1.high, i - 1); swings.st.hi.push({ price: b1.high, at: i - 1, i }); }
    const nITL = q(stL, false);
    if (nITL && !cITL) { push(itL, stL.mid, stL.midI); swings.it.lo.push({ price: stL.mid, at: stL.midI, i }); }
    cITL = nITL;
    const nITH = q(stH, true);
    if (nITH && !cITH) { push(itH, stH.mid, stH.midI); swings.it.hi.push({ price: stH.mid, at: stH.midI, i }); }
    cITH = nITH;

    const nLTL = q(itL, false);
    if (nLTL && !cLTL) {
      ltL.crossed = false;
      if (ms.last === -1 && ms.prev !== ms.last && ltL.measure === false) {
        ltL.measure = true;
        // Drawn from the CHoCH's highest high (the area's top) down to this long-term low.
        bear = Number.isNaN(ltL.zoneTop) ? null : { dir: -1, hi: ltL.zoneTop, hiAt: ltL.extremeAt, lo: itL.mid, loAt: itL.midI, createdAt: i, lastAt: i };
        if (bear) sets.push(bear);
      }
      ltL.price = itL.mid; ltL.at = itL.midI;
      swings.lt.lo.push({ price: itL.mid, at: itL.midI, i });
    }
    cLTL = nLTL;
    if (ltL.choch && ltL.measure && b.high < ltL.hghst && bear) bear.lastAt = i;

    const nLTH = q(itH, true);
    if (nLTH && !cLTH) {
      ltH.crossed = false;
      if (ms.last === 1 && ms.prev !== ms.last && ltH.measure === false) {
        ltH.measure = true;
        bull = Number.isNaN(ltH.zoneBot) ? null : { dir: 1, hi: itH.mid, hiAt: itH.midI, lo: ltH.zoneBot, loAt: ltH.extremeAt, createdAt: i, lastAt: i };
        if (bull) sets.push(bull);
      }
      ltH.price = itH.mid; ltH.at = itH.midI;
      swings.lt.hi.push({ price: itH.mid, at: itH.midI, i });
    }
    cLTH = nLTH;
    if (ltH.choch && ltH.measure && b.low > ltH.lwest && bull) bull.lastAt = i;

    // renderStructures: the bearish side (long-term low) first, then the bullish side.
    for (const up of [false, true]) {
      const s = up ? ltH : ltL, broke = up ? b.close > s.price : b.close < s.price;
      if (broke && !s.crossed) {
        s.crossed = true;
        if (ms.last === (up ? -1 : 1)) {
          s.choch = true; s.measure = false;
          let ref = up ? b.low : b.high, refI = i;
          for (let k = 1; k <= i - s.at; k++) { const x = up ? c[i - k]!.low : c[i - k]!.high; if (up ? x < ref : x > ref) { ref = x; refI = i - k; } }
          s.lwest = up ? ref : b.low; s.hghst = up ? b.high : ref; s.extremeAt = refI;
          s.zoneTop = up ? s.price : ref; s.zoneBot = up ? ref : s.price;
          chochs.push({ dir: up ? 1 : -1, i, level: s.price, levelAt: s.at, extreme: ref, extremeAt: refI });
        } else s.choch = false;
        ms.prev = ms.last; ms.last = up ? 1 : -1;
      } else if (s.choch && !(up ? b.low > s.lwest : b.high < s.hghst)) s.choch = false;
    }
  }
  return { sets, chochs, swings };
}
