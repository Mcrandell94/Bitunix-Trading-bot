// TypeScript port of "Strong Fibo Clusters" (Pine v6) for the ETH / BTC cards (owner 2026-10-11, round 4). The copy
// given has no licence header; TradingView's default for open scripts is MPL 2.0, noted as for Wyckoff. Calculations
// only (no boxes, lines, labels or separators), default inputs: weekly anchor, 1 period of source swings.
//
// Bar-for-bar notes (defaults kept):
// - Swings: ta.pivothigh/low(10, 10), newest first, at most 300 kept. ATR = ta.atr(14).
// - At the first bar of each week (Monday 00:00 UTC; the week's first bar is part of it): untouched levels of the week
//   that just ended become virgin magnets (its prior high / low and every untouched cluster; at most 8 magnets, oldest
//   dropped); then from the ended week's high / low (H / L) and its swings (pivot bars from the previous week start up
//   to this bar, at most 10 highs and 10 lows, newest first) the new week's levels are built:
//   - every swing high x swing low pair spanning >= 2 ATR gives 0.236 / 0.382 / 0.5 / 0.618 / 0.786 retracements
//     (high - range x r); a level joins the nearest cluster within 0.5 ATR (its centre moves to the running mean, and
//     its strength counts each pair once), else starts one; clusters of strength 2+ are ranked by strength (ties keep
//     their order), and the top 5 at least 1.5 ATR apart are kept (zone = centre +/- 0.2 ATR);
//   - the golden pocket L + (H - L) x 0.5 .. 0.618 and the 50% line; extensions H + 0.13 / 0.27 x range and
//     L - 0.13 / 0.27 x range;
//   - the prior high / low states: sweep = a high >= H + 0.08 ATR closing back under H (from intact); acceptance = a
//     close over H + 0.30 ATR (from any state); failed break = a close back under H after acceptance (low side
//     mirrored). The ATR is the one at the week's first bar.
// - Each bar (the week's first included): a zone traded into is touched (once); the prior high / low traded through
//   is touched; a magnet traded through is tagged and removed.
// - The owner's strength cutoff (round 4): a cluster is STRONG at strength 4+. 4H only (the script needs bars inside
//   the week; it refuses a timeframe of a week or more).
// Pure.

import type { Candle } from '@bot/marketdata';
import { taAtr } from './pine';
import { pinePivot } from './srbreaks';

const DAY = 86_400_000;
export const FIBCL = { swing: 10, maxSwings: 10, ratios: [0.236, 0.382, 0.5, 0.618, 0.786], tolAtr: 0.5, minRangeAtr: 2, minStr: 2, maxClusters: 5, sepAtr: 1.5, zoneHalfAtr: 0.2, gp: [0.5, 0.618], ext: [0.13, 0.27], sweepAtr: 0.08, breakAtr: 0.3, maxMagnets: 8, strong: 4 } as const;

export type FibZoneKind = 'cluster' | 'gp' | 'eq' | 'ext';
export interface FibZone { kind: FibZoneKind; center: number; top: number; bot: number; strength: number; tag: string; touchedAt: number; fromSide: 1 | -1 | 0 }
export interface FibWeek { i: number; weekOf: number; high: number; low: number; atr: number; zones: FibZone[] }
/** 0 intact, 1 swept, 2 accepted, 3 failed break. */
export type ExtState = 0 | 1 | 2 | 3;
export interface Magnet { price: number; tag: string; bornAt: number; taggedAt: number; droppedAt: number }
export type FibKind = 'sweep-high' | 'sweep-low' | 'accept-high' | 'accept-low' | 'fail-high' | 'fail-low' | 'touch' | 'magnet';
export interface FibEvent { i: number; kind: FibKind; price: number; zone?: FibZone; magnet?: Magnet }
export interface FibSeries { atr: number[]; weeks: FibWeek[]; weekAt: Int32Array; stHigh: Int8Array; stLow: Int8Array; magnets: Magnet[]; events: FibEvent[] }

const weekStart = (t: number) => { const d = Math.floor(t / DAY) * DAY; return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };

