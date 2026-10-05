// 2-hour candles (owner 2026-10-05: "could the 2 hr candle be used for testing?"). Research only. 2h bars are built
// from the 1h history (two 1h bars starting on an even UTC hour: first open, max high, min low, last close, summed
// volume), the same bars the exchange shows. Rules fixed before the run:
//
// A. The live 4H models, unchanged except for the bar size, on 2h AND on 4h over the same window:
//    - 4H failure-swing short: bearish failure swing (or its double-top form) on the bar's RSI 14 while the daily RSI is
//      under 50; option 1 (BTC under its 50-day SMA, skip late > 3 ATR, breakeven at +2R); exit A (3R target);
//    - 4H under-floor: the bar's RSI breaks under the coin's own lowest RSI while the signal bar touches the LuxAlgo
//      daily demand zone; stop 0.75x the 10-bar-low stop; option 1 (skip late, no breakeven); exit A (5 ATR trail
//      from +2R).
//    Time caps are kept in calendar time (15 days / 10 days), so 2h caps are twice the 4h bar count. Costs 0.22%.
//    Random = each trade taken both ways, averaged.
// B. The 1h short regular divergence study (ltfdiv.ts) run on 2h bars, base settings unchanged (caps in bars).
// Window: the 1h history (about 4 years); older / newer split at Oct 2024, so 2022-2024 is the period no 15m / 1h / 2h
// test has used.

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi, sma } from '../indicators';
import type { FundingPoint } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { ltfDivReport } from './ltfdiv';
import { rsiFloorEvents } from './rsimap';
import { rsiPatterns } from './rsipatterns';
import { btcBearishAt, LATE_ATR, runBeforeEntry } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { lastClosed } from './scalp2';
import { luxDailyDemandTouched } from './sdzones';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, DAY = 24 * H;

/** 2h candles from 1h ones: pairs starting on an even UTC hour; an incomplete pair is dropped. */
export function to2h(c1: ReadonlyArray<Candle>): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + 1 < c1.length; i++) {
    const a = c1[i]!, b = c1[i + 1]!;
    if (a.openTime % (2 * H) !== 0 || b.openTime !== a.openTime + H) continue;
    out.push({ openTime: a.openTime, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, volume: (a.volume ?? 0) + (b.volume ?? 0) });
    i++;
  }
  return out;
}

type Model = '4h-fail-short' | 'under-floor';
type T = SignalTrade & { opp: number | null };

/** One live 4H model on candles of `bar` ms (option 1, exit A, caps in calendar days). */
export function modelOnBars(model: Model, sym: string, d1: ReadonlyArray<Candle>, c: ReadonlyArray<Candle>, bar: number, btc: ReadonlyArray<Candle>, btc50: ReadonlyArray<number | null>, from: number): T[] {
  const r = rsi(c.map((x) => x.close), 14), atr = atrWilder(c, 14), dr = rsi(d1.map((x) => x.close), 14);
  const days = model === '4h-fail-short' ? 15 : 10, cap = Math.round((days * DAY) / bar);
  const spec: ExitSpec = model === '4h-fail-short' ? { name: '3R, breakeven +2R', target: 3, cap, be: 2 } : { name: '5 ATR trail from +2R', trail: { kind: 'atr', k: 5, arm: 2 }, cap };
  const setups: { i: number; d: 1 | -1; stop: number }[] = [];
  if (model === '4h-fail-short') {
    for (const e of rsiPatterns(c, r, atr)) {
      if (e.d !== -1 || (e.pat !== 'failure swing' && e.pat !== 'double bottom')) continue;
      const k = lastClosed(d1, DAY, c[e.i]!.openTime + bar);
      if (k < 0 || dr[k] == null || !(dr[k]! < 50)) continue;
      setups.push({ i: e.i, d: -1, stop: e.stop });
    }
  } else {
    for (const e of rsiFloorEvents(r).filter((x) => x.kind === 'under-floor')) {
      const a = atr[e.i];
      if (a == null || !luxDailyDemandTouched(d1, c[e.i]!, c[e.i]!.openTime + bar)) continue;
      let lo = Infinity;
      for (let q = Math.max(0, e.i - 9); q <= e.i; q++) lo = Math.min(lo, c[q]!.low);
      setups.push({ i: e.i, d: 1, stop: lo - 0.5 * a });
    }
  }
  const out: T[] = [];
  let busy = -Infinity;
  for (const s of setups) {
    const known = c[s.i]!.openTime + bar, j = s.i + 1;
    if (known < from || known <= busy || j >= c.length) continue;
    const entry = c[j]!.open;
    if (s.d < 0 && !btcBearishAt(btc, btc50, c[j]!.openTime)) continue;
    if (runBeforeEntry(c, atr, j, s.d, entry) > LATE_ATR) continue;
    const dist = (model === 'under-floor' ? 0.75 : 1) * s.d * (entry - s.stop);
    if (!(dist > 0)) continue;
    const t = specTrade(c, atr, {}, j, entry - s.d * dist, s.d, spec);
    if (!t || t.open) continue;
    const o = specTrade(c, atr, {}, j, entry + s.d * dist, (-s.d) as 1 | -1, spec);
    out.push({ sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, opp: o && !o.open ? o.r : null });
    busy = c[t.end]!.openTime + bar;
  }
  return out;
}

