// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Buyside & Sellside Liquidity [LuxAlgo]" (Pine
// v5, © LuxAlgo) for the owner's ETH / BTC cards (owner 2026-10-17, cards v3). Calculations only (no lines, boxes or
// labels), default inputs: detection length 7, margin 6.9, zone margins 2.3, "Present" mode, 3 visible levels a side,
// liquidity voids off (their default). This port is shared under the same licence: non-commercial use only.
//
// Bar-for-bar notes:
// - Swings: pivothigh / pivotlow(7, 1). A zigzag of the last 50 swings (a new swing of the other side is added, a
//   higher high / lower low of the same side replaces the last one).
// - On each new pivot (only within the chart's last 500 bars, "Present"; here: bars within 500 of bar i), the zigzag's
//   swings of that side within ±ATR(10) / (10 / 6.9) of it are counted, newest to oldest, stopping at one past it (a
//   higher high, a lower low). Three or more draw a level at the oldest of them, with a detection box of their middle
//   ± that margin; the same oldest swing updates the newest level's box instead. 3 levels a side are kept.
// - A high over a buyside level's box top breaks it (swept): its sweep zone runs from the level up to the high, at most
//   2.3 x ATR(10), while bars stay within 2.3 x ATR of the level. Sellside mirrored.
// - The card takes the kept levels not yet swept (buyside over highs, sellside under lows).
// Pure.

import type { Candle } from '@bot/marketdata';
import { nz, taAtr } from './pine';
import { pinePivot } from './srbreaks';

export const LUXBSL = { len: 7, mar: 10 / 6.9, marZone: 2.3, visible: 3, maxSize: 50, present: 500 } as const;

export interface BslLevel {
  /** 1 = buyside (equal highs), -1 = sellside (equal lows). */
  side: 1 | -1;
  /** The oldest swing of the cluster (bar and price: the drawn line), the detection box and the bar it was drawn on. */
  left: number; level: number; top: number; bottom: number; at: number;
  /** Swept (the script's brL) and when; the sweep zone. */
  swept: boolean; sweptAt: number | null; zone: { lo: number; hi: number; left: number; right: number; open: boolean } | null;
  empty?: true;
}

const empty = (side: 1 | -1): BslLevel => ({ side, left: NaN, level: NaN, top: NaN, bottom: NaN, at: -1, swept: false, sweptAt: null, zone: null, empty: true });

/** The kept levels at the close of bar i (bars up to i only), newest first. */
export function luxBsl(c: ReadonlyArray<Candle>, i: number = c.length - 1): { buy: BslLevel[]; sell: BslLevel[] } {
  const { len, mar, marZone, visible, maxSize, present } = LUXBSL, cc = c.slice(0, Math.max(0, i + 1));
  const hi = cc.map((b) => b.high), lo = cc.map((b) => b.low), atr = taAtr(cc, 10);
  const d = new Array<number>(maxSize).fill(0), x = new Array<number>(maxSize).fill(0), y = new Array<number>(maxSize).fill(NaN);
  const inOut = (dd: number, xx: number, yy: number) => { d.unshift(dd); x.unshift(xx); y.unshift(yy); d.pop(); x.pop(); y.pop(); };
  let buy: BslLevel[] = [empty(1)], sell: BslLevel[] = [empty(-1)];

  const detect = (side: 1 | -1, p: number, k: number, list: BslLevel[]) => {
    const m = atr[k]! / mar;
    let count = 0, stP = 0, stB = 0, minP = 0, maxP = 10e6;
    for (let q = 0; q < maxSize; q++) {
      if (d[q] !== side) continue;
      const v = y[q]!;
      if (side > 0 ? v > p + m : v < p - m) break;
      if (v > p - m && v < p + m) { count++; stB = x[q]!; stP = v; if (v > minP) minP = v; if (v < maxP) maxP = v; }
    }
    if (count <= 2) return list;
    const mid = (minP + maxP) / 2, g = list[0]!;
    if (stB === g.left) { g.top = mid + m; g.bottom = mid - m; } else list.unshift({ side, left: stB, level: stP, top: mid + m, bottom: mid - m, at: k, swept: false, sweptAt: null, zone: null });
    return list.length > visible ? list.slice(0, visible) : list;
  };

  for (let k = 0; k < cc.length; k++) {
    const b = cc[k]!, x2 = k - 1, per = i - k <= present;
    const ph = pinePivot(hi, k, len, 1, true), pl = pinePivot(lo, k, len, 1, false);
    if (ph != null && ph !== 0) {
      const dir = d[0]!, y1 = y[0]!, y2 = nz(k > 0 ? hi[k - 1]! : NaN);
      if (dir < 1) inOut(1, x2, y2); else if (dir === 1 && ph > y1) { x[0] = x2; y[0] = y2; }
      if (per) buy = detect(1, ph, k, buy);
    }
    if (pl != null && pl !== 0) {
      const dir = d[0]!, y1 = y[0]!, y2 = nz(k > 0 ? lo[k - 1]! : NaN);
      if (dir > -1) inOut(-1, x2, y2); else if (dir === -1 && pl < y1) { x[0] = x2; y[0] = y2; }
      if (per) sell = detect(-1, pl, k, sell);
    }
    const a = atr[k]!;
    for (const z of buy) {
      if (!z.swept) {
        if (b.high > z.top) { z.swept = true; z.sweptAt = k; z.zone = { lo: z.level, hi: Math.min(z.level + marZone * a, b.high), left: k - 1, right: k + 1, open: true }; }
      } else if (z.zone?.open) {
        if (b.low > z.level - marZone * a && b.high < z.level + marZone * a) { z.zone.right = k + 1; z.zone.hi = Math.max(b.high, z.zone.hi); } else z.zone.open = false;
      }
    }
    for (const z of sell) {
      if (!z.swept) {
        if (b.low < z.bottom) { z.swept = true; z.sweptAt = k; z.zone = { lo: Math.max(z.level - marZone * a, b.low), hi: z.level, left: k - 1, right: k + 1, open: true }; }
      } else if (z.zone?.open) {
        if (b.low > z.level - marZone * a && b.high < z.level + marZone * a) { z.zone.right = k + 1; z.zone.lo = Math.min(b.low, z.zone.lo); } else z.zone.open = false;
      }
    }
  }
  return { buy: buy.filter((z) => !z.empty), sell: sell.filter((z) => !z.empty) };
}
