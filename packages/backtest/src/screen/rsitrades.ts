// RSI framework signals run as trades (owner 2026-10-03: "run them as trades and drop the buy flip").
// Rules fixed before the run:
// - entry at the open of the bar after the signal bar; one open trade per coin per signal;
// - stop beyond the swing: longs under the lowest low of the last 10 bars - 0.5 ATR, shorts over the highest high
//   + 0.5 ATR; a gap through the stop fills at the open;
// - exits: 'hold' = time cap with the stop; '3R' = 3R target + stop + time cap (stop first when both touch in a bar);
//   'trail' = after +1R (on a close), trail 3 ATR behind the best close, + time cap;
// - costs 0.22% of entry per round trip (fees + slippage), charged in R; funding not modelled.
import type { Candle } from '@bot/marketdata';
import { readRrg, resolveConfig } from '@bot/signals';
import { luxDailyDemandTouched } from './sdzones';
import { atrWilder, macdHistogram, rsi } from '../indicators';
import { prismRsi } from './prismrsi';
import { bottomDivEvents, divergenceEvents, prismFlipEvents, rsiFloorEvents, supportEvents, topDivEvents, tripleDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';

export type TradeExit = 'hold' | '3R' | 'trail';
export interface SignalTrade { sym: string; t: number; r: number; stopPct: number; bars: number }

export function simulateSignal(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, i: number, d: 1 | -1, cap: number, exit: TradeExit, cost = 0.0022): { r: number; stopPct: number; bars: number; end: number } | null {
  const a = atr[i];
  if (a == null || i + 1 >= c.length) return null;
  let ext = d > 0 ? Infinity : -Infinity;
  for (let k = Math.max(0, i - 9); k <= i; k++) ext = d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
  return simulateFrom(c, atr, i + 1, ext - d * 0.5 * a, d, cap, exit, cost);
}

/** One trade entered at the open of bar `j` with the given stop; exits as in the header. Null unless the time cap is inside the data. */
export function simulateFrom(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, cap: number, exit: TradeExit, cost = 0.0022): { r: number; stopPct: number; bars: number; end: number } | null {
  if (j + cap - 1 >= c.length) return null;
  const t = runTrade(c, atr, j, stop0, d, cap, exit, cost);
  return t && { r: t.r, stopPct: t.stopPct, bars: t.bars, end: t.end };
}

export interface TradeState {
  /** Result in R after costs: final if closed, marked at the last close if still open. */
  r: number; stopPct: number; bars: number; end: number;
  status: 'open' | 'stop' | 'target' | 'time';
  entry: number; stop: number; target: number | null;
}

/**
 * The same trade as simulateFrom, run as far as the data goes: closed (stop, 3R target or time cap) or still open,
 * with the current stop (it trails for 'trail'). Used for the dashboard's live RSI signals.
 */
export function runTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, cap: number, exit: TradeExit, cost = 0.0022, targetPx?: number): TradeState | null {
  if (j >= c.length) return null;
  const last = j + cap - 1, stopLast = Math.min(last, c.length - 1);
  const entry = c[j]!.open;
  let stop = stop0;
  const risk = d * (entry - stop);
  if (!(risk > 0)) return null;
  // targetPx (zone tests): a fixed target replacing the 3R one, on any exit mode.
  const target = targetPx ?? entry + d * 3 * risk, useTarget = targetPx != null || exit === '3R';
  let best = entry, armed = false, px = c[stopLast]!.close, end = stopLast;
  let status: TradeState['status'] = stopLast === last ? 'time' : 'open';
  for (let k = j; k <= stopLast; k++) {
    const b = c[k]!;
    if (d * (b.open - stop) <= 0) { px = b.open; end = k; status = 'stop'; break; } // gapped through the stop
    if (d > 0 ? b.low <= stop : b.high >= stop) { px = stop; end = k; status = 'stop'; break; }
    if (useTarget && (d > 0 ? b.high >= target : b.low <= target)) { px = target; end = k; status = 'target'; break; }
    if (exit === 'trail') {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - entry) >= risk) armed = true;
      const ak = atr[k];
      if (armed && ak != null) { const tr = best - d * 3 * ak; if (d * (tr - stop) > 0) stop = tr; }
    }
  }
  return { r: (d * (px - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: end - j + 1, end, status, entry, stop, target: useTarget ? target : null };
}

/** Long entered at the next open with the stop under the pattern's lowest low (first pivot .. signal bar) - 0.5 ATR. */
export function patternStopTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, e: WeeklyEvent, cap: number, exit: TradeExit) {
  const a = atr[e.i];
  if (e.a == null || a == null || e.i + 1 >= c.length) return null;
  let lo = Infinity;
  for (let k = e.a; k <= e.i; k++) lo = Math.min(lo, c[k]!.low);
  return simulateFrom(c, atr, e.i + 1, lo - 0.5 * a, 1, cap, exit);
}