export function tf2hReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, ticks: ReadonlyMap<string, number> = new Map()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btc50 = sma(btc.map((b) => b.close), 50);
  const c2 = new Map<string, Candle[]>();
  for (const sym of symbols) c2.set(sym, to2h(data[sym]?.candles['1h'] ?? []));
  // Start where every coin has 2h history: the window opens at `from`; 4h runs over the same window for comparison.
  const HEAD = '  model / bars                                                                           n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`2-HOUR CANDLES: ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)} (2022-2024 = no 15m / 1h / 2h test used it).`, '', 'A. THE LIVE 4H MODELS ON 2h vs 4h (option 1, exit A, caps in calendar days)', HEAD];
  const rnd = (ts: T[]) => { const xs = ts.flatMap((t) => (t.opp == null ? [t.r] : [t.r, t.opp])); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; };
  for (const model of ['4h-fail-short', 'under-floor'] as Model[]) {
    out.push('', `  ${model === '4h-fail-short' ? 'failure-swing short' : 'under-floor'}`);
    for (const [label, bar, get] of [['4h bars (as live)', 4 * H, (s: string) => data[s]?.candles['4h'] ?? []], ['2h bars', 2 * H, (s: string) => c2.get(s) ?? []]] as const) {
      const ts: T[] = [];
      for (const sym of symbols) {
        const d1 = data[sym]?.candles['1d'] ?? [], c = get(sym);
        if (d1.length < 300 || c.length < 300) continue;
        ts.push(...modelOnBars(model, sym, d1, c, bar, btc, btc50, from));
      }
      const years = [...new Set(ts.map((t) => new Date(t.t).getUTCFullYear()))].sort().map((y) => { const ys = ts.filter((t) => new Date(t.t).getUTCFullYear() === y); return `${y} ${(ys.reduce((a, b) => a + b.r, 0) / ys.length).toFixed(2)} (${ys.length})`; });
      out.push(`${statsLine(`    ${label}`.padEnd(84), ts, cut)}   random ${rnd(ts).toFixed(2)}`, `      by year: ${years.join(' | ')}`);
    }
  }
  // B. The divergence study on 2h bars: the study reads candles['1h'], so hand it the 2h series with a 2h bar length.
  const d2: Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }> = {};
  for (const sym of symbols) d2[sym] = { candles: { ...(data[sym]?.candles ?? {}), '1h': c2.get(sym) ?? [] }, funding: data[sym]?.funding };
  out.push('', 'B. SHORT REGULAR DIVERGENCE STUDY ON 2h BARS (ltfdiv.ts, same rules; caps and bar counts are in 2h bars)');
  out.push(...ltfDivReport(d2, symbols, from, to, cut, ticks, 'stop:1.25,a:75,entry:atr,filter:btc50,filter:late3', 2 * H));
  return out;
}
