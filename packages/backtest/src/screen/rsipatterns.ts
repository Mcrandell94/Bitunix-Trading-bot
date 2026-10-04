// RSI pattern catalogue (owner 2026-10-04, write-up on how they read RSI: regime first, then the pattern; daily bias,
// 4H setup, 1H trigger; a divergence is a warning until RSI or structure confirms). Research only. Rules fixed before
// the runs (RSI 14, Wilder; pivots 5 bars left / 2 right; shorts are the exact mirror: RSI -> 100 - RSI, price flipped):
//
// Patterns (each gives a signal bar i, entry at the next open, stop past the pattern's swing -/+ 0.2 ATR(14)):
//  - 'oversold reclaim': RSI closes back above 30 after closes under it; stop under the low since RSI went under 30.
//  - 'failure swing': RSI under 30, rallies to an interim high, pulls back (>= 3 points) holding above 30, then closes
//    above the interim high (Wilder); 'double bottom': the same but the second trough dips to or under 30 while staying
//    at or above the first. Stop under the low of the pullback. A lower RSI low resets it; 60 bars max.
//  - 'regular div': RSI pivot low A <= 30, later pivot low B (5..60 bars on) with higher RSI and a lower price low;
//    confirmed when RSI closes back above 50 within 30 bars of B (cancelled if price trades under B's low first).
//  - 'hidden div': pivot lows A, B (5..60 bars apart): higher price low, lower RSI low, RSI at B between 30 and 50;
//    signal when B is confirmed. Stop under B's low.
//  - 'midline reclaim': after RSI >= 60 within the 30 bars before a pullback, RSI closes under 50 for >= 2 bars, then
//    closes back above 50 and the next bar holds above 50. Stop under the pullback's low.
// Regime (daily RSI, last closed day): 'with trend' = daily RSI >= 50 for longs (< 50 shorts); 'range shift' = last 20
// daily RSI held >= 40 and reached >= 60 (shorts: held <= 60 and reached <= 40); 'range' = neither shift either way.
// Exits: 2R, 3R, 3 ATR trail from +1R. Caps: 1H 120 bars, 4H 90, daily 60. Costs 0.22%; random-side baseline.
// Stacks (1H trigger, as the write-up's table): 'best long' = daily RSI 50-70 and the 4H RSI low of the last 12 bars
// in 35-50; 'exhaustion long' = daily RSI under 30 in the last 5 days and the 4H RSI crossed back above 30 in the last
// 6 bars; trigger = a 1H oversold reclaim, failure swing / double bottom, or midline reclaim. Shorts mirrored
// (daily 30-50 with the 4H high in 50-65; daily over 70 in the last 5 days with the 4H back under 70).

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import { statsLine, type SignalTrade } from './rsitrades';
import { flip, lastClosed, scalp2Trade, type Exit } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Tf = '1h' | '4h' | '1d';
export type Pat = 'oversold reclaim' | 'failure swing' | 'double bottom' | 'regular div' | 'hidden div' | 'midline reclaim';
export interface PatEvent { i: number; d: 1 | -1; pat: Pat; stop: number }

const H = 3_600_000, DAY = 24 * H;
const BAR: Record<Tf, number> = { '1h': H, '4h': 4 * H, '1d': DAY };
const CAP: Record<Tf, number> = { '1h': 120, '4h': 90, '1d': 60 };
const PATS: Pat[] = ['oversold reclaim', 'failure swing', 'double bottom', 'regular div', 'hidden div', 'midline reclaim'];
const EXITS: Exit[] = ['2R', '3R', 'trail'];

