// Working the one 15m / 1h line that passed (owner 2026-10-05: "let's continue to work on it, not just apply it to
// paper or live at the first sight of positive test results"). Research only.
//
// Base (docs/RESULTS.md "Cost / stop gate and realistic maker fills"): 1h short regular divergence (RSI high A >= 70,
// a lower RSI high B 5-60 bars later at a higher price high, confirmed when RSI closes back under 50 within 30 bars, not
// cancelled by a new high over B), daily RSI < 50, maker limit at the signal close (2 bars, 1-tick trade-through),
// K = 10 cost / stop gate, stop 1.5x the pattern stop, 3R target, 120-bar cap, real funding.
//
// Method, fixed before the run:
//  1. Is the base robust? By year, by coin (top-5 share of total R, and without the 3 best coins).
//  2. One change at a time from the base, over a neighbourhood: stop multiple, target / exit, daily RSI threshold, the
//     pattern's own settings (A level, confirmation level, max A-B gap), entry price, the K gate, the time cap, and
//     filters the live models already use (BTC under its 50-day / 200-day SMA, coin under its own 50-day SMA, skip late
//     > 3 ATR, 4H RSI < 50, 1h MACD histogram side).
//  3. Selection on the RESEARCH coins only: a change counts when avg R rises in BOTH periods with n >= 300, and, for a
//     numeric setting, both neighbours are also at least the base (a plateau, not a spike). The combined candidate
//     (`--div-combo`) is then run once on the fresh coins; pass = positive in both periods, above random, and not
//     below the base there. The coin holdout stays locked.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi, sma } from '../indicators';
import type { FundingPoint } from '../types';
import { lastClosed } from './scalp2';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, DAY = 24 * H, TAKER = 0.11, MAKER = 0.02, ROUND = 0.22;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(2) : '-');

export interface DivParams { a: number; confirm: number; maxGap: number; win: number }
export const BASE_DIV: DivParams = { a: 70, confirm: 50, maxGap: 60, win: 30 };

/**
 * Bearish regular divergences confirmed by RSI closing back under `confirm` (the RSI catalogue's rule, mirrored, with its
 * settings as parameters). Signal at bar i (entry from i + 1); stop over B's high + 0.2 ATR(14).
 */
export function regDivShorts(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, atr: ReadonlyArray<number | null>, p: DivParams = BASE_DIV): { i: number; stop: number }[] {
  const mr = r.map((x) => (x == null ? null : 100 - x)), lowM = (k: number) => -c[k]!.high; // mirrored: highs become lows
  const aM = 100 - p.a, cM = 100 - p.confirm;
  const lows: number[] = [], pending: { b: number; lowB: number; until: number }[] = [], out: { i: number; stop: number }[] = [];
  for (let i = 1; i < c.length; i++) {
    const v = mr[i], pv = mr[i - 1];
    if (v == null || pv == null) continue;
    const k = i - 2;
    if (k >= 5) {
      const rk = mr[k];
      let isLow = rk != null;
      for (let q = k - 5; q <= k + 2 && isLow; q++) { if (q === k) continue; const w = mr[q]; if (w == null || w < rk! || (w === rk && q < k)) isLow = false; }
      if (isLow) {
        for (const a of lows) {
          if (k - a < 5 || k - a > p.maxGap) continue;
          if (mr[a]! <= aM && rk! > mr[a]! && lowM(k) < lowM(a)) pending.push({ b: k, lowB: lowM(k), until: k + p.win });
        }
        lows.push(k);
        while (lows.length && k - lows[0]! > p.maxGap) lows.shift();
      }
    }
    for (let q = pending.length - 1; q >= 0; q--) {
      const x = pending[q]!;
      if (i <= x.b + 2) continue;
      if (lowM(i) < x.lowB || i > x.until) { pending.splice(q, 1); continue; }
      if (pv < cM && v >= cM) {
        const a = atr[i];
        if (a != null) out.push({ i, stop: -(x.lowB - 0.2 * a) });
        pending.splice(q, 1);
      }
    }
  }
  return out;
}

