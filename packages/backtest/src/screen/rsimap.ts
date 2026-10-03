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

export type WeeklyEventKind = 'flip' | 'exhaustion' | 'divergence' | 'div-anchor' | 'flip+div' | 'floor' | 'under-floor' | 'stretch-top' | 'top-div' | 'high-div' | 'support-lost' | 'held-div' | 'reclaim-div' | 'reclaim' | 'sequence' | 'db-div' | 'support-hold';
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
export function divergenceEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, left = 5, right = 3, minGap = 5, maxGap = 40, anchor?: { hi: number; lo: number }): WeeklyEvent[] {
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
      const near = lows.filter((p) => k - p >= minGap && k - p <= maxGap);
      // Anchored (owner's daily charts): any earlier RSI low under anchor.lo; else the previous pivot low.
      const cands = anchor ? near.filter((p) => r[p]! <= anchor.lo) : near.slice(-1);
      if (cands.some((p) => c[k]!.low < c[p]!.low && r[k]! > r[p]!)) out.push({ i, d: 1, kind: anchor ? 'div-anchor' : 'divergence' });
      lows.push(k);
    }
    if (piv(k, false)) {
      const near = highs.filter((p) => k - p >= minGap && k - p <= maxGap);
      const cands = anchor ? near.filter((p) => r[p]! >= anchor.hi) : near.slice(-1);
      if (cands.some((p) => c[k]!.high > c[p]!.high && r[k]! < r[p]!)) out.push({ i, d: -1, kind: anchor ? 'div-anchor' : 'divergence' });
      highs.push(k);
    }
  }
  return out;
}

/** A Prism flip (either kind) in the same direction within `win` bars after a divergence; the event sits on the flip. */
export function flipDivEvents(flips: ReadonlyArray<WeeklyEvent>, divs: ReadonlyArray<WeeklyEvent>, win = 6): WeeklyEvent[] {
  return flips.filter((f) => divs.some((dv) => dv.d === f.d && f.i - dv.i >= 0 && f.i - dv.i <= win)).map((f) => ({ ...f, kind: 'flip+div' as const }));
}

/**
 * Owner 2026-10-03 (ETH daily): each coin has an RSI bottom; within ~5 points above it is a strong buy, under it is a
 * bear-market discount. Floor = the lowest RSI 14 over all earlier bars (needs `warm` bars of history, no look-ahead).
 * 'floor' = first bar back in [floor, floor + band]; 'under-floor' = first bar under the floor (a new low); one event
 * per visit (the bar before was outside the zone) and at most one per `cool` bars.
 */
export function rsiFloorEvents(r: ReadonlyArray<number | null>, band = 5, warm = 250, cool = 10): (WeeklyEvent & { floor: number })[] {
  const out: (WeeklyEvent & { floor: number })[] = [];
  let lo = Infinity, seen = 0, last = -Infinity, prevIn = false;
  for (let i = 0; i < r.length; i++) {
    const v = r[i];
    if (v == null || !Number.isFinite(v)) continue;
    const ready = seen >= warm, inZone = ready && v <= lo + band;
    if (inZone && !prevIn && i - last >= cool) { out.push({ i, d: 1, kind: v < lo ? 'under-floor' : 'floor', floor: lo }); last = i; }
    prevIn = inZone;
    lo = Math.min(lo, v);
    seen++;
  }
  return out;
}

/**
 * Owner 2026-10-03: an RSI "stretch" (RSI pivot high >= 70 at least 5 points above the previous pivot high within
 * `maxGap` bars, while price made no significant new high: at most +3%) shows strength; the next bearish divergence
 * within `win` bars after it is read as the major top. The event sits on that divergence.
 */
export function stretchTopEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, bearDivs: ReadonlyArray<WeeklyEvent>, left = 5, right = 3, maxGap = 60, win = 120): WeeklyEvent[] {
  const highs: number[] = [], stretches: number[] = [];
  for (let i = right; i < c.length; i++) {
    const k = i - right, v = r[k];
    if (v == null || k - left < 0) continue;
    let ok = true;
    for (let j = k - left; j <= k + right && ok; j++) { const w = r[j]; if (j !== k && (w == null || w > v || (w === v && j < k))) ok = false; }
    if (!ok) continue;
    const p = highs.filter((h) => k - h >= 5 && k - h <= maxGap).at(-1);
    if (p != null && v >= 70 && v >= r[p]! + 5 && c[k]!.high <= c[p]!.high * 1.03) stretches.push(i);
    highs.push(k);
  }
  const out: WeeklyEvent[] = [];
  let used = -1;
  for (const s of stretches) {
    if (s <= used) continue;
    const dv = bearDivs.filter((e) => e.d === -1 && e.i > s && e.i - s <= win).sort((a, b) => a.i - b.i)[0];
    if (dv && !out.some((e) => e.i === dv.i)) { out.push({ i: dv.i, d: -1, kind: 'stretch-top' }); used = dv.i; }
  }
  return out;
}

