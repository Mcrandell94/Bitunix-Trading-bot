// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of "Shaakuni - Liquidity Levels & Order Blocks" v1.4.0 (Pine Script v6, MPL-2.0, (c) Shaakuni), for
// the owner's ETH card (2026-10-11). Calculations only (no lines, boxes or panel), default inputs: OB structure lookback
// 10, impulse 0.7 x ATR(14), zone lookback "Auto" (250 bars on 4H, 150 on 1D), unmitigated zones shown.
//
// Bar-for-bar notes (Pine semantics kept):
// - Weeks start Monday 00:00 UTC and days at 00:00 UTC (the exchange time of crypto charts). On a new week the running
//   high / low becomes the previous week's (PWH / PWL) and the old one the week before; days the same (PDH / PDL). EQ =
//   the 50% of each range.
// - Day status on the last bar: "Break" if the close is beyond the previous day's level, else "Sweep" if today's
//   running high / low went beyond it, else "Active".
// - Weekend roll (as written): when `now` is a Saturday or Sunday (UTC), the script shifts on the last bar, so the
//   "previous" week shows the current week so far and the "previous" day today so far. The day status is computed
//   before that shift.
// - Session (New York time, DST-aware): Asian 20:00-24:00, London 02:00-05:00, New York 07:00-10:00, London Close
//   10:00-12:00, else none.
// - Order block (bullish): on a bar that closes above the highest high of the 10 bars before it (at least 3 bars back),
//   take the lowest low between them; the first bullish bar after that low with a body >= 0.7 x ATR(14) is the impulse;
//   the block is the first bearish bar going back from the impulse to the low (else the low bar). It must be fresh (no
//   low since then has traded into its high) and not the same block as the last one. Bearish mirrored. A block is
//   mitigated when a later bar trades into it (high >= bottom and low <= top) and dropped once created more than the
//   zone lookback ago.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taAtr } from './pine';

const DAY = 86_400_000;
export const SHAAKUNI = { swingLen: 10, impulse: 0.7, atrLen: 14, minHOff: 3 } as const;
export type DayStatus = 'Active' | 'Sweep' | 'Break';
export interface ShaakuniLevels {
  pwh: number; pwl: number; weq: number; pwh2: number; pwl2: number;
  pdh: number; pdl: number; deq: number;
  pdhStatus: DayStatus; pdlStatus: DayStatus;
  /** The weekend roll was applied (the "previous" levels are the current week / day so far). */
  weekendRoll: boolean;
  session: string;
}
export interface ObZone {
  side: 1 | -1;
  top: number;
  bottom: number;
  /** The block's own bar, the bar it was confirmed on, and its impulse bar. */
  obBar: number;
  createdAt: number;
  impulseBar: number;
  /** ATR(14) at the confirming bar (the script's impulse yardstick). */
  atr: number;
  mitigatedAt: number;
  droppedAt: number;
}

const weekOf = (t: number) => Math.floor((t - 4 * DAY) / (7 * DAY));
const dayOf = (t: number) => Math.floor(t / DAY);

/** The NY session at `now`. */
export function nySession(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === 'hour')!.value), m = Number(parts.find((p) => p.type === 'minute')!.value), mins = h * 60 + m;
  return mins >= 1200 && mins < 1440 ? 'Asian' : mins >= 120 && mins < 300 ? 'London' : mins >= 420 && mins < 600 ? 'New York' : mins >= 600 && mins < 720 ? 'London Close' : '-';
}

/** The running levels after each bar (before any weekend roll): previous week / the week before / previous day, and the current week / day so far. */
export interface LevelBar { pwh: number; pwl: number; pwh2: number; pwl2: number; pdh: number; pdl: number; wHi: number; wLo: number; dHi: number; dLo: number }
export function shaakuniLevelSeries(c: ReadonlyArray<Candle>): LevelBar[] {
  let trkHi = NaN, trkLo = NaN, pwh = NaN, pwl = NaN, pwh2 = NaN, pwl2 = NaN, dHi = NaN, dLo = NaN, pdh = NaN, pdl = NaN;
  const out: LevelBar[] = [];
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, newWeek = i > 0 && weekOf(b.openTime) !== weekOf(c[i - 1]!.openTime), newDay = i > 0 && dayOf(b.openTime) !== dayOf(c[i - 1]!.openTime);
    if (newWeek) { pwh2 = pwh; pwl2 = pwl; pwh = trkHi; pwl = trkLo; trkHi = b.high; trkLo = b.low; }
    else { if (Number.isNaN(trkHi) || b.high > trkHi) trkHi = b.high; if (Number.isNaN(trkLo) || b.low < trkLo) trkLo = b.low; }
    if (newDay) { pdh = dHi; pdl = dLo; dHi = b.high; dLo = b.low; }
    else { if (Number.isNaN(dHi) || b.high > dHi) dHi = b.high; if (Number.isNaN(dLo) || b.low < dLo) dLo = b.low; }
    out.push({ pwh, pwl, pwh2, pwl2, pdh, pdl, wHi: trkHi, wLo: trkLo, dHi, dLo });
  }
  return out;
}

/** The day status of the previous day's high / low at a bar closing at `close`. */
export function dayStatus(lv: LevelBar, close: number): { pdh: DayStatus; pdl: DayStatus } {
  return {
    pdh: Number.isNaN(lv.pdh) ? 'Active' : close > lv.pdh ? 'Break' : lv.dHi > lv.pdh ? 'Sweep' : 'Active',
    pdl: Number.isNaN(lv.pdl) ? 'Active' : close < lv.pdl ? 'Break' : lv.dLo < lv.pdl ? 'Sweep' : 'Active',
  };
}

