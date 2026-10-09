// The RSI framework's live signals for the dashboard (owner 2026-10-03: "allow current rsi framework to provide
// signals (not bot trades) to the dashboard"). Same models, settings and trade rules as frameworkReport in
// rsitrades.ts (docs/RESULTS.md, "RSI framework, final settings, as trades"), run on closed bars up to now:
// each setup is reported while it waits for its entry trigger, while the trade it describes is open, and for
// 14 days after it closed. Nothing here places orders.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdHistogram, macdLines, rsi, sma } from '../indicators';
import { bottomDivEvents, divergenceEvents, rsiFloorEvents, topDivEvents, tripleDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';
import { macdCross, momentumEvents, runTrade, type TradeExit } from './rsitrades';
import { luxDailyDemandTouched } from './sdzones';
import { specTrade, type ExitSpec } from './exits';
import { rsiPatterns } from './rsipatterns';
import { macdDivergence, macdState, type MacdState } from './macdstate';

const DAY = 86_400_000;

export type RsiModelId = 'bottom-div' | 'triple-div' | 'momentum' | 'under-floor' | 'w-bear-div' | 'w-top-div' | 'w-high-div' | 'd-top-div' | 'w-dbl-bottom' | 'w-reclaim' | 'd-fail-short' | '4h-fail-short' | '15m-rsi10';

/**
 * `test`: profit still doubtful, shown as a test model (owner 2026-10-04: "all models are test models but I don't want any
 * labeled like so unless they are controversial in terms of profit"). Rules describe the entry and the base stop; the exits (version A / B, each with its stop width) are in LIVE_EXITS.
 */
export const RSI_MODELS: Record<RsiModelId, { label: string; side: 'long' | 'short'; tf: '15m' | '4H' | 'daily' | 'weekly'; rule: string; test?: true; dropped?: true }> = {
  'bottom-div': { label: 'Daily bottom divergence', side: 'long', tf: 'daily', rule: 'RSI low <= 20, then a higher low <= 33 at a lower or equal price; enter next open; stop under the wick low' },
  'triple-div': { label: 'Daily triple divergence', side: 'long', tf: 'daily', rule: 'three rising RSI lows (first <= 27) while price holds its low; enter on the MACD cross-up; stop under the wick low' },
  momentum: { label: 'Daily momentum', side: 'long', tf: 'daily', dropped: true, rule: 'daily RSI closes above 75 while the weekly RSI is under 62; enter next open; stop under the 3-day low' },
  'under-floor': { label: '4H under-floor', side: 'long', tf: '4H', rule: '4H RSI breaks under the coin\'s own lowest RSI while the signal bar touches the LuxAlgo visible-range daily demand zone; stop under the 10-bar low' },
  'w-bear-div': { label: 'Weekly bearish divergence', side: 'short', tf: 'weekly', rule: 'weekly RSI 14 bearish divergence; enter next daily open; stop over the 10-day high' },
  'w-top-div': { label: 'Weekly top divergence', side: 'short', tf: 'weekly', rule: 'weekly RSI high >= 79, then a lower high >= 75 at a higher price; enter on a daily close under the 5-day low (within 20 days); stop over the high since the signal' },
  'w-high-div': { label: 'Weekly 70/63 divergence', side: 'short', tf: 'weekly', dropped: true, rule: 'weekly RSI high >= 70, then a lower high >= 63 at a higher price; enter on a daily close under the 5-day low (within 20 days); stop over the high since the signal' },
  'd-top-div': { label: 'Daily top divergence', side: 'short', tf: 'daily', dropped: true, rule: 'daily RSI high >= 79, then a lower high >= 75 at a higher price; enter next open; stop over the 10-day high' },
  'w-dbl-bottom': { label: 'Weekly double bottom', side: 'long', tf: 'weekly', rule: 'weekly RSI low <= 35, then a higher low <= 45 with price within 5% of the first low; enter next daily open; stop under the 20-day low' },
  'w-reclaim': { label: 'Weekly RSI reclaim', side: 'long', tf: 'weekly', dropped: true, rule: 'weekly RSI closes over 45 within 12 weeks of a weekly close <= 40; enter next daily open; stop under the 20-day low' },
  'd-fail-short': { label: 'Daily failure swing short', side: 'short', tf: 'daily', rule: 'daily RSI under 50; daily RSI over 70, pulls back, fails to make a new high, then closes under the pullback low (Wilder failure swing); enter next open; stop over the pullback high' },
  '4h-fail-short': { label: '4H failure swing short', side: 'short', tf: '4H', rule: 'daily RSI under 50; 4H RSI over 70, pulls back, fails to make a new high, then closes under the pullback low (Wilder failure swing); enter next open; stop over the pullback high' },
  // Owner 2026-10-06 (docs/RESULTS.md "15M-RSI10", round 8): added to the dashboard with live and signal switches (both off).
  '15m-rsi10': { label: '15M-RSI10 (order block)', side: 'long', tf: '15m', test: true, rule: 'within 12 days of a 4H RSI flush to 30 or below (days 0-3): lower price lows in phase 2 (days 2-5) and phase 3 (day 5 on), no 4H close under 30 after day 3, and the phase-3 4H RSI low in 30-35 with RSI turned up 2+ points from it; entry on a 15m close with 4H RSI 31-37, 1H 33-39, 15m 35-50, daily RSI over 37, and price touching a bullish 4H or daily order block; enter next 15m open; stop under the window low - 1 x 4H ATR' },
};

/**
 * Live exits (owner 2026-10-04): no time stops unless a timed exit tested best for the model ("if the timed exit was
 * the best for any models it should stay for that model, or be final tested alongside the same model that performs in
 * second place or close"). Two variants per model, both shown and final tested: [0] = the best (main), [1] = the best of
 * the other kind (timed vs untimed) when close or second. docs/RESULTS.md "Timed vs untimed exits".
 * The stop is the model's stop distance x stopMult from the entry; `cap` (in the model's bars) is the time exit.
 */
export interface LiveExit { stopMult: number; spec: ExitSpec }
export const LIVE_EXITS: Record<RsiModelId, [LiveExit, LiveExit]> = {
  // Pooled exit grid (owner 2026-10-04, docs/RESULTS.md "Pooled exit grid"): research + holdout coins, scored on the weaker
  // coin set; A = best score positive on both coin sets and both periods (<= 25% open); B = best of a different kind
  // (exit family or timed / untimed). Caps are in the model's bars (4H: 60 bars = 10 days).
  'bottom-div': [{ stopMult: 1, spec: { name: '20R target, no time stop', target: 20 } }, { stopMult: 1, spec: { name: '20R target, 270 days', target: 20, cap: 270 } }],
  'triple-div': [{ stopMult: 0.75, spec: { name: 'hold 90 days', cap: 90 } }, { stopMult: 0.75, spec: { name: '20R target, 90 days', target: 20, cap: 90 } }],
  'under-floor': [{ stopMult: 0.75, spec: { name: '5 ATR trail from +2R, 10 days', trail: { kind: 'atr', k: 5, arm: 2 }, cap: 60 } }, { stopMult: 0.75, spec: { name: '10R target, 10 days', target: 10, cap: 60 } }],
  'w-bear-div': [{ stopMult: 0.75, spec: { name: '3R target, 182 days', target: 3, cap: 182 } }, { stopMult: 0.75, spec: { name: '3R target, no time stop', target: 3 } }],
  'w-top-div': [{ stopMult: 0.75, spec: { name: '3R target, no time stop', target: 3 } }, { stopMult: 0.75, spec: { name: '3R target, 91 days', target: 3, cap: 91 } }],
  'w-dbl-bottom': [{ stopMult: 1, spec: { name: 'hold 91 days', cap: 91 } }, { stopMult: 1, spec: { name: '20R target, 91 days', target: 20, cap: 91 } }],
  // Downtrend short model (owner 2026-10-04, docs/RESULTS.md "Downtrend short model"): A = the fixed-rule pick
  // (stop 1x, 3R); B = the 3 ATR trail (daily) / the 2x stop with 2R (4H, about 55% wins on fresh coins). Caps in bars.
  'd-fail-short': [{ stopMult: 1, spec: { name: '3R target, 60 days', target: 3, cap: 60 } }, { stopMult: 1, spec: { name: '3 ATR trail from +1R, 60 days', trail: { kind: 'atr', k: 3, arm: 1 }, cap: 60 } }],
  '4h-fail-short': [{ stopMult: 1, spec: { name: '3R target, 15 days', target: 3, cap: 90 } }, { stopMult: 2, spec: { name: '2R target, 15 days', target: 2, cap: 90 } }],
  // 15M-RSI10 (round 8: positive in every research / fresh, older / newer cell with these two, 4H-ATR stop). No time stop.
  '15m-rsi10': [{ stopMult: 1, spec: { name: '10R target, no time stop', target: 10 } }, { stopMult: 1, spec: { name: '5R target, no time stop', target: 5 } }],
  // Dropped (owner 2026-10-04: no exit positive on both coin sets, or failed the fresh coins); kept so old reports still run.
  momentum: [{ stopMult: 0.75, spec: { name: 'hold 270 days', cap: 270 } }, { stopMult: 1, spec: { name: '20R target, no time stop', target: 20 } }],
  'w-high-div': [{ stopMult: 0.75, spec: { name: '4R target, no time stop', target: 4 } }, { stopMult: 0.75, spec: { name: '6R target, 182 days', target: 6, cap: 182 } }],
  'd-top-div': [{ stopMult: 1, spec: { name: '6R target, 120 days', target: 6, cap: 120 } }, { stopMult: 1, spec: { name: 'hold 120 days', cap: 120 } }],
  'w-reclaim': [{ stopMult: 1, spec: { name: '3 ATR trail from +1R, 91 days', trail: { kind: 'atr', k: 3, arm: 1 }, cap: 91 } }, { stopMult: 1, spec: { name: '3R target, 91 days', target: 3, cap: 91 } }],
};

/**
 * The exit version each model trades live: the worker's presets OPTIMAL_RSI_LIVE (2026-10-04) and bottom divergence A
 * (2026-10-08); 15M-RSI10 A. Models not listed use A (0). The dashboard can change it later; research reports use this.
 */
export const LIVE_VARIANT: Partial<Record<RsiModelId, 0 | 1>> = { 'bottom-div': 0, 'triple-div': 1 };

export interface RsiSignalRow {
  symbol: string;
  model: RsiModelId;
  /** 0 = the model's main exit, 1 = its alternative (both final tested); `exitName` describes it. */
  variant: 0 | 1;
  exitName: string;
  side: 'long' | 'short';
  /** When the setup was known (the close that confirmed it). */
  signalAt: number;
  /** waiting = setup seen, entry trigger not yet; enter = enter at the next open; open = the trade it describes is running; closed = finished. */
  status: 'waiting' | 'enter' | 'open' | 'closed';
  /** Entry price (for 'enter': the last close, an estimate of the next open). */
  entry: number | null;
  enteredAt: number | null;
  stop: number | null;
  target: number | null;
  /** The last close, and the trade's R there (marked if open, final if closed). */
  lastPrice: number;
  r: number | null;
  /** closed: stop / target / time / exit (an EMA close exit); waiting: until when the trigger is awaited; open: when a timed exit ends (null = no time stop). */
  exit: 'stop' | 'target' | 'time' | 'exit' | null;
  until: number | null;
  closedAt: number | null;
  stopPct: number | null;
  /** The rule sets this row belongs to (see RULE_PLANS). */
  plans: RulePlan[];
  /**
   * Daily MACD gap the trade's way (owner 2026-10-04, shown with each signal): (MACD - signal) / |MACD|, 12/26/9 on
   * the last daily bar closed before the entry (before now for a signal still waiting or about to enter). 0.08 = 8%.
   */
  macdGap?: number | null;
  /** Daily MACD state at the same bar (display only): pre-cross / just crossed / with, older / against, widening, with day counts. */
  macd?: { state: MacdState; shrinking: number; sinceCross: number | null } | null;
  /** Regular daily MACD divergence at the same bar (price vs MACD line over the last two pivots; display only). */
  macdDiv?: boolean;
  /** Zones that supported the entry, e.g. "order block 4H" (15M-RSI10). */
  support?: string[];
}

/** The gap the trade's way: (MACD - signal) / |MACD| x direction; null when MACD isn't formed or is exactly zero. */
export function macdGap(line: number | null, sig: number | null, d: 1 | -1): number | null {
  if (line == null || sig == null || line === 0) return null;
  return (d * (line - sig)) / Math.abs(line);
}

export interface Setup { model: RsiModelId; d: 1 | -1; known: number; c: ReadonlyArray<Candle>; atr: ReadonlyArray<number | null>; j: number | null; stop: number | null; cap: number; exit: TradeExit; waitUntil: number | null; bar: number; /** Zones that supported the entry (15M-RSI10), shown and sent with the signal. */ support?: string[] }

const lowBetween = (c: ReadonlyArray<Candle>, a: number, b: number) => { let lo = Infinity; for (let k = Math.max(0, a); k <= b; k++) lo = Math.min(lo, c[k]!.low); return lo; };
const highBetween = (c: ReadonlyArray<Candle>, a: number, b: number) => { let hi = -Infinity; for (let k = Math.max(0, a); k <= b; k++) hi = Math.max(hi, c[k]!.high); return hi; };

/** Daily-entry long setups: next open, or the MACD cross-up within 30 days (cancelled by a close under the wick low). */
function dailyLongs(model: RsiModelId, dd: ReadonlyArray<Candle>, atrD: ReadonlyArray<number | null>, events: WeeklyEvent[], opts: { entry: 'next' | 'macd'; stop: 'pattern' | 'swing3'; cap: number; exit: TradeExit }): Setup[] {
  const hist = opts.entry === 'macd' ? macdHistogram(dd.map((b) => b.close)) : [];
  const out: Setup[] = [];
  for (const e of events) {
    if (e.d !== 1 || atrD[e.i] == null) continue;
    if (opts.stop === 'pattern' && e.a == null) continue;
    const known = dd[e.i]!.openTime + DAY;
    let j: number | null = e.i + 1, trig = e.i, waitUntil: number | null = null;
    if (opts.entry === 'macd') {
      const wick = lowBetween(dd, e.a!, e.i);
      const x = macdCross(hist, e.i, e.i + 30, 1);
      let broke = false;
      for (let k = e.i + 1; k <= (x ?? Math.min(dd.length - 1, e.i + 30)); k++) if (dd[k]!.close < wick) { broke = true; break; }
      if (broke) continue;
      if (x == null) {
        if (e.i + 30 < dd.length) continue; // the wait ran out without a trigger
        j = null; waitUntil = dd[e.i]!.openTime + 31 * DAY;
      } else { trig = x; j = x + 1; }
    }
    const a = atrD[trig];
    if (a == null) continue;
    const stop = opts.stop === 'pattern' ? lowBetween(dd, e.a!, trig) - 0.5 * a : lowBetween(dd, trig - 2, trig) - 0.5 * a;
    out.push({ model, d: 1, known, c: dd, atr: atrD, j, stop: j == null ? null : stop, cap: opts.cap, exit: opts.exit, waitUntil, bar: DAY });
  }
  return out;
}

/** Weekly shorts on daily bars ('swing': next daily open, stop over the 10-day high; 'breakdown': see rsitrades.ts weeklyShortTrades). */
function weeklyShorts(model: RsiModelId, dd: ReadonlyArray<Candle>, atrD: ReadonlyArray<number | null>, w: ReadonlyArray<Candle>, events: WeeklyEvent[], mode: 'swing' | 'breakdown', exit: TradeExit): Setup[] {
  const out: Setup[] = [];
  for (const e of events) {
    if (e.d !== -1) continue;
    const known = w[e.i]!.openTime + 7 * DAY;
    const j0 = dd.findIndex((b) => b.openTime >= known);
    if (j0 < 0) { // the week closed with the last daily bar: entry at the next open
      const lastI = dd.length - 1, a = atrD[lastI];
      if (mode === 'swing' && a != null && dd[lastI]!.openTime + DAY === known) out.push({ model, d: -1, known, c: dd, atr: atrD, j: dd.length, stop: highBetween(dd, lastI - 9, lastI) + 0.5 * a, cap: 91, exit, waitUntil: null, bar: DAY });
      if (mode === 'breakdown' && dd[lastI]!.openTime + DAY === known) out.push({ model, d: -1, known, c: dd, atr: atrD, j: null, stop: null, cap: 91, exit, waitUntil: known + 20 * DAY, bar: DAY });
      continue;
    }
    if (j0 < 8) continue;
    if (mode === 'swing') {
      const a = atrD[j0 - 1];
      if (a == null) continue;
      out.push({ model, d: -1, known, c: dd, atr: atrD, j: j0, stop: highBetween(dd, j0 - 10, j0 - 1) + 0.5 * a, cap: 91, exit, waitUntil: null, bar: DAY });
      continue;
    }
    let hi = highBetween(dd, j0 - 7, j0 - 1), j: number | null = null, stop: number | null = null;
    const lastK = Math.min(dd.length - 1, j0 + 19);
    for (let k = j0; k <= lastK; k++) {
      hi = Math.max(hi, dd[k]!.high);
      const lo = lowBetween(dd, k - 5, k - 1), a = atrD[k];
      if (dd[k]!.close < lo && a != null) { j = k + 1; stop = hi + 0.5 * a; break; }
    }
    if (j == null && j0 + 19 < dd.length) continue; // no breakdown within 20 days
    out.push({ model, d: -1, known, c: dd, atr: atrD, j, stop, cap: 91, exit, waitUntil: j == null ? dd[j0]!.openTime + 20 * DAY : null, bar: DAY });
  }
  return out;
}

/** Weekly RSI reclaim: the first weekly close with RSI over `x` within `within` weeks of a weekly close <= `y`. */
export function weeklyReclaimEvents(rw: ReadonlyArray<number | null>, y = 40, x = 45, within = 12): WeeklyEvent[] {
  const out: WeeklyEvent[] = [];
  let lastUnder = -Infinity;
  for (let i = 1; i < rw.length; i++) {
    const v = rw[i], pv = rw[i - 1];
    if (v == null || pv == null) continue;
    if (pv <= y) lastUnder = i - 1;
    if (v > x && pv <= x && i - lastUnder <= within) out.push({ i, d: 1, kind: 'reclaim' });
  }
  return out;
}

/** Weekly longs on daily bars: next daily open after the week closes, stop under the last 20 days' low - 0.5 ATR. */
function weeklyLongs(model: RsiModelId, dd: ReadonlyArray<Candle>, atrD: ReadonlyArray<number | null>, w: ReadonlyArray<Candle>, events: WeeklyEvent[], cap: number, exit: TradeExit): Setup[] {
  const out: Setup[] = [];
  for (const e of events) {
    if (e.d !== 1) continue;
    const known = w[e.i]!.openTime + 7 * DAY;
    let j = dd.findIndex((b) => b.openTime >= known);
    if (j < 0) { if (dd[dd.length - 1]!.openTime + DAY !== known) continue; j = dd.length; } // the week closed with the last daily bar
    if (j < 21) continue;
    const a = atrD[j - 1];
    if (a == null) continue;
    out.push({ model, d: 1, known, c: dd, atr: atrD, j, stop: lowBetween(dd, j - 20, j - 1) - 0.5 * a, cap, exit, waitUntil: null, bar: DAY });
  }
  return out;
}

/** Every setup of the framework's seven models for one coin, in time order (daily-bar trades for the daily and weekly models, 4H for under-floor). */
export function frameworkSetups(d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>): Setup[] {
  const setups: Setup[] = [];
  if (d1.length >= 60) {
    const r14 = rsi(d1.map((b) => b.close), 14), atrD = atrWilder(d1, 14);
    const dd = [...d1];
    setups.push(...dailyLongs('bottom-div', dd, atrD, bottomDivEvents(dd, r14, 20, 33), { entry: 'next', stop: 'pattern', cap: 90, exit: '3R' }));
    setups.push(...dailyLongs('triple-div', dd, atrD, tripleDivEvents(dd, r14, 27), { entry: 'macd', stop: 'pattern', cap: 90, exit: 'trail' }));
    setups.push(...dailyLongs('momentum', dd, atrD, momentumEvents(dd, r14), { entry: 'next', stop: 'swing3', cap: 30, exit: 'hold' }));
    const w = weeklyFromDaily(d1);
    if (w.length >= 40) {
      const rw = rsi(w.map((b) => b.close), 14);
      setups.push(...weeklyShorts('w-bear-div', dd, atrD, w, divergenceEvents(w, rw, 5, 3, 5, 40), 'swing', '3R'));
      const tops = topDivEvents(w, rw, 79, 75);
      setups.push(...weeklyShorts('w-top-div', dd, atrD, w, tops, 'breakdown', 'hold'));
      setups.push(...weeklyShorts('w-high-div', dd, atrD, w, topDivEvents(w, rw, 70, 63, 'high-div').filter((e) => !tops.some((x) => x.i === e.i)), 'breakdown', '3R'));
      // Test models (owner 2026-10-04).
      setups.push(...weeklyLongs('w-dbl-bottom', dd, atrD, w, bottomDivEvents(w, rw, 35, 45, 'bottom-div', 0.05, 5, 3, 40), 91, 'trail'));
      setups.push(...weeklyLongs('w-reclaim', dd, atrD, w, weeklyReclaimEvents(rw), 91, 'trail'));
    }
    for (const e of topDivEvents(dd, r14, 79, 75)) { // test model: daily top divergence short
      const a = atrD[e.i];
      if (a == null) continue;
      setups.push({ model: 'd-top-div', d: -1, known: dd[e.i]!.openTime + DAY, c: dd, atr: atrD, j: e.i + 1, stop: highBetween(dd, e.i - 9, e.i) + 0.5 * a, cap: 60, exit: '3R', waitUntil: null, bar: DAY });
    }
  }
  // Downtrend short model: bearish failure swings (incl. the double-top form) while the daily RSI is under 50.
  const dR = d1.length >= 60 ? rsi(d1.map((b) => b.close), 14) : [];
  const dailyUnder50 = (t: number) => { let k = -1; for (let q = d1.length - 1; q >= 0; q--) if (d1[q]!.openTime + DAY <= t) { k = q; break; } return k >= 0 && dR[k] != null && dR[k]! < 50; };
  const failShorts = (model: RsiModelId, c: ReadonlyArray<Candle>, bar: number) => {
    const r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
    for (const e of rsiPatterns(c, r, atr)) {
      if (e.d !== -1 || (e.pat !== 'failure swing' && e.pat !== 'double bottom')) continue;
      const known = c[e.i]!.openTime + bar;
      if (!dailyUnder50(known)) continue;
      setups.push({ model, d: -1, known, c, atr, j: e.i + 1, stop: e.stop, cap: model === 'd-fail-short' ? 60 : 90, exit: '3R', waitUntil: null, bar });
    }
  };
  if (d1.length >= 60) failShorts('d-fail-short', [...d1], DAY);
  if (h4.length >= 300) failShorts('4h-fail-short', [...h4], 4 * 3_600_000);
  if (h4.length >= 300) {
    const c = [...h4], r14 = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14), H4 = 4 * 3_600_000;
    for (const e of rsiFloorEvents(r14).filter((x) => x.kind === 'under-floor')) {
      const a = atr[e.i];
      if (a == null) continue;
      // Owner 2026-10-03: only when the signal bar touches the LuxAlgo visible-range demand zone on the daily.
      if (!luxDailyDemandTouched(d1, c[e.i]!, c[e.i]!.openTime + H4)) continue;
      setups.push({ model: 'under-floor', d: 1, known: c[e.i]!.openTime + H4, c, atr, j: e.i + 1, stop: lowBetween(c, e.i - 9, e.i) - 0.5 * a, cap: 60, exit: 'hold', waitUntil: null, bar: H4 });
    }
  }

  return setups.sort((a, b) => a.known - b.known);
}

