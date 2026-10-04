// Owner 2026-10-04 research round (research only, rules fixed before the run):
//  A. "Run some test to see what went wrong with the 3 others, try different RSI combos, maybe the one that took 600+
//     trades needs a filter of some kind" (4H ceiling short, daily momentum breakdown short, weekly bottom long).
//  B. "A triple top pattern: first RSI will spike to the 76-80+ range, the next anywhere between 76-72, then the third
//     hardly makes it past 69.5-71" - as a short on the weekly, daily and 4H.
//  C. "Explore different take profit models ... higher targets and wait out for longer times, also different stop
//     widths" - every framework model with stop widths x targets x time caps.
// Costs 0.22% per round trip, one trade at a time per coin and line, trades still open at the end are left out.

import type { Candle } from '@bot/marketdata';
import { atrWilder, ema, rsi } from '../indicators';
import { momentumDownEvents, rsiCeilingEvents } from './newmodels';
import { frameworkSetups, RSI_MODELS, type RsiModelId, type Setup } from './rsisignals';
import { bottomDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';
import { runTrade, statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Exit = number | 'hold' | 'trail'; // a number = an R-multiple target
const DAY = 86_400_000, H4 = 4 * 3_600_000, WEEK = 7 * DAY;

/** Index of the last bar closed at or before t (-1 if none). */
function lastClosed(c: ReadonlyArray<Candle>, bar: number, t: number): number {
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime + bar <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** One trade from the open of bar j with the stop; an R-multiple target, hold to the cap, or the 3 ATR trail. */
function trade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop: number, d: 1 | -1, cap: number, exit: Exit) {
  if (j >= c.length) return null;
  const entry = c[j]!.open, risk = d * (entry - stop);
  if (!(risk > 0)) return null;
  const t = typeof exit === 'number' ? runTrade(c, atr, j, stop, d, cap, 'hold', 0.0022, entry + d * exit * risk) : runTrade(c, atr, j, stop, d, cap, exit);
  return t && t.status !== 'open' ? t : null;
}
const exitName = (e: Exit) => (typeof e === 'number' ? `${e}R` : e);

/** Trades for events on bars c: entry at e.i + 1 with stop from stopOf (null = skip); one at a time. */
function eventTrades(sym: string, c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, events: ReadonlyArray<{ i: number }>, d: 1 | -1, cap: number, exit: Exit, from: number, to: number, bar: number, stopOf: (i: number) => number | null, entryOf: (i: number) => number | null = (i) => i + 1): SignalTrade[] {
  const out: SignalTrade[] = [];
  let busy = -1;
  for (const e of events) {
    if (e.i <= busy) continue;
    const j = entryOf(e.i);
    if (j == null || j >= c.length || c[j]!.openTime < from) continue;
    const s = stopOf(e.i);
    if (s == null) continue;
    const t = trade(c, atr, j, s, d, cap, exit);
    if (!t || c[t.end]!.openTime + bar > to) continue;
    out.push({ sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars });
    busy = t.end;
  }
  return out;
}
const swingStop = (c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, d: 1 | -1, n: number) => (i: number) => {
  const a = atr[i];
  if (a == null) return null;
  let x = d > 0 ? Infinity : -Infinity;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) x = d > 0 ? Math.min(x, c[k]!.low) : Math.max(x, c[k]!.high);
  return x - d * 0.5 * a;
};

/** Where price went after each event (the trade's way): average % at the horizons and the share that moved its way. */
function forwardLine(label: string, rows: { c: ReadonlyArray<Candle>; i: number; d: 1 | -1 }[], hs: number[]): string {
  const parts = hs.map((h) => {
    const xs = rows.filter((x) => x.i + h < x.c.length).map((x) => (x.d * (x.c[x.i + h]!.close / x.c[x.i]!.close - 1)) * 100);
    const avg = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return `+${h} bars: ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% (${xs.length ? Math.round((100 * xs.filter((x) => x > 0).length) / xs.length) : 0}% its way)`;
  });
  return `  ${label.padEnd(60)} n=${String(rows.length).padStart(5)}  ${parts.join('  ')}`;
}

const HEAD = '  model / variant                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';

// ---------------------------------------------------------------------------------------------------------------
// A. What went wrong with the three failed models.
// 4H ceiling short filters (each fixed before the run): daily RSI >= 70 at the last daily close; weekly RSI >= 70 at the
// last completed week; daily close under / over the daily EMA 50; BTC daily RSI < 50; 'ceiling divergence' = after the
// ceiling, the next 4H RSI pivot high within 30 bars that is lower while price makes a higher high (enter next open,
// stop over the highest high since the ceiling + 0.5 ATR); 'RSI fade' = the first 4H close under 60 within 30 bars of
// the ceiling (same stop). Exits 1.5R / 2R / 3R / hold 10 days.
// Momentum breakdown short: daily RSI under 20 / 25 / 30 / 35, weekly over 38 (mirror) / under 50 (bear regime) / any;
// stop over the last 3 / 10 days' high + 0.5 ATR; 2R / 3R / hold 30 days.
// Weekly long: 'weekly reclaim' = the first weekly close with RSI over X after a weekly close <= Y within 12 weeks
// (30 -> 35, 35 -> 40, 40 -> 45); 'weekly double bottom' = bottomDivEvents with first <= 35, second <= 45, price within
// 5% of the first low; entry next daily open after the week closes, stop under the last 20 days' low - 0.5 ATR;
// 3R / 5R / trail / hold 91 days.

export function diagnoseReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [`WHAT WENT WRONG WITH THE THREE NEW MODELS (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`];
  const btc = data.BTCUSDT?.candles['1d'] ?? [], btcR = rsi(btc.map((b) => b.close), 14);

  // A1. 4H ceiling short.
  out.push('', 'A1. 4H RSI CEILING SHORT: where price went after the signal (the short\'s way; 6 bars = 1 day)');
  type Filt = 'none' | 'daily RSI >= 70' | 'weekly RSI >= 70' | 'daily under EMA50' | 'daily over EMA50' | 'BTC daily RSI < 50' | 'ceiling divergence entry' | 'RSI fade < 60 entry';
  const FILTS: Filt[] = ['none', 'daily RSI >= 70', 'weekly RSI >= 70', 'daily under EMA50', 'daily over EMA50', 'BTC daily RSI < 50', 'ceiling divergence entry', 'RSI fade < 60 entry'];
  const fwd: { c: ReadonlyArray<Candle>; i: number; d: 1 | -1 }[] = [];
  const perFilt = new Map<string, SignalTrade[]>();
  for (const sym of symbols) {
    const c = data[sym]?.candles['4h'] ?? [], d1 = data[sym]?.candles['1d'] ?? [];
    if (c.length < 300 || d1.length < 60) continue;
    const r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
    const rd = rsi(d1.map((b) => b.close), 14), e50 = ema(d1.map((b) => b.close), 50), w = weeklyFromDaily(d1), rw = rsi(w.map((b) => b.close), 14);
    const ev = rsiCeilingEvents(r).filter((e) => c[e.i]!.openTime >= from);
    for (const e of ev) fwd.push({ c, i: e.i, d: -1 });
    for (const f of FILTS) for (const exit of [1.5, 2, 3, 'hold'] as Exit[]) {
      let events: { i: number }[] = ev, entryOf = (i: number): number | null => i + 1, stopOf = swingStop(c, atr, -1, 10);
      const kd = (i: number) => lastClosed(d1, DAY, c[i]!.openTime + H4), kw = (i: number) => lastClosed(w, WEEK, c[i]!.openTime + H4);
      if (f === 'daily RSI >= 70') events = ev.filter((e) => { const k = kd(e.i); return k >= 0 && (rd[k] ?? 0) >= 70; });
      if (f === 'weekly RSI >= 70') events = ev.filter((e) => { const k = kw(e.i); return k >= 0 && (rw[k] ?? 0) >= 70; });
      if (f === 'daily under EMA50') events = ev.filter((e) => { const k = kd(e.i); return k >= 0 && e50[k] != null && d1[k]!.close < e50[k]!; });
      if (f === 'daily over EMA50') events = ev.filter((e) => { const k = kd(e.i); return k >= 0 && e50[k] != null && d1[k]!.close > e50[k]!; });
      if (f === 'BTC daily RSI < 50') events = ev.filter((e) => { const k = lastClosed(btc, DAY, c[e.i]!.openTime + H4); return k >= 0 && (btcR[k] ?? 100) < 50; });
      if (f === 'ceiling divergence entry' || f === 'RSI fade < 60 entry') {
        const trig = new Map<number, number>();
        for (const e of ev) {
          let hh = c[e.i]!.high;
          for (let k = e.i + 1; k < Math.min(c.length - 1, e.i + 31); k++) {
            hh = Math.max(hh, c[k]!.high);
            if (f === 'RSI fade < 60 entry') { if ((r[k] ?? 100) < 60) { trig.set(e.i, k); break; } continue; }
            const p = k - 2; // pivot high confirmed 2 bars later
            if (p <= e.i + 2) continue;
            let piv = true;
            for (let q = p - 3; q <= p + 2; q++) if (q !== p && (r[q] ?? 0) >= (r[p] ?? 0)) piv = false;
            if (piv && (r[p] ?? 100) < (r[e.i] ?? 0) && c[p]!.high >= c[e.i]!.high) { trig.set(e.i, k); break; }
          }
        }
        events = ev.filter((e) => trig.has(e.i));
        entryOf = (i) => trig.get(i)! + 1;
        stopOf = (i) => { const k = trig.get(i)!, a = atr[k]; if (a == null) return null; let hh = -Infinity; for (let q = i; q <= k; q++) hh = Math.max(hh, c[q]!.high); return hh + 0.5 * a; };
      }
      const key = `${f}|${exitName(exit)}`;
      perFilt.set(key, [...(perFilt.get(key) ?? []), ...eventTrades(sym, c, atr, events, -1, 60, exit, from, to, H4, stopOf, entryOf)]);
    }
  }
  out.push(forwardLine('every 4H ceiling signal', fwd, [6, 30, 60]), HEAD);
  for (const f of FILTS) for (const exit of [1.5, 2, 3, 'hold'] as Exit[]) out.push(statsLine(`${f}, ${exitName(exit)}`.padEnd(78), perFilt.get(`${f}|${exitName(exit)}`) ?? [], cut));

  // A2. Daily momentum breakdown short.
  out.push('', 'A2. DAILY MOMENTUM BREAKDOWN SHORT: forward moves and RSI / weekly / stop / exit combos');
  const W2 = [['weekly > 38 (mirror)', (v: number) => v > 38], ['weekly < 50 (bear regime)', (v: number) => v < 50], ['any weekly', () => true]] as const;
  const fwd2 = new Map<string, { c: ReadonlyArray<Candle>; i: number; d: 1 | -1 }[]>();
  const res2 = new Map<string, SignalTrade[]>();
  for (const sym of symbols) {
    const c = [...(data[sym]?.candles['1d'] ?? [])];
    if (c.length < 120) continue;
    const r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
    for (const lo of [20, 25, 30, 35]) for (const [wn, wf] of W2) {
      const all = momentumDownEvents(c, r, lo, -1), w = weeklyFromDaily(c), rw = rsi(w.map((b) => b.close), 14);
      const ev = all.filter((e) => { const k = lastClosed(w, WEEK, c[e.i]!.openTime + DAY); return k >= 0 && rw[k] != null && wf(rw[k]!) && c[e.i]!.openTime >= from; });
      const fk = `RSI < ${lo}, ${wn}`;
      fwd2.set(fk, [...(fwd2.get(fk) ?? []), ...ev.map((e) => ({ c, i: e.i, d: -1 as const }))]);
      for (const sn of [3, 10]) for (const exit of [2, 3, 'hold'] as Exit[]) {
        const key = `${fk}, ${sn}-day stop, ${exitName(exit)}`;
        res2.set(key, [...(res2.get(key) ?? []), ...eventTrades(sym, c, atr, ev, -1, 30, exit, from, to, DAY, swingStop(c, atr, -1, sn))]);
      }
    }
  }
  for (const [k, rows] of fwd2) out.push(forwardLine(k, rows, [5, 10, 30]));
  out.push(HEAD);
  for (const [k, ts] of res2) out.push(statsLine(k.padEnd(78), ts, cut));

  // A3. Weekly long.
  out.push('', 'A3. WEEKLY LONG: other RSI combos (traded on daily bars from the open after the weekly close)');
  const res3 = new Map<string, SignalTrade[]>(), fwd3 = new Map<string, { c: ReadonlyArray<Candle>; i: number; d: 1 | -1 }[]>();
  for (const sym of symbols) {
    const dd = data[sym]?.candles['1d'] ?? [], w = weeklyFromDaily(dd);
    if (w.length < 40) continue;
    const rw = rsi(w.map((b) => b.close), 14), atr = atrWilder(dd, 14);
    const kinds: [string, WeeklyEvent[]][] = [];
    for (const [y, x] of [[30, 35], [35, 40], [40, 45]] as [number, number][]) {
      const ev: WeeklyEvent[] = [];
      let lastUnder = -Infinity;
      for (let i = 1; i < w.length; i++) {
        const v = rw[i], pv = rw[i - 1];
        if (v == null || pv == null) continue;
        if (pv <= y) lastUnder = i - 1;
        if (v > x && pv <= x && i - lastUnder <= 12) ev.push({ i, d: 1, kind: 'reclaim' });
      }
      kinds.push([`weekly reclaim: RSI <= ${y!} then over ${x!}`, ev]);
    }
    kinds.push(['weekly double bottom: <= 35 then <= 45, price within 5%', bottomDivEvents(w, rw, 35, 45, 'bottom-div', 0.05, 5, 3, 40)]);
    for (const [name, wev] of kinds) {
      const ev: { i: number }[] = [];
      for (const e of wev) { const j = dd.findIndex((b) => b.openTime >= w[e.i]!.openTime + WEEK); if (j > 0 && dd[j]!.openTime >= from) ev.push({ i: j - 1 }); }
      fwd3.set(name, [...(fwd3.get(name) ?? []), ...ev.map((e) => ({ c: dd, i: e.i, d: 1 as const }))]);
      for (const exit of [3, 5, 'trail', 'hold'] as Exit[]) {
        const key = `${name}, 20-day low stop, 91d, ${exitName(exit)}`;
        res3.set(key, [...(res3.get(key) ?? []), ...eventTrades(sym, dd, atr, ev, 1, 91, exit, from, to, DAY, swingStop(dd, atr, 1, 20))]);
      }
    }
  }
  for (const [k, rows] of fwd3) out.push(forwardLine(k, rows, [10, 30, 60]));
  out.push(HEAD);
  for (const [k, ts] of res3) out.push(statsLine(k.padEnd(78), ts, cut));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// B. RSI triple top (owner): three RSI 14 pivot highs within `span` bars, each lower: A >= aMin, B in [bLo, bHi),
// C in [cLo, cHi]; owner's levels A >= 76, B 72-76, C 69.5-71.5, also shifted -3 / +3 together and a loose C (68-72).
// 'price' = the C price high at or above the A price high less 1% (a triple top in price too); 'any' = no price rule.
// Short at the open after C is confirmed (3 bars), stop over the highest high from A to C + 0.5 ATR; 2R / 3R / 5R /
// hold. Daily and 4H on their own bars (cap 60 bars), weekly on daily bars from the open after the week (cap 91 days).

export function tripleTopEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, aMin: number, bLo: number, bHi: number, cLo: number, cHi: number, price: boolean, span = 60, left = 5, right = 3): (WeeklyEvent & { a: number })[] {
  const highs: number[] = [], out: (WeeklyEvent & { a: number })[] = [], used = new Set<number>();
  for (let i = right; i < c.length; i++) {
    const k = i - right, v = r[k];
    if (v == null || k - left < 0) continue;
    let ok = true;
    for (let j = k - left; j <= k + right && ok; j++) { const x = r[j]; if (j !== k && (x == null || x > v || (x === v && j < k))) ok = false; }
    if (!ok) continue;
    if (v >= cLo && v <= cHi) {
      for (const a of highs) {
        if (used.has(a) || k - a > span || r[a]! < aMin) continue;
        const b = highs.find((q) => q > a && q < k && q - a >= 3 && k - q >= 3 && r[q]! >= bLo && r[q]! < bHi && r[q]! < r[a]! && r[q]! > v);
        if (b != null && (!price || c[k]!.high >= c[a]!.high * 0.99)) { out.push({ i, d: -1, kind: 'top-div', a }); used.add(a); break; }
      }
    }
    highs.push(k);
  }
  return out;
}