/** Tighter stops: 'atr2' = entry -/+ 2 ATR; 'swing3' = beyond the last 3 bars' extreme -/+ 0.5 ATR. */
export function tightStopTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, i: number, d: 1 | -1, mode: 'atr2' | 'swing3', cap: number, exit: TradeExit) {
  const a = atr[i];
  if (a == null || i + 1 >= c.length) return null;
  let stop: number;
  if (mode === 'atr2') stop = c[i + 1]!.open - d * 2 * a;
  else {
    let ext = d > 0 ? Infinity : -Infinity;
    for (let k = Math.max(0, i - 2); k <= i; k++) ext = d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
    stop = ext - d * 0.5 * a;
  }
  return simulateFrom(c, atr, i + 1, stop, d, cap, exit);
}

type Sig = { key: string; tf: '1w' | '1d' | '4h'; cap: number; d: 1 | -1; stop?: 'pattern' | 'atr2' | 'swing3'; find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[] };
export const TRADE_SIGNALS: Sig[] = [
  { key: 'W diamond (Prism exhaustion) short', tf: '1w', cap: 13, d: -1, find: (c) => { const p = prismRsi(c.map((b) => b.close)); return prismFlipEvents(p).filter((e) => e.kind === 'exhaustion' && e.d === -1); } },
  { key: 'W top divergence 82/75 short', tf: '1w', cap: 13, d: -1, find: (c, r) => topDivEvents(c, r) },
  { key: 'W high divergence 70/60 short', tf: '1w', cap: 13, d: -1, find: (c, r) => { const t = topDivEvents(c, r); return topDivEvents(c, r, 70, 60, 'high-div').filter((e) => !t.some((x) => x.i === e.i)); } },
  { key: 'W RSI 14 bearish divergence short', tf: '1w', cap: 13, d: -1, find: (c, r) => divergenceEvents(c, r, 5, 3, 5, 40).filter((e) => e.d === -1) },
  { key: 'D bottom divergence 20/30 long', tf: '1d', cap: 60, d: 1, find: (c, r) => bottomDivEvents(c, r) },
  // Long side (owner 2026-10-03: "yes run those as trades"); rules fixed before the run.
  { key: '4H RSI floor long (10 days)', tf: '4h', cap: 60, d: 1, find: (_c, r) => rsiFloorEvents(r).filter((e) => e.kind === 'floor') },
  { key: '4H under-floor long (10 days)', tf: '4h', cap: 60, d: 1, find: (_c, r) => rsiFloorEvents(r).filter((e) => e.kind === 'under-floor') },
  { key: 'D RSI floor long (20 days)', tf: '1d', cap: 20, d: 1, find: (_c, r) => rsiFloorEvents(r).filter((e) => e.kind === 'floor' || e.kind === 'under-floor') },
  { key: 'D reclaim divergence long (90 days)', tf: '1d', cap: 90, d: 1, find: (c, r) => supportEvents(c, r).filter((e) => e.kind === 'reclaim-div') },
  { key: 'D triple divergence long (60 days)', tf: '1d', cap: 60, d: 1, find: (c, r) => tripleDivEvents(c, r) },
  // Owner 2026-10-03: stop under the pattern's own low (lowest low from the first pivot to the signal - 0.5 ATR).
  { key: 'D triple div, pattern-low stop (60d)', tf: '1d', cap: 60, d: 1, stop: 'pattern', find: (c, r) => tripleDivEvents(c, r) },
  { key: 'D triple div, pattern-low stop (90d)', tf: '1d', cap: 90, d: 1, stop: 'pattern', find: (c, r) => tripleDivEvents(c, r) },
  { key: 'D bottom div, pattern-low stop (60d)', tf: '1d', cap: 60, d: 1, stop: 'pattern', find: (c, r) => bottomDivEvents(c, r) },
  { key: 'D bottom div, pattern-low stop (90d)', tf: '1d', cap: 90, d: 1, stop: 'pattern', find: (c, r) => bottomDivEvents(c, r) },
  { key: 'D momentum RSI>75, W<62 long (30d)', tf: '1d', cap: 30, d: 1, find: (c, r) => momentumEvents(c, r) },
  // Owner 2026-10-03: the momentum long with a tighter daily stop (fixed before the run).
  { key: 'D momentum, stop 2 ATR (30d)', tf: '1d', cap: 30, d: 1, stop: 'atr2', find: (c, r) => momentumEvents(c, r) },
  { key: 'D momentum, stop 3-day low (30d)', tf: '1d', cap: 30, d: 1, stop: 'swing3', find: (c, r) => momentumEvents(c, r) },
];

/**
 * Momentum long: the first daily close with RSI 14 above 75 (the day before <= 75) while the last COMPLETED week's
 * RSI 14 is under 62 (no look-ahead: the current week is not used).
 */
export function momentumEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, hi = 75, wMax = 62): WeeklyEvent[] {
  const w = weeklyFromDaily(c), rw = rsi(w.map((b) => b.close), 14), WEEK = 7 * 86_400_000, out: WeeklyEvent[] = [];
  let k = -1;
  for (let i = 1; i < c.length; i++) {
    while (k + 1 < w.length && w[k + 1]!.openTime + WEEK <= c[i]!.openTime + 86_400_000) k++; // weeks closed by day i's close
    const v = r[i], pv = r[i - 1], wv = k >= 0 ? rw[k] : null;
    if (v != null && pv != null && wv != null && v > hi && pv <= hi && wv < wMax) out.push({ i, d: 1, kind: 'flip' });
  }
  return out;
}

