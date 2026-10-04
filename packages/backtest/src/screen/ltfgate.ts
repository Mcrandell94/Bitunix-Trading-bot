// Cost / stop gate and realistic maker fills on the 15m / 1h lines (owner 2026-10-05, a brief written with another
// model). Research only. No signal rule changes; parameters fixed by the brief, not tuned:
//
// TEST 1, cost / stop gate: stop % = |entry - stop| / entry; skip a trade when stop % < K x the round-trip cost
//   (0.22%). K = 10 is the test (stop >= 2.2%); K = 5 (1.1%) and K = 15 (3.3%) are sensitivity only. A skipped trade
//   does not block the coin, so the next signal can be taken.
// TEST 2, maker fills: a limit at the signal bar's close, valid 2 bars; filled only when price trades THROUGH it by at
//   least one tick (long: low <= limit - tick; short: high >= limit + tick). Unfilled = missed (its market-entry result
//   is still logged, for adverse selection). Exits: stop and trailed stop = taker (fee + slippage); take-profit = a limit
//   (maker fee, same trade-through rule); time exits = taker. The stop counts on the fill bar, a target does not.
// Costs (the studies' existing 0.22% round trip): a taker leg = 0.06% fee + 0.05% slippage = 0.11%; a maker leg =
//   0.02% fee, no slippage. Funding: the coin's real settlements while the trade is open (longs pay a positive rate).
// Lines (named before the run):
//   a) 1h short regular divergence, daily RSI < 50, 3R, stop 1x and 1.5x (RSI pattern catalogue);
//   b) the best 1h long and short of the selective scalp (docs/RESULTS.md 2.11, run 37202942888):
//      1h|long|div|all|none|30|trail and 1h|short|hl|first|4h rsi|25|3R;
//   c) 1h long hl trail and 1h short div trail (first per anchor, level 30, no direction filter; 2.15), all, with a
//      1h MACD divergence, without one.
// Sweep: the K = 10 gate over every existing scalp line (15m, 1h, 15m + 1h) and every 1h pattern-catalogue line, at
//   market. Reported as counts only: lines positive in both periods (n >= 30) before / after the gate, and the same count
//   for the gated lines traded in a random direction (the chance level). No line from the sweep is named.
// Pass rule: positive in both periods, on research AND fresh coins (two runs), and beating random direction.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi, sma } from '../indicators';
import type { FundingPoint } from '../types';
import { macdDivergence } from './macdstate';
import { regimeOk, rsiPatterns, type Regime } from './rsipatterns';
import { statsLine, type SignalTrade } from './rsitrades';
import { buildScalp2Rows, dirOk, flip, prep, scalp2Signals, scalp2Trade, stopFor, type Exit } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, CAP = 120, ROUND = 0.22, TAKER = 0.11, MAKER = 0.02, WAIT = 2;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');

interface Book { c: ReadonlyArray<Candle>; r: (number | null)[]; atr: (number | null)[]; tick: number; funding: ReadonlyArray<FundingPoint> }
export interface GateEv { sym: string; i: number; d: 1 | -1; stop: number; exit: Exit; stopMult: number; t0: number }
interface Sim { r: number; stopPct: number; t: number; endT: number; bars: number }

/** Limit at the close of bar i, valid `wait` bars, filled only when price trades through it by `tick`. */
export function makerFill(c: ReadonlyArray<Candle>, i: number, d: 1 | -1, tick: number, wait = WAIT): { q: number; px: number } | null {
  const px = c[i]!.close;
  for (let q = i + 1; q <= i + wait && q < c.length; q++) if (d > 0 ? c[q]!.low <= px - tick : c[q]!.high >= px + tick) return { q, px };
  return null;
}

/** True when the stop is wide enough for the K gate (K null = no gate). */
export const gateOk = (stopPct: number, k: number | null) => k == null || stopPct >= k * ROUND;

