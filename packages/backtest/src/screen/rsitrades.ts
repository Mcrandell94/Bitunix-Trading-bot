// RSI framework signals run as trades (owner 2026-10-03: "run them as trades and drop the buy flip").
// Rules fixed before the run:
// - entry at the open of the bar after the signal bar; one open trade per coin per signal;
// - stop beyond the swing: longs under the lowest low of the last 10 bars - 0.5 ATR, shorts over the highest high
//   + 0.5 ATR; a gap through the stop fills at the open;
// - exits: 'hold' = time cap with the stop; '3R' = 3R target + stop + time cap (stop first when both touch in a bar);
//   'trail' = after +1R (on a close), trail 3 ATR behind the best close, + time cap;
// - costs 0.22% of entry per round trip (fees + slippage), charged in R; funding not modelled.
import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
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

/** One trade entered at the open of bar `j` with the given stop; exits as in the header. */
export function simulateFrom(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, cap: number, exit: TradeExit, cost = 0.0022): { r: number; stopPct: number; bars: number; end: number } | null {
  const last = j + cap - 1;
  if (last >= c.length) return null;
  const entry = c[j]!.open;
  let stop = stop0;
  const risk = d * (entry - stop);
  if (!(risk > 0)) return null;
  const target = entry + d * 3 * risk;
  let best = entry, armed = false, px = c[last]!.close, end = last;
  for (let k = j; k <= last; k++) {
    const b = c[k]!;
    if (d * (b.open - stop) <= 0) { px = b.open; end = k; break; } // gapped through the stop
    if (d > 0 ? b.low <= stop : b.high >= stop) { px = stop; end = k; break; }
    if (exit === '3R' && (d > 0 ? b.high >= target : b.low <= target)) { px = target; end = k; break; }
    if (exit === 'trail') {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - entry) >= risk) armed = true;
      const ak = atr[k];
      if (armed && ak != null) { const tr = best - d * 3 * ak; if (d * (tr - stop) > 0) stop = tr; }
    }
  }
  return { r: (d * (px - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: end - j + 1, end };
}

/** Long entered at the next open with the stop under the pattern's lowest low (first pivot .. signal bar) - 0.5 ATR. */
export function patternStopTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, e: WeeklyEvent, cap: number, exit: TradeExit) {
  const a = atr[e.i];
  if (e.a == null || a == null || e.i + 1 >= c.length) return null;
  let lo = Infinity;
  for (let k = e.a; k <= e.i; k++) lo = Math.min(lo, c[k]!.low);
  return simulateFrom(c, atr, e.i + 1, lo - 0.5 * a, 1, cap, exit);
}

type Sig = { key: string; tf: '1w' | '1d' | '4h'; cap: number; d: 1 | -1; stop?: 'pattern'; find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[] };
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
        const res = s.stop === 'pattern' ? patternStopTrade(c, atr, e, s.cap, exit) : simulateSignal(c, atr, e.i, s.d, s.cap, exit);
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
