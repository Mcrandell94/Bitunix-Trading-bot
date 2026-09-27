// Confluence score components (docs/confluence/SPEC.md §2-§3). Every value
// at decision time t (a 1H close) comes from bars closed by t only (§1.2):
// each timeframe is read at barAt(list, interval, t), swings only once
// confirmed by then, funding settlements at or before t. The same code runs
// on full and on truncated history; the lookahead test compares the two.

import { intervalMs, type Candle } from '@bot/marketdata';
import { analyze, barAt, detectShift, DEFAULT_SETUP, knownCount, type SeriesAnalysis, type SetupConfig, type StructureConfig } from '@bot/smc';
import { readRrg, resolveConfig } from '@bot/signals';
import { ema } from '../indicators';
import type { SymbolData, Tf } from '../types';
import type { ComponentName, GroupName, ScoreConfig } from './config';

export type Sign = -1 | 0 | 1;
const TF_OF: Record<string, Tf> = { '1D': '1d', '4H': '4h', '1H': '1h', '15m': '15m' };
const RRG_BARS = 120;
const rrgConfig = resolveConfig();

/** Per coin and timeframe: candles, structure and the EMA, built once. */
export interface TfFeatures { tf: Tf; candles: ReadonlyArray<Candle>; analysis: SeriesAnalysis; ema: (number | null)[]; shift: Map<number, Sign> }

export function tfFeatures(candles: ReadonlyArray<Candle>, tf: Tf, cfg: ScoreConfig, structure?: StructureConfig): TfFeatures {
  return { tf, candles, analysis: analyze(candles, structure), ema: ema(candles.map((c) => c.close), cfg.components.C1_trend.ema_len), shift: new Map() };
}

/** Index of the last `tf` bar closed by t, or -1. */
export const closedIndex = (f: TfFeatures, t: number): number => barAt(f.candles, intervalMs(f.tf), t);

export function c1Trend(f: TfFeatures, i: number, cfg: ScoreConfig): Sign {
  const k = cfg.components.C1_trend.slope_lookback_bars;
  const e = f.ema[i];
  const e0 = i - k >= 0 ? f.ema[i - k] : null;
  if (e == null || e0 == null) return 0;
  const close = f.candles[i]!.close;
  if (close > e && e > e0) return 1;
  if (close < e && e < e0) return -1;
  return 0;
}

/** The last `n` swings of `list` confirmed by bar i (list is in confirmation order). */
function lastSwings<T extends { confirmedAt: number; price: number }>(list: ReadonlyArray<T>, i: number, n: number): T[] {
  const k = knownCount(list as never, i);
  return list.slice(Math.max(0, k - n), k) as T[];
}

export function c2Structure(f: TfFeatures, i: number, cfg: ScoreConfig): Sign {
  const n = cfg.components.C2_structure.swings_compared;
  const hs = lastSwings(f.analysis.long.highs, i, n);
  const ls = lastSwings(f.analysis.long.lows, i, n);
  if (hs.length < n || ls.length < n) return 0;
  const rising = (xs: { price: number }[]) => xs.every((x, j) => j === 0 || x.price > xs[j - 1]!.price);
  const falling = (xs: { price: number }[]) => xs.every((x, j) => j === 0 || x.price < xs[j - 1]!.price);
  if (rising(hs) && rising(ls)) return 1;
  if (falling(hs) && falling(ls)) return -1;
  return 0;
}

export function c3Location(f: TfFeatures, i: number, cfg: ScoreConfig): Sign {
  const hi = lastSwings(f.analysis.long.highs, i, 1)[0];
  const lo = lastSwings(f.analysis.long.lows, i, 1)[0];
  if (!hi || !lo || !(hi.price > lo.price)) return 0;
  const pos = (f.candles[i]!.close - lo.price) / (hi.price - lo.price);
  if (pos <= cfg.components.C3_location.discount_max) return 1;
  if (pos >= cfg.components.C3_location.premium_min) return -1;
  return 0;
}

/**
 * C4: a sweep followed by an MSS with displacement known within the last
 * `lookback_bars` bars (known at k = the bar after the MSS, k <= i); the most
 * recent wins. Uses the existing setup code without the entry zone.
 */
export function c4SmcEvent(f: TfFeatures, i: number, cfg: ScoreConfig): Sign {
  const p = cfg.components.C4_smc_event;
  const setup: SetupConfig = { ...DEFAULT_SETUP, displacementAtr: p.displacement_atr, displacementBodyRatio: p.body_ratio };
  for (let k = i; k > i - p.lookback_bars && k >= 1; k--) {
    let v = f.shift.get(k);
    if (v === undefined) {
      const s = detectShift(f.analysis, k, setup);
      v = s ? (s.side === 'long' ? 1 : -1) : 0;
      f.shift.set(k, v);
    }
    if (v !== 0) return v;
  }
  return 0;
}