/**
 * Owner 2026-10-03: "the top seems to be at 85 RSI divergence to 79-80 RSI". Bearish divergence where an earlier RSI
 * pivot high (5..maxGap bars back) is >= `first` and the new pivot, at a higher price high, is >= `second` but lower.
 * 'top-div' uses 82 / 75; 'high-div' (70 / 60, not already a top-div) shows what the looser band would add.
 */
export function topDivEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, first = 82, second = 75, kind: 'top-div' | 'high-div' = 'top-div', left = 5, right = 3, maxGap = 120): WeeklyEvent[] {
  const highs: number[] = [], out: WeeklyEvent[] = [];
  for (let i = right; i < c.length; i++) {
    const k = i - right, v = r[k];
    if (v == null || k - left < 0) continue;
    let ok = true;
    for (let j = k - left; j <= k + right && ok; j++) { const w = r[j]; if (j !== k && (w == null || w > v || (w === v && j < k))) ok = false; }
    if (!ok) continue;
    if (v >= second && highs.some((p) => k - p >= 5 && k - p <= maxGap && r[p]! >= first && v < r[p]! && c[k]!.high > c[p]!.high)) out.push({ i, d: -1, kind });
    highs.push(k);
  }
  return out;
}

/**
 * Owner 2026-10-03 (ETH 4H): RSI 30-35 is support. Losing it (close under `lo`) is bearish; then a bullish divergence
 * where "RSI tanked but price held" (a new RSI pivot low under `lo`, below the previous RSI pivot low, while the price
 * low holds at or above the previous one: 'held-div'); then a bullish divergence on the reclaim (price lower low, the
 * previous RSI low under `lo`, the new one back at `lo` or higher: 'reclaim-div'). 'reclaim' = a close back above `hi`
 * after a close under `lo` within 20 bars; 'sequence' = a reclaim-div within `win` bars after a held-div.
 */
export function supportEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, lo = 30, hi = 35, left = 5, right = 3, maxGap = 60, win = 60, cool = 10): WeeklyEvent[] {
  const out: WeeklyEvent[] = [], lows: number[] = [];
  let lastLost = -Infinity, lastReclaim = -Infinity, lastUnder = -Infinity, lastHeld = -Infinity;
  for (let i = 1; i < c.length; i++) {
    const v = r[i], pv = r[i - 1];
    if (v != null && pv != null) {
      if (v < lo && pv >= lo && i - lastLost >= cool) { out.push({ i, d: -1, kind: 'support-lost' }); lastLost = i; }
      if (v > hi && pv <= hi && i - lastUnder <= 20 && i - lastReclaim >= cool) { out.push({ i, d: 1, kind: 'reclaim' }); lastReclaim = i; }
      if (v < lo) lastUnder = i;
    }
    const k = i - right, x = r[k];
    if (k - left < 0 || x == null) continue;
    let ok = true;
    for (let j = k - left; j <= k + right && ok; j++) { const w = r[j]; if (j !== k && (w == null || w < x || (w === x && j < k))) ok = false; }
    if (!ok) continue;
    const p = lows.filter((q) => k - q >= 5 && k - q <= maxGap).at(-1);
    if (p != null) {
      if (x < lo && x < r[p]! && c[k]!.low >= c[p]!.low) { out.push({ i, d: 1, kind: 'held-div' }); lastHeld = i; }
      if (r[p]! < lo && x >= lo && c[k]!.low < c[p]!.low) {
        out.push({ i, d: 1, kind: 'reclaim-div' });
        if (i - lastHeld <= win) out.push({ i, d: 1, kind: 'sequence' });
      }
    }
    lows.push(k);
  }
  return out;
}

/**
 * Owner's ETH 4H screenshot (Jun-Aug 2026), read after the first support run:
 * 'db-div' = price retests its low (within `tol` of an earlier pivot low 10..maxGap bars back, that RSI low under
 * `lo`) while RSI makes a higher low (>= 3 pts): Jun 26 2026. 'support-hold' = RSI pivot low in [lo, lo + 10], above
 * the previous RSI pivot low, at a higher price low, with RSI under `lo` somewhere in the `memory` bars before: Aug 2026.
 */
