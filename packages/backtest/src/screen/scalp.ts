// 15m / 1h RSI scalp study (owner 2026-10-03, LINK 15m and 1h screenshots: "mainly to be used together for a 15m 1h
// scalping signal, that might become a bot"). Research only. Rules fixed before the run:
//
// RSI 14 (Wilder) pivots: a pivot needs 5 bars on the left and 2 on the right, so it is known when the 2nd bar after it
// closes; the trade enters at the next bar's open.
//  - long 'rsi-hl': a pivot low B <= bHi that is higher than an earlier pivot low A <= aHi (5..60 bars before B) - the
//    owner's green lines (rising RSI lows from the oversold band); 'bull-div': the same with price low B <= price low A.
//  - short 'rsi-lh': a pivot high B >= bLo lower than an earlier pivot high A >= aLo - the owner's red lines (falling
//    RSI highs from 80 to 70); 'bear-div': the same with price high B >= price high A.
//  - grids: loose (A <= 30, B <= 40 / A >= 70, B >= 60) and tight (A <= 25, B <= 35 / A >= 75, B >= 65).
// Stop: under the lowest low from 5 bars before B to the entry (shorts: over the highest high) -/+ 0.2 ATR(14).
// Exits: 1.5R or 2R target, or 'RSI' = the close where RSI reaches 70 (longs) / 30 (shorts); always a time cap (15m: 96
// bars = 24h, 1h: 48 bars = 48h). A gap through the stop exits at the open. Costs per round trip 0.22% (taker plus
// slippage) and, separately, 0.10%. One trade at a time per coin and line.
// Combinations: '15m' alone; '1h' alone; '15m + 1h signal' = a 15m signal taken only if a 1h signal of the same side and
// type was known within the 12 hours before; '15m + 1h RSI' = a 15m signal taken only if the last closed 1h RSI is <= 45
// (longs) / >= 55 (shorts); '1h then 15m' = after a 1h signal, the first 15m signal of the same side within 4 hours.

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Family = 'hl' | 'div';
type Grid = 'loose' | 'tight';
type Exit = '1.5R' | '2R' | 'RSI';
type Combo = '15m' | '1h' | '15m + 1h signal' | '15m + 1h RSI' | '1h then 15m';

const H = 3_600_000, BAR = { '15m': H / 4, '1h': H } as const;
const GRID: Record<Grid, { aHi: number; bHi: number; aLo: number; bLo: number }> = {
  loose: { aHi: 30, bHi: 40, aLo: 70, bLo: 60 },
  tight: { aHi: 25, bHi: 35, aLo: 75, bLo: 65 },
};
const LEFT = 5, RIGHT = 2, MAXGAP = 60;

export interface ScalpSignal { i: number; d: 1 | -1; family: Family; grid: Grid; b: number; a: number }

/** Every signal on one timeframe; `i` = the bar whose close confirms pivot B (enter at i + 1). */
export function scalpSignals(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>): ScalpSignal[] {
  const lows: number[] = [], highs: number[] = [], out: ScalpSignal[] = [];
  for (let i = RIGHT; i < c.length; i++) {
    const k = i - RIGHT, v = r[k];
    if (v == null || k - LEFT < 0) continue;
    let isLow = true, isHigh = true;
    for (let j = k - LEFT; j <= k + RIGHT; j++) {
      if (j === k) continue;
      const w = r[j];
      if (w == null) { isLow = isHigh = false; break; }
      if (w < v || (w === v && j < k)) isLow = false;
      if (w > v || (w === v && j < k)) isHigh = false;
    }
    for (const grid of ['loose', 'tight'] as Grid[]) {
      const g = GRID[grid];
      if (isLow && v <= g.bHi) {
        const cand = lows.filter((p) => k - p >= 5 && k - p <= MAXGAP && r[p]! <= g.aHi && r[p]! < v);
        const a = cand.at(-1);
        if (a != null) out.push({ i, d: 1, family: 'hl', grid, b: k, a });
        const ad = cand.filter((p) => c[k]!.low <= c[p]!.low).at(-1);
        if (ad != null) out.push({ i, d: 1, family: 'div', grid, b: k, a: ad });
      }
      if (isHigh && v >= g.bLo) {
        const cand = highs.filter((p) => k - p >= 5 && k - p <= MAXGAP && r[p]! >= g.aLo && r[p]! > v);
        const a = cand.at(-1);
        if (a != null) out.push({ i, d: -1, family: 'hl', grid, b: k, a });
        const ad = cand.filter((p) => c[k]!.high >= c[p]!.high).at(-1);
        if (ad != null) out.push({ i, d: -1, family: 'div', grid, b: k, a: ad });
      }
    }
    if (isLow) lows.push(k);
    if (isHigh) highs.push(k);
  }
  return out;
}

