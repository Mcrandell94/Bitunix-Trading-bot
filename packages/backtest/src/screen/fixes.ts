// Fixes from the loss post-mortem, plus volume and ADX (owner 2026-10-04: "try some fixes and let's see the results,
// wondering if volume and ADX would help or hurt us"). Research only. Live models, version A exits, as the dashboard.
// Rules fixed before the run; each change is tested alone against the base, then the ones that help together:
//  - 'BE +2R' / 'BE +3R': stop to breakeven once a close is 2R / 3R the trade's way (36% of losers had gone >= 1R);
//  - 'skip late': skip entries more than 3 ATR from the 10-bar extreme (late entries averaged +0.19 R vs +1.30 R);
//  - 'BTC filter on shorts': shorts only while BTC's daily close is under its 50-day SMA (longs unchanged);
//  - 'max 2 a day': at most 2 entries per day and side across all coins (the earliest-run ones kept);
//  - volume: the signal bar's volume vs its 20-bar average on the entry timeframe: 'volume >= 1.5x' / '< 0.8x' kept;
//  - ADX(14) on the entry timeframe at the signal bar: 'ADX >= 25' (trending) / 'ADX < 20' (ranging) kept;
//    and ADX with the trade (+DI over -DI for longs) / against.
// Also avg R by volume ratio and ADX quartiles. Same coins and window as the post-mortem.

import type { Candle } from '@bot/marketdata';
import { adx as adxCalc, sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { frameworkSetups, LIVE_EXITS, RSI_MODELS, type RsiModelId } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
type Exit = 'base' | 'BE +2R' | 'BE +3R';
interface FT extends SignalTrade { model: RsiModelId; d: 1 | -1; ex: Exit; run: number; btcOk: boolean; vol: number; adx: number; diWith: boolean | null; btcAbove: Record<number, boolean | null> }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '-');