export function m2Rotation(coin: TfFeatures, btc: TfFeatures, t: number, cfg: ScoreConfig): Sign {
  const i = closedIndex(coin, t);
  const j = closedIndex(btc, t);
  if (i < RRG_BARS - 1 || j < RRG_BARS - 1) return 0;
  const a = coin.candles.slice(i - RRG_BARS + 1, i + 1);
  const b = btc.candles.slice(j - RRG_BARS + 1, j + 1);
  if (a[0]!.openTime !== b[0]!.openTime || a.at(-1)!.openTime !== b.at(-1)!.openTime) return 0; // not aligned
  const r = readRrg(a.map((c) => c.close), b.map((c) => c.close), 'BTC', rrgConfig);
  if (!r) return 0;
  const p = cfg.components.M2_rotation;
  if (p.bullish.includes(r.quadrant)) return 1;
  if (p.bearish.includes(r.quadrant)) return -1;
  return 0;
}

export function m3Funding(data: SymbolData, t: number, cfg: ScoreConfig): Sign {
  const p = cfg.components.M3_funding;
  const settled = (data.funding ?? []).filter((x) => x.time <= t).slice(-p.mean_of_last);
  if (settled.length < p.mean_of_last) return 0;
  const meanPct = (settled.reduce((a, x) => a + x.rate, 0) / settled.length) * 100;
  if (meanPct > p.long_crowded_pct) return -1;
  if (meanPct < p.short_crowded_pct) return 1;
  return 0;
}

/** Everything the score needs for one coin (plus BTC for the market group). */
export interface CoinFeatures {
  symbol: string;
  data: SymbolData;
  tf: Partial<Record<Tf, TfFeatures>>;
  btc: Partial<Record<Tf, TfFeatures>>;
}

export function coinFeatures(all: Readonly<Record<string, SymbolData>>, symbol: string, cfg: ScoreConfig, structure?: StructureConfig): CoinFeatures {
  const build = (s: string) => {
    const out: Partial<Record<Tf, TfFeatures>> = {};
    for (const tf of ['15m', '1h', '4h', '1d'] as Tf[]) {
      const c = all[s]?.candles[tf];
      if (c?.length) out[tf] = tfFeatures(c, tf, cfg, structure);
    }
    return out;
  };
  const tf = build(symbol);
  return { symbol, data: all[symbol]!, tf, btc: symbol === 'BTCUSDT' ? tf : build('BTCUSDT') };
}

export interface ScorePoint {
  t: number;
  /** Component values by `GROUP.component`, e.g. "H4.C4_smc_event". Excluded components are absent. */
  c: Record<string, Sign>;
  g: Record<GroupName, number>;
  /** S per weight set, -100..100. */
  S: Record<string, number>;
}

function componentValue(f: CoinFeatures, group: GroupName, name: ComponentName, t: number, cfg: ScoreConfig): Sign | null {
  if (group === 'MKT') {
    if (name === 'M1_btc_regime') {
      if (f.symbol === 'BTCUSDT') return null; // excluded for BTC itself
      const d = f.btc['1d'];
      const i = d ? closedIndex(d, t) : -1;
      return d && i >= 0 ? c1Trend(d, i, cfg) : 0;
    }
    if (name === 'M2_rotation') {
      if (f.symbol === 'BTCUSDT') return 0;
      const a = f.tf['4h'];
      const b = f.btc['4h'];
      return a && b ? m2Rotation(a, b, t, cfg) : 0;
    }
    if (name === 'M3_funding') return m3Funding(f.data, t, cfg);
    return 0;
  }
  const tf = TF_OF[cfg.groups[group].timeframe];
  const feat = tf ? f.tf[tf] : undefined;
  const i = feat ? closedIndex(feat, t) : -1;
  if (!feat || i < 0) return 0;
  switch (name) {
    case 'C1_trend': return c1Trend(feat, i, cfg);
    case 'C2_structure': return c2Structure(feat, i, cfg);
    case 'C3_location': return c3Location(feat, i, cfg);
    case 'C4_smc_event': return c4SmcEvent(feat, i, cfg);
    default: return 0;
  }
}

/** The score at decision time t, from bars closed by t. */
export function scoreAt(f: CoinFeatures, t: number, cfg: ScoreConfig, weights: Record<string, Record<GroupName, number>>): ScorePoint {
  const c: Record<string, Sign> = {};
  const g = {} as Record<GroupName, number>;
  for (const group of Object.keys(cfg.groups) as GroupName[]) {
    const vals: number[] = [];
    for (const name of cfg.groups[group].components) {
      const v = componentValue(f, group, name, t, cfg);
      if (v === null) continue;
      c[`${group}.${name}`] = v;
      vals.push(v);
    }
    g[group] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  const S: Record<string, number> = {};
  for (const [name, w] of Object.entries(weights)) {
    S[name] = 100 * (Object.keys(w) as GroupName[]).reduce((a, k) => a + w[k] * (g[k] ?? 0), 0);
  }
  return { t, c, g, S };
}
