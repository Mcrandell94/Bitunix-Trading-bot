// T5 (docs/confluence/TASKS.md): Stage A, Mode X. The existing 1H SMC setup
// taken only when the confluence score S passes the threshold on the MSS
// candle's close, with the SPEC §4 vetoes and §5 exits. Walk-forward over
// A1/A2 x the t_entry grid, the monotonicity test, benchmarks (a)-(c) and
// the Monte Carlo drawdown (SPEC §7).
//
// Trades carry the MSS close time as their tag, so one run's trades can be
// scored under either weight set afterwards.

import { intervalMs } from '@bot/marketdata';
import type { RunMode, CandidateOverride } from '../engine';
import { runBacktest } from '../engine';
import type { Side } from '@bot/risk';
import type { BacktestConfig, SymbolData, Trade } from '../types';
import { block, type Block, type Fold } from '../walkforward';
import type { ScorePoint } from './components';
import type { ScoreConfig } from './config';

const H = intervalMs('1h');

type Num = Record<string, unknown>;
const num = (o: unknown, path: string, dflt: number): number => {
  let x: unknown = o;
  for (const k of path.split('.')) x = x && typeof x === 'object' ? (x as Num)[k] : undefined;
  return typeof x === 'number' ? x : dflt;
};

/** Mode X on the MTF slot: SPEC §4 entry and vetoes, §5 exits, flat 1% risk, fill realism on. */
export function modeXConfig(base: BacktestConfig, sc: ScoreConfig): BacktestConfig {
  const s = sc as unknown as Num;
  const riskPct = num(s, 'risk.risk_per_trade_pct', 1);
  const maxCost = num(s, 'vetoes.max_cost_ratio', 0.15);
  const ch = (s.exits as Num | undefined)?.chandelier as Num | undefined;
  const ts = (s.exits as Num | undefined)?.time_stop as Num | undefined;
  return {
    ...base,
    fillRealism: true,
    // Cost ratio veto: skip if 0.10 / d > max_cost_ratio, i.e. d < 0.10 / max_cost_ratio (%).
    minStopPct: 0.10 / maxCost,
    fundingFillBlackoutMinutes: num(s, 'vetoes.funding_blackout_min', 15),
    portfolio: { maxOpenRiskPct: num(s, 'risk.max_total_open_risk_pct', 6), maxSameDirAlts: num(s, 'risk.max_same_dir_alts', 2) },
    risk: {
      ...base.risk,
      fundingGapMinutes: 0, // replaced by the fill blackout
      maxPositionsPerSymbolTier: 1,
      tiers: { ...base.risk.tiers, MTF: { ...base.risk.tiers.MTF, riskPct, dailyLossPct: num(s, 'risk.daily_loss_limit_pct', 8), maxEffectiveLeverage: num(s, 'risk.max_effective_leverage', 5) } },
    },
    tiers: {
      LTF: { ...base.tiers.LTF, enabled: false },
      HTF: { ...base.tiers.HTF, enabled: false },
      P4H: { ...base.tiers.P4H, enabled: false },
      P1H: { ...base.tiers.P1H, enabled: false },
      MTF: {
        ...base.tiers.MTF, enabled: true, model: 'smc', entryTf: '1h', bias: 'off', confirmTfs: undefined,
        expiryBars: num(s, 'entry.mode_X.expiry_bars', 8),
        cancelOn1RTouch: true, cancelOnZoneClose: true,
        rewardR: num(s, 'exits.cap_R', 8),
        partials: [{ atR: 1, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }],
        breakevenAtR: null, trailTf: null,
        stopSteps: [{ atR: 1, toR: num(s, 'exits.stop_at_1R_R', -0.5) }, { atR: 2, toPct: num(s, 'exits.stop_at_2R_offset_pct', 0.1) }],
        chandelier: { activateR: Number(ch?.activate_R ?? 2), atrTf: '4h', atrLen: Number(ch?.atr_len ?? 22), mult: Number(ch?.mult ?? 3) },
        timeStop: { barTf: '1h', checkBars: Number(ts?.check_bars_1h ?? 48), minMfeR: Number(ts?.min_mfe_R ?? 1), maxBars: Number(ts?.max_bars_1h ?? 240) },
      },
    },
  };
}

