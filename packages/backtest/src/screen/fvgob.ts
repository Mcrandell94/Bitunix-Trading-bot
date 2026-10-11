// TypeScript port of "FVG and Order Blocks Detector" (Pine v6, shorttitle "IOB Zones") for the ETH / BTC cards (owner
// 2026-10-11, round 4). Calculations only (no boxes or labels), default inputs.
//
// RIGHTS: the source is "© Michael_Fx_Trader. All rights reserved." This port exists for the owner's PRIVATE use only
// (the owner's own cards and research). It must never go into anything sold, shared or published.
//
// Bar-for-bar notes (defaults kept: chart-timeframe FVGs, min gap 0.1 ATR, "Full Fill" mitigation, 8-bar swings,
// "Candle Close" break, displacement 1.2 ATR, "Full Candle" blocks, "Wick" mitigation, 5 zones per type):
// - Each bar, in the script's order: FVG detection (bull: low > high[2], the gap high[2]..low; bear: high < low[2], the
//   gap high..low[2]; kept when >= 0.1 x ATR(14)), FVG mitigation (bull: a low under the gap's bottom; bear: a high
//   over its top), the 8 / 8 swing pivots (a new pivot re-arms its swing), order-block mitigation (bull: a low under
//   the block; bear: a high over it), then the structure break: a close over the last unbroken swing high (under the
//   last swing low) on a bar whose range is >= 1.2 ATR marks the swing broken and makes the block: the bearish candle
//   with the lowest low from the swing bar to the break bar (bullish candle with the highest high for a bear block;
//   ties go to the most recent; with no such candle, the extreme candle), its full high..low. A block overlapping an
//   unmitigated same-side block by more than 70% of its own height is skipped.
// - Per type (bull / bear FVG, bull / bear block) at most 5 are kept, mitigated ones included (the chart keeps them,
//   faded); beyond that the oldest of the type is dropped.
// - The owner's strength cutoffs (round 4): an FVG is STRONG when it is unfilled, at least 0.5 ATR tall, and its middle
//   candle's volume is >= 1.5 x the mean of the 20 bars before it. A block is STRONG by the Shaakuni rule
//   (zonestrength.ts obStrength): its impulse candle (here the breaking candle) has a body >= 1.0 ATR and volume
//   >= 1.5 x the 20 bars before it; unmitigated.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr } from './pine';
import { pinePivot } from './srbreaks';
import { ZONE_RULE, obStrength, type ObStrength } from './zonestrength';

export const FVGOB = { atrLen: 14, minGapAtr: 0.1, maxPerType: 5, swing: 8, dispMult: 1.2, overlap: 0.7, strongGapAtr: 0.5, strongVolMult: 1.5, volBars: 20 } as const;

export interface Fvg {
  side: 1 | -1; top: number; bottom: number; mid: number;
  /** The first candle of the pattern, and the bar that completed it (the gap exists from its close). */
  leftBar: number; createdAt: number;
  atr: number; sizeAtr: number; volMult: number;
  /** First bar after creation trading into the gap; the fill (mitigation) bar; the bar it was dropped by the 5-per-type cap; -1 if not (yet). */
  touchedAt: number; filledAt: number; droppedAt: number;
}
export interface DetBlock {
  side: 1 | -1; top: number; bottom: number; obBar: number; createdAt: number; impulseBar: number; atr: number;
  mitigatedAt: number; droppedAt: number; str: ObStrength;
}
export interface FvgObSeries { atr: number[]; fvgs: Fvg[]; blocks: DetBlock[] }

const volMultAt = (vol: ReadonlyArray<number>, k: number) => {
  let s = 0, n = 0;
  for (let q = Math.max(0, k - FVGOB.volBars); q < k; q++) if (!Number.isNaN(vol[q]!)) { s += vol[q]!; n++; }
  return n > 0 && s > 0 && !Number.isNaN(vol[k]!) ? vol[k]! / (s / n) : 0;
};