/** Funding paid or received between start and end, in R (settlements sorted by time). */
const fundingR = (b: Book, d: 1 | -1, start: number, end: number, stopPct: number) => {
  const fs = b.funding;
  let lo = 0, hi = fs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fs[m]!.time <= start) lo = m + 1; else hi = m; }
  let s = 0;
  for (let k = lo; k < fs.length && fs[k]!.time <= end; k++) s += -d * fs[k]!.rate * 100;
  return s / stopPct;
};

/** Stop level for an entry at px: the event's stop (stop x1) or its distance scaled from px. */
const stopAt = (e: GateEv, px: number, d: 1 | -1, pct?: number) => (pct != null ? px - (d * px * pct) / 100 : e.stopMult === 1 && d === e.d ? e.stop : px - d * e.stopMult * Math.abs(px - e.stop));

function market(b: Book, e: GateEv, d: 1 | -1 = e.d, pct?: number): Sim | null {
  const j = e.i + 1;
  if (j >= b.c.length) return null;
  const px = b.c[j]!.open, stop = stopAt(e, px, d, pct);
  const tr = scalp2Trade(b.c, b.r, b.atr, j, stop, d, CAP, e.exit);
  if (!tr) return null;
  const endT = b.c[tr.end]!.openTime + H;
  return { r: tr.gross - ROUND * tr.costR + fundingR(b, d, b.c[j]!.openTime, endT, tr.stopPct), stopPct: tr.stopPct, t: b.c[j]!.openTime, endT, bars: tr.bars };
}

function maker(b: Book, e: GateEv, k: number | null, d: 1 | -1 = e.d, pct?: number): Sim | 'skip' | 'miss' | null {
  const px = b.c[e.i]!.close, stop = stopAt(e, px, d, pct), stopPct = (100 * d * (px - stop)) / px;
  if (!(stopPct > 0)) return null;
  if (!gateOk(stopPct, k)) return 'skip'; // the order is never placed
  const f = makerFill(b.c, e.i, d, b.tick);
  if (!f) return 'miss';
  const tr = scalp2Trade(b.c, b.r, b.atr, f.q, stop, d, CAP, e.exit, [], f.px, b.tick);
  if (!tr) return null;
  const endT = b.c[tr.end]!.openTime + H;
  const cost = MAKER + (tr.how === 'target' ? MAKER : TAKER);
  return { r: tr.gross - cost * tr.costR + fundingR(b, d, b.c[f.q]!.openTime, endT, tr.stopPct), stopPct: tr.stopPct, t: b.c[f.q]!.openTime, endT, bars: tr.bars };
}

interface Run { trades: (SignalTrade & { e: GateEv })[]; skipped: number; missed: number; missedMkt: SignalTrade[]; filledMkt: SignalTrade[] }

/** One line through time: one trade at a time per coin; skipped and missed signals do not block the coin. */
function runLine(books: Map<string, Book>, evs: GateEv[], mode: 'market' | 'maker', k: number | null, to: number, noFunding = false): Run {
  const busy = new Map<string, number>(), out: Run = { trades: [], skipped: 0, missed: 0, missedMkt: [], filledMkt: [] };
  for (const e of evs) {
    const b = books.get(e.sym)!;
    if (e.t0 <= (busy.get(e.sym) ?? -Infinity)) continue;
    const bk = noFunding ? { ...b, funding: [] } : b;
    let s: Sim | null;
    if (mode === 'market') {
      s = market(bk, e);
      if (s && !gateOk(s.stopPct, k)) { out.skipped++; continue; }
    } else {
      const m = maker(bk, e, k);
      if (m === 'skip') { out.skipped++; continue; }
      const mk = market(bk, e);
      if (m === 'miss') { out.missed++; if (mk && mk.endT <= to) out.missedMkt.push({ sym: e.sym, t: mk.t, r: mk.r, stopPct: mk.stopPct, bars: mk.bars }); continue; }
      s = m;
      if (s && mk && s.endT <= to) out.filledMkt.push({ sym: e.sym, t: mk.t, r: mk.r, stopPct: mk.stopPct, bars: mk.bars });
    }
    if (!s || s.endT > to) continue;
    out.trades.push({ sym: e.sym, t: s.t, r: s.r, stopPct: s.stopPct, bars: s.bars, e });
    busy.set(e.sym, s.endT);
  }
  return out;
}

