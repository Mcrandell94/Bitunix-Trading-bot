// TypeScript port of "Fibonacci Entry Zone [OTE] (@ath.snipr)" (Pine v6) for the owner's ETH / BTC cards (owner
// 2026-10-17, cards v3). Calculations only (no lines, labels or fill), default inputs: structure period 10, bullish and
// bearish structure on, swing tracker on, levels 0.5 and 0.618 (the OTE zone), previous levels off.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© ath.snipr). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes (the order inside a bar follows the script):
// - Up = max(Up[1], high), Dn = min(Dn[1], low); both stay na until the first pivot sets them (math.max / math.min with
//   na give na; assumed as Pine documents for most math functions). A pivot high (ta.pivothigh 10 / 10) resets Up while
//   the structure count is 0 or below, a pivot low resets Dn while it is 0 or above.
// - Up rising over Up[1] (a new high past the level) sets iUp to this bar. From a count of 0 or below that is a bullish
//   CHoCH: the levels are drawn from Dn to Up and the count becomes 1; while bullish, each new high redraws them from
//   the current Dn (the swing tracker: the latest pivot low) to the new high and adds 1. Up falling (a pivot reset)
//   sets iUp to the pivot's bar. Then the same for Dn: a new low under Dn from a count of 0 or above is a bearish CHoCH
//   (count -1), further new lows redraw and subtract 1; Dn rising sets iDn to the pivot's bar.
// - A level x: when the low's bar is before the high's, high - (high - low) x x, when after, low + (high - low) x x
//   (the script's fibb; na when both are on the same bar). The levels stay drawn until the next CHoCH.
// - The card takes the zone between the two levels (the OTE zone) on W / D / 4H.
// Pure.

import type { Candle } from '@bot/marketdata';
import { pinePivot } from './srbreaks';

export const OTE = { prd: 10, levels: [0.5, 0.618] } as const;

export interface OteBar {
  /** The structure count (positive bullish, negative bearish) and the running levels. */
  pos: number; up: number; dn: number;
  /** The drawn levels (0.5 and 0.618; NaN when none), the side they were drawn for (1 bullish, -1 bearish, 0 none). */
  dir: 1 | -1 | 0; l50: number; l618: number;
  /** The swing they were last drawn on (bar indexes, -1 when unknown) and the last CHoCH: its bar and the level broken. */
  hi: number; lo: number; hiAt: number; loAt: number; chochAt: number; chochLevel: number;
}

const fibb = (v: number, h: number, l: number, ih: number, il: number) => (il < ih ? h - (h - l) * v : il > ih ? l + (h - l) * v : NaN);

export function ote(c: ReadonlyArray<Candle>): OteBar[] {
  const P = OTE.prd, [v1, v2] = OTE.levels, hi = c.map((b) => b.high), lo = c.map((b) => b.low), out: OteBar[] = [];
  let pos = 0, up = NaN, dn = NaN, iUp = NaN, iDn = NaN;
  let dir = 0 as 1 | -1 | 0, l50 = NaN, l618 = NaN, aHi = NaN, aLo = NaN, aHiAt = -1, aLoAt = -1, chochAt = -1, chochLevel = NaN;
  const idx = (k: number) => (Number.isNaN(k) ? -1 : k);
  const draw = (d: 1 | -1, f: (v: number) => number) => { dir = d; l50 = f(v1); l618 = f(v2); aHi = up; aLo = dn; aHiAt = idx(iUp); aLoAt = idx(iDn); };
  for (let b = 0; b < c.length; b++) {
    const up1 = up, dn1 = dn;
    up = Math.max(up1, hi[b]!); // NaN stays NaN, as Pine's na
    dn = Math.min(dn1, lo[b]!);
    const ph = pinePivot(hi, b, P, P, true), pl = pinePivot(lo, b, P, P, false);
    if (ph != null && pos <= 0) up = ph;
    if (pl != null && pos >= 0) dn = pl;
    if (up > up1) {
      iUp = b;
      if (pos <= 0) { chochAt = b; chochLevel = up1; draw(1, (v) => fibb(v, up, dn, iUp, iDn)); pos = 1; }
      else { if (dir === 1) draw(1, (v) => fibb(v, up, dn, iUp, iDn)); pos += 1; }
    } else if (up < up1) iUp = b - P;
    if (dn < dn1) {
      iDn = b;
      if (pos >= 0) { chochAt = b; chochLevel = dn1; draw(-1, (v) => fibb(v, dn, up, iDn, iUp)); pos = -1; }
      else { if (dir === -1) draw(-1, (v) => fibb(v, up, dn, iUp, iDn)); pos -= 1; }
    } else if (dn > dn1) iDn = b - P;
    out.push({ pos, up, dn, dir, l50, l618, hi: aHi, lo: aLo, hiAt: aHiAt, loAt: aLoAt, chochAt, chochLevel });
  }
  return out;
}
