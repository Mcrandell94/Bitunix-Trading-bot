// TypeScript port of "Dynamic Liquidity HeatMap Profile [BigBeluga]" (Pine v6, MPL 2.0, © BigBeluga) for the owner's
// ETH / BTC cards (owner 2026-10-13, cards v2). Calculations only (no boxes or lines), default inputs: 300 calculated
// bars, profile resolution 50, the max-liquidity point on.
//
// Bar-for-bar notes:
// - vol = the 10-bar volume sum; nVol = vol / its highest of the last 300 bars x 100; atr = ATR(5) / 50; offset = the
//   highest atr x nVol of the last 300 bars. The range is the highest high + offset .. lowest low - offset of the last
//   300 bars, in 100 steps.
// - Over the last 300 bars: a bar whose high is the highest of the last 2 bars stores a liquidity level at each step
//   middle within one step of high + atr x nVol (above price); a bar whose low is the lowest of 2 stores one at each
//   step middle within one step of low - atr x nVol, minus atr x nVol again (as written; below price). Each level keeps
//   its bar's vol. A level above is swept (removed) by a later high over it, one below by a later low under it, the
//   same bar included. (The script removes inside a for-in loop over the same array; all crossed levels are removed
//   here.)
// - Profile on the last bar: 50 bins over that bar's range; each live level adds its vol to the bins whose middle is
//   less than one bin away. Bins holding the price are not drawn. The biggest bin is the max liquidity point; bins
//   over the average are labelled.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taHighest, taLowest, taSum } from './pine';

export const LIQHEAT = { lookBack: 300, resolution: 100, bins: 50, volLen: 10, atrLen: 5 } as const;

export interface LiqBin { lo: number; hi: number; mid: number; vol: number }
export interface LiqProfile { bins: LiqBin[]; max: LiqBin | null; avg: number; price: number }

export function liqHeat(c: ReadonlyArray<Candle>, at: number): LiqProfile {
  const H = LIQHEAT, cc = c.slice(0, at + 1), n = cc.length, vol = taSum(coinVolume(cc).map((x) => x || 0), H.volLen);
  const atr = taAtr(cc, H.atrLen).map((x) => x / 50), h2 = taHighest(cc.map((b) => b.high), 2), l2 = taLowest(cc.map((b) => b.low), 2);
  const nVol = vol.map((v, i) => { let m = -Infinity; for (let k = Math.max(0, i - H.lookBack + 1); k <= i; k++) if (!Number.isNaN(vol[k]!)) m = Math.max(m, vol[k]!); return (v / m) * 100; });
  const sv = atr.map((a, i) => a * nVol[i]!), offset = taHighest(sv, H.lookBack);
  const range = (i: number) => {
    let top = -Infinity, bot = Infinity;
    for (let k = Math.max(0, i - H.lookBack + 1); k <= i; k++) { const o = offset[k]!; if (Number.isNaN(o)) continue; top = Math.max(top, cc[k]!.high + o); bot = Math.min(bot, cc[k]!.low - o); }
    return { top, bot };
  };
  const pivots: { y: number; low: boolean; vol: number }[] = [];
  for (let i = Math.max(0, n - H.lookBack); i < n; i++) {
    const b = cc[i]!, { top, bot } = range(i), step = (top - bot) / H.resolution, s = sv[i]!;
    if (Number.isFinite(step) && step > 0 && !Number.isNaN(s)) {
      if (h2[i] === b.high) for (let k = 0; k < H.resolution; k++) { const mid = bot + step * k + step / 2; if (Math.abs(b.high + s - mid) <= step) pivots.push({ y: mid, low: false, vol: vol[i]! }); }
      if (l2[i] === b.low) for (let k = 0; k < H.resolution; k++) { const mid = bot + step * k + step / 2; if (Math.abs(b.low - s - mid) <= step) pivots.push({ y: mid - s, low: true, vol: vol[i]! }); }
    }
    for (let k = pivots.length - 1; k >= 0; k--) { const p = pivots[k]!; if (p.low ? b.low < p.y : b.high > p.y) pivots.splice(k, 1); }
  }
  const { top, bot } = range(n - 1), step = (top - bot) / H.bins, price = cc[n - 1]!.close;
  const bins: LiqBin[] = Array.from({ length: H.bins }, (_, j) => ({ lo: bot + step * j, hi: bot + step * (j + 1), mid: bot + step * j + step / 2, vol: 0 }));
  for (const p of pivots) for (const b of bins) if (Math.abs(p.y - b.mid) < step) b.vol += p.vol || 0;
  const shown = bins.filter((b) => b.vol > 0 && !(price < b.hi && price > b.lo));
  const maxVol = Math.max(0, ...bins.map((b) => b.vol)), avg = bins.reduce((a, b) => a + b.vol, 0) / bins.length;
  return { bins: shown, max: shown.find((b) => b.vol === maxVol) ?? null, avg, price };
}
