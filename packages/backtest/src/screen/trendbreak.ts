// Trend breakout model, long and short on 4H (owner 2026-10-16: "Test this as a model"). Research only. The owner's
// rules, fixed here before the run. The message pointed to a write-up (/workspace/trendmodel/SPEC.md) that is not in
// this repository or this container, so anything it adds is not here; the details the message leaves open are marked
// "chosen".
// - Daily trend: the last closed daily close against its EMA 26 (taEma, Pine's EMA), as known at the 4H bar's close.
// - Long: the coin and BTC both close above their daily EMA 26, and a 4H close breaks above the highest high of the 20
//   4H bars before it, on 4H volume above 1.5x the mean of those 20 bars (chosen: the 20 bars before the breakout bar,
//   volume as loaded).
// - Short: the coin closes below its daily EMA 26, and a 4H close breaks below the lowest low of the 20 4H bars before
//   it. As written, no volume or BTC rule.
// - Entry at the next 4H open. Stop: long 4 x ATR(14) under the highest close since entry, short 2 x ATR above the
//   lowest close (exits.ts 'atr' trail, armed at once, ratchet only, ATR of each closed 4H bar; the first stop is 4 / 2
//   ATR of the breakout bar from the entry price, and 1R = that distance). Time stop: 60 days (360 4H bars) at the
//   close. Costs 0.22% round trip; funding is not counted (as the live-model check). One trade per coin at a time.
// - Portfolio: 1% risk per trade, at most 5 open; a signal while 5 are open, or on a coin already held, is skipped
//   (chosen: signals on the same 4H bar in coin-list order).
// Checks, fixed before the run:
// - Trades: every signal (one per coin at a time, no portfolio cap), long and short apart, older / newer than the cut,
//   with the two baselines of the live-model check (timing.ts, 20 seeds): the same entry in a random direction, and the
//   same side at a random bar in the next 60 days.
// - Portfolio: daily marks at each coin's daily close, in % of starting equity, not compounded. Sharpe = mean daily
//   return / its deviation x sqrt(365). The owner's figures to check: correlation with the live models -0.05, Sharpe of
//   the live models 0.84 and of both together 1.56. The live models here: the live code (livecheck.ts, rule set
//   option 1, each model's one exit, no time limit) at the live defaults, 2% risk and at most 3 open (chosen; both are
//   dashboard settings); 15M-RSI10 is left out (it needs the 15m history, and trades about 9 times a year).
// Pure.

import type { Candle } from '@bot/marketdata';
import { atrWilder } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { livePositions } from './livecheck';
import { taEma } from './pine';
import { STATS_HEAD } from './smcreport';
import { randomDirectionTwins, randomTimeTwins, timingLine, type TimedRow } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const H4 = 4 * 3_600_000, DAY = 86_400_000, COST = 0.0022;

export const TREND_BREAK = {
  emaLen: 26, look: 20, volMult: 1.5, atrLen: 14, trailAtr: { long: 4, short: 2 },
  /** 60 days of 4H bars. */
  capBars: 360,
  riskPct: 1, maxOpen: 5,
  /** The live models in the portfolio comparison: the live defaults (dashboard settings). */
  live: { riskPct: 2, maxOpen: 3 },
  seeds: 20, spanDays: 60,
} as const;

export const trendSpec = (d: 1 | -1): ExitSpec => d > 0
  ? { name: '4 ATR trail under the highest close, 60-day time stop', trail: { kind: 'atr', k: TREND_BREAK.trailAtr.long, arm: 0 }, cap: TREND_BREAK.capBars }
  : { name: '2 ATR trail over the lowest close, 60-day time stop', trail: { kind: 'atr', k: TREND_BREAK.trailAtr.short, arm: 0 }, cap: TREND_BREAK.capBars };

/** For each 4H bar: 1 when the last daily close known at its close is above its EMA 26, -1 below, 0 unknown. */
export function dailySide(h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, len: number = TREND_BREAK.emaLen): Int8Array {
  const ema = taEma(d1.map((b) => b.close), len), out = new Int8Array(h4.length);
  let k = -1;
  for (let i = 0; i < h4.length; i++) {
    const closeAt = h4[i]!.openTime + H4;
    while (k + 1 < d1.length && d1[k + 1]!.openTime + DAY <= closeAt) k++;
    const e = k >= 0 ? ema[k]! : NaN, c = k >= 0 ? d1[k]!.close : NaN;
    out[i] = Number.isFinite(e) ? (c > e ? 1 : c < e ? -1 : 0) : 0;
  }
  return out;
}