/** symbol -> 1H close time -> S, for one weight set. */
export type ScoreLookup = Map<string, Map<number, number>>;

export function scoreLookup(tables: Readonly<Record<string, ScorePoint[]>>, weightSet: string): ScoreLookup {
  return new Map(Object.entries(tables).map(([sym, rows]) => [sym, new Map(rows.map((p) => [p.t, p.S[weightSet] ?? 0]))]));
}

/** S signed toward the trade: +S for longs, -S for shorts. */
export const aligned = (side: Side, s: number) => (side === 'long' ? s : -s);

/** Mode X gate: long needs S >= T, short S <= -T, S read at the MSS candle's close. Tags the trade with that time. */
export function scoreGate(lookup: ScoreLookup | null, threshold: number): NonNullable<RunMode['gate']> {
  return ({ symbol, side, mssTime }) => {
    if (!lookup) return { tag: mssTime };
    const s = lookup.get(symbol)?.get(mssTime);
    if (s == null) return 'no score';
    return aligned(side, s) >= threshold ? { tag: mssTime } : `score ${s.toFixed(0)} below ${threshold}`;
  };
}

const within = (t: number, [a, b]: [number, number]) => t >= a && t < b;
const inTest = (t: number, folds: Fold[]) => folds.some((f) => within(t, f.test));

export interface ConfigRun { weightSet: string; threshold: number; trades: Trade[] }

export interface WalkRow { fold: Fold; perConfig: { weightSet: string; threshold: number; train: Block; test: Block }[]; chosen: { weightSet: string; threshold: number } | null; chosenTest: Block }

/**
 * Per fold: every config's train and test block; the config with the best
 * train expectancy among those with >= minTrain train trades is applied to
 * the test block (none qualifies: no trades that block).
 */
export function walkForwardSelect(runs: ConfigRun[], folds: Fold[], minTrain: number): { rows: WalkRow[]; oos: Block; oosTrades: Trade[] } {
  const rows: WalkRow[] = [];
  const oosTrades: Trade[] = [];
  for (const fold of folds) {
    const perConfig = runs.map((r) => ({
      weightSet: r.weightSet, threshold: r.threshold,
      train: block(r.trades.filter((t) => within(t.openedAt, fold.train))),
      test: block(r.trades.filter((t) => within(t.openedAt, fold.test))),
    }));
    const eligible = perConfig.filter((c) => c.train.n >= minTrain && c.train.expectancyR != null);
    const best = eligible.sort((a, b) => b.train.expectancyR! - a.train.expectancyR!)[0];
    const run = best ? runs.find((r) => r.weightSet === best.weightSet && r.threshold === best.threshold)! : null;
    const test = run ? run.trades.filter((t) => within(t.openedAt, fold.test)) : [];
    oosTrades.push(...test);
    rows.push({ fold, perConfig, chosen: best ? { weightSet: best.weightSet, threshold: best.threshold } : null, chosenTest: block(test) });
  }
  return { rows, oos: block(oosTrades), oosTrades };
}

/** Spearman rank correlation (average ranks for ties). NaN with fewer than 2 points or no variance. */
export function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
      for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  if (xs.length < 2) return NaN;
  const rx = rank(xs);
  const ry = rank(ys);
  const m = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = m(rx);
  const my = m(ry);
  let num2 = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num2 += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return dx && dy ? num2 / Math.sqrt(dx * dy) : NaN;
}

/** A trade with the score it was taken on, signed toward its side. */
export interface Scored { symbol: string; openedAt: number; side: Side; r: number; mssTime: number; score: number }

export function scoreTrades(trades: Trade[], lookup: ScoreLookup): Scored[] {
  return trades.flatMap((t) => {
    const s = t.tag != null ? lookup.get(t.symbol)?.get(t.tag) : undefined;
    return s == null ? [] : [{ symbol: t.symbol, openedAt: t.openedAt, side: t.side, r: t.r, mssTime: t.tag!, score: aligned(t.side, s) }];
  });
}

export interface MonoFold { fold: number; buckets: { from: number; to: number; n: number; expectancyR: number | null }[]; rho: number }

