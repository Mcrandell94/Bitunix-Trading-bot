// Walk-forward split (docs/backtest/TASKS.md, T4; SPEC §6): train 12 months,
// test 3 months, step 3 months, over the research data (everything before
// the 6-month holdout, which is never touched here). The baseline report
// runs each tier alone once over the whole research window and assigns
// every trade to the fold its entry falls in; rule evaluation (T8+) will
// choose parameters on each train block and score them on the next test.
//
//   npm run -s walkforward -- --days 1095 --extras 20

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { CORE_SYMBOLS } from '@bot/signals';
import { apiTradable, selectUniverse } from '@bot/worker';
import { researchWindow, soloTier } from './baseline';
import { runBacktest } from './engine';
import { loadMarket, WARMUP_DAYS } from './load';
import { loadRules } from './rules';
import { appendRunLog, profitFactor, type RunLogRow, gitHash } from './runlog';
import { defaultConfig, type BacktestConfig, type SymbolData, type Trade } from './types';

const DAY = 86_400_000;

export function addMonths(t: number, n: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

export interface Fold { index: number; train: [number, number]; test: [number, number] }

/** Folds whose test block ends by `to`. Train and test are half-open [from, to). */
export function makeFolds(from: number, to: number, trainMonths = 12, testMonths = 3, stepMonths = 3): Fold[] {
  const out: Fold[] = [];
  for (let k = 0; ; k++) {
    const trainFrom = addMonths(from, k * stepMonths);
    const trainTo = addMonths(trainFrom, trainMonths);
    const testTo = addMonths(trainTo, testMonths);
    if (testTo > to) break;
    out.push({ index: k + 1, train: [trainFrom, trainTo], test: [trainTo, testTo] });
  }
  return out;
}

export interface Block { n: number; wins: number; totalR: number; expectancyR: number | null; profitFactor: number | null; winRate: number | null }

export function block(trades: ReadonlyArray<Pick<Trade, 'r'>>): Block {
  const n = trades.length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;
  return { n, wins, totalR, expectancyR: n ? totalR / n : null, profitFactor: profitFactor(trades), winRate: n ? wins / n : null };
}

const within = (t: Pick<Trade, 'openedAt'>, [a, b]: [number, number]) => t.openedAt >= a && t.openedAt < b;

export interface TierWalk {
  tier: 'MTF' | 'HTF';
  folds: { fold: Fold; train: Block; test: Block }[];
  oos: Block;
  minTrades: { train: number; oosBlock: number };
  foldsMeetingMinimum: number;
}

/** Baseline walk-forward: one run per tier over the research window, trades assigned to folds by entry time. */
export function walkForwardBaseline(data: Readonly<Record<string, SymbolData>>, cfg: BacktestConfig, folds: Fold[], minTrades = { train: 150, oosBlock: 75 }): TierWalk[] {
  return (['MTF', 'HTF'] as const).map((tier) => {
    const trades = runBacktest(data, soloTier(cfg, tier)).trades;
    const rows = folds.map((fold) => ({ fold, train: block(trades.filter((t) => within(t, fold.train))), test: block(trades.filter((t) => within(t, fold.test))) }));
    const oos = block(trades.filter((t) => folds.some((f) => within(t, f.test))));
    return {
      tier, folds: rows, oos, minTrades,
      foldsMeetingMinimum: rows.filter((r) => r.train.n >= minTrades.train && r.test.n >= minTrades.oosBlock).length,
    };
  });
}

/** First time every core symbol has enough history for the daily bias to be meaningful. */
export function earliestTradable(data: Readonly<Record<string, SymbolData>>, core: ReadonlyArray<string>): number {
  let start = -Infinity;
  for (const s of core) {
    const first = data[s]?.candles['1d']?.[0]?.openTime ?? data[s]?.candles['15m']?.[0]?.openTime;
    if (first != null) start = Math.max(start, first + WARMUP_DAYS['1d'] * DAY);
  }
  return start;
}

export function formatWalkForward(w: TierWalk[], window: { from: number; to: number }, holdoutFrom: number): string {
  const day = (x: number) => new Date(x).toISOString().slice(0, 10);
  const b = (x: Block) => `${String(x.n).padStart(4)} tr  win ${x.winRate == null ? '   -' : (x.winRate * 100).toFixed(0).padStart(3) + '%'}  exp ${x.expectancyR == null ? '     -' : x.expectancyR.toFixed(3).padStart(6)}R  PF ${x.profitFactor == null ? '   -' : x.profitFactor.toFixed(2).padStart(4)}  total ${x.totalR.toFixed(1).padStart(6)}R`;
  const lines = [`WALK-FORWARD BASELINE  research ${day(window.from)} → ${day(window.to)}; holdout ${day(holdoutFrom)} → untouched`, 'train 12m, test 3m, step 3m', ''];
  for (const t of w) {
    lines.push(`${t.tier}  (minimum: ${t.minTrades.train} train trades, ${t.minTrades.oosBlock} per test block; ${t.foldsMeetingMinimum}/${t.folds.length} folds meet it)`);
    for (const f of t.folds) lines.push(`  fold ${f.fold.index}  train ${day(f.fold.train[0])}→${day(f.fold.train[1])} ${b(f.train)}   test ${day(f.fold.test[0])}→${day(f.fold.test[1])} ${b(f.test)}`);
    const pos = t.folds.filter((f) => f.test.totalR > 0).length;
    lines.push(`  all test blocks together     ${b(t.oos)}   (${pos}/${t.folds.length} test blocks positive)`, '');
  }
  return lines.join('\n');
}

export function walkForwardRows(w: TierWalk[], rulesHash: string | null): RunLogRow[] {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const stamp = new Date().toISOString();
  const row = (tier: string, name: string, [a, b]: [number, number], x: Block): RunLogRow => ({
    timestamp: stamp, gitHash: gitHash(), rulesHash, rule: 'baseline', tier, window: { name, from: iso(a), to: iso(b) },
    n: x.n, expectancyR: x.expectancyR, profitFactor: x.profitFactor, totalR: x.totalR, winRate: x.winRate,
    nullPctile: null, randomFilterPctile: null, verdict: 'baseline',
  });
  return w.flatMap((t) => t.folds.flatMap((f) => [row(t.tier, `wf${f.fold.index}-train`, f.fold.train, f.train), row(t.tier, `wf${f.fold.index}-test`, f.fold.test, f.test)]));
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const days = Number(arg('days') ?? 1095);
  const extras = Number(arg('extras') ?? 20);
  const w = researchWindow(days);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols: ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: w.from, to: w.to, log });
  // Start where the core coins have enough daily history, rounded up to the next day.
  const from = Math.max(w.from, Math.ceil(earliestTradable(data, CORE_SYMBOLS) / DAY) * DAY);
  const folds = makeFolds(from, w.to);
  if (folds.length === 0) throw new Error('not enough history for one 15-month fold');
  const { hash } = loadRules();
  const result = walkForwardBaseline(data, defaultConfig(from, w.to), folds);
  appendRunLog(walkForwardRows(result, hash));
  const report = `${formatWalkForward(result, { from, to: w.to }, w.to)}\nSymbols: ${symbols.join(', ')}`;
  writeFileSync('walkforward-report.txt', report);
  writeFileSync('walkforward-results.json', JSON.stringify({ from, to: w.to, folds, result }, null, 2));
  console.log(report);
}

if (process.argv[1]?.endsWith('walkforward.ts')) main().catch((e) => { console.error(e); process.exit(1); });
