// RSI framework study (owner 2026-10-03): where on each timeframe does the Prism Adaptive RSI favour longs, and where
// shorts? Model-free: every closed bar of every research coin, its Prism RSI, and what price did next. Each timeframe
// is mapped on its own (weekly, daily, 4H, 1H), so the zones can be set per timeframe before they are applied.
import { intervalMs, type Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import { prismRsi } from './prismrsi';

/** RSI bins (owner's boundaries 38 / 55 / 75 kept as edges). */
export const RSI_BINS: ReadonlyArray<[number, number]> = [[0, 25], [25, 32], [32, 38], [38, 45], [45, 50], [50, 55], [55, 62], [62, 68], [68, 75], [75, 82], [82, 101]];
/** Bars ahead per timeframe: weekly 4 (a month), daily 10, 4H 12 (two days), 1H 24 (a day). */
export const RSI_MAP_HORIZON: Record<string, number> = { '1w': 4, '1d': 10, '4h': 12, '1h': 24 };

/** Weekly candles (Monday 00:00 UTC) from daily ones; only complete weeks. */
export function weeklyFromDaily(d: ReadonlyArray<Candle>): Candle[] {
  const day = intervalMs('1d'), weekOf = (t: number) => Math.floor((t - 4 * day) / (7 * day));
  const out: Candle[] = [];
  let cur: Candle | null = null, wk = NaN, days = 0;
  for (const b of d) {
    const w = weekOf(b.openTime);
    if (w !== wk) {
      if (cur && days === 7) out.push(cur);
      cur = { openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
      wk = w; days = 1;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume = (cur.volume ?? 0) + (b.volume ?? 0); days++;
    }
  }
  if (cur && days === 7) out.push(cur);
  return out;
}

export interface MapSample { rsi: number; twistUp: boolean; fwd: number; first: 'up' | 'down' | 'none'; old: boolean }

/**
 * Samples for one coin and timeframe: at each closed bar in [from, to) (with h bars after it), the Prism RSI line,
 * whether the fast line is above the slow one, the move h bars later in ATRs, and which 1-ATR barrier price touched
 * first (a bar touching both counts as 'none').
 */
export function mapSamples(c: ReadonlyArray<Candle>, h: number, from: number, to: number, cut: number, line: 'mid' | 'fast' | 'slow' = 'mid', values?: ReadonlyArray<number | null>): MapSample[] {
  const p = prismRsi(c.map((b) => b.close)), atr = atrWilder(c, 14), iv = c.length > 1 ? c[1]!.openTime - c[0]!.openTime : 0;
  const out: MapSample[] = [];
  for (let i = 0; i + h < c.length; i++) {
    const t = c[i]!.openTime;
    if (t < from || c[i + h]!.openTime + iv > to) continue;
    const r = values ? values[i] ?? NaN : p[line][i]!, a = atr[i];
    if (!Number.isFinite(r) || a == null || !(a > 0)) continue;
    const base = c[i]!.close;
    let first: MapSample['first'] = 'none';
    for (let j = i + 1; j <= i + h; j++) {
      const u = c[j]!.high >= base + a, dn = c[j]!.low <= base - a;
      if (u && dn) break;
      if (u) { first = 'up'; break; }
      if (dn) { first = 'down'; break; }
    }
    out.push({ rsi: r, twistUp: p.fast[i]! >= p.slow[i]!, fwd: (c[i + h]!.close - base) / a, first, old: t < cut });
  }
  return out;
}

const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const f = (v: number, p = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(p) : '-');

/**
 * One timeframe's map: per RSI bin, samples, mean move after h bars (ATR), % up-first and % down-first, the long edge
 * (up-first minus down-first, percentage points; the short edge is its negative), and the long edge in the older two
 * years and the newest year. Edges are relative to the timeframe's base rate (all bars), so market drift is removed.
 */
export function mapTable(samples: ReadonlyArray<MapSample>, title: string): string[] {
  const edge = (xs: ReadonlyArray<MapSample>) => pct(xs.filter((s) => s.first === 'up').length, xs.length) - pct(xs.filter((s) => s.first === 'down').length, xs.length);
  const baseAll = edge(samples), baseOld = edge(samples.filter((s) => s.old)), baseNew = edge(samples.filter((s) => !s.old));
  const out = [
    title,
    `  base (all bars): ${samples.length} / move ${f(mean(samples.map((s) => s.fwd)))} ATR / up-first ${pct(samples.filter((s) => s.first === 'up').length, samples.length).toFixed(1)}% / down-first ${pct(samples.filter((s) => s.first === 'down').length, samples.length).toFixed(1)}%`,
    '  RSI bin    samples   move(ATR)  up-1st  down-1st  LONG edge vs base (older / newest)   verdict',
  ];
  for (const [lo, hi] of RSI_BINS) {
    const b = samples.filter((s) => s.rsi >= lo && s.rsi < hi);
    if (b.length < 30) { out.push(`  ${`${lo}-${hi > 100 ? 100 : hi}`.padEnd(9)} ${String(b.length).padStart(7)}   (too few)`); continue; }
    const o = b.filter((s) => s.old), nw = b.filter((s) => !s.old);
    const e = edge(b) - baseAll, eo = edge(o) - baseOld, en = edge(nw) - baseNew;
    const verdict = e >= 3 && eo > 0 && en > 0 ? 'LONG' : e <= -3 && eo < 0 && en < 0 ? 'SHORT' : '';
    out.push(`  ${`${lo}-${hi > 100 ? 100 : hi}`.padEnd(9)} ${String(b.length).padStart(7)}   ${f(mean(b.map((s) => s.fwd))).padStart(7)}   ${pct(b.filter((s) => s.first === 'up').length, b.length).toFixed(1).padStart(5)}%  ${pct(b.filter((s) => s.first === 'down').length, b.length).toFixed(1).padStart(6)}%   ${f(e, 1).padStart(6)} pts (${f(eo, 1)} / ${f(en, 1)})   ${verdict}`);
  }
  for (const tw of [true, false]) {
    const b = samples.filter((s) => s.twistUp === tw), o = b.filter((s) => s.old), nw = b.filter((s) => !s.old);
    out.push(`  twist ${tw ? 'up  ' : 'down'}  ${String(b.length).padStart(7)}   ${f(mean(b.map((s) => s.fwd))).padStart(7)}   long edge ${f(edge(b) - baseAll, 1)} pts (${f(edge(o) - baseOld, 1)} / ${f(edge(nw) - baseNew, 1)})`);
  }
  return out;
}

/** The full report: weekly, daily, 4H, 1H, for the middle and fast lines. */
export function rsiMapReport(data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const out = [
    'RSI MAP (Prism Adaptive RSI, owner 2026-10-03): every closed bar of every research coin. Move = close h bars later vs now, in ATRs.',
    'up-1st / down-1st = price touched +1 ATR / -1 ATR first within h bars. LONG edge = (up-1st - down-1st) minus the timeframe base rate, in',
    'percentage points; a negative long edge is a SHORT edge. verdict LONG / SHORT = edge of 3+ pts, same sign in both periods. Samples overlap',
    '(neighbouring bars share their future), so treat counts as much smaller than shown.',
  ];
  for (const tf of ['1w', '1d', '4h', '1h'] as const) {
    for (const line of ['mid', 'fast'] as const) {
      const all: MapSample[] = [];
      for (const s of symbols) {
        const d = data[s]?.candles;
        const c = tf === '1w' ? weeklyFromDaily(d?.['1d'] ?? []) : d?.[tf] ?? [];
        if (c.length > 60) all.push(...mapSamples(c, RSI_MAP_HORIZON[tf]!, from, to, cut, line));
      }
      out.push('', ...mapTable(all, `${tf.toUpperCase()} — ${line} line, ${RSI_MAP_HORIZON[tf]} bars ahead`));
    }
  }
  return out;
}

/**
 * Weekly Prism RSI as known at each daily bar: completed weeks (Monday 00:00 UTC) plus the current week so far,
 * built from closed daily bars (no look-ahead). One value per daily bar (NaN while the weekly is warming up).
 */
export function weeklyAtDaily(d: ReadonlyArray<Candle>, line: 'mid' | 'fast' = 'mid'): number[] {
  const day = intervalMs('1d'), weekOf = (t: number) => Math.floor((t - 4 * day) / (7 * day));
  const done: number[] = []; // closes of completed weeks
  const out: number[] = [];
  for (let j = 0; j < d.length; j++) {
    if (j > 0 && weekOf(d[j]!.openTime) !== weekOf(d[j - 1]!.openTime)) done.push(d[j - 1]!.close);
    const s = prismRsi([...done, d[j]!.close]);
    out.push(s[line].at(-1)!);
  }
  return out;
}

export const COMBO_W_BANDS: ReadonlyArray<[number, number]> = [[0, 38], [38, 50], [50, 55], [55, 62], [62, 68], [68, 101]];
export const COMBO_D_BANDS: ReadonlyArray<[number, number]> = [[0, 32], [32, 38], [38, 55], [55, 68], [68, 75], [75, 101]];
export interface ComboSample extends MapSample { w: number }

/** Daily samples (10 days ahead) tagged with the weekly RSI known that day. */
export function comboSamples(d: ReadonlyArray<Candle>, from: number, to: number, cut: number): ComboSample[] {
  const w = weeklyAtDaily(d), h = RSI_MAP_HORIZON['1d']!;
  const p = prismRsi(d.map((b) => b.close)), atr = atrWilder(d, 14), iv = intervalMs('1d');
  const out: ComboSample[] = [];
  for (let i = 0; i + h < d.length; i++) {
    const t = d[i]!.openTime;
    if (t < from || d[i + h]!.openTime + iv > to) continue;
    const r = p.mid[i]!, a = atr[i];
    if (!Number.isFinite(r) || !Number.isFinite(w[i]!) || a == null || !(a > 0)) continue;
    const base = d[i]!.close;
    let first: MapSample['first'] = 'none';
    for (let j = i + 1; j <= i + h; j++) {
      const u = d[j]!.high >= base + a, dn = d[j]!.low <= base - a;
      if (u && dn) break;
      if (u) { first = 'up'; break; }
      if (dn) { first = 'down'; break; }
    }
    out.push({ rsi: r, w: w[i]!, twistUp: p.fast[i]! >= p.slow[i]!, fwd: (d[i + h]!.close - base) / a, first, old: t < cut });
  }
  return out;
}

/** Grid: weekly band (rows) x daily band (columns); each cell = long edge vs the daily base rate (pts), older / newest, samples. */
export function comboTable(samples: ReadonlyArray<ComboSample>, minN = 150): string[] {
  const edge = (xs: ReadonlyArray<MapSample>) => pct(xs.filter((s) => s.first === 'up').length, xs.length) - pct(xs.filter((s) => s.first === 'down').length, xs.length);
  const bA = edge(samples), bO = edge(samples.filter((s) => s.old)), bN = edge(samples.filter((s) => !s.old));
  const lab = ([lo, hi]: [number, number]) => `${lo}-${hi > 100 ? 100 : hi}`;
  const out = [
    `WEEKLY x DAILY (Prism RSI middle line; daily bars, 10 days ahead, +-1 daily ATR first touch; ${samples.length} coin-days).`,
    'Cell = LONG edge vs the daily base rate in pts [older / newest] (samples); L / S = 3+ pts the same way in both periods; cells under ' + minN + ' samples: count only.',
    `  weekly \\ daily  ${COMBO_D_BANDS.map((b) => lab(b).padEnd(26)).join('')}`,
  ];
  const cells: { w: string; dd: string; e: number; n: number; v: string }[] = [];
  for (const wb of COMBO_W_BANDS) {
    let row = `  ${lab(wb).padEnd(15)} `;
    for (const db of COMBO_D_BANDS) {
      const c = samples.filter((s) => s.w >= wb[0] && s.w < wb[1] && s.rsi >= db[0] && s.rsi < db[1]);
      if (c.length < minN) { row += `(${c.length})`.padEnd(26); continue; }
      const e = edge(c) - bA, eo = edge(c.filter((s) => s.old)) - bO, en = edge(c.filter((s) => !s.old)) - bN;
      const v = e >= 3 && eo > 0 && en > 0 ? 'L' : e <= -3 && eo < 0 && en < 0 ? 'S' : ' ';
      cells.push({ w: lab(wb), dd: lab(db), e, n: c.length, v });
      row += `${v} ${f(e, 1)} [${f(eo, 0)}/${f(en, 0)}] (${c.length})`.padEnd(26);
    }
    out.push(row);
  }
  const best = [...cells].filter((c) => c.v === 'L').sort((a, b) => b.e - a.e).slice(0, 5);
  const worst = [...cells].filter((c) => c.v === 'S').sort((a, b) => a.e - b.e).slice(0, 5);
  out.push('  best LONG cells: ' + (best.map((c) => `W ${c.w} & D ${c.dd} ${f(c.e, 1)} (${c.n})`).join('; ') || 'none'));
  out.push('  best SHORT cells: ' + (worst.map((c) => `W ${c.w} & D ${c.dd} ${f(c.e, 1)} (${c.n})`).join('; ') || 'none'));
  return out;
}

export function rsiComboReport(data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const all: ComboSample[] = [];
  for (const s of symbols) { const d = data[s]?.candles['1d'] ?? []; if (d.length > 200) all.push(...comboSamples(d, from, to, cut)); }
  return comboTable(all);
}

// ---- Weekly signal events (owner 2026-10-03, from their ETH / LINK weekly charts): Prism ribbon flips (dots),
// exhaustion flips (diamonds), RSI 14 divergences, and a flip confirming a divergence. Each event is known at the
// close of its week; outcomes are the % move 4, 8 and 13 weeks later, in the event's direction.

export type WeeklyEventKind = 'flip' | 'exhaustion' | 'divergence' | 'flip+div';
export interface WeeklyEvent { i: number; d: 1 | -1; kind: WeeklyEventKind }

/** Prism flips with the script's filter: bull = fast crosses over slow while slow < 50; bear = crosses under while slow > 50. Exhaustion: fast touched 20 / 80 within 10 bars. */
export function prismFlipEvents(p: { fast: number[]; slow: number[] }, ob = 80, os = 20, lb = 10): WeeklyEvent[] {
  const out: WeeklyEvent[] = [];
  for (let i = 1; i < p.fast.length; i++) {
    const f0 = p.fast[i - 1]!, f1 = p.fast[i]!, s0 = p.slow[i - 1]!, s1 = p.slow[i]!;
    if (![f0, f1, s0, s1].every(Number.isFinite)) continue;
    const up = f0 <= s0 && f1 > s1 && s1 < 50, dn = f0 >= s0 && f1 < s1 && s1 > 50;
    if (!up && !dn) continue;
    let lo = Infinity, hi = -Infinity;
    for (let k = Math.max(0, i - lb + 1); k <= i; k++) { lo = Math.min(lo, p.fast[k]!); hi = Math.max(hi, p.fast[k]!); }
    const exh = up ? lo <= os : hi >= ob;
    out.push({ i, d: up ? 1 : -1, kind: exh ? 'exhaustion' : 'flip' });
  }
  return out;
}

/**
 * Regular RSI divergences on pivots (left 5, right 3 bars; a pivot is known `right` bars after it): bullish = price
 * lower low while RSI makes a higher low (previous RSI pivot low within 5-40 bars); bearish = the mirror on highs.
 * The event sits on the bar the second pivot is confirmed.
 */
export function divergenceEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, left = 5, right = 3, minGap = 5, maxGap = 40): WeeklyEvent[] {
  const out: WeeklyEvent[] = [];
  const piv = (k: number, low: boolean) => {
    const v = r[k];
    if (v == null || k - left < 0 || k + right >= c.length) return false;
    for (let j = k - left; j <= k + right; j++) {
      if (j === k) continue;
      const w = r[j];
      if (w == null) return false;
      if (low ? w < v || (w === v && j < k) : w > v || (w === v && j < k)) return false;
    }
    return true;
  };
  const lows: number[] = [], highs: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const k = i - right; // pivot candidate confirmed at bar i
    if (k < 0) continue;
    if (piv(k, true)) {
      const prev = lows.filter((p) => k - p >= minGap && k - p <= maxGap).at(-1);
      if (prev != null && c[k]!.low < c[prev]!.low && r[k]! > r[prev]!) out.push({ i, d: 1, kind: 'divergence' });
      lows.push(k);
    }
    if (piv(k, false)) {
      const prev = highs.filter((p) => k - p >= minGap && k - p <= maxGap).at(-1);
      if (prev != null && c[k]!.high > c[prev]!.high && r[k]! < r[prev]!) out.push({ i, d: -1, kind: 'divergence' });
      highs.push(k);
    }
  }
  return out;
}

