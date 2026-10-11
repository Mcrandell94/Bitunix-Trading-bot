// TypeScript port of "Support Resistance Confluence Zones [AxeAlgo]" (Pine v6) for the ETH / BTC cards (owner
// 2026-10-11, round 4: "more indicator templates to try and help find positions"). Calculations only (no boxes,
// badges, dashboard or watermark), default inputs.
//
// Licence: the source is "subject to the terms of the Mozilla Public License 2.0" (© AxeAlgo); this port keeps that
// notice and is a derived calculation for the owner's own cards.
//
// Bar-for-bar notes (defaults kept):
// - Pivots: ta.pivothigh(high, L, 3) / ta.pivotlow(low, L, 3) with the auto-tuned length L (4H: 18, 1D: 24); the pivot
//   is the bar 3 back. ATR = ta.atr(14). Volume (coin units, as TradingView shows crypto) is "high" when it is over
//   1.5 x its 20-bar SMA (the bar itself included); a pivot carries the flag and raw volume of its own bar.
// - A pivot merges into the first zone of the same role whose band (+/- 0.35 ATR) holds it: the band widens to it
//   (height kept within max(0.08, 0.175) ATR .. 1.5 ATR around its middle), touches + 1, and the volume POC moves to it
//   when its volume is the highest so far. Otherwise it pairs with the first waiting pivot of its kind within 0.35 ATR
//   (waiting pivots expire after 100 bars, at most 20 kept) and the pair opens a zone with 2 touches; else it waits.
// - Same-role zones within 0.35 ATR of each other merge (touches and pre-flip touches add up).
// - At each close, newest zone first: a close through a zone (over a resistance's top / under a support's bottom)
//   flips its role (pre-flip touches += touches, touches = 1). Else a bar trading into it counts a retest when 5+ bars
//   passed since its last touch (a high-volume bar sets the volume tag), and a rejection is a bar that wicks in and
//   closes outside in the candle's direction (bearish close under a resistance, bullish close over a support) while
//   the zone scores 60+. Zones more than 20 ATR from the close are dropped, then the oldest beyond 12.
// - Score 0-100 = int(min(100, 80 - 40 / (1 + (max(touches, 2) - 2) x 0.15) + 8 (HTF) + 6 (round) + 6 (volume))),
//   touches counting both roles; HTF = the zone's middle (the POC when inside the zone) within 0.5 ATR of the last
//   swing high (resistance) / low (support) of the higher timeframe: ta.pivothigh/low(5, 2) on the last CLOSED W bar
//   for 4H and M bar for 1D (request.security without look-ahead), built from the daily bars; round = within 0.15 ATR
//   of a multiple of 1/10, 1/20, 1/100 or 1/200 of the price's power of ten (for ETH and BTC this is true at almost any
//   price: the finest step is 0.5% of the power of ten, so the tag is nearly always on).
// - The owner's strength cutoff (round 4): a zone is STRONG at a score of 60+.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taSma } from './pine';
import { pinePivot } from './srbreaks';
import { aggregate } from './wyckoffhtf';

export const SRZ = {
  pivot: { '4H': 18, '1D': 24 }, pvRight: 3, atrLen: 14, clusterTolAtr: 0.35, minHeightAtr: 0.08, maxHeightAtr: 1.5, htfTolAtr: 0.5, roundTolAtr: 0.15,
  retestSepBars: 5, bufferMaxAge: 100, bufferMax: 20, zoneFarAtr: 20, maxZones: 12, volLen: 20, volMult: 1.5, htfLeft: 5, htfRight: 2, strongScore: 60,
} as const;
export type SrTf = '4H' | '1D';

export interface SrZone { id: number; top: number; bot: number; dir: 1 | -1; touch: number; preTouch: number; flipCount: number; born: number; lastTouchBar: number; hasVol: boolean; pocPx: number; maxVol: number }
/** A zone as it stood at a bar close, with its score and tags. */
export interface SrSnap { id: number; top: number; bot: number; mid: number; dir: 1 | -1; touch: number; preTouch: number; flips: number; score: number; htf: boolean; round: boolean; vol: boolean }
export type SrKind = 'new' | 'strong' | 'flip' | 'retest' | 'reject';
/** dir: the zone's role after the event (a flip's new role); prevScore: the score before a flip. */
export interface SrEvent { i: number; kind: SrKind; zone: SrSnap; prevScore?: number }
export interface SrSeries { tf: SrTf; atr: number[]; htfHi: number[]; htfLo: number[]; snaps: SrSnap[][]; events: SrEvent[] }

/** True when px is within tol of a round number of its magnitude (f_isRoundNear). */
export function roundNear(px: number, tol: number): boolean {
  const a = Math.abs(px);
  if (!(a > 0) || !(tol >= 0)) return false;
  const b1 = 10 ** Math.floor(Math.log10(a)), b01 = b1 / 10, b001 = b1 / 100;
  return [b01, b01 / 2, b001, b001 / 2].some((s) => Math.abs(a - Math.round(a / s) * s) <= tol);
}
export const srScore = (touches: number, htf: boolean, round: boolean, vol: boolean) => {
  const t = Math.max(touches, 2);
  return Math.trunc(Math.min(100, 80 - 40 / (1 + (t - 2) * 0.15) + (htf ? 8 : 0) + (round ? 6 : 0) + (vol ? 6 : 0)));
};