/** Bullish patterns on candles / RSI already mirrored for shorts. */
function bullPatterns(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>): Omit<PatEvent, 'd'>[] {
  const out: Omit<PatEvent, 'd'>[] = [];
  const lowFrom = (a: number, b: number) => { let lo = Infinity; for (let k = Math.max(0, a); k <= b; k++) lo = Math.min(lo, c[k]!.low); return lo; };
  const emit = (i: number, pat: Pat, swingLow: number) => { const a = atr[i]; if (a != null && Number.isFinite(swingLow)) out.push({ i, pat, stop: swingLow - 0.2 * a }); };
  let under: number | null = null; // oversold reclaim: index RSI went under 30
  // failure swing / double bottom state
  let t1: number | null = null, t1i = -1, peak: number | null = null, down = false, t2: number | null = null, pullStart = -1;
  // pivots
  const lows: number[] = [];
  const pending: { b: number; lowB: number; until: number }[] = [];
  // midline
  let last60 = -Infinity, below = -1;
  for (let i = 1; i < c.length; i++) {
    const v = r[i], p = r[i - 1];
    if (v == null || p == null) continue;
    // oversold reclaim
    if (v < 30 && p >= 30) under = i;
    if (p < 30 && v >= 30 && under != null) { emit(i, 'oversold reclaim', lowFrom(under, i)); under = null; }
    // failure swing / double bottom
    if (t1 != null && i - t1i > 60) { t1 = null; peak = null; down = false; t2 = null; }
    if (v < 30) {
      if (t1 == null || peak == null) { if (t1 == null || v < t1) { t1 = v; t1i = i; } }
      else if (v < t1) { t1 = v; t1i = i; peak = null; down = false; t2 = null; }
      else { if (!down) { down = true; pullStart = i; } t2 = Math.min(t2 ?? v, v); }
    } else if (t1 != null) {
      if (!down) { if (peak == null || v > peak) peak = v; else if (v <= peak - 3) { down = true; pullStart = i; t2 = v; } }
      else if (v > peak!) { emit(i, t2! > 30 ? 'failure swing' : 'double bottom', lowFrom(pullStart, i)); t1 = null; peak = null; down = false; t2 = null; }
      else t2 = Math.min(t2 ?? v, v);
    }
    // pivots (B confirmed at k + 2)
    const k = i - 2;
    if (k >= 5) {
      const rk = r[k];
      let isLow = rk != null;
      for (let q = k - 5; q <= k + 2 && isLow; q++) { if (q === k) continue; const w = r[q]; if (w == null || w < rk! || (w === rk && q < k)) isLow = false; }
      if (isLow) {
        for (const a of lows) {
          if (k - a < 5 || k - a > 60) continue;
          const ra = r[a]!, rb = rk!;
          if (ra <= 30 && rb > ra && c[k]!.low < c[a]!.low) pending.push({ b: k, lowB: c[k]!.low, until: k + 30 });
          if (c[k]!.low > c[a]!.low && rb < ra && rb >= 30 && rb <= 50) emit(i, 'hidden div', c[k]!.low);
        }
        lows.push(k);
        while (lows.length && k - lows[0]! > 60) lows.shift();
      }
    }
    for (let q = pending.length - 1; q >= 0; q--) {
      const x = pending[q]!;
      if (i <= x.b + 2) continue;
      if (c[i]!.low < x.lowB || i > x.until) { pending.splice(q, 1); continue; }
      if (p < 50 && v >= 50) { emit(i, 'regular div', x.lowB); pending.splice(q, 1); }
    }
    // midline reclaim: crossed up at i-1, held at i
    if (v >= 60) last60 = i;
    if (p >= 50 && v < 50) below = i;
    if (i >= 2) {
      const pp = r[i - 2];
      if (pp != null && pp < 50 && p >= 50 && v >= 50 && below >= 0 && i - 1 - below >= 2 && below - last60 <= 30 && last60 < below) emit(i, 'midline reclaim', lowFrom(below, i));
    }
  }
  return out;
}

const mirror = (c: ReadonlyArray<Candle>): Candle[] => c.map((b) => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close }));

/** All patterns, both sides. Short stops are mapped back to real prices. */
export function rsiPatterns(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>): PatEvent[] {
  const longs = bullPatterns(c, r, atr).map((e) => ({ ...e, d: 1 as const }));
  const shorts = bullPatterns(mirror(c), r.map((x) => (x == null ? null : 100 - x)), atr).map((e) => ({ ...e, d: -1 as const, stop: -e.stop }));
  return [...longs, ...shorts].sort((a, b) => a.i - b.i);
}

type Regime = 'none' | 'with trend' | 'range shift' | 'range';
function regimeOk(reg: Regime, d: 1 | -1, t: number, dc: ReadonlyArray<Candle>, dr: ReadonlyArray<number | null>): boolean {
  if (reg === 'none') return true;
  const k = lastClosed(dc, DAY, t);
  if (k < 20 || dr[k] == null) return false;
  if (reg === 'with trend') return d > 0 ? dr[k]! >= 50 : dr[k]! < 50;
  const w = dr.slice(k - 19, k + 1).filter((x): x is number => x != null);
  const bull = Math.min(...w) >= 40 && Math.max(...w) >= 60, bear = Math.max(...w) <= 60 && Math.min(...w) <= 40;
  if (reg === 'range shift') return d > 0 ? bull : bear;
  return !bull && !bear;
}

