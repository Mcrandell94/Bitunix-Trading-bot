// npm run tune [-- --days 365 --extras 10 --test-days 120]
//
// Tunes on the earlier part of the window (train) and checks the result on
// the later part it never saw (test), so improvements that only fit the
// past show up as such. One setting is varied at a time from the current
// defaults; a change is kept only if it adds at least MIN_GAIN_R on train.
// Settings that change the owner's spec (limit-order exits, LTF without an
// MTF position, stacking) are never adopted here, only reported.
// Writes tune-report.txt and tune-results.json.

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { intervalMs } from '@bot/marketdata';
import { CORE_SYMBOLS } from '@bot/signals';
import { apiTradable, selectUniverse } from '@bot/worker';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { maxDrawdown, stats } from './metrics';
import { defaultConfig, type BacktestConfig, type BacktestResult, type SymbolData } from './types';

const DAY = 86_400_000;
/** A train score needs at least this many trades to count. */
const MIN_TRADES = 25;
/** A setting replaces the default only if it adds at least this much total R on train. */
const MIN_GAIN_R = 1;

type Patch = (c: BacktestConfig) => BacktestConfig;
interface Option { label: string; patch: Patch }

const tier = (t: 'LTF' | 'MTF', over: Partial<BacktestConfig['tiers']['LTF']>): Patch => (c) =>
  ({ ...c, tiers: { ...c.tiers, [t]: { ...c.tiers[t], ...over } } });
const same: Patch = (c) => c;

/** The search space. The first option of each factor is the current default. */
export const FACTORS: Record<string, Option[]> = {
  'min stop distance': [0, 0.3, 0.5, 0.8].map((v) => ({ label: `${v}%`, patch: (c: BacktestConfig) => ({ ...c, minStopPct: v }) })),
  'bias rule': [
    { label: 'structure + confluence, lower TF can veto', patch: same },
    { label: 'structure + confluence, higher TF only', patch: (c) => ({ ...c, biasCombine: 'higher' }) },
    { label: 'structure only, lower TF can veto', patch: (c) => ({ ...c, bias: { ...c.bias, requireConfluence: false } }) },
    { label: 'structure only, higher TF only', patch: (c) => ({ ...c, biasCombine: 'higher', bias: { ...c.bias, requireConfluence: false } }) },
  ],
  'entry point in the gap': [0.5, 0.75, 1].map((v) => ({
    label: v === 0.5 ? 'middle (CE)' : v === 1 ? 'near edge' : '3/4 toward near edge',
    patch: (c: BacktestConfig) => ({ ...c, setup: { ...c.setup, entryFraction: v } }),
  })),
  'displacement strength': [1, 1.2, 1.5].map((v) => ({ label: `${v} ATR`, patch: (c: BacktestConfig) => ({ ...c, setup: { ...c.setup, displacementAtr: v } }) })),
  'order expiry': [
    { label: 'LTF 8 / MTF 6 bars', patch: same },
    { label: 'LTF 16 / MTF 12 bars', patch: (c) => tier('MTF', { expiryBars: 12 })(tier('LTF', { expiryBars: 16 })(c)) },
  ],
  'LTF target': [2, 3].map((v) => ({ label: `${v}R`, patch: tier('LTF', { rewardR: v }) })),
  'MTF runner cap': [5, 3].map((v) => ({ label: `${v}R`, patch: tier('MTF', { rewardR: v }) })),
};

/** Departures from the owner's spec: reported on top of the tuned settings, never adopted. */
export const SPEC_CHANGES: Option[] = [
  { label: 'targets as market orders on mark-price triggers (taker) instead of resting limits', patch: (c) => ({ ...c, targetFill: 'taker' }) },
  { label: 'LTF allowed without an open MTF position', patch: (c) => ({ ...c, risk: { ...c.risk, ltfRequiresMtf: false } }) },
  { label: 'stacking: up to 2 same-direction positions per coin per tier', patch: (c) => ({ ...c, risk: { ...c.risk, maxPositionsPerSymbolTier: 2 } }) },
];

export interface Row {
  trades: number;
  winRate: number;
  avgR: number;
  totalR: number;
  returnPct: number;
  maxDrawdownPct: number;
  fees: number;
}

function row(r: BacktestResult): Row {
  const s = stats(r.trades);
  return {
    trades: s.trades, winRate: s.winRate, avgR: s.expectancyR, totalR: s.totalR,
    returnPct: (r.endEquity / r.config.startEquity - 1) * 100,
    maxDrawdownPct: maxDrawdown(r.config.startEquity, r.equityCurve) * 100,
    fees: s.fees,
  };
}

const score = (r: Row) => (r.trades >= MIN_TRADES ? r.totalR : -Infinity);

