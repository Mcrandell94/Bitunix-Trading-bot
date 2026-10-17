// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "[ A L P H A X ] Dynamic Liquidity Matrix" (shorttitle AlphaX DLM, Pine v6, © AlphaX) for the
// owner's ETH / BTC cards (owner 2026-10-17, cards v3). Calculations only (no boxes, lines, labels or table), default
// inputs: 300 lookback bars, 50 bins, volume sum 10, ATR 14, FVGs on (0.1 ATR, 8 kept), sweep lookback 5.
//
// Bar-for-bar notes:
// - The liquidity profile is the engine of Dynamic Liquidity HeatMap Profile [BigBeluga] (the script's "reference
//   script"; liqheat.ts liqHeatCore) with ATR 14 instead of 5 and the 300-bar volume max floored at 1. Its POC is the
//   biggest of the 50 bins (the first one on a tie), drawn even when the price is inside it; the other bins are drawn
//   when they hold volume and not the price. Buy-side volume comes from the levels under lows, sell-side from those
//   over highs. Dashboard: the live levels (pivots) by side and the bias, the 10-bar volume as % of its 300-bar max
//   (very low under 20, low, normal from 40, high from 60, very high over 80) and the price's place in the last bar's
//   range (lower zone under 30%, upper zone over 70%).
// - FVGs, on every bar: a bullish gap when low > high[2] by 0.1 ATR(14) or more (high[2]..low), a bearish one when
//   high < low[2] (high..low[2]). A gap is removed once fully filled (a low at or under a bull gap's bottom, a high at
//   or over a bear gap's top; the script removes inside a for-in loop over the same array, all filled gaps are
//   removed here), then only the 8 newest are kept.
// - Sweeps: low under the lowest low of the 5 bars before, a close back over it and an up candle (bull); the high
//   mirrored (bear). The script's sweep labels are off by default; the bar colour and alerts use them.
// - The card takes the FVGs (FVG family). The profile is left out of the POIs: it is BigBeluga's profile (already a
//   POI script) with another ATR length, and would count the same liquidity twice; it is in the chart check.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { liqHeatCore, type LiqBin } from './liqheat';
import { taAtr } from './pine';

export const ALPHAX_DLM = { atrLen: 14, fvgMin: 0.1, maxFvgs: 8, sweepLookback: 5, barMaxWidth: 50 } as const;

export interface DlmGap { top: number; bot: number; bull: boolean; start: number }
export interface DlmProfile {
  bins: (LiqBin & { buy: number; sell: number; pct: number })[]; poc: LiqBin | null; avg: number;
  buyPivots: number; sellPivots: number; bias: 'BUY SIDE' | 'SELL SIDE' | 'BALANCED'; pricePos: number; nVol: number;
}

/** The FVGs on the chart at bar `at` (oldest first) and the sweep marks of every bar up to it. */
export function dlmGaps(c: ReadonlyArray<Candle>, at: number): { fvgs: DlmGap[]; bullSweep: boolean[]; bearSweep: boolean[] } {
  const D = ALPHAX_DLM, atr = taAtr(c.slice(0, at + 1), D.atrLen), fvgs: DlmGap[] = [], bullSweep: boolean[] = [], bearSweep: boolean[] = [];
  for (let i = 0; i <= at; i++) {
    const b = c[i]!, min = D.fvgMin * atr[i]!;
    if (i >= 2) {
      const b2 = c[i - 2]!;
      if (b.low > b2.high && b.low - b2.high >= min) fvgs.push({ top: b.low, bot: b2.high, bull: true, start: i });
      if (b.high < b2.low && b2.low - b.high >= min) fvgs.push({ top: b2.low, bot: b.high, bull: false, start: i });
    }
    for (let k = fvgs.length - 1; k >= 0; k--) { const g = fvgs[k]!; if (g.bull ? b.low <= g.bot : b.high >= g.top) fvgs.splice(k, 1); }
    while (fvgs.length > D.maxFvgs) fvgs.shift();
    let lo = Infinity, hi = -Infinity;
    for (let k = i - D.sweepLookback; k < i; k++) if (k >= 0) { lo = Math.min(lo, c[k]!.low); hi = Math.max(hi, c[k]!.high); }
    const full = i >= D.sweepLookback;
    bullSweep.push(full && b.low < lo && b.close > lo && b.close > b.open);
    bearSweep.push(full && b.high > hi && b.close < hi && b.close < b.open);
  }
  return { fvgs, bullSweep, bearSweep };
}

/** The liquidity profile on the last bar `at` (the script draws it on the last bar only). */
export function dlmProfile(c: ReadonlyArray<Candle>, at: number): DlmProfile {
  const core = liqHeatCore(c, at, ALPHAX_DLM.atrLen, 1), step = (core.top - core.bot) / core.all.length;
  const bins = core.all.map((b) => {
    let buy = 0, sell = 0;
    for (const p of core.pivots) if (Math.abs(p.y - b.mid) < step) { if (p.low) buy += p.vol || 0; else sell += p.vol || 0; }
    return { ...b, buy, sell, pct: 0 };
  });
  const max = Math.max(...bins.map((b) => b.vol)), avg = bins.reduce((a, b) => a + b.vol, 0) / bins.length;
  for (const b of bins) b.pct = max > 0 ? (b.vol / max) * 100 : 0;
  const buyPivots = core.pivots.filter((p) => p.low).length, sellPivots = core.pivots.length - buyPivots, P = core.price, size = core.top - core.bot;
  return {
    bins: bins.filter((b) => (b.vol / max) * ALPHAX_DLM.barMaxWidth > 0 && !(P < b.hi && P > b.lo)), poc: core.pivots.length && max > 0 ? core.all[bins.findIndex((b) => b.vol === max)]! : null, avg,
    buyPivots, sellPivots, bias: buyPivots > sellPivots ? 'BUY SIDE' : sellPivots > buyPivots ? 'SELL SIDE' : 'BALANCED', pricePos: size > 0 ? ((P - core.bot) / size) * 100 : 50, nVol: core.nVol,
  };
}
