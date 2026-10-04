// WaveTrend [LazyBear] (owner 2026-10-04: "test it by itself and across models and time frames"). Research only.
// wt1 = EMA21 of ci, ci = (hlc3 - EMA10(hlc3)) / (0.015 * EMA10(|hlc3 - EMA10(hlc3)|)); wt2 = SMA4(wt1). Standard
// levels: over sold -53 / -60, over bought +53 / +60. Rules fixed before the runs:
//
// A. By itself, on each timeframe given: long = wt1 crosses above wt2 at a level <= -L (L = 0, 53, 60; shorts mirror),
//    known at the bar's close, enter at the next open. Stop past the 5-bar extreme +/- 0.2 ATR(14). Exits 2R, 3R, the
//    next opposite cross (any level), 3 ATR trail from +1R; caps 15m 192 bars, 1h 120, 4H 90, daily 60. Direction:
//    none, or the daily close vs its 200-day SMA. Costs 0.22% (and 0.10%); random-side baseline (20 seeds).
// B. With the 1h / 15m RSI scalp signals (scalp2.ts, first per anchor, level 30): taken only if WaveTrend crossed the
//    trade's way (at or beyond zero) in the last 6 bars, or only if wt1 was past -53 / +53 at the RSI pivot B.
// C. With the 6 live models (rsisignals.ts, version A exits): base trades split by WaveTrend at entry on the entry
//    timeframe and on the other one (daily <-> 4H): wt1 above / below wt2, a cross the trade's way in the last 10 bars,
//    and an over sold / bought reading in the last 10 bars; and WaveTrend as the entry trigger (wait up to 10 bars
//    for a cross the trade's way, cancelled if the model's stop trades first).

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi, sma } from '../indicators';
import { frameworkSetups, LIVE_EXITS, RSI_MODELS, type RsiModelId } from './rsisignals';
import { specTrade } from './exits';
import { statsLine, type SignalTrade } from './rsitrades';
import { dirOk, flip, lastClosed, scalp2Signals, scalp2Trade, type Exit } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Tf = '15m' | '1h' | '4h' | '1d';
const H = 3_600_000, DAY = 24 * H;
const BAR: Record<Tf, number> = { '15m': H / 4, '1h': H, '4h': 4 * H, '1d': DAY };
const CAP: Record<Tf, number> = { '15m': 192, '1h': 120, '4h': 90, '1d': 60 };

/** EMA that starts at the first non-null value (TradingView-style recursion). */
function emaN(xs: ReadonlyArray<number | null>, n: number): (number | null)[] {
  const k = 2 / (n + 1), out: (number | null)[] = [];
  let e: number | null = null, seen = 0;
  for (const x of xs) {
    if (x == null) { out.push(null); continue; }
    e = e == null ? x : x * k + e * (1 - k);
    seen++;
    out.push(seen >= n ? e : null);
  }
  return out;
}

export function waveTrend(c: ReadonlyArray<Candle>, n1 = 10, n2 = 21): { wt1: (number | null)[]; wt2: (number | null)[] } {
  const ap = c.map((b) => (b.high + b.low + b.close) / 3);
  const esa = emaN(ap, n1);
  const dev = emaN(ap.map((x, i) => (esa[i] == null ? null : Math.abs(x - esa[i]!))), n1);
  const ci = ap.map((x, i) => (esa[i] == null || dev[i] == null || dev[i] === 0 ? null : (x - esa[i]!) / (0.015 * dev[i]!)));
  const wt1 = emaN(ci, n2), wt2 = sma(wt1, 4);
  return { wt1, wt2 };
}

export interface WtCross { i: number; d: 1 | -1; level: number }
/** Crosses of wt1 over / under wt2, with the wt2 level at the cross. */
export function wtCrosses(wt1: ReadonlyArray<number | null>, wt2: ReadonlyArray<number | null>): WtCross[] {
  const out: WtCross[] = [];
  for (let i = 1; i < wt1.length; i++) {
    const a0 = wt1[i - 1], b0 = wt2[i - 1], a = wt1[i], b = wt2[i];
    if (a0 == null || b0 == null || a == null || b == null) continue;
    if (a0 <= b0 && a > b) out.push({ i, d: 1, level: b });
    else if (a0 >= b0 && a < b) out.push({ i, d: -1, level: b });
  }
  return out;
}
const atLevel = (x: WtCross, L: number) => (x.d > 0 ? x.level <= -L : x.level >= L);

