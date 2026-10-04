// RSI Pro+ Suite (RWCS_LTD, owner 2026-10-04: "i like this indicator for rsi also"). Research only. The indicator's own
// defaults: RSI 14, signal line SMA 14 of RSI, OB / OS 70 / 30, slope over 5 bars (flat under 2 points), regime over 50
// bars (bull = RSI never under 40 and above 60 at some point; bear = never over 60 and under 40 at some point),
// divergence pivots 5 left / 5 right, 5..60 bars from the previous pivot. Shorts are the exact mirror (RSI -> 100 - RSI).
//
// A. Signals by themselves (1H on 24 months; 4H / daily on 84 months with --rp-htf), entry next open, stop past the
//    5-bar extreme (divergence: past the pivot) -/+ 0.2 ATR(14):
//    - 'flip aligned': RSI crosses over its signal line while RSI >= 50 (the indicator's green triangle);
//    - 'flip counter': the same cross while RSI < 50 (orange: "counter-trend, low conviction");
//    - 'pullback end': the cross over the signal line in a bull regime (the end of the indicator's "PULLBACK?" state);
//    - 'score 5': the bull score reaches 5 / 5 (RSI > 50, RSI > signal, signal > 50, slope > 2, bull regime);
//    - 'regime flip': the regime turns bull; 'OS exit': RSI crosses back over 30;
//    - 'regular div' / 'hidden div': the indicator's divergences (price LL + RSI HL / price HL + RSI LL).
//    Filter: none, or the daily RSI Pro+ regime on the trade's side (last closed day). Exits 2R, 3R, 3 ATR trail from
//    +1R, or the opposite signal-line cross. Caps 1H 120, 4H 90, daily 60 bars. Costs 0.22%; random-side baseline.
// B. Across the 6 live models (version A exits): base trades split by the RSI Pro+ state at entry on the entry
//    timeframe and on the daily: score >= 4 the trade's way, regime the trade's way, regime against, RSI over its
//    signal line the trade's way.

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi, sma } from '../indicators';
import { specTrade } from './exits';
import { frameworkSetups, LIVE_EXITS, RSI_MODELS, type RsiModelId } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { flip, lastClosed, scalp2Trade, type Exit } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Tf = '1h' | '4h' | '1d';
export type ProPat = 'flip aligned' | 'flip counter' | 'pullback end' | 'score 5' | 'regime flip' | 'OS exit' | 'regular div' | 'hidden div';
export interface ProEvent { i: number; d: 1 | -1; pat: ProPat; stop: number }
const PATS: ProPat[] = ['flip aligned', 'flip counter', 'pullback end', 'score 5', 'regime flip', 'OS exit', 'regular div', 'hidden div'];
const H = 3_600_000, DAY = 24 * H;
const BAR: Record<Tf, number> = { '1h': H, '4h': 4 * H, '1d': DAY };
const CAP: Record<Tf, number> = { '1h': 120, '4h': 90, '1d': 60 };

/** The indicator's state per bar (bull side; feed 100 - RSI for the bear side). */
export function proState(r: ReadonlyArray<number | null>): { sig: (number | null)[]; regime: (1 | 0 | -1 | null)[]; score: (number | null)[] } {
  const sig = sma(r, 14), regime: (1 | 0 | -1 | null)[] = [], score: (number | null)[] = [];
  for (let i = 0; i < r.length; i++) {
    let lo = Infinity, hi = -Infinity, ok = i >= 49;
    for (let k = i - 49; k <= i && ok; k++) { const v = r[k]; if (v == null) ok = false; else { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    regime.push(ok ? (lo >= 40 && hi > 60 ? 1 : hi <= 60 && lo < 40 ? -1 : 0) : null);
    const v = r[i], s = sig[i], v5 = i >= 5 ? r[i - 5] : null;
    score.push(v == null || s == null || v5 == null || regime[i] == null ? null
      : (v > 50 ? 1 : 0) + (v > s ? 1 : 0) + (s > 50 ? 1 : 0) + (v - v5 > 2 ? 1 : 0) + (regime[i] === 1 ? 1 : 0));
  }
  return { sig, regime, score };
}

function bullEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>): Omit<ProEvent, 'd'>[] {
  const { sig, regime, score } = proState(r), out: Omit<ProEvent, 'd'>[] = [];
  const low5 = (i: number) => { let lo = Infinity; for (let k = Math.max(0, i - 4); k <= i; k++) lo = Math.min(lo, c[k]!.low); return lo; };
  let prevPiv = -1;
  for (let i = 1; i < c.length; i++) {
    const v = r[i], p = r[i - 1], s = sig[i], sp = sig[i - 1], a = atr[i];
    if (v == null || p == null || a == null) continue;
    const emit = (pat: ProPat, lo: number) => out.push({ i, pat, stop: lo - 0.2 * a });
    if (s != null && sp != null && p <= sp && v > s) {
      emit(v >= 50 ? 'flip aligned' : 'flip counter', low5(i));
      if (regime[i] === 1) emit('pullback end', low5(i));
    }
    if (score[i] === 5 && score[i - 1] != null && score[i - 1]! < 5) emit('score 5', low5(i));
    if (regime[i] === 1 && regime[i - 1] != null && regime[i - 1] !== 1) emit('regime flip', low5(i));
    if (p <= 30 && v > 30) emit('OS exit', low5(i));
    // Divergence: pivot low at k = i - 5 (5 left / 5 right), compared with the previous pivot low 5..60 bars before.
    const k = i - 5, rk = k >= 5 ? r[k] : null;
    if (rk == null) continue;
    let piv = true;
    for (let q = k - 5; q <= k + 5 && piv; q++) { if (q === k) continue; const w = r[q]; if (w == null || w < rk || (w === rk && q < k)) piv = false; }
    if (!piv) continue;
    if (prevPiv >= 0 && k - prevPiv >= 5 && k - prevPiv <= 60) {
      const rp = r[prevPiv]!;
      if (c[k]!.low < c[prevPiv]!.low && rk > rp) emit('regular div', c[k]!.low);
      if (c[k]!.low > c[prevPiv]!.low && rk < rp) emit('hidden div', c[k]!.low);
    }
    prevPiv = k;
  }
  return out;
}
const mirror = (c: ReadonlyArray<Candle>): Candle[] => c.map((b) => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close }));
const inv = (r: ReadonlyArray<number | null>) => r.map((x) => (x == null ? null : 100 - x));

