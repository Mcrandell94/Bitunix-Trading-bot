// Selective 1h / 15m RSI divergence scalp (owner 2026-10-04, ETH 1h and 15m screenshots: green lines from a deep RSI
// low to later higher lows = longs, red lines from a spike high to later lower highs = shorts; "vertical lines are
// mainly entry points"; exits: "not sure, test them"). Research only. Rules fixed before the run:
//
// The first scalp study (scalp.ts) fired on every small pivot pair and lost everywhere. Here a line needs an ANCHOR:
//  - long anchor A: an RSI 14 pivot low (5 bars left, 2 right) <= level (30 or 25) that is the lowest RSI of the 100
//    bars before it; it stays active until any RSI print goes under it, or MAXSPAN bars pass.
//  - entry point B: a later pivot low (>= 10 bars after A) with RSI above A's and <= 45. 'hl' = rising RSI low only;
//    'div' = also price low at B <= price low at A. Shorts mirror (>= 70 / 75, highest of 100 bars, B below A and >= 55).
//  - 'first' = only the first B per anchor (per family); 'all' = every B (one open trade per coin and line).
//  - known when the 2nd bar after B closes; enter at the next bar's open.
// Direction (the guidelines' daily bias): none; 'sma200' = last closed daily close above (longs) / below (shorts) the
// 200-day SMA; '4h rsi' = last closed 4H RSI >= 50 (longs) / <= 50 (shorts).
// Stop: past the extreme from 5 bars before B to the entry +/- 0.2 ATR(14). Exits: 2R, 3R, RSI to 70 / 30, the next
// opposite signal (same timeframe, family and level), a 3 ATR trail armed at +1R; time cap 1h 120 bars, 15m 192 bars.
// Costs 0.22% (taker plus slippage) and 0.10% per round trip. Combos: 1h, 15m, and 15m with a same-side 1h signal
// (same family and level) known in the 24 hours before.
// Random baseline: the same entries, stop distances and exits with the side set by a seeded coin flip (20 seeds).

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi, sma } from '../indicators';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
export type Family = 'hl' | 'div';
export type Level = 30 | 25;
type Dir = 'none' | 'sma200' | '4h rsi';
export type Exit = '2R' | '3R' | 'RSI' | 'opposite' | 'trail';
type Combo = '1h' | '15m' | '15m + 1h';

const H = 3_600_000, BAR = { '15m': H / 4, '1h': H } as const, CAP = { '15m': 192, '1h': 120 } as const;
const LEFT = 5, RIGHT = 2, LOOK = 100, MINGAP = 10, MAXSPAN = 500;
const LEVELS: Level[] = [30, 25], FAMS: Family[] = ['hl', 'div'], DIRS: Dir[] = ['none', 'sma200', '4h rsi'];
const EXITS: Exit[] = ['2R', '3R', 'RSI', 'opposite', 'trail'], COMBOS: Combo[] = ['1h', '15m', '15m + 1h'];

export interface Scalp2Signal { i: number; d: 1 | -1; family: Family; first: boolean; b: number; a: number }

/** Anchored RSI signals on one timeframe for one anchor level; `i` = the bar whose close confirms pivot B. */
export function scalp2Signals(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, level: Level): Scalp2Signal[] {
  type Anchor = { k: number; v: number; used: Record<Family, boolean> };
  let longs: Anchor[] = [], shorts: Anchor[] = [];
  const out: Scalp2Signal[] = [];
  for (let i = 0; i < c.length; i++) {
    const now = r[i];
    // Invalidation: any RSI print beyond an anchor kills it (known at bar i), as does age.
    if (now != null) { longs = longs.filter((a) => now >= a.v && i - a.k <= MAXSPAN); shorts = shorts.filter((a) => now <= a.v && i - a.k <= MAXSPAN); }
    const k = i - RIGHT, v = k >= 0 ? r[k] : null;
    if (v == null || k - LEFT < 0) continue;
    let isLow = true, isHigh = true;
    for (let j = k - LEFT; j <= k + RIGHT; j++) {
      if (j === k) continue;
      const w = r[j];
      if (w == null) { isLow = isHigh = false; break; }
      if (w < v || (w === v && j < k)) isLow = false;
      if (w > v || (w === v && j < k)) isHigh = false;
    }
    if (isLow) {
      if (v <= 45) for (const a of longs) {
        if (k - a.k < MINGAP || !(v > a.v)) continue;
        for (const family of FAMS) {
          if (family === 'div' && !(c[k]!.low <= c[a.k]!.low)) continue;
          out.push({ i, d: 1, family, first: !a.used[family], b: k, a: a.k });
          a.used[family] = true;
        }
      }
      let lowest = v <= level;
      for (let j = Math.max(0, k - LOOK); j < k && lowest; j++) { const w = r[j]; if (w != null && w < v) lowest = false; }
      if (lowest && k >= LOOK) longs.push({ k, v, used: { hl: false, div: false } });
    }
    if (isHigh) {
      if (v >= 55) for (const a of shorts) {
        if (k - a.k < MINGAP || !(v < a.v)) continue;
        for (const family of FAMS) {
          if (family === 'div' && !(c[k]!.high >= c[a.k]!.high)) continue;
          out.push({ i, d: -1, family, first: !a.used[family], b: k, a: a.k });
          a.used[family] = true;
        }
      }
      let highest = v >= 100 - level;
      for (let j = Math.max(0, k - LOOK); j < k && highest; j++) { const w = r[j]; if (w != null && w > v) highest = false; }
      if (highest && k >= LOOK) shorts.push({ k, v, used: { hl: false, div: false } });
    }
  }
  return out;
}

