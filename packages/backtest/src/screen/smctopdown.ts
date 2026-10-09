// Owner 2026-10-10: "Top down model. Weekly and daily's set poi, 4hr and maybe 1 assist on entry." Rules fixed before
// the run (plan "SMC top-down model", research branch):
// - POI: a live order block (internal or swing) or fair value gap of the trade's side on the weekly or daily chart
//   (smclux.ts with the script's defaults, as drawn: the newest 5 order blocks per list and every FVG), known at the
//   last weekly / daily close. Variants: weekly, daily, either, nested (a daily zone overlapping a live weekly zone of
//   the same side).
// - Arm: a bar of the trigger timeframe trades into a POI without going through it (long: low <= top and
//   low >= bottom); the floor is the lowest bottom touched. A low under the floor cancels; 7 days without a new touch
//   expires.
// - Trigger: the first internal (length 5) structure break the trade's way on the trigger timeframe (4H, or 1H) while
//   armed, CHoCH or BOS (the touch bar counts). Entry at the next open; stop = the lowest low since arming - 0.25 x
//   ATR(14) of the trigger timeframe. Shorts mirror.
// - Context: none, or aligned (the weekly internal trend points the trade's way and the trigger bar closes in the
//   daily swing range's discount for a long / premium for a short).
// - Exits: 2R, 3R, 5R, 5R with breakeven at +2R, 30-day cap, 0.22% cost; one trade per coin per line.
// - Baselines, 10 seeds each: random direction at the same entry, and (added 2026-10-10 before any run on real data)
//   the same side entered at a random bar in the 60 days after the entry on the same coin, with the same stop % and
//   exit. Random-walk checks showed why: R is in price terms, so a long-only line gains about +0.1 R from drift alone
//   and a direction flip cannot see that; and twins drawn from before the entry lose by construction (a long setup
//   needs price to have come down into a bullish POI), which flattered the model on random prices.
// - A line passes with n >= 30, avg R > 0 before and after the cut, an edge of at least +0.10 R over both baselines,
//   and a timing edge at least 2 standard errors above zero.

import type { Candle } from '@bot/marketdata';
import { atrWilder } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { weeklyFromDaily } from './rsimap';
import { flip } from './scalp2';
import { edgeLine, STATS_HEAD, type EdgeRow } from './smcreport';
import { smcLux, smcZoneCursor, type Bias, type SmcSeries, type SmcZone } from './smclux';
import { rangePos } from './zonescore';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const H = 3_600_000, DAY = 24 * H, WEEK = 7 * DAY;

export type PoiVariant = 'weekly' | 'daily' | 'either' | 'nested';
export const POI_VARIANTS: ReadonlyArray<PoiVariant> = ['weekly', 'daily', 'either', 'nested'];
export type TriggerTf = '4h' | '1h';
const BAR: Record<TriggerTf, number> = { '4h': 4 * H, '1h': H };
/** Bars in 7 days (a setup lapses this long after its last touch) and in 30 days (the time cap). */
export const EXPIRE: Record<TriggerTf, number> = { '4h': 42, '1h': 168 };
const CAP: Record<TriggerTf, number> = { '4h': 180, '1h': 720 };
const exitsFor = (tf: TriggerTf): ExitSpec[] => [
  { name: '2R', target: 2, cap: CAP[tf] }, { name: '3R', target: 3, cap: CAP[tf] }, { name: '5R', target: 5, cap: CAP[tf] },
  { name: '5R, breakeven +2R', target: 5, be: 2, cap: CAP[tf] },
];

export interface Poi { tf: 'weekly' | 'daily'; z: SmcZone }
export interface Break { t: number; dir: Bias; kind: 'BOS' | 'CHoCH'; level: number }
export interface TopDownSetup { touch: number; trig: number; j: number; stop: number; poi: Poi; kind: 'BOS' | 'CHoCH'; level: number }
/** The weekly (built from the daily candles) and daily charts with the indicator on each. */
export interface Htf { w: ReadonlyArray<Candle>; ws: SmcSeries; d: ReadonlyArray<Candle>; ds: SmcSeries }
export interface HtfAt { weekly: SmcZone[]; daily: SmcZone[]; kw: number; kd: number }

