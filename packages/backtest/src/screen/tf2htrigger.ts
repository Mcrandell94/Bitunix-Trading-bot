// 2h entry trigger on the live models, longs and shorts (owner 2026-10-05: "can't we retune RSI numbers and/or consider
// MACD gap, along with confluence from the 4hr to make a 2hr bot functional?" ... "I was hoping for long models as
// well"). Research only. The setups are the live models' own (option 1 rules at the setup); the 2h bars only time the
// entry. Rules fixed before the run:
//
// Setups (stop level fixed at the setup = the live entry price minus stopMult x the live stop distance):
//  - 4h-fail-short (live): 4H bearish failure swing, daily RSI < 50, BTC under its 50-day SMA; exit 3R, breakeven +2R, 15 days;
//  - 4h-fail-long (NEW, mirror): 4H bullish failure swing (or its double-bottom form), daily RSI > 50; no BTC filter
//    (no live long uses one); exit 3R, breakeven +2R, 15 days;
//  - under-floor (live, small sample): exit 5 ATR trail from +2R, 10 days, stop 0.75x; no breakeven;
//  - bottom-div (live B: 20R, 270 days), triple-div (live B: 20R, 90 days, stop 0.75x), w-dbl-bottom (live A: hold
//    91 days); breakeven +2R. The live entry time (next daily open; triple-div: after the daily MACD cross) starts the wait.
//  - every setup: skip late (> 3 ATR from the 10-bar extreme on the model's own bars at the live entry).
// Trigger, on closed 2h bars from the live entry time; wait 24h (4H setups) or 5 days (daily / weekly setups):
//  - RSI 14 (2h): none / turn (RSI turns the trade's way after a bar against) / cross back over 30, 40, 50 for longs
//    (under 70, 60, 50 for shorts) from the other side;
//  - 2h MACD gap in the trade's favour: none / >= 5% / >= 10% (gap = (MACD - signal) / |MACD|, sign by side);
//  - 4H filter: off / on (the last closed 4H MACD histogram points the trade's way).
//  All conditions must hold on the same 2h close; entry at the next 2h open. Unfilled in the wait, or the stop traded
//  first, or the entry already past the stop = missed. "none / none / off" = enter at once (the reference).
// Trades are simulated on 2h bars (caps in calendar days; the under-floor trail is 5 x sqrt(2) 2h ATR, about 5 4H ATR).
// Costs 0.22%. Trades still open at the data end are marked at the last close. One trade per coin per model per line.
// Random = each trade also taken the other way (same stop distance), averaged.
// Selection (fixed): research coins, older period only (2022-2024): per model, the line with the best older avg R among
// lines with older n >= max(30, half the immediate line's older n); it must beat the immediate line there. That one pick
// is then read on the newer period and on fresh coins (same table, rules unchanged).

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi, sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { rsiPatterns } from './rsipatterns';
import { btcBearishAt, frameworkSetups, LATE_ATR, LIVE_EXITS, runBeforeEntry } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { lastClosed } from './scalp2';
import { to2h } from './tf2h';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const H = 3_600_000, H2 = 2 * H, H4 = 4 * H, DAY = 24 * H;

export type TModel = '4h-fail-short' | '4h-fail-long' | 'under-floor' | 'bottom-div' | 'triple-div' | 'w-dbl-bottom';
export const T_MODELS: readonly TModel[] = ['4h-fail-short', '4h-fail-long', 'under-floor', 'bottom-div', 'triple-div', 'w-dbl-bottom'];
export type RsiTrig = 'none' | 'turn' | 30 | 40 | 50;
export interface Line { rsi: RsiTrig; gap: 0 | 0.05 | 0.1; f4: boolean }
export const LINES: Line[] = (['none', 'turn', 30, 40, 50] as RsiTrig[]).flatMap((rsi) => ([0, 0.05, 0.1] as const).flatMap((gap) => [false, true].map((f4) => ({ rsi, gap, f4 }))));
export const lineName = (l: Line) => `RSI ${l.rsi === 'none' ? 'none' : l.rsi === 'turn' ? 'turn' : `cross ${l.rsi}`} / gap ${l.gap ? `>= ${l.gap * 100}%` : 'none'} / 4H ${l.f4 ? 'on' : 'off'}`;
const isNow = (l: Line) => l.rsi === 'none' && !l.gap && !l.f4;

/** One setup: direction, the live entry time, the stop level, the exit (caps in 2h bars) and the wait. */
export interface TSetup { model: TModel; sym: string; d: 1 | -1; start: number; stop: number; spec: ExitSpec; wait: number }

