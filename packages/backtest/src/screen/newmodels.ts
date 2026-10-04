// New RSI framework models to fill the gaps (owner 2026-10-04: "do we have enough long and short models for various
// time frames? ... Please begin number 2"). The framework had daily / 4H longs and only weekly shorts, no weekly long.
// Research only, rules fixed before the run (mirrors of the existing models):
//  1. 4H over-ceiling short: 4H RSI 14 enters the band of 5 under its own running maximum (250 bars warm-up, 10-bar
//     cool-down): 'ceiling' = touch, 'over-ceiling' = a new maximum. Next open, stop over the 10-bar high + 0.5 ATR,
//     hold 60 bars (10 days) or 3R. Also with the LuxAlgo visible-range daily SUPPLY filter (the signal bar touches it).
//  2. Daily bearish divergences: topDivEvents on daily bars (82/75, 79/75 and 70/60) and the generic RSI 14 bearish
//     divergence; entry next open (stop over the 10-day high + 0.5 ATR) or a daily breakdown (a close under the prior
//     5-day low within 20 days, stop over the highest high since the signal + 0.5 ATR); 3R or hold, 60 days.
//  3. Daily momentum breakdown short: the first daily close with RSI 14 under 25 (the day before >= 25) while the last
//     completed week's RSI 14 is over 38; stop over the last 3 days' high + 0.5 ATR; hold 30 days or 3R.
//  4. Weekly bottom divergence long: bottomDivEvents on weekly bars (20/30, 25/35, 30/40), known at the weekly close;
//     entry on a daily breakout (a close over the prior 5-day high within 20 days, stop under the lowest low since 7 days
//     before the signal - 0.5 ATR) or next daily open with a 10-day swing stop; 3R or hold, 91 days.
// Every RSI threshold is also run -3 / +3. One trade at a time per coin and line; costs 0.22%.

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import { bottomDivEvents, divergenceEvents, topDivEvents, weeklyFromDaily, type WeeklyEvent } from './rsimap';
import { simulateFrom, simulateSignal, statsLine, tightStopTrade, type SignalTrade, type TradeExit } from './rsitrades';
import { sdVisibleRange } from './sdzones';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, H4 = 4 * 3_600_000;

/** Mirror of rsiFloorEvents: RSI within `band` of its own running maximum. */
export function rsiCeilingEvents(r: ReadonlyArray<number | null>, band = 5, warm = 250, cool = 10): (WeeklyEvent & { ceiling: number })[] {
  const out: (WeeklyEvent & { ceiling: number })[] = [];
  let hi = -Infinity, seen = 0, last = -Infinity, prevIn = false;
  for (let i = 0; i < r.length; i++) {
    const v = r[i];
    if (v == null || !Number.isFinite(v)) continue;
    const ready = seen >= warm, inZone = ready && v >= hi - band;
    if (inZone && !prevIn && i - last >= cool) { out.push({ i, d: -1, kind: v > hi ? 'over-ceiling' : 'ceiling', ceiling: hi }); last = i; }
    prevIn = inZone;
    hi = Math.max(hi, v);
    seen++;
  }
  return out;
}

/** Mirror of momentumEvents: first daily close with RSI under `lo` while the last completed week's RSI is over `wMin`. */
export function momentumDownEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, lo = 25, wMin = 38): WeeklyEvent[] {
  const w = weeklyFromDaily(c), rw = rsi(w.map((b) => b.close), 14), WEEK = 7 * DAY, out: WeeklyEvent[] = [];
  let k = -1;
  for (let i = 1; i < c.length; i++) {
    while (k + 1 < w.length && w[k + 1]!.openTime + WEEK <= c[i]!.openTime + DAY) k++;
    const v = r[i], pv = r[i - 1], wv = k >= 0 ? rw[k] : null;
    if (v != null && pv != null && wv != null && v < lo && pv >= lo && wv > wMin) out.push({ i, d: -1, kind: 'flip' });
  }
  return out;
}