interface Row extends SignalTrade { gross: number; costR: number; d: 1 | -1; j: number; risk: number; ex: Exit; tf: Tf; opp: ReadonlyArray<number>; oppR: ReadonlyArray<number> }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function waveTrendReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const tfs = (['15m', '1h', '4h', '1d'] as Tf[]).filter((tf) => symbols.some((s) => (data[s]?.candles[tf]?.length ?? 0) > 300));
  const standalone = process.argv.includes('--wt-htf') ? tfs.filter((t) => t === '4h' || t === '1d') : tfs.filter((t) => t !== '4h' && !(t === '1d' && tfs.includes('15m')));
  const rows = new Map<string, Row[]>(), sc = new Map<string, Row[]>();
  const cache = new Map<string, { c: ReadonlyArray<Candle>; atr: (number | null)[] }>();
  const push = (m: Map<string, Row[]>, k: string, r: Row) => { const a = m.get(k) ?? []; a.push(r); m.set(k, a); };
  for (const sym of symbols) {
    const cd = data[sym]?.candles['1d'] ?? [];
    const d1 = { c: cd, sma: sma(cd.map((x) => x.close), 200) }, noH4 = { c: [] as Candle[], r: [] as (number | null)[] };
    for (const tf of standalone) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 300) continue;
      const atr = atrWilder(c, 14), { wt1, wt2 } = waveTrend(c), xs = wtCrosses(wt1, wt2);
      cache.set(`${sym}|${tf}`, { c, atr });
      const oppOf = { 1: xs.filter((x) => x.d === -1).map((x) => x.i), [-1]: xs.filter((x) => x.d === 1).map((x) => x.i) } as Record<number, number[]>;
      const busy = new Map<string, number>();
      for (const x of xs) {
        const j = x.i + 1, t0 = c[x.i]!.openTime + BAR[tf];
        if (t0 < from || j >= c.length || atr[x.i] == null) continue;
        let ext = x.d > 0 ? Infinity : -Infinity;
        for (let k = Math.max(0, x.i - 4); k <= x.i; k++) ext = x.d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
        const stop = ext - x.d * 0.2 * atr[x.i]!;
        for (const L of [0, 53, 60]) {
          if (!atLevel(x, L)) continue;
          for (const dir of ['none', 'sma200'] as const) {
            if (!dirOk(dir, x.d, t0, d1, noH4)) continue;
            for (const ex of ['2R', '3R', 'opposite', 'trail'] as Exit[]) {
              const k = `${tf}|${x.d > 0 ? 'long' : 'short'}|level ${L}|${dir}|${ex}`;
              if (c[j]!.openTime <= (busy.get(k) ?? -Infinity)) continue;
              const tr = scalp2Trade(c, [], atr, j, stop, x.d, CAP[tf], ex, oppOf[x.d]!);
              if (!tr || c[tr.end]!.openTime + BAR[tf] > to) continue;
              push(rows, k, { sym, t: c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, d: x.d, j, risk: x.d * (c[j]!.open - stop), ex, tf, opp: oppOf[x.d]!, oppR: oppOf[-x.d]! });
              busy.set(k, c[tr.end]!.openTime + BAR[tf]);
            }
          }
        }
      }
    }
    // B. RSI scalp signals filtered by WaveTrend (1h / 15m only).
    for (const tf of (['1h', '15m'] as Tf[]).filter((t) => tfs.includes(t) && !process.argv.includes('--wt-htf'))) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 1000) continue;
      const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14), { wt1, wt2 } = waveTrend(c), xs = wtCrosses(wt1, wt2);
      cache.set(`${sym}|${tf}`, { c, atr });
      const crossAt = new Map<number, 1 | -1>(xs.map((x) => [x.i, x.d] as [number, 1 | -1]));
      const busy = new Map<string, number>();
      for (const s of scalp2Signals(c, r, 30)) {
        if (!s.first) continue;
        const j = s.i + 1, t0 = c[s.i]!.openTime + BAR[tf], a = atr[s.i];
        if (t0 < from || j >= c.length || a == null) continue;
        let ext = s.d > 0 ? Infinity : -Infinity;
        for (let k = Math.max(0, s.b - 5); k < j; k++) ext = s.d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
        const stop = ext - s.d * 0.2 * a;
        let crossed = false;
        for (let k = s.i - 5; k <= s.i; k++) { const dd = crossAt.get(k), w = wt2[k]; if (dd === s.d && w != null && s.d * w <= 0) crossed = true; }
        const w1 = wt1[s.b], extreme = w1 != null && (s.d > 0 ? w1 <= -53 : w1 >= 53);
        for (const filt of ['all', 'wt cross in 6 bars', 'wt past 53 at B'] as const) {
          if ((filt === 'wt cross in 6 bars' && !crossed) || (filt === 'wt past 53 at B' && !extreme)) continue;
          for (const ex of ['2R', '3R', 'trail'] as Exit[]) {
            const k = `${tf}|${s.d > 0 ? 'long' : 'short'}|${s.family}|${filt}|${ex}`;
            if (c[j]!.openTime <= (busy.get(k) ?? -Infinity)) continue;
            const tr = scalp2Trade(c, r, atr, j, stop, s.d, tf === '15m' ? 192 : 120, ex);
            if (!tr || c[tr.end]!.openTime + BAR[tf] > to) continue;
            push(sc, k, { sym, t: c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, d: s.d, j, risk: s.d * (c[j]!.open - stop), ex, tf, opp: [], oppR: [] });
            busy.set(k, c[tr.end]!.openTime + BAR[tf]);
          }
        }
      }
    }
  }
  const randomAvg = (ts: Row[]): number => {
    let sum = 0, n = 0;
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const p = cache.get(`${t.sym}|${t.tf}`)!, d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
      const tr = scalp2Trade(p.c, [], p.atr, t.j, p.c[t.j]!.open - d * t.risk, d, CAP[t.tf], t.ex, d === t.d ? t.opp : t.oppR);
      if (tr) { sum += tr.gross - 0.22 * tr.costR; n++; }
    }
    return n ? sum / n : NaN;
  };
  const withCost = (ts: Row[], cost: number): SignalTrade[] => ts.map((t) => ({ ...t, r: t.gross - cost * t.costR }));
  const HEAD = '  line                                                                                 n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`WAVETREND [LazyBear] 10 / 21: ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}. Costs 0.22% unless noted.`];
  if (rows.size) {
    const scored = [...rows.entries()].map(([k, ts]) => ({ k, ts, avg: avg(ts.map((t) => t.r)), old: avg(ts.filter((t) => t.t < cut).map((t) => t.r)), neu: avg(ts.filter((t) => t.t >= cut).map((t) => t.r)) }));
    const pre = scored.filter((x) => x.ts.length >= 60 && x.old > 0 && x.neu > 0).sort((a, b) => b.avg - a.avg);
    const kept = pre.map((x) => ({ ...x, rnd: randomAvg(x.ts) })).filter((x) => x.avg - x.rnd >= 0.1);
    out.push('', `A. WAVETREND CROSSES BY THEMSELVES (${standalone.join(', ')}): ${rows.size} lines; ${pre.length} positive in both periods (n >= 60); ${kept.length} also beat a random side by >= 0.1 R.`, 'Kept (best 15):', HEAD);
    for (const x of kept.slice(0, 15)) out.push(`${statsLine(x.k.padEnd(84).slice(0, 84), x.ts, cut)}   random ${x.rnd.toFixed(2)}`);
    out.push('', 'Best line per timeframe and side (n >= 30), with 0.10% cost and the random baseline:', HEAD);
    for (const tf of standalone) for (const side of ['long', 'short']) {
      const b = scored.filter((x) => x.k.startsWith(`${tf}|${side}|`) && x.ts.length >= 30).sort((a, z) => z.avg - a.avg)[0];
      if (!b) { out.push(`  ${tf} ${side}: no line with 30 trades`); continue; }
      out.push(`${statsLine(b.k.padEnd(84).slice(0, 84), b.ts, cut)}   random ${randomAvg(b.ts).toFixed(2)}`);
      out.push(statsLine('   same at 0.10% cost'.padEnd(84), withCost(b.ts, 0.10), cut));
    }
    out.push('', 'Every level / exit with no direction filter (to see the shape):', HEAD);
    for (const x of scored.filter((z) => z.k.includes('|none|')).sort((a, b) => a.k.localeCompare(b.k))) out.push(statsLine(x.k.padEnd(84).slice(0, 84), x.ts, cut));
  }
  if (sc.size) {
    out.push('', 'B. 1h / 15m RSI SCALP SIGNALS (first per anchor, level 30) FILTERED BY WAVETREND:', HEAD);
    for (const k of [...sc.keys()].sort()) out.push(statsLine(k.padEnd(84).slice(0, 84), sc.get(k)!, cut));
  }
  return out;
}