/**
 * The higher timeframe's last confirmed swing high / low per chart bar: ta.pivothigh/low(5, 2) on the HTF bars closed
 * by the chart bar's close (W for 4H, M for 1D, aggregated from d1).
 */
export function htfSwings(c: ReadonlyArray<Candle>, ms: number, d1: ReadonlyArray<Candle>, unit: 'W' | 'M'): { hi: number[]; lo: number[] } {
  const { c: h, ends } = aggregate(d1, unit), hh = h.map((b) => b.high), hl = h.map((b) => b.low), lastHi: number[] = [], lastLo: number[] = [];
  let ph = NaN, pl = NaN;
  for (let j = 0; j < h.length; j++) {
    const a = pinePivot(hh, j, SRZ.htfLeft, SRZ.htfRight, true), b = pinePivot(hl, j, SRZ.htfLeft, SRZ.htfRight, false);
    if (a != null) ph = a;
    if (b != null) pl = b;
    lastHi.push(ph); lastLo.push(pl);
  }
  const hi: number[] = [], lo: number[] = [];
  let j = -1;
  for (const b of c) {
    const t = b.openTime + ms;
    while (j + 1 < h.length && ends[j + 1]! <= t) j++;
    hi.push(j >= 0 ? lastHi[j]! : NaN); lo.push(j >= 0 ? lastLo[j]! : NaN);
  }
  return { hi, lo };
}