/** The weekly / daily levels and the day status on the last bar of `c` (any intraday or daily timeframe), as the panel shows them at `now`. */
export function shaakuniLevels(c: ReadonlyArray<Candle>, now: number): ShaakuniLevels {
  const lv = shaakuniLevelSeries(c).at(-1), last = c[c.length - 1];
  let { pwh, pwl, pwh2, pwl2, pdh, pdl } = lv ?? { pwh: NaN, pwl: NaN, pwh2: NaN, pwl2: NaN, pdh: NaN, pdl: NaN };
  const trkHi = lv?.wHi ?? NaN, trkLo = lv?.wLo ?? NaN, dHi = lv?.dHi ?? NaN, dLo = lv?.dLo ?? NaN;
  const st = lv && last ? dayStatus(lv, last.close) : { pdh: 'Active' as DayStatus, pdl: 'Active' as DayStatus };
  const dow = new Date(now).getUTCDay(), weekend = dow === 0 || dow === 6;
  let weekendRoll = false;
  if (weekend && last && !Number.isNaN(trkHi) && (Number.isNaN(pwh) || trkHi !== pwh || trkLo !== pwl)) { pwh2 = pwh; pwl2 = pwl; pwh = trkHi; pwl = trkLo; weekendRoll = true; }
  if (weekend && last && !Number.isNaN(dHi) && (Number.isNaN(pdh) || dHi !== pdh || dLo !== pdl)) { pdh = dHi; pdl = dLo; weekendRoll = true; }
  const livePwh = Number.isNaN(pwh) ? trkHi : pwh, livePwl = Number.isNaN(pwl) ? trkLo : pwl, livePdh = Number.isNaN(pdh) ? dHi : pdh, livePdl = Number.isNaN(pdl) ? dLo : pdl;
  return {
    pwh: livePwh, pwl: livePwl, weq: (livePwh + livePwl) / 2, pwh2, pwl2,
    pdh: livePdh, pdl: livePdl, deq: (livePdh + livePdl) / 2, pdhStatus: st.pdh, pdlStatus: st.pdl, weekendRoll, session: nySession(now),
  };
}

/** Order blocks / POI on `c` (the script's auto zone lookback by timeframe: 250 bars on 4H, 150 on daily). */
export function shaakuniBlocks(c: ReadonlyArray<Candle>, tfMs: number): ObZone[] {
  const s = tfMs / 1000, lb = s <= 60 ? 2000 : s <= 300 ? 1500 : s <= 900 ? 1000 : s <= 1800 ? 700 : s <= 3600 ? 500 : s <= 14400 ? 250 : 150;
  const S = SHAAKUNI, atr = taAtr(c, S.atrLen), out: ObZone[] = [], live: ObZone[] = [];
  let lastBull = -1, lastBear = -1;
  const at = (i: number, off: number) => c[i - off]!;
  for (let i = 0; i < c.length; i++) {
    const a = atr[i]!;
    if (!Number.isNaN(a) && i > S.swingLen + 2) {
      for (const d of [1, -1] as const) {
        // The extreme of the 10 bars before (bars 1..10 back) and its offset.
        let ext = d > 0 ? at(i, 1).high : at(i, 1).low, eOff = 1;
        for (let k = 2; k <= S.swingLen; k++) { const v = d > 0 ? at(i, k).high : at(i, k).low; if (d > 0 ? v > ext : v < ext) { ext = v; eOff = k; } }
        if (!(d > 0 ? c[i]!.close > ext : c[i]!.close < ext) || eOff < S.minHOff) continue;
        // The opposite extreme between them.
        let opp = d > 0 ? at(i, 1).low : at(i, 1).high, oOff = 1;
        for (let k = 2; k <= eOff - 1; k++) { const v = d > 0 ? at(i, k).low : at(i, k).high; if (d > 0 ? v < opp : v > opp) { opp = v; oOff = k; } }
        let dOff = -1;
        for (let k = 0; k <= oOff - 1; k++) {
          const o = oOff - 1 - k, x = at(i, o), body = d > 0 ? x.close - x.open : x.open - x.close;
          if (body > 0 && body >= a * S.impulse) { dOff = o; break; }
        }
        if (dOff < 0) continue;
        let obOff = oOff;
        for (let j = dOff + 1; j <= oOff; j++) { const x = at(i, j); if (d > 0 ? x.close < x.open : x.close > x.open) { obOff = j; break; } }
        const ob = at(i, obOff);
        let fresh = true;
        if (obOff >= 2) for (let k = 0; k <= obOff - 2; k++) { const x = at(i, k); if (d > 0 ? x.low <= ob.high : x.high >= ob.low) { fresh = false; break; } }
        const obBar = i - obOff;
        if (!fresh || obBar === (d > 0 ? lastBull : lastBear)) continue;
        if (d > 0) lastBull = obBar; else lastBear = obBar;
        const z: ObZone = { side: d, top: ob.high, bottom: ob.low, obBar, createdAt: i, impulseBar: i - dOff, atr: a, mitigatedAt: -1, droppedAt: -1 };
        out.push(z);
        live.push(z);
      }
    }
    const b = c[i]!;
    for (const z of live) if (i > z.createdAt && z.mitigatedAt < 0 && b.high >= z.bottom && b.low <= z.top) z.mitigatedAt = i;
    for (let k = live.length - 1; k >= 0; k--) if (live[k]!.createdAt < i - lb) { live[k]!.droppedAt = i; live.splice(k, 1); }
  }
  return out;
}

/** The blocks shown on the chart at bar i: confirmed by i, not mitigated or dropped by i. */
export const activeBlocks = (zs: ReadonlyArray<ObZone>, i: number) =>
  zs.filter((z) => z.createdAt <= i && (z.mitigatedAt < 0 || z.mitigatedAt > i) && (z.droppedAt < 0 || z.droppedAt > i));
