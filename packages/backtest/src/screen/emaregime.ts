// The owner's EMA notes for ETH and BTC (2026-10-11), checked on our data before the cards lean on them (round 4). The
// notes rank "price through one EMA" against "one EMA crossing another" as a regime switch: long when the condition is
// true, short (LS) or flat (LF) when it is false, with flips, Sharpe and CAGR. This rebuilds those tables with the
// notes' rules as written. Fixed before the run:
// - A condition known at close k sets the position for close k -> close k+1 (no look-ahead). Daily Sharpe = mean / sd
//   of the daily strategy returns x sqrt(365); weekly x sqrt(52); 4H x sqrt(6 x 365). CAGR from the compounded returns.
// - Each book is shown without costs (as the notes appear to be) and with 0.11% per side per unit of position change
//   (a long / short flip = 2 units).
// - Each row starts where its slowest EMA is seeded (taEma, SMA seed), so slow rows cover a shorter span; the span is
//   printed with the row.
// - Short-rule profit factors (ETH: short when the close loses EMA 26 while EMA 12 is under 26; BTC: short when the
//   2-of-3 check of emastack.ts reaches 2), each trade closed when the close is back over EMA 26; a trade's return is
//   1 - exit / entry; PF = gross wins / gross losses, without and with costs.
// - The notes' own figures (NOTES) are printed under each row they cover. Their samples are longer (ETH Nov 2017 - Sep
//   2026, BTC Oct 2016 - Sep 2026); ours stop at the research end, and Binance spot starts in Aug 2017.
// Pure.

import type { Candle } from '@bot/marketdata';
import { btcShortCheck, stackSeries } from './emastack';
import { taEma } from './pine';
import { aggregate } from './wyckoffhtf';

export const REGIME = { costPerSide: 0.0011 } as const;
/** The owner's pasted figures (2026-10-11), keyed by our row names: flips, LS / LF Sharpe, LS / LF CAGR %. */
export interface NoteRef { flips?: string; ls?: number; lf?: number; lsCagr?: number; lfCagr?: number; text?: string }
export const NOTES: Record<'ETHUSDT' | 'BTCUSDT', Record<string, NoteRef>> = {
  ETHUSDT: {
    'close vs 26': { flips: '~295', ls: 1.11, lf: 1.26, lsCagr: 79 }, 'close vs 21': { flips: '345', ls: 0.97, lf: 1.22, lsCagr: 59 },
    'close vs 50': { flips: '205', ls: 0.5, lf: 0.9, lsCagr: 6 }, 'close vs 5': { flips: '867', ls: 0.19, lf: 0.67, lsCagr: -17 },
    '13 cross 21': { flips: '93', ls: 0.95, lf: 1.16, lsCagr: 56 }, '8 cross 26': { flips: '101', ls: 0.92, lf: 1.16, lsCagr: 53 },
    '12 cross 21': { flips: '97', ls: 0.88, lf: 1.12, lsCagr: 47 }, '21 cross 50': { flips: '51', ls: 0.55, lf: 0.87, lsCagr: 11 },
    'weekly close vs W5': { ls: 0.95 }, 'weekly 5 cross 21': { ls: 0.28, text: 'negative CAGR' }, short: { text: 'PF 1.70' },
  },
  BTCUSDT: {
    'buy and hold': { ls: 0.99, lsCagr: 54 },
    'close vs 21': { flips: '461', ls: 0.92, lf: 1.39, lsCagr: 48, lfCagr: 70 }, 'close vs 26': { flips: '401', ls: 0.96, lf: 1.41, lsCagr: 52, lfCagr: 72 },
    'close vs 50': { flips: '255', ls: 0.86, lf: 1.3, lsCagr: 42, lfCagr: 65 }, 'close vs 89': { flips: '171', ls: 0.91, lf: 1.28, lsCagr: 47, lfCagr: 66 },
    'close vs 100': { flips: '163', ls: 0.9, lf: 1.27, lsCagr: 46, lfCagr: 66 }, 'close vs 144': { flips: '95', ls: 1.09, lf: 1.37, lsCagr: 65, lfCagr: 75 },
    'close vs 200': { flips: '99', ls: 0.88, lf: 1.21, lsCagr: 44, lfCagr: 63 },
    '9 cross 89': { flips: '57', ls: 1.05, lf: 1.36, lsCagr: 62 }, '8 cross 100': { flips: '59', ls: 1.02, lf: 1.34, lsCagr: 58 },
    '5 cross 89': { flips: '79', ls: 1.01, lf: 1.34, lsCagr: 57 }, '8 cross 89': { flips: '65', ls: 1.01, lf: 1.33, lsCagr: 57 },
    '21 cross 89': { flips: '37', ls: 0.96, lf: 1.29, lsCagr: 52 }, '12 cross 21': { text: 'weaker than 9/89' }, '13 cross 21': { text: 'weaker than 9/89' },
    '5 cross 8': { flips: '314 crosses', ls: 1.88, text: '"on the later test"' },
    'weekly close vs W5': { flips: '137', ls: 0.93, lf: 1.25 }, 'weekly close vs W34': { flips: '37', ls: 0.84, lf: 1.1 },
    'weekly close vs W13': { flips: '69', ls: 0.77, lf: 1.09 }, 'weekly close vs W26': { flips: '43', ls: 0.74, lf: 1.06 },
    'weekly close vs W21': { flips: '49', ls: 0.72, lf: 1.05 }, 'weekly close vs W50': { flips: '29', ls: 0.73, lf: 1.02 },
    'weekly close vs W200': { flips: '13', ls: -0.28, lf: 0.52 }, 'weekly 5 cross 21': { flips: '21', ls: 0.86 }, short: { text: '"only okay"' },
  },
};
export interface Book { sharpe: number | null; cagr: number | null }
export interface RegimeRow { name: string; from: number; to: number; flips: number; ls: Book; lf: Book; lsCost: Book; lfCost: Book }

