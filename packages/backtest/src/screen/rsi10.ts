// 15M-RSI10 model (owner 2026-10-06): a long setup over a 7-10 day window read on 4H, 1H and 15m RSI 14 together,
// entered on a 15m close. Research only. Rules as agreed with the owner, fixed before the run (t0 = the 4H close where
// 4H RSI first dips to 30 or below, with no such dip in the 3 days before; days count from t0):
//
// Phase 1 (days 0-2): 4H RSI taps 27.5-30 (its lowest close in days 0-3 sits in 27.5-30); 1H RSI reaches 20-30.
// 15m (days 0-6): RSI goes under 30, down near 20 (lowest <= 25) at least once.
// Phase 2 (days 2-5): price makes a lower low than phase 1 while 4H RSI holds 30-33 at that time (no 4H close under 30
//   after day 3: one cancels the window).
// Phase 3 (day 5 to the entry, entry by day 10): price makes a lower low again (the window's lowest low); 4H RSI dips back
//   to 30-33 at least once; 1H RSI holds near 30 (its phase-3 low in 27-35); 15m RSI's phase-3 low is shallower (25-30)
//   and has since lifted into 35-41.
// Daily: RSI above 37 at the last daily close, and a bullish divergence month over month: the window's low is below the
//   lowest low of the previous month (days -40 to -10) while daily RSI at the window's low day is higher than at that low.
// Entry, all on one 15m close (enter at the next 15m open): 4H RSI 31-37, 1H RSI 33-39, 15m RSI 35-50 (last closed
//   bars of each). MACD gap add-on: (MACD - signal) / |MACD| >= 5% upward on 15m, 1h and 4h.
// Stop: the window's lowest low minus 0.25 x 1h ATR(14). One trade per window and per coin at a time.
// Levels (to see which parts matter): strict = everything above; core = the 4H flush (lowest 4H RSI in days 0-3 <= 30),
//   no 4H close under 30 after day 3, the two lower lows, the entry ranges and daily RSI > 37; entry = only the entry
//   ranges and daily RSI > 37 (no window; one trade per coin at a time, 10-day spacing).
// Exits on 15m bars: 2R / 3R / 5R targets (10 days), hold 2 / 5 / 10 days, breakeven at +1R then 1-day swing-low trail
//   (10 days). Costs 0.22% round trip. Random = each trade also taken short with the same stop distance, averaged.

// Round 2 (owner 2026-10-06): the daily month-over-month divergence is dropped from strict (dailyDivOk is kept for
// reference); the MACD gap add-on is replaced by divergences between phase 1 and phase 3 (the lowest RSI / MACD line in
// phase 3 above phase 1's, per timeframe); stops: window low - 0.25 x 1h ATR, window low - 1 x 4H ATR, and fixed 3 / 4 / 5%
// under the entry ("on a 10x position 40% is where most exit" = a 4% price move). The 15m phase-3 low of 25-30 is optional.
// Round 4 (owner 2026-10-06, "do 1"): the 4H flush may go to any depth at or below 30, and the 4H retests widen to 30-35.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { macdGap } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { lastClosed } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const M15 = 15 * 60_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H;

export type Level = 'strict' | 'core' | 'entry';
export const LEVELS: readonly Level[] = ['strict', 'core', 'entry'];
export const EXITS: readonly ExitSpec[] = [
  { name: '2R target, 10 days', target: 2, cap: 960 },
  { name: '3R target, 10 days', target: 3, cap: 960 },
  { name: '5R target, 10 days', target: 5, cap: 960 },
  { name: 'hold 2 days', cap: 192 },
  { name: 'hold 5 days', cap: 480 },
  { name: 'hold 10 days', cap: 960 },
  { name: 'breakeven +1R, 1-day swing trail, 10 days', be: 1, trail: { kind: 'swing', k: 96, arm: 1 }, cap: 960 },
];

interface Frame { c: ReadonlyArray<Candle>; r: (number | null)[]; bar: number; line?: (number | null)[]; sig?: (number | null)[] }
export interface Coin { sym: string; m15: Frame; h1: Frame & { atr: (number | null)[] }; h4: Frame & { atr?: (number | null)[] }; d1: Frame }