/** The same trades with the side set by a seeded coin flip (20 seeds), same stop %, same entry mode. */
function randomAvg(books: Map<string, Book>, run: Run, mode: 'market' | 'maker'): number {
  const rs: number[] = [];
  for (let seed = 1; seed <= 20; seed++) for (const t of run.trades) {
    const b = books.get(t.sym)!, d: 1 | -1 = flip(seed, t.sym, t.e.i) ? 1 : -1;
    const s = mode === 'market' ? market(b, t.e, d, t.stopPct) : maker(b, t.e, null, d, t.stopPct);
    if (s && typeof s === 'object') rs.push(s.r);
  }
  return avg(rs);
}

export function ltfGateReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, ticks: ReadonlyMap<string, number> = new Map()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const books = new Map<string, Book>();
  const lines: { id: string; name: string; evs: GateEv[] }[] = [
    { id: 'a1', name: 'a) 1h short regular div, daily RSI < 50, 3R, stop 1x', evs: [] },
    { id: 'a2', name: 'a) 1h short regular div, daily RSI < 50, 3R, stop 1.5x', evs: [] },
    { id: 'b1', name: 'b) best 1h long: 1h|long|div|all|none|30|trail', evs: [] },
    { id: 'b2', name: 'b) best 1h short: 1h|short|hl|first|4h rsi|25|3R', evs: [] },
    { id: 'c1', name: 'c) 1h long hl trail (first, 30, no filter): all', evs: [] },
    { id: 'c1+', name: 'c) 1h long hl trail: with a 1h MACD divergence', evs: [] },
    { id: 'c1-', name: 'c) 1h long hl trail: without', evs: [] },
    { id: 'c2', name: 'c) 1h short div trail (first, 30, no filter): all', evs: [] },
    { id: 'c2+', name: 'c) 1h short div trail: with a 1h MACD divergence', evs: [] },
    { id: 'c2-', name: 'c) 1h short div trail: without', evs: [] },
  ];
  const L = Object.fromEntries(lines.map((x) => [x.id, x.evs]));
  let tickFallback = 0;
  for (const sym of symbols) {
    const c = data[sym]?.candles['1h'] ?? [], dc = data[sym]?.candles['1d'] ?? [], c4 = data[sym]?.candles['4h'] ?? [];
    if (c.length < 500) continue;
    const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14);
    let tick = ticks.get(sym);
    if (tick == null) { tick = c[c.length - 1]!.close * 1e-4; tickFallback++; } // no exchange tick: one basis point
    books.set(sym, { c, r, atr, tick, funding: data[sym]?.funding ?? [] });
    const dr = rsi(dc.map((x) => x.close), 14);
    for (const e of rsiPatterns(c, r, atr)) {
      if (e.d !== -1 || e.pat !== 'regular div') continue;
      const t0 = c[e.i]!.openTime + H;
      if (t0 < from || !regimeOk('with trend', -1, t0, dc, dr)) continue;
      L.a1!.push({ sym, i: e.i, d: -1, stop: e.stop, exit: '3R', stopMult: 1, t0 });
      L.a2!.push({ sym, i: e.i, d: -1, stop: e.stop, exit: '3R', stopMult: 1.5, t0 });
    }
    const p = prep(c, '1h'), m = macdLines(c.map((x) => x.close));
    const d1 = { c: dc, sma: sma(dc.map((x) => x.close), 200) }, h4 = { c: c4, r: rsi(c4.map((x) => x.close), 14) };
    for (const lv of [30, 25] as const) for (const s of scalp2Signals(c, r, lv)) {
      const t0 = c[s.i]!.openTime + H, stop = stopFor(p, s, s.i + 1);
      if (t0 < from || stop == null) continue;
      const ev = (exit: Exit): GateEv => ({ sym, i: s.i, d: s.d, stop, exit, stopMult: 1, t0 });
      if (lv === 30 && s.d > 0 && s.family === 'div') L.b1!.push(ev('trail'));
      if (lv === 25 && s.d < 0 && s.family === 'hl' && s.first && dirOk('4h rsi', -1, t0, d1, h4)) L.b2!.push(ev('3R'));
      if (lv === 30 && s.first && ((s.d > 0 && s.family === 'hl') || (s.d < 0 && s.family === 'div'))) {
        const id = s.d > 0 ? 'c1' : 'c2', div = macdDivergence(c, m.line, s.i, s.d);
        L[id]!.push(ev('trail'));
        L[`${id}${div ? '+' : '-'}`]!.push(ev('trail'));
      }
    }
  }
  for (const x of lines) x.evs.sort((a, b) => a.t0 - b.t0);

  const HEAD = '  line / test                                                                            n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [
    `COST / STOP GATE AND MAKER FILLS ON THE 15m / 1h LINES: ${day(from)} to ${day(to)}, ${books.size} coins${tickFallback ? ` (${tickFallback} without an exchange tick: 1 bp used)` : ''}. Older / newer = before / after ${day(cut)}.`,
    'Costs: taker leg 0.11% (0.06% fee + 0.05% slippage, the studies\' 0.22% round trip), maker leg 0.02%; real funding while open. Random = the same trades, side by coin flip, 20 seeds.',
    'Pass: avg R > 0 in both periods here AND in the fresh-coin run, and above random.',
  ];
  const passMark = (run: Run, rnd: number) => {
    const o = avg(run.trades.filter((t) => t.t < cut).map((t) => t.r)), n = avg(run.trades.filter((t) => t.t >= cut).map((t) => t.r)), a = avg(run.trades.map((t) => t.r));
    return o > 0 && n > 0 && a > rnd ? 'BOTH PERIODS > 0, ABOVE RANDOM' : 'fails';
  };
  out.push('', 'TEST 1: COST / STOP GATE (market entry at the next open). skipped = signals whose stop is under K x 0.22%.', HEAD);
  for (const x of lines) {
    out.push('', `  ${x.name} (${x.evs.length} signals)`);
    const base = runLine(books, x.evs, 'market', null, to, true);
    out.push(statsLine('    no gate, no funding (ties to the earlier tables)'.padEnd(84), base.trades, cut));
    for (const k of [null, 5, 10, 15]) {
      const run = runLine(books, x.evs, 'market', k, to), rnd = randomAvg(books, run, 'market');
      out.push(`${statsLine(`    ${k == null ? 'no gate' : `K = ${k}${k === 10 ? ' (the test)' : ' (sensitivity)'}, stop >= ${(k * ROUND).toFixed(1)}%`}`.padEnd(84), run.trades, cut)}   skipped ${run.skipped}   random ${f2(rnd)}   ${k === 10 || k == null ? passMark(run, rnd) : ''}`);
    }
  }
  out.push('', 'TEST 2: MAKER FILLS (limit at the signal close, 2 bars, filled only when traded through by 1 tick).', HEAD);
  for (const x of lines) {
    out.push('', `  ${x.name}`);
    for (const k of [null, 10]) {
      const run = runLine(books, x.evs, 'maker', k, to), rnd = randomAvg(books, run, 'maker');
      const filled = run.trades.length, tried = filled + run.missed;
      out.push(`${statsLine(`    maker, ${k == null ? 'no gate' : 'K = 10 gate'}`.padEnd(84), run.trades, cut)}   skipped ${run.skipped}   missed ${run.missed}   fill rate ${tried ? Math.round((100 * filled) / tried) : 0}%   random ${f2(rnd)}   ${passMark(run, rnd)}`);
      out.push(statsLine('      market-entry R of the FILLED signals'.padEnd(84), run.filledMkt, cut));
      out.push(statsLine('      market-entry R of the MISSED signals'.padEnd(84), run.missedMkt, cut));
    }
  }

  // Sweep: K = 10 over every existing 15m / 1h line at market (counts only).
  out.push('', 'SWEEP: K = 10 GATE OVER EVERY EXISTING 15m / 1h LINE (selective scalp: 15m, 1h, 15m + 1h; RSI pattern catalogue: 1h), market entry, 0.22%, no funding.');
  out.push('  Gate applied to each line\'s trade list (a skipped trade does not free the coin for a later signal here; an approximation for the count).');
  type SR = SignalTrade & { j: number; risk: number; ex: Exit; d: 1 | -1; c: ReadonlyArray<Candle>; r2: (number | null)[]; atr: (number | null)[]; cap: number };
  const sweep = new Map<string, SR[]>();
  const { rows, preps } = buildScalp2Rows(data, symbols, from, to);
  for (const [key, ts] of rows) sweep.set(`scalp|${key}`, ts.map((t) => { const p = preps.get(t.sym)![t.tf]; return { ...t, c: p.c, r2: p.r, atr: p.atr, cap: t.tf === '1h' ? 120 : 192 }; }));
  for (const [sym, b] of books) {
    const dc = data[sym]?.candles['1d'] ?? [], dr = rsi(dc.map((x) => x.close), 14), busy = new Map<string, number>();
    for (const e of rsiPatterns(b.c, b.r, b.atr)) {
      const t0 = b.c[e.i]!.openTime + H, j = e.i + 1;
      if (t0 < from || j >= b.c.length) continue;
      for (const reg of ['none', 'with trend', 'range shift', 'range'] as Regime[]) {
        if (!regimeOk(reg, e.d, t0, dc, dr)) continue;
        for (const ex of ['2R', '3R', 'trail'] as Exit[]) {
          const key = `pattern|1h|${e.d > 0 ? 'long' : 'short'}|${e.pat}|${reg}|${ex}`;
          if (b.c[j]!.openTime <= (busy.get(key) ?? -Infinity)) continue;
          const tr = scalp2Trade(b.c, b.r, b.atr, j, e.stop, e.d, CAP, ex);
          if (!tr || b.c[tr.end]!.openTime + H > to) continue;
          const a = sweep.get(key) ?? [];
          a.push({ sym, t: b.c[j]!.openTime, r: tr.gross - ROUND * tr.costR, stopPct: tr.stopPct, bars: tr.bars, j, risk: e.d * (b.c[j]!.open - e.stop), ex, d: e.d, c: b.c, r2: b.r, atr: b.atr, cap: CAP });
          sweep.set(key, a);
          busy.set(key, b.c[tr.end]!.openTime + H);
        }
      }
    }
  }
  const both = (ts: SignalTrade[]) => ts.length >= 30 && avg(ts.filter((t) => t.t < cut).map((t) => t.r)) > 0 && avg(ts.filter((t) => t.t >= cut).map((t) => t.r)) > 0;
  let ungated = 0, gated = 0, gatedLines = 0;
  const chance: number[] = [0, 0, 0, 0, 0];
  for (const ts of sweep.values()) {
    if (both(ts)) ungated++;
    const g = ts.filter((t) => t.stopPct >= 10 * ROUND);
    if (g.length >= 30) gatedLines++;
    if (both(g)) gated++;
    if (g.length < 30) continue;
    for (let seed = 1; seed <= 5; seed++) {
      const rs: SignalTrade[] = [];
      for (const t of g) {
        const d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
        const tr = scalp2Trade(t.c, t.r2, t.atr, t.j, t.c[t.j]!.open - d * t.risk, d, t.cap, t.ex);
        if (tr) rs.push({ ...t, r: tr.gross - ROUND * tr.costR });
      }
      if (both(rs)) chance[seed - 1]!++;
    }
  }
  out.push(`  lines in the sweep: ${sweep.size}`,
    `  positive in both periods (n >= 30), no gate: ${ungated}`,
    `  lines that keep >= 30 trades after the K = 10 gate: ${gatedLines}`,
    `  positive in both periods after the gate: ${gated}`,
    `  chance level: the same gated lines traded in a random direction, positive in both periods: ${avg(chance).toFixed(1)} on average (5 seeds: ${chance.join(', ')})`);
  return out;
}