/**
 * Entry and exit rules from the loss post-mortem (owner 2026-10-04: "Option one and option 1 without exceptions could
 * be what we try"; docs/RESULTS.md "The two options, exactly as proposed"). Both rule sets run side by side:
 *  - BTC filter: shorts only while BTC's last closed daily is under its 50-day SMA (longs unchanged);
 *  - skip late: no entry more than 3 ATR from the 10-bar extreme the trade's way;
 *  - breakeven: stop to the entry once a close is 2R the trade's way.
 * 'option 1' leaves out breakeven for under-floor and skip late for the daily failure-swing short; 'no exceptions' applies all three to every model.
 */
export type RulePlan = 'option 1' | 'no exceptions';
export const RULE_PLANS: readonly RulePlan[] = ['option 1', 'no exceptions'];
export const LATE_ATR = 3, BE_R = 2, BTC_SMA = 50;
// 15M-RSI10 was tested without breakeven and without the late-entry skip, so option 1 leaves both out for it too.
export const planUsesBe = (plan: RulePlan, model: RsiModelId) => !(plan === 'option 1' && (model === 'under-floor' || model === '15m-rsi10'));
export const planSkipsLate = (plan: RulePlan, model: RsiModelId) => !(plan === 'option 1' && (model === 'd-fail-short' || model === '15m-rsi10'));