const frame = (c: ReadonlyArray<Candle>, bar: number, withMacd = false): Frame => {
  const closes = c.map((b) => b.close), m = withMacd ? macdLines(closes) : null;
  return { c, r: rsi(closes, 14), bar, ...(m ? { line: m.line, sig: m.sig } : {}) };
};
export function makeCoin(sym: string, m15: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>): Coin {
  return { sym, m15: frame(m15, M15, true), h1: { ...frame(h1, H, true), atr: atrWilder(h1, 14) }, h4: { ...frame(h4, H4, true), atr: atrWilder(h4, 14) }, d1: frame(d1, DAY) };
}

/** RSI values (with bar index) of the bars of `f` that closed in [a, b). */
function closedIn(f: Frame, a: number, b: number): { i: number; v: number }[] {
  const out: { i: number; v: number }[] = [];
  for (let i = Math.max(0, lastClosed(f.c, f.bar, a)); i < f.c.length; i++) {
    const end = f.c[i]!.openTime + f.bar;
    if (end >= b) break;
    if (end >= a && f.r[i] != null) out.push({ i, v: f.r[i]! });
  }
  return out;
}
const minOf = (xs: { v: number }[]) => xs.reduce((m, x) => Math.min(m, x.v), Infinity);
/** Lowest 15m low between a and b (bars fully closed by b), with its time. */
function lowIn(f: Frame, a: number, b: number): { px: number; t: number } {
  let px = Infinity, t = NaN;
  for (let i = Math.max(0, lastClosed(f.c, f.bar, a)); i < f.c.length && f.c[i]!.openTime + f.bar <= b; i++) {
    if (f.c[i]!.openTime < a) continue;
    if (f.c[i]!.low < px) { px = f.c[i]!.low; t = f.c[i]!.openTime; }
  }
  return { px, t };
}
const rsiAt = (f: Frame, t: number) => { const k = lastClosed(f.c, f.bar, t); return k < 0 ? null : f.r[k] ?? null; };
const gapAt = (f: Frame, t: number) => { const k = lastClosed(f.c, f.bar, t); return k < 0 || !f.line || !f.sig ? null : macdGap(f.line[k] ?? null, f.sig[k] ?? null, 1); };

export function entryOk(c: Coin, t: number): boolean {
  const r4 = rsiAt(c.h4, t), r1 = rsiAt(c.h1, t), r15 = rsiAt(c.m15, t), rd = rsiAt(c.d1, t);
  return r4 != null && r4 >= 31 && r4 <= 37 && r1 != null && r1 >= 33 && r1 <= 39 && r15 != null && r15 >= 35 && r15 <= 50 && rd != null && rd > 37;
}
export const macdOk = (c: Coin, t: number) => [c.m15, c.h1, c.h4].every((f) => { const g = gapAt(f, t); return g != null && g >= 0.05; });

/** Window starts: 4H closes where RSI first dips to 30 or below, with no such dip in the 3 days before. */
export function windowStarts(c: Coin): number[] {
  const out: number[] = [];
  let lastDip = -Infinity;
  for (let i = 0; i < c.h4.c.length; i++) {
    const v = c.h4.r[i];
    if (v == null || v > 30) continue;
    const t = c.h4.c[i]!.openTime + H4;
    if (t - lastDip > 3 * DAY) out.push(t);
    lastDip = t;
  }
  return out;
}

/** Does the window from t0 hold at time t (a 15m close) for this level? Entry ranges are checked separately. */
export function windowOk(c: Coin, t0: number, t: number, level: 'strict' | 'core'): boolean {
  if (t < t0 + 5 * DAY || t > t0 + 10 * DAY) return false;
  const h4early = closedIn(c.h4, t0 - H4 + 1, t0 + 3 * DAY + 1), h4late = closedIn(c.h4, t0 + 3 * DAY + 1, t + 1); // day 3 included in the buffer
  if (!h4early.length || h4late.some((x) => x.v < 30)) return false;
  const flush = minOf(h4early);
  if (!(flush <= 30)) return false;
  const p1 = lowIn(c.m15, t0 - H4, t0 + 2 * DAY), p2 = lowIn(c.m15, t0 + 2 * DAY, t0 + 5 * DAY), p3 = lowIn(c.m15, t0 + 5 * DAY, t);
  if (!(p2.px < p1.px && p3.px < p2.px)) return false;
  if (level === 'core') return true;
  return Object.entries(strictChecks(c, t0, t)).every(([k, v]) => v || OPTIONAL.has(k));
}

/** Rules the owner made optional (2026-10-06): reported, not required. */
export const OPTIONAL = new Set(['15m phase-3 low 25-30']);