/** The script on one timeframe's closed bars; d1 (the daily history) feeds the HTF swings. */
export function srZones(c: ReadonlyArray<Candle>, tf: SrTf, d1: ReadonlyArray<Candle>): SrSeries {
  const S = SRZ, n = c.length, ms = tf === '4H' ? 4 * 3_600_000 : 86_400_000, L = S.pivot[tf], R = S.pvRight;
  const atr = taAtr(c, S.atrLen), vol = coinVolume(c), vsma = taSma(vol, S.volLen), hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  const hiVol = vol.map((v, i) => !Number.isNaN(v) && !Number.isNaN(vsma[i]!) && vsma[i]! > 0 && v > vsma[i]! * S.volMult);
  const htf = htfSwings(c, ms, d1, tf === '4H' ? 'W' : 'M');
  const zones: SrZone[] = [], bufs = { 1: [] as { px: number; bar: number; v: boolean; vol: number }[], [-1]: [] as { px: number; bar: number; v: boolean; vol: number }[] };
  const snaps: SrSnap[][] = [], events: SrEvent[] = [], strongSeen = new Set<number>();
  let nextId = 0;
  for (let i = 0; i < n; i++) {
    const a = atr[i]!, b = c[i]!;
    const mid = (z: SrZone) => (!Number.isNaN(z.pocPx) && z.pocPx >= z.bot && z.pocPx <= z.top ? z.pocPx : (z.top + z.bot) / 2);
    const snap = (z: SrZone): SrSnap => {
      const m = mid(z), lvl = z.dir === 1 ? htf.hi[i]! : htf.lo[i]!, ok = !Number.isNaN(a) && a > 0;
      const h = ok && !Number.isNaN(lvl) && Math.abs(m - lvl) <= S.htfTolAtr * a, r = ok && roundNear(m, S.roundTolAtr * a);
      return { id: z.id, top: z.top, bot: z.bot, mid: m, dir: z.dir, touch: z.touch, preTouch: z.preTouch, flips: z.flipCount, score: srScore(z.touch + z.preTouch, h, r, z.hasVol), htf: h, round: r, vol: z.hasVol };
    };
    if (Number.isNaN(a) || !(a > 0)) { snaps.push(zones.map(snap)); continue; }
    const bounds = (top: number, bot: number): [number, number] => {
      const minH = Math.max(S.minHeightAtr * a, S.clusterTolAtr * a * 0.5);
      if (top - bot < minH) { const m = (top + bot) / 2; top = m + minH / 2; bot = m - minH / 2; }
      if (top - bot > S.maxHeightAtr * a) { const m = (top + bot) / 2; top = m + (S.maxHeightAtr * a) / 2; bot = m - (S.maxHeightAtr * a) / 2; }
      return [top, bot];
    };
    const tol = S.clusterTolAtr * a;
    const pivot = (dir: 1 | -1, px: number, isVol: boolean, rawVol: number): boolean => {
      for (const z of zones) {
        if (z.dir === dir && px >= z.bot - tol && px <= z.top + tol) {
          [z.top, z.bot] = bounds(Math.max(z.top, px), Math.min(z.bot, px));
          z.touch++; z.lastTouchBar = i; z.hasVol ||= isVol;
          if (rawVol > z.maxVol) { z.maxVol = rawVol; z.pocPx = px; }
          return false;
        }
      }
      const buf = bufs[dir];
      for (let k = buf.length - 1; k >= 0; k--) if (i - buf[k]!.bar > S.bufferMaxAge) buf.splice(k, 1);
      const k = buf.findIndex((w) => Math.abs(w.px - px) <= tol);
      if (k >= 0) {
        const w = buf[k]!, [top, bot] = bounds(Math.max(w.px, px), Math.min(w.px, px));
        zones.push({ id: nextId++, top, bot, dir, touch: 2, preTouch: 0, flipCount: 0, born: Math.min(w.bar, i - R), lastTouchBar: i, hasVol: w.v || isVol, pocPx: rawVol >= w.vol ? px : w.px, maxVol: Math.max(rawVol, w.vol) });
        buf.splice(k, 1);
        return true;
      }
      buf.push({ px, bar: i - R, v: hiVol[i - R]!, vol: rawVol });
      if (buf.length > S.bufferMax) buf.shift();
      return false;
    };
    const rv = (k: number) => (Number.isNaN(vol[k]!) ? 0 : vol[k]!);
    if (i - R >= 0) {
      if (pinePivot(hi, i, L, R, true) != null && pivot(1, hi[i - R]!, hiVol[i - R]!, rv(i - R))) events.push({ i, kind: 'new', zone: snap(zones.at(-1)!) });
      if (pinePivot(lo, i, L, R, false) != null && pivot(-1, lo[i - R]!, hiVol[i - R]!, rv(i - R))) events.push({ i, kind: 'new', zone: snap(zones.at(-1)!) });
    }
    // f_mergeZones
    for (let p = zones.length - 1; p >= 1; p--) {
      const zi = zones[p]!;
      for (let q = p - 1; q >= 0; q--) {
        const zj = zones[q]!;
        if (zi.dir === zj.dir && zi.top >= zj.bot - tol && zi.bot <= zj.top + tol) {
          [zj.top, zj.bot] = bounds(Math.max(zi.top, zj.top), Math.min(zi.bot, zj.bot));
          zj.touch += zi.touch; zj.preTouch += zi.preTouch; zj.lastTouchBar = Math.max(zi.lastTouchBar, zj.lastTouchBar); zj.born = Math.min(zi.born, zj.born); zj.hasVol ||= zi.hasVol;
          if (zi.maxVol > zj.maxVol) { zj.maxVol = zi.maxVol; zj.pocPx = zi.pocPx; }
          zones.splice(p, 1);
          break;
        }
      }
    }
    // Retest / break / flip / rejection, newest zone first.
    for (let p = zones.length - 1; p >= 0; p--) {
      const z = zones[p]!;
      if (z.born !== i) {
        if (z.dir === 1 ? b.close > z.top : b.close < z.bot) {
          const before = snap(z).score;
          z.dir = (z.dir * -1) as 1 | -1; z.preTouch += z.touch; z.touch = 1; z.flipCount++; z.lastTouchBar = i;
          events.push({ i, kind: 'flip', zone: snap(z), prevScore: before });
        } else if (b.low <= z.top && b.high >= z.bot) {
          if (i - z.lastTouchBar >= S.retestSepBars) {
            z.touch++; z.lastTouchBar = i;
            if (hiVol[i]) z.hasVol = true;
            events.push({ i, kind: 'retest', zone: snap(z) });
          }
          const s = snap(z);
          if (s.score >= S.strongScore && (z.dir === 1 ? b.high >= z.bot && b.close < z.bot && b.close < b.open : b.low <= z.top && b.close > z.top && b.close > b.open)) events.push({ i, kind: 'reject', zone: s });
        }
      }
      if (Math.abs(b.close - mid(z)) > S.zoneFarAtr * a) zones.splice(p, 1);
    }
    while (zones.length > S.maxZones) zones.shift();
    const now = zones.map(snap);
    for (const s of now) if (s.score >= S.strongScore && !strongSeen.has(s.id)) { strongSeen.add(s.id); events.push({ i, kind: 'strong', zone: s }); }
    snaps.push(now);
  }
  return { tf, atr, htfHi: htf.hi, htfLo: htf.lo, snaps, events };
}

/** The strong zones at bar i nearest the close, one per side (resistance above, support below) by default. */
export function nearestStrong(S: SrSeries, i: number, price: number, perSide = 1): { above: SrSnap[]; below: SrSnap[] } {
  const strong = (S.snaps[i] ?? []).filter((z) => z.score >= SRZ.strongScore), dist = (z: SrSnap) => Math.abs(z.mid - price);
  return {
    above: strong.filter((z) => z.mid >= price).sort((x, y) => dist(x) - dist(y)).slice(0, perSide),
    below: strong.filter((z) => z.mid < price).sort((x, y) => dist(x) - dist(y)).slice(0, perSide),
  };
}

/** Touches as the badge prints them: "3+2×" after a flip, else "4×". */
export const srTouches = (z: SrSnap) => (z.flips > 0 && z.preTouch > 0 ? `${z.preTouch}+${z.touch}×` : `${z.touch}×`);
export const srTags = (z: SrSnap) => `${z.htf ? ' ◈' : ''}${z.round ? ' ◎' : ''}${z.vol ? ' Ⓥ' : ''}`;