/**
 * SPEC §7 monotonicity: out-of-sample candidates bucketed by aligned score
 * into [20,40) ... [80,100]; Spearman between bucket rank and expectancy over
 * the non-empty buckets, per fold.
 */
export function monotonicity(cands: Scored[], folds: Fold[], edges = [20, 40, 60, 80, 100]): { folds: MonoFold[]; positive: number } {
  const out = folds.map((f) => {
    const test = cands.filter((c) => within(c.openedAt, f.test));
    const buckets = edges.slice(0, -1).map((lo, i) => {
      const hi = edges[i + 1]!;
      const last = i === edges.length - 2;
      const b = test.filter((c) => c.score >= lo && (last ? c.score <= hi : c.score < hi));
      return { from: lo, to: hi, n: b.length, expectancyR: b.length ? b.reduce((a, c) => a + c.r, 0) / b.length : null };
    });
    const full = buckets.map((b, i) => [i, b.expectancyR] as const).filter((x): x is readonly [number, number] => x[1] != null);
    return { fold: f.index, buckets, rho: spearman(full.map((x) => x[0]), full.map((x) => x[1])) };
  });
  return { folds: out, positive: out.filter((f) => f.rho > 0).length };
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const pctile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? NaN;
};
const rankOf = (xs: number[], x: number) => xs.filter((v) => v < x).length / Math.max(1, xs.length);

export interface NullResult { real: number; p95: number; pctile: number; draws: number; n: number }

/**
 * Benchmark (c): S replaced by a random score with the same distribution.
 * Each coin's S series is shuffled across its decision times; every
 * candidate setup (out of sample) takes the shuffled S at its MSS close and
 * the threshold is applied as usual. Statistic: expectancy of the selected.
 * Setups are evaluated on their isolated outcomes (the candidate run), so
 * portfolio interactions are left out on both sides of the comparison.
 */
export function shuffledScore(cands: Scored[], lookup: ScoreLookup, threshold: number, folds: Fold[], runs: number, seed = 7): NullResult {
  const oos = cands.filter((c) => inTest(c.openedAt, folds));
  const sel = (score: (c: Scored) => number) => {
    const s = oos.filter((c) => score(c) >= threshold);
    return { n: s.length, exp: s.length ? s.reduce((a, c) => a + c.r, 0) / s.length : 0 };
  };
  const real = sel((c) => c.score);
  const rand = rng(seed);
  const series = new Map([...lookup].map(([sym, m]) => [sym, { times: [...m.keys()], values: [...m.values()] }]));
  const draws: number[] = [];
  for (let k = 0; k < runs; k++) {
    const shuffled = new Map<string, Map<number, number>>();
    for (const [sym, { times, values }] of series) {
      const v = [...values];
      for (let i = v.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [v[i], v[j]] = [v[j]!, v[i]!]; }
      shuffled.set(sym, new Map(times.map((t, i) => [t, v[i]!])));
    }
    draws.push(sel((c) => aligned(c.side, shuffled.get(c.symbol)?.get(c.mssTime) ?? 0)).exp);
  }
  return { real: real.exp, p95: pctile(draws, 0.95), pctile: rankOf(draws, real.exp), draws: runs, n: real.n };
}

/** One out-of-sample trade's market-entry outcomes both ways (benchmark a). */
export interface EntryKey { symbol: string; hour: number; stopPct: number }

/**
 * Keys spread over layers so no two on one coin sit within `gapMs` of each
 * other in one layer (the engine holds one position per coin; a gap of the
 * longest possible trade keeps the runs from blocking each other).
 */
export function layerKeys(keys: EntryKey[], gapMs: number): EntryKey[][] {
  const layers: { last: Map<string, number>; keys: EntryKey[] }[] = [];
  for (const k of [...keys].sort((a, b) => a.hour - b.hour)) {
    let l = layers.find((x) => (x.last.get(k.symbol) ?? -Infinity) + gapMs <= k.hour);
    if (!l) { l = { last: new Map(), keys: [] }; layers.push(l); }
    l.keys.push(k);
    l.last.set(k.symbol, k.hour);
  }
  return layers.map((l) => l.keys);
}

/** The hour close at or before a fill: where the market entry is placed. */
export const entryHour = (t: Trade) => Math.floor(t.openedAt / H) * H;