/** A trade from price px in bar q. tgtR null = no target; trail = 3 ATR from +1R; be = stop to entry after a close at +be R. */
export function divTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, q: number, px: number, stop0: number, d: 1 | -1, cap: number, o: { tgtR: number | null; trail: boolean; be: number | null }, intrabar: boolean, tick: number): { gross: number; how: 'stop' | 'target' | 'other'; end: number; stopPct: number } | null {
  const risk = d * (px - stop0), last = q + cap - 1;
  if (!(risk > 0) || last >= c.length) return null;
  const tgt = o.tgtR != null ? px + d * o.tgtR * risk : null;
  let stop = stop0, best = px, armed = false;
  const done = (out: number, i: number, how: 'stop' | 'target' | 'other') => ({ gross: (d * (out - px)) / risk, how, end: i, stopPct: (100 * risk) / px });
  for (let i = q; i <= last; i++) {
    const b = c[i]!;
    if (i > q && d * (b.open - stop) <= 0) return done(b.open, i, 'stop');
    if (d > 0 ? b.low <= stop : b.high >= stop) return done(stop, i, 'stop');
    if (tgt != null && !(intrabar && i === q) && (d > 0 ? b.high >= tgt + tick : b.low <= tgt - tick)) return done(i > q && d * (b.open - tgt) >= 0 ? b.open : tgt, i, 'target');
    if (o.trail) {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - px) >= risk) armed = true;
      const a = atr[i];
      if (armed && a != null) { const tr = best - d * 3 * a; if (d * (tr - stop) > 0) stop = tr; }
    }
    if (o.be != null && d * (b.close - px) >= o.be * risk && d * (px - stop) > 0) stop = px;
  }
  return done(c[last]!.close, last, 'other');
}

type Exit = '2R' | '2.5R' | '3R' | '4R' | '5R' | 'trail' | '3R + BE 2R';
type Entry = 'market' | 'maker close' | 'maker +0.25 ATR';
type Filter = 'btc < 50d' | 'btc < 200d' | 'coin < 50d' | 'skip late 3 ATR' | '4h rsi < 50' | '1h macd hist < 0' | '1h macd hist > 0';
export interface Spec { stop: number; exit: Exit; daily: number | null; div: DivParams; entry: Entry; k: number | null; cap: number; filters: Filter[] }
export const BASE_SPEC: Spec = { stop: 1.5, exit: '3R', daily: 50, div: BASE_DIV, entry: 'maker close', k: 10, cap: 120, filters: [] };
const EXIT_OPT: Record<Exit, { tgtR: number | null; trail: boolean; be: number | null }> = {
  '2R': { tgtR: 2, trail: false, be: null }, '2.5R': { tgtR: 2.5, trail: false, be: null }, '3R': { tgtR: 3, trail: false, be: null },
  '4R': { tgtR: 4, trail: false, be: null }, '5R': { tgtR: 5, trail: false, be: null }, trail: { tgtR: null, trail: true, be: null },
  '3R + BE 2R': { tgtR: 3, trail: false, be: 2 },
};

interface Coin { sym: string; c: ReadonlyArray<Candle>; atr: (number | null)[]; r: (number | null)[]; tick: number; funding: ReadonlyArray<FundingPoint>; dr: (number | null)[]; dc: ReadonlyArray<Candle>; dsma: (number | null)[]; c4: ReadonlyArray<Candle>; r4: (number | null)[]; hist: (number | null)[]; ev: Map<string, { i: number; stop: number }[]> }
type T = SignalTrade & { opp: number | null };