export function signalTradeReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number,
): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `RSI SIGNALS AS TRADES: ${day(from)} to ${day(to)}, ${symbols.length} coins. Entry next bar open; stop beyond the 10-bar swing +/- 0.5 ATR;`,
    'costs 0.22% round trip; one open trade per coin per signal. Exits: hold = time cap (per signal; weekly 13 weeks) with the stop; 3R = target 3R;',
    `trail = after +1R trail 3 ATR behind the best close. R = result in units of the stop distance. Older / newer = before / after ${day(cut)}.`,
    '  signal                                exit    n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const lists: { key: string; exit: TradeExit; trades: SignalTrade[] }[] = [];
  for (const s of TRADE_SIGNALS) for (const exit of ['hold', '3R', 'trail'] as TradeExit[]) {
    const trades: SignalTrade[] = [];
    for (const sym of symbols) {
      const d1 = data[sym]?.candles['1d'] ?? [];
      const c = s.tf === '1w' ? weeklyFromDaily(d1) : [...(data[sym]?.candles[s.tf] ?? [])];
      if (c.length < 40) continue;
      const r14 = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
      let busy = -1;
      for (const e of s.find(c, r14)) {
        if (e.d !== s.d || e.i <= busy) continue;
        const j = e.i + 1;
        if (j >= c.length || c[j]!.openTime < from || c[j]!.openTime > to) continue;
        const res = s.stop === 'pattern' ? patternStopTrade(c, atr, e, s.cap, exit) : s.stop ? tightStopTrade(c, atr, e.i, s.d, s.stop, s.cap, exit) : simulateSignal(c, atr, e.i, s.d, s.cap, exit);
        if (!res || c[res.end]!.openTime + (s.tf === '1w' ? 7 * 86_400_000 : s.tf === '1d' ? 86_400_000 : 4 * 3_600_000) > to) continue;
        trades.push({ sym, t: c[j]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
        busy = res.end;
      }
    }
    lists.push({ key: s.key, exit, trades });
  }
  const f = (x: number, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '-');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const { key, exit, trades } of lists) {
    const rs = trades.map((t) => t.r), wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
    const sorted = [...rs].sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
    const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0) : Infinity;
    let eq = 0, peak = 0, dd = 0;
    for (const t of [...trades].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const old = trades.filter((t) => t.t < cut).map((t) => t.r), neu = trades.filter((t) => t.t >= cut).map((t) => t.r);
    out.push(`  ${key.padEnd(37)} ${exit.padEnd(5)} ${String(rs.length).padStart(4)}  ${f((100 * wins.length) / rs.length, 0).padStart(4)}%  ${f(avg(rs)).padStart(6)}  ${f(med).padStart(7)}  ${f(pf).padStart(6)}  ${f(rs.reduce((a, b) => a + b, 0), 1).padStart(7)}  ${f(dd, 1).padStart(7)}   ${f(avg(trades.map((t) => t.stopPct)), 1).padStart(5)}%  ${f(avg(trades.map((t) => t.bars)), 0).padStart(4)}   ${f(avg(old))} (${old.length}) / ${f(avg(neu))} (${neu.length})`);
  }
  return out;
}

/**
 * Owner 2026-10-03: the weekly shorts with a tighter daily stop. The weekly signal is known when its week closes;
 * 'daily swing' = enter at the next daily open, stop over the 10-day high + 0.5 daily ATR; 'daily breakdown' = within
 * 20 days wait for a daily close under the prior 5-day low, enter at the next open, stop over the highest high since
 * the signal + 0.5 daily ATR (no trade if it never comes). Time cap 91 days; exits hold / 3R / trail on daily bars.
 */