/** True when BTC's last daily closed by `t` is under its 50-day SMA; false when above or unknown (shorts then wait). */
export function btcBearishAt(btc: ReadonlyArray<Candle>, btcSma: ReadonlyArray<number | null>, t: number): boolean {
  let k = -1;
  for (let lo = 0, hi = btc.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (btc[m]!.openTime + DAY <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && btcSma[k] != null && btc[k]!.close < btcSma[k]!;
}

/** How far price had run the trade's way before entry index j, in ATR: from the 10-bar extreme to `entry`. */
export function runBeforeEntry(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, d: 1 | -1, entry: number): number {
  let ext = d > 0 ? Infinity : -Infinity;
  for (let q = Math.max(0, j - 10); q < j; q++) ext = d > 0 ? Math.min(ext, c[q]!.low) : Math.max(ext, c[q]!.high);
  const a = atr[j - 1] ?? null;
  return a ? (d * (entry - ext)) / a : NaN;
}

/**
 * Live RSI framework signals for one coin from closed daily and 4H candles. `now` = the time of the last close.
 * Rows: setups waiting for their trigger, trades to enter at the next open, open trades, and trades closed in the
 * last `keepDays` days. One trade per coin per model, exit variant and rule set at a time (a setup during an open trade
 * is skipped). `btcD1` = BTC's closed daily candles, for the BTC filter on shorts. A row the two rule sets share is
 * listed once, with both in `plans`.
 */
export function rsiFrameworkSignals(symbol: string, d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, now: number, keepDays = 14, btcD1: ReadonlyArray<Candle> = []): RsiSignalRow[] {
  return rowsFromSetups(symbol, frameworkSetups(d1, h4), d1, now, keepDays, btcD1);
}

/** Rows for any list of setups (both rule sets, merged), with the daily MACD fields; shared with the 15M-RSI10 model. */
export function rowsFromSetups(symbol: string, setups: Setup[], d1: ReadonlyArray<Candle>, now: number, keepDays = 14, btcD1: ReadonlyArray<Candle> = []): RsiSignalRow[] {
  const btcSma = sma(btcD1.map((b) => b.close), BTC_SMA);
  const merged = new Map<string, RsiSignalRow>();
  for (const plan of RULE_PLANS) for (const row of planRows(symbol, setups, now, keepDays, plan, btcD1, btcSma)) {
    const { plans: _p, ...rest } = row, key = JSON.stringify(rest);
    const had = merged.get(key);
    if (had) had.plans.push(plan); else merged.set(key, row);
  }
  const { line, sig } = macdLines(d1.map((b) => b.close));
  const hist = line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i]!));
  return [...merged.values()].map((r) => {
    const t = r.enteredAt ?? now;
    let k = -1;
    for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    const d = r.side === 'long' ? 1 : -1;
    const g = k < 0 ? null : macdGap(line[k] ?? null, sig[k] ?? null, d);
    return { ...r, macdGap: g == null ? null : Number(g.toFixed(4)), macd: k < 0 ? null : macdState(hist, k, d), macdDiv: k >= 0 && macdDivergence(d1, line, k, d) };
  });
}