export function fvgOb(c: ReadonlyArray<Candle>): FvgObSeries {
  const F = FVGOB, atr = taAtr(c, F.atrLen), vol = coinVolume(c), hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  const fvgs: Fvg[] = [], blocks: DetBlock[] = [], gapList: Fvg[] = [], blockList: DetBlock[] = [];
  let swH: { price: number; bar: number; broken: boolean } | null = null, swL: { price: number; bar: number; broken: boolean } | null = null;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, a = atr[i]!;
    // FVG detection
    if (i >= 2) {
      let g: { side: 1 | -1; top: number; bottom: number } | null = null;
      if (b.low > c[i - 2]!.high) g = { side: 1, top: b.low, bottom: c[i - 2]!.high };
      else if (b.high < c[i - 2]!.low) g = { side: -1, top: c[i - 2]!.low, bottom: b.high };
      if (g && !Number.isNaN(a) && g.top - g.bottom >= F.minGapAtr * a) {
        const z: Fvg = { ...g, mid: (g.top + g.bottom) / 2, leftBar: i - 2, createdAt: i, atr: a, sizeAtr: a > 0 ? (g.top - g.bottom) / a : 0, volMult: volMultAt(vol, i - 1), touchedAt: -1, filledAt: -1, droppedAt: -1 };
        fvgs.push(z); gapList.push(z);
      }
    }
    // FVG touch (first bar after creation trading into it; for the records) and mitigation
    for (const g of gapList) {
      if (g.filledAt >= 0) continue;
      if (g.touchedAt < 0 && i > g.createdAt && b.high >= g.bottom && b.low <= g.top) g.touchedAt = i;
      if (g.side === 1 ? b.low < g.bottom : b.high > g.top) g.filledAt = i;
    }
    // Swings
    const ph = pinePivot(hi, i, F.swing, F.swing, true), pl = pinePivot(lo, i, F.swing, F.swing, false);
    if (ph != null) swH = { price: ph, bar: i - F.swing, broken: false };
    if (pl != null) swL = { price: pl, bar: i - F.swing, broken: false };
    // Order-block mitigation (wick)
    for (const k of blockList) if (k.mitigatedAt < 0 && (k.side === 1 ? b.low < k.bottom : b.high > k.top)) k.mitigatedAt = i;
    // Structure break + block
    const disp = !Number.isNaN(a) && b.high - b.low >= F.dispMult * a;
    const overlaps = (top: number, bot: number, side: 1 | -1) => blockList.some((k) => k.mitigatedAt < 0 && k.side === side && top - bot > 0 && Math.max(0, Math.min(top, k.top) - Math.max(bot, k.bottom)) / (top - bot) > F.overlap);
    const make = (side: 1 | -1, from: number) => {
      // f_findBearishLow / f_findBullishHigh over offsets 0..i-from (0 = this bar)
      let best = 0, found = false, bestV = side === 1 ? Infinity : -Infinity;
      for (let k = 0; k <= i - from; k++) {
        const q = c[i - k]!, ok = side === 1 ? q.close < q.open : q.close > q.open;
        if (ok && (side === 1 ? q.low < bestV : q.high > bestV)) { bestV = side === 1 ? q.low : q.high; best = k; found = true; }
      }
      if (!found) {
        bestV = side === 1 ? b.low : b.high;
        for (let k = 0; k <= i - from; k++) { const q = c[i - k]!; if (side === 1 ? q.low < bestV : q.high > bestV) { bestV = side === 1 ? q.low : q.high; best = k; } }
      }
      const q = c[i - best]!;
      if (overlaps(q.high, q.low, side)) return;
      const k: DetBlock = { side, top: q.high, bottom: q.low, obBar: i - best, createdAt: i, impulseBar: i, atr: a, mitigatedAt: -1, droppedAt: -1, str: { impulseAtr: 0, volumeMult: 0, strong: false } };
      k.str = obStrength(c, k, vol);
      blocks.push(k); blockList.push(k);
    };
    if (swH && !swH.broken && b.close > swH.price && disp) { swH.broken = true; make(1, swH.bar); }
    if (swL && !swL.broken && b.close < swL.price && disp) { swL.broken = true; make(-1, swL.bar); }
    // 5 per type, oldest first (mitigated ones count)
    for (const side of [1, -1] as const) {
      if (gapList.filter((g) => g.side === side).length > F.maxPerType) { const k = gapList.findIndex((g) => g.side === side); gapList[k]!.droppedAt = i; gapList.splice(k, 1); }
    }
    for (const side of [1, -1] as const) {
      if (blockList.filter((g) => g.side === side).length > F.maxPerType) { const k = blockList.findIndex((g) => g.side === side); blockList[k]!.droppedAt = i; blockList.splice(k, 1); }
    }
  }
  return { atr, fvgs, blocks };
}

/** On the chart at bar i (created, not dropped), and unfilled / unmitigated at i. */
export const fvgActive = (g: Fvg, i: number) => g.createdAt <= i && (g.droppedAt < 0 || g.droppedAt > i) && (g.filledAt < 0 || g.filledAt > i);
export const blockActive = (k: DetBlock, i: number) => k.createdAt <= i && (k.droppedAt < 0 || k.droppedAt > i) && (k.mitigatedAt < 0 || k.mitigatedAt > i);
/** The owner's strong FVG (size and volume; unfilled is checked with fvgActive). */
export const fvgStrong = (g: Fvg) => g.sizeAtr >= FVGOB.strongGapAtr && g.volMult >= FVGOB.strongVolMult;
/** Share of a's height covered by b. */
export const overlapShare = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) => (a.top - a.bottom > 0 ? Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom)) / (a.top - a.bottom) : 0);

/** First touch of each touched gap: held = price moved 1 ATR (at creation) away from it before a close through it. */
export function fvgFirstTouch(c: ReadonlyArray<Candle>, gaps: ReadonlyArray<Fvg>): { gap: Fvg; held: boolean }[] {
  const out: { gap: Fvg; held: boolean }[] = [];
  for (const g of gaps) {
    if (g.touchedAt < 0 || (g.droppedAt >= 0 && g.droppedAt <= g.touchedAt)) continue;
    const away = ZONE_RULE.holdAtr * g.atr;
    for (let k = g.touchedAt; k < c.length; k++) {
      const b = c[k]!;
      if (g.side > 0 ? b.close < g.bottom : b.close > g.top) { out.push({ gap: g, held: false }); break; }
      if (g.side > 0 ? b.high >= g.top + away : b.low <= g.bottom - away) { out.push({ gap: g, held: true }); break; }
    }
  }
  return out;
}
