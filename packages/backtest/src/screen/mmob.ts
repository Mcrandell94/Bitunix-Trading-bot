// TypeScript port of "MarketMaulers Order Blocks" v1.8 (Pine v6, "Built by Market Maulers · Free forever"; the copy
// given has no licence header) for the owner's ETH / BTC cards (owner 2026-10-13, cards v2). Calculations only (no
// boxes, CE lines or labels), the chart-timeframe engine with default inputs; the cards run it on the weekly, daily and
// 4H bars separately (as the script on each of those charts), so its HTF slots stay off (their default).
//
// Bar-for-bar notes (defaults: structure sensitivity 5, displacement filter on at 1.5 x ATR(14), origin "Cluster",
// FVG confluence off, mitigation by wick, broken OBs removed, mitigated kept, at most 12 OBs, killzones off):
// - Swings: ta.pivothigh / ta.pivotlow(5, 5) (pine.ts taPivot); a new pivot replaces the stored swing high / low.
// - Bullish BOS: a close above the stored swing high. The swing is consumed (set to na) whether or not an OB qualifies.
//   The origin is the nearest down candle (close < open) within bars 0..12 back (the breaking bar included); "Cluster"
//   extends it back through every contiguous down candle. Zone: top = the highest body high (max(open, close)), bottom
//   = the lowest wick low of that run. It qualifies when |close - open of the nearest one| >= 1.5 ATR and bottom < top.
//   Bearish mirrored (up candles; top = the highest wick high, bottom = the lowest body low).
// - Each bar after detection, every live zone (in reverse order): bullish broken on a close under its bottom
//   (removed), else mitigated on its first wick at or under its top (kept, "tapped"); bearish mirrored. A zone born on
//   a bar is checked on that same bar, as in the script.
// - Then the cull: while more than 12 zones are live, the oldest goes; then a hard cap of 300.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taAtr, taPivot } from './pine';

export const MMOB = { pivLen: 5, dispMult: 1.5, maxShow: 12, maxScan: 12, hardCap: 300, atrLen: 14 } as const;

export interface MmZone {
  dir: 1 | -1; top: number; bot: number;
  /** The run's oldest (far) and nearest origin bars, and the breaking bar the zone was made on. */
  left: number; near: number; createdAt: number;
  /** First wick into it (-1 = fresh), and the bar it left the list: broken (a close through) or culled (-1 = live). */
  mitigatedAt: number; removedAt: number; how: 'broken' | 'culled' | null;
}

export function mmob(c: ReadonlyArray<Candle>): MmZone[] {
  const M = MMOB, hi = c.map((b) => b.high), lo = c.map((b) => b.low), atr = taAtr(c, M.atrLen);
  const all: MmZone[] = [], live: MmZone[] = [];
  let swH = NaN, swL = NaN;
  const opp = (i: number, k: number, down: boolean) => i - k >= 0 && (down ? c[i - k]!.close < c[i - k]!.open : c[i - k]!.close > c[i - k]!.open);
  // f_obRun: the nearest opposing candle and the contiguous run behind it.
  const run = (i: number, down: boolean): { kN: number; kF: number; top: number; bot: number } | null => {
    let kN = -1;
    for (let k = 0; k <= M.maxScan; k++) if (opp(i, k, down)) { kN = k; break; }
    if (kN < 0) return null;
    const b = (k: number) => c[i - k]!;
    let kF = kN, top = down ? Math.max(b(kN).open, b(kN).close) : b(kN).high, bot = down ? b(kN).low : Math.min(b(kN).open, b(kN).close);
    for (let k = kN + 1; k <= M.maxScan; k++) {
      if (!opp(i, k, down)) break;
      kF = k;
      top = Math.max(top, down ? Math.max(b(k).open, b(k).close) : b(k).high);
      bot = Math.min(bot, down ? b(k).low : Math.min(b(k).open, b(k).close));
    }
    return { kN, kF, top, bot };
  };
  const remove = (z: MmZone, i: number, how: 'broken' | 'culled') => { z.removedAt = i; z.how = how; live.splice(live.indexOf(z), 1); };
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, ph = taPivot(hi, i, M.pivLen, true), pl = taPivot(lo, i, M.pivLen, false);
    if (!Number.isNaN(ph)) swH = ph;
    if (!Number.isNaN(pl)) swL = pl;
    for (const up of [true, false]) {
      const sw = up ? swH : swL;
      if (Number.isNaN(sw) || !(up ? b.close > sw : b.close < sw)) continue;
      const r = run(i, up);
      if (r && Math.abs(b.close - c[i - r.kN]!.open) >= M.dispMult * atr[i]! && r.bot < r.top) {
        const z: MmZone = { dir: up ? 1 : -1, top: r.top, bot: r.bot, left: i - r.kF, near: i - r.kN, createdAt: i, mitigatedAt: -1, removedAt: -1, how: null };
        all.push(z); live.push(z);
      }
      if (up) swH = NaN; else swL = NaN;
    }
    // Mitigation / break, newest first.
    for (let k = live.length - 1; k >= 0; k--) {
      const z = live[k]!;
      if (z.dir === 1 ? b.close < z.bot : b.close > z.top) remove(z, i, 'broken');
      else if (z.mitigatedAt < 0 && (z.dir === 1 ? b.low <= z.top : b.high >= z.bot)) z.mitigatedAt = i;
    }
    while (live.length > M.maxShow) remove(live[0]!, i, 'culled');
    if (live.length > M.hardCap) remove(live[0]!, i, 'culled');
  }
  return all;
}

/** The zones live at bar i (made by i and not yet removed), with whether they were tapped by i. */
export const mmLive = (zs: ReadonlyArray<MmZone>, i: number) =>
  zs.filter((z) => z.createdAt <= i && (z.removedAt < 0 || z.removedAt > i)).map((z) => ({ z, tapped: z.mitigatedAt >= 0 && z.mitigatedAt <= i }));