/**
 * Market entries at each key's hour close, stop at the same distance (%),
 * managed by the same exits: R for long and for short. Portfolio caps and the
 * daily limit are off so each outcome is isolated.
 */
export function marketOutcomes(data: Readonly<Record<string, SymbolData>>, cfg: BacktestConfig, keys: EntryKey[]): Map<string, { long?: number; short?: number }> {
  const iso: BacktestConfig = {
    ...cfg, portfolio: null, minStopPct: 0, fundingFillBlackoutMinutes: undefined,
    risk: { ...cfg.risk, coreExposureCap: 1e9, tiers: { ...cfg.risk.tiers, MTF: { ...cfg.risk.tiers.MTF, dailyLossPct: 1e9, maxEffectiveLeverage: 1e9 } } },
  };
  const out = new Map<string, { long?: number; short?: number }>();
  const maxBars = cfg.tiers.MTF.timeStop?.maxBars ?? 240;
  for (const layer of layerKeys(keys, (maxBars + 2) * H)) {
    const at = new Map(layer.map((k) => [`${k.symbol}|${k.hour}`, k]));
    for (const side of ['long', 'short'] as const) {
      const override: CandidateOverride = ({ tier, symbol, time }) => {
        const k = tier === 'MTF' ? at.get(`${symbol}|${time}`) : undefined;
        if (!k) return null;
        const c = data[symbol]!.candles['1h']!.find((x) => x.openTime + H === time);
        if (!c) return null;
        const d = c.close * k.stopPct;
        return { side, entry: c.close, stop: side === 'long' ? c.close - d : c.close + d, source: 'core', market: true, tag: time };
      };
      for (const t of runBacktest(data, iso, override).trades) {
        const key = `${t.symbol}|${t.tag}`;
        out.set(key, { ...out.get(key), [side]: t.r });
      }
    }
  }
  return out;
}

/**
 * Benchmark (a): the same trades (coin, hour, stop distance) entered at
 * market with a random direction; 500 draws of total R. Also the
 * bias-directed variant (direction = sign of the daily group, ties random).
 */
export function randomEntryNull(trades: Trade[], outcomes: Map<string, { long?: number; short?: number }>, runs: number, dailySign?: (t: Trade) => number, seed = 11): { real: number; covered: number; n: number; random: NullResult; biasDirected: NullResult | null } {
  const rows = trades.map((t) => ({ t, o: outcomes.get(`${t.symbol}|${entryHour(t)}`) })).filter((x) => x.o?.long != null && x.o?.short != null);
  const real = rows.reduce((a, x) => a + x.t.r, 0);
  const rand = rng(seed);
  const draw = (pick: (x: (typeof rows)[number]) => 'long' | 'short') => rows.reduce((a, x) => a + x.o![pick(x)]!, 0);
  const random = Array.from({ length: runs }, () => draw(() => (rand() < 0.5 ? 'long' : 'short')));
  const res = (d: number[]): NullResult => ({ real, p95: pctile(d, 0.95), pctile: rankOf(d, real), draws: runs, n: rows.length });
  let biasDirected: NullResult | null = null;
  if (dailySign) {
    const d = Array.from({ length: runs }, () => draw((x) => { const s = dailySign(x.t); return s > 0 ? 'long' : s < 0 ? 'short' : rand() < 0.5 ? 'long' : 'short'; }));
    biasDirected = res(d);
  }
  return { real, covered: rows.length, n: trades.length, random: res(random), biasDirected };
}

/** 95th-percentile max drawdown (%) over bootstrap resamples of the trade sequence, compounding at riskPct per R. */
export function monteCarloDrawdown(rs: number[], riskPct: number, resamples: number, seed = 3): { p95: number; median: number } {
  if (!rs.length) return { p95: 0, median: 0 };
  const rand = rng(seed);
  const dds: number[] = [];
  for (let k = 0; k < resamples; k++) {
    let eq = 1, peak = 1, dd = 0;
    for (let i = 0; i < rs.length; i++) {
      eq *= Math.max(0, 1 + (riskPct / 100) * rs[Math.floor(rand() * rs.length)]!);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
    }
    dds.push(dd * 100);
  }
  return { p95: pctile(dds, 0.95), median: pctile(dds, 0.5) };
}
