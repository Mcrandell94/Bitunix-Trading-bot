// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Support and Resistance Signals MTF [LuxAlgo]"
// (Pine v5, © LuxAlgo) for the owner's ETH / BTC cards (owner 2026-10-16, cards v3). Calculations only (no boxes,
// lines or labels), default inputs: detection on the chart's timeframe, length 15, margin 2, the previous zone checked,
// false breakouts avoided. The manipulation (sweep) boxes are display only and are left out. This port is shared under
// the same licence: non-commercial use only.
//
// Bar-for-bar notes (the script's own order on every bar: pivot high, pivot low, then the resistance, previous
// resistance, support and previous support checks):
// - Pivots: pivothigh / pivotlow(15, 15). m = (highest high - lowest low) / highest high of the last 15 bars. A pivot
//   high draws a resistance zone from the pivot high down to high x (1 - m x 0.34), a pivot low a support zone from
//   the low up to low x (1 + m x 0.34), each from the pivot bar; unless the pivot sits inside the newest zone (or the
//   one before it), widened by its own m x 0.34, or the newest zone started within the pivot's 15 bars and price has
//   already left it. The lists start with one empty zone, so (as written) the second resistance comes only from a
//   broken support, and the first two supports are always drawn.
// - Signals use the bar before (labels sit on it), on the newest and previous zone of each side: a breakout is a close
//   past the far edge by m x 0.17 (the zone is marked broken and a zone of the other side is drawn on the same prices
//   from that bar: resistance becomes support and back); a retest (after the other side broke) is a bar that opens
//   inside, wicks in and closes back out; a test (once per zone) is a wick into the zone that closes back on its side
//   for two bars. Rejections: a shadow of 1.618 x ATR(17) on 1.618 x the SMA 17 volume.
// - The card takes the newest and previous zone of each side that are not broken (the ones the script still checks).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taHighest, taLowest, taSma } from './pine';
import { pinePivot } from './srbreaks';

export const LUXSRS = { len: 15, margin: 2, atrLen: 17, volLen: 17 } as const;

export interface SrsZone {
  kind: 'R' | 'S'; top: number; bottom: number;
  /** The first bar (the pivot, or the breakout bar for a flipped zone), the bar it extends to and the bar it was drawn on. */
  left: number; right: number; at: number; m: number; from: 'pivot' | 'flip';
  /** Broken, tested, retested (the script's b / t / r flags). */
  b: boolean; t: boolean; r: boolean;
  /** The lists' start-up entry (an empty zone: every check on it is false). */
  empty?: true;
}
export interface SrsEvent { i: number; kind: 'breakout' | 'test' | 'retest' | 'rejection'; dir: 1 | -1; level: number }

const empty = (): SrsZone => ({ kind: 'R', top: NaN, bottom: NaN, left: NaN, right: NaN, at: -1, m: NaN, from: 'pivot', b: false, t: false, r: false, empty: true });