/** The owner's detailed path, each rule on its own (for strict, and to see which rule blocks the most). */
export function strictChecks(c: Coin, t0: number, t: number): Record<string, boolean> {
  const flush = minOf(closedIn(c.h4, t0 - H4 + 1, t0 + 3 * DAY + 1));
  const h1p1 = minOf(closedIn(c.h1, t0 - H4, t0 + 2 * DAY)), h1p3 = minOf(closedIn(c.h1, t0 + 5 * DAY, t + 1));
  const m3 = closedIn(c.m15, t0 + 5 * DAY, t + 1);
  const lowK = m3.length ? m3.reduce((a, x) => (x.v < a.v ? x : a)) : null;
  return {
    '4H flush at or below 30': flush <= 30,
    '4H 30-35 in phase 2': closedIn(c.h4, t0 + 2 * DAY, t0 + 5 * DAY).some((x) => x.v >= 30 && x.v <= 35),
    '4H 30-35 in phase 3': closedIn(c.h4, t0 + 5 * DAY, t + 1).some((x) => x.v >= 30 && x.v <= 35),
    '1H 20-30 in phase 1': h1p1 >= 20 && h1p1 <= 30,
    '1H holds 27-35 in phase 3': h1p3 >= 27 && h1p3 <= 35,
    '15m <= 25 in days 0-6': minOf(closedIn(c.m15, t0 - H4, t0 + 6 * DAY)) <= 25,
    '15m phase-3 low 25-30': lowK != null && lowK.v >= 25 && lowK.v <= 30,
    '15m lift into 35-41 after it': lowK != null && m3.some((x) => x.i > lowK.i && x.v >= 35 && x.v <= 41),
  };
}

/** Month over month: the window's low under last month's low, daily RSI higher at the window's low day. */
export function dailyDivOk(c: Coin, t0: number, t: number, low: { px: number; t: number }): boolean {
  let pk = -1;
  for (let i = 0; i < c.d1.c.length; i++) {
    const b = c.d1.c[i]!;
    if (b.openTime < t0 - 40 * DAY || b.openTime + DAY > t0 - 10 * DAY) continue;
    if (pk < 0 || b.low < c.d1.c[pk]!.low) pk = i;
  }
  if (pk < 0 || c.d1.r[pk] == null || !(low.px < c.d1.c[pk]!.low)) return false;
  // Daily RSI on the low's day once that day has closed; before then, the last closed day's.
  const kLow = lastClosed(c.d1.c, DAY, low.t + DAY);
  const v = kLow >= 0 && c.d1.c[kLow]!.openTime <= low.t && c.d1.c[kLow]!.openTime + DAY <= t ? c.d1.r[kLow] : rsiAt(c.d1, t);
  return v != null && v > c.d1.r[pk]!;
}

/** Divergences between phase 1 (days 0-2) and phase 3 (day 5 to t): the lowest RSI / MACD line in phase 3 is higher. */
export function phaseDivs(c: Coin, t0: number, t: number): Record<string, boolean> {
  const minLine = (f: Frame, a: number, b: number) => {
    let m = Infinity;
    for (const x of closedIn(f, a, b)) { const v = f.line?.[x.i]; if (v != null) m = Math.min(m, v); }
    return m;
  };
  const out: Record<string, boolean> = {};
  for (const [name, f] of [['4H', c.h4], ['1H', c.h1], ['15m', c.m15]] as const) {
    const p1 = [t0 - H4, t0 + 2 * DAY] as const, p3 = [t0 + 5 * DAY, t + 1] as const;
    out[`RSI ${name}`] = minOf(closedIn(f, ...p3)) > minOf(closedIn(f, ...p1));
    const m1 = minLine(f, ...p1), m3 = minLine(f, ...p3);
    out[`MACD ${name}`] = Number.isFinite(m1) && Number.isFinite(m3) && m3 > m1;
  }
  return out;
}
export const ADDONS: readonly { name: string; ok: (d: Record<string, boolean>) => boolean }[] = [
  { name: 'RSI divergence on 4H, 1H and 15m', ok: (d) => !!(d['RSI 4H'] && d['RSI 1H'] && d['RSI 15m']) },
  { name: 'MACD divergence on 4H', ok: (d) => !!d['MACD 4H'] },
  { name: 'MACD divergence on 1H', ok: (d) => !!d['MACD 1H'] },
  { name: 'MACD divergence on 15m', ok: (d) => !!d['MACD 15m'] },
  { name: 'MACD divergence on all three', ok: (d) => !!(d['MACD 4H'] && d['MACD 1H'] && d['MACD 15m']) },
];

