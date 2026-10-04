// Weekly double bottom: stop placement and daily / 4H entry timing (owner 2026-10-05, after the BEAMX trade: "a better
// entry would have been ideal, I guess that comes down to daily and 4 hr timing"; and a stop test). Research only.
// Setups are the live model's (weekly RSI low <= 35, then a higher low <= 45 with price within 5% of the first low;
// known when the week closes). Rules fixed before the run:
//
// Stops (level fixed when the week closes; size scales so the loss at the stop is 1R):
//   S0 = live: under the 20-day low - 0.5 daily ATR(14);
//   S1 = under the higher-low week's own low - 0.5 ATR (the pattern low);
//   S2 = under the 10-day low - 0.5 ATR;
//   S3 = under the signal week's low - 0.5 ATR.
// Entries, all within 10 days of the week's close (unfilled = missed; a setup whose stop trades first is dead):
//   E0 = live: the next daily open;
//   E1 = daily pullback: a limit 1 daily ATR under the week's close, filled when a daily low trades under it;
//   E2 = 4H timing: the first 4H close with RSI 14 <= 40, entry at the next 4H open;
//   E3 = daily timing: the first daily close with RSI 14 <= 45, entry at the next daily open.
// Live rules (option 1): skip late (> 3 ATR above the 10-day low at the actual entry); breakeven at +2R on a daily close.
// Exits: A = hold 91 days; B = 20R target, 91 days. Trades simulated on daily bars from the entry price; on the entry
// day the stop counts and a target does not. Costs 0.22% in R. Trades still open are marked at the last close (as the
// live signal list does). One trade per coin at a time; missed setups do not block. Random = same entries and stop
// distances with the side by coin flip (20 seeds).

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import { bottomDivEvents, weeklyFromDaily } from './rsimap';
import { LATE_ATR, BE_R, frameworkSetups, runBeforeEntry } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { flip } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, H4 = 4 * 3_600_000, WAIT_DAYS = 10, CAP = 91, COST = 0.22;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** A trade on daily bars entered at `px` during day q. Target 0 = none. Open at the data end = marked at the last close. */
export function dayTrade(c: ReadonlyArray<Candle>, q: number, px: number, stop0: number, d: 1 | -1, target: number, entryAtOpen: boolean): { r: number; endT: number; open: boolean } | null {
  const risk = d * (px - stop0);
  if (!(risk > 0) || q >= c.length) return null;
  const tgt = target ? px + d * target * risk : null, last = Math.min(c.length - 1, q + CAP - 1);
  let stop = stop0;
  for (let i = q; i <= last; i++) {
    const b = c[i]!;
    if (i > q && d * (b.open - stop) <= 0) return { r: (d * (b.open - px)) / risk - (COST * px) / risk / 100, endT: b.openTime + DAY, open: false };
    if (d > 0 ? b.low <= stop : b.high >= stop) return { r: (d * (stop - px)) / risk - (COST * px) / risk / 100, endT: b.openTime + DAY, open: false };
    if (tgt != null && (i > q || entryAtOpen) && (d > 0 ? b.high >= tgt : b.low <= tgt)) { const out = i > q && d * (b.open - tgt) >= 0 ? b.open : tgt; return { r: (d * (out - px)) / risk - (COST * px) / risk / 100, endT: b.openTime + DAY, open: false }; }
    if (d * (b.close - px) >= BE_R * risk && d * (px - stop) > 0) stop = px; // breakeven on a close at +2R
  }
  const open = last === c.length - 1 && q + CAP - 1 > c.length - 1;
  return { r: (d * (c[last]!.close - px)) / risk - (COST * px) / risk / 100, endT: c[last]!.openTime + DAY, open };
}

const lowOf = (c: ReadonlyArray<Candle>, a: number, b: number) => { let lo = Infinity; for (let k = Math.max(0, a); k <= b; k++) lo = Math.min(lo, c[k]!.low); return lo; };

type Entry = 'E0' | 'E1' | 'E2' | 'E3';
type Stop = 'S0' | 'S1' | 'S2' | 'S3';
const ENTRY_NAME: Record<Entry, string> = { E0: 'E0 next daily open (live)', E1: 'E1 daily limit 1 ATR under the close', E2: 'E2 first 4H RSI <= 40', E3: 'E3 first daily RSI <= 45' };
const STOP_NAME: Record<Stop, string> = { S0: 'S0 20-day low (live)', S1: 'S1 higher-low week low', S2: 'S2 10-day low', S3: 'S3 signal week low' };

interface Setup { sym: string; c: ReadonlyArray<Candle>; atr: (number | null)[]; dr: (number | null)[]; h4: ReadonlyArray<Candle>; r4: (number | null)[]; j0: number; known: number; stops: Record<Stop, number> }