/** The LS / LF books of a condition series (true / false / null = not yet known) over closes. */
export function regimeRow(name: string, c: ReadonlyArray<{ openTime: number; close: number }>, cond: ReadonlyArray<boolean | null>, perYear: number): RegimeRow {
  let start = cond.findIndex((v) => v != null);
  if (start < 0) start = c.length;
  const books = { ls: [] as number[], lf: [] as number[], lsCost: [] as number[], lfCost: [] as number[] };
  let flips = 0, pLs = 0, pLf = 0;
  for (let k = start; k < c.length - 1; k++) {
    const v = cond[k];
    if (v == null) continue;
    const ls = v ? 1 : -1, lf = v ? 1 : 0, r = c[k + 1]!.close / c[k]!.close - 1;
    if (k > start && cond[k - 1] != null && cond[k - 1] !== v) flips++;
    const cl = Math.abs(ls - pLs) * REGIME.costPerSide, cf = Math.abs(lf - pLf) * REGIME.costPerSide;
    books.ls.push(ls * r); books.lf.push(lf * r); books.lsCost.push(ls * r - cl); books.lfCost.push(lf * r - cf);
    pLs = ls; pLf = lf;
  }
  const book = (x: number[]): Book => {
    if (x.length < 30) return { sharpe: null, cagr: null };
    const m = x.reduce((p, y) => p + y, 0) / x.length, sd = Math.sqrt(x.reduce((p, y) => p + (y - m) ** 2, 0) / (x.length - 1));
    const growth = x.reduce((p, y) => p * (1 + y), 1);
    return { sharpe: sd > 0 ? (m / sd) * Math.sqrt(perYear) : null, cagr: growth > 0 ? growth ** (perYear / x.length) - 1 : -1 };
  };
  return { name, from: c[start]?.openTime ?? NaN, to: c.at(-1)?.openTime ?? NaN, flips, ls: book(books.ls), lf: book(books.lf), lsCost: book(books.lsCost), lfCost: book(books.lfCost) };
}

