// T2 (docs/confluence/TASKS.md): the per-coin table of every component and
// S at each 1H close, and the lookahead check that recomputes random points
// from history truncated at t and requires exact equality.

import { intervalMs } from '@bot/marketdata';
import type { StructureConfig } from '@bot/smc';
import type { SymbolData, Tf } from '../types';
import { coinFeatures, scoreAt, type ScorePoint } from './components';
import { weightSets, type ScoreConfig } from './config';

const H = intervalMs('1h');

/** Every 1H close in (from, to] for which the coin has a closed 1H bar. */
export function decisionTimes(data: SymbolData, from: number, to: number): number[] {
  return (data.candles['1h'] ?? []).map((c) => c.openTime + H).filter((t) => t > from && t <= to);
}

export function scoreTable(all: Readonly<Record<string, SymbolData>>, symbol: string, from: number, to: number, cfg: ScoreConfig, structure?: StructureConfig): ScorePoint[] {
  const f = coinFeatures(all, symbol, cfg, structure);
  const w = weightSets(cfg);
  return decisionTimes(all[symbol]!, from, to).map((t) => scoreAt(f, t, cfg, w));
}

/** The data as it was known at t: bars closed by t, funding settled by t. */
export function truncateAt(all: Readonly<Record<string, SymbolData>>, symbols: string[], t: number): Record<string, SymbolData> {
  const out: Record<string, SymbolData> = {};
  for (const s of symbols) {
    const d = all[s];
    if (!d) continue;
    const candles: SymbolData['candles'] = {};
    for (const [tf, list] of Object.entries(d.candles) as [Tf, NonNullable<SymbolData['candles'][Tf]>][]) {
      const ms = intervalMs(tf);
      candles[tf] = list.filter((c) => c.openTime + ms <= t);
    }
    out[s] = { ...d, candles, mark15m: d.mark15m?.filter((c) => c.openTime + intervalMs('15m') <= t), funding: d.funding?.filter((x) => x.time <= t) };
  }
  return out;
}

export interface LookaheadResult { checked: number; mismatches: { symbol: string; t: number; key: string; full: number; truncated: number }[] }

/**
 * For `samples` random (coin, t): the score recomputed from history
 * truncated at t must equal the full-history value exactly, component by
 * component, group by group, and for every weight set.
 */
export function lookaheadCheck(all: Readonly<Record<string, SymbolData>>, symbols: string[], from: number, to: number, cfg: ScoreConfig, samples: number, seed = 1, structure?: StructureConfig): LookaheadResult {
  let s = seed >>> 0 || 1;
  const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const w = weightSets(cfg);
  const full = new Map(symbols.map((sym) => [sym, coinFeatures(all, sym, cfg, structure)]));
  const times = new Map(symbols.map((sym) => [sym, decisionTimes(all[sym]!, from, to)]));
  const mismatches: LookaheadResult['mismatches'] = [];
  let checked = 0;
  for (let n = 0; n < samples; n++) {
    const sym = symbols[Math.floor(rand() * symbols.length)]!;
    const ts = times.get(sym)!;
    if (!ts.length) continue;
    const t = ts[Math.floor(rand() * ts.length)]!;
    const a = scoreAt(full.get(sym)!, t, cfg, w);
    const cut = truncateAt(all, [...new Set([sym, 'BTCUSDT'])], t);
    const b = scoreAt(coinFeatures(cut, sym, cfg, structure), t, cfg, w);
    const flat = (p: ScorePoint) => ({ ...Object.fromEntries(Object.entries(p.c).map(([k, v]) => [`c.${k}`, v])), ...Object.fromEntries(Object.entries(p.g).map(([k, v]) => [`g.${k}`, v])), ...Object.fromEntries(Object.entries(p.S).map(([k, v]) => [`S.${k}`, v])) });
    const fa = flat(a) as Record<string, number>;
    const fb = flat(b) as Record<string, number>;
    for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (fa[key] !== fb[key]) mismatches.push({ symbol: sym, t, key, full: fa[key] ?? NaN, truncated: fb[key] ?? NaN });
    }
    checked++;
  }
  return { checked, mismatches };
}
