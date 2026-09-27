// T3 component diagnostics and T4 score distribution (docs/confluence/TASKS.md).
// T3: value frequencies and the pairwise correlation matrix over every
// research decision time (no outcomes involved), and forward returns by
// value on the first train window only (fold 1), so nothing a later test
// block is scored on informs a choice made here.
// T4: histograms of S, the share of decision times past each |S| level, and
// how many existing 1H setups pass each t_entry per 12-month train window.

import { intervalMs } from '@bot/marketdata';
import { analyze, detectSetup, DEFAULT_SETUP } from '@bot/smc';
import type { SymbolData } from '../types';
import type { Fold } from '../walkforward';
import type { ScorePoint } from './components';

const H = intervalMs('1h');

export interface Diagnostics {
  keys: string[];
  frequency: Record<string, { plus: number; zero: number; minus: number }>;
  correlation: Record<string, Record<string, number | null>>;
  flaggedPairs: { a: string; b: string; rho: number }[];
  forward: Record<string, Record<'4h' | '12h' | '24h', { plus: number | null; zero: number | null; minus: number | null; edge: number | null }>>;
  forwardWindow: [number, number];
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0; let my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]!; my += ys[i]!; }
  mx /= n; my /= n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i]! - mx; const b = ys[i]! - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Close-to-close return from the 1H close at t to the 1H close h hours later, or null. */
function forwardReturn(closeAt: Map<number, number>, t: number, hours: number): number | null {
  const a = closeAt.get(t);
  const b = closeAt.get(t + hours * H);
  return a != null && b != null && a > 0 ? b / a - 1 : null;
}

export function diagnostics(
  tables: Record<string, ScorePoint[]>, data: Readonly<Record<string, SymbolData>>, forwardWindow: [number, number], maxAbsCorr = 0.7,
): Diagnostics {
  const rows = Object.values(tables).flat();
  const groupKeys = rows.length ? Object.keys(rows[0]!.g).map((g) => `group.${g}`) : [];
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.c)))].sort().concat(groupKeys);
  const value = (r: ScorePoint, k: string): number | undefined => (k.startsWith('group.') ? r.g[k.slice(6) as keyof ScorePoint['g']] : r.c[k]);

  const frequency: Diagnostics['frequency'] = {};
  for (const k of keys) {
    const vs = rows.map((r) => value(r, k)).filter((v): v is number => v != null);
    const n = vs.length || 1;
    frequency[k] = { plus: vs.filter((v) => v > 0).length / n, zero: vs.filter((v) => v === 0).length / n, minus: vs.filter((v) => v < 0).length / n };
  }

  const comp = keys.filter((k) => !k.startsWith('group.'));
  const correlation: Diagnostics['correlation'] = {};
  const flaggedPairs: Diagnostics['flaggedPairs'] = [];
  for (let i = 0; i < comp.length; i++) {
    correlation[comp[i]!] = {};
    for (let j = 0; j < comp.length; j++) {
      const both = rows.filter((r) => r.c[comp[i]!] != null && r.c[comp[j]!] != null);
      const rho = pearson(both.map((r) => r.c[comp[i]!]!), both.map((r) => r.c[comp[j]!]!));
      correlation[comp[i]!]![comp[j]!] = rho;
      if (j > i && rho != null && Math.abs(rho) > maxAbsCorr) flaggedPairs.push({ a: comp[i]!, b: comp[j]!, rho });
    }
  }

  const forward: Diagnostics['forward'] = {};
  const closes = new Map<string, Map<number, number>>();
  for (const s of Object.keys(tables)) closes.set(s, new Map((data[s]!.candles['1h'] ?? []).map((c) => [c.openTime + H, c.close])));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  for (const k of keys) {
    forward[k] = {} as Diagnostics['forward'][string];
    for (const [label, hours] of [['4h', 4], ['12h', 12], ['24h', 24]] as const) {
      const buckets = { plus: [] as number[], zero: [] as number[], minus: [] as number[] };
      for (const [s, table] of Object.entries(tables)) {
        for (const r of table) {
          if (r.t <= forwardWindow[0] || r.t + hours * H > forwardWindow[1]) continue; // outcome inside the train window too
          const v = value(r, k);
          const fr = forwardReturn(closes.get(s)!, r.t, hours);
          if (v == null || fr == null) continue;
          (v > 0 ? buckets.plus : v < 0 ? buckets.minus : buckets.zero).push(fr);
        }
      }
      const plus = mean(buckets.plus); const minus = mean(buckets.minus);
      forward[k]![label] = { plus, zero: mean(buckets.zero), minus, edge: plus != null && minus != null ? plus - minus : null };
    }
  }
  return { keys, frequency, correlation, flaggedPairs, forward, forwardWindow };
}