export function tripleTopReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [`RSI TRIPLE TOP SHORT (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`, HEAD];
  const GRID: [string, number, number, number, number, number][] = [
    ['owner: A>=76, B 72-76, C 69.5-71.5', 76, 72, 76, 69.5, 71.5],
    ['shift -3: A>=73, B 69-73, C 66.5-68.5', 73, 69, 73, 66.5, 68.5],
    ['shift +3: A>=79, B 75-79, C 72.5-74.5', 79, 75, 79, 72.5, 74.5],
    ['loose C: A>=76, B 72-76, C 68-72', 76, 72, 76, 68, 72],
  ];
  for (const tf of ['1w', '1d', '4h'] as const) for (const g of GRID) for (const price of [false, true]) for (const exit of [2, 3, 5, 'hold'] as Exit[]) {
    const all: SignalTrade[] = [];
    let sig = 0;
    for (const sym of symbols) {
      const dd = data[sym]?.candles['1d'] ?? [];
      const c = tf === '4h' ? data[sym]?.candles['4h'] ?? [] : tf === '1d' ? dd : weeklyFromDaily(dd);
      if (c.length < 60) continue;
      const r = rsi(c.map((b) => b.close), 14);
      const ev = tripleTopEvents(c, r, g[1], g[2], g[3], g[4], g[5], price, tf === '1w' ? 40 : 60, tf === '1w' ? 3 : 5, tf === '1w' ? 2 : 3);
      sig += ev.length;
      if (tf === '1w') {
        const atr = atrWilder(dd, 14), evd: { i: number; hh: number }[] = [];
        for (const e of ev) {
          const j = dd.findIndex((b) => b.openTime >= c[e.i]!.openTime + WEEK);
          if (j <= 0) continue;
          let hh = -Infinity;
          for (let q = e.a; q <= e.i; q++) hh = Math.max(hh, c[q]!.high);
          evd.push({ i: j - 1, hh });
        }
        all.push(...eventTrades(sym, dd, atr, evd, -1, 91, exit, from, to, DAY, (i) => { const x = evd.find((y) => y.i === i)!, a = atr[i]; return a == null ? null : x.hh + 0.5 * a; }));
      } else {
        const atr = atrWilder(c, 14), bar = tf === '4h' ? H4 : DAY;
        const hhOf = new Map(ev.map((e) => { let hh = -Infinity; for (let q = e.a; q <= e.i; q++) hh = Math.max(hh, c[q]!.high); return [e.i, hh] as const; }));
        all.push(...eventTrades(sym, c, atr, ev, -1, 60, exit, from, to, bar, (i) => { const a = atr[i]; return a == null ? null : hhOf.get(i)! + 0.5 * a; }));
      }
    }
    out.push(statsLine(`${tf} ${g[0]}, ${price ? 'price tops' : 'any price'}, ${exitName(exit)} (${sig} signals)`.padEnd(78), all, cut));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// C. Take-profit / stop / time variants of every framework model (its own signals and entries): stop width 0.75x /
// 1x / 1.5x / 2x the model's stop distance; exit 2R / 3R / 4R / 6R / 10R / 3 ATR trail / hold; time cap 1x / 2x the
// model's. The current setting is marked '*'. R is per the trade's own risk (wider stop = smaller size).

export function tpGridReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const STOPS = [0.75, 1, 1.5, 2], EXITS: Exit[] = [2, 3, 4, 6, 10, 'trail', 'hold'], CAPS = [1, 2];
  const res = new Map<string, SignalTrade[]>();
  const current: Record<string, Exit> = {};
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4) as Setup[]) {
      if (s.j == null || s.j >= s.c.length || s.stop == null || s.c[s.j]!.openTime < from) continue;
      current[s.model] = s.exit === '3R' ? 3 : s.exit;
      const entry = s.c[s.j]!.open, dist = s.d * (entry - s.stop);
      if (!(dist > 0)) continue;
      for (const m of STOPS) for (const ex of EXITS) for (const cm of CAPS) {
        const key = `${s.model}|${m}|${exitName(ex)}|${cm}`;
        if (s.known <= (busy.get(key) ?? -Infinity)) continue;
        const t = trade(s.c, s.atr, s.j, entry - s.d * m * dist, s.d, s.cap * cm, ex);
        if (!t || s.c[t.end]!.openTime + s.bar > to) continue;
        res.set(key, [...(res.get(key) ?? []), { sym, t: s.c[s.j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars }]);
        busy.set(key, s.c[t.end]!.openTime + s.bar);
      }
    }
  }
  const out = [`TAKE PROFIT / STOP / TIME VARIANTS OF THE FRAMEWORK MODELS (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'stop = x the model\'s stop distance; exit = R target / 3 ATR trail / hold to the cap; cap = x the model\'s time cap. * = current setting. Lines sorted by total R.', HEAD];
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side}); current: stop 1x, ${exitName(current[m] ?? 'hold')}, cap 1x`);
    const rows = [...res.entries()].filter(([k]) => k.startsWith(`${m}|`)).map(([k, ts]) => ({ k, ts, tot: ts.reduce((a, b) => a + b.r, 0) })).sort((a, b) => b.tot - a.tot);
    for (const row of rows) {
      const [, st, ex, cm] = row.k.split('|');
      const star = st === '1' && ex === exitName(current[m] ?? 'hold') && cm === '1' ? ' *' : '';
      out.push(statsLine(`stop ${st}x, ${ex}, cap ${cm}x${star}`.padEnd(78), row.ts, cut));
    }
  }
  return out;
}