export interface TrendSignal { i: number; d: 1 | -1 }
/** Breakout signals on closed 4H bars (rules in the header). `btc` is BTC's dailySide on the same 4H bars. */
export function trendSignals(h4: ReadonlyArray<Candle>, coin: Int8Array, btc: Int8Array): TrendSignal[] {
  const { look, volMult } = TREND_BREAK, out: TrendSignal[] = [];
  for (let i = look; i < h4.length; i++) {
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let q = i - look; q < i; q++) { const b = h4[q]!; hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); vol += b.volume ?? NaN; }
    const b = h4[i]!;
    if (coin[i]! > 0 && btc[i]! > 0 && b.close > hi && (b.volume ?? NaN) > volMult * (vol / look)) out.push({ i, d: 1 }); // a missing volume fails the rule
    else if (coin[i]! < 0 && b.close < lo) out.push({ i, d: -1 });
  }
  return out;
}

/** A position for the daily marks: prices per unit, `risk` = 1R per unit, `exitT` = the close time of the exit bar. */
export interface Pos { sym: string; d: 1 | -1; entryT: number; exitT: number; entryPx: number; exitPx: number; risk: number; cost: number }
export type TrendTrade = TimedRow & Pos & { how: string; open: boolean };

/**
 * One coin's trades from closed 4H bars: every signal from `from` on, one trade at a time (the next signal must come
 * after the exit bar). `twins` = add the random-direction and random-time baselines.
 */
export function coinTrendTrades(sym: string, h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, btcSide: Int8Array, from: number, twins = true): TrendTrade[] {
  const atr = atrWilder(h4, TREND_BREAK.atrLen), out: TrendTrade[] = [];
  let lastEnd = -1;
  for (const s of trendSignals(h4, dailySide(h4, d1), btcSide)) {
    const j = s.i + 1, a = atr[s.i];
    if (s.i <= lastEnd || j >= h4.length || h4[j]!.openTime < from || a == null) continue;
    const spec = trendSpec(s.d), entry = h4[j]!.open, k = s.d > 0 ? TREND_BREAK.trailAtr.long : TREND_BREAK.trailAtr.short, stop0 = entry - s.d * k * a;
    const x = specTrade(h4, atr, {}, j, stop0, s.d, spec, COST);
    if (!x) continue;
    const risk = s.d * (entry - stop0);
    out.push({
      sym, t: h4[j]!.openTime, r: x.r, stopPct: x.stopPct, bars: Math.round((h4[x.end]!.openTime + H4 - h4[j]!.openTime) / DAY),
      d: s.d, entryT: h4[j]!.openTime, exitT: h4[x.end]!.openTime + H4, entryPx: entry, exitPx: entry + s.d * risk * (x.r + (COST * entry) / risk), risk, cost: COST,
      how: x.how, open: x.open,
      rand: twins ? randomDirectionTwins(h4, atr, sym, j, stop0, s.d, spec, TREND_BREAK.seeds) : [],
      rtime: twins ? randomTimeTwins(h4, atr, sym, j, stop0, s.d, spec, (TREND_BREAK.spanDays * DAY) / H4, TREND_BREAK.seeds) : [],
    });
    lastEnd = x.end;
  }
  return out;
}

/** The positions a book takes: by entry time (ties in input order), at most `maxOpen` open, one per coin. */
export function capped<T extends Pos>(xs: ReadonlyArray<T>, maxOpen: number): T[] {
  const sorted = xs.map((x, k) => ({ x, k })).sort((a, b) => a.x.entryT - b.x.entryT || a.k - b.k).map((y) => y.x);
  const taken: T[] = [];
  let open: T[] = [];
  for (const x of sorted) {
    open = open.filter((o) => o.exitT > x.entryT);
    if (open.length >= maxOpen || open.some((o) => o.sym === x.sym)) continue;
    open.push(x); taken.push(x);
  }
  return taken;
}

const dayOf = (t: number) => Math.floor(t / DAY) * DAY;
/**
 * Daily returns (fractions of starting equity, not compounded) from `from` to `to`, each position at `riskPct` of
 * starting equity per 1R, marked at its coin's daily close (`closes`: day start -> close); the exit day ends at the exit
 * price, less the costs.
 */
