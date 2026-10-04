// 15m / 1h follow-up from an outside review (owner 2026-10-05: "we can test but let's talk after testing"). Research only.
// Rules fixed before the runs; nothing here is tuned on the results.
//
// 1. FILLS AND COSTS, on three frozen 1h lines only (no threshold, stop or target changed):
//    L1 = 1h short regular divergence, daily RSI < 50, 3R (RSI pattern catalogue);
//    L2 = 1h long RSI higher low, first per anchor, level 30, no direction filter, 3 ATR trail, with a 1h MACD divergence;
//    L3 = 1h short divergence, same, with a 1h MACD divergence (L2 / L3 = the two scalp lines that reached +0.05).
//    - market: as before, next open, 0.22% (taker both ways plus slippage);
//    - maker: post-only limit at the signal bar's close, live for 1 bar (1h; 2 bars on 15m). Filled only when price
//      trades THROUGH it (low < limit for a long, high > limit for a short; a touch is not a fill). Unfilled = no trade.
//      Entry at the limit; the stop counts on the fill bar, a target touched on the fill bar does not. Costs: maker in
//      0.02% + taker out 0.06% + 0.05% exit slippage = 0.13%; 0.08% (fees only) shown as the best case.
//    - adverse selection: the market-entry R of the signals that would have filled vs those that would not.
//    Gate (the reviewer's): >= +0.08 R with maker fills on research AND fresh coins, in both time splits.
// 2. FEWER SIGNALS, same three lines, market and maker:
//    - BTC and ETH only;
//    - first signal per coin per 4H swing: a signal counts only if no signal of the line was taken on that coin since the
//      last confirmed 4H pivot of the trade's kind (pivot high for shorts, low for longs; 5 bars left, 2 right);
//    - funding windows: only the first signal per coin in the 4 hours after a funding print (00:00, 08:00, 16:00 UTC).
//      Empty if the trade count falls ~70% and R does not rise.
// 5a. BTC LEAD-LAG on 15m, majors only: BTC's 15m bar moves >= 1.5x its ATR(14); an alt whose same bar moved less than
//     25% of BTC's move (in BTC's direction) is bought / sold at the next open in BTC's direction (an alt that already
//     matched is skipped). Stop 1.5 ATR(14) of the alt; exits: hold 2 / 4 / 8 bars, or 2R within 8 bars. Control: every
//     alt after the same BTC bars (no lag condition). Costs 0.22% and 0.10%; random-side baseline.
// 5b. FUNDING CARRY around the print: at a settlement with |rate| >= 0.05% (and >= 0.10%) and price within 2% of where it
//     was 8 hours before (stalling), take the side that RECEIVES funding at the print's open, hold through the next 1
//     or 2 settlements, exit at the open of the hour after. Return in % of notional = price move + funding received -
//     costs (0.22% taker, 0.13% with a maker entry). Also with a 3% stop. Random-side baseline on the price part.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi } from '../indicators';
import type { FundingPoint } from '../types';
import { macdDivergence } from './macdstate';
import { regimeOk, rsiPatterns } from './rsipatterns';
import { rsiFrameworkSignals } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { flip, lastClosed, prep, scalp2Trade, stopFor, type Exit } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, DAY = 24 * H;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '-');

/** A frozen-line signal on 1h: known at the close of bar i. */
interface Ev { sym: string; line: 'L1' | 'L2' | 'L3'; i: number; d: 1 | -1; stop: number; exit: Exit; t0: number }
const LINES = {
  L1: '1h short regular div, daily RSI < 50, 3R',
  L2: '1h long RSI higher low, first, level 30, trail, + 1h MACD div',
  L3: '1h short divergence, first, level 30, trail, + 1h MACD div',
} as const;
const CAP1H = 120;

interface Book { c: ReadonlyArray<Candle>; r: (number | null)[]; atr: (number | null)[] }

/** Post-only limit at the signal close, live `wait` bars; filled when price trades through. */
export function limitFill(c: ReadonlyArray<Candle>, i: number, d: 1 | -1, wait: number): { q: number; px: number } | null {
  const px = c[i]!.close;
  for (let q = i + 1; q <= i + wait && q < c.length; q++) if (d > 0 ? c[q]!.low < px : c[q]!.high > px) return { q, px };
  return null;
}

type T = SignalTrade & { gross: number; costR: number; filled: boolean; j: number; risk: number };