/** A scalp from the open of bar j. Returns the gross R and the cost in R per 1% of round-trip cost. */
export function scalpTrade(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, j: number, stop: number, d: 1 | -1, cap: number, exit: Exit): { gross: number; costR: number; stopPct: number; bars: number; end: number } | null {
  if (j >= c.length) return null;
  const px = c[j]!.open, risk = d * (px - stop);
  if (!(risk > 0)) return null;
  const last = j + cap - 1;
  if (last >= c.length) return null;
  const tgt = exit === '1.5R' ? px + d * 1.5 * risk : exit === '2R' ? px + d * 2 * risk : null;
  let out = c[last]!.close, end = last;
  for (let i = j; i <= last; i++) {
    const b = c[i]!;
    if (i > j && d * (b.open - stop) <= 0) { out = b.open; end = i; break; }
    if (d > 0 ? b.low <= stop : b.high >= stop) { out = stop; end = i; break; }
    if (tgt != null && (d > 0 ? b.high >= tgt : b.low <= tgt)) { out = i > j && d * (b.open - tgt) >= 0 ? b.open : tgt; end = i; break; }
    const v = r[i];
    if (exit === 'RSI' && v != null && (d > 0 ? v >= 70 : v <= 30)) { out = b.close; end = i; break; }
  }
  return { gross: (d * (out - px)) / risk, costR: px / risk / 100, stopPct: (100 * risk) / px, bars: end - j + 1, end };
}

interface Tf { c: ReadonlyArray<Candle>; r: (number | null)[]; atr: (number | null)[]; sig: ScalpSignal[]; bar: number; cap: number }
const prep = (c: ReadonlyArray<Candle>, tf: '15m' | '1h'): Tf => {
  const r = rsi(c.map((x) => x.close), 14);
  return { c, r, atr: atrWilder(c, 14), sig: scalpSignals(c, r), bar: BAR[tf], cap: tf === '15m' ? 96 : 48 };
};
const stopFor = (t: Tf, s: ScalpSignal, j: number): number | null => {
  const a = t.atr[s.i];
  if (a == null) return null;
  let x = s.d > 0 ? Infinity : -Infinity;
  for (let k = Math.max(0, s.b - LEFT); k < j; k++) x = s.d > 0 ? Math.min(x, t.c[k]!.low) : Math.max(x, t.c[k]!.high);
  return x - s.d * 0.2 * a;
};
/** Last closed bar at time t. */
const lastClosed = (c: ReadonlyArray<Candle>, bar: number, t: number) => { let lo = 0, hi = c.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime + bar <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

/** Sorted-array searches: first index with value >= t (lower) / > t (upper). */
const lower = (a: ReadonlyArray<number>, t: number) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m]! < t) lo = m + 1; else hi = m; } return lo; };
const upper = (a: ReadonlyArray<number>, t: number) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m]! <= t) lo = m + 1; else hi = m; } return lo; };

interface ScalpTradeRow extends SignalTrade { gross: number; costR: number }