function planRows(symbol: string, setups: Setup[], now: number, keepDays: number, plan: RulePlan, btcD1: ReadonlyArray<Candle>, btcSma: ReadonlyArray<number | null>): RsiSignalRow[] {
  const rows: RsiSignalRow[] = [];
  const busy = new Map<string, number>(); // model|variant -> time its last trade closed (or Infinity while open/waiting)
  for (const s of setups) for (const variant of [0, 1] as const) {
    if (RSI_MODELS[s.model].dropped) continue; // dropped after the pooled grid (owner 2026-10-04): no live signals
    const key = `${s.model}|${variant}`, lx0 = LIVE_EXITS[s.model][variant];
    if (s.known <= (busy.get(key) ?? -Infinity)) continue;
    const c = s.c, last = c[c.length - 1]!;
    if (s.j != null && s.stop != null) { // entry filters (a filtered setup is not shown and does not block the next one)
      const j = s.j, entryAt = j < c.length ? c[j]!.openTime : last.openTime + s.bar, entry = j < c.length ? c[j]!.open : last.close;
      if (s.d < 0 && !btcBearishAt(btcD1, btcSma, entryAt)) continue;
      if (planSkipsLate(plan, s.model) && runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR) continue;
    }
    const lx: LiveExit = planUsesBe(plan, s.model) ? { stopMult: lx0.stopMult, spec: { ...lx0.spec, name: `${lx0.spec.name}, breakeven at +${BE_R}R`, be: BE_R } } : lx0;
    const base = { symbol, model: s.model, variant, exitName: lx.spec.name, side: (s.d > 0 ? 'long' : 'short') as 'long' | 'short', signalAt: s.known, lastPrice: last.close, plans: [plan], ...(s.support ? { support: s.support } : {}) };
    if (s.j == null) { // waiting for the trigger
      if (s.waitUntil != null && s.waitUntil > now) {
        rows.push({ ...base, status: 'waiting', entry: null, enteredAt: null, stop: null, target: null, r: null, exit: null, until: s.waitUntil, closedAt: null, stopPct: null });
        busy.set(key, Infinity);
      }
      continue;
    }
    if (s.j >= c.length) { // enter at the next open (estimate: the last close)
      const entry = last.close, dist = s.d * (entry - s.stop!);
      if (!(dist > 0)) continue;
      const stop = entry - s.d * lx.stopMult * dist, risk = lx.stopMult * dist;
      rows.push({ ...base, status: 'enter', entry, enteredAt: null, stop, target: lx.spec.target != null ? entry + s.d * lx.spec.target * risk : null, r: null, exit: null, until: lx.spec.cap != null ? last.openTime + s.bar + lx.spec.cap * s.bar : null, closedAt: null, stopPct: (100 * risk) / entry });
      busy.set(key, Infinity);
      continue;
    }
    const entry0 = c[s.j]!.open;
    const t = specTrade(c, s.atr, {}, s.j, entry0 - lx.stopMult * (entry0 - s.stop!), s.d, lx.spec);
    if (!t) continue;
    const closedAt = t.open ? null : c[t.end]!.openTime + s.bar;
    busy.set(key, closedAt ?? Infinity);
    if (closedAt != null && closedAt < now - keepDays * DAY) continue;
    rows.push({
      ...base, status: t.open ? 'open' : 'closed', entry: t.entry, enteredAt: c[s.j]!.openTime, stop: t.stop, target: t.target,
      r: Number(t.r.toFixed(2)), exit: t.open || t.how === 'open' ? null : t.how, until: t.open && lx.spec.cap != null ? c[s.j]!.openTime + lx.spec.cap * s.bar : null, closedAt, stopPct: Number(t.stopPct.toFixed(1)),
    });
  }
  return rows;
}