export interface Distribution {
  weightSets: string[];
  histogram: Record<string, { overall: number[]; perCoin: Record<string, number[]> }>;
  shareAbove: Record<string, Record<number, number>>;
  /** Existing 1H setups whose S on the MSS close passes t_entry in the setup's direction, per fold train window. */
  setupsPassing: Record<string, Record<number, number[]>>;
  setupsTotal: number[];
}

const BINS = 20; // -100..100 in steps of 10

export function distribution(
  tables: Record<string, ScorePoint[]>, data: Readonly<Record<string, SymbolData>>, folds: Fold[], thresholds: number[], levels = [40, 50, 60, 70], maxCostRatio = 0.15,
): Distribution {
  const rows = Object.values(tables).flat();
  const weightSets = rows.length ? Object.keys(rows[0]!.S) : [];
  const bin = (s: number) => Math.min(BINS - 1, Math.max(0, Math.floor((s + 100) / 10)));
  const histogram: Distribution['histogram'] = {};
  const shareAbove: Distribution['shareAbove'] = {};
  for (const w of weightSets) {
    const overall: number[] = new Array(BINS).fill(0);
    const perCoin: Record<string, number[]> = {};
    for (const [s, table] of Object.entries(tables)) {
      const mine: number[] = new Array(BINS).fill(0);
      for (const r of table) { const b = bin(r.S[w]!); overall[b] = (overall[b] ?? 0) + 1; mine[b] = (mine[b] ?? 0) + 1; }
      perCoin[s] = mine;
    }
    histogram[w] = { overall, perCoin };
    shareAbove[w] = Object.fromEntries(levels.map((l) => [l, rows.filter((r) => Math.abs(r.S[w]!) >= l).length / (rows.length || 1)]));
  }

  // Mode X candidates: the existing 1H setup (MTF entry model), past the cost veto, S read at the MSS close.
  const setupsPassing: Distribution['setupsPassing'] = Object.fromEntries(weightSets.map((w) => [w, Object.fromEntries(thresholds.map((x) => [x, folds.map(() => 0)]))]));
  const setupsTotal = folds.map(() => 0);
  for (const [s, table] of Object.entries(tables)) {
    const candles = data[s]!.candles['1h'];
    if (!candles?.length) continue;
    const a = analyze(candles);
    const byT = new Map(table.map((r) => [r.t, r]));
    for (let k = 2; k < candles.length; k++) {
      const setup = detectSetup(a, k, DEFAULT_SETUP);
      if (!setup) continue;
      const d = (Math.abs(setup.entry - setup.stop) / setup.entry) * 100;
      if (!(d > 0) || 0.1 / d > maxCostRatio) continue;
      const mssClose = candles[setup.mssIndex]!.openTime + H;
      const r = byT.get(mssClose);
      if (!r) continue;
      folds.forEach((f, fi) => {
        if (mssClose <= f.train[0] || mssClose > f.train[1]) return;
        setupsTotal[fi] = (setupsTotal[fi] ?? 0) + 1;
        for (const w of weightSets) for (const x of thresholds) {
          const row = setupsPassing[w]![x]!;
          if (setup.side === 'long' ? r.S[w]! >= x : r.S[w]! <= -x) row[fi] = (row[fi] ?? 0) + 1;
        }
      });
    }
  }
  return { weightSets, histogram, shareAbove, setupsPassing, setupsTotal };
}

