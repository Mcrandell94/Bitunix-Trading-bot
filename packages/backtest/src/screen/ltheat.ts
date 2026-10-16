// This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Liquidity Trend Heatmap [BigBeluga]" (Pine v6,
// shorttitle "LT Heatmap [BigBeluga]", © BigBeluga) for the owner's ETH / BTC cards (owner 2026-10-16, cards v3).
// Calculations only (no shapes, labels, fills or dashboard), default inputs: trend length 50, lookback 500, heatmap
// threshold 50%. This port is shared under the same licence: non-commercial use only.
//
// Bar-for-bar notes:
// - Trend line: middle = EMA 50 of SMA 50 of the close (taEma / taSma, Pine's). ATR(100) (Pine's RMA). The line is
//   bullish while the close is over middle + ATR, bearish under middle - ATR, neutral between; the dashboard's word is
//   "Bullish" when middle is over its value 4 bars back, else "Bearish".
// - Range: upper = the highest (high + ATR) and lower = the lowest (low - ATR) of the last 500 bars; step = (upper -
//   lower) / 26. Node k (k = 0..25) sits at lower + k x step (the top of the range, node 26, is not one).
// - Each node's volume: the volume of the last bar and the 500 before it whose hl2 is within half a step of the node.
//   The POC is the node with the most (the first if tied). A node is drawn only from 50% of the POC's volume up (the
//   colour gradient starts at the threshold), so those are the nodes taken here.
// - The is_active() check only hides the markers where the current bar trades through a node (display).
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taEma, taSma } from './pine';

export const LTHEAT = { length: 50, lookback: 500, nodes: 26, minShare: 0.5, atrLen: 100 } as const;

export interface LtNode { k: number; level: number; vol: number; share: number; poc: boolean }
export interface LtHeat {
  middle: number; atr: number; trend: 'bullish' | 'bearish' | 'neutral'; dash: 'Bullish' | 'Bearish';
  upper: number; lower: number; step: number;
  /** All 26 nodes, and the ones drawn (50% of the POC's volume or more). */
  nodes: LtNode[]; shown: LtNode[]; poc: LtNode | null;
}

/** The heat map at the close of bar `i` (only bars up to i are read), or null before 500 bars and ATR(100). */
export function ltHeat(c: ReadonlyArray<Candle>, i: number = c.length - 1): LtHeat | null {
  const { length, lookback, nodes: N, minShare, atrLen } = LTHEAT;
  if (i < lookback || i >= c.length) return null;
  const cc = c.slice(0, i + 1), atr = taAtr(cc, atrLen), middle = taEma(taSma(cc.map((b) => b.close), length), length);
  let upper = -Infinity, lower = Infinity;
  for (let k = i - lookback + 1; k <= i; k++) {
    const a = atr[k]!;
    if (Number.isNaN(a)) return null;
    upper = Math.max(upper, cc[k]!.high + a); lower = Math.min(lower, cc[k]!.low - a);
  }
  const step = Math.max(upper - lower, 0.00001) / N, vol = coinVolume(cc);
  const nodes: LtNode[] = Array.from({ length: N }, (_, k) => {
    const level = lower + step * k;
    let v = 0;
    for (let j = 0; j <= lookback; j++) { const b = cc[i - j]!; if (Math.abs((b.high + b.low) / 2 - level) <= step / 2) v += vol[i - j] || 0; }
    return { k, level, vol: v, share: 0, poc: false };
  });
  const max = Math.max(...nodes.map((x) => x.vol)), pk = max > 0 ? nodes.findIndex((x) => x.vol === max) : -1;
  for (const x of nodes) { x.share = max > 0 ? x.vol / max : 0; x.poc = x.k === pk; }
  const m = middle[i]!, a = atr[i]!, close = cc[i]!.close;
  return {
    middle: m, atr: a, trend: close > m + a ? 'bullish' : close < m - a ? 'bearish' : 'neutral', dash: m > (middle[i - 4] ?? NaN) ? 'Bullish' : 'Bearish',
    upper, lower, step, nodes, shown: nodes.filter((x) => max > 0 && x.share >= minShare), poc: pk >= 0 ? nodes[pk]! : null,
  };
}
