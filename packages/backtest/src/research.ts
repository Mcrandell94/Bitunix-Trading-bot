// npm run research [-- --days 365 --extras 10 --test-days 120]
//
// Win-rate research: small changes, one at a time, each compared with the
// current strategy on the train window and on the held-out test window.
// A change "holds" only if it raises the win rate on BOTH windows without
// lowering total R on either (a higher win rate bought with smaller wins is
// not an improvement). Changes that hold are then tried together.
// Nothing is adopted automatically. Writes research-report.txt and
// research-results.json.

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { intervalMs } from '@bot/marketdata';
import { SESSION_KILLZONES } from '@bot/risk';
import { CORE_SYMBOLS } from '@bot/signals';
import { apiTradable, selectUniverse } from '@bot/worker';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { maxDrawdown, stats } from './metrics';
import { defaultConfig, type BacktestConfig, type SymbolData } from './types';

const DAY = 86_400_000;
const MIN_TRADES = 25;
/** Win-rate gain (percentage points) a change needs on each window to hold. */
const MIN_WIN_GAIN = 1;

type Patch = (c: BacktestConfig) => BacktestConfig;
export interface Candidate { label: string; why: string; patch: Patch }

const setup = (over: Partial<BacktestConfig['setup']>): Patch => (c) => ({ ...c, setup: { ...c.setup, ...over } });
const tier = (t: 'LTF' | 'MTF', over: Partial<BacktestConfig['tiers']['LTF']>): Patch => (c) =>
  ({ ...c, tiers: { ...c.tiers, [t]: { ...c.tiers[t], ...over } } });

export const CANDIDATES: Candidate[] = [
  { label: 'stop buffer 0.25 ATR', why: 'more room beyond the sweep wick: fewer stop-outs by noise', patch: setup({ stopBufferAtr: 0.25 }) },
  { label: 'stop buffer 0.5 ATR', why: 'even more room (smaller size for the same risk)', patch: setup({ stopBufferAtr: 0.5 }) },
  { label: 'entry deeper in the gap (1/4)', why: 'better price: fewer fills, but the ones that fill are cheaper', patch: setup({ entryFraction: 0.25 }) },
  { label: 'entry at the gap\'s far edge', why: 'deepest price in the gap', patch: setup({ entryFraction: 0 }) },
  { label: 'displacement body >= 70% of range', why: 'cleaner displacement candles only', patch: setup({ displacementBodyRatio: 0.7 }) },
  { label: 'displacement >= 1.2 ATR', why: 'stronger displacement only', patch: setup({ displacementAtr: 1.2 }) },
  { label: 'sweep within 10 bars of the MSS', why: 'fresher setups', patch: setup({ maxLegBars: 10 }) },
  { label: 'FVG only (no iFVG)', why: 'skip the weaker inverted-gap entries', patch: setup({ allowIfvg: false }) },
  { label: 'room to liquidity >= 1.5R', why: 'skip setups boxed in by a nearby swing', patch: (c) => ({ ...c, minRoomR: 1.5 }) },
  { label: 'room to liquidity >= 2R', why: 'stricter room', patch: (c) => ({ ...c, minRoomR: 2 }) },
  { label: 'RRG as a guide only (extras trade on bias)', why: 'owner: RRG finds strong coins sooner, it need not gate each trade', patch: (c) => ({ ...c, extrasRrg: 'guide' }) },
  { label: 'RRG veto only for extras', why: 'extras trade on bias unless RRG points the other way', patch: (c) => ({ ...c, extrasRrg: 'veto' }) },
  { label: 'core RRG veto', why: 'BTC/ETH/XRP skip setups against their rotation signal', patch: (c) => ({ ...c, coreRrgVeto: true }) },
  { label: 'bias: both timeframes agree', why: 'the lower bias timeframe must confirm, not just not object', patch: (c) => ({ ...c, biasCombine: 'both' }) },
  { label: 'min stop distance 0.3%', why: 'skip stops so tight that fees and noise decide them', patch: (c) => ({ ...c, minStopPct: 0.3 }) },
  { label: 'LTF: half off at 1R, stop to entry', why: 'bank part of LTF trades early', patch: tier('LTF', { partials: [{ atR: 1, fraction: 0.5 }], breakevenAtR: 1 }) },
  { label: 'MTF: first third off at 0.75R', why: 'bank the first partial sooner', patch: tier('MTF', { partials: [{ atR: 0.75, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }] }) },
  // Combinations of the near-misses from the first run (2026-09-26, 365 days, 13 coins).
  {
    label: 'combo A: both-TF bias + FVG only + min stop 0.3%',
    why: 'the three near-misses that never cost R on either window',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.3, setup: { ...c.setup, allowIfvg: false } }),
  },
  {
    label: 'combo B: combo A + stop buffer 0.25 ATR',
    why: 'plus the extra stop room (win rate up on both windows, -0.4R on train)',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.3, setup: { ...c.setup, allowIfvg: false, stopBufferAtr: 0.25 } }),
  },
  { label: 'LTF only in killzones (London, NY AM, Asia)', why: 'info: the windows you dropped; do they win more?', patch: (c) => ({ ...c, risk: { ...c.risk, tiers: { ...c.risk.tiers, LTF: { ...c.risk.tiers.LTF, killzones: SESSION_KILLZONES } } } }) },
];