export function supportHoldEvents(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, lo = 30, tol = 0.015, left = 5, right = 3, maxGap = 150, memory = 360): WeeklyEvent[] {
  const out: WeeklyEvent[] = [], lows: number[] = [];
  let lastUnder = -Infinity;
  for (let i = 0; i < c.length; i++) {
    const k = i - right, x = k >= 0 ? r[k] : null;
    if (k - left >= 0 && x != null) {
      let ok = true;
      for (let j = k - left; j <= k + right && ok; j++) { const w = r[j]; if (j !== k && (w == null || w < x || (w === x && j < k))) ok = false; }
      if (ok) {
        const near = lows.filter((q) => k - q >= 10 && k - q <= maxGap);
        if (near.some((q) => r[q]! < lo && x >= r[q]! + 3 && Math.abs(c[k]!.low / c[q]!.low - 1) <= tol)) out.push({ i, d: 1, kind: 'db-div' });
        const p = lows.filter((q) => k - q >= 5 && k - q <= maxGap).at(-1);
        if (p != null && x >= lo && x <= lo + 10 && x > r[p]! && c[k]!.low > c[p]!.low && k - lastUnder <= memory) out.push({ i, d: 1, kind: 'support-hold' });
        lows.push(k);
      }
    }
    // A support-hold pivot and its neighbours sit at >= lo, so the last close under lo is always before the pivot.
    const v = r[i];
    if (v != null && v < lo) lastUnder = i;
  }
  return out;
}

export const WEEKLY_HORIZONS = [4, 8, 13] as const;
/** Per timeframe: horizons (bars), divergence pivot spacing, anchor levels, and the bar length. */
export const EVENT_TF = {
  '1w': { horizons: [4, 8, 13], maxGap: 40, anchorGap: 60, unit: 'w', bar: 7 * 86_400_000 },
  '4h': { horizons: [6, 12, 30, 60], maxGap: 60, anchorGap: 120, unit: 'b', bar: 4 * 3_600_000 },
  '1d': { horizons: [5, 10, 20, 40], maxGap: 60, anchorGap: 120, unit: 'd', bar: 86_400_000 },
} as const;