// C. Across the 6 live models.
export function waveTrendModelsReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped);
  type T = SignalTrade & { tags: Set<string> };
  const base = new Map<RsiModelId, T[]>(), trig = new Map<RsiModelId, SignalTrade[]>();
  const FILTERS = ['state same tf', 'cross in 10 same tf', 'extreme in 10 same tf', 'state other tf', 'cross in 10 other tf', 'extreme in 10 other tf'];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const wD = waveTrend(d1), w4 = waveTrend(h4);
    const xD = new Map(wtCrosses(wD.wt1, wD.wt2).map((x) => [x.i, x] as [number, WtCross])), x4 = new Map(wtCrosses(w4.wt1, w4.wt2).map((x) => [x.i, x] as [number, WtCross]));
    const tags = (d: 1 | -1, w: { wt1: (number | null)[]; wt2: (number | null)[] }, xm: Map<number, WtCross>, k: number, suffix: string): string[] => {
      if (k < 10) return [];
      const out: string[] = [];
      const a = w.wt1[k], b = w.wt2[k];
      if (a != null && b != null && d * (a - b) > 0) out.push(`state ${suffix}`);
      let cr = false, ex = false;
      for (let q = k - 9; q <= k; q++) {
        if (xm.get(q)?.d === d) cr = true;
        const v = w.wt1[q];
        if (v != null && (d > 0 ? v <= -53 : v >= 53)) ex = true;
      }
      if (cr) out.push(`cross in 10 ${suffix}`);
      if (ex) out.push(`extreme in 10 ${suffix}`);
      return out;
    };
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (!models.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length || s.c[s.j]!.openTime < from) continue;
      const lx = LIVE_EXITS[s.model][0], daily = s.bar === DAY;
      const same = daily ? { w: wD, x: xD } : { w: w4, x: x4 }, other = daily ? { w: w4, x: x4, c: h4, bar: 4 * H } : { w: wD, x: xD, c: d1, bar: DAY };
      // Base trade (as live) with its WaveTrend tags at entry.
      if (s.known > (busy.get(`${s.model}|base`) ?? -Infinity)) {
        const entry = s.c[s.j]!.open, t = specTrade(s.c, s.atr, {}, s.j, entry - lx.stopMult * (entry - s.stop), s.d, lx.spec);
        if (t) {
          const tEntry = s.c[s.j]!.openTime, ko = lastClosed(other.c, other.bar, tEntry);
          const tg = new Set([...tags(s.d, same.w, same.x, s.j - 1, 'same tf'), ...(ko >= 0 ? tags(s.d, other.w, other.x, ko, 'other tf') : [])]);
          base.set(s.model, [...(base.get(s.model) ?? []), { sym, t: tEntry, r: t.r, stopPct: t.stopPct, bars: t.bars, tags: tg }]);
          busy.set(`${s.model}|base`, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
        }
      }
      // WaveTrend as the trigger: first cross the trade's way within 10 bars of the signal; cancelled if the stop trades.
      if (s.known > (busy.get(`${s.model}|trig`) ?? -Infinity)) {
        let k = -1;
        for (let q = s.j - 1; q < Math.min(s.c.length - 1, s.j + 9); q++) {
          if (q >= s.j && (s.d > 0 ? s.c[q]!.low <= s.stop : s.c[q]!.high >= s.stop)) break;
          if (same.x.get(q)?.d === s.d) { k = q; break; }
        }
        if (k >= 0) {
          const j = k + 1, entry = s.c[j]!.open, stop = entry - lx.stopMult * (entry - s.stop);
          if (s.d * (entry - stop) > 0) {
            const t = specTrade(s.c, s.atr, {}, j, stop, s.d, lx.spec);
            if (t) {
              trig.set(s.model, [...(trig.get(s.model) ?? []), { sym, t: s.c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars }]);
              busy.set(`${s.model}|trig`, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
            }
          }
        }
      }
    }
  }
  const HEAD = '  model / WaveTrend at entry                                                         n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`WAVETREND ACROSS THE 6 LIVE MODELS (version A exits): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'same tf = the model\'s entry timeframe (daily, or 4H for under-floor); other tf = 4H for daily models, daily for under-floor.',
    'state = wt1 above wt2 for longs (below for shorts); cross in 10 = a cross the trade\'s way in the last 10 bars; extreme in 10 = wt1 <= -53 (>= +53) in the last 10 bars.',
    'trigger = wait up to 10 bars for a WaveTrend cross the trade\'s way, enter next open (cancelled if the stop trades first).', HEAD];
  const all: T[] = [], allTrig: SignalTrade[] = [];
  const block = (name: string, ts: T[], tr: SignalTrade[]) => {
    out.push('', name);
    out.push(statsLine('base (as live)'.padEnd(84), ts, cut));
    for (const f of FILTERS) {
      out.push(statsLine(`  with: ${f}`.padEnd(84), ts.filter((t) => t.tags.has(f)), cut));
      out.push(statsLine(`  without: ${f}`.padEnd(84), ts.filter((t) => !t.tags.has(f)), cut));
    }
    out.push(statsLine('WaveTrend trigger entry'.padEnd(84), tr, cut));
  };
  for (const m of models) { const ts = base.get(m) ?? [], tr = trig.get(m) ?? []; all.push(...ts); allTrig.push(...tr); block(RSI_MODELS[m].label, ts, tr); }
  block('ALL 6 MODELS', all, allTrig);
  return out;
}