/** Close over EMA n (null until seeded). */
export const closeVs = (c: ReadonlyArray<{ close: number }>, n: number) => { const e = taEma(c.map((b) => b.close), n); return c.map((b, k) => (Number.isNaN(e[k]!) ? null : b.close > e[k]!)); };
/** EMA a over EMA b (null until both are seeded). */
export const cross = (c: ReadonlyArray<{ close: number }>, a: number, b: number) => { const x = taEma(c.map((q) => q.close), a), y = taEma(c.map((q) => q.close), b); return c.map((_, k) => (Number.isNaN(x[k]!) || Number.isNaN(y[k]!) ? null : x[k]! > y[k]!)); };
/** Our earlier screen signal `ema50_trend` as a regime: long once the close is over EMA 50 and the EMA rises, short once both turn down, held between. */
function ema50Trend(c: ReadonlyArray<{ close: number }>): (boolean | null)[] {
  const e = taEma(c.map((b) => b.close), 50), out: (boolean | null)[] = [];
  let st: boolean | null = null;
  for (let k = 0; k < c.length; k++) {
    if (k > 0 && !Number.isNaN(e[k]!) && !Number.isNaN(e[k - 1]!)) {
      if (c[k]!.close > e[k]! && e[k]! > e[k - 1]!) st = true;
      else if (c[k]!.close < e[k]! && e[k]! < e[k - 1]!) st = false;
    }
    out.push(st);
  }
  return out;
}

export interface ShortPf { trades: number; pf: number | null; pfCost: number | null; avg: number | null }
/** Short trades entered at a close where `enter(k)` holds, closed at the first close back over EMA 26. */
export function shortPf(c: ReadonlyArray<{ close: number }>, enter: (k: number) => boolean, e26: ReadonlyArray<number>): ShortPf {
  const rets: number[] = [];
  for (let k = 0; k < c.length; k++) {
    if (!enter(k)) continue;
    let j = k + 1;
    while (j < c.length && !(c[j]!.close > e26[j]!)) j++;
    if (j >= c.length) break;
    rets.push(1 - c[j]!.close / c[k]!.close);
    k = j;
  }
  const pf = (x: number[]) => { const w = x.filter((r) => r > 0).reduce((p, r) => p + r, 0), l = -x.filter((r) => r < 0).reduce((p, r) => p + r, 0); return l > 0 ? w / l : null; };
  return { trades: rets.length, pf: pf(rets), pfCost: pf(rets.map((r) => r - 2 * REGIME.costPerSide)), avg: rets.length ? (rets.reduce((p, r) => p + r, 0) / rets.length) * 100 : null };
}

export interface RegimeTables { daily: RegimeRow[]; weekly: RegimeRow[]; h4: RegimeRow[]; shorts: { name: string; r: ShortPf }[] }
/** The notes' rows for one coin, plus our earlier EMA findings for reference. */
export function regimeTables(coin: 'ETHUSDT' | 'BTCUSDT', d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>): RegimeTables {
  const w = aggregate(d1, 'W').c.slice(0, -1), D = 365, W = 52;
  const daily: RegimeRow[] = [regimeRow('buy and hold', d1, d1.map(() => true), D)];
  const weekly: RegimeRow[] = [];
  if (coin === 'ETHUSDT') {
    for (const n of [26, 21, 50, 5]) daily.push(regimeRow(`close vs ${n}`, d1, closeVs(d1, n), D));
    for (const [a, b] of [[13, 21], [8, 26], [12, 21], [21, 50]] as const) daily.push(regimeRow(`${a} cross ${b}`, d1, cross(d1, a, b), D));
    for (const n of [5, 13]) weekly.push(regimeRow(`weekly close vs W${n}`, w, closeVs(w, n), W));
  } else {
    for (const n of [21, 26, 50, 89, 100, 144, 200]) daily.push(regimeRow(`close vs ${n}`, d1, closeVs(d1, n), D));
    for (const [a, b] of [[9, 89], [8, 100], [5, 89], [8, 89], [21, 89], [12, 21], [13, 21], [5, 8]] as const) daily.push(regimeRow(`${a} cross ${b}`, d1, cross(d1, a, b), D));
    for (const n of [5, 13, 21, 26, 34, 50, 200]) weekly.push(regimeRow(`weekly close vs W${n}`, w, closeVs(w, n), W));
  }
  weekly.push(regimeRow('weekly 5 cross 21', w, cross(w, 5, 21), W));
  daily.push(regimeRow('earlier ema50_trend (held)', d1, ema50Trend(d1), D));
  const h4rows = h4.length ? [regimeRow('earlier 4H EMA 5 cross 20', h4, cross(h4, 5, 20), 6 * 365)] : [];
  // Short rules.
  const s = stackSeries(coin, d1, []), e26 = s.dEma.get(26)!, e12 = s.dEma.get(12)!;
  const loses26 = (k: number) => k > 0 && !Number.isNaN(e26[k]!) && !Number.isNaN(e26[k - 1]!) && d1[k]!.close < e26[k]! && d1[k - 1]!.close >= e26[k - 1]!;
  const shorts = coin === 'ETHUSDT'
    ? [{ name: 'short when the close loses 26 with 12 under 26', r: shortPf(d1, (k) => loses26(k) && e12[k]! < e26[k]!, e26) }, { name: 'short on every close losing 26 (no filter)', r: shortPf(d1, loses26, e26) }]
    : [{ name: 'short when the 2-of-3 check reaches 2', r: shortPf(d1, (k) => (btcShortCheck(s, k)?.count ?? 0) >= 2 && (k === 0 || (btcShortCheck(s, k - 1)?.count ?? 0) < 2), e26) }, { name: 'short on every close losing 26 (no filter)', r: shortPf(d1, loses26, e26) }];
  return { daily, weekly, h4: h4rows, shorts };
}