export function weeklyDailyStopReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number,
): string[] {
  const DAY = 86_400_000, day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `WEEKLY SHORTS WITH A DAILY STOP: ${day(from)} to ${day(to)}, ${symbols.length} coins. Time cap 91 days; costs 0.22%; one open trade per coin per signal.`,
    'daily swing = enter next daily open, stop over the 10-day high + 0.5 ATR; daily breakdown = wait <= 20 days for a close under the prior 5-day low,',
    `stop over the high since the signal + 0.5 ATR. Older / newer = before / after ${day(cut)}.`,
    '  signal                                entry            exit    n   win%   avg R  median R    PF   total R  max DD R   stop %  days   avg R older / newer   avg % per trade',
  ];
  const f = (x: number, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '-');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  for (const s of TRADE_SIGNALS.filter((x) => x.tf === '1w' && !x.key.includes('diamond'))) {
    for (const mode of ['daily swing', 'daily breakdown'] as const) for (const exit of ['hold', '3R', 'trail'] as TradeExit[]) {
      const trades: (SignalTrade & { pct: number })[] = [];
      for (const sym of symbols) {
        const dd = data[sym]?.candles['1d'] ?? [];
        const w = weeklyFromDaily(dd);
        if (w.length < 40) continue;
        const r14 = rsi(w.map((b) => b.close), 14), atrD = atrWilder(dd, 14);
        let busy = -Infinity;
        for (const e of s.find(w, r14)) {
          if (e.d !== -1) continue;
          const known = w[e.i]!.openTime + 7 * DAY; // the signal week has closed
          if (known <= busy || known < from || known > to) continue;
          const j0 = dd.findIndex((b) => b.openTime >= known);
          if (j0 < 1) continue;
          let j = j0, stop: number | null = null;
          if (mode === 'daily swing') {
            const a = atrD[j0 - 1];
            if (a == null) continue;
            let hi = -Infinity;
            for (let k = Math.max(0, j0 - 10); k < j0; k++) hi = Math.max(hi, dd[k]!.high);
            stop = hi + 0.5 * a;
          } else {
            let hi = -Infinity;
            for (let k = Math.max(0, j0 - 7); k < j0; k++) hi = Math.max(hi, dd[k]!.high); // the signal week's high
            for (let k = j0; k < Math.min(dd.length - 1, j0 + 20); k++) {
              hi = Math.max(hi, dd[k]!.high);
              let lo = Infinity;
              for (let q = Math.max(0, k - 5); q < k; q++) lo = Math.min(lo, dd[q]!.low);
              const a = atrD[k];
              if (dd[k]!.close < lo && a != null) { j = k + 1; stop = hi + 0.5 * a; break; }
            }
          }
          if (stop == null) continue;
          const res = simulateFrom(dd, atrD, j, stop, -1, 91, exit);
          if (!res || dd[res.end]!.openTime + DAY > to) continue;
          trades.push({ sym, t: dd[j]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars, pct: res.r * res.stopPct }); // % of price, after costs
          busy = dd[res.end]!.openTime;
        }
      }
      const rs = trades.map((t) => t.r), wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
      const sorted = [...rs].sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
      const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0) : Infinity;
      let eq = 0, peak = 0, ddR = 0;
      for (const t of [...trades].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); ddR = Math.max(ddR, peak - eq); }
      const old = trades.filter((t) => t.t < cut).map((t) => t.r), neu = trades.filter((t) => t.t >= cut).map((t) => t.r);
      out.push(`  ${s.key.padEnd(37)} ${mode.padEnd(16)} ${exit.padEnd(5)} ${String(rs.length).padStart(4)}  ${f((100 * wins.length) / rs.length, 0).padStart(4)}%  ${f(avg(rs)).padStart(6)}  ${f(med).padStart(7)}  ${f(pf).padStart(6)}  ${f(rs.reduce((a, b) => a + b, 0), 1).padStart(7)}  ${f(ddR, 1).padStart(7)}   ${f(avg(trades.map((t) => t.stopPct)), 1).padStart(5)}%  ${f(avg(trades.map((t) => t.bars)), 0).padStart(4)}   ${f(avg(old))} (${old.length}) / ${f(avg(neu))} (${neu.length})   ${f(avg(trades.map((t) => t.pct)), 1)}%`);
    }
  }
  return out;
}

/** First bar in [from, to] where the MACD histogram crosses through zero in direction d (from <= 0 to > 0 for longs). */
export function macdCross(hist: ReadonlyArray<number | null>, from: number, to: number, d: 1 | -1): number | null {
  for (let j = Math.max(1, from); j <= Math.min(to, hist.length - 1); j++) {
    const a = hist[j - 1], b = hist[j];
    if (a != null && b != null && d * a <= 0 && d * b > 0) return j;
  }
  return null;
}

export function statsLine(label: string, trades: SignalTrade[], cut: number): string {
  const f = (x: number, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '-');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const rs = trades.map((t) => t.r), wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const sorted = [...rs].sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
  const pf = losses.length ? wins.reduce((a, b) => a + b, 0) / -losses.reduce((a, b) => a + b, 0) : Infinity;
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const old = trades.filter((t) => t.t < cut).map((t) => t.r), neu = trades.filter((t) => t.t >= cut).map((t) => t.r);
  return `  ${label}  ${String(rs.length).padStart(4)}  ${f((100 * wins.length) / rs.length, 0).padStart(4)}%  ${f(avg(rs)).padStart(6)}  ${f(med).padStart(7)}  ${f(pf).padStart(6)}  ${f(rs.reduce((a, b) => a + b, 0), 1).padStart(7)}  ${f(dd, 1).padStart(7)}   ${f(avg(trades.map((t) => t.stopPct)), 1).padStart(5)}%  ${f(avg(trades.map((t) => t.bars)), 0).padStart(4)}   ${f(avg(old))} (${old.length}) / ${f(avg(neu))} (${neu.length})`;
}

/**
 * Owner 2026-10-03: MACD (12/26/9) as the entry trigger for the slow divergences. Rules fixed before the run:
 * - longs (daily bottom / triple divergence): after the signal, wait up to 30 days for the daily MACD histogram to
 *   cross above zero; cancelled if a daily close falls under the pattern's wick low first; enter next open; stop under
 *   the wick low (first pivot .. trigger) - 0.5 ATR; cap 90 days.
 * - weekly shorts: after the weekly close, wait up to 20 days for the daily histogram to cross below zero; enter next
 *   open; stop over the highest high since the signal week began + 0.5 ATR; cap 91 days.
 * Each line is compared with the same signal entered without the trigger (the current entries).
 */