export function htfOf(d: ReadonlyArray<Candle>): Htf {
  const w = weeklyFromDaily(d);
  return { w, ws: smcLux(w), d, ds: smcLux(d) };
}

/** Index of the last bar of `c` (bars `len` long) closed at or before T; -1 if none. */
export function lastClosed(c: ReadonlyArray<Candle>, len: number, T: number): number {
  let k = -1;
  for (let lo = 0, hi = c.length - 1; lo <= hi;) {
    const m = (lo + hi) >> 1;
    if (c[m]!.openTime + len <= T) { k = m; lo = m + 1; } else hi = m - 1;
  }
  return k;
}

/** For times T that never decrease: the weekly and daily zones known at T (alive entering the bar after the last close). */
export function htfCursor(h: Htf): (T: number) => HtfAt {
  const cw = smcZoneCursor(h.ws), cd = smcZoneCursor(h.ds);
  let kw = -2, kd = -2, weekly: SmcZone[] = [], daily: SmcZone[] = [];
  return (T) => {
    const nw = lastClosed(h.w, WEEK, T), nd = lastClosed(h.d, DAY, T);
    if (nw !== kw) { kw = nw; weekly = nw >= 0 ? cw(nw + 1) : []; }
    if (nd !== kd) { kd = nd; daily = nd >= 0 ? cd(nd + 1) : []; }
    return { weekly, daily, kw, kd };
  };
}

const overlaps = (a: SmcZone, b: SmcZone) => a.bottom <= b.top && b.bottom <= a.top;

/** The POIs of one side for a variant. */
export function poisFor(v: PoiVariant, side: Bias, at: Pick<HtfAt, 'weekly' | 'daily'>): Poi[] {
  const w = at.weekly.filter((z) => z.bias === side), d = at.daily.filter((z) => z.bias === side);
  const W = w.map((z): Poi => ({ tf: 'weekly', z })), D = d.map((z): Poi => ({ tf: 'daily', z }));
  if (v === 'weekly') return W;
  if (v === 'daily') return D;
  if (v === 'nested') return D.filter((p) => w.some((x) => overlaps(x, p.z)));
  return [...W, ...D];
}

/**
 * The setups of one side on the trigger timeframe: `pois(t)` = the POIs known at bar t's open, `breaks` = the internal
 * structure breaks on `c` (t = the bar whose close broke), `expire` = bars after the last touch before a setup lapses.
 */
export function topDownSetups(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, breaks: ReadonlyArray<Break>, pois: (t: number) => Poi[], side: Bias, expire: number): TopDownSetup[] {
  const brk = new Map<number, Break>();
  for (const b of breaks) if (b.dir === side && !brk.has(b.t)) brk.set(b.t, b);
  const out: TopDownSetup[] = [];
  // Shorts run on mirrored prices: `lo` is the low for a long and minus the high for a short.
  let armed = false, start = -1, last = -1, floor = NaN, ext = NaN, first: Poi | null = null;
  for (let t = 0; t < c.length; t++) {
    const b = c[t]!, lo = side === 1 ? b.low : -b.high;
    if (armed && (lo < floor || t - last > expire)) armed = false;
    const touched = pois(t).filter(({ z }) => (side === 1 ? b.low <= z.top && b.low >= z.bottom : b.high >= z.bottom && b.high <= z.top));
    if (touched.length) {
      const f = side === 1 ? Math.min(...touched.map((p) => p.z.bottom)) : -Math.max(...touched.map((p) => p.z.top));
      if (!armed) { armed = true; start = t; floor = f; ext = lo; first = touched[0]!; } else floor = Math.min(floor, f);
      last = t;
    }
    if (!armed) continue;
    ext = Math.min(ext, lo);
    const k = brk.get(t), a = atr[t];
    if (k && a != null && t + 1 < c.length) {
      out.push({ touch: start, trig: t, j: t + 1, stop: side === 1 ? ext - 0.25 * a : -ext + 0.25 * a, poi: first!, kind: k.kind, level: k.level });
      armed = false;
    }
  }
  return out;
}