/** A trade from the open of bar j; `opp` = sorted signal-bar indices of opposite signals (exit at the next open). */
export function scalp2Trade(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, cap: number, exit: Exit, opp: ReadonlyArray<number> = []): { gross: number; costR: number; stopPct: number; bars: number; end: number } | null {
  if (j >= c.length) return null;
  const px = c[j]!.open, risk = d * (px - stop0);
  if (!(risk > 0)) return null;
  const last = j + cap - 1;
  if (last >= c.length) return null;
  const tgt = exit === '2R' ? px + d * 2 * risk : exit === '3R' ? px + d * 3 * risk : null;
  let stop = stop0, best = px, armed = false, out = c[last]!.close, end = last;
  let q = 0;
  while (q < opp.length && opp[q]! < j) q++;
  for (let i = j; i <= last; i++) {
    const b = c[i]!;
    if (exit === 'opposite' && q < opp.length && opp[q]! + 1 === i && i > j) { out = b.open; end = i; break; } // signal at i-1 closed: out at i's open
    if (i > j && d * (b.open - stop) <= 0) { out = b.open; end = i; break; }
    if (d > 0 ? b.low <= stop : b.high >= stop) { out = stop; end = i; break; }
    if (tgt != null && (d > 0 ? b.high >= tgt : b.low <= tgt)) { out = i > j && d * (b.open - tgt) >= 0 ? b.open : tgt; end = i; break; }
    const v = r[i];
    if (exit === 'RSI' && v != null && (d > 0 ? v >= 70 : v <= 30)) { out = b.close; end = i; break; }
    if (exit === 'trail') {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - px) >= risk) armed = true;
      const a = atr[i];
      if (armed && a != null) { const tr = best - d * 3 * a; if (d * (tr - stop) > 0) stop = tr; }
    }
    while (q < opp.length && opp[q]! < i) q++;
  }
  return { gross: (d * (out - px)) / risk, costR: px / risk / 100, stopPct: (100 * risk) / px, bars: end - j + 1, end };
}