/** Where the entry happens: day index, price, and whether it is the day's open. Null = missed (or the stop traded first). */
function entryFor(s: Setup, e: Entry, stop: number): { q: number; px: number; atOpen: boolean } | null {
  const { c, j0 } = s;
  if (j0 >= c.length) return null;
  const end = s.known + WAIT_DAYS * DAY;
  if (e === 'E0') return { q: j0, px: c[j0]!.open, atOpen: true };
  if (e === 'E1') {
    const a = s.atr[j0 - 1];
    if (a == null) return null;
    const lim = c[j0 - 1]!.close - a;
    for (let q = j0; q < c.length && c[q]!.openTime < end; q++) {
      if (c[q]!.open <= lim) return c[q]!.open > stop ? { q, px: c[q]!.open, atOpen: true } : null; // gapped through: filled at the open
      if (c[q]!.low < lim) return lim > stop ? { q, px: lim, atOpen: false } : null;
      if (c[q]!.low <= stop) return null;
    }
    return null;
  }
  if (e === 'E3') {
    for (let q = j0 - 1; q + 1 < c.length && c[q + 1]!.openTime < end; q++) {
      if (q >= j0 && c[q]!.low <= stop) return null;
      const v = s.dr[q];
      if (v != null && v <= 45) return c[q + 1]!.open > stop ? { q: q + 1, px: c[q + 1]!.open, atOpen: true } : null;
    }
    return null;
  }
  // E2: 4H bars from the week's close.
  let k = s.h4.findIndex((b) => b.openTime >= s.known);
  if (k < 1) return null;
  for (k = k - 1; k + 1 < s.h4.length && s.h4[k + 1]!.openTime < end; k++) {
    if (s.h4[k]!.openTime >= s.known && s.h4[k]!.low <= stop) return null;
    const v = s.r4[k];
    if (s.h4[k]!.openTime + H4 >= s.known && v != null && v <= 40) {
      const t = s.h4[k + 1]!.openTime, px = s.h4[k + 1]!.open;
      const q = c.findIndex((b) => b.openTime <= t && t < b.openTime + DAY);
      if (q < 0 || px <= stop) return null;
      return { q, px, atOpen: t === c[q]!.openTime };
    }
  }
  return null;
}

export function weeklyDoubleBottomReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const setups: Setup[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const c = [...d1], atr = atrWilder(c, 14), dr = rsi(c.map((b) => b.close), 14), r4 = rsi(h4.map((b) => b.close), 14);
    const w = weeklyFromDaily(d1), rw = rsi(w.map((b) => b.close), 14);
    const ev = bottomDivEvents(w, rw, 35, 45, 'bottom-div', 0.05, 5, 3, 40);
    for (const st of frameworkSetups(d1, []).filter((x) => x.model === 'w-dbl-bottom')) {
      if (st.j == null || st.stop == null || st.known < from) continue;
      const e = ev.find((x) => w[x.i]!.openTime + 7 * DAY === st.known);
      const a = atr[st.j - 1];
      if (!e || a == null) continue;
      const j0 = st.j;
      setups.push({ sym, c, atr, dr, h4, r4, j0, known: st.known, stops: {
        S0: st.stop, S1: w[e.i - 3]!.low - 0.5 * a, S2: lowOf(c, j0 - 10, j0 - 1) - 0.5 * a, S3: w[e.i]!.low - 0.5 * a,
      } });
    }
  }
  setups.sort((a, b) => a.known - b.known);
  type T = SignalTrade & { q: number; px: number; dist: number; atOpen: boolean; s: Setup; target: number };
  const run = (e: Entry, sk: Stop, target: number) => {
    const busy = new Map<string, number>(), trades: T[] = [];
    let missed = 0, late = 0;
    for (const s of setups) {
      if (s.known < (busy.get(s.sym) ?? -Infinity)) continue;
      const stop = s.stops[sk], en = entryFor(s, e, stop);
      if (!en) { missed++; continue; }
      if (runBeforeEntry(s.c, s.atr, en.q, 1, en.px) > LATE_ATR) { late++; continue; }
      const tr = dayTrade(s.c, en.q, en.px, stop, 1, target, en.atOpen);
      if (!tr) { missed++; continue; }
      trades.push({ sym: s.sym, t: s.c[en.q]!.openTime, r: tr.r, stopPct: (100 * (en.px - stop)) / en.px, bars: Math.round((tr.endT - s.c[en.q]!.openTime) / DAY), q: en.q, px: en.px, dist: en.px - stop, atOpen: en.atOpen, s, target });
      busy.set(s.sym, tr.open ? Infinity : tr.endT);
    }
    return { trades, missed, late };
  };
  const random = (ts: T[]) => {
    const rs: number[] = [];
    for (let seed = 1; seed <= 20; seed++) for (const t of ts) {
      const d: 1 | -1 = flip(seed, t.sym, t.q) ? 1 : -1;
      const x = dayTrade(t.s.c, t.q, t.px, t.px - d * t.dist, d, t.target, t.atOpen);
      if (x) rs.push(x.r);
    }
    return avg(rs);
  };
  const HEAD = '  exit / entry / stop                                                                    n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`WEEKLY DOUBLE BOTTOM: STOP AND DAILY / 4H ENTRY TIMING: ${day(from)} to now, ${symbols.length} coins, ${setups.length} setups. Older / newer = before / after ${day(cut)}.`,
    'R is per unit of risk (size scales with the stop). Missed = no fill in 10 days or the stop traded first; late = skipped by the 3 ATR rule at the actual entry.'];
  for (const [ex, target] of [['A: hold 91 days, breakeven +2R', 0], ['B: 20R target, 91 days, breakeven +2R', 20]] as const) {
    out.push('', `EXIT ${ex}`, HEAD);
    for (const e of ['E0', 'E1', 'E2', 'E3'] as Entry[]) for (const sk of ['S0', 'S1', 'S2', 'S3'] as Stop[]) {
      const r = run(e, sk, target);
      out.push(`${statsLine(`  ${ENTRY_NAME[e]} | ${STOP_NAME[sk]}`.padEnd(84), r.trades, cut)}   missed ${r.missed}   late ${r.late}   random ${random(r.trades).toFixed(2)}`);
    }
  }
  return out;
}