/** Shell-safe filter names for `--div-combo` (the workflow passes it unquoted). */
const FILTER_ALIAS: Record<string, Filter> = { btc50: 'btc < 50d', btc200: 'btc < 200d', coin50: 'coin < 50d', late3: 'skip late 3 ATR', rsi4h50: '4h rsi < 50', macdneg: '1h macd hist < 0', macdpos: '1h macd hist > 0' };
const EXIT_ALIAS: Record<string, Exit> = { '2R': '2R', '2.5R': '2.5R', '3R': '3R', '4R': '4R', '5R': '5R', trail: 'trail', be: '3R + BE 2R' };
const ENTRY_ALIAS: Record<string, Entry> = { market: 'market', close: 'maker close', atr: 'maker +0.25 ATR' };

/** `--div-combo stop:2,exit:4R,daily:45,a:75,confirm:50,gap:60,entry:close,k:10,cap:120,filter:btc50` (any subset). */
export function parseCombo(s: string | undefined): Spec {
  const spec: Spec = { ...BASE_SPEC, div: { ...BASE_DIV }, filters: [] };
  for (const kv of (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = kv.split(':').map((x) => x.trim()) as [string, string];
    if (k === 'stop') spec.stop = Number(v);
    else if (k === 'exit') spec.exit = EXIT_ALIAS[v] ?? (() => { throw new Error(`unknown exit ${v}`); })();
    else if (k === 'daily') spec.daily = v === 'none' ? null : Number(v);
    else if (k === 'a') spec.div.a = Number(v);
    else if (k === 'confirm') spec.div.confirm = Number(v);
    else if (k === 'gap') spec.div.maxGap = Number(v);
    else if (k === 'entry') spec.entry = ENTRY_ALIAS[v] ?? (() => { throw new Error(`unknown entry ${v}`); })();
    else if (k === 'k') spec.k = v === 'none' ? null : Number(v);
    else if (k === 'cap') spec.cap = Number(v);
    else if (k === 'filter') spec.filters.push(FILTER_ALIAS[v] ?? (() => { throw new Error(`unknown filter ${v}`); })());
    else throw new Error(`unknown --div-combo key ${k}`);
  }
  return spec;
}

export function ltfDivReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, ticks: ReadonlyMap<string, number> = new Map(), combo?: string): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcC = btc.map((b) => b.close), b50 = sma(btcC, 50), b200 = sma(btcC, 200);
  const btcUnder = (t: number, s: (number | null)[]) => { const k = lastClosed(btc, DAY, t); return k >= 0 && s[k] != null && btc[k]!.close < s[k]!; };
  const coins: Coin[] = [];
  for (const sym of symbols) {
    const c = data[sym]?.candles['1h'] ?? [], dc = data[sym]?.candles['1d'] ?? [], c4 = data[sym]?.candles['4h'] ?? [];
    if (c.length < 500 || dc.length < 60) continue;
    const r = rsi(c.map((x) => x.close), 14), m = macdLines(c.map((x) => x.close));
    coins.push({ sym, c, atr: atrWilder(c, 14), r, tick: ticks.get(sym) ?? c[c.length - 1]!.close * 1e-4, funding: data[sym]?.funding ?? [],
      dr: rsi(dc.map((x) => x.close), 14), dc, dsma: sma(dc.map((x) => x.close), 50), c4, r4: rsi(c4.map((x) => x.close), 14),
      hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)), ev: new Map() });
  }
  const events = (k: Coin, p: DivParams) => {
    const key = `${p.a}|${p.confirm}|${p.maxGap}|${p.win}`;
    let e = k.ev.get(key);
    if (!e) { e = regDivShorts(k.c, k.r, k.atr, p); k.ev.set(key, e); }
    return e;
  };
  const fundR = (k: Coin, d: 1 | -1, start: number, end: number, stopPct: number) => {
    const fs = k.funding;
    let lo = 0, hi = fs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (fs[m]!.time <= start) lo = m + 1; else hi = m; }
    let s = 0;
    for (let q = lo; q < fs.length && fs[q]!.time <= end; q++) s += -d * fs[q]!.rate * 100;
    return s / stopPct;
  };
  /** One trade for a signal under a spec and side; null = no trade (missed fill, gate, invalid). */
  const sim = (k: Coin, e: { i: number; stop: number }, spec: Spec, d: 1 | -1, distPct?: number): (SignalTrade & { endT: number }) | 'skip' | null => {
    const { c, atr } = k, i = e.i, a = atr[i];
    let q: number, px: number, intrabar: boolean;
    if (spec.entry === 'market') { q = i + 1; if (q >= c.length) return null; px = c[q]!.open; intrabar = false; }
    else {
      const lim = c[i]!.close - (spec.entry === 'maker +0.25 ATR' ? d * 0.25 * (a ?? 0) : 0);
      let f = -1;
      for (let x = i + 1; x <= i + 2 && x < c.length; x++) if (d > 0 ? c[x]!.low <= lim - k.tick : c[x]!.high >= lim + k.tick) { f = x; break; }
      if (f < 0) return null;
      q = f; px = lim; intrabar = true;
    }
    const dist = distPct != null ? (px * distPct) / 100 : spec.stop * Math.abs(px - e.stop);
    const stop = px - d * dist, stopPct = (100 * dist) / px;
    if (!(stopPct > 0)) return null;
    if (spec.k != null && stopPct < spec.k * ROUND) return 'skip';
    const tr = divTrade(c, atr, q, px, stop, d, spec.cap, EXIT_OPT[spec.exit], intrabar, k.tick);
    if (!tr) return null;
    const cost = spec.entry === 'market' ? ROUND : MAKER + (tr.how === 'target' ? MAKER : TAKER);
    const endT = c[tr.end]!.openTime + H;
    return { sym: k.sym, t: c[q]!.openTime, r: tr.gross - (cost * px) / (dist * 100) + fundR(k, d, c[q]!.openTime, endT, stopPct), stopPct, bars: tr.end - q + 1, endT };
  };
  const keep = (k: Coin, e: { i: number }, spec: Spec, t0: number): boolean => {
    if (spec.daily != null) { const j = lastClosed(k.dc, DAY, t0); if (j < 0 || k.dr[j] == null || !(k.dr[j]! < spec.daily)) return false; }
    for (const f of spec.filters) {
      if (f === 'btc < 50d' && !btcUnder(t0, b50)) return false;
      if (f === 'btc < 200d' && !btcUnder(t0, b200)) return false;
      if (f === 'coin < 50d') { const j = lastClosed(k.dc, DAY, t0); if (j < 0 || k.dsma[j] == null || !(k.dc[j]!.close < k.dsma[j]!)) return false; }
      if (f === 'skip late 3 ATR') { const a = k.atr[e.i]; let hi = -Infinity; for (let q = Math.max(0, e.i - 9); q <= e.i; q++) hi = Math.max(hi, k.c[q]!.high); if (a == null || (hi - k.c[e.i]!.close) / a > 3) return false; }
      if (f === '4h rsi < 50') { const j = lastClosed(k.c4, 4 * H, t0); if (j < 0 || k.r4[j] == null || !(k.r4[j]! < 50)) return false; }
      if (f === '1h macd hist < 0' && !((k.hist[e.i] ?? 0) < 0)) return false;
      if (f === '1h macd hist > 0' && !((k.hist[e.i] ?? 0) > 0)) return false;
    }
    return true;
  };
  const run = (spec: Spec): { ts: T[]; skipped: number; missed: number } => {
    const ts: T[] = [];
    let skipped = 0, missed = 0;
    for (const k of coins) {
      let busy = -Infinity;
      for (const e of events(k, spec.div)) {
        const t0 = k.c[e.i]!.openTime + H;
        if (t0 < from || t0 <= busy || !keep(k, e, spec, t0)) continue;
        const s = sim(k, e, spec, -1);
        if (s === 'skip') { skipped++; continue; }
        if (!s) { missed++; continue; }
        if (s.endT > to) continue;
        const o = sim(k, e, spec, 1, s.stopPct);
        ts.push({ sym: s.sym, t: s.t, r: s.r, stopPct: s.stopPct, bars: s.bars, opp: o && o !== 'skip' && o.endT <= to ? o.r : null });
        busy = s.endT;
      }
    }
    return { ts, skipped, missed };
  };
  // Random direction = each trade taken both ways, averaged (the expected result of a coin-flip side).
  const rnd = (ts: T[]) => avg(ts.flatMap((t) => (t.opp == null ? [t.r] : [t.r, t.opp])));
  const half = (ts: T[]) => [avg(ts.filter((t) => t.t < cut).map((t) => t.r)), avg(ts.filter((t) => t.t >= cut).map((t) => t.r))] as const;
  const HEAD = '  variant                                                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`1h SHORT REGULAR DIVERGENCE, WORKED (base: daily RSI < 50, maker at the close, K = 10, stop 1.5x, 3R): ${day(from)} to ${day(to)}, ${coins.length} coins. Older / newer = before / after ${day(cut)}.`];
  const base = run(BASE_SPEC), [bo, bn] = half(base.ts), bAvg = avg(base.ts.map((t) => t.r));
  const line = (label: string, spec: Spec, mark = true) => {
    const x = run(spec), [o, n] = half(x.ts), a = avg(x.ts.map((t) => t.r));
    const better = mark && x.ts.length >= 300 && o > bo && n > bn;
    out.push(`${statsLine(`    ${label}`.padEnd(84), x.ts, cut)}   random ${f2(rnd(x.ts))}   skipped ${x.skipped} missed ${x.missed}${better ? '   BETTER IN BOTH PERIODS' : ''}`);
    return { a, o, n, len: x.ts.length };
  };

  // 0. Sanity: the parametrised detector against the catalogue's count is in the unit tests; here, the base line.
  out.push('', 'BASE', HEAD);
  out.push(`${statsLine('    base'.padEnd(84), base.ts, cut)}   random ${f2(rnd(base.ts))}   skipped ${base.skipped} missed ${base.missed}`);

  // 1. Robustness of the base.
  out.push('', '1. ROBUSTNESS OF THE BASE', '  by year: ' + [...new Set(base.ts.map((t) => new Date(t.t).getUTCFullYear()))].sort().map((y) => {
    const ys = base.ts.filter((t) => new Date(t.t).getUTCFullYear() === y);
    return `${y}: ${ys.length} trades, avg ${f2(avg(ys.map((t) => t.r)))}, total ${ys.reduce((s, t) => s + t.r, 0).toFixed(1)} R`;
  }).join(' | '));
  const bySym = new Map<string, number>();
  for (const t of base.ts) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + t.r);
  const ranked = [...bySym.entries()].sort((a, b) => b[1] - a[1]), total = base.ts.reduce((s, t) => s + t.r, 0);
  out.push(`  coins traded ${bySym.size}; positive ${ranked.filter((x) => x[1] > 0).length}; top 5 coins = ${ranked.slice(0, 5).reduce((s, x) => s + x[1], 0).toFixed(1)} of ${total.toFixed(1)} R total (${ranked.slice(0, 5).map((x) => `${x[0]} ${x[1].toFixed(1)}`).join(', ')})`);
  const top3 = new Set(ranked.slice(0, 3).map((x) => x[0]));
  out.push(statsLine('    without the 3 best coins'.padEnd(84), base.ts.filter((t) => !top3.has(t.sym)), cut));
  const quarters = new Map<string, number[]>();
  for (const t of base.ts) { const d = new Date(t.t), q = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`; quarters.set(q, [...(quarters.get(q) ?? []), t.r]); }
  out.push('  by quarter (total R): ' + [...quarters.entries()].sort().map(([q, rs]) => `${q} ${rs.reduce((a, b) => a + b, 0).toFixed(1)} (${rs.length})`).join(' | '));

  // 2. One change at a time.
  out.push('', '2. ONE CHANGE AT A TIME (BETTER IN BOTH PERIODS = avg R above the base in the older AND newer period, n >= 300)', HEAD);
  const with_ = (p: Partial<Spec>): Spec => ({ ...BASE_SPEC, div: { ...BASE_DIV }, filters: [], ...p });
  const dim = (name: string, vals: { label: string; spec: Spec; isBase?: boolean }[]) => {
    out.push(`  ${name}`);
    const res = vals.map((v) => ({ ...v, ...line(v.label + (v.isBase ? ' (base)' : ''), v.spec, !v.isBase) }));
    // Plateau note for numeric settings: values whose neighbours are both >= the base avg R.
    const plateau = res.filter((v, i) => !v.isBase && i > 0 && i < res.length - 1 && res[i - 1]!.a >= bAvg && res[i + 1]!.a >= bAvg && v.len >= 300 && v.o > bo && v.n > bn);
    if (plateau.length) out.push(`      plateau (both neighbours >= base): ${plateau.map((v) => v.label).join(', ')}`);
  };
  dim('stop multiple', [1, 1.25, 1.5, 1.75, 2, 2.5].map((s) => ({ label: `stop ${s}x`, spec: with_({ stop: s }), isBase: s === 1.5 })));
  dim('exit', (['2R', '2.5R', '3R', '4R', '5R', 'trail', '3R + BE 2R'] as Exit[]).map((x) => ({ label: `exit ${x}`, spec: with_({ exit: x }), isBase: x === '3R' })));
  dim('daily RSI under', [40, 45, 50, 55, null].map((v) => ({ label: v == null ? 'no daily RSI filter' : `daily RSI < ${v}`, spec: with_({ daily: v }), isBase: v === 50 })));
  dim('A level (RSI high)', [65, 70, 75, 80].map((v) => ({ label: `A >= ${v}`, spec: with_({ div: { ...BASE_DIV, a: v } }), isBase: v === 70 })));
  dim('confirmation (RSI closes under)', [45, 50, 55].map((v) => ({ label: `confirm under ${v}`, spec: with_({ div: { ...BASE_DIV, confirm: v } }), isBase: v === 50 })));
  dim('max A-B gap (bars)', [30, 60, 90].map((v) => ({ label: `gap <= ${v}`, spec: with_({ div: { ...BASE_DIV, maxGap: v } }), isBase: v === 60 })));
  dim('entry', (['market', 'maker close', 'maker +0.25 ATR'] as Entry[]).map((v) => ({ label: `entry ${v}`, spec: with_({ entry: v }), isBase: v === 'maker close' })));
  dim('cost / stop gate K', [null, 5, 10, 15].map((v) => ({ label: v == null ? 'no gate' : `K = ${v}`, spec: with_({ k: v }), isBase: v === 10 })));
  dim('time cap (1h bars)', [60, 120, 240].map((v) => ({ label: `cap ${v}`, spec: with_({ cap: v }), isBase: v === 120 })));
  out.push('  filters (each added alone)');
  for (const f of ['btc < 50d', 'btc < 200d', 'coin < 50d', 'skip late 3 ATR', '4h rsi < 50', '1h macd hist < 0', '1h macd hist > 0'] as Filter[]) line(`filter: ${f}`, with_({ filters: [f] }));

  if (combo) {
    const spec = parseCombo(combo);
    out.push('', `3. COMBINED CANDIDATE (chosen on the research coins): ${combo}`, HEAD);
    out.push(`${statsLine('    base'.padEnd(84), base.ts, cut)}   random ${f2(rnd(base.ts))}`);
    const x = run(spec), [o, n] = half(x.ts);
    out.push(`${statsLine('    combined'.padEnd(84), x.ts, cut)}   random ${f2(rnd(x.ts))}   skipped ${x.skipped} missed ${x.missed}   ${o > 0 && n > 0 && avg(x.ts.map((t) => t.r)) > rnd(x.ts) ? 'POSITIVE IN BOTH PERIODS, ABOVE RANDOM' : 'fails'}`);
  }
  return out;
}