/** Keep at most `max` entries per UTC day and side across coins, the earliest-run (smallest run before entry) first. */
export function capPerDay<T extends { t: number; d: 1 | -1; run: number }>(ts: T[], max: number): T[] {
  const groups = new Map<string, T[]>();
  for (const x of ts) { const k = `${Math.floor(x.t / DAY)}|${x.d}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
  return [...groups.values()].flatMap((g) => [...g].sort((a, b) => a.run - b.run).slice(0, max));
}

export function fixesReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), 50);
  const btcBear = (t: number) => { let k = -1; for (let lo = 0, hi = btc.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (btc[m]!.openTime + DAY <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 && btcSma[k] != null && btc[k]!.close < btcSma[k]!; };
  // Owner 2026-10-04: the BTC trend line at 25..75 days (step 5) instead of 50, for the bull / bear flip.
  const SMA_LENS = [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75];
  const btcSmas = new Map(SMA_LENS.map((n) => [n, sma(btc.map((b) => b.close), n)] as const));
  const btcAboveAt = (t: number): Record<number, boolean | null> => {
    let k = -1; for (let lo = 0, hi = btc.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (btc[m]!.openTime + DAY <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    return Object.fromEntries(SMA_LENS.map((n) => { const v = k >= 0 ? btcSmas.get(n)![k] : null; return [n, v == null ? null : btc[k]!.close > v]; }));
  };
  const all: FT[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const ind = new Map<ReadonlyArray<Candle>, { vavg: (number | null)[]; a: ReturnType<typeof adxCalc> }>();
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (!models.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length || s.c[s.j]!.openTime < from) continue;
      const c = s.c, j = s.j, k = j - 1, entry = c[j]!.open, lx = LIVE_EXITS[s.model][0], stop0 = entry - lx.stopMult * (entry - s.stop);
      if (!ind.has(c)) ind.set(c, { vavg: sma(c.map((b) => b.volume), 20), a: adxCalc(c, 14) });
      const I = ind.get(c)!;
      let ext = s.d > 0 ? Infinity : -Infinity;
      for (let q = Math.max(0, j - 10); q < j; q++) ext = s.d > 0 ? Math.min(ext, c[q]!.low) : Math.max(ext, c[q]!.high);
      const a = s.atr[k] ?? null, run = a ? (s.d * (entry - ext)) / a : NaN;
      const va = I.vavg[k] ?? 0, vol = va > 0 ? (c[k]!.volume ?? NaN) / va : NaN, ax = I.a.adx[k] ?? NaN, pdi = I.a.pdi[k], mdi = I.a.mdi[k];
      const diWith = pdi == null || mdi == null ? null : s.d * (pdi - mdi) > 0;
      const btcOk = s.d > 0 || btcBear(c[j]!.openTime);
      for (const ex of ['base', 'BE +2R', 'BE +3R'] as Exit[]) {
        const key = `${s.model}|${ex}`;
        if (s.known <= (busy.get(key) ?? -Infinity)) continue;
        const spec: ExitSpec = ex === 'base' ? lx.spec : { ...lx.spec, name: `${lx.spec.name}, ${ex}`, be: ex === 'BE +2R' ? 2 : 3 };
        const t = specTrade(c, s.atr, {}, j, stop0, s.d, spec);
        if (!t) continue;
        busy.set(key, t.open ? Infinity : c[t.end]!.openTime + s.bar);
        all.push({ sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars, model: s.model, d: s.d, ex, run, btcOk, vol, adx: ax, diWith, btcAbove: btcAboveAt(c[j]!.openTime) });
      }
    }
  }
  const HEAD = '  variant                                                                              n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`FIXES FROM THE LOSS POST-MORTEM, PLUS VOLUME AND ADX (live models, version A exits): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`, HEAD];
  const variants = (ts: FT[]): [string, SignalTrade[]][] => {
    const base = ts.filter((x) => x.ex === 'base');
    const be2 = ts.filter((x) => x.ex === 'BE +2R'), be3 = ts.filter((x) => x.ex === 'BE +3R');
    return [
      ['base (as live)', base],
      ['BE +2R', be2], ['BE +3R', be3],
      ['skip late (> 3 ATR run)', base.filter((x) => !(x.run > 3))],
      ['BTC filter on shorts', base.filter((x) => x.btcOk)],
      ['max 2 a day per side', capPerDay(base, 2)],
      ['volume >= 1.5x avg only', base.filter((x) => x.vol >= 1.5)],
      ['volume < 0.8x avg only', base.filter((x) => x.vol < 0.8)],
      ['ADX >= 25 only', base.filter((x) => x.adx >= 25)],
      ['ADX < 20 only', base.filter((x) => x.adx < 20)],
      ['+DI / -DI with the trade only', base.filter((x) => x.diWith === true)],
      ['+DI / -DI against the trade only', base.filter((x) => x.diWith === false)],
      ['COMBO: BE +3R + skip late + BTC filter', be3.filter((x) => !(x.run > 3) && x.btcOk)],
      ['COMBO: BE +2R + skip late + BTC filter', be2.filter((x) => !(x.run > 3) && x.btcOk)],
    ];
  };
  const quart = (ts: FT[], key: (x: FT) => number, label: string) => {
    const xs = ts.filter((x) => Number.isFinite(key(x))).sort((a, b) => key(a) - key(b));
    if (xs.length < 12) return;
    const parts = [0, 1, 2, 3].map((q) => xs.slice(Math.floor((q * xs.length) / 4), Math.floor(((q + 1) * xs.length) / 4)));
    out.push(`  by ${label}: ` + parts.map((p, q) => `Q${q + 1} ${f(key(p[0]!), 1)}-${f(key(p[p.length - 1]!), 1)}: ${p.length}, avg R ${f(avg(p.map((x) => x.r)))}, ${f((100 * p.filter((x) => x.r > 0).length) / p.length, 0)}% wins`).join(' | '));
  };
  const block = (name: string, ts: FT[]) => {
    out.push('', name);
    for (const [label, v] of variants(ts)) out.push(statsLine(`  ${label}`.padEnd(84), v, cut));
    const base = ts.filter((x) => x.ex === 'base');
    quart(base, (x) => x.vol, 'signal-bar volume / 20-bar avg');
    quart(base, (x) => x.adx, 'ADX(14) at the signal bar');
  };
  for (const m of models) block(RSI_MODELS[m].label, all.filter((x) => x.model === m));
  block('ALL LIVE MODELS', all);
  // BTC trend line length: shorts only below / longs only above / both, per length (base exits).
  const base = all.filter((x) => x.ex === 'base');
  out.push('', 'BTC DAILY TREND LINE LENGTH (shorts only while BTC is under its n-day SMA; longs only while over; both), all live models, base exits:', HEAD);
  out.push(statsLine('  no BTC filter'.padEnd(84), base, cut));
  for (const n of SMA_LENS) {
    const ok = (x: FT, side: 1 | -1) => x.d !== side || x.btcAbove[n] === (side > 0);
    out.push(statsLine(`  ${n}-day: shorts only under`.padEnd(84), base.filter((x) => ok(x, -1)), cut));
    out.push(statsLine(`  ${n}-day: longs only over`.padEnd(84), base.filter((x) => ok(x, 1)), cut));
    out.push(statsLine(`  ${n}-day: both`.padEnd(84), base.filter((x) => ok(x, 1) && ok(x, -1)), cut));
  }
  out.push('', 'SHORTS ONLY, by BTC trend line length (shorts under the line vs over it):', HEAD);
  const shorts = base.filter((x) => x.d < 0), longs = base.filter((x) => x.d > 0);
  for (const n of SMA_LENS) { out.push(statsLine(`  ${n}-day: BTC under (kept)`.padEnd(84), shorts.filter((x) => x.btcAbove[n] === false), cut)); out.push(statsLine(`  ${n}-day: BTC over (dropped)`.padEnd(84), shorts.filter((x) => x.btcAbove[n] === true), cut)); }
  out.push('', 'LONGS ONLY, by BTC trend line length (longs over the line vs under it):', HEAD);
  for (const n of SMA_LENS) { out.push(statsLine(`  ${n}-day: BTC over (kept)`.padEnd(84), longs.filter((x) => x.btcAbove[n] === true), cut)); out.push(statsLine(`  ${n}-day: BTC under (dropped)`.padEnd(84), longs.filter((x) => x.btcAbove[n] === false), cut)); }
  return out;
}