/** A Prism flip (either kind) in the same direction within `win` bars after a divergence; the event sits on the flip. */
export function flipDivEvents(flips: ReadonlyArray<WeeklyEvent>, divs: ReadonlyArray<WeeklyEvent>, win = 6): WeeklyEvent[] {
  return flips.filter((f) => divs.some((dv) => dv.d === f.d && f.i - dv.i >= 0 && f.i - dv.i <= win)).map((f) => ({ ...f, kind: 'flip+div' as const }));
}

export const WEEKLY_HORIZONS = [4, 8, 13] as const;

export function weeklyEventReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, show: ReadonlyArray<string> = ['ETHUSDT', 'LINKUSDT'],
): string[] {
  type Row = { sym: string; t: number; d: number; kind: WeeklyEventKind; fwd: (number | null)[]; old: boolean; rsi14: number | null; prism: number };
  const rows: Row[] = [];
  const base: Record<number, number[]> = { 4: [], 8: [], 13: [] };
  const lvlSamples: MapSample[] = [];
  const wk = 7 * 86_400_000;
  for (const sym of symbols) {
    const c = weeklyFromDaily(data[sym]?.candles['1d'] ?? []);
    if (c.length < 40) continue;
    const closes = c.map((b) => b.close), p = prismRsi(closes), r14 = rsi(closes, 14);
    const inWin = (i: number) => c[i]!.openTime >= from && c[i]!.openTime + wk <= to;
    const fwd = (i: number, h: number, d: number) => (i + h < c.length && c[i + h]!.openTime + wk <= to ? (100 * d * (c[i + h]!.close - c[i]!.close)) / c[i]!.close : null);
    for (let i = 0; i < c.length; i++) if (inWin(i)) for (const h of WEEKLY_HORIZONS) { const v = fwd(i, h, 1); if (v != null) base[h]!.push(v); }
    const flips = prismFlipEvents(p), divs = divergenceEvents(c, r14);
    for (const e of [...flips, ...divs, ...flipDivEvents(flips, divs)]) {
      if (!inWin(e.i)) continue;
      rows.push({ sym, t: c[e.i]!.openTime, d: e.d, kind: e.kind, fwd: WEEKLY_HORIZONS.map((h) => fwd(e.i, h, e.d)), old: c[e.i]!.openTime < cut, rsi14: r14[e.i] ?? null, prism: p.mid[e.i]! });
    }
    lvlSamples.push(...mapSamples(c, 4, from, to, cut, 'mid', r14));
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    `WEEKLY SIGNALS (owner's charts): ${new Date(from).toISOString().slice(0, 10)} to ${day(to)}, weekly bars built from daily, ${symbols.length} coins.`,
    'Move = % change N weeks after the signal week closes, in the signal\'s direction (a short that falls 10% = +10%). Base = the average week',
    '(long: the plain move; short: minus it). "right" = share of signals that moved the right way. Older / newer = before / after ' + day(cut) + '.',
    `  base (all weeks): 4w ${f(avg(base[4]!), 1)}%  8w ${f(avg(base[8]!), 1)}%  13w ${f(avg(base[13]!), 1)}%  (long; short = minus these)`,
    '  signal          side   n    4w move  right    8w move  right    13w move  right    8w older / newer',
  ];
  for (const kind of ['flip', 'exhaustion', 'divergence', 'flip+div'] as const) {
    for (const d of [1, -1]) {
      const xs = rows.filter((r) => r.kind === kind && r.d === d);
      const cols = WEEKLY_HORIZONS.map((h, k) => {
        const v = xs.map((r) => r.fwd[k]).filter((x): x is number => x != null);
        const b = d * avg(base[h]!);
        return `${f(avg(v), 1).padStart(6)}% (${f(avg(v) - b, 1)}) ${pct(v.filter((x) => x > 0).length, v.length).toFixed(0).padStart(3)}%`;
      });
      const o8 = xs.filter((r) => r.old).map((r) => r.fwd[1]).filter((x): x is number => x != null), n8 = xs.filter((r) => !r.old).map((r) => r.fwd[1]).filter((x): x is number => x != null);
      out.push(`  ${kind.padEnd(14)} ${d > 0 ? 'long ' : 'short'} ${String(xs.length).padStart(4)}  ${cols.join('  ')}   ${f(avg(o8), 1)}% (${o8.length}) / ${f(avg(n8), 1)}% (${n8.length})`);
    }
  }
  out.push('', ...mapTable(lvlSamples, 'WEEKLY RSI 14 LEVELS (standard RSI, 4 weeks ahead, +-1 weekly ATR first touch; same columns as the Prism map)'));
  for (const sym of show) {
    const xs = rows.filter((r) => r.sym === sym).sort((a, b) => a.t - b.t);
    out.push('', `${sym} weekly signals (date, side, kind, RSI 14, Prism mid, move 4w / 8w / 13w in the signal's direction):`);
    for (const r of xs) out.push(`  ${day(r.t)} ${r.d > 0 ? 'BUY ' : 'SELL'} ${r.kind.padEnd(11)} RSI14 ${r.rsi14 == null ? '-' : r.rsi14.toFixed(0)}  prism ${r.prism.toFixed(0)}   ${r.fwd.map((v) => (v == null ? '-' : `${f(v, 0)}%`)).join(' / ')}`);
  }
  return out;
}