export interface Signal { sym: string; t0: number | null; t: number; j: number; low: number; atr1h: number; atr4h: number }

export type StopKind = 'low-1h' | 'low-4h' | 'pct3' | 'pct4' | 'pct5';
export const STOPS: readonly { kind: StopKind; name: string }[] = [
  { kind: 'low-1h', name: 'window low - 0.25 x 1h ATR' },
  { kind: 'low-4h', name: 'window low - 1 x 4H ATR' },
  { kind: 'pct3', name: 'fixed 3% (30% at 10x)' },
  { kind: 'pct4', name: 'fixed 4% (40% at 10x)' },
  { kind: 'pct5', name: 'fixed 5% (50% at 10x)' },
];
export function stopFor(s: Signal, entry: number, kind: StopKind): number {
  if (kind === 'low-1h') return s.low - 0.25 * s.atr1h;
  if (kind === 'low-4h') return s.low - s.atr4h;
  return entry * (1 - (kind === 'pct3' ? 0.03 : kind === 'pct4' ? 0.04 : 0.05));
}

/** Entries for one coin and level; `extra` is an optional add-on checked on the window (strict / core only). */
export function rsi10Signals(c: Coin, level: Level, from: number, extra?: (t0: number, t: number) => boolean): Signal[] {
  const out: Signal[] = [], m = c.m15.c;
  const atrs = (t: number) => { const a1 = c.h1.atr[lastClosed(c.h1.c, H, t)], a4 = c.h4.atr?.[lastClosed(c.h4.c, H4, t)]; return a1 == null || a4 == null ? null : { atr1h: a1, atr4h: a4 }; };
  let busy = -Infinity;
  if (level === 'entry') {
    for (let i = 0; i + 1 < m.length; i++) {
      const t = m[i]!.openTime + M15;
      if (t < from || t < busy || !entryOk(c, t)) continue;
      const a = atrs(t), low = lowIn(c.m15, t - 3 * DAY, t).px;
      if (!a || !(m[i + 1]!.open > low)) continue;
      out.push({ sym: c.sym, t0: null, t, j: i + 1, low, ...a });
      busy = t + 10 * DAY;
    }
    return out;
  }
  for (const t0 of windowStarts(c)) {
    if (t0 + 10 * DAY < from || t0 < busy) continue;
    const i0 = lastClosed(m, M15, t0 + 5 * DAY);
    for (let i = Math.max(0, i0); i + 1 < m.length; i++) {
      const t = m[i]!.openTime + M15;
      if (t > t0 + 10 * DAY) break;
      if (t < from || !entryOk(c, t) || !windowOk(c, t0, t, level) || (extra && !extra(t0, t))) continue;
      const a = atrs(t), low = lowIn(c.m15, t0 - H4, t).px;
      if (!a || !(m[i + 1]!.open > low)) break;
      out.push({ sym: c.sym, t0, t, j: i + 1, low, ...a });
      busy = t0 + 10 * DAY;
      break;
    }
  }
  return out;
}