/** Index of the last bar closed by time t (-1 if none). */
export const lastClosed = (c: ReadonlyArray<Candle>, bar: number, t: number) => { let lo = 0, hi = c.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime + bar <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

/** Direction filter at time t (known bars only). */
export function dirOk(dir: Dir, d: 1 | -1, t: number, d1: { c: ReadonlyArray<Candle>; sma: ReadonlyArray<number | null> }, h4: { c: ReadonlyArray<Candle>; r: ReadonlyArray<number | null> }): boolean {
  if (dir === 'none') return true;
  if (dir === 'sma200') {
    const i = lastClosed(d1.c, 24 * H, t), s = i >= 0 ? d1.sma[i] : null;
    return s != null && (d > 0 ? d1.c[i]!.close > s : d1.c[i]!.close < s);
  }
  const i = lastClosed(h4.c, 4 * H, t), v = i >= 0 ? h4.r[i] : null;
  return v != null && (d > 0 ? v >= 50 : v <= 50);
}

interface Prep { tf: '15m' | '1h'; c: ReadonlyArray<Candle>; r: (number | null)[]; atr: (number | null)[]; sig: Map<Level, Scalp2Signal[]>; opp: Map<string, number[]> }
const prep = (c: ReadonlyArray<Candle>, tf: '15m' | '1h'): Prep => {
  const r = rsi(c.map((x) => x.close), 14), sig = new Map<Level, Scalp2Signal[]>(), opp = new Map<string, number[]>();
  for (const lv of LEVELS) {
    const s = scalp2Signals(c, r, lv);
    sig.set(lv, s);
    for (const f of FAMS) for (const d of [1, -1] as const) opp.set(`${lv}|${f}|${d}`, s.filter((x) => x.family === f && x.d === d).map((x) => x.i));
  }
  return { tf, c, r, atr: atrWilder(c, 14), sig, opp };
};
const stopFor = (p: Prep, s: Scalp2Signal, j: number): number | null => {
  const a = p.atr[s.i];
  if (a == null) return null;
  let x = s.d > 0 ? Infinity : -Infinity;
  for (let k = Math.max(0, s.b - LEFT); k < j; k++) x = s.d > 0 ? Math.min(x, p.c[k]!.low) : Math.max(x, p.c[k]!.high);
  return x - s.d * 0.2 * a;
};

interface Row extends SignalTrade { gross: number; costR: number; d: 1 | -1; j: number; risk: number; ex: Exit; tf: '15m' | '1h'; lv: Level; fam: Family }

/** Deterministic coin flip per (seed, coin, bar). */
export const flip = (seed: number, sym: string, j: number) => {
  let h = 2166136261 ^ seed;
  for (const ch of `${sym}|${j}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) & 1) === 1;
};

export function scalp2Report(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, show: ReadonlyArray<string> = ['ETHUSDT', 'SUIUSDT']): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10), iso = (t: number) => new Date(t).toISOString().slice(0, 16);
  const rows = new Map<string, Row[]>();
  const preps = new Map<string, Record<'15m' | '1h', Prep>>();
  for (const sym of symbols) {
    const c15 = data[sym]?.candles['15m'] ?? [], c1 = data[sym]?.candles['1h'] ?? [], cd = data[sym]?.candles['1d'] ?? [], c4 = data[sym]?.candles['4h'] ?? [];
    if (c15.length < 1000 || c1.length < 500) continue;
    const m15 = prep(c15, '15m'), m1 = prep(c1, '1h');
    preps.set(sym, { '15m': m15, '1h': m1 });
    const d1 = { c: cd, sma: sma(cd.map((x) => x.close), 200) }, h4 = { c: c4, r: rsi(c4.map((x) => x.close), 14) };
    const busy = new Map<string, number>();
    const take = (combo: Combo, p: Prep, s: Scalp2Signal, lv: Level) => {
      const j = s.i + 1, t0 = p.c[s.i]!.openTime + BAR[p.tf];
      if (t0 < from || j >= p.c.length) return;
      const stop = stopFor(p, s, j);
      if (stop == null) return;
      for (const dir of DIRS) {
        if (!dirOk(dir, s.d, t0, d1, h4)) continue;
        for (const sel of s.first ? ['first', 'all'] : ['all']) for (const ex of EXITS) {
          const key = `${combo}|${s.d > 0 ? 'long' : 'short'}|${s.family}|${sel}|${dir}|${lv}|${ex}`;
          if (p.c[j]!.openTime <= (busy.get(key) ?? -Infinity)) continue;
          const tr = scalp2Trade(p.c, p.r, p.atr, j, stop, s.d, CAP[p.tf], ex, p.opp.get(`${lv}|${s.family}|${-s.d}`));
          if (!tr || p.c[tr.end]!.openTime + BAR[p.tf] > to) continue;
          const a = rows.get(key) ?? [];
          a.push({ sym, t: p.c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, d: s.d, j, risk: s.d * (p.c[j]!.open - stop), ex, tf: p.tf, lv, fam: s.family });
          rows.set(key, a);
          busy.set(key, p.c[tr.end]!.openTime + BAR[p.tf]);
        }
      }
    };
    for (const lv of LEVELS) {
      const s1 = m1.sig.get(lv)!, s15 = m15.sig.get(lv)!;
      const known1 = s1.map((s) => ({ s, t: m1.c[s.i]!.openTime + H }));
      for (const s of s1) take('1h', m1, s, lv);
      for (const s of s15) {
        take('15m', m15, s, lv);
        const t0 = m15.c[s.i]!.openTime + BAR['15m'];
        if (known1.some((x) => x.s.d === s.d && x.s.family === s.family && x.t <= t0 && t0 - x.t <= 24 * H)) take('15m + 1h', m15, s, lv);
      }
    }
  }
  // Random-direction baseline: same entries, stop distances and exit rule, side by coin flip; avg R over 20 seeds.
  const randomAvg = (ts: Row[]): number => {
    let sum = 0, n = 0;
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const p = preps.get(t.sym)![t.tf], d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
      const tr = scalp2Trade(p.c, p.r, p.atr, t.j, p.c[t.j]!.open - d * t.risk, d, CAP[t.tf], t.ex, p.opp.get(`${t.lv}|${t.fam}|${-d}`));
      if (tr) { sum += tr.gross - 0.22 * tr.costR; n++; }
    }
    return n ? sum / n : NaN;
  };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const scored = [...rows.entries()].map(([k, ts]) => ({ k, ts, avg: avg(ts.map((t) => t.r)), old: avg(ts.filter((t) => t.t < cut).map((t) => t.r)), neu: avg(ts.filter((t) => t.t >= cut).map((t) => t.r)) }));
  const pre = scored.filter((x) => x.ts.length >= 100 && x.old > 0 && x.neu > 0).sort((a, b) => b.avg - a.avg);
  const kept = pre.map((x) => ({ ...x, rnd: randomAvg(x.ts) })).filter((x) => x.avg - x.rnd >= 0.1);
  const HEAD = '  combo | side | family | first/all | direction | anchor level | exit                         n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [
    `SELECTIVE 1h / 15m RSI SCALP (owner's ETH charts): ${day(from)} to ${day(to)}, ${symbols.length} coins, ${rows.size} lines. Older / newer = before / after ${day(cut)}.`,
    'Anchor = RSI pivot low <= level and the lowest of 100 bars (shorts mirrored); entry at a later higher RSI low <= 45 (>= 55), 10-500 bars on.',
    'Kept: n >= 100, avg R > 0 in both periods at 0.22% cost, and >= 0.1 R better than the same trades with a random side (20 seeds).',
    `${pre.length} lines positive in both periods with n >= 100; ${kept.length} also beat random.`, '', 'KEPT (best 15 by avg R), cost 0.22%:', HEAD,
  ];
  for (const x of kept.slice(0, 15)) out.push(`${statsLine(x.k.padEnd(84).slice(0, 84), x.ts, cut)}   random ${x.rnd.toFixed(2)}`);
  out.push('', 'BEST LINE PER COMBO AND SIDE (n >= 50), cost 0.22% and 0.10%, with the random baseline:', HEAD);
  const withCost = (ts: Row[], cost: number): SignalTrade[] => ts.map((t) => ({ ...t, r: t.gross - cost * t.costR }));
  for (const combo of COMBOS) for (const side of ['long', 'short']) {
    const best = scored.filter((x) => x.k.startsWith(`${combo}|${side}|`) && x.ts.length >= 50).sort((a, b) => b.avg - a.avg)[0];
    if (!best) { out.push(`  ${combo} ${side}: no line with 50 trades`); continue; }
    out.push(`${statsLine(best.k.padEnd(84).slice(0, 84), best.ts, cut)}   random ${randomAvg(best.ts).toFixed(2)}`);
    out.push(`${statsLine(`   same at 0.10% cost`.padEnd(84), withCost(best.ts, 0.10), cut)}`);
  }
  // Signal counts and the owner's chart check: every 'first' signal of the most-traded anchor rules on the shown coins.
  out.push('', 'SIGNAL COUNT PER COIN PER MONTH (first per anchor, no direction filter, level 30, hl):');
  for (const tf of ['1h', '15m'] as const) {
    const n = [...preps.values()].reduce((a, p) => a + p[tf].sig.get(30)!.filter((s) => s.first && s.family === 'hl' && p[tf].c[s.i]!.openTime >= from).length, 0);
    const months = (to - from) / (30 * 24 * H);
    out.push(`  ${tf}: ${(n / Math.max(1, preps.size) / months).toFixed(1)} signals per coin per month`);
  }
  out.push('', `SIGNALS SINCE 2026-08-01 (first per anchor, level 30, both families) for ${show.join(', ')}, times UTC; entry = next bar open:`);
  for (const sym of show) {
    const p = preps.get(sym);
    if (!p) { out.push(`  ${sym}: no data`); continue; }
    for (const tf of ['1h', '15m'] as const) for (const s of p[tf].sig.get(30)!) {
      const t = p[tf].c[s.i]!.openTime;
      if (!s.first || t < Date.UTC(2026, 7, 1)) continue;
      out.push(`  ${sym} ${tf.padEnd(3)} ${s.d > 0 ? 'long ' : 'short'} ${s.family === 'div' ? 'divergence ' : 'RSI trend  '} A ${iso(p[tf].c[s.a]!.openTime)} RSI ${p[tf].r[s.a]!.toFixed(1)}  B ${iso(p[tf].c[s.b]!.openTime)} RSI ${p[tf].r[s.b]!.toFixed(1)}  enter ${iso(t + BAR[tf])}`);
    }
  }
  return out;
}
