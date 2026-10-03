// Owner 2026-10-03: "Does it help the higher time frames if they align with these 1hr and 15m RSI being at extreme highs
// or lows while entering?" A split of the RSI framework's trades (final settings) by the 1h and 15m RSI 14 at entry (the
// last bar closed before the trade's entry open). Shorts are mirrored (100 - RSI), so "your way" means oversold for a
// long and overbought for a short. Rules fixed before the run:
//  - buckets of the aligned RSI: <= 30 extreme your way, 30-45, 45-55, 55-70, >= 70 extreme against (chasing);
//  - both: 1h and 15m both <= 30 aligned / one of them / neither;
//  - 24h: the 1h aligned RSI was <= 30 at some close in the 24 hours before entry.
// Only trades whose entry falls inside the 1h / 15m history count; the rest are listed as not classified.

import type { Candle } from '@bot/marketdata';
import { rsi } from '../indicators';
import { frameworkModels, statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const H = 3_600_000;

/** Index of the last bar closed at or before t (-1 if none). */
function lastClosed(c: ReadonlyArray<Candle>, bar: number, t: number): number {
  let lo = 0, hi = c.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime + bar <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

const bucket = (v: number) => (v <= 30 ? '<= 30 (extreme your way)' : v <= 45 ? '30-45' : v < 55 ? '45-55' : v < 70 ? '55-70' : '>= 70 (extreme against)');
const BUCKETS = ['<= 30 (extreme your way)', '30-45', '45-55', '55-70', '>= 70 (extreme against)'];

export function ltfSplitReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const groups = new Map<string, SignalTrade[]>();
  const add = (k: string, t: SignalTrade) => { const a = groups.get(k) ?? []; a.push(t); groups.set(k, a); };
  const ind = new Map<string, { c1: ReadonlyArray<Candle>; r1: (number | null)[]; c15: ReadonlyArray<Candle>; r15: (number | null)[] }>();
  for (const sym of symbols) {
    const c1 = data[sym]?.candles['1h'] ?? [], c15 = data[sym]?.candles['15m'] ?? [];
    ind.set(sym, { c1, r1: rsi(c1.map((b) => b.close), 14), c15, r15: rsi(c15.map((b) => b.close), 14) });
  }
  let unclassified = 0, total = 0;
  for (const m of frameworkModels(data, from, to)) {
    if (m.label.includes('bottom div') && m.label.endsWith('hold')) continue; // the 3R version is the framework's
    const side = m.label.startsWith('LONG') ? 'long' : 'short', d = side === 'long' ? 1 : -1;
    const al = (v: number) => (d > 0 ? v : 100 - v);
    for (const sym of symbols) for (const t of m.f(sym)) {
      total++;
      const x = ind.get(sym)!;
      const i1 = lastClosed(x.c1, H, t.t), i15 = lastClosed(x.c15, H / 4, t.t);
      const v1 = i1 >= 0 && t.t - x.c1[i1]!.openTime <= 2 * H ? x.r1[i1] : null;
      const v15 = i15 >= 0 && t.t - x.c15[i15]!.openTime <= H ? x.r15[i15] : null;
      if (v1 == null || v15 == null) { unclassified++; continue; }
      const a1 = al(v1), a15 = al(v15);
      for (const s of [side, 'all']) {
        add(`${s}|all`, t);
        add(`${s}|1h|${bucket(a1)}`, t);
        add(`${s}|15m|${bucket(a15)}`, t);
        add(`${s}|both|${a1 <= 30 && a15 <= 30 ? 'both extreme your way' : a1 <= 30 || a15 <= 30 ? 'one extreme your way' : a1 >= 70 || a15 >= 70 ? 'either extreme against' : 'neither extreme'}`, t);
        let was = false;
        for (let k = i1; k >= 0 && t.t - x.c1[k]!.openTime <= 25 * H; k--) { const v = x.r1[k]; if (v != null && al(v) <= 30) { was = true; break; } }
        add(`${s}|24h|${was ? '1h extreme your way in the last 24h' : 'not in the last 24h'}`, t);
      }
      add(`model|${m.label}|${a1 <= 30 || a15 <= 30 ? 'extreme your way (1h or 15m)' : a1 >= 70 || a15 >= 70 ? 'extreme against (1h or 15m)' : 'neither'}`, t);
    }
  }
  const out = [
    `RSI FRAMEWORK TRADES SPLIT BY 1H / 15M RSI AT ENTRY (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    `${total - unclassified} of ${total} trades classified (the rest enter before the 1h / 15m history). Shorts mirrored: "your way" = overbought for a short.`,
    '  group                                                                             n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const line = (label: string, k: string) => out.push(statsLine(label.padEnd(76), groups.get(k) ?? [], cut));
  for (const s of ['all', 'long', 'short']) {
    out.push('', `${s === 'all' ? 'WHOLE FRAMEWORK' : s === 'long' ? 'LONG MODELS' : 'SHORT MODELS'}`);
    line('all classified trades', `${s}|all`);
    for (const b of BUCKETS) line(`1h RSI ${b}`, `${s}|1h|${b}`);
    for (const b of BUCKETS) line(`15m RSI ${b}`, `${s}|15m|${b}`);
    for (const b of ['both extreme your way', 'one extreme your way', 'neither extreme', 'either extreme against']) line(b, `${s}|both|${b}`);
    for (const b of ['1h extreme your way in the last 24h', 'not in the last 24h']) line(b, `${s}|24h|${b}`);
  }
  out.push('', 'BY MODEL');
  for (const k of [...groups.keys()].filter((k) => k.startsWith('model|')).sort()) line(k.slice(6), k);
  return out;
}