/** Mirror of luxDailyDemandTouched: the signal bar touches the LuxAlgo visible-range supply zone on the daily. */
export function luxDailySupplyTouched(d1: ReadonlyArray<Candle>, signalBar: Candle, known: number): boolean {
  let lo = 0, hi = d1.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= known) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 20) return false;
  const z = sdVisibleRange(d1, idx, 150).supply;
  return z != null && z.bottom <= signalBar.high && z.top >= signalBar.low;
}

/** A signal on bars `c` at index e.i, traded on bars `c`: next open with a 10-bar swing stop, or a breakout / breakdown. */
function eventTrades(sym: string, c: ReadonlyArray<Candle>, events: ReadonlyArray<WeeklyEvent>, d: 1 | -1, entry: 'next' | 'break', cap: number, exit: TradeExit, from: number, to: number, bar: number): SignalTrade[] {
  const atr = atrWilder(c, 14), out: SignalTrade[] = [];
  let busy = -1;
  for (const e of events) {
    if (e.i <= busy || e.i + 1 >= c.length) continue;
    let res: ReturnType<typeof simulateFrom> = null, j = e.i + 1;
    if (entry === 'next') res = simulateSignal(c, atr, e.i, d, cap, exit);
    else {
      let ext = d > 0 ? Infinity : -Infinity;
      for (let k = Math.max(0, e.i - 7); k <= e.i; k++) ext = d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
      let stop: number | null = null;
      for (let k = e.i + 1; k < Math.min(c.length - 1, e.i + 21); k++) {
        ext = d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
        let lv = d > 0 ? -Infinity : Infinity;
        for (let q = Math.max(0, k - 5); q < k; q++) lv = d > 0 ? Math.max(lv, c[q]!.high) : Math.min(lv, c[q]!.low);
        const a = atr[k];
        if (a != null && (d > 0 ? c[k]!.close > lv : c[k]!.close < lv)) { j = k + 1; stop = ext - d * 0.5 * a; break; }
      }
      if (stop != null) res = simulateFrom(c, atr, j, stop, d, cap, exit);
    }
    if (!res || c[j]!.openTime < from || c[res.end]!.openTime + bar > to) continue;
    out.push({ sym, t: c[j]!.openTime, r: res.r, stopPct: res.stopPct, bars: res.bars });
    busy = res.end;
  }
  return out;
}

/** Weekly events traded on daily bars: map each weekly signal to the first daily bar after the week closes. */
function weeklyToDaily(dd: ReadonlyArray<Candle>, w: ReadonlyArray<Candle>, events: ReadonlyArray<WeeklyEvent>): WeeklyEvent[] {
  const out: WeeklyEvent[] = [];
  for (const e of events) {
    const known = w[e.i]!.openTime + 7 * DAY;
    const j = dd.findIndex((b) => b.openTime >= known);
    if (j > 0) out.push({ ...e, i: j - 1 });
  }
  return out;
}