export function macdTriggerReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number,
): string[] {
  const DAY = 86_400_000, day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `MACD TRIGGER: ${day(from)} to ${day(to)}, ${symbols.length} coins. Costs 0.22%; one open trade per coin per line. Older / newer = before / after ${day(cut)}.`,
    '  signal / entry                                            exit     n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  type Line = { label: string; d: 1 | -1; weekly: boolean; find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[]; macd: boolean };
  const lines: Line[] = [
    { label: 'D bottom div 20/30, enter next open (now)', d: 1, weekly: false, macd: false, find: (c, r) => bottomDivEvents(c, r) },
    { label: 'D bottom div 20/30, MACD cross-up trigger', d: 1, weekly: false, macd: true, find: (c, r) => bottomDivEvents(c, r) },
    { label: 'D triple div, enter next open (now)', d: 1, weekly: false, macd: false, find: (c, r) => tripleDivEvents(c, r) },
    { label: 'D triple div, MACD cross-up trigger', d: 1, weekly: false, macd: true, find: (c, r) => tripleDivEvents(c, r) },
    ...TRADE_SIGNALS.filter((x) => x.tf === '1w' && !x.key.includes('diamond')).flatMap((x) => [
      { label: `${x.key}, MACD cross-down trigger`, d: -1 as const, weekly: true, macd: true, find: x.find },
    ]),
  ];
  for (const L of lines) for (const exit of ['hold', '3R', 'trail'] as TradeExit[]) {
    const trades: SignalTrade[] = [];
    for (const sym of symbols) {
      const dd = data[sym]?.candles['1d'] ?? [];
      if (dd.length < 60) continue;
      const atrD = atrWilder(dd, 14), hist = macdHistogram(dd.map((b) => b.close));
      let busy = -Infinity;
      if (L.weekly) {
        const w = weeklyFromDaily(dd), rw = rsi(w.map((b) => b.close), 14);
        for (const e of L.find(w, rw)) {
          if (e.d !== -1) continue;
          const known = w[e.i]!.openTime + 7 * DAY;
          if (known <= busy || known < from || known > to) continue;
          const j0 = dd.findIndex((b) => b.openTime >= known);
          if (j0 < 8) continue;
          const j = macdCross(hist, j0, j0 + 19, -1);
          if (j == null || j + 1 >= dd.length || atrD[j] == null) continue;
          let hi = -Infinity;
          for (let k = j0 - 7; k <= j; k++) hi = Math.max(hi, dd[k]!.high);
          const res = simulateFrom(dd, atrD, j + 1, hi + 0.5 * atrD[j]!, -1, 91, exit);
          if (!res || dd[res.end]!.openTime + DAY > to) continue;
          trades.push({ sym, t: dd[j + 1]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
          busy = dd[res.end]!.openTime;
        }
      } else {
        const r14 = rsi(dd.map((b) => b.close), 14);
        let busyI = -1;
        for (const e of L.find([...dd], r14)) {
          if (e.i <= busyI || e.a == null) continue;
          let j = e.i;
          if (L.macd) {
            let lo = Infinity;
            for (let k = e.a; k <= e.i; k++) lo = Math.min(lo, dd[k]!.low);
            const x = macdCross(hist, e.i, e.i + 30, 1);
            if (x == null) continue;
            let broke = false;
            for (let k = e.i + 1; k <= x; k++) if (dd[k]!.close < lo) { broke = true; break; }
            if (broke) continue;
            j = x;
          }
          if (j + 1 >= dd.length || dd[j + 1]!.openTime < from || dd[j + 1]!.openTime > to || atrD[j] == null) continue;
          let lo = Infinity;
          for (let k = e.a; k <= j; k++) lo = Math.min(lo, dd[k]!.low);
          const res = simulateFrom(dd, atrD, j + 1, lo - 0.5 * atrD[j]!, 1, 90, exit);
          if (!res || dd[res.end]!.openTime + DAY > to) continue;
          trades.push({ sym, t: dd[j + 1]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
          busyI = res.end;
        }
      }
    }
    out.push(statsLine(`${L.label.padEnd(56)} ${exit.padEnd(5)}`, trades, cut));
  }
  return out;
}

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;

/** Weekly short on daily bars: 'swing' = next daily open, stop over the 10-day high; 'breakdown' = see weeklyDailyStopReport. */
export function weeklyShortTrades(sym: string, dd: ReadonlyArray<Candle>, find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[], mode: 'swing' | 'breakdown', exit: TradeExit, from: number, to: number): SignalTrade[] {
  const DAY = 86_400_000, w = weeklyFromDaily(dd), out: SignalTrade[] = [];
  if (w.length < 40) return out;
  const r14 = rsi(w.map((b) => b.close), 14), atrD = atrWilder(dd, 14);
  let busy = -Infinity;
  for (const e of find(w, r14)) {
    if (e.d !== -1) continue;
    const known = w[e.i]!.openTime + 7 * DAY;
    if (known <= busy || known < from || known > to) continue;
    const j0 = dd.findIndex((b) => b.openTime >= known);
    if (j0 < 8) continue;
    let j = j0, stop: number | null = null;
    if (mode === 'swing') {
      const a = atrD[j0 - 1];
      if (a == null) continue;
      let hi = -Infinity;
      for (let k = j0 - 10; k < j0; k++) if (k >= 0) hi = Math.max(hi, dd[k]!.high);
      stop = hi + 0.5 * a;
    } else {
      let hi = -Infinity;
      for (let k = j0 - 7; k < j0; k++) hi = Math.max(hi, dd[k]!.high);
      for (let k = j0; k < Math.min(dd.length - 1, j0 + 20); k++) {
        hi = Math.max(hi, dd[k]!.high);
        let lo = Infinity;
        for (let q = Math.max(0, k - 5); q < k; q++) lo = Math.min(lo, dd[q]!.low);
        const a = atrD[k];
        if (dd[k]!.close < lo && a != null) { j = k + 1; stop = hi + 0.5 * a; break; }
      }
    }
    if (stop == null) continue;
    const res = simulateFrom(dd, atrD, j, stop, -1, 91, exit);
    if (!res || dd[res.end]!.openTime + DAY > to) continue;
    out.push({ sym, t: dd[j]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
    busy = dd[res.end]!.openTime;
  }
  return out;
}

/** Daily long: entry 'next' (next open) or 'macd' (MACD cross-up within 30 days, cancelled under the wick low); stop 'pattern' or 'swing3'. */
export function dailyLongTrades(sym: string, dd: ReadonlyArray<Candle>, find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[], entry: 'next' | 'macd', stopMode: 'pattern' | 'swing3', cap: number, exit: TradeExit, from: number, to: number): SignalTrade[] {
  const DAY = 86_400_000, out: SignalTrade[] = [];
  if (dd.length < 60) return out;
  const r14 = rsi(dd.map((b) => b.close), 14), atrD = atrWilder(dd, 14), hist = entry === 'macd' ? macdHistogram(dd.map((b) => b.close)) : [];
  let busy = -1;
  for (const e of find([...dd], r14)) {
    if (e.d !== 1 || e.i <= busy) continue;
    if (stopMode === 'pattern' && e.a == null) continue;
    let j = e.i;
    if (entry === 'macd') {
      let lo = Infinity;
      for (let k = e.a!; k <= e.i; k++) lo = Math.min(lo, dd[k]!.low);
      const x = macdCross(hist, e.i, e.i + 30, 1);
      if (x == null) continue;
      let broke = false;
      for (let k = e.i + 1; k <= x; k++) if (dd[k]!.close < lo) { broke = true; break; }
      if (broke) continue;
      j = x;
    }
    if (j + 1 >= dd.length || dd[j + 1]!.openTime < from || dd[j + 1]!.openTime > to || atrD[j] == null) continue;
    let res;
    if (stopMode === 'swing3') res = tightStopTrade(dd, atrD, j, 1, 'swing3', cap, exit);
    else {
      let lo = Infinity;
      for (let k = e.a!; k <= j; k++) lo = Math.min(lo, dd[k]!.low);
      res = simulateFrom(dd, atrD, j + 1, lo - 0.5 * atrD[j]!, 1, cap, exit);
    }
    if (!res || dd[res.end]!.openTime + DAY > to) continue;
    out.push({ sym, t: dd[j + 1]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
    busy = res.end;
  }
  return out;
}

/**
 * Owner 2026-10-03: every RSI threshold of the framework's models moved -3 / 0 / +3 (each threshold separately, all
 * combinations), with each model's chosen entry, stop and exit. A robustness check: the chosen setting is marked '*';
 * a model is robust if its neighbours stay positive in both periods.
 */
export function rsiGridReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `RSI THRESHOLD GRID (+/- 3): ${day(from)} to ${day(to)}, ${symbols.length} coins; * = the chosen setting. Older / newer = before / after ${day(cut)}.`,
    '  model / thresholds                                         exit     n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const run = (label: string, f: (sym: string, dd: ReadonlyArray<Candle>) => SignalTrade[]) => {
    const trades: SignalTrade[] = [];
    for (const sym of symbols) trades.push(...f(sym, data[sym]?.candles['1d'] ?? []));
    out.push(statsLine(label.padEnd(64), trades, cut));
  };
  const D = [-3, 0, 3];
  for (const exit of ['hold', '3R'] as TradeExit[]) for (const a of D) for (const b of D)
    run(`D bottom div <=${20 + a} then <=${30 + b}, 90d${a === 0 && b === 0 ? ' *' : ''}  ${exit}`, (sym, dd) => dailyLongTrades(sym, dd, (c, r) => bottomDivEvents(c, r, 20 + a, 30 + b), 'next', 'pattern', 90, exit, from, to));
  for (const a of D)
    run(`D triple div first <=${30 + a}, MACD entry${a === 0 ? ' *' : ''}  trail`, (sym, dd) => dailyLongTrades(sym, dd, (c, r) => tripleDivEvents(c, r, 30 + a), 'macd', 'pattern', 90, 'trail', from, to));
  for (const a of D) for (const b of D)
    run(`D momentum RSI >${75 + a}, weekly <${62 + b}, 3-day stop${a === 0 && b === 0 ? ' *' : ''}  hold`, (sym, dd) => dailyLongTrades(sym, dd, (c, r) => momentumEvents(c, r, 75 + a, 62 + b), 'next', 'swing3', 30, 'hold', from, to));
  for (const a of D) for (const b of D)
    run(`W top div >=${82 + a} then >=${75 + b}, breakdown${a === 0 && b === 0 ? ' *' : ''}  hold`, (sym, dd) => weeklyShortTrades(sym, dd, (c, r) => topDivEvents(c, r, 82 + a, 75 + b), 'breakdown', 'hold', from, to));
  for (const a of D) for (const b of D)
    run(`W high div >=${70 + a} then >=${60 + b}, breakdown${a === 0 && b === 0 ? ' *' : ''}  3R`, (sym, dd) => weeklyShortTrades(sym, dd, (c, r) => { const t = topDivEvents(c, r); return topDivEvents(c, r, 70 + a, 60 + b, 'high-div').filter((e) => !t.some((x) => x.i === e.i)); }, 'breakdown', '3R', from, to));
  return out;
}

/** The framework's models with their final settings (see frameworkReport). */
export function frameworkModels(data: Data, from: number, to: number): { label: string; f: (sym: string) => SignalTrade[] }[] {
  return [
    { label: 'LONG  D bottom div <=20 / <=33, 90d, 3R', f: (sym) => dailyLongTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => bottomDivEvents(c, r, 20, 33), 'next', 'pattern', 90, '3R', from, to) },
    { label: 'LONG  D bottom div <=20 / <=33, 90d, hold', f: (sym) => dailyLongTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => bottomDivEvents(c, r, 20, 33), 'next', 'pattern', 90, 'hold', from, to) },
    { label: 'LONG  D triple div <=27, MACD entry, trail', f: (sym) => dailyLongTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => tripleDivEvents(c, r, 27), 'macd', 'pattern', 90, 'trail', from, to) },
    { label: 'LONG  D momentum >75 / W<62, 3-day stop, hold', f: (sym) => dailyLongTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => momentumEvents(c, r), 'next', 'swing3', 30, 'hold', from, to) },
    { label: 'LONG  4H under-floor + LuxAlgo daily demand, 10 days', f: (sym) => {
      const c = [...(data[sym]?.candles['4h'] ?? [])], res: SignalTrade[] = [];
      if (c.length < 300) return res;
      const r14 = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
      let busy = -1;
      for (const e of rsiFloorEvents(r14).filter((x) => x.kind === 'under-floor')) {
        if (e.i <= busy || e.i + 1 >= c.length || c[e.i + 1]!.openTime < from || c[e.i + 1]!.openTime > to) continue;
        if (!luxDailyDemandTouched(data[sym]?.candles['1d'] ?? [], c[e.i]!, c[e.i + 1]!.openTime)) continue; // owner 2026-10-03
        const t = simulateSignal(c, atr, e.i, 1, 60, 'hold');
        if (!t || c[t.end]!.openTime + 4 * 3_600_000 > to) continue;
        res.push({ sym, t: c[e.i + 1]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars });
        busy = t.end;
      }
      return res;
    } },
    { label: 'SHORT W RSI 14 bearish div, daily swing stop, 3R', f: (sym) => weeklyShortTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => divergenceEvents(c, r, 5, 3, 5, 40).filter((e) => e.d === -1), 'swing', '3R', from, to) },
    { label: 'SHORT W top div >=79 / >=75, breakdown, hold', f: (sym) => weeklyShortTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => topDivEvents(c, r, 79, 75), 'breakdown', 'hold', from, to) },
    { label: 'SHORT W high div >=70 / >=63, breakdown, 3R', f: (sym) => weeklyShortTrades(sym, data[sym]?.candles['1d'] ?? [], (c, r) => { const t = topDivEvents(c, r, 79, 75); return topDivEvents(c, r, 70, 63, 'high-div').filter((e) => !t.some((x) => x.i === e.i)); }, 'breakdown', '3R', from, to) },
  ];
}

