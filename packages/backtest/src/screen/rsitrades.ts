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
import { bottomDivEvents, divergenceEvents, prismFlipEvents, topDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';

export type TradeExit = 'hold' | '3R' | 'trail';
export interface SignalTrade { sym: string; t: number; r: number; stopPct: number; bars: number }

export function simulateSignal(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, i: number, d: 1 | -1, cap: number, exit: TradeExit, cost = 0.0022): { r: number; stopPct: number; bars: number; end: number } | null {
  const j = i + 1, last = j + cap - 1, a = atr[i];
  if (last >= c.length || a == null) return null;
  let ext = d > 0 ? Infinity : -Infinity;
  for (let k = Math.max(0, i - 9); k <= i; k++) ext = d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
  const entry = c[j]!.open;
  let stop = ext - d * 0.5 * a;
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

type Sig = { key: string; tf: '1w' | '1d'; cap: number; d: 1 | -1; find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[] };
export const TRADE_SIGNALS: Sig[] = [
  { key: 'W diamond (Prism exhaustion) short', tf: '1w', cap: 13, d: -1, find: (c) => { const p = prismRsi(c.map((b) => b.close)); return prismFlipEvents(p).filter((e) => e.kind === 'exhaustion' && e.d === -1); } },
  { key: 'W top divergence 82/75 short', tf: '1w', cap: 13, d: -1, find: (c, r) => topDivEvents(c, r) },
  { key: 'W high divergence 70/60 short', tf: '1w', cap: 13, d: -1, find: (c, r) => { const t = topDivEvents(c, r); return topDivEvents(c, r, 70, 60, 'high-div').filter((e) => !t.some((x) => x.i === e.i)); } },
  { key: 'W RSI 14 bearish divergence short', tf: '1w', cap: 13, d: -1, find: (c, r) => divergenceEvents(c, r, 5, 3, 5, 40).filter((e) => e.d === -1) },
  { key: 'D bottom divergence 20/30 long', tf: '1d', cap: 60, d: 1, find: (c, r) => bottomDivEvents(c, r) },
];

export function signalTradeReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number,
): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `RSI SIGNALS AS TRADES: ${day(from)} to ${day(to)}, ${symbols.length} coins. Entry next bar open; stop beyond the 10-bar swing +/- 0.5 ATR;`,
    'costs 0.22% round trip; one open trade per coin per signal. Exits: hold = time cap (13 weeks / 60 days) with the stop; 3R = target 3R;',
    `trail = after +1R trail 3 ATR behind the best close. R = result in units of the stop distance. Older / newer = before / after ${day(cut)}.`,
    '  signal                                exit    n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const lists: { key: string; exit: TradeExit; trades: SignalTrade[] }[] = [];
  for (const s of TRADE_SIGNALS) for (const exit of ['hold', '3R', 'trail'] as TradeExit[]) {
    const trades: SignalTrade[] = [];
    for (const sym of symbols) {
      const d1 = data[sym]?.candles['1d'] ?? [];
      const c = s.tf === '1w' ? weeklyFromDaily(d1) : [...d1];
      if (c.length < 40) continue;
      const r14 = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
      let busy = -1;
      for (const e of s.find(c, r14)) {
        if (e.d !== s.d || e.i <= busy) continue;
        const j = e.i + 1;
        if (j >= c.length || c[j]!.openTime < from || c[j]!.openTime > to) continue;
        const res = simulateSignal(c, atr, e.i, s.d, s.cap, exit);
        if (!res || c[res.end]!.openTime + (s.tf === '1w' ? 7 : 1) * 86_400_000 > to) continue;
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