/** The zone lists (newest first) and every signal up to bar i (bars up to i only). */
export function luxSrSignals(c: ReadonlyArray<Candle>, i: number = c.length - 1): { R: SrsZone[]; S: SrsZone[]; events: SrsEvent[] } {
  const { len, margin: mr } = LUXSRS, cc = c.slice(0, Math.max(0, i + 1)), n = cc.length;
  const hi = cc.map((b) => b.high), lo = cc.map((b) => b.low), hh = taHighest(hi, len), ll = taLowest(lo, len);
  const atr = taAtr(cc, LUXSRS.atrLen), vol = coinVolume(cc).map((v) => (Number.isNaN(v) ? 0 : v)), vSma = taSma(vol, LUXSRS.volLen);
  const isHV = (k: number) => k >= 0 && vol[k]! >= 1.618 * vSma[k]!;
  const isLLS = (k: number) => k >= 0 && Math.abs(cc[k]!.low - Math.min(cc[k]!.open, cc[k]!.close)) >= 1.618 * atr[k]!;
  const isLUS = (k: number) => k >= 0 && Math.abs(cc[k]!.high - Math.max(cc[k]!.open, cc[k]!.close)) >= 1.618 * atr[k]!;
  const R: SrsZone[] = [empty()], S: SrsZone[] = [empty()], events: SrsEvent[] = [];
  let lR = empty(), lS = empty(), lRt = empty(), lSt = empty();
  const ext = (z: SrsZone, x: number) => { if (!z.empty) z.right = x; };
  const zone = (kind: 'R' | 'S', top: number, bottom: number, left: number, right: number, m: number, from: 'pivot' | 'flip', at: number): SrsZone => ({ kind, top, bottom, left, right, at, m, from, b: false, t: false, r: false });

  for (let k = 0; k < n; k++) {
    const b = cc[k]!, p = k > 0 ? cc[k - 1]! : null, o1 = p?.open ?? NaN, h1 = p?.high ?? NaN, l1 = p?.low ?? NaN, c1 = p?.close ?? NaN;
    const mNow = (hh[k]! - ll[k]!) / hh[k]!;

    // Pivot high: a new resistance zone, unless it sits in the newest one (or the one before it).
    const ph = pinePivot(hi, k, len, len, true);
    if (ph != null) {
      const x = k - len, out = (z: SrsZone) => ph < z.bottom * (1 - z.m * 0.17 * mr) || ph > z.top * (1 + z.m * 0.17 * mr);
      if (R.length > 1) {
        lR = R[0]!; lRt = R[1]!;
        if (out(lR)) {
          if (!(x < lR.left && x + len > lR.left && b.close < lR.bottom)) {
            if (out(lRt)) { R.unshift(zone('R', ph, ph * (1 - mNow * 0.17 * mr), x, k, mNow, 'pivot', k)); lS.t = false; } else ext(lRt, k);
          }
        } else if (lR.top !== lS.top) ext(lR, k);
      } else { R.unshift(zone('R', ph, ph * (1 - mNow * 0.17 * mr), x, k, mNow, 'pivot', k)); lS.t = false; }
    }
    // Pivot low: a new support zone (the lists' asymmetry kept: 2 entries needed past the empty one).
    const pl = pinePivot(lo, k, len, len, false);
    if (pl != null) {
      const x = k - len, out = (z: SrsZone) => pl < z.bottom * (1 - z.m * 0.17 * mr) || pl > z.top * (1 + z.m * 0.17 * mr);
      if (S.length > 2) {
        lS = S[0]!; lSt = S[1]!;
        if (out(lS)) {
          if (!(x < lS.left && x + len > lS.left && b.close > lS.top)) {
            if (out(lSt)) { S.unshift(zone('S', pl * (1 + mNow * 0.17 * mr), pl, x, k, mNow, 'pivot', k)); lR.t = false; } else ext(lSt, k);
          }
        } else if (lS.bottom !== lR.bottom) ext(lS, k);
      } else { S.unshift(zone('S', pl * (1 + mNow * 0.17 * mr), pl, x, k, mNow, 'pivot', k)); lR.t = false; }
    }

    // Resistance checks: the newest zone, then the one before it (with the matching support's flags).
    const resist = (z: SrsZone, sup: SrsZone, withR: boolean) => {
      if (c1 > z.top * (1 + z.m * 0.17) && !z.b) {
        ext(z, k - 1); z.b = true; z.r = false;
        S.unshift(zone('S', z.top, z.bottom, k - 1, k + 1, z.m, 'flip', k));
        events.push({ i: k - 1, kind: 'breakout', dir: 1, level: z.top });
      } else if (sup.b && o1 < z.top && h1 > z.bottom && c1 < z.bottom && !z.r && k - 1 !== z.left) {
        events.push({ i: k - 1, kind: 'retest', dir: -1, level: z.bottom }); z.r = true; ext(z, k);
      } else if (h1 > z.bottom && c1 < z.top && b.close < z.top && !z.t && (!withR || !z.r) && !z.b && !sup.b && k - 1 !== z.left) {
        events.push({ i: k - 1, kind: 'test', dir: -1, level: z.bottom }); z.t = true; ext(z, k);
      } else if (b.high > z.bottom * (1 - z.m * 0.17) && !z.b) { if (b.high > z.bottom) ext(z, k); }
    };
    const support = (z: SrsZone, res: SrsZone, newest: boolean) => {
      let chained = false;
      if (c1 < z.bottom * (1 - z.m * 0.17) && !z.b) {
        ext(z, k - 1); z.b = true; z.r = false;
        R.unshift(zone('R', z.top, z.bottom, k - 1, k + 1, z.m, 'flip', k));
        events.push({ i: k - 1, kind: 'breakout', dir: -1, level: z.bottom });
        chained = !newest; // the newest zone's later checks are a separate if in the script (they run anyway)
      }
      if (chained) return;
      if (res.b && o1 > z.bottom && l1 < z.top && c1 > z.top && !z.r && k - 1 !== z.left) {
        events.push({ i: k - 1, kind: 'retest', dir: 1, level: z.top }); z.r = true; ext(z, k);
      } else if (l1 < z.top && c1 > z.bottom && b.close > z.bottom && !z.t && !z.b && !res.b && k - 1 !== z.left) {
        events.push({ i: k - 1, kind: 'test', dir: 1, level: z.top }); z.t = true; ext(z, k);
      } else if (b.low < z.top * (1 + z.m * 0.17) && !z.b) { if (b.low < z.top) ext(z, k); }
    };
    if (R.length > 0) {
      lR = R[0]!;
      resist(lR, lS, true);
      if (isLLS(k - 1) && isHV(k - 1)) events.push({ i: k - 1, kind: 'rejection', dir: 1, level: l1 });
    }
    if (R.length > 1) { lRt = R[1]!; if (lR.top !== lRt.top) resist(lRt, lSt, false); }
    if (S.length > 1) {
      lS = S[0]!;
      support(lS, lR, true);
      if (isLUS(k - 1) && isHV(k - 1)) events.push({ i: k - 1, kind: 'rejection', dir: -1, level: h1 });
    }
    if (S.length > 2) { lSt = S[1]!; if (lS.bottom !== lSt.bottom) support(lSt, lRt, false); }
  }
  return { R, S, events };
}

/** The zones the script still checks at bar i: the newest and previous of each side, not broken. */
export function luxSrActive(r: { R: SrsZone[]; S: SrsZone[] }): SrsZone[] {
  return [...r.R.slice(0, 2), ...r.S.slice(0, 2)].filter((z) => !z.empty && !z.b);
}