export interface TuneResult {
  windows: { train: [number, number]; test: [number, number] };
  factors: { name: string; options: { label: string; train: Row }[]; chosen: string }[];
  baseline: Record<'train' | 'test' | 'full', Row>;
  tuned: Record<'train' | 'test' | 'full', Row>;
  specChanges: { label: string; test: Row; full: Row }[];
}

/** Pure search over already-loaded data; the CLI below handles downloading and writing files. */
export function tune(data: Readonly<Record<string, SymbolData>>, from: number, to: number, testDays: number, log: (m: string) => void = () => {}): TuneResult {
  const split = to - testDays * DAY;
  const base = defaultConfig(from, to);
  const run = (c: BacktestConfig, a: number, b: number) => row(runBacktest(data, { ...c, from: a, to: b }));

  const factors: TuneResult['factors'] = [];
  const picks: Patch[] = [];
  const baseTrain = run(base, from, split);
  for (const [name, options] of Object.entries(FACTORS)) {
    const results = options.map((o, i) => {
      log(`  ${name}: ${o.label}`);
      return { label: o.label, train: i === 0 ? baseTrain : run(o.patch(base), from, split), patch: o.patch };
    });
    const best = results.reduce((a, b) => (score(b.train) > score(a.train) ? b : a));
    const chosen = score(best.train) - score(baseTrain) >= MIN_GAIN_R ? best : results[0]!;
    picks.push(chosen.patch);
    factors.push({ name, options: results.map(({ label, train }) => ({ label, train })), chosen: chosen.label });
  }

  const tunedCfg = picks.reduce((c, p) => p(c), base);
  log('  comparing on the test window...');
  const both = (c: BacktestConfig) => ({ train: run(c, from, split), test: run(c, split, to), full: run(c, from, to) });
  const baseline = both(base);
  const tuned = both(tunedCfg);
  const specChanges = SPEC_CHANGES.map((o) => {
    log(`  spec change: ${o.label}`);
    const c = o.patch(tunedCfg);
    return { label: o.label, test: run(c, split, to), full: run(c, from, to) };
  });
  return { windows: { train: [from, split], test: [split, to] }, factors, baseline, tuned, specChanges };
}

const pct = (x: number) => `${x.toFixed(1)}%`;
function fmt(r: Row): string {
  return `${String(r.trades).padStart(4)} trades  win ${pct(r.winRate * 100).padStart(6)}  avg ${r.avgR.toFixed(2).padStart(5)}R  total ${r.totalR.toFixed(1).padStart(6)}R  return ${pct(r.returnPct).padStart(6)}  maxDD ${pct(r.maxDrawdownPct).padStart(5)}  fees $${r.fees.toFixed(0)}`;
}

export function formatTune(t: TuneResult): string {
  const d = (x: number) => new Date(x).toISOString().slice(0, 10);
  const lines = [
    `Tuning: train ${d(t.windows.train[0])} → ${d(t.windows.train[1])}, test ${d(t.windows.test[0])} → ${d(t.windows.test[1])}`,
    `A setting is adopted only if it adds ≥ ${MIN_GAIN_R}R on train with ≥ ${MIN_TRADES} trades.`,
    '',
    'ONE SETTING AT A TIME (train window)',
  ];
  for (const f of t.factors) {
    lines.push(`${f.name}:`);
    for (const o of f.options) lines.push(`  ${o.label === f.chosen ? '*' : ' '} ${o.label.padEnd(44)} ${fmt(o.train)}`);
  }
  lines.push('', 'BEFORE vs AFTER', '');
  for (const w of ['train', 'test', 'full'] as const) {
    lines.push(`${w.toUpperCase().padEnd(6)} current  ${fmt(t.baseline[w])}`);
    lines.push(`${''.padEnd(6)} tuned    ${fmt(t.tuned[w])}`);
  }
  lines.push('', 'NOT ADOPTED: changes to your spec, each on top of the tuned settings', '');
  for (const s of t.specChanges) {
    lines.push(`${s.label}:`, `  test ${fmt(s.test)}`, `  full ${fmt(s.full)}`);
  }
  return lines.join('\n');
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const days = Number(arg('days') ?? 365);
  const extras = Number(arg('extras') ?? 10);
  const testDays = Number(arg('test-days') ?? 120);
  const q = intervalMs('15m');
  const to = Math.floor(Date.now() / q) * q;
  const from = to - days * DAY;
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);

  let symbols = arg('symbols')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols) symbols = [...new Set([...CORE_SYMBOLS, ...symbols])];
  else symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols: ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to, log });
  log('tuning...');
  const result = tune(data, from, to, testDays, log);
  const report = `${formatTune(result)}\n\nSymbols: ${symbols.join(', ')}`;
  writeFileSync('tune-report.txt', report);
  writeFileSync('tune-results.json', JSON.stringify(result, null, 2));
  console.log(report);
}

// Only when run as a script (npm run tune), not when imported by tests.
if (process.argv[1]?.endsWith('tune.ts')) {
  main().catch((err) => {
    console.error(`tuning failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