export function formatDiagnostics(d: Diagnostics, dist: Distribution, folds: Fold[], minTrain: number): string {
  const day = (x: number) => new Date(x).toISOString().slice(0, 10);
  const pct = (x: number) => `${(x * 100).toFixed(0).padStart(3)}%`;
  const bps = (x: number | null) => (x == null ? '    -' : `${(x * 10_000).toFixed(1).padStart(5)}`);
  const lines = ['T3 COMPONENT DIAGNOSTICS', '', 'Value frequency (all research decision times):', '  component                     +1    0   -1'];
  for (const k of d.keys) { const f = d.frequency[k]!; lines.push(`  ${k.padEnd(28)} ${pct(f.plus)} ${pct(f.zero)} ${pct(f.minus)}`); }
  lines.push('', `Forward 1H-close returns by value, bps (train window ${day(d.forwardWindow[0])} → ${day(d.forwardWindow[1])} only):`, '  component                    horizon    +1     0    -1   edge(+1 minus -1)');
  for (const k of d.keys) for (const h of ['4h', '12h', '24h'] as const) {
    const x = d.forward[k]![h];
    lines.push(`  ${k.padEnd(28)} ${h.padStart(4)}   ${bps(x.plus)} ${bps(x.zero)} ${bps(x.minus)}   ${bps(x.edge)}`);
  }
  lines.push('', 'Pairs with |correlation| > 0.7 (owner decides which to keep):');
  lines.push(...(d.flaggedPairs.length ? d.flaggedPairs.map((p) => `  ${p.a} ~ ${p.b}: ${p.rho.toFixed(2)}`) : ['  none']));
  const comp = d.keys.filter((k) => !k.startsWith('group.'));
  lines.push('', 'Correlation matrix (components, rows/columns in the order above):');
  for (const a of comp) lines.push(`  ${a.padEnd(28)} ${comp.map((b) => (d.correlation[a]![b] == null ? '   - ' : d.correlation[a]![b]!.toFixed(2).padStart(5))).join(' ')}`);

  lines.push('', 'T4 SCORE DISTRIBUTION', '');
  for (const w of dist.weightSets) {
    const h = dist.histogram[w]!.overall;
    const total = h.reduce((a, b) => a + b, 0) || 1;
    lines.push(`${w}: share of decision times with |S| >= ${Object.entries(dist.shareAbove[w]!).map(([l, s]) => `${l}: ${(s * 100).toFixed(1)}%`).join(', ')}`);
    lines.push(`  histogram (S from -100 to +100 in steps of 10): ${h.map((x) => `${((x / total) * 100).toFixed(1)}%`).join(' ')}`);
  }
  lines.push('', `Existing 1H setups past the cost veto whose S passes t_entry on the MSS close, per 12-month train window (need >= ${minTrain} trades; setups are an upper bound on trades):`);
  lines.push(`  fold train window            all setups  ${dist.weightSets.flatMap((w) => Object.keys(dist.setupsPassing[w]!).map((x) => `${w}@${x}`.padStart(8))).join('')}`);
  folds.forEach((f, fi) => {
    lines.push(`  ${String(f.index).padStart(4)} ${day(f.train[0])}→${day(f.train[1])} ${String(dist.setupsTotal[fi]).padStart(10)}  ${dist.weightSets.flatMap((w) => Object.keys(dist.setupsPassing[w]!).map((x) => String(dist.setupsPassing[w]![Number(x)]![fi]).padStart(8))).join('')}`);
  });
  const meets = dist.weightSets.flatMap((w) => Object.keys(dist.setupsPassing[w]!).filter((x) => dist.setupsPassing[w]![Number(x)]!.every((n) => n >= minTrain)).map((x) => `${w} @ ${x}`));
  lines.push(`  t_entry values with >= ${minTrain} setups in every train window: ${meets.length ? meets.join(', ') : 'none'}`);
  return lines.join('\n');
}
