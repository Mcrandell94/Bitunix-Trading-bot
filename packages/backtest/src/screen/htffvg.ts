// TypeScript port of "HTF FVG/IFVG" (Pine v6, merged build; the copy given has no author or licence header) for the
// owner's ETH / BTC cards (owner 2026-10-13, cards v2). Calculations only, default inputs, the engines run on their own
// timeframe's bars (as on that chart): the 4H engine on 4H bars and the Daily engine on daily bars. The script has no
// weekly engine; the cards run the Daily engine on weekly bars with a 365-day lookback (one of the script's lookback
// options), noted on the card as an extension.
//
// Bar-for-bar notes (defaults: confirmed lifecycle on, IFVG invalidation after 1 close, lookback 30 calendar days,
// minimum gap 0, consecutive-zone ordinal 1 on 4H, "show only unmitigated" off):
// - At each closed bar: first the lifecycle of the zones made before it, then the new gap.
// - Lifecycle: a bullish FVG turns into a bearish IFVG after 2 consecutive closes under its bottom (one close back in
//   or over resets the count); a bearish FVG into a bullish IFVG after 2 consecutive closes over its top. An IFVG is
//   removed on 1 close back through its far side (bullish IFVG: a close under its bottom; bearish: over its top).
// - New gap: bullish when the bar's low is over the high of 2 bars back (zone = that high .. this low), bearish when
//   its high is under the low of 2 bars back (zone = this high .. that low). Only the 3-candle geometry counts.
// - Lookback: a zone goes once its gap bar is older than the lookback at the current bar's open (checked before and
//   after each bar's processing).
// - 4H display filter: of a run of same-direction FVGs on consecutive 4H bars only the 1st shows; of IFVG conversions
//   on consecutive 4H closes (and several on one close) only the 1st shows. Singles always show. Daily: no filter.
// Pure.

import type { Candle } from '@bot/marketdata';

export const HTFFVG = { lookbackDays: 30, weeklyLookbackDays: 365, ifvgCloses: 1, convertCloses: 2 } as const;
const DAY = 86_400_000;

export interface HtfGap {
  /** Original direction (1 bullish FVG, -1 bearish), zone, the gap bar (3rd candle) and the first candle's bar. */
  dir: 1 | -1; lo: number; hi: number; createdAt: number; firstAt: number;
  /** The close that turned it into an IFVG (-1 = still an FVG) and the bar it was removed (-1 = live) and why. */
  convertedAt: number; removedAt: number; how: 'invalidated' | 'lookback' | null;
  /** 4H display ordinals in its FVG run and IFVG run (1 = shown). */
  fvgOrd: number; ifvgOrd: number;
}

export function htfFvg(c: ReadonlyArray<Candle>, opts: { lookbackDays: number; ordinals: boolean }): HtfGap[] {
  const all: HtfGap[] = [], live: (HtfGap & { opp: number; rev: number })[] = [], lb = opts.lookbackDays * DAY;
  let bullRun = 0, bearRun = 0, prevBullConv = false, prevBearConv = false, bullConvRun = 0, bearConvRun = 0;
  const prune = (i: number) => {
    for (let k = live.length - 1; k >= 0; k--) {
      const z = live[k]!;
      if (c[z.createdAt]!.openTime < c[i]!.openTime - lb) { z.removedAt = i; z.how = 'lookback'; live.splice(k, 1); }
    }
  };
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!;
    prune(i);
    let bullConv = 0, bearConv = 0;
    for (let k = 0; k < live.length; ) {
      const z = live[k]!, ifvg = z.convertedAt >= 0, kind = ifvg ? -2 * z.dir : z.dir;
      let removeIt = false;
      if (kind === 1 || kind === -1) {
        if (kind === 1 ? b.close < z.lo : b.close > z.hi) {
          z.opp++;
          if (z.opp >= HTFFVG.convertCloses) {
            z.convertedAt = i; z.opp = 0; z.rev = 0;
            if (kind === 1) { if (bearConv === 0 && !prevBearConv) bearConvRun = 0; bearConvRun++; bearConv++; z.ifvgOrd = bearConvRun; }
            else { if (bullConv === 0 && !prevBullConv) bullConvRun = 0; bullConvRun++; bullConv++; z.ifvgOrd = bullConvRun; }
          }
        } else z.opp = 0;
      } else if (kind === 2 ? b.close < z.lo : b.close > z.hi) {
        z.rev++;
        if (z.rev >= HTFFVG.ifvgCloses) removeIt = true;
      } else z.rev = 0;
      if (removeIt) { z.removedAt = i; z.how = 'invalidated'; live.splice(k, 1); } else k++;
    }
    prevBullConv = bullConv > 0; prevBearConv = bearConv > 0;
    if (!prevBullConv) bullConvRun = 0;
    if (!prevBearConv) bearConvRun = 0;
    if (i >= 2) {
      const p = c[i - 2]!, bull = b.low > p.high, bear = b.high < p.low;
      bullRun = bull ? bullRun + 1 : 0; bearRun = bear ? bearRun + 1 : 0;
      if (bull || bear) {
        const z = { dir: (bull ? 1 : -1) as 1 | -1, lo: bull ? p.high : b.high, hi: bull ? b.low : p.low, createdAt: i, firstAt: i - 2, convertedAt: -1, removedAt: -1, how: null, fvgOrd: bull ? bullRun : bearRun, ifvgOrd: 0, opp: 0, rev: 0 };
        all.push(z); live.push(z);
      }
    }
    prune(i);
  }
  if (!opts.ordinals) for (const z of all) { z.fvgOrd = 1; if (z.convertedAt >= 0) z.ifvgOrd = 1; }
  return all.map(({ opp: _o, rev: _r, ...z }: HtfGap & { opp?: number; rev?: number }) => z as HtfGap);
}

/** The engine for a card timeframe: the 4H engine on 4H bars, the Daily engine on daily bars and (extension) on weekly bars. */
export const htfFvgFor = (c: ReadonlyArray<Candle>, tf: '4H' | 'D' | 'W') =>
  htfFvg(c, { lookbackDays: tf === 'W' ? HTFFVG.weeklyLookbackDays : HTFFVG.lookbackDays, ordinals: tf === '4H' });

/** The zones shown at bar i, as FVG or IFVG with their current direction (an IFVG acts the opposite way). */
export function htfShown(zs: ReadonlyArray<HtfGap>, i: number): { z: HtfGap; ifvg: boolean; side: 1 | -1 }[] {
  const out: { z: HtfGap; ifvg: boolean; side: 1 | -1 }[] = [];
  for (const z of zs) {
    if (z.createdAt > i || (z.removedAt >= 0 && z.removedAt <= i)) continue;
    const ifvg = z.convertedAt >= 0 && z.convertedAt <= i;
    if ((ifvg ? z.ifvgOrd : z.fvgOrd) !== 1) continue;
    out.push({ z, ifvg, side: ifvg ? (-z.dir as 1 | -1) : z.dir });
  }
  return out;
}