/** Does 2h bar k fire for a trade in direction d? */
export function fires(l: Line, d: 1 | -1, k: number, r: ReadonlyArray<number | null>, line: ReadonlyArray<number | null>, sig: ReadonlyArray<number | null>, h4ok: boolean): boolean {
  if (l.f4 && !h4ok) return false;
  if (l.gap) {
    const m = line[k], s = sig[k];
    if (m == null || s == null || m === 0 || !((d * (m - s)) / Math.abs(m) >= l.gap)) return false;
  }
  if (l.rsi === 'none') return true;
  const a = r[k], b = r[k - 1], c = r[k - 2];
  if (a == null || b == null) return false;
  if (l.rsi === 'turn') return c != null && d * (a - b) > 0 && d * (b - c) <= 0;
  const lv = d > 0 ? l.rsi : 100 - l.rsi;
  return d > 0 ? b <= lv && a > lv : b >= lv && a < lv;
}

/** Entry index on the 2h bars for one setup and line, or null when missed. */
export function triggerEntry(s: TSetup, l: Line, c2: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, line: ReadonlyArray<number | null>, sig: ReadonlyArray<number | null>, h4ok: (t: number) => boolean): number | null {
  let s0 = c2.length;
  for (let lo = 0, hi = c2.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (c2[m]!.openTime >= s.start) { s0 = m; hi = m - 1; } else lo = m + 1; }
  if (s0 < 1 || s0 >= c2.length) return null;
  for (let k = s0 - 1; k + 1 < c2.length && c2[k + 1]!.openTime < s.start + s.wait; k++) {
    if (k >= s0 && (s.d > 0 ? c2[k]!.low <= s.stop : c2[k]!.high >= s.stop)) return null;
    if (isNow(l) ? k === s0 - 1 : fires(l, s.d, k, r, line, sig, h4ok(c2[k]!.openTime + H2))) return s.d * (c2[k + 1]!.open - s.stop) > 0 ? k + 1 : null;
  }
  return null;
}