export function newModelsReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const lines: { group: string; label: string; f: (sym: string) => SignalTrade[] }[] = [];
  const G = [-3, 0, 3];
  // 1. 4H over-ceiling short.
  for (const kind of ['ceiling', 'over-ceiling', 'both'] as const) for (const lux of [false, true]) for (const exit of ['hold', '3R'] as TradeExit[]) {
    lines.push({ group: '1. 4H RSI CEILING SHORT (mirror of the under-floor long)', label: `4H ${kind === 'both' ? 'ceiling or over-ceiling' : kind}${lux ? ' + LuxAlgo daily supply' : ''}, 10 days, ${exit}`, f: (sym) => {
      const c = data[sym]?.candles['4h'] ?? [], d1 = data[sym]?.candles['1d'] ?? [];
      if (c.length < 300) return [];
      const ev = rsiCeilingEvents(rsi(c.map((b) => b.close), 14)).filter((e) => kind === 'both' || e.kind === kind).filter((e) => !lux || (e.i + 1 < c.length && luxDailySupplyTouched(d1, c[e.i]!, c[e.i + 1]!.openTime)));
      return eventTrades(sym, c, ev, -1, 'next', 60, exit, from, to, H4);
    } });
  }
  // 2. Daily bearish divergences.
  const dailyDiv: { name: string; find: (c: Candle[], r: (number | null)[]) => WeeklyEvent[] }[] = [];
  for (const a of G) for (const b of G) dailyDiv.push({ name: `D top div >=${79 + a} / >=${75 + b}`, find: (c, r) => topDivEvents(c, r, 79 + a, 75 + b) });
  for (const a of G) for (const b of G) dailyDiv.push({ name: `D high div >=${70 + a} / >=${60 + b}`, find: (c, r) => topDivEvents(c, r, 70 + a, 60 + b, 'high-div') });
  dailyDiv.push({ name: 'D RSI 14 bearish divergence (any level)', find: (c, r) => divergenceEvents(c, r, 5, 3, 5, 40).filter((e) => e.d === -1) });
  for (const dv of dailyDiv) for (const entry of ['next', 'break'] as const) for (const exit of ['3R', 'hold'] as TradeExit[]) {
    lines.push({ group: '2. DAILY BEARISH DIVERGENCE SHORT', label: `${dv.name}, ${entry === 'next' ? 'next open' : 'breakdown'}, 60d, ${exit}`, f: (sym) => {
      const c = [...(data[sym]?.candles['1d'] ?? [])];
      if (c.length < 60) return [];
      return eventTrades(sym, c, dv.find(c, rsi(c.map((b) => b.close), 14)), -1, entry, 60, exit, from, to, DAY);
    } });
  }
  // 3. Daily momentum breakdown short.
  for (const a of G) for (const b of G) for (const exit of ['hold', '3R'] as TradeExit[]) {
    lines.push({ group: '3. DAILY MOMENTUM BREAKDOWN SHORT (mirror of the momentum long)', label: `D RSI <${25 + a}, weekly >${38 + b}, 3-day stop, 30d, ${exit}`, f: (sym) => {
      const c = [...(data[sym]?.candles['1d'] ?? [])];
      if (c.length < 60) return [];
      const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14), out: SignalTrade[] = [];
      let busy = -1;
      for (const e of momentumDownEvents(c, r, 25 + a, 38 + b)) {
        if (e.i <= busy) continue;
        const t = tightStopTrade(c, atr, e.i, -1, 'swing3', 30, exit);
        if (!t || c[e.i + 1]!.openTime < from || c[t.end]!.openTime + DAY > to) continue;
        out.push({ sym, t: c[e.i + 1]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars });
        busy = t.end;
      }
      return out;
    } });
  }
  // 4. Weekly bottom divergence long.
  for (const [f0, s0] of [[20, 30], [25, 35], [30, 40]]) for (const a of G) for (const entry of ['break', 'next'] as const) for (const exit of ['3R', 'hold'] as TradeExit[]) {
    if (a !== 0 && f0 !== 25) continue; // the grid on the middle setting
    lines.push({ group: '4. WEEKLY BOTTOM DIVERGENCE LONG (mirror of the weekly shorts)', label: `W bottom div <=${f0 + a} / <=${s0 + a}, daily ${entry === 'break' ? 'breakout' : 'next open'}, 91d, ${exit}`, f: (sym) => {
      const dd = data[sym]?.candles['1d'] ?? [], w = weeklyFromDaily(dd);
      if (w.length < 40) return [];
      const ev = weeklyToDaily(dd, w, bottomDivEvents(w, rsi(w.map((b) => b.close), 14), f0 + a, s0 + a, 'bottom-div', 0.01, 5, 3, 40));
      return eventTrades(sym, dd, ev, 1, entry, 91, exit, from, to, DAY);
    } });
  }
  const out = [
    `NEW RSI MODELS (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Costs 0.22%. Older / newer = before / after ${day(cut)}.`,
    '  model / variant                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  let group = '';
  for (const l of lines) {
    if (l.group !== group) { out.push('', l.group); group = l.group; }
    out.push(statsLine(l.label.padEnd(78), symbols.flatMap((s) => l.f(s)), cut));
  }
  return out;
}