export function proEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>): ProEvent[] {
  return [...bullEvents(c, r, atr).map((e) => ({ ...e, d: 1 as const })), ...bullEvents(mirror(c), inv(r), atr).map((e) => ({ ...e, d: -1 as const, stop: -e.stop }))].sort((a, b) => a.i - b.i);
}

interface Row extends SignalTrade { gross: number; costR: number; d: 1 | -1; j: number; risk: number; ex: Exit; tf: Tf; opp: ReadonlyArray<number>; oppR: ReadonlyArray<number> }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function rsiProReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const tfs = (['1h', '4h', '1d'] as Tf[]).filter((tf) => symbols.some((s) => (data[s]?.candles[tf]?.length ?? 0) > 300) && (process.argv.includes('--rp-htf') ? tf !== '1h' : tf === '1h'));
  const rows = new Map<string, Row[]>(), cache = new Map<string, { c: ReadonlyArray<Candle>; atr: (number | null)[] }>();
  for (const sym of symbols) {
    const dc = data[sym]?.candles['1d'] ?? [], dr = rsi(dc.map((x) => x.close), 14), dReg = proState(dr).regime;
    for (const tf of tfs) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 300) continue;
      const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14), st = proState(r);
      cache.set(`${sym}|${tf}`, { c, atr });
      // Opposite signal-line crosses (exit 'opposite'): for longs the cross under, for shorts the cross over.
      const crossDn: number[] = [], crossUp: number[] = [];
      for (let i = 1; i < r.length; i++) {
        const v = r[i], p = r[i - 1], s = st.sig[i], sp = st.sig[i - 1];
        if (v == null || p == null || s == null || sp == null) continue;
        if (p <= sp && v > s) crossUp.push(i);
        if (p >= sp && v < s) crossDn.push(i);
      }
      const busy = new Map<string, number>();
      for (const e of proEvents(c, r, atr)) {
        const j = e.i + 1, t0 = c[e.i]!.openTime + BAR[tf];
        if (t0 < from || j >= c.length) continue;
        const kd = lastClosed(dc, DAY, t0), dreg = kd >= 0 ? dReg[kd] : null;
        const regOk = dreg != null && dreg === e.d;
        for (const filt of ['none', 'daily regime'] as const) {
          if (filt === 'daily regime' && !regOk) continue;
          for (const ex of ['2R', '3R', 'trail', 'opposite'] as Exit[]) {
            const key = `${tf}|${e.d > 0 ? 'long' : 'short'}|${e.pat}|${filt}|${ex}`;
            if (c[j]!.openTime <= (busy.get(key) ?? -Infinity)) continue;
            const opp = e.d > 0 ? crossDn : crossUp, oppR = e.d > 0 ? crossUp : crossDn;
            const tr = scalp2Trade(c, r, atr, j, e.stop, e.d, CAP[tf], ex, opp);
            if (!tr || c[tr.end]!.openTime + BAR[tf] > to) continue;
            const a = rows.get(key) ?? [];
            a.push({ sym, t: c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, d: e.d, j, risk: e.d * (c[j]!.open - e.stop), ex, tf, opp, oppR });
            rows.set(key, a);
            busy.set(key, c[tr.end]!.openTime + BAR[tf]);
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
  const HEAD = '  timeframe | side | signal | filter | exit                                                   n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const scored = [...rows.entries()].map(([k, ts]) => ({ k, ts, avg: avg(ts.map((t) => t.r)), old: avg(ts.filter((t) => t.t < cut).map((t) => t.r)), neu: avg(ts.filter((t) => t.t >= cut).map((t) => t.r)) }));
  const pre = scored.filter((x) => x.ts.length >= 60 && x.old > 0 && x.neu > 0).sort((a, b) => b.avg - a.avg);
  const kept = pre.map((x) => ({ ...x, rnd: randomAvg(x.ts) })).filter((x) => x.avg - x.rnd >= 0.1);
  const out = [`RSI PRO+ SUITE (RWCS_LTD, default settings): ${day(from)} to ${day(to)}, ${symbols.length} coins, ${tfs.join(', ')}. Older / newer = before / after ${day(cut)}. Costs 0.22%.`,
    '', `${rows.size} lines; ${pre.length} positive in both periods with n >= 60; ${kept.length} also beat a random side by >= 0.1 R.`, 'KEPT (best 20):', HEAD];
  for (const x of kept.slice(0, 20)) out.push(`${statsLine(x.k.padEnd(84).slice(0, 84), x.ts, cut)}   random ${x.rnd.toFixed(2)}`);
  out.push('', 'BEST LINE PER TIMEFRAME, SIDE AND SIGNAL (n >= 30), with the random baseline:', HEAD);
  for (const tf of tfs) for (const side of ['long', 'short']) for (const pat of PATS) {
    const b = scored.filter((x) => x.k.startsWith(`${tf}|${side}|${pat}|`) && x.ts.length >= 30).sort((a, z) => z.avg - a.avg)[0];
    if (b) out.push(`${statsLine(b.k.padEnd(84).slice(0, 84), b.ts, cut)}   random ${randomAvg(b.ts).toFixed(2)}`);
  }
  return out;
}

// B. Across the 6 live models.
export function rsiProModelsReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped);
  type T = SignalTrade & { tags: Set<string> };
  const base = new Map<RsiModelId, T[]>();
  const TAGS = ['score >= 4 entry tf', 'regime with entry tf', 'regime against entry tf', 'RSI over signal entry tf', 'score >= 4 daily', 'regime with daily', 'regime against daily', 'RSI over signal daily'];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const rD = rsi(d1.map((x) => x.close), 14), r4 = rsi(h4.map((x) => x.close), 14);
    const st = { d: { 1: proState(rD), [-1]: proState(inv(rD)) }, h: { 1: proState(r4), [-1]: proState(inv(r4)) } } as const;
    const rr = { d: { 1: rD, [-1]: inv(rD) }, h: { 1: r4, [-1]: inv(r4) } } as const;
    const tags = (d: 1 | -1, which: 'd' | 'h', k: number, sfx: string): string[] => {
      if (k < 0) return [];
      const s = st[which][d], r = rr[which][d][k], out: string[] = [];
      if ((s.score[k] ?? -1) >= 4) out.push(`score >= 4 ${sfx}`);
      if (s.regime[k] === 1) out.push(`regime with ${sfx}`);
      if (s.regime[k] === -1) out.push(`regime against ${sfx}`);
      if (r != null && s.sig[k] != null && r > s.sig[k]!) out.push(`RSI over signal ${sfx}`);
      return out;
    };
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (!models.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length || s.c[s.j]!.openTime < from) continue;
      if (s.known <= (busy.get(s.model) ?? -Infinity)) continue;
      const lx = LIVE_EXITS[s.model][0], entry = s.c[s.j]!.open, t = specTrade(s.c, s.atr, {}, s.j, entry - lx.stopMult * (entry - s.stop), s.d, lx.spec);
      if (!t) continue;
      const tEntry = s.c[s.j]!.openTime, daily = s.bar === DAY;
      const tg = new Set([...tags(s.d, daily ? 'd' : 'h', s.j - 1, 'entry tf'), ...tags(s.d, 'd', lastClosed(d1, DAY, tEntry), 'daily')]);
      base.set(s.model, [...(base.get(s.model) ?? []), { sym, t: tEntry, r: t.r, stopPct: t.stopPct, bars: t.bars, tags: tg }]);
      busy.set(s.model, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
    }
  }
  const HEAD = '  model / RSI Pro+ state at entry                                                    n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`RSI PRO+ STATE ACROSS THE 6 LIVE MODELS (version A exits): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'entry tf = daily (4H for under-floor); "with" = on the trade\'s side (mirrored for shorts).', HEAD];
  const all: T[] = [];
  const block = (name: string, ts: T[]) => {
    out.push('', name, statsLine('base (as live)'.padEnd(84), ts, cut));
    for (const f of TAGS) { out.push(statsLine(`  with: ${f}`.padEnd(84), ts.filter((t) => t.tags.has(f)), cut)); out.push(statsLine(`  without: ${f}`.padEnd(84), ts.filter((t) => !t.tags.has(f)), cut)); }
  };
  for (const m of models) { const ts = base.get(m) ?? []; all.push(...ts); block(RSI_MODELS[m].label, ts); }
  block('ALL 6 MODELS', all);
  return out;
}