export function dailyReturns(ps: ReadonlyArray<Pos>, riskPct: number, closes: ReadonlyMap<string, ReadonlyMap<number, number>>, from: number, to: number): { days: number[]; ret: number[] } {
  const d0 = dayOf(from), n = Math.max(0, Math.floor((dayOf(to) - d0) / DAY) + 1), ret = new Array<number>(n).fill(0), f = riskPct / 100;
  for (const p of ps) {
    const e0 = dayOf(p.entryT), e1 = dayOf(p.exitT - 1), cl = closes.get(p.sym);
    let prev = p.entryPx;
    for (let D = e0; D <= e1; D += DAY) {
      const mark = D === e1 ? p.exitPx : cl?.get(D) ?? prev, k = (D - d0) / DAY;
      if (k >= 0 && k < n) ret[k]! += (f * p.d * (mark - prev)) / p.risk;
      prev = mark;
    }
    const k = (e1 - d0) / DAY;
    if (k >= 0 && k < n) ret[k]! -= (f * p.cost * p.entryPx) / p.risk;
  }
  return { days: Array.from({ length: n }, (_, k) => d0 + k * DAY), ret };
}

/** Sharpe (x sqrt 365), return a year, total and max drawdown, in % of starting equity (not compounded). */
export function seriesStats(ret: ReadonlyArray<number>): { sharpe: number; annual: number; total: number; maxDd: number } {
  const n = ret.length, mean = ret.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const sd = Math.sqrt(ret.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  let eq = 0, peak = 0, dd = 0;
  for (const r of ret) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return { sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : NaN, annual: 100 * mean * 365, total: 100 * eq, maxDd: 100 * dd };
}

export function correlation(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length), ma = a.slice(0, n).reduce((p, q) => p + q, 0) / n, mb = b.slice(0, n).reduce((p, q) => p + q, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < n; k++) { const x = a[k]! - ma, y = b[k]! - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** Sums of consecutive 7-day blocks (for the weekly correlation). */
const weekly = (r: ReadonlyArray<number>) => Array.from({ length: Math.floor(r.length / 7) }, (_, w) => r.slice(7 * w, 7 * w + 7).reduce((a, b) => a + b, 0));

/** The report. Needs 4h + 1d (BTC's daily for the long rule). `skip` = reference coins (BTC on fresh sets). */
export function trendBreakReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10), pct = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
  const btcD1 = data['BTCUSDT']?.candles['1d'] ?? [], trades: TrendTrade[] = [], closes = new Map<string, Map<number, number>>();
  let used = 0, end = from;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 300 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = (data[sym]?.candles['4h'] ?? []).filter((b) => b.openTime + H4 <= now);
    closes.set(sym, new Map(d1.map((b) => [b.openTime, b.close])));
    end = Math.max(end, now);
    if (h4.length < 300) continue;
    trades.push(...coinTrendTrades(sym, h4, d1, dailySide(h4, btcD1), from));
  }
  const longs = trades.filter((x) => x.d > 0), shorts = trades.filter((x) => x.d < 0);
  const out = [
    `TREND BREAKOUT, 4H, LONG AND SHORT (owner 2026-10-16): ${day(from)} to now, ${used} coins. Older / newer = before / after ${day(cut)}.`,
    'Rules (fixed before the run, screen/trendbreak.ts): long = coin and BTC daily close over their EMA 26, 4H close over the 20-bar high on volume > 1.5x the 20-bar mean; short = coin daily close under its EMA 26, 4H close under the 20-bar low. Entry next 4H open; trail 4 ATR under the highest close (long) / 2 ATR over the lowest close (short); 60-day time stop; 0.22% costs, funding not counted.',
    'Baselines (20 seeds each): "random" = the same entry in a random direction; "random time" = the same side at a random bar in the next 60 days, same stop % and exit; timing edge = R minus its own random-time twins (t value; before / after the cut). The bars column is days held.',
    '', 'TRADES (every signal, one trade per coin at a time, no portfolio cap)', STATS_HEAD,
  ];
  if (!trades.length) return [...out, '  no trades'];
  out.push(timingLine('  ALL'.padEnd(84), trades, cut));
  if (longs.length) out.push(timingLine(`    long: ${trendSpec(1).name}`.padEnd(84), longs, cut));
  if (shorts.length) out.push(timingLine(`    short: ${trendSpec(-1).name}`.padEnd(84), shorts, cut));
  const exits = (xs: TrendTrade[]) => ['stop', 'time', 'open'].map((h) => `${h} ${xs.filter((x) => x.how === h).length}`).join(', ');
  out.push(`  How trades ended: long ${exits(longs)}; short ${exits(shorts)}.`);

  // Portfolio: the trend book (1% risk, max 5 open) and the live models' book (2% risk, max 3 open), marked daily.
  // The series start at the first entry of either book (the 4H history begins years after `from`; empty days before it
  // would pull every Sharpe down).
  const book = capped(trades, TREND_BREAK.maxOpen), liveAll = livePositions(data, symbols, from, skip), liveBook = capped(liveAll, TREND_BREAK.live.maxOpen);
  const start = Math.max(from, Math.min(...book.map((x) => x.entryT), ...liveBook.map((x) => x.entryT)));
  const tr = dailyReturns(book, TREND_BREAK.riskPct, closes, start, end), lv = dailyReturns(liveBook, TREND_BREAK.live.riskPct, closes, start, end);
  const both = tr.ret.map((x, k) => x + (lv.ret[k] ?? 0));
  // Added after the first run (the trade split showed the edge in the longs): information only, not a rule fixed before.
  const longBook = capped(trades.filter((x) => x.d > 0), TREND_BREAK.maxOpen), lo = dailyReturns(longBook, TREND_BREAK.riskPct, closes, start, end);
  const bothLong = lo.ret.map((x, k) => x + (lv.ret[k] ?? 0));
  const line = (label: string, r: ReadonlyArray<number>) => { const s = seriesStats(r); return `  ${label.padEnd(58)} Sharpe ${s.sharpe.toFixed(2).padStart(5)}   ${pct(s.annual).padStart(7)} a year   total ${pct(s.total).padStart(8)}   max DD ${s.maxDd.toFixed(1)}%`; };
  const years = [...new Set(tr.days.map((t) => new Date(t).getUTCFullYear()))];
  const byYear = (r: ReadonlyArray<number>) => years.map((y) => `${y} ${pct(100 * r.reduce((a, b, k) => a + (new Date(tr.days[k]!).getUTCFullYear() === y ? b : 0), 0))}`).join(' · ');
  const half = (r: ReadonlyArray<number>, newer: boolean) => r.filter((_, k) => (tr.days[k]! >= cut) === newer);
  out.push(
    '', `PORTFOLIO (daily marks at the daily close; % of starting equity, not compounded; ${tr.days.length} days from ${day(start)}, the first entry of either book)`,
    `  Trend book: ${TREND_BREAK.riskPct}% risk a trade, at most ${TREND_BREAK.maxOpen} open: ${book.length} of ${trades.length} trades taken (long ${book.filter((x) => x.d > 0).length}, short ${book.filter((x) => x.d < 0).length}).`,
    `  Live models' book (live code, option 1, one exit each, no time limit; 15M-RSI10 not included): ${TREND_BREAK.live.riskPct}% risk, at most ${TREND_BREAK.live.maxOpen} open: ${liveBook.length} of ${liveAll.length} trades taken.`,
    line('trend book', tr.ret), line('live models', lv.ret), line('both books together', both),
    line('trend book, older', half(tr.ret, false)), line('trend book, newer', half(tr.ret, true)),
    line('both together, older', half(both, false)), line('both together, newer', half(both, true)),
    `  Correlation, trend vs live: daily ${correlation(tr.ret, lv.ret).toFixed(2)}, weekly ${correlation(weekly(tr.ret), weekly(lv.ret)).toFixed(2)}.`,
    `  Added after the first run, information only: trend book of longs only (${longBook.length} taken):`,
    line('  longs-only trend book', lo.ret), line('  longs-only trend book + live models', bothLong),
    line('  longs-only trend book, older', half(lo.ret, false)), line('  longs-only trend book, newer', half(lo.ret, true)),
    `    correlation with live: daily ${correlation(lo.ret, lv.ret).toFixed(2)}; by year ${byYear(lo.ret)}`,
    `  By year, trend: ${byYear(tr.ret)}`,
    `  By year, live: ${byYear(lv.ret)}`,
    `  By year, both: ${byYear(both)}`,
    '  The owner\'s figures to check: correlation -0.05; Sharpe 0.84 (live models) -> 1.56 (with the trend model).',
  );
  return out;
}
