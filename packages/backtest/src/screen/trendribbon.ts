// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of "Trend Target Ribbon [BOSWaves]" (Pine Script v6, MPL-2.0, (c) BOSWaves), for the owner's ETH card
// (2026-10-11). Calculations only (no ribbon, candles or boxes drawn), default inputs: ALMA 34 / 0.85 / 6, deviation 34 x
// 0.65, slope over 3 bars >= 0.08 ATR(14), stop structure lookback 12 clamped to 0.75 - 3 ATR, 4 targets at 1 - 4R.
//
// Bar-for-bar notes (Pine semantics kept):
// - The trend flips to bull when the ALMA slope (over 3 bars, in ATRs) is above 0.08 and the close is above ALMA + 0.65 x
//   stdev(34); bear mirrored. A flip opens a new position at the close and ends the previous one ("flip").
// - Stop: the script reads `ta.lowest(low, 12)[1]` (longs) / `ta.highest(high, 12)[1]` (shorts) inside the flip block:
//   the 12-bar extreme up to the bar before the flip. The risk is then clamped to 0.75 - 3 ATR (na -> 0.75 ATR).
//   Owner's chart 2026-10-11 (ETHUSD 1D, bear flip 10-08): T1 ~2,182 / T2 ~1,900, a 3-ATR stop past the 10-02 high. An
//   earlier reading of `[1]` as "that call's previous run" (the previous same-side flip) gave 0.75 ATR (T1 2,401) and
//   was wrong.
// - From the bar after entry, a low at or under the stop (a high at or over it for shorts) stops the position; target
//   hits are checked on bars where it was not stopped, including the entry bar.
// - Conviction = clamp(|slope| x 2 + |close - ALMA| / ATR x 0.35, 0, 1).
// Pure.

import type { Candle } from '@bot/marketdata';
import { taAlma, taAtr, taHighest, taLowest, taStdev } from './pine';

export const RIBBON = { almaLen: 34, almaOffset: 0.85, almaSigma: 6, devLen: 34, devMult: 0.65, slopeLen: 3, slopeMin: 0.08, atrLen: 14, stopLookback: 12, minStopAtr: 0.75, maxStopAtr: 3, targets: 4 } as const;

export interface RibbonPosition {
  dir: 1 | -1;
  /** The flip bar (entry at its close). */
  i: number;
  entry: number;
  stop: number;
  risk: number;
  /** Target prices T1..T4 and the bar each was first hit (-1 = not yet). */
  targets: { price: number; hitAt: number }[];
  /** The bar it ended on (-1 = still open) and how. */
  endAt: number;
  how: 'stop' | 'flip' | null;
}
export interface RibbonSeries { trend: Int8Array; conviction: Float64Array; alma: number[]; positions: RibbonPosition[] }

export function trendRibbon(c: ReadonlyArray<Candle>): RibbonSeries {
  const R = RIBBON, close = c.map((b) => b.close);
  const alma = taAlma(close, R.almaLen, R.almaOffset, R.almaSigma), dev = taStdev(close, R.devLen), atr = taAtr(c, R.atrLen);
  const lo12 = taLowest(c.map((b) => b.low), R.stopLookback), hi12 = taHighest(c.map((b) => b.high), R.stopLookback);
  const trendOut = new Int8Array(c.length), conv = new Float64Array(c.length), positions: RibbonPosition[] = [];
  let trend = 0, pos: RibbonPosition | null = null;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, a = atr[i]!, al = alma[i]!;
    const slope = a > 0 ? (al - (i >= R.slopeLen ? alma[i - R.slopeLen]! : NaN)) / a : 0;
    const bullSetup = slope > R.slopeMin && b.close > al + dev[i]! * R.devMult, bearSetup = slope < -R.slopeMin && b.close < al - dev[i]! * R.devMult;
    let flip = false;
    if (trend !== 1 && bullSetup) { trend = 1; flip = true; } else if (trend !== -1 && bearSetup) { trend = -1; flip = true; }
    trendOut[i] = trend;
    const dist = a > 0 ? Math.abs(b.close - al) / a : 0;
    conv[i] = Math.max(0, Math.min(1, Math.abs(slope) * 2 + dist * 0.35));
    if (flip && pos && pos.endAt < 0) { pos.endAt = i; pos.how = 'flip'; }
    if (flip) {
      const dir = trend as 1 | -1, entry = b.close;
      const structure = i < 1 ? NaN : dir === 1 ? lo12[i - 1]! : hi12[i - 1]!;
      const raw = dir === 1 ? entry - structure : structure - entry, minR = a * R.minStopAtr, maxR = a * R.maxStopAtr;
      const risk = Math.min(Math.max(Number.isNaN(raw) ? minR : raw, minR), maxR);
      pos = { dir, i, entry, stop: entry - dir * risk, risk, targets: Array.from({ length: R.targets }, (_, k) => ({ price: entry + dir * risk * (k + 1), hitAt: -1 })), endAt: -1, how: null };
      positions.push(pos);
    }
    if (pos && pos.endAt < 0) {
      const stopped = i > pos.i && (pos.dir === 1 ? b.low <= pos.stop : b.high >= pos.stop);
      if (stopped) { pos.endAt = i; pos.how = 'stop'; }
      else for (const t of pos.targets) if (t.hitAt < 0 && (pos.dir === 1 ? b.high >= t.price : b.low <= t.price)) t.hitAt = i;
    }
  }
  return { trend: trendOut, conviction: conv, alma, positions };
}
