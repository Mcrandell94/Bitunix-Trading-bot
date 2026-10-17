// TypeScript port of the price-data part of "USDT/USDC Signal v.2.0" (Pine v5; the copy given has no author or licence
// header, TradingView's default for open scripts is MPL 2.0) for the owner's ETH / BTC cards (owner 2026-10-17, cards
// v3). The script's default display is its VWAP with the "blue line" extensions and an EMA 80; that is what is ported.
// Its USDT / USDC mint and burn marks (TradingView's CRYPTOCAP:USDT / USDC market caps), the DXY and BKX calls
// (TVC:DXY, NASDAQ:BKX) and the stablecoin dominance calls (CRYPTOCAP:USDT.D / USDC.D / DAI.D) need data the bot has no
// feed for, and its Liquidity Swing [LuxAlgo] copy is off by default.
//
// Bar-for-bar notes:
// - VWAP = ta.vwap(hlc3): the volume-weighted hlc3 since the session began (a new UTC day for crypto: each 4H bar adds to
//   the day's, each daily or weekly bar starts its own).
// - Blue line: over the 40 bars before this one, the highest high above its bar's VWAP and the lowest low under its
//   bar's VWAP (starting from this bar's high / low and VWAP); the bigger of the two deviations, as a ratio, sets both
//   lines: VWAP x (1 + d) and VWAP x (1 - d) (the script's four cases, in its order; neither when the two are equal).
// - EMA 80 of the close (Pine's SMA-seeded EMA).
// - The card takes the VWAP, both blue lines and the EMA 80 at the close as levels.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taEma } from './pine';

export const USDTSIG = { lookback: 40, ema: 80 } as const;
const DAY = 86_400_000;

export interface UsdtSigSeries { vwap: number[]; upper: number[]; lower: number[]; ema80: number[] }

export function usdtSig(c: ReadonlyArray<Candle>): UsdtSigSeries {
  const vol = coinVolume(c), vwap: number[] = [];
  let sv = 0, s = 0;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!;
    if (i === 0 || Math.floor(b.openTime / DAY) !== Math.floor(c[i - 1]!.openTime / DAY) || c[i]!.openTime - c[i - 1]!.openTime >= DAY) { sv = 0; s = 0; }
    s += ((b.high + b.low + b.close) / 3) * vol[i]!; sv += vol[i]!;
    vwap.push(s / sv);
  }
  const upper: number[] = [], lower: number[] = [];
  for (let i = 0; i < c.length; i++) {
    let hv = c[i]!.high, lv = c[i]!.low, vh = vwap[i]!, vl = vwap[i]!;
    for (let k = 1; k <= USDTSIG.lookback; k++) {
      if (i - k < 0) break;
      const b = c[i - k]!, w = vwap[i - k]!;
      if (b.high > w && hv < b.high) { hv = b.high; vh = w; }
      if (b.low < w && lv > b.low) { lv = b.low; vl = w; }
    }
    const rh = hv > vh ? (hv * 100) / vh : 100, rl = lv < vl ? (lv * 100) / vl : 100;
    let up = 1, dn = 1;
    if (rh > 100 && rl < 100 && rh / 100 - 1 > 1 - rl / 100) { up = rh / 100; dn = 2 - rh / 100; }
    else if (rh > 100 && rl < 100 && rh / 100 - 1 < 1 - rl / 100) { up = 1 - rl / 100 + 1; dn = rl / 100; }
    else if (rh >= 100 && rl >= 100) { up = rh / 100; dn = 2 - rh / 100; }
    else if (rh <= 100 && rl <= 100) { up = 1 - rl / 100 + 1; dn = rl / 100; }
    upper.push(vwap[i]! * up); lower.push(vwap[i]! * dn);
  }
  return { vwap, upper, lower, ema80: taEma(c.map((b) => b.close), USDTSIG.ema) };
}
