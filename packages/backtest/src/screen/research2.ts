// Owner 2026-10-04 research round (research only, rules fixed before the run):
//  A. "Run some test to see what went wrong with the 3 others, try different RSI combos, maybe the one that took 600+
//     trades needs a filter of some kind" (4H ceiling short, daily momentum breakdown short, weekly bottom long).
//  B. "A triple top pattern: first RSI will spike to the 76-80+ range, the next anywhere between 76-72, then the third
//     hardly makes it past 69.5-71" - as a short on the weekly, daily and 4H.
//  C. "Explore different take profit models ... higher targets and wait out for longer times, also different stop
//     widths" - every framework model with stop widths x targets x time caps.
// Costs 0.22% per round trip, one trade at a time per coin and line, trades still open at the end are left out.

import type { Candle } from '@bot/marketdata';
import { atrWilder, ema, macdHistogram, rsi } from '../indicators';
import { momentumDownEvents, rsiCeilingEvents } from './newmodels';
import { frameworkSetups, LIVE_EXITS, RSI_MODELS, type RsiModelId, type Setup } from './rsisignals';
import { bottomDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';
import { macdCross, runTrade, statsLine, type SignalTrade } from './rsitrades';
import { exitSpecs, specTrade } from './exits';

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

// ---------------------------------------------------------------------------------------------------------------
// D. No time stops (owner 2026-10-04: "Let's eliminate time stops and let the stop losses do their thing"). Every
// framework model's own signals and stops, no time cap: exit only at the stop (fixed or trailing) or a target. Exits:
// 'current' (the model's own target / trail, cap removed), 3R / 6R / 10R targets, 3 ATR / 5 ATR trail (armed after
// +1R, as in the framework), 'stop only' (no target, fixed stop). Stop width 0.75x / 1x / 1.5x. Trades still open at
// the end are marked at the last close and counted; an open trade blocks the coin's next signal of that model.

function noCapTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, target: number | null, trail: number | null, cost = 0.0022) {
  if (j >= c.length) return null;
  const entry = c[j]!.open, risk = d * (entry - stop0);
  if (!(risk > 0)) return null;
  const tgt = target == null ? null : entry + d * target * risk;
  let stop = stop0, best = entry, armed = false;
  for (let k = j; k < c.length; k++) {
    const b = c[k]!;
    const done = (px: number) => ({ r: (d * (px - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: k - j + 1, end: k, open: false });
    if (d * (b.open - stop) <= 0) return done(b.open);
    if (d > 0 ? b.low <= stop : b.high >= stop) return done(stop);
    if (tgt != null && (d > 0 ? b.high >= tgt : b.low <= tgt)) return done(tgt);
    if (trail != null) {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - entry) >= risk) armed = true;
      const a = atr[k];
      if (armed && a != null) { const t = best - d * trail * a; if (d * (t - stop) > 0) stop = t; }
    }
  }
  const last = c[c.length - 1]!;
  return { r: (d * (last.close - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: c.length - j, end: c.length - 1, open: true };
}

export function noTimeStopReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const EXITS: { name: string; target: (cur: Setup) => number | null; trail: (cur: Setup) => number | null }[] = [
    { name: 'current exit, no cap', target: (s) => (s.exit === '3R' ? 3 : null), trail: (s) => (s.exit === 'trail' ? 3 : null) },
    { name: '3R', target: () => 3, trail: () => null }, { name: '6R', target: () => 6, trail: () => null }, { name: '10R', target: () => 10, trail: () => null },
    { name: '3 ATR trail', target: () => null, trail: () => 3 }, { name: '5 ATR trail', target: () => null, trail: () => 5 },
    { name: 'stop only', target: () => null, trail: () => null },
  ];
  const res = new Map<string, (SignalTrade & { open: boolean })[]>(), capped = new Map<RsiModelId, SignalTrade[]>();
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null || s.c[s.j]!.openTime < from) continue;
      const entry = s.c[s.j]!.open, dist = s.d * (entry - s.stop);
      if (!(dist > 0)) continue;
      // The framework as it is now (with its time cap), on the same setups.
      if (s.known > (busy.get(`${s.model}|capped`) ?? -Infinity)) {
        const t = runTrade(s.c, s.atr, s.j, s.stop, s.d, s.cap, s.exit);
        if (t && t.status !== 'open') { capped.set(s.model, [...(capped.get(s.model) ?? []), { sym, t: s.c[s.j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars }]); busy.set(`${s.model}|capped`, s.c[t.end]!.openTime + s.bar); }
      }
      for (const m of [0.75, 1, 1.5]) for (const ex of EXITS) {
        const key = `${s.model}|${m}|${ex.name}`;
        if (s.known <= (busy.get(key) ?? -Infinity)) continue;
        const t = noCapTrade(s.c, s.atr, s.j, entry - s.d * m * dist, s.d, ex.target(s), ex.trail(s));
        if (!t) continue;
        res.set(key, [...(res.get(key) ?? []), { sym, t: s.c[s.j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, open: t.open }]);
        busy.set(key, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
      }
    }
  }
  const out = [`NO TIME STOPS (test): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Exit only at the stop (fixed or trailing) or a target. Trades still open are marked at the last close ("open" = how many). Lines sorted by total R.', HEAD];
  for (const md of models) {
    out.push('', `${RSI_MODELS[md].label} (${RSI_MODELS[md].side})`, statsLine('NOW: current exit with its time cap'.padEnd(78), capped.get(md) ?? [], cut));
    const rows = [...res.entries()].filter(([k]) => k.startsWith(`${md}|`)).map(([k, ts]) => ({ k, ts, tot: ts.reduce((a, b) => a + b.r, 0) })).sort((a, b) => b.tot - a.tot);
    for (const row of rows) {
      const [, st, ex] = row.k.split('|');
      const bars = row.ts.map((t) => t.bars).sort((a, b) => a - b), med = bars[Math.floor(bars.length / 2)] ?? 0;
      out.push(statsLine(`stop ${st}x, ${ex} (open ${row.ts.filter((t) => t.open).length}, median ${med} bars, max ${bars.at(-1) ?? 0})`.padEnd(78), row.ts, cut));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// E. MACD crossover against the models again (owner 2026-10-04), with no time stops and the proposed no-cap exits:
// bottom div 10R (stop 1.5x), triple div 5 ATR trail, momentum 5 ATR trail (stop 1.5x), under-floor 5 ATR trail (stop
// 0.75x), weekly shorts 3R (stop 0.75x; 70/63 1x). MACD 12/26/9 histogram on the model's own bars (daily; 4H for
// under-floor; daily for the weekly shorts). Entries: now; filter (histogram already the trade's way at the last close);
// opposite filter (against, for comparison); cross (wait up to 30 bars for the histogram to cross the trade's way, enter
// next open; cancelled if price reaches the stop first); aligned-or-cross (now if aligned, else wait for the cross).
// The stop stays at the same price level. Exits: the model's, or also out at the close where the histogram crosses
// against the trade. Triple divergence already enters on a MACD cross (only filters / exit apply).


const NOCAP: Record<RsiModelId, { stop: number; target: number | null; trail: number | null }> = {
  'bottom-div': { stop: 1.5, target: 10, trail: null }, 'triple-div': { stop: 1, target: null, trail: 5 },
  momentum: { stop: 1.5, target: null, trail: 5 }, 'under-floor': { stop: 0.75, target: null, trail: 5 },
  'w-bear-div': { stop: 0.75, target: 3, trail: null }, 'w-top-div': { stop: 0.75, target: 3, trail: null }, 'w-high-div': { stop: 1, target: 3, trail: null },
  'd-top-div': { stop: 1, target: 3, trail: null }, 'w-dbl-bottom': { stop: 1, target: null, trail: 3 }, 'w-reclaim': { stop: 1, target: null, trail: 3 },
} as Record<RsiModelId, { stop: number; target: number | null; trail: number | null }>;

function macdExitTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, hist: ReadonlyArray<number | null>, j: number, stop0: number, d: 1 | -1, target: number | null, trail: number | null, macdExit: boolean, cost = 0.0022) {
  if (j >= c.length) return null;
  const entry = c[j]!.open, risk = d * (entry - stop0);
  if (!(risk > 0)) return null;
  const tgt = target == null ? null : entry + d * target * risk;
  let stop = stop0, best = entry, armed = false;
  for (let k = j; k < c.length; k++) {
    const b = c[k]!;
    const done = (px: number) => ({ r: (d * (px - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: k - j + 1, end: k, open: false });
    if (d * (b.open - stop) <= 0) return done(b.open);
    if (d > 0 ? b.low <= stop : b.high >= stop) return done(stop);
    if (tgt != null && (d > 0 ? b.high >= tgt : b.low <= tgt)) return done(tgt);
    const h0 = hist[k - 1], h1 = hist[k];
    if (macdExit && k > j && h0 != null && h1 != null && d * h0 > 0 && d * h1 <= 0) return done(b.close);
    if (trail != null) {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - entry) >= risk) armed = true;
      const a = atr[k];
      if (armed && a != null) { const t = best - d * trail * a; if (d * (t - stop) > 0) stop = t; }
    }
  }
  const last = c[c.length - 1]!;
  return { r: (d * (last.close - entry)) / risk - (cost * entry) / risk, stopPct: (100 * risk) / entry, bars: c.length - j, end: c.length - 1, open: true };
}

export function macdAgainReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const ENTRIES = ['now', 'MACD filter (aligned)', 'opposite filter (against)', 'MACD cross trigger', 'aligned or cross'] as const;
  const res = new Map<string, (SignalTrade & { open: boolean })[]>();
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    const busy = new Map<string, number>(), hists = new Map<ReadonlyArray<Candle>, (number | null)[]>();
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null || s.c[s.j]!.openTime < from) continue;
      const cfg = NOCAP[s.model], c = s.c, d = s.d, j0 = s.j;
      if (!hists.has(c)) hists.set(c, macdHistogram(c.map((b) => b.close)));
      const hist = hists.get(c)!;
      const entry0 = c[j0]!.open, dist = d * (entry0 - s.stop);
      if (!(dist > 0)) continue;
      const stop = entry0 - d * cfg.stop * dist, h = hist[j0 - 1];
      const aligned = h != null && d * h > 0;
      for (const en of ENTRIES) {
        if (s.model === 'triple-div' && (en === 'MACD cross trigger' || en === 'aligned or cross')) continue;
        let j: number | null = j0;
        if (en === 'MACD filter (aligned)' && !aligned) j = null;
        if (en === 'opposite filter (against)' && (aligned || h == null)) j = null;
        if (en === 'MACD cross trigger' || (en === 'aligned or cross' && !aligned)) {
          const x = macdCross(hist, j0 - 1, j0 + 29, d);
          j = x == null || x + 1 >= c.length ? null : x + 1;
          if (j != null) for (let k = j0; k < j; k++) if (d > 0 ? c[k]!.low <= stop : c[k]!.high >= stop) { j = null; break; }
        }
        if (j == null) continue;
        for (const mx of [false, true]) {
          const key = `${s.model}|${en}|${mx ? 'model exit + MACD cross-against exit' : 'model exit'}`;
          if (s.known <= (busy.get(key) ?? -Infinity)) continue;
          const t = macdExitTrade(c, s.atr, hist, j, stop, d, cfg.target, cfg.trail, mx);
          if (!t) continue;
          res.set(key, [...(res.get(key) ?? []), { sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, open: t.open }]);
          busy.set(key, t.open ? Infinity : c[t.end]!.openTime + s.bar);
        }
      }
    }
  }
  const out = [`MACD CROSSOVER AGAINST THE MODELS, NO TIME STOPS (test): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Exits: bottom div 10R (stop 1.5x), triple div / momentum / under-floor 5 ATR trail, weekly shorts 3R. Open trades marked at the last close.', HEAD];
  const all = (suffix: string) => models.flatMap((m) => res.get(`${m}|${suffix}`) ?? []);
  out.push('', 'WHOLE FRAMEWORK');
  for (const en of ENTRIES) for (const ex of ['model exit', 'model exit + MACD cross-against exit']) out.push(statsLine(`${en}, ${ex}`.padEnd(78), all(`${en}|${ex}`), cut));
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side})`);
    for (const en of ENTRIES) for (const ex of ['model exit', 'model exit + MACD cross-against exit']) {
      const ts = res.get(`${m}|${en}|${ex}`);
      if (ts) out.push(statsLine(`${en}, ${ex} (open ${ts.filter((t) => t.open).length})`.padEnd(78), ts, cut));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// F. Exit methods with no time stops (owner 2026-10-04: "experiment some more with various targets and trailing stop
// methods"). Every framework model (test models included), its own signals; stop width 1x and the proposed width. Exits:
// R targets 3 / 5 / 8 / 10 / 15 / 20; ATR trail k = 2 / 3 / 4 / 5 / 6 / 8 from the best close, armed at once / after
// +1R / after +2R; chandelier (highest high - k ATR, k 3 / 5, armed +1R); swing trail (the lowest low of the last 5 /
// 10 / 20 bars, armed +1R); EMA exit (a close under the EMA 20 / 50, armed +1R); breakeven at +1R / +2R then a 10R
// target or a 5 ATR trail; partial: half at 2R / 3R, the rest on a 5 ATR trail. Open trades are marked at the last
// close; an open trade blocks that coin's next signal of the model.

export function exitStudyReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[], specs = exitSpecs();
  const res = new Map<string, (SignalTrade & { open: boolean })[]>();
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    const busy = new Map<string, number>(), emaCache = new Map<ReadonlyArray<Candle>, Record<number, (number | null)[]>>();
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null || s.c[s.j]!.openTime < from) continue;
      if (!emaCache.has(s.c)) { const cl = s.c.map((b) => b.close); emaCache.set(s.c, { 20: ema(cl, 20), 50: ema(cl, 50) }); }
      const entry = s.c[s.j]!.open, dist = s.d * (entry - s.stop);
      if (!(dist > 0)) continue;
      for (const m of [...new Set([1, NOCAP[s.model].stop])]) for (const sp of specs) {
        const key = `${s.model}|${m}|${sp.name}`;
        if (s.known <= (busy.get(key) ?? -Infinity)) continue;
        const t = specTrade(s.c, s.atr, emaCache.get(s.c)!, s.j, entry - s.d * m * dist, s.d, sp);
        if (!t) continue;
        res.set(key, [...(res.get(key) ?? []), { sym, t: s.c[s.j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, open: t.open }]);
        busy.set(key, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
      }
    }
  }
  const out = [`EXIT METHODS, NO TIME STOPS (test): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Per model: the 15 best lines by total R, then the best line per exit family. Open trades marked at the last close (open = how many).', HEAD];
  const fam = (n: string) => (n.includes('R target') && !n.includes('breakeven') ? 'R target' : n.includes('ATR trail, armed') ? 'ATR trail' : n.split(' ')[0]!);
  for (const md of models) {
    out.push('', `${RSI_MODELS[md].label} (${RSI_MODELS[md].side}); proposed stop ${NOCAP[md].stop}x`);
    const rows = [...res.entries()].filter(([k]) => k.startsWith(`${md}|`)).map(([k, ts]) => ({ k, ts, tot: ts.reduce((a, b) => a + b.r, 0) })).sort((a, b) => b.tot - a.tot);
    const line = (row: (typeof rows)[number]) => { const [, st, ex] = row.k.split('|'); return statsLine(`stop ${st}x, ${ex} (open ${row.ts.filter((t) => t.open).length})`.slice(0, 78).padEnd(78), row.ts, cut); };
    for (const row of rows.slice(0, 15)) out.push(line(row));
    out.push('  best per exit family:');
    const seen = new Set<string>();
    for (const row of rows) { const f = fam(row.k.split('|')[2]!); if (!seen.has(f)) { seen.add(f); out.push(line(row)); } }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// G. The framework with no time stops and its live exits (LIVE_EXITS): each model, the 7 core models together, the test
// models, everything together, and by year. Open trades marked at the last close; an open trade blocks the coin's next
// signal of the same model (as live).

export function frameworkV2Report(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const res = new Map<RsiModelId, (SignalTrade & { open: boolean })[]>();
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    const busy = new Map<RsiModelId, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null || s.c[s.j]!.openTime < from) continue;
      if (s.known <= (busy.get(s.model) ?? -Infinity)) continue;
      const lx = LIVE_EXITS[s.model], entry = s.c[s.j]!.open;
      const t = specTrade(s.c, s.atr, {}, s.j, entry - lx.stopMult * (entry - s.stop), s.d, lx.spec);
      if (!t) continue;
      res.set(s.model, [...(res.get(s.model) ?? []), { sym, t: s.c[s.j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, open: t.open }]);
      busy.set(s.model, t.open ? Infinity : s.c[t.end]!.openTime + s.bar);
    }
  }
  const out = [`RSI FRAMEWORK, NO TIME STOPS, LIVE EXITS: ${day(from)} to now, ${symbols.length} coins. Costs 0.22%. Older / newer = before / after ${day(cut)}.`,
    'Open trades marked at the last close (open = how many).', HEAD];
  for (const m of models) { const ts = res.get(m) ?? []; out.push(statsLine(`${RSI_MODELS[m].label}: ${LIVE_EXITS[m].spec.name}, stop ${LIVE_EXITS[m].stopMult}x (open ${ts.filter((t) => t.open).length})`.slice(0, 78).padEnd(78), ts, cut)); }
  const core = models.filter((m) => !RSI_MODELS[m].test), test = models.filter((m) => RSI_MODELS[m].test);
  const pick = (ms: RsiModelId[]) => ms.flatMap((m) => res.get(m) ?? []);
  out.push('', statsLine('CORE 7 MODELS together'.padEnd(78), pick(core), cut), statsLine('  core longs'.padEnd(78), pick(core.filter((m) => RSI_MODELS[m].side === 'long')), cut), statsLine('  core shorts'.padEnd(78), pick(core.filter((m) => RSI_MODELS[m].side === 'short')), cut));
  out.push(statsLine('TEST MODELS together'.padEnd(78), pick(test), cut), statsLine('EVERYTHING together'.padEnd(78), pick(models), cut));
  for (const [name, ms] of [['core', core], ['everything', models]] as const) {
    const years = new Map<number, number[]>();
    for (const t of pick([...ms])) { const y = new Date(t.t).getUTCFullYear(); years.set(y, [...(years.get(y) ?? []), t.r]); }
    out.push(`  by year (${name}): ` + [...years.entries()].sort((a, b) => a[0] - b[0]).map(([y, rs]) => `${y}: ${rs.length} trades ${rs.reduce((a, b) => a + b, 0).toFixed(1)} R`).join(' | '));
  }
  return out;
}