type T = SignalTrade & { opp: number | null };
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function rsi10Report(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, show: ReadonlyArray<string> = ['ETHUSDT', 'SOLUSDT', 'LINKUSDT']): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const coins: Coin[] = [];
  let start = Infinity;
  for (const sym of symbols) {
    const g = (tf: string) => data[sym]?.candles[tf] ?? [];
    if (g('15m').length < 2000 || g('1h').length < 500 || g('4h').length < 300 || g('1d').length < 100) continue;
    coins.push(makeCoin(sym, g('15m'), g('1h'), g('4h'), g('1d')));
    start = Math.min(start, g('15m')[0]!.openTime);
  }
  const bySym = new Map(coins.map((c) => [c.sym, c]));
  const from2 = Math.max(from, start + 30 * DAY);
  const HEAD = '  exit                                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const block = (ss: Signal[], stop: StopKind, exits: readonly ExitSpec[]) => exits.map((ex) => {
    const ts: T[] = [];
    for (const s of ss) {
      const m = bySym.get(s.sym)!.m15.c, entry = m[s.j]!.open, st = stopFor(s, entry, stop);
      const tr = specTrade(m, [], {}, s.j, st, 1, ex);
      if (!tr) continue;
      const o = specTrade(m, [], {}, s.j, 2 * entry - st, -1, ex);
      ts.push({ sym: s.sym, t: m[s.j]!.openTime, r: tr.r, stopPct: tr.stopPct, bars: tr.bars, opp: o ? o.r : null });
    }
    return `${statsLine(`      ${ex.name}`.padEnd(84), ts, cut)}   random ${avg(ts.flatMap((x) => (x.opp == null ? [x.r] : [x.r, x.opp]))).toFixed(2)}`;
  });
  const out = [`15M-RSI10 (long), round 2: ${day(from2).slice(0, 10)} to ${day(to).slice(0, 10)}, ${coins.length} coins. Older / newer = before / after ${day(cut).slice(0, 10)}.`,
    'Owner changes: daily month-over-month divergence removed; divergences between phase 1 and phase 3 as add-ons; wider stops (4% = 40% on a 10x position). Costs 0.22%. Random = each trade also taken short, averaged.', ''];
  const sigs = new Map<string, Signal[]>();
  out.push('A. EACH LEVEL x STOP x EXIT');
  for (const level of LEVELS) {
    const ss = coins.flatMap((c) => rsi10Signals(c, level, from2));
    sigs.set(level, ss);
    out.push(`${level.toUpperCase()}: ${ss.length} signals on ${new Set(ss.map((s) => s.sym)).size} coins`);
    if (!ss.length) { out.push(''); continue; }
    for (const st of STOPS) out.push(`  stop: ${st.name}`, HEAD, ...block(ss, st.kind, EXITS));
    out.push('');
  }
  out.push('B. DIVERGENCE ADD-ONS (phase 1 vs phase 3; the window must also show it), stops window low - 1 x 4H ATR and fixed 4%');
  const SUB = EXITS.filter((e) => ['2R target, 10 days', '3R target, 10 days', 'hold 5 days', 'hold 10 days'].includes(e.name));
  for (const level of ['strict', 'core'] as const) for (const ad of ADDONS) {
    const ss = coins.flatMap((c) => rsi10Signals(c, level, from2, (t0, t) => ad.ok(phaseDivs(c, t0, t))));
    out.push(`${level.toUpperCase()} + ${ad.name}: ${ss.length} signals on ${new Set(ss.map((s) => s.sym)).size} coins`);
    if (!ss.length) continue;
    for (const st of STOPS.filter((x) => x.kind === 'low-4h' || x.kind === 'pct4')) out.push(`  stop: ${st.name}`, HEAD, ...block(ss, st.kind, SUB));
  }
  out.push('');
  const core = sigs.get('core') ?? [];
  if (core.length) {
    const tally = new Map<string, number>(), dv = new Map<string, number>();
    let all = 0;
    for (const s of core) {
      const c = bySym.get(s.sym)!, ch = strictChecks(c, s.t0!, s.t);
      for (const [k, v] of Object.entries(ch)) if (v) tally.set(k, (tally.get(k) ?? 0) + 1);
      if (Object.entries(ch).every(([k, v]) => v || OPTIONAL.has(k))) all++;
      for (const [k, v] of Object.entries(phaseDivs(c, s.t0!, s.t))) if (v) dv.set(k, (dv.get(k) ?? 0) + 1);
    }
    out.push(`C. STRICT RULES ON THE ${core.length} CORE SIGNALS (how many pass each rule; all required ones: ${all}; optional: ${[...OPTIONAL].join(', ')}):`);
    for (const [k, v] of tally) out.push(`  ${k.padEnd(36)} ${v} (${Math.round((100 * v) / core.length)}%)`);
    out.push('  divergences phase 1 -> phase 3 at the core signals: ' + [...dv].map(([k, v]) => `${k} ${v} (${Math.round((100 * v) / core.length)}%)`).join(' | '), '');
  }
  out.push('D. SIGNAL LIST (strict and core), to check against the charts:');
  for (const sym of show) for (const level of ['strict', 'core'] as const) {
    const ss = (sigs.get(level) ?? []).filter((s) => s.sym === sym);
    out.push(`  ${sym} ${level}: ${ss.length ? ss.map((s) => `window ${day(s.t0!)} -> entry ${day(s.t)} (window low ${s.low.toPrecision(5)})`).join(' | ') : 'none'}`);
  }
  return out;
}