export function fibClusters(c: ReadonlyArray<Candle>): FibSeries {
  const F = FIBCL, n = c.length, atr = taAtr(c, 14), hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  const swings: { price: number; bar: number; isHigh: boolean }[] = [], boundaries: number[] = [], weeks: FibWeek[] = [], magnets: Magnet[] = [], live: Magnet[] = [], events: FibEvent[] = [];
  const weekAt = new Int32Array(n).fill(-1), stHigh = new Int8Array(n), stLow = new Int8Array(n);
  let pH = NaN, pL = NaN, active: FibWeek | null = null, stU: ExtState = 0, stL: ExtState = 0, tU = false, tL = false;
  for (let i = 0; i < n; i++) {
    const b = c[i]!;
    const ph = pinePivot(hi, i, F.swing, F.swing, true), pl = pinePivot(lo, i, F.swing, F.swing, false);
    if (ph != null) swings.unshift({ price: ph, bar: i - F.swing, isHigh: true });
    if (pl != null) swings.unshift({ price: pl, bar: i - F.swing, isHigh: false });
    if (swings.length > 300) swings.length = 300;
    const newP = i > 0 && weekStart(b.openTime) !== weekStart(c[i - 1]!.openTime);
    if (newP) {
      if (active) {
        const spawn = (price: number, tag: string) => { const m: Magnet = { price, tag, bornAt: i, taggedAt: -1, droppedAt: -1 }; magnets.push(m); live.push(m); };
        if (!tU) spawn(active.high, 'virgin week high');
        if (!tL) spawn(active.low, 'virgin week low');
        for (const z of active.zones) if (z.kind === 'cluster' && z.touchedAt < 0) spawn(z.center, 'virgin cluster');
        while (live.length > F.maxMagnets) live.shift()!.droppedAt = i;
      }
      const prevH = pH, prevL = pL, startBar = boundaries.length ? boundaries[0]! : 0, a = atr[i]!;
      active = null; stU = 0; stL = 0; tU = false; tL = false;
      if (!Number.isNaN(prevH) && !Number.isNaN(prevL) && prevH > prevL && !Number.isNaN(a)) {
        const rng = prevH - prevL, tol = a * F.tolAtr, half = a * F.zoneHalfAtr, hs: number[] = [], ls: number[] = [];
        for (const s of swings) if (s.bar >= startBar && s.bar < i) { if (s.isHigh) { if (hs.length < F.maxSwings) hs.push(s.price); } else if (ls.length < F.maxSwings) ls.push(s.price); }
        const cl: { center: number; strength: number }[] = [];
        for (const sh of hs) for (const sl of ls) {
          const pr = sh - sl;
          if (!(pr >= a * F.minRangeAtr)) continue;
          const contributed = cl.map(() => false);
          for (const r of F.ratios) {
            const lp = sh - pr * r;
            let best = -1, bestD = tol + 1;
            for (let k = 0; k < cl.length; k++) { const d = Math.abs(lp - cl[k]!.center); if (d <= tol && d < bestD) { bestD = d; best = k; } }
            if (best >= 0) {
              const ck = cl[best]!;
              ck.center = (ck.center * ck.strength + lp) / (ck.strength + 1);
              if (!contributed[best]) { ck.strength++; contributed[best] = true; }
            } else { cl.push({ center: lp, strength: 1 }); contributed.push(true); }
          }
        }
        const q = cl.filter((k) => k.strength >= F.minStr);
        for (let x = 0; x < q.length - 1; x++) for (let y = 0; y < q.length - 1 - x; y++) if (q[y]!.strength < q[y + 1]!.strength) [q[y], q[y + 1]] = [q[y + 1]!, q[y]!];
        const sel: typeof q = [];
        for (const k of q) { if (sel.length >= F.maxClusters) break; if (!sel.some((e) => Math.abs(k.center - e.center) < a * F.sepAtr)) sel.push(k); }
        const zones: FibZone[] = sel.map((k) => ({ kind: 'cluster', center: k.center, top: k.center + half, bot: k.center - half, strength: k.strength, tag: `cluster ${k.strength}`, touchedAt: -1, fromSide: 0 }));
        const gpTop = prevL + rng * Math.max(...F.gp), gpBot = prevL + rng * Math.min(...F.gp);
        zones.push({ kind: 'gp', center: (gpTop + gpBot) / 2, top: gpTop, bot: gpBot, strength: 0, tag: 'golden pocket', touchedAt: -1, fromSide: 0 });
        const eq = prevL + rng * 0.5;
        zones.push({ kind: 'eq', center: eq, top: eq, bot: eq, strength: 0, tag: '50%', touchedAt: -1, fromSide: 0 });
        for (const [p, tag] of [[prevH + rng * F.ext[0], 'ext 1.13'], [prevH + rng * F.ext[1], 'ext 1.27'], [prevL - rng * F.ext[0], 'ext -0.13'], [prevL - rng * F.ext[1], 'ext -0.27']] as const) zones.push({ kind: 'ext', center: p, top: p + half, bot: p - half, strength: 0, tag, touchedAt: -1, fromSide: 0 });
        active = { i, weekOf: weekStart(b.openTime), high: prevH, low: prevL, atr: a, zones };
        weeks.push(active);
      }
      boundaries.unshift(i);
      if (boundaries.length > 4 + 3) boundaries.length = 7;
      pH = b.high; pL = b.low;
    } else { pH = Number.isNaN(pH) ? b.high : Math.max(pH, b.high); pL = Number.isNaN(pL) ? b.low : Math.min(pL, b.low); }
    if (active) {
      weekAt[i] = weeks.length - 1;
      const prevClose = i > 0 ? c[i - 1]!.close : NaN;
      for (const z of active.zones) if (z.touchedAt < 0 && b.high >= z.bot && b.low <= z.top) {
        z.touchedAt = i; z.fromSide = prevClose > z.top ? 1 : prevClose < z.bot ? -1 : 0;
        events.push({ i, kind: 'touch', price: z.center, zone: z });
      }
      const H = active.high, L = active.low, a = active.atr;
      if (b.high >= H && b.low <= H) tU = true;
      if (b.high >= L && b.low <= L) tL = true;
      const pU = stU, pLs = stL;
      if (b.close > H + a * F.breakAtr) stU = 2; else if (stU === 2 && b.close < H) stU = 3; else if (stU === 0 && b.high >= H + a * F.sweepAtr && b.close < H) stU = 1;
      if (b.close < L - a * F.breakAtr) stL = 2; else if (stL === 2 && b.close > L) stL = 3; else if (stL === 0 && b.low <= L - a * F.sweepAtr && b.close > L) stL = 1;
      if (stU === 1 && pU === 0) events.push({ i, kind: 'sweep-high', price: H });
      if (stL === 1 && pLs === 0) events.push({ i, kind: 'sweep-low', price: L });
      if (stU === 2 && pU !== 2) events.push({ i, kind: 'accept-high', price: H });
      if (stL === 2 && pLs !== 2) events.push({ i, kind: 'accept-low', price: L });
      if (stU === 3 && pU === 2) events.push({ i, kind: 'fail-high', price: H });
      if (stL === 3 && pLs === 2) events.push({ i, kind: 'fail-low', price: L });
      stHigh[i] = stU; stLow[i] = stL;
    }
    for (let k = live.length - 1; k >= 0; k--) {
      const m = live[k]!;
      if (b.low <= m.price && b.high >= m.price) { m.taggedAt = i; live.splice(k, 1); events.push({ i, kind: 'magnet', price: m.price, magnet: m }); }
    }
  }
  return { atr, weeks, weekAt, stHigh, stLow, magnets, events };
}

/** The magnets live at bar i: spawned by i, neither tagged nor pushed out by the 8-magnet cap by i. */
export const liveMagnets = (S: FibSeries, i: number): Magnet[] => S.magnets.filter((m) => m.bornAt <= i && (m.taggedAt < 0 || m.taggedAt > i) && (m.droppedAt < 0 || m.droppedAt > i));

export const stateWord = (s: number) => (s === 1 ? 'swept' : s === 2 ? 'accepted' : s === 3 ? 'failed break' : 'intact');
