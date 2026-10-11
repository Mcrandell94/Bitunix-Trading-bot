// TypeScript port of "DiNapoli Levels Confluence Targets [MarkitTick]" (Pine v6) for the ETH / BTC cards (owner
// 2026-10-11: "offering entries for 1 day 4hr and 1 hr, this could be included"). Calculations only (no lines,
// labels, dashboard or webhook payloads), default inputs.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© MarkitTick). Non-commercial: fine for the
// owner's own cards and chat; it must not go into a paid product or group.
//
// Bar-for-bar notes (defaults kept: pivots 5 / 5, min swing 1 ATR, max retrace 0.90, ATR 14, DMA 3x3 filter on;
// confluence, smoothing, ADX and HTF filters off; stop buffer 0.5 ATR):
// - Pivots are the script's own: a pivot high is the high 5 bars back with every one of the 5 bars before it lower
//   (an equal high on the left disqualifies) and none of the 5 after it higher (an equal high on the right is fine);
//   lows mirrored. Each bar the high is processed, then the low. A pivot of the same side as the newest stored one
//   replaces it only when more extreme (its bar moves too); otherwise a new pivot is stored, newest first, 8 kept, so
//   the list alternates high / low.
// - C, B, A = the three newest pivots (A2 = the fifth). Bull when C is a low (B high, A low); bear mirrored.
//   swing = B - A, retrace = (B - C) / swing; nodes F38.2 = B - 0.382 swing, F61.8 = B - 0.618 swing; the entry is
//   F61.8 when the retrace is 0.618+, else F38.2; stop = C -/+ 0.5 ATR; COP / OP / XOP = C + 0.618 / 1.0 / 1.618 swing.
//   Confluence (shown, not required): the closest pair of the F38.2 / F61.8 nodes of swing B-A and of swing B-A2,
//   when within 0.25 ATR (A2 on the right side of B), their midpoint.
// - A setup is valid at a close when the retrace is 0.382..0.90, |swing| >= 1 ATR with the right sign, and the close
//   is over (bull) / under (bear) the 3-bar SMA of 3 bars before. It fires once per C pivot (a new or moved C can fire
//   again); a new setup replaces the one before.
// - Tracking, from the bar after the signal to the bar a new setup fires (that bar included): the stop when a wick
//   reaches it (it wins a bar that also reaches a target), COP / OP / XOP when a wick reaches them; the setup closes
//   at the stop or at XOP. The script draws the levels whether or not price came back to the entry node.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taAtr, taSma } from './pine';

export const DINAPOLI = { left: 5, right: 5, minSwingAtr: 1.0, maxRetr: 0.9, atrLen: 14, dmaLen: 3, dmaDisp: 3, confTolAtr: 0.25, slAtr: 0.5, maxPivots: 8 } as const;

export interface DnSetup {
  /** The signal bar; C's bar; the bar the next setup replaced it (-1 = still the latest). */
  i: number; cBar: number; replacedAt: number;
  dir: 1 | -1; a: number; b: number; c: number; swing: number; retr: number; node: 382 | 618;
  entry: number; stop: number; cop: number; op: number; xop: number; n382: number; n618: number; conf: number; atr: number;
  /** First bar each level was reached while the setup was live (-1 = not). */
  copAt: number; opAt: number; xopAt: number; stopAt: number;
}
export interface DnSeries { atr: number[]; setups: DnSetup[] }

/** The script's pivot high / low at bar i (the bar `right` back), or NaN. */
export function dnPivot(src: ArrayLike<number>, i: number, left: number, right: number, high: boolean): number {
  if (i < left + right) return NaN;
  const p = src[i - right]!;
  for (let k = 1; k <= left; k++) if (high ? src[i - right - k]! >= p : src[i - right - k]! <= p) return NaN;
  for (let k = 1; k <= right; k++) if (high ? src[i - right + k]! > p : src[i - right + k]! < p) return NaN;
  return p;
}