const f2 = (x: number | null | undefined) => (x == null ? '    -' : x.toFixed(2).padStart(5));
const pc = (x: number | null | undefined, frac = true) => (x == null ? '      -' : `${frac ? (x * 100).toFixed(0) : x.toFixed(0)}%`.padStart(7));
/** The table text, with the notes' figures under each row they cover. */
export function regimeText(coin: 'ETHUSDT' | 'BTCUSDT', t: RegimeTables): string[] {
  const iso = (x: number) => (Number.isFinite(x) ? new Date(x).toISOString().slice(0, 10) : '-'), N = NOTES[coin];
  const row = (r: RegimeRow) => {
    const n = N[r.name], line = `  ${r.name.padEnd(28)} ${String(r.flips).padStart(5)} ${f2(r.ls.sharpe)} ${f2(r.lf.sharpe)} ${pc(r.ls.cagr)} ${pc(r.lf.cagr)} | ${f2(r.lsCost.sharpe)} ${f2(r.lfCost.sharpe)} ${pc(r.lsCost.cagr)} ${pc(r.lfCost.cagr)}  ${iso(r.from)}..${iso(r.to)}`;
    return n ? [line, `    notes:${' '.repeat(21)}${(n.flips ?? '-').padStart(5)} ${f2(n.ls)} ${f2(n.lf)} ${pc(n.lsCagr, false)} ${pc(n.lfCagr, false)}${n.text ? `  ${n.text}` : ''}`] : [line];
  };
  const head = `  ${'rule'.padEnd(28)} flips LS Sh LF Sh LS CAGR LF CAGR | 0.11%/side: LS Sh LF Sh LS CAGR LF CAGR  span`;
  const sh = (x: ShortPf) => `${x.trades} trades, PF ${x.pf == null ? '-' : x.pf.toFixed(2)} (with costs ${x.pfCost == null ? '-' : x.pfCost.toFixed(2)}), avg ${x.avg == null ? '-' : `${x.avg.toFixed(2)}%`}`;
  return [
    `${coin} daily:`, head, ...t.daily.flatMap(row),
    `${coin} weekly (closed Monday weeks):`, head, ...t.weekly.flatMap(row),
    ...(t.h4.length ? [`${coin} 4H:`, head, ...t.h4.flatMap(row)] : []),
    `${coin} short rules (each trade closed at the first close back over EMA 26):`,
    ...t.shorts.map((x, k) => `  ${x.name}: ${sh(x.r)}${k === 0 && N.short?.text ? ` (notes: ${N.short.text})` : ''}`),
  ];
}