interface Sim { r: number; stopPct: number; end: number; open: boolean; rand: number[]; rtime: number[] }
type TdRow = EdgeRow & { rtime: number[] };
interface Info { tf: TriggerTf; side: Bias; row: TdRow; poiTf: Poi['tf']; kind: SmcZone['kind']; trig: 'BOS' | 'CHoCH'; aligned: boolean }

/** Seeded index in [0, n) per (seed, coin, bar): FNV-1a then the murmur3 finaliser (as `coin` in scalp2.ts). */
const pick = (seed: number, sym: string, j: number, n: number) => {
  let h = 2166136261 ^ Math.imul(seed, 0x9e3779b1);
  for (const ch of `${sym}|${j}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) % n;
};

/**
 * The stats line with both baselines. The timing edge is the mean of each trade's R minus the mean of its own
 * random-time twins, with its t value; a line passes only with an edge of +0.10 R over both baselines and a timing t
 * of 2 or more.
 */
function tdLine(label: string, xs: ReadonlyArray<TdRow>, cut: number): { line: string; pass: boolean } {
  const e = edgeLine(label, xs, cut);
  const diffs = xs.filter((x) => x.rtime.length).map((x) => x.r - x.rtime.reduce((p, q) => p + q, 0) / x.rtime.length);
  const n = diffs.length, mean = diffs.reduce((p, q) => p + q, 0) / Math.max(1, n);
  const sd = Math.sqrt(diffs.reduce((p, q) => p + (q - mean) ** 2, 0) / Math.max(1, n - 1)), tv = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { line: `${e.line}; timing edge ${mean.toFixed(2)} (t ${tv.toFixed(1)})`, pass: e.pass && mean >= 0.1 && tv >= 2 };
}

export function smcTopDownReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10), ts = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const px = (x: number) => String(Number(x.toPrecision(6)));
  const lines = new Map<string, TdRow[]>(), info: Info[] = [], chart: string[] = [];
  let used = 0, h1From = Infinity;

  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 300) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h = htfOf(d1);
    for (const tf of ['4h', '1h'] as TriggerTf[]) {
      const c = (data[sym]?.candles[tf] ?? []).filter((b) => b.openTime + BAR[tf] <= now);
      if (c.length < 300) continue;
      if (tf === '1h') h1From = Math.min(h1From, c[0]!.openTime);
      const s = smcLux(c), atr = atrWilder(c, 14), cur = htfCursor(h), at = c.map((b) => cur(b.openTime));
      const j0 = Math.max(0, c.findIndex((b) => b.openTime >= from)), span = Math.round((60 * DAY) / BAR[tf]);
      const breaks: Break[] = s.events.filter((e) => e.scope === 'internal');
      const memo = new Map<string, Sim | null>(), busy = new Map<string, number>();
      const sim = (st: TopDownSetup, side: Bias, ex: ExitSpec): Sim | null => {
        const key = `${side}|${st.j}|${st.stop}|${ex.name}`;
        if (!memo.has(key)) {
          const tr = specTrade(c, atr, {}, st.j, st.stop, side, ex);
          let m: Sim | null = null;
          if (tr) {
            const rand: number[] = [], entry = c[st.j]!.open, dist = Math.abs(entry - st.stop);
            for (let k = 1; k <= 10; k++) {
              const d = (flip(k, sym, st.j) ? -side : side) as Bias, x = specTrade(c, atr, {}, st.j, entry - d * dist, d, ex);
              if (x) rand.push(x.r);
            }
            // Same side, random entry in the 60 days after this one, same stop % and exit.
            const rtime: number[] = [], lo = Math.max(j0, st.j + 1), hi = Math.min(c.length - 2, st.j + span);
            for (let k = 1; k <= 10 && hi >= lo; k++) {
              const j2 = lo + pick(k, sym, st.j, hi - lo + 1), e2 = c[j2]!.open, x = specTrade(c, atr, {}, j2, e2 - side * e2 * (dist / entry), side, ex);
              if (x) rtime.push(x.r);
            }
            m = { r: tr.r, stopPct: tr.stopPct, end: tr.end, open: tr.open, rand, rtime };
          }
          memo.set(key, m);
        }
        return memo.get(key)!;
      };
      const aligned = (st: TopDownSetup, side: Bias) => {
        const x = at[st.trig]!, pos = x.kd >= 0 ? rangePos(h.ds, x.kd, c[st.trig]!.close) : NaN;
        return x.kw >= 0 && h.ws.internalTrend[x.kw] === side && (side === 1 ? pos < 0.5 : pos > 0.5);
      };

      for (const side of [1, -1] as Bias[]) for (const v of POI_VARIANTS) {
        const setups = topDownSetups(c, atr, breaks, (t) => poisFor(v, side, at[t]!), side, EXPIRE[tf]);
        for (const st of setups) {
          if (c[st.j]!.openTime < from) continue;
          const al = aligned(st, side);
          for (const ctx of ['none', 'aligned'] as const) {
            if (ctx === 'aligned' && !al) continue;
            for (const ex of exitsFor(tf)) {
              const key = `${tf}|${side}|${v}|${ctx}|${ex.name}`;
              if (st.trig <= (busy.get(key) ?? -1)) continue;
              const m = sim(st, side, ex);
              if (!m) continue;
              busy.set(key, m.open ? Infinity : m.end);
              const row: TdRow = { sym, t: c[st.j]!.openTime, r: m.r, stopPct: m.stopPct, bars: Math.round((c[m.end]!.openTime - c[st.j]!.openTime) / DAY), rand: m.rand, rtime: m.rtime };
              const list = lines.get(key) ?? [];
              list.push(row);
              lines.set(key, list);
              if (v === 'either' && ctx === 'none' && ex.name === '3R') info.push({ tf, side, row, poiTf: st.poi.tf, kind: st.poi.z.kind, trig: st.kind, aligned: al });
            }
          }
        }
      }

      // Chart check: the latest setups (4H entry, either POI) on three big coins, to look at on TradingView.
      if (tf === '4h' && (sym === 'ETHUSDT' || sym === 'SOLUSDT' || sym === 'BTCUSDT')) {
        const both = ([1, -1] as Bias[]).flatMap((side) => topDownSetups(c, atr, breaks, (t) => poisFor('either', side, at[t]!), side, EXPIRE[tf]).map((st) => ({ st, side })));
        both.sort((a, b) => b.st.trig - a.st.trig);
        chart.push('', `${sym} (4H entry, weekly or daily POI): latest setups, bar open times UTC`);
        for (const { st, side } of both.slice(0, 8)) {
          const zc = st.poi.tf === 'weekly' ? h.w : h.d, m = sim(st, side, exitsFor('4h')[1]!);
          chart.push(`  ${side === 1 ? 'LONG ' : 'SHORT'} touch ${ts(c[st.touch]!.openTime)}, ${st.kind} ${ts(c[st.trig]!.openTime)} at ${px(st.level)}; POI ${st.poi.tf} ${st.poi.z.kind} ${px(st.poi.z.bottom)}-${px(st.poi.z.top)} (candle ${day(zc[st.poi.z.from]!.openTime)}); entry ${px(c[st.j]!.open)} ${ts(c[st.j]!.openTime)}, stop ${px(st.stop)}; 3R exit ${m ? `${m.r.toFixed(2)} R${m.open ? ' (open)' : ''}` : '-'}`);
        }
      }
    }
  }

  const out = [
    `SMC TOP-DOWN MODEL (weekly / daily POI, 4H or 1H entry): 4H entries ${day(from)} to now, 1H entries ${Number.isFinite(h1From) ? day(h1From) : '-'} to now (the 1H history); ${used} coins. Older / newer = before / after ${day(cut)}.`,
    'POI: a live order block or FVG (LuxAlgo SMC, defaults) on the weekly / daily, known at its last close. Arm when price trades into it without going through; trigger = first internal structure break (CHoCH or BOS) the trade\'s way within 7 days of the last touch; entry next open, stop beyond the extreme since arming + 0.25 ATR(14).',
    'Baselines (10 seeds each): "random" = random direction at the same entry; "timing edge" = R minus the same side entered at random bars in the 60 days after (same stop % and exit), with its t value. A line passes only with an edge of +0.10 R or more over both and a timing t of 2 or more.',
  ];
  const pass: string[] = [];
  for (const tf of ['4h', '1h'] as TriggerTf[]) for (const side of [1, -1] as Bias[]) {
    out.push('', `${tf === '4h' ? '4H' : '1H'} ENTRY, ${side === 1 ? 'LONGS (bullish weekly / daily zones)' : 'SHORTS (bearish weekly / daily zones)'}`, STATS_HEAD);
    for (const v of POI_VARIANTS) for (const ctx of ['none', 'aligned']) for (const ex of exitsFor(tf)) {
      const xs = lines.get(`${tf}|${side}|${v}|${ctx}|${ex.name}`) ?? [];
      if (!xs.length) continue;
      const { line, pass: ok } = tdLine(`    ${v} POI, ${ctx}, ${ex.name}`.padEnd(84), xs, cut);
      out.push(line);
      if (ok) pass.push(`  ${tf === '4h' ? '4H' : '1H'} ${side === 1 ? 'long ' : 'short'} ${line.trim()}`);
    }
  }
  out.push('', `LINES THAT PASS ON THIS COIN SET (n >= 30, avg R > 0 in both periods, edge >= +0.10 vs random and vs random time, timing t >= 2): ${pass.length}`, ...pass);

  // Information only: the main line (either POI, no context, 3R) split up.
  out.push('', 'MAIN LINE (either POI, no context, 3R) SPLIT UP (information only)', STATS_HEAD);
  for (const tf of ['4h', '1h'] as TriggerTf[]) for (const side of [1, -1] as Bias[]) {
    const xs = info.filter((x) => x.tf === tf && x.side === side);
    if (!xs.length) continue;
    out.push(`  ${tf === '4h' ? '4H' : '1H'} ${side === 1 ? 'longs' : 'shorts'}`);
    const split = (label: string, f: (x: Info) => boolean) => { const g = xs.filter(f).map((x) => x.row); if (g.length) out.push(tdLine(`      ${label}`.padEnd(84), g, cut).line); };
    split('first POI touched on the weekly', (x) => x.poiTf === 'weekly');
    split('first POI touched on the daily', (x) => x.poiTf === 'daily');
    split('POI internal order block', (x) => x.kind === 'ob-internal');
    split('POI swing order block', (x) => x.kind === 'ob-swing');
    split('POI fair value gap', (x) => x.kind === 'fvg');
    split('trigger CHoCH', (x) => x.trig === 'CHoCH');
    split('trigger BOS', (x) => x.trig === 'BOS');
    if (tf === '4h' && Number.isFinite(h1From)) split(`4H entries inside the 1H window (from ${day(h1From)})`, (x) => x.row.t >= h1From);
  }
  out.push('', 'CHART CHECK (compare with LuxAlgo Smart Money Concepts on the weekly / daily / 4H charts)', ...chart);
  return out;
}