export function scalpReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, show: ReadonlyArray<string> = ['LINKUSDT']): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const COMBOS: Combo[] = ['15m', '1h', '15m + 1h signal', '15m + 1h RSI', '1h then 15m'];
  const EXITS: Exit[] = ['1.5R', '2R', 'RSI'];
  const trades = new Map<string, ScalpTradeRow[]>();
  const add = (k: string, t: ScalpTradeRow) => { const a = trades.get(k) ?? []; a.push(t); trades.set(k, a); };
  const shown: string[] = [];
  for (const sym of symbols) {
    const c15 = data[sym]?.candles['15m'] ?? [], c1 = data[sym]?.candles['1h'] ?? [];
    if (c15.length < 500 || c1.length < 200) continue;
    const m15 = prep(c15, '15m'), m1 = prep(c1, '1h');
    if (show.includes(sym)) {
      for (const [tf, t] of [['1h', m1], ['15m', m15]] as const) for (const s of t.sig) {
        if (s.grid !== 'loose' || t.c[s.i]!.openTime < to - 30 * 24 * H) continue;
        shown.push(`  ${sym} ${tf.padEnd(3)} ${s.d > 0 ? 'long ' : 'short'} ${s.family === 'div' ? 'divergence' : 'RSI trend  '}  pivot A ${new Date(t.c[s.a]!.openTime).toISOString().slice(0, 16)} RSI ${t.r[s.a]!.toFixed(1)}  pivot B ${new Date(t.c[s.b]!.openTime).toISOString().slice(0, 16)} RSI ${t.r[s.b]!.toFixed(1)}  enter ${new Date(t.c[s.i]!.openTime + t.bar).toISOString().slice(0, 16)}`);
      }
    }
    // 1h signals known by time t, per side / family / grid (for the confluence combos).
    const known1h = m1.sig.map((s) => ({ s, t: m1.c[s.i]!.openTime + m1.bar })), knownT = known1h.map((x) => x.t);
    const busy = new Map<string, number>();
    const take = (key: string, t: Tf, s: ScalpSignal, j: number, sigTime: number) => {
      if (sigTime < from) return;
      const stop = stopFor(t, s, j);
      if (stop == null) return;
      for (const ex of EXITS) {
        const k = `${key}|${s.d > 0 ? 'long' : 'short'}|${s.family}|${s.grid}|${ex}`;
        if (t.c[j]?.openTime == null || t.c[j]!.openTime <= (busy.get(k) ?? -Infinity)) continue;
        const tr = scalpTrade(t.c, t.r, j, stop, s.d, t.cap, ex);
        if (!tr || t.c[tr.end]!.openTime + t.bar > to) continue;
        add(k, { sym, t: t.c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars });
        busy.set(k, t.c[tr.end]!.openTime + t.bar);
      }
    };
    for (const s of m1.sig) take('1h', m1, s, s.i + 1, m1.c[s.i]!.openTime);
    for (const s of m15.sig) {
      const t0 = m15.c[s.i]!.openTime + m15.bar; // known
      take('15m', m15, s, s.i + 1, t0);
      let q = upper(knownT, t0) - 1, hit = false;
      for (; q >= 0 && t0 - knownT[q]! <= 12 * H && !hit; q--) { const x = known1h[q]!.s; hit = x.d === s.d && x.family === s.family && x.grid === s.grid; }
      if (hit) take('15m + 1h signal', m15, s, s.i + 1, t0);
      const h = lastClosed(m1.c, m1.bar, t0), hv = h >= 0 ? m1.r[h] : null;
      if (hv != null && (s.d > 0 ? hv <= 45 : hv >= 55)) take('15m + 1h RSI', m15, s, s.i + 1, t0);
    }
    // 1h then 15m: the first 15m signal (same side, any family / grid of the 15m) within 4 hours after a 1h signal.
    const t15 = m15.sig.map((s) => m15.c[s.i]!.openTime + m15.bar);
    for (const x of known1h) {
      let s15: ScalpSignal | undefined;
      for (let q = lower(t15, x.t); q < t15.length && t15[q]! - x.t <= 4 * H; q++) { const s = m15.sig[q]!; if (s.d === x.s.d && s.family === x.s.family && s.grid === x.s.grid) { s15 = s; break; } }
      if (s15) take('1h then 15m', m15, s15, s15.i + 1, m15.c[s15.i]!.openTime + m15.bar);
    }
  }
  const withCost = (ts: ScalpTradeRow[], cost: number): SignalTrade[] => ts.map((t) => ({ ...t, r: t.gross - cost * t.costR }));
  const out = [
    `15m / 1h RSI SCALP STUDY (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'hl = rising RSI lows / falling RSI highs (owner\'s lines); div = with a price divergence. loose = A<=30,B<=40 / A>=70,B>=60; tight = A<=25,B<=35 / A>=75,B>=65.',
    'Stop past the swing +/- 0.2 ATR; exits 1.5R, 2R or RSI back to 70 / 30, time cap 24h (15m) / 48h (1h).',
    '  combo / side / type / grid / exit                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  for (const cost of [0.22, 0.10]) {
    out.push('', `COSTS ${cost.toFixed(2)}% PER ROUND TRIP`);
    for (const combo of COMBOS) {
      out.push(`${combo}`);
      for (const side of ['long', 'short']) for (const fam of ['hl', 'div'] as Family[]) for (const grid of ['loose', 'tight'] as Grid[]) for (const ex of EXITS) {
        if (cost === 0.10 && ex !== '2R' && ex !== 'RSI') continue;
        const k = `${combo}|${side}|${fam}|${grid}|${ex}`;
        out.push(statsLine(`${side} ${fam === 'hl' ? 'RSI trend' : 'divergence'} ${grid} ${ex}`.padEnd(76), withCost(trades.get(k) ?? [], cost), cut));
      }
    }
  }
  out.push('', `SIGNALS IN THE LAST 30 DAYS (loose grid) for ${show.join(', ')}, times UTC (bar open). Compare with the chart:`, ...shown.sort());
  return out;
}