interface Row extends SignalTrade { gross: number; costR: number; d: 1 | -1; j: number; risk: number; ex: Exit; tf: Tf }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function rsiPatternsReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const tfs = (['1h', '4h', '1d'] as Tf[]).filter((tf) => symbols.some((s) => (data[s]?.candles[tf]?.length ?? 0) > 300) && (process.argv.includes('--rp-htf') ? tf !== '1h' : tf === '1h'));
  const rows = new Map<string, Row[]>(), stacks = new Map<string, Row[]>(), wide = new Map<string, Row[]>();
  const cache = new Map<string, { c: ReadonlyArray<Candle>; atr: (number | null)[] }>();
  const push = (m: Map<string, Row[]>, k: string, x: Row) => { const a = m.get(k) ?? []; a.push(x); m.set(k, a); };
  for (const sym of symbols) {
    const dc = data[sym]?.candles['1d'] ?? [], dr = rsi(dc.map((x) => x.close), 14);
    const hc = data[sym]?.candles['4h'] ?? [], hr = rsi(hc.map((x) => x.close), 14);
    for (const tf of tfs) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 300) continue;
      const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14);
      cache.set(`${sym}|${tf}`, { c, atr });
      const busy = new Map<string, number>();
      const trade = (m: Map<string, Row[]>, key: string, e: PatEvent, mult = 1) => {
        const j = e.i + 1;
        if (j >= c.length || c[j]!.openTime <= (busy.get(key) ?? -Infinity)) return;
        const ex = key.slice(key.lastIndexOf('|') + 1) as Exit;
        const stop = c[j]!.open - mult * (c[j]!.open - e.stop); // wider stop, smaller size: the loss at the stop stays 1R
        const tr = scalp2Trade(c, r, atr, j, stop, e.d, CAP[tf], ex);
        if (!tr || c[tr.end]!.openTime + BAR[tf] > to) return;
        push(m, key, { sym, t: c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, d: e.d, j, risk: e.d * (c[j]!.open - stop), ex, tf });
        busy.set(key, c[tr.end]!.openTime + BAR[tf]);
      };
      for (const e of rsiPatterns(c, r, atr)) {
        const t0 = c[e.i]!.openTime + BAR[tf];
        if (t0 < from) continue;
        const side = e.d > 0 ? 'long' : 'short';
        for (const reg of ['none', 'with trend', 'range shift', 'range'] as Regime[]) {
          if (!regimeOk(reg, e.d, t0, dc, dr)) continue;
          for (const ex of EXITS) trade(rows, `${tf}|${side}|${e.pat}|${reg}|${ex}`, e);
          // Owner 2026-10-04: "stops wider on 15m-1h but position size or leverage smaller": stop width x 1.5 / 2 / 3.
          if (process.argv.includes('--rp-stops') && e.pat === 'regular div' && reg !== 'range') for (const mult of [1.5, 2, 3]) for (const ex of EXITS) trade(wide, `${tf}|${side}|${e.pat}|${reg}|stop x${mult}|${ex}`, e, mult);
        }
        // Stacks: 1H triggers inside the daily / 4H conditions.
        if (tf !== '1h' || e.pat === 'regular div' || e.pat === 'hidden div') continue;
        const kd = lastClosed(dc, DAY, t0), k4 = lastClosed(hc, 4 * H, t0);
        if (kd < 5 || k4 < 12 || dr[kd] == null) continue;
        const rd = e.d > 0 ? dr[kd]! : 100 - dr[kd]!;
        const r4 = hr.slice(k4 - 11, k4 + 1).map((x) => (x == null ? null : e.d > 0 ? x : 100 - x)).filter((x): x is number => x != null);
        const dLast5 = dr.slice(kd - 4, kd + 1).map((x) => (x == null ? 50 : e.d > 0 ? x : 100 - x));
        const r4s = hr.slice(k4 - 6, k4 + 1).map((x) => (x == null ? 50 : e.d > 0 ? x : 100 - x));
        const best = rd >= 50 && rd <= 70 && r4.length === 12 && Math.min(...r4) >= 35 && Math.min(...r4) <= 50;
        let reclaim4 = false;
        for (let q = 1; q < r4s.length; q++) if (r4s[q - 1]! < 30 && r4s[q]! >= 30) reclaim4 = true;
        const exhaust = Math.min(...dLast5) < 30 && reclaim4;
        const trig = e.pat === 'double bottom' ? 'failure swing' : e.pat;
        for (const [stack, ok] of [['best', best], ['exhaustion', exhaust]] as const) {
          if (!ok) continue;
          for (const tg of [trig, 'any trigger']) for (const ex of EXITS) trade(stacks, `${stack} ${side}|${tg}|${ex}`, e);
        }
      }
    }
  }
  const randomAvg = (ts: Row[]): number => {
    let sum = 0, n = 0;
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const p = cache.get(`${t.sym}|${t.tf}`)!, d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
      const tr = scalp2Trade(p.c, [], p.atr, t.j, p.c[t.j]!.open - d * t.risk, d, CAP[t.tf], t.ex);
      if (tr) { sum += tr.gross - 0.22 * tr.costR; n++; }
    }
    return n ? sum / n : NaN;
  };
  const HEAD = '  timeframe | side | pattern | regime | exit                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`RSI PATTERN CATALOGUE (owner's write-up): ${day(from)} to ${day(to)}, ${symbols.length} coins, timeframes ${tfs.join(', ')}. Older / newer = before / after ${day(cut)}. Costs 0.22%.`];
  const scored = [...rows.entries()].map(([k, ts]) => ({ k, ts, avg: avg(ts.map((t) => t.r)), old: avg(ts.filter((t) => t.t < cut).map((t) => t.r)), neu: avg(ts.filter((t) => t.t >= cut).map((t) => t.r)) }));
  const pre = scored.filter((x) => x.ts.length >= 60 && x.old > 0 && x.neu > 0).sort((a, b) => b.avg - a.avg);
  const kept = pre.map((x) => ({ ...x, rnd: randomAvg(x.ts) })).filter((x) => x.avg - x.rnd >= 0.1);
  out.push('', `${rows.size} lines; ${pre.length} positive in both periods with n >= 60; ${kept.length} also beat a random side by >= 0.1 R.`, 'KEPT (best 20):', HEAD);
  for (const x of kept.slice(0, 20)) out.push(`${statsLine(x.k.padEnd(84).slice(0, 84), x.ts, cut)}   random ${x.rnd.toFixed(2)}`);
  out.push('', 'BEST LINE PER TIMEFRAME, SIDE AND PATTERN (n >= 30), with the random baseline:', HEAD);
  for (const tf of tfs) for (const side of ['long', 'short']) for (const pat of PATS) {
    const b = scored.filter((x) => x.k.startsWith(`${tf}|${side}|${pat}|`) && x.ts.length >= 30).sort((a, z) => z.avg - a.avg)[0];
    if (b) out.push(`${statsLine(b.k.padEnd(84).slice(0, 84), b.ts, cut)}   random ${randomAvg(b.ts).toFixed(2)}`);
  }
  out.push('', 'REGIME EFFECT (3R exit, all patterns pooled per timeframe and side):', HEAD);
  for (const tf of tfs) for (const side of ['long', 'short']) for (const reg of ['none', 'with trend', 'range shift', 'range']) {
    const ts = PATS.flatMap((pat) => rows.get(`${tf}|${side}|${pat}|${reg}|3R`) ?? []);
    out.push(statsLine(`${tf}|${side}|all patterns|${reg}|3R`.padEnd(84), ts, cut));
  }
  if (wide.size) {
    out.push('', 'REGULAR DIVERGENCE WITH WIDER STOPS (size scaled so the stop loss stays 1R), next to stop x1:', HEAD);
    for (const k of [...rows.keys()].filter((x) => x.includes('|regular div|') && !x.includes('|range|')).sort()) {
      const base = rows.get(k)!, at = k.lastIndexOf('|');
      out.push(`${statsLine(`${k.slice(0, at)}|stop x1${k.slice(at)}`.padEnd(84).slice(0, 84), base, cut)}   random ${randomAvg(base).toFixed(2)}`);
      for (const m of [1.5, 2, 3]) { const key = `${k.slice(0, at)}|stop x${m}${k.slice(at)}`, ts = wide.get(key) ?? []; out.push(`${statsLine(key.padEnd(84).slice(0, 84), ts, cut)}   random ${ts.length >= 20 ? randomAvg(ts).toFixed(2) : '-'}`); }
    }
  }
  if (stacks.size) {
    out.push('', 'MULTI-TIMEFRAME STACKS (daily bias, 4H setup, 1H trigger), with the random baseline:', HEAD);
    for (const k of [...stacks.keys()].sort()) { const ts = stacks.get(k)!; out.push(`${statsLine(k.padEnd(84).slice(0, 84), ts, cut)}   random ${ts.length >= 20 ? randomAvg(ts).toFixed(2) : '-'}`); }
  }
  return out;
}