/**
 * Owner 2026-10-03: the RSI framework with its final settings, run as trades, each model and all together (1 R per
 * trade, trades in time order; overlapping trades all count). Settings after the +/- 3 grid:
 * D bottom div <=20 / <=33 (next open, wick stop, 90 days, 3R); D triple div first <=27 (MACD entry, wick stop, 90 days,
 * trail); D momentum RSI > 75 with weekly < 62 (3-day stop, 30 days, hold); 4H under-floor (10-bar swing stop, 10 days,
 * hold); W RSI 14 bearish divergence (daily swing stop, 3R); W top div >= 79 / >= 75 (daily breakdown, hold);
 * W high div >= 70 / >= 63 (daily breakdown, 3R).
 */
export function frameworkReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `RSI FRAMEWORK (final settings) AS TRADES: ${day(from)} to ${day(to)}, ${symbols.length} coins. Costs 0.22%. Older / newer = before / after ${day(cut)}.`,
    '  model                                                              n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const models = frameworkModels(data, from, to);
  const all: SignalTrade[] = [], longs: SignalTrade[] = [], shorts: SignalTrade[] = [];
  for (const m of models) {
    const trades = symbols.flatMap((sym) => m.f(sym));
    out.push(statsLine(m.label.padEnd(64), trades, cut));
    if (m.label.includes('bottom div') && m.label.endsWith('hold')) continue; // the 3R version goes in the portfolio
    all.push(...trades);
    (m.label.startsWith('LONG') ? longs : shorts).push(...trades);
  }
  out.push('', statsLine('ALL LONGS together'.padEnd(64), longs, cut), statsLine('ALL SHORTS together'.padEnd(64), shorts, cut), statsLine('WHOLE FRAMEWORK (bottom div with 3R)'.padEnd(64), all, cut));
  const years = new Map<number, number[]>();
  for (const t of all) { const y = new Date(t.t).getUTCFullYear(); years.set(y, [...(years.get(y) ?? []), t.r]); }
  out.push('', '  by year (whole framework): ' + [...years.entries()].sort((a, b) => a[0] - b[0]).map(([y, rs]) => `${y}: ${rs.length} trades, ${rs.reduce((a, b) => a + b, 0).toFixed(1)} R`).join(' | '));
  return out;
}

