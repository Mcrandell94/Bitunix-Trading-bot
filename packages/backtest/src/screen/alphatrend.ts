// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "AlphaTrend" (shorttitle AT, Pine v5, © KivancOzbilgic) for the owner's ETH / BTC cards (owner
// 2026-10-16, cards v3). Calculations only (no plots or fill), default inputs: multiplier 1, period 14, source close,
// volume data on (the MFI, not the RSI).
//
// Bar-for-bar notes:
// - ATR = SMA 14 of the true range (ta.tr: na on the first bar). upT = low - ATR, downT = high + ATR.
// - MFI 14 of hlc3 (ta.mfi): the sums of volume x hlc3 over 14 bars on bars where hlc3 rose (upper) and fell (lower);
//   on the first bar the change is na, so it counts on both sides. MFI = 100 - 100 / (1 + upper / lower); with no
//   falling bar (lower = 0) the port reads na (x / 0), which takes the bearish branch below.
// - AlphaTrend: while MFI >= 50 it is upT, but never under its previous value (nz); otherwise downT, never over its
//   previous value (nz: from 0 at the start, so the line can sit at 0 until the first bullish bar).
// - Colour: green when the line is over its value 2 bars back, red when under, else as the bar before (AT[1] vs AT[3]).
// - Signals: BUY = the line crosses over its value 2 bars back, SELL = crosses under. The labels (and the "Potential"
//   alerts) need the previous BUY to be older than the last SELL (barssince(buy[1]) > barssince(sell)), the SELL
//   mirrored; drawn at AT[2] x 0.9999 / 1.0001.
// - The card takes the line's value at the close as a level (support while green, resistance while red).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, nz, taSma, taSum, trueRange } from './pine';

export const ALPHATREND = { coeff: 1, period: 14 } as const;

export interface AlphaTrendSeries {
  /** Per bar: the line, the MFI, the colour (true = green), the crosses and the labels shown. */
  at: number[]; mfi: number[]; green: boolean[]; buy: boolean[]; sell: boolean[]; buyLabel: boolean[]; sellLabel: boolean[];
}

/** ta.mfi(hlc3, len) with the coin volume. */
export function mfiHlc3(c: ReadonlyArray<Candle>, len: number): number[] {
  const src = c.map((b) => (b.high + b.low + b.close) / 3), vol = coinVolume(c);
  const ch = src.map((x, i) => (i > 0 ? x - src[i - 1]! : NaN));
  const upper = taSum(src.map((x, i) => vol[i]! * (ch[i]! <= 0 ? 0 : x)), len), lower = taSum(src.map((x, i) => vol[i]! * (ch[i]! >= 0 ? 0 : x)), len);
  return upper.map((u, i) => (lower[i]! !== 0 ? 100 - 100 / (1 + u / lower[i]!) : NaN));
}

export function alphaTrend(c: ReadonlyArray<Candle>): AlphaTrendSeries {
  const { coeff, period } = ALPHATREND, n = c.length;
  const atr = taSma(trueRange(c).map((x, i) => (i === 0 ? NaN : x)), period), mfi = mfiHlc3(c, period);
  const at = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const up = c[i]!.low - atr[i]! * coeff, dn = c[i]!.high + atr[i]! * coeff, p = nz(i > 0 ? at[i - 1]! : NaN);
    at[i] = mfi[i]! >= 50 ? (up < p ? p : up) : dn > p ? p : dn;
  }
  const back = (k: number, d: number) => (k - d >= 0 ? at[k - d]! : NaN);
  const green: boolean[] = [], buy: boolean[] = [], sell: boolean[] = [], buyLabel: boolean[] = [], sellLabel: boolean[] = [];
  let lastBuy = -1, lastSell = -1;
  for (let i = 0; i < n; i++) {
    green.push(at[i]! > back(i, 2) ? true : at[i]! < back(i, 2) ? false : back(i, 1) > back(i, 3));
    const b = at[i]! > back(i, 2) && back(i, 1) <= back(i, 3), s = at[i]! < back(i, 2) && back(i, 1) >= back(i, 3);
    buy.push(b); sell.push(s);
    // barssince(buy[1]) = bars since the bar after the last BUY before this bar; barssince(sell) includes this bar.
    const o1 = lastBuy >= 0 ? i - (lastBuy + 1) : NaN, o2 = lastSell >= 0 ? i - (lastSell + 1) : NaN;
    if (s) lastSell = i;
    if (b) lastBuy = i;
    const k2 = lastSell >= 0 ? i - lastSell : NaN, k1 = lastBuy >= 0 ? i - lastBuy : NaN;
    buyLabel.push(b && o1 > k2); sellLabel.push(s && o2 > k1);
  }
  return { at, mfi, green, buy, sell, buyLabel, sellLabel };
}