export interface Row { trades: number; winRate: number; avgR: number; totalR: number; returnPct: number; maxDrawdownPct: number }

export interface ResearchResult {
  windows: { train: [number, number]; test: [number, number] };
  baseline: { train: Row; test: Row };
  candidates: { label: string; why: string; train: Row; test: Row; holds: boolean }[];
  combined: { labels: string[]; train: Row; test: Row } | null;
}

export function research(data: Readonly<Record<string, SymbolData>>, from: number, to: number, testDays: number, log: (m: string) => void = () => {}): ResearchResult {
  const split = to - testDays * DAY;
  const base = defaultConfig(from, to);
  const run = (c: BacktestConfig, a: number, b: number): Row => {
    const r = runBacktest(data, { ...c, from: a, to: b });
    const s = stats(r.trades);
    return {
      trades: s.trades, winRate: s.winRate * 100, avgR: s.expectancyR, totalR: s.totalR,
      returnPct: (r.endEquity / r.config.startEquity - 1) * 100, maxDrawdownPct: maxDrawdown(r.config.startEquity, r.equityCurve) * 100,
    };
  };
  const both = (c: BacktestConfig) => ({ train: run(c, from, split), test: run(c, split, to) });
  log('  baseline');
  const baseline = both(base);
  const holds = (x: { train: Row; test: Row }) => (['train', 'test'] as const).every((w) =>
    x[w].trades >= (w === 'train' ? MIN_TRADES : 1) && x[w].winRate - baseline[w].winRate >= MIN_WIN_GAIN && x[w].totalR >= baseline[w].totalR);
  const candidates = CANDIDATES.map((c) => {
    log(`  ${c.label}`);
    const r = both(c.patch(base));
    return { label: c.label, why: c.why, ...r, holds: holds(r) };
  });
  const good = CANDIDATES.filter((c) => candidates.find((x) => x.label === c.label)!.holds && !c.label.startsWith('LTF only in killzones'));
  let combined: ResearchResult['combined'] = null;
  if (good.length > 1) {
    log('  combined');
    combined = { labels: good.map((g) => g.label), ...both(good.reduce((c, g) => g.patch(c), base)) };
  }
  return { windows: { train: [from, split], test: [split, to] }, baseline, candidates, combined };
}

const f = (r: Row) => `${String(r.trades).padStart(4)} tr  win ${r.winRate.toFixed(1).padStart(5)}%  avg ${r.avgR.toFixed(2).padStart(5)}R  total ${r.totalR.toFixed(1).padStart(6)}R  ret ${r.returnPct.toFixed(1).padStart(6)}%  DD ${r.maxDrawdownPct.toFixed(1).padStart(5)}%`;
const d = (r: Row, b: Row) => `win ${(r.winRate - b.winRate >= 0 ? '+' : '') + (r.winRate - b.winRate).toFixed(1)}pt, R ${(r.totalR - b.totalR >= 0 ? '+' : '') + (r.totalR - b.totalR).toFixed(1)}`;

export function formatResearch(r: ResearchResult): string {
  const day = (x: number) => new Date(x).toISOString().slice(0, 10);
  const lines = [
    `Win-rate research: train ${day(r.windows.train[0])} → ${day(r.windows.train[1])}, test ${day(r.windows.test[0])} → ${day(r.windows.test[1])}`,
    `HOLDS = win rate up >= ${MIN_WIN_GAIN}pt on BOTH windows and total R not lower on either.`,
    '',
    `BASELINE (current strategy)`,
    `  train ${f(r.baseline.train)}`,
    `  test  ${f(r.baseline.test)}`,
    '',
  ];
  const gain = (c: ResearchResult['candidates'][number]) => (c.train.winRate - r.baseline.train.winRate) + (c.test.winRate - r.baseline.test.winRate);
  const sorted = [...r.candidates].sort((a, b) => Number(b.holds) - Number(a.holds) || gain(b) - gain(a));
  for (const c of sorted) {
    lines.push(`${c.holds ? 'HOLDS ' : '      '}${c.label}  (${c.why})`);
    lines.push(`   train ${f(c.train)}   [${d(c.train, r.baseline.train)}]`);
    lines.push(`   test  ${f(c.test)}   [${d(c.test, r.baseline.test)}]`);
  }
  if (r.combined) {
    lines.push('', `ALL THAT HOLD, TOGETHER: ${r.combined.labels.join(' + ')}`);
    lines.push(`   train ${f(r.combined.train)}   [${d(r.combined.train, r.baseline.train)}]`);
    lines.push(`   test  ${f(r.combined.test)}   [${d(r.combined.test, r.baseline.test)}]`);
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
  log('researching...');
  const result = research(data, from, to, testDays, log);
  const report = `${formatResearch(result)}\n\nSymbols: ${symbols.join(', ')}`;
  writeFileSync('research-report.txt', report);
  writeFileSync('research-results.json', JSON.stringify(result, null, 2));
  console.log(report);
}

if (process.argv[1]?.endsWith('research.ts')) {
  main().catch((err) => {
    console.error(`research failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