/**
 * Owner 2026-10-03, a test only: does the RRG framework (the coin's daily RRG vs BTC) add anything to the RSI
 * framework? Every framework trade (final settings) is tagged with its coin's daily RRG vs BTC at the close before
 * entry (120 daily bars, the bot's default classifier): position (x + y - 200, the trade's way), quadrant, and heading
 * (the tail turning the trade's way). Results are split by whether RRG agreed. BTC itself has no RRG vs BTC.
 */
export function rrgSplitReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10), DAY = 86_400_000;
  const cfg = resolveConfig({}), btc = data.BTCUSDT?.candles['1d'] ?? [];
  const btcClose = new Map(btc.map((c) => [c.openTime, c.close]));
  const read = (sym: string, t: number) => {
    const d = data[sym]?.candles['1d'] ?? [];
    const own = d.filter((c) => c.openTime + DAY <= t && btcClose.has(c.openTime)).slice(-122);
    if (sym === 'BTCUSDT' || own.length < 60) return null;
    return readRrg(own.map((c) => c.close), own.map((c) => btcClose.get(c.openTime)!), 'BTC', cfg);
  };
  const out = [
    `RRG x RSI FRAMEWORK (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Daily RRG vs BTC at the close before entry.`,
    'position agrees = coin stronger than BTC for a long (x + y > 200), weaker for a short; heading agrees = tail turning the trade\'s way.',
    `Older / newer = before / after ${day(cut)}.`,
    '  model / RRG group                                               n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  type Tagged = SignalTrade & { pos: boolean; head: boolean | null; quad: string };
  const allTagged: (Tagged & { long: boolean })[] = [];
  for (const m of frameworkModels(data, from, to)) {
    const long = m.label.startsWith('LONG');
    if (m.label.includes('bottom div') && m.label.endsWith('hold')) continue;
    const tagged: Tagged[] = [];
    for (const sym of symbols) for (const t of m.f(sym)) {
      const r = read(sym, t.t);
      if (!r) continue;
      const sgn = long ? 1 : -1, pos = sgn * (r.point.x - 100 + (r.point.y - 100)) > 0;
      const head = r.heading ? sgn * (r.heading.dx + r.heading.dy) > 0 : null;
      tagged.push({ ...t, pos, head, quad: r.quadrant });
    }
    allTagged.push(...tagged.map((t) => ({ ...t, long })));
    out.push(statsLine(`${m.label} (all with RRG)`.padEnd(62), tagged, cut));
    out.push(statsLine('    position agrees'.padEnd(62), tagged.filter((t) => t.pos), cut));
    out.push(statsLine('    position against'.padEnd(62), tagged.filter((t) => !t.pos), cut));
    out.push(statsLine('    heading agrees'.padEnd(62), tagged.filter((t) => t.head === true), cut));
    out.push(statsLine('    heading against'.padEnd(62), tagged.filter((t) => t.head === false), cut));
  }
  out.push('', statsLine('WHOLE FRAMEWORK (all with RRG)'.padEnd(62), allTagged, cut));
  for (const [label, f] of [
    ['  position agrees', (t: Tagged) => t.pos], ['  position against', (t: Tagged) => !t.pos],
    ['  heading agrees', (t: Tagged) => t.head === true], ['  heading against', (t: Tagged) => t.head === false],
    ['  both agree', (t: Tagged) => t.pos && t.head === true], ['  both against', (t: Tagged) => !t.pos && t.head === false],
  ] as const) out.push(statsLine(label.padEnd(62), allTagged.filter(f), cut));
  for (const q of ['leading', 'weakening', 'lagging', 'improving']) {
    out.push(statsLine(`  longs, coin ${q}`.padEnd(62), allTagged.filter((t) => t.long && t.quad === q), cut));
    out.push(statsLine(`  shorts, coin ${q}`.padEnd(62), allTagged.filter((t) => !t.long && t.quad === q), cut));
  }
  return out;
}
