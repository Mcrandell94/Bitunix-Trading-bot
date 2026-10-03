// RSI framework study (owner 2026-10-03): where on each timeframe does the Prism Adaptive RSI favour longs, and where
// shorts? Model-free: every closed bar of every research coin, its Prism RSI, and what price did next. Each timeframe
// is mapped on its own (weekly, daily, 4H, 1H), so the zones can be set per timeframe before they are applied.
import { intervalMs, type Candle } from '@bot/marketdata';
import { atrWilder } from '../indicators';
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
export function mapSamples(c: ReadonlyArray<Candle>, h: number, from: number, to: number, cut: number, line: 'mid' | 'fast' | 'slow' = 'mid'): MapSample[] {
  const p = prismRsi(c.map((b) => b.close)), atr = atrWilder(c, 14), iv = c.length > 1 ? c[1]!.openTime - c[0]!.openTime : 0;
  const out: MapSample[] = [];
  for (let i = 0; i + h < c.length; i++) {
    const t = c[i]!.openTime;
    if (t < from || c[i + h]!.openTime + iv > to) continue;
    const r = p[line][i]!, a = atr[i];
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