export function dinapoli(c: ReadonlyArray<Candle>): DnSeries {
  const D = DINAPOLI, atr = taAtr(c, D.atrLen), dma = taSma(c.map((b) => b.close), D.dmaLen), hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  const pv: { price: number; bar: number; high: boolean }[] = [], setups: DnSetup[] = [];
  let cur: DnSetup | null = null, lastC = NaN;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!;
    // Pivots (high first, then low).
    for (const high of [true, false]) {
      const p = dnPivot(high ? hi : lo, i, D.left, D.right, high);
      if (Number.isNaN(p)) continue;
      const top = pv[0];
      if (top && top.high === high) { if (high ? p > top.price : p < top.price) { top.price = p; top.bar = i - D.right; } }
      else pv.unshift({ price: p, bar: i - D.right, high });
    }
    if (pv.length > D.maxPivots) pv.pop();
    // The live setup's levels on this bar (before a new setup can replace it).
    if (cur && cur.stopAt < 0 && cur.xopAt < 0) {
      const up = cur.dir > 0, reach = (lvl: number) => (up ? b.high >= lvl : b.low <= lvl);
      if (up ? b.low <= cur.stop : b.high >= cur.stop) cur.stopAt = i;
      else {
        if (cur.copAt < 0 && reach(cur.cop)) cur.copAt = i;
        if (cur.opAt < 0 && reach(cur.op)) cur.opAt = i;
        if (cur.xopAt < 0 && reach(cur.xop)) cur.xopAt = i;
      }
    }
    // A new setup.
    if (pv.length < 3) continue;
    const [C, B, A] = [pv[0]!, pv[1]!, pv[2]!], bull = !C.high && B.high && !A.high, bear = C.high && !B.high && A.high;
    if (!bull && !bear) continue;
    const swing = B.price - A.price, a = atr[i]!;
    if (swing === 0 || Number.isNaN(a)) continue;
    const retr = (B.price - C.price) / swing, ref = i - D.dmaDisp >= 0 ? dma[i - D.dmaDisp]! : NaN;
    const trend = bull ? b.close > ref : b.close < ref;
    const valid = retr >= 0.382 && retr <= D.maxRetr && Math.abs(swing) >= a * D.minSwingAtr && (bull ? swing > 0 : swing < 0) && trend;
    if (!valid || C.bar === lastC) continue;
    const n382 = B.price - 0.382 * swing, n618 = B.price - 0.618 * swing, dir = bull ? 1 : -1;
    let conf = NaN;
    if (pv.length >= 5) {
      const s2 = B.price - pv[4]!.price;
      if (bull ? s2 > 0 : s2 < 0) {
        const m382 = B.price - 0.382 * s2, m618 = B.price - 0.618 * s2;
        const pairs: [number, number][] = [[n382, m382], [n382, m618], [n618, m382], [n618, m618]], d = pairs.map(([x, y]) => Math.abs(x - y)), best = Math.min(...d);
        if (best <= a * D.confTolAtr) { const k = d.indexOf(best); conf = (pairs[k]![0] + pairs[k]![1]) / 2; }
      }
    }
    if (cur) cur.replacedAt = i;
    cur = {
      i, cBar: C.bar, replacedAt: -1, dir, a: A.price, b: B.price, c: C.price, swing, retr, node: retr >= 0.618 ? 618 : 382,
      entry: retr >= 0.618 ? n618 : n382, stop: bull ? C.price - a * D.slAtr : C.price + a * D.slAtr,
      cop: C.price + 0.618 * swing, op: C.price + swing, xop: C.price + 1.618 * swing, n382, n618, conf, atr: a, copAt: -1, opAt: -1, xopAt: -1, stopAt: -1,
    };
    setups.push(cur);
    lastC = C.bar;
  }
  return { atr, setups };
}

/** The setup live at bar i (the latest fired by i) with its levels' state at i. */
export function dnAt(S: DnSeries, i: number): { s: DnSetup; cop: boolean; op: boolean; xop: boolean; stop: boolean } | null {
  let s: DnSetup | null = null;
  for (const x of S.setups) { if (x.i > i) break; s = x; }
  if (!s) return null;
  const by = (k: number) => k >= 0 && k <= i;
  return { s, cop: by(s.copAt), op: by(s.opAt), xop: by(s.xopAt), stop: by(s.stopAt) };
}

/**
 * Each setup as a trade from its signal close (rules fixed before the preview run): out at the stop or OP, whichever
 * a wick reaches first (the stop on a tie), or at the close of the bar a new setup replaces it; open ones are left out.
 * Return after 0.22% round trip, and in R (the distance to the stop from the signal close).
 */
export function dnTrades(c: ReadonlyArray<Candle>, S: DnSeries, cost = 0.0022): { s: DnSetup; ret: number; r: number; how: 'op' | 'stop' | 'replaced' }[] {
  const out: { s: DnSetup; ret: number; r: number; how: 'op' | 'stop' | 'replaced' }[] = [];
  for (const s of S.setups) {
    const e = c[s.i]!.close, risk = Math.abs(e - s.stop) / e;
    let exit = NaN, how: 'op' | 'stop' | 'replaced' = 'replaced';
    for (let k = s.i + 1; k < c.length; k++) {
      const b = c[k]!;
      if (s.dir > 0 ? b.low <= s.stop : b.high >= s.stop) { exit = s.stop; how = 'stop'; break; }
      if (s.dir > 0 ? b.high >= s.op : b.low <= s.op) { exit = s.op; how = 'op'; break; }
      if (k === s.replacedAt) { exit = b.close; how = 'replaced'; break; }
    }
    if (Number.isNaN(exit)) continue;
    const ret = s.dir * (exit / e - 1) - cost;
    out.push({ s, ret, r: risk > 0 ? ret / risk : NaN, how });
  }
  return out;
}