/** The setups of the six models for one coin (option 1 at the setup). */
export function trigSetups(sym: string, d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, btc: ReadonlyArray<Candle>, btc50: ReadonlyArray<number | null>): TSetup[] {
  const out: TSetup[] = [];
  const live = (m: 'bottom-div' | 'triple-div' | 'w-dbl-bottom' | 'under-floor' | '4h-fail-short', v: 0 | 1) => LIVE_EXITS[m][v];
  const scale = (sp: ExitSpec, barMs: number, trailK = 1): ExitSpec => ({ ...sp, ...(sp.cap != null ? { cap: Math.round((sp.cap * barMs) / H2) } : {}), ...(sp.trail ? { trail: { ...sp.trail, k: sp.trail.k * trailK } } : {}) });
  const push = (model: TModel, d: 1 | -1, c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop: number, stopMult: number, spec: ExitSpec, wait: number) => {
    if (j < 1 || j >= c.length) return;
    const ref = c[j]!.open;
    if (!(d * (ref - stop) > 0) || runBeforeEntry(c, atr, j, d, ref) > LATE_ATR) return;
    if (d < 0 && !btcBearishAt(btc, btc50, c[j]!.openTime)) return;
    out.push({ model, sym, d, start: c[j]!.openTime, stop: ref - stopMult * (ref - stop), spec, wait });
  };
  for (const st of frameworkSetups(d1, h4)) {
    if (st.j == null || st.stop == null) continue;
    if (st.model === 'bottom-div' || st.model === 'triple-div' || st.model === 'w-dbl-bottom') {
      const x = live(st.model, st.model === 'w-dbl-bottom' ? 0 : 1);
      push(st.model, 1, st.c, st.atr, st.j, st.stop, x.stopMult, { ...scale(x.spec, DAY), be: 2 }, 5 * DAY);
    } else if (st.model === 'under-floor') {
      const x = live('under-floor', 0);
      push('under-floor', 1, st.c, st.atr, st.j, st.stop, x.stopMult, scale(x.spec, H4, Math.SQRT2), DAY);
    } else if (st.model === '4h-fail-short') {
      const x = live('4h-fail-short', 0);
      push('4h-fail-short', -1, st.c, st.atr, st.j, st.stop, x.stopMult, { ...scale(x.spec, H4), be: 2 }, DAY);
    }
  }
  // New: the bullish 4H failure swing while the daily RSI is over 50 (mirror of the live short).
  if (h4.length >= 300 && d1.length >= 60) {
    const c = [...h4], r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14), dr = rsi(d1.map((b) => b.close), 14);
    for (const e of rsiPatterns(c, r, atr)) {
      if (e.d !== 1 || (e.pat !== 'failure swing' && e.pat !== 'double bottom')) continue;
      const k = lastClosed(d1, DAY, c[e.i]!.openTime + H4);
      if (k < 0 || dr[k] == null || !(dr[k]! > 50)) continue;
      push('4h-fail-long', 1, c, atr, e.i + 1, e.stop, 1, { name: '3R target, 15 days', target: 3, cap: 180, be: 2 }, DAY);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

type T = SignalTrade & { opp: number | null };
/** The random-direction twin's stop: the same distance on the other side of the entry. */
export const oppStop = (entry: number, stop: number) => 2 * entry - stop;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(2) : '-');

export function tf2hTriggerReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btc50 = sma(btc.map((b) => b.close), 50);
  const per = new Map<string, { c2: Candle[]; r: (number | null)[]; atr: (number | null)[]; line: (number | null)[]; sig: (number | null)[]; h4ok: (d: 1 | -1, t: number) => boolean }>();
  const setups: TSetup[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [], c2 = to2h(data[sym]?.candles['1h'] ?? []);
    if (d1.length < 300 || h4.length < 300 || c2.length < 300) continue;
    const closes = c2.map((b) => b.close), m = macdLines(closes), m4 = macdLines(h4.map((b) => b.close));
    const h4ok = (d: 1 | -1, t: number) => { const k = lastClosed(h4, H4, t); return k >= 0 && m4.line[k] != null && m4.sig[k] != null && d * (m4.line[k]! - m4.sig[k]!) > 0; };
    per.set(sym, { c2, r: rsi(closes, 14), atr: atrWilder(c2, 14), line: m.line, sig: m.sig, h4ok });
    for (const s of trigSetups(sym, d1, h4, btc, btc50)) if (s.start >= from && s.start >= c2[0]!.openTime + 30 * DAY) setups.push(s);
  }
  const run = (model: TModel, l: Line) => {
    const ts: T[] = [], busy = new Map<string, number>();
    let n = 0, missed = 0;
    for (const s of setups) {
      if (s.model !== model || s.start < (busy.get(s.sym) ?? -Infinity)) continue;
      const p = per.get(s.sym)!;
      n++;
      const j = triggerEntry(s, l, p.c2, p.r, p.line, p.sig, (t) => p.h4ok(s.d, t));
      if (j == null) { missed++; continue; }
      const t = specTrade(p.c2, p.atr, {}, j, s.stop, s.d, s.spec);
      if (!t) { missed++; continue; }
      const o = specTrade(p.c2, p.atr, {}, j, oppStop(p.c2[j]!.open, s.stop), (-s.d) as 1 | -1, s.spec);
      ts.push({ sym: s.sym, t: p.c2[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, opp: o ? o.r : null });
      busy.set(s.sym, t.open ? Infinity : p.c2[t.end]!.openTime + H2);
    }
    return { ts, n, missed };
  };
  const rnd = (ts: T[]) => avg(ts.flatMap((t) => (t.opp == null ? [t.r] : [t.r, t.opp])));
  const older = (ts: T[]) => ts.filter((t) => t.t < cut), newer = (ts: T[]) => ts.filter((t) => t.t >= cut);
  const HEAD = '  2h trigger                                                                             n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`2h ENTRY TRIGGER ON THE LIVE MODELS (+ new 4H bullish failure swing): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Setups are the live ones (option 1 at the setup); the trigger only times the entry. Missed = no trigger in the wait, or the stop traded first.', ''];
  const summary: string[] = ['SELECTION (older period only; pick must beat "enter at once" there; then read on the newer period):'];
  for (const model of T_MODELS) {
    const res = LINES.map((l) => ({ l, ...run(model, l) }));
    const now = res.find((x) => isNow(x.l))!;
    out.push(`${model.toUpperCase()} (${now.n} setups)`, HEAD);
    for (const x of res) out.push(`${statsLine(`    ${lineName(x.l)}`.padEnd(84), x.ts, cut)}   random ${f(rnd(x.ts))}  missed ${Math.round((100 * x.missed) / Math.max(1, x.n))}%`);
    out.push('');
    const nowO = avg(older(now.ts).map((t) => t.r)), minN = Math.max(30, Math.ceil(older(now.ts).length / 2));
    const cands = res.filter((x) => !isNow(x.l) && older(x.ts).length >= minN).sort((a, b) => avg(older(b.ts).map((t) => t.r)) - avg(older(a.ts).map((t) => t.r)));
    const pick = cands[0];
    const nowN = avg(newer(now.ts).map((t) => t.r));
    if (!pick) { summary.push(`  ${model}: no line with older n >= ${minN} (at once: older ${f(nowO)} n ${older(now.ts).length}, newer ${f(nowN)})`); continue; }
    const pO = avg(older(pick.ts).map((t) => t.r)), pN = avg(newer(pick.ts).map((t) => t.r));
    const nb = res.filter((x) => x !== pick && !isNow(x.l) && x.l.rsi === pick.l.rsi && (x.l.gap === pick.l.gap || x.l.f4 === pick.l.f4)).map((x) => `${lineName(x.l)} ${f(avg(older(x.ts).map((t) => t.r)))}`);
    summary.push(`  ${model}: pick ${lineName(pick.l)}: older ${f(pO)} (${older(pick.ts).length}) vs at once ${f(nowO)} (${older(now.ts).length}) ${pO > nowO ? 'BEATS' : 'does not beat'}; newer ${f(pN)} (${newer(pick.ts).length}) vs at once ${f(nowN)} (${newer(now.ts).length}) ${pN > nowN ? 'beats' : 'does not beat'}; random ${f(rnd(pick.ts))}`,
      `      neighbours (older): ${nb.join(' | ')}`);
  }
  return [...out, ...summary];
}