export function weeklyEventReport(
  data: Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, show: ReadonlyArray<string> = ['ETHUSDT', 'LINKUSDT'],
  tf: keyof typeof EVENT_TF = '1w', horizons?: ReadonlyArray<number>,
): string[] {
  const T = EVENT_TF[tf], H = horizons?.length ? horizons : T.horizons, HL = H[H.length - 1]!;
  type Row = { sym: string; t: number; d: number; kind: WeeklyEventKind; fwd: (number | null)[]; ext: [number, number] | null; old: boolean; rsi14: number | null; prism: number; floor?: number };
  const rows: Row[] = [];
  const base: Record<number, number[]> = Object.fromEntries(H.map((h) => [h, [] as number[]]));
  const lvlSamples: MapSample[] = [];
  const wk = T.bar;
  for (const sym of symbols) {
    const c = tf === '1w' ? weeklyFromDaily(data[sym]?.candles['1d'] ?? []) : [...(data[sym]?.candles[tf] ?? [])];
    if (c.length < 40) continue;
    const closes = c.map((b) => b.close), p = prismRsi(closes), r14 = rsi(closes, 14);
    const inWin = (i: number) => c[i]!.openTime >= from && c[i]!.openTime + wk <= to;
    // Owner 2026-10-03: major divergences play out over months. Best move for / against the signal within the
    // longest horizon (from the highs and lows), to see whether it squeezes first.
    const ext = (i: number, d: number): [number, number] | null => {
      if (i + HL >= c.length || c[i + HL]!.openTime + wk > to) return null;
      let hi = -Infinity, lo = Infinity;
      for (let k = i + 1; k <= i + HL; k++) { hi = Math.max(hi, c[k]!.high); lo = Math.min(lo, c[k]!.low); }
      const up = (100 * (hi - c[i]!.close)) / c[i]!.close, dn = (100 * (c[i]!.close - lo)) / c[i]!.close;
      return d > 0 ? [up, dn] : [dn, up];
    };
    const fwd = (i: number, h: number, d: number) => (i + h < c.length && c[i + h]!.openTime + wk <= to ? (100 * d * (c[i + h]!.close - c[i]!.close)) / c[i]!.close : null);
    for (let i = 0; i < c.length; i++) if (inWin(i)) for (const h of H) { const v = fwd(i, h, 1); if (v != null) base[h]!.push(v); }
    const flips = prismFlipEvents(p), divs = divergenceEvents(c, r14, 5, 3, 5, T.maxGap);
    const anch = divergenceEvents(c, r14, 5, 3, 5, T.anchorGap, { hi: 65, lo: 35 });
    const floors = rsiFloorEvents(r14), tops = stretchTopEvents(c, r14, [...divs, ...anch]);
    const topDivs = topDivEvents(c, r14), highDivs = topDivEvents(c, r14, 70, 60, 'high-div').filter((e) => !topDivs.some((t) => t.i === e.i));
    for (const e of [...flips, ...divs, ...anch, ...flipDivEvents(flips, [...divs, ...anch]), ...floors, ...tops, ...topDivs, ...highDivs, ...supportEvents(c, r14), ...supportHoldEvents(c, r14)]) {
      if (!inWin(e.i)) continue;
      rows.push({ sym, t: c[e.i]!.openTime, d: e.d, kind: e.kind, fwd: H.map((h) => fwd(e.i, h, e.d)), ext: ext(e.i, e.d), old: c[e.i]!.openTime < cut, rsi14: r14[e.i] ?? null, prism: p.mid[e.i]!, ...('floor' in e ? { floor: e.floor as number } : {}) });
    }
    lvlSamples.push(...mapSamples(c, H[0]!, from, to, cut, 'mid', r14));
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
  const day = (t: number) => new Date(t).toISOString().slice(0, tf === '4h' ? 16 : 10).replace('T', ' ');
  const TF = { '1w': 'WEEKLY', '1d': 'DAILY', '4h': '4H' }[tf];
  const out = [
    `${TF} SIGNALS (owner's charts): ${new Date(from).toISOString().slice(0, 10)} to ${day(to)}, ${symbols.length} coins. div-anchor = divergence against any earlier RSI extreme (>= 65 / <= 35) within ${T.anchorGap} bars.`,
    `Move = % change N bars after the signal bar closes, in the signal's direction (a short that falls 10% = +10%). Base = the average ${tf === '1w' ? 'week' : tf === '1d' ? 'day' : '4h bar'}${tf === '4h' ? ' (b = 4h bars: 6 = 1 day, 60 = 10 days)' : ''}`,
    '(long: the plain move; short: minus it). "right" = share of signals that moved the right way. Older / newer = before / after ' + day(cut) + '.',
    `  base (all bars): ${H.map((h) => `${h}${T.unit} ${f(avg(base[h]!), 1)}%`).join('  ')}  (long; short = minus these)`,
    `  signal          side   n    ${H.map((h) => `${h}${T.unit} move  right  `).join('  ')}  ${HL}${T.unit} older / newer   best for / against within ${HL}${T.unit}`,
  ];
  for (const kind of ['flip', 'exhaustion', 'divergence', 'div-anchor', 'flip+div', 'floor', 'under-floor', 'stretch-top', 'top-div', 'high-div', 'support-lost', 'held-div', 'reclaim-div', 'reclaim', 'sequence', 'db-div', 'support-hold'] as const) {
    for (const d of [1, -1]) {
      const xs = rows.filter((r) => r.kind === kind && r.d === d);
      if (!xs.length) continue;
      const cols = H.map((h, k) => {
        const v = xs.map((r) => r.fwd[k]).filter((x): x is number => x != null);
        const b = d * avg(base[h]!);
        return `${f(avg(v), 1).padStart(6)}% (${f(avg(v) - b, 1)}) ${pct(v.filter((x) => x > 0).length, v.length).toFixed(0).padStart(3)}%`;
      });
      const L = H.length - 1;
      const o8 = xs.filter((r) => r.old).map((r) => r.fwd[L]).filter((x): x is number => x != null), n8 = xs.filter((r) => !r.old).map((r) => r.fwd[L]).filter((x): x is number => x != null);
      const ex = xs.map((r) => r.ext).filter((x): x is [number, number] => x != null);
      out.push(`  ${kind.padEnd(14)} ${d > 0 ? 'long ' : 'short'} ${String(xs.length).padStart(4)}  ${cols.join('  ')}   ${f(avg(o8), 1)}% (${o8.length}) / ${f(avg(n8), 1)}% (${n8.length})   ${avg(ex.map((x) => x[0])).toFixed(1)}% / ${avg(ex.map((x) => x[1])).toFixed(1)}%`);
    }
  }
  out.push('', ...mapTable(lvlSamples, `${TF} RSI 14 LEVELS (standard RSI, ${H[0]} bars ahead, +-1 ATR first touch; same columns as the Prism map)`));
  for (const sym of show) {
    const support = ['support-lost', 'held-div', 'reclaim-div', 'reclaim', 'sequence', 'db-div', 'support-hold', 'floor', 'under-floor'];
    const xs = rows.filter((r) => r.sym === sym && (tf !== '4h' || support.includes(r.kind))).sort((a, b) => a.t - b.t);
    out.push('', `${sym} ${TF} signals (date, side, kind, RSI 14, Prism mid, move ${H.map((h) => `${h}${T.unit}`).join(' / ')} in the signal's direction):`);
    for (const r of xs) out.push(`  ${day(r.t)} ${r.d > 0 ? 'BUY ' : 'SELL'} ${r.kind.padEnd(12)} RSI14 ${r.rsi14 == null ? '-' : r.rsi14.toFixed(0)}  prism ${r.prism.toFixed(0)}${r.floor != null ? `  floor ${r.floor.toFixed(1)}` : ''}   ${r.fwd.map((v) => (v == null ? '-' : `${f(v, 0)}%`)).join(' / ')}`);
  }
  return out;
}