function simulate(b: Book, e: Ev, mode: 'market' | 'maker', cost: number, d: 1 | -1 = e.d, riskOverride?: number): T | null {
  if (mode === 'market') {
    const j = e.i + 1;
    if (j >= b.c.length) return null;
    const stop = riskOverride != null ? b.c[j]!.open - d * riskOverride : e.stop;
    const tr = scalp2Trade(b.c, b.r, b.atr, j, stop, d, CAP1H, e.exit);
    if (!tr) return null;
    return { sym: e.sym, t: b.c[j]!.openTime, r: tr.gross - cost * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, filled: true, j, risk: d * (b.c[j]!.open - stop) };
  }
  const f = limitFill(b.c, e.i, d, 1);
  if (!f) return null;
  const stop = riskOverride != null ? f.px - d * riskOverride : e.stop;
  const tr = scalp2Trade(b.c, b.r, b.atr, f.q, stop, d, CAP1H, e.exit, [], f.px);
  if (!tr) return null;
  return { sym: e.sym, t: b.c[f.q]!.openTime, r: tr.gross - cost * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, filled: true, j: f.q, risk: d * (f.px - stop) };
}

export function ltfCostReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const books = new Map<string, Book>();
  const evs: Ev[] = [];
  const pivots4h = new Map<string, { hi: number[]; lo: number[] }>(); // confirmation times of 4H pivots
  for (const sym of symbols) {
    const c = data[sym]?.candles['1h'] ?? [], dc = data[sym]?.candles['1d'] ?? [], c4 = data[sym]?.candles['4h'] ?? [];
    if (c.length < 500) continue;
    const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14);
    books.set(sym, { c, r, atr });
    const dr = rsi(dc.map((x) => x.close), 14);
    // L1
    for (const e of rsiPatterns(c, r, atr)) {
      if (e.d !== -1 || e.pat !== 'regular div') continue;
      const t0 = c[e.i]!.openTime + H;
      if (t0 < from || !regimeOk('with trend', -1, t0, dc, dr)) continue;
      evs.push({ sym, line: 'L1', i: e.i, d: -1, stop: e.stop, exit: '3R', t0 });
    }
    // L2 / L3
    const p = prep(c, '1h'), m = macdLines(c.map((x) => x.close));
    for (const s of p.sig.get(30)!) {
      if (!s.first) continue;
      const line = s.d > 0 && s.family === 'hl' ? 'L2' : s.d < 0 && s.family === 'div' ? 'L3' : null;
      if (!line || !macdDivergence(c, m.line, s.i, s.d)) continue;
      const t0 = c[s.i]!.openTime + H, stop = stopFor(p, s, s.i + 1);
      if (t0 < from || stop == null) continue;
      evs.push({ sym, line, i: s.i, d: s.d, stop, exit: 'trail', t0 });
    }
    // 4H pivots (price), known 2 bars after the pivot bar closes.
    const hi: number[] = [], lo: number[] = [];
    for (let k = 5; k + 2 < c4.length; k++) {
      let isH = true, isL = true;
      for (let q = k - 5; q <= k + 2; q++) { if (q === k) continue; if (c4[q]!.high >= c4[k]!.high) isH = false; if (c4[q]!.low <= c4[k]!.low) isL = false; }
      const known = c4[k + 2]!.openTime + 4 * H;
      if (isH) hi.push(known);
      if (isL) lo.push(known);
    }
    pivots4h.set(sym, { hi, lo });
  }
  evs.sort((a, b) => a.t0 - b.t0);

  // One trade at a time per coin and line; `keep` decides which signals are eligible (applied before the busy check).
  const run = (mode: 'market' | 'maker', cost: number, keep: (e: Ev) => boolean = () => true, line?: Ev['line']): T[] => {
    const busy = new Map<string, number>(), out: T[] = [];
    for (const e of evs) {
      if (line && e.line !== line) continue;
      const k = `${e.sym}|${e.line}`, b = books.get(e.sym)!;
      if (e.t0 < (busy.get(k) ?? -Infinity) || !keep(e)) continue;
      const t = simulate(b, e, mode, cost);
      if (!t || b.c[Math.min(b.c.length - 1, t.j + t.bars - 1)]!.openTime + H > to) continue;
      out.push(t);
      busy.set(k, b.c[t.j + t.bars - 1]!.openTime + H);
    }
    return out;
  };
  const randomAvg = (ts: T[], mode: 'market' | 'maker', cost: number, line: Ev['line']): number => {
    const byKey = new Map(evs.filter((e) => e.line === line).map((e) => [`${e.sym}|${e.i}`, e]));
    let sum = 0, n = 0;
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const b = books.get(t.sym)!;
      // find the event this trade came from (market: j = i + 1; maker: fill bar q = i + 1)
      const e = byKey.get(`${t.sym}|${t.j - 1}`);
      if (!e) continue;
      const d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
      const x = simulate(b, e, mode, cost, d, t.risk);
      if (x) { sum += x.r; n++; }
    }
    return n ? sum / n : NaN;
  };

  const HEAD = '  line / test                                                                            n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [
    `15m / 1h FOLLOW-UP (outside review): ${day(from)} to ${day(to)}, ${books.size} coins. Older / newer = before / after ${day(cut)}.`,
    'Frozen lines: ' + Object.entries(LINES).map(([k, v]) => `${k} = ${v}`).join('; '),
    '', '1. FILLS AND COSTS (maker = post-only limit at the signal close, 1 bar, filled only when price trades through):', HEAD,
  ];
  for (const line of ['L1', 'L2', 'L3'] as const) {
    const sig = evs.filter((e) => e.line === line).length;
    const mk = run('market', 0.22, undefined, line);
    out.push('', `  ${line}: ${LINES[line]} (${sig} signals)`);
    out.push(`${statsLine('    market, 0.22%'.padEnd(84), mk, cut)}   random ${f2(randomAvg(mk, 'market', 0.22, line))}`);
    for (const cost of [0.13, 0.08]) {
      const mm = run('maker', cost, undefined, line);
      out.push(`${statsLine(`    maker entry, ${cost.toFixed(2)}%`.padEnd(84), mm, cut)}   random ${f2(randomAvg(mm, 'maker', cost, line))}`);
    }
    // Adverse selection: the market R of the signals a limit would / would not have filled.
    const fills = new Set<string>();
    for (const e of evs) if (e.line === line && limitFill(books.get(e.sym)!.c, e.i, e.d, 1)) fills.add(`${e.sym}|${e.i}`);
    const mkE = mk.map((t) => ({ t, key: `${t.sym}|${t.j - 1}` }));
    out.push(`    fill rate ${((100 * fills.size) / Math.max(1, sig)).toFixed(0)}% of signals`);
    out.push(statsLine('    market R of the signals a limit WOULD fill'.padEnd(84), mkE.filter((x) => fills.has(x.key)).map((x) => x.t), cut));
    out.push(statsLine('    market R of the signals a limit would NOT fill'.padEnd(84), mkE.filter((x) => !fills.has(x.key)).map((x) => x.t), cut));
  }

  out.push('', '2. FEWER SIGNALS (same lines; market 0.22% / maker 0.13%):', HEAD);
  const majors = (e: Ev) => e.sym === 'BTCUSDT' || e.sym === 'ETHUSDT';
  const taken = new Map<string, number>(); // per pass: last signal time taken per coin|line
  const perSwing = (e: Ev) => {
    const pv = pivots4h.get(e.sym), list = e.d < 0 ? pv?.hi : pv?.lo;
    let last = -Infinity;
    for (const t of list ?? []) { if (t <= e.t0) last = t; else break; }
    const k = `${e.sym}|${e.line}`, prev = taken.get(k) ?? -Infinity;
    if (prev >= last) return false; // already one since the last swing
    taken.set(k, e.t0);
    return true;
  };
  const fundWin = (e: Ev) => {
    const h = new Date(e.t0).getUTCHours(), start = e.t0 - ((h % 8) * H + (e.t0 % H));
    if (h % 8 >= 4) return false;
    const k = `${e.sym}|${e.line}|fw`, prev = taken.get(k) ?? -Infinity;
    if (prev >= start) return false;
    taken.set(k, e.t0);
    return true;
  };
  for (const line of ['L1', 'L2', 'L3'] as const) {
    out.push('', `  ${line}: ${LINES[line]}`);
    for (const [name, keep] of [['all coins (as above)', () => true], ['BTC and ETH only', majors], ['first per coin per 4H swing', perSwing], ['first in the 4h after a funding print', fundWin]] as const) {
      for (const [mode, cost] of [['market', 0.22], ['maker', 0.13]] as const) {
        taken.clear();
        out.push(statsLine(`    ${name}, ${mode} ${cost}%`.padEnd(84), run(mode, cost, keep, line), cut));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 5a. BTC lead-lag on 15m (majors only).
export const LEADLAG_MAJORS = ['ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'LTCUSDT', 'DOTUSDT', 'BCHUSDT', 'SUIUSDT', 'NEARUSDT', 'UNIUSDT', 'AAVEUSDT', 'HBARUSDT', 'XLMUSDT'];

export function leadLagReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['15m'] ?? [];
  const batr = atrWilder(btc, 14);
  const imp: { t: number; d: 1 | -1; ret: number }[] = [];
  for (let i = 1; i < btc.length; i++) {
    const a = batr[i - 1], ret = btc[i]!.close / btc[i - 1]!.close - 1;
    if (a == null || btc[i]!.openTime < from) continue;
    if (Math.abs(ret) * btc[i - 1]!.close >= 1.5 * a) imp.push({ t: btc[i]!.openTime, d: ret > 0 ? 1 : -1, ret });
  }
  const exits: [string, Exit, number][] = [['hold 2 bars', 'opposite', 2], ['hold 4 bars', 'opposite', 4], ['hold 8 bars', 'opposite', 8], ['2R within 8 bars', '2R', 8]];
  type R = T & { sym: string };
  const lines = new Map<string, R[]>();
  const books = new Map<string, Book>();
  for (const sym of symbols.filter((s) => LEADLAG_MAJORS.includes(s))) {
    const c = data[sym]?.candles['15m'] ?? [];
    if (c.length < 1000) continue;
    const atr = atrWilder(c, 14), idx = new Map(c.map((b, i) => [b.openTime, i]));
    books.set(sym, { c, r: [], atr });
    const busy = new Map<string, number>();
    for (const x of imp) {
      const i = idx.get(x.t);
      if (i == null || i < 1 || i + 9 >= c.length) continue;
      const a = atr[i], alt = c[i]!.close / c[i - 1]!.close - 1;
      if (a == null) continue;
      const lag = x.d * alt < 0.25 * Math.abs(x.ret);
      const j = i + 1, stop = c[j]!.open - x.d * 1.5 * a;
      for (const [name, ex, cap] of exits) for (const group of lag ? ['lagging alt', 'every alt (control)'] : ['every alt (control)']) {
        const key = `${group}|${name}`;
        if (c[j]!.openTime < (busy.get(key) ?? -Infinity)) continue;
        const tr = scalp2Trade(c, [], atr, j, stop, x.d, cap, ex);
        if (!tr || c[tr.end]!.openTime > to) continue;
        const a2 = lines.get(key) ?? [];
        a2.push({ sym, t: c[j]!.openTime, r: tr.gross - 0.22 * tr.costR, gross: tr.gross, costR: tr.costR, stopPct: tr.stopPct, bars: tr.bars, filled: true, j, risk: x.d * (c[j]!.open - stop) });
        lines.set(key, a2);
        busy.set(key, c[tr.end]!.openTime + H / 4);
      }
    }
  }
  const rnd = (ts: R[], ex: Exit, cap: number) => {
    let s = 0, n = 0;
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const b = books.get(t.sym)!, d: 1 | -1 = flip(seed, t.sym, t.j) ? 1 : -1;
      const tr = scalp2Trade(b.c, [], b.atr, t.j, b.c[t.j]!.open - d * t.risk, d, cap, ex);
      if (tr) { s += tr.gross - 0.22 * tr.costR; n++; }
    }
    return n ? s / n : NaN;
  };
  const HEAD = '  group / exit                                                                           n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`BTC LEAD-LAG ON 15m (majors): ${day(from)} to ${day(to)}, ${books.size} alts, ${imp.length} BTC impulse bars (15m move >= 1.5 ATR). Older / newer = before / after ${day(cut)}.`, HEAD];
  for (const group of ['lagging alt', 'every alt (control)']) for (const [name, ex, cap] of exits) {
    const ts = lines.get(`${group}|${name}`) ?? [];
    out.push(`${statsLine(`  ${group}, ${name}, 0.22%`.padEnd(84), ts, cut)}   random ${f2(rnd(ts, ex, cap))}`);
    out.push(statsLine(`    same at 0.10%`.padEnd(84), ts.map((t) => ({ ...t, r: t.gross - 0.10 * t.costR })), cut));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 5b. Funding carry around the print. Returns in % of notional (not R).
export function fundingCarryReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  type P = { sym: string; t: number; pct: number; price: number; fund: number; rnd: number };
  const groups = new Map<string, P[]>();
  let coins = 0;
  for (const sym of symbols) {
    const c = data[sym]?.candles['1h'] ?? [], fs = (data[sym]?.funding ?? []).filter((f) => f.time >= from && f.time < to);
    if (c.length < 500 || fs.length < 10) continue;
    coins++;
    const idx = new Map(c.map((b, i) => [b.openTime, i]));
    const at = (t: number) => idx.get(Math.floor(t / H) * H);
    const busy = new Map<string, number>();
    for (let k = 0; k + 2 < fs.length; k++) {
      const f = fs[k]!, i0 = at(f.time), i8 = at(f.time - 8 * H);
      if (i0 == null || i8 == null) continue;
      const stall = Math.abs(c[i0]!.open / c[i8]!.open - 1) < 0.02;
      if (!stall) continue;
      const d: 1 | -1 = f.rate > 0 ? -1 : 1; // the receiving side
      for (const thr of [0.0005, 0.001]) {
        if (Math.abs(f.rate) < thr) continue;
        for (const n of [1, 2]) for (const stopPct of [null, 3]) for (const cost of [0.22, 0.13]) {
          const key = `|rate| >= ${(thr * 100).toFixed(2)}%, hold ${n} settlement${n > 1 ? 's' : ''}, ${stopPct ? '3% stop' : 'no stop'}, cost ${cost}%`;
          if (f.time < (busy.get(key) ?? -Infinity)) continue;
          const exitT = fs[k + n]!.time + H, ie = at(exitT);
          if (ie == null) continue;
          const px = c[i0]!.open;
          let out = c[ie]!.open, end = exitT;
          if (stopPct) {
            const stop = px * (1 - d * stopPct / 100);
            for (let q = i0; q < ie; q++) if (d > 0 ? c[q]!.low <= stop : c[q]!.high >= stop) { out = stop; end = c[q]!.openTime + H; break; }
          }
          const price = 100 * d * (out / px - 1);
          let fund = 0;
          for (let q = k + 1; q <= k + n; q++) if (fs[q]!.time < end) fund += -d * fs[q]!.rate * 100;
          const rnd = avg([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => (flip(s, sym, i0) ? 1 : -1) * 100 * (c[ie]!.open / px - 1)));
          const g = groups.get(key) ?? [];
          g.push({ sym, t: f.time, pct: price + fund - cost, price, fund, rnd });
          groups.set(key, g);
          busy.set(key, end);
        }
      }
    }
  }
  const out = [`FUNDING CARRY AROUND THE PRINT: ${day(from)} to ${day(to)}, ${coins} coins with funding history. Returns in % of notional per trade. Older / newer = before / after ${day(cut)}.`,
    '  rule                                                                                    n   win%   avg %   price %   funding %   avg % older / newer   random-side price %'];
  for (const [k, ps] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const old = ps.filter((p) => p.t < cut), neu = ps.filter((p) => p.t >= cut);
    out.push(`  ${k.padEnd(84)}  ${String(ps.length).padStart(4)}  ${((100 * ps.filter((p) => p.pct > 0).length) / ps.length).toFixed(0).padStart(4)}%  ${f2(avg(ps.map((p) => p.pct))).padStart(6)}  ${f2(avg(ps.map((p) => p.price))).padStart(7)}  ${f2(avg(ps.map((p) => p.fund))).padStart(9)}   ${f2(avg(old.map((p) => p.pct)))} (${old.length}) / ${f2(avg(neu.map((p) => p.pct)))} (${neu.length})   ${f2(avg(ps.map((p) => p.rnd)))}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The 15m book on the live models (option 1, exit A): a veto when the 15m RSI is already stretched >= 70 against the
//    trade at entry (rule fixed from the earlier split, not re-tuned), and a tighter stop beyond the 15m swing.
//    Tighter stop: the lowest low (highs for shorts) of the 20 closed 15m bars before entry -/+ 0.2 ATR(14) on 15m, used
//    only when tighter than the live stop. The trade is walked on 15m bars to its recorded close: if the tight stop is
//    hit first it is -1R (in tight-stop units); otherwise it ends where the live trade ended, R = live R x live risk /
//    tight risk (the live path, breakeven and target are left as they were; an approximation).
export function liveLtfReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [];
  type X = SignalTrade & { model: string; veto15: boolean; veto1h: boolean; tight: { r: number; hit: boolean } | null };
  const xs: X[] = [];
  let outside = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [], c15 = data[sym]?.candles['15m'] ?? [], c1 = data[sym]?.candles['1h'] ?? [];
    if (d1.length < 300 || c15.length < 1000) continue;
    const now = d1[d1.length - 1]!.openTime + DAY;
    const r15 = rsi(c15.map((b) => b.close), 14), r1 = rsi(c1.map((b) => b.close), 14), a15 = atrWilder(c15, 14);
    for (const row of rsiFrameworkSignals(sym, d1, h4.filter((b) => b.openTime + 4 * H <= now), now, 100_000, btc)) {
      if (row.enteredAt == null || row.enteredAt < from || row.r == null || row.variant !== 0 || !row.plans.includes('option 1') || row.closedAt == null) continue;
      const k = lastClosed(c15, H / 4, row.enteredAt), k1 = lastClosed(c1, H, row.enteredAt);
      if (k < 20 || row.enteredAt - c15[k]!.openTime > H || k1 < 0 || r15[k] == null || r1[k1] == null) { outside++; continue; }
      const d = row.side === 'long' ? 1 : -1, al = (v: number) => (d > 0 ? v : 100 - v);
      const entry = row.entry!, risk0 = (entry * row.stopPct!) / 100;
      let ext = d > 0 ? Infinity : -Infinity;
      for (let q = k - 19; q <= k; q++) ext = d > 0 ? Math.min(ext, c15[q]!.low) : Math.max(ext, c15[q]!.high);
      const a = a15[k];
      let tight: X['tight'] = null;
      if (a != null) {
        const stop = ext - d * 0.2 * a, risk = d * (entry - stop);
        if (risk > 0 && risk < risk0) {
          let hit = false;
          for (let q = k + 1; q < c15.length && c15[q]!.openTime < row.closedAt; q++) if (d > 0 ? c15[q]!.low <= stop : c15[q]!.high >= stop) { hit = true; break; }
          tight = { hit, r: hit ? -1 - (0.22 * entry) / risk / 100 : (row.r * risk0) / risk };
        }
      }
      xs.push({ sym, t: row.enteredAt, r: row.r, stopPct: row.stopPct!, bars: Math.round((row.closedAt - row.enteredAt) / DAY), model: row.model, veto15: al(r15[k]!) >= 70, veto1h: al(r1[k1]!) >= 70, tight });
    }
  }
  const HEAD = '  group                                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`LIVE MODELS WITH THE 15m BOOK (option 1, exit A): ${day(from)} to now, ${symbols.length} coins; ${xs.length} trades inside the 15m history (${outside} outside). Older / newer = before / after ${day(cut)}.`, HEAD];
  const block = (name: string, ts: X[]) => {
    if (!ts.length) return;
    out.push('', statsLine(`  ${name}: all (as live)`.padEnd(84), ts, cut));
    out.push(statsLine('    VETO: skip when the 15m RSI is >= 70 against the trade'.padEnd(84), ts.filter((x) => !x.veto15), cut));
    out.push(statsLine('      the vetoed trades'.padEnd(84), ts.filter((x) => x.veto15), cut));
    out.push(statsLine('    skip when the 1h RSI is >= 70 against (for comparison)'.padEnd(84), ts.filter((x) => !x.veto1h), cut));
    const tt = ts.filter((x) => x.tight);
    out.push(statsLine(`    trades where a 15m-swing stop is tighter (live stop)`.padEnd(84), tt, cut));
    out.push(`${statsLine(`    same trades with the 15m-swing stop`.padEnd(84), tt.map((x) => ({ ...x, r: x.tight!.r, stopPct: x.stopPct })), cut)}   stopped by it: ${tt.length ? Math.round((100 * tt.filter((x) => x.tight!.hit).length) / tt.length) : 0}%`);
  };
  block('ALL LIVE MODELS', xs);
  for (const m of [...new Set(xs.map((x) => x.model))].sort()) block(m, xs.filter((x) => x.model === m));
  return out;
}
