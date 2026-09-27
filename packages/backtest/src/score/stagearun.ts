// T5 runner: Stage A on real data (see stagea.ts for the pieces).

import { writeFileSync } from 'node:fs';
import { soloTier } from '../baseline';
import { runBacktest } from '../engine';
import { appendRunLog, gitHash, type RunLogRow } from '../runlog';
import { defaultConfig, type SymbolData, type Trade } from '../types';
import { block, makeFolds, type Block, type Fold } from '../walkforward';
import type { ScorePoint } from './components';
import { weightSets, type ScoreConfig } from './config';
import { scoreTable } from './pipeline';
import {
  entryHour, marketOutcomes, modeXConfig, monotonicity, monteCarloDrawdown, randomEntryNull, scoreGate, scoreLookup,
  scoreTrades, shuffledScore, walkForwardSelect, type ConfigRun, type EntryKey, type NullResult,
} from './stagea';

const DAY = 86_400_000;

export async function runStageA(o: {
  data: Readonly<Record<string, SymbolData>>; symbols: string[]; from: number; to: number;
  config: ScoreConfig; hash: string; log: (m: string) => void; runs: number;
}): Promise<void> {
  const { data, symbols, from, to, config, hash, log, runs } = o;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const val = (config.validation ?? {}) as { min_trades?: { train?: number; oos_block?: number }; monotonic_folds_required?: number; mc_resamples?: number; mc_dd95_max_pct?: number; score_buckets?: number[] };
  const minTrain = val.min_trades?.train ?? 100;
  const minOos = val.min_trades?.oos_block ?? 50;
  const folds = makeFolds(from, to);
  const grid = config.entry.grid?.t_entry ?? [config.entry.t_entry];
  const sets = Object.keys(weightSets(config));
  const started = Date.now();
  const clock = () => `${((Date.now() - started) / 60_000).toFixed(1)}m`;

  // Scores from a week before the window, so setups whose MSS closed just before `from` have one.
  const tables: Record<string, ScorePoint[]> = {};
  for (const s of symbols) { tables[s] = scoreTable(data, s, from - 7 * DAY, to, config); }
  log(`${clock()} scored ${symbols.length} coins`);
  const lookups = Object.fromEntries(sets.map((w) => [w, scoreLookup(tables, w)]));
  const dailyGroup = new Map(symbols.map((s) => [s, new Map(tables[s]!.map((p) => [p.t, p.g.D ?? 0]))]));
  const dailySign = (t: Trade) => dailyGroup.get(t.symbol)?.get(entryHour(t)) ?? 0;

  const base = defaultConfig(from, to);
  const mx = modeXConfig(base, config);
  const configRuns: ConfigRun[] = [];
  for (const w of sets) {
    for (const T of grid) {
      const r = runBacktest(data, mx, undefined, { closeAtEnd: true, gate: scoreGate(lookups[w]!, T) });
      configRuns.push({ weightSet: w, threshold: T, trades: r.trades });
      log(`${clock()} ${w} T=${T}: ${r.trades.length} trades`);
    }
  }
  // Every setup the score could take, each isolated (no portfolio caps, no daily limit): monotonicity and benchmark (c).
  const iso2 = { ...mx, portfolio: null, risk: { ...mx.risk, tiers: { ...mx.risk.tiers, MTF: { ...mx.risk.tiers.MTF, dailyLossPct: 1e9 } } } };
  const candTrades = runBacktest(data, iso2, undefined, { closeAtEnd: true, gate: scoreGate(null, 0) }).trades;
  log(`${clock()} candidate run: ${candTrades.length} setups traded`);
  const mtf = runBacktest(data, { ...soloTier(base, 'MTF'), fillRealism: true }).trades;
  log(`${clock()} MTF benchmark: ${mtf.length} trades`);

  const inTest = (t: Trade) => folds.some((f) => t.openedAt >= f.test[0] && t.openedAt < f.test[1]);
  const wf = walkForwardSelect(configRuns, folds, minTrain);
  const mtfFolds = folds.map((f) => block(mtf.filter((t) => t.openedAt >= f.test[0] && t.openedAt < f.test[1])));
  const mtfOos = block(mtf.filter(inTest));

  // Benchmark (a): market entries at the same coin, hour and stop distance, both directions.
  const keyMap = new Map<string, EntryKey>();
  for (const t of [...configRuns.flatMap((r) => r.trades.filter(inTest))]) {
    const k = { symbol: t.symbol, hour: entryHour(t), stopPct: Math.abs(t.entry - t.initialStop) / t.entry };
    keyMap.set(`${k.symbol}|${k.hour}`, keyMap.get(`${k.symbol}|${k.hour}`) ?? k);
  }
  const outcomes = marketOutcomes(data, mx, [...keyMap.values()]);
  log(`${clock()} random-entry outcomes for ${keyMap.size} entries`);

  const cands = Object.fromEntries(sets.map((w) => [w, scoreTrades(candTrades, lookups[w]!)]));
  const mono = Object.fromEntries(sets.map((w) => [w, monotonicity(cands[w]!, folds, val.score_buckets)]));
  const monoRequired = val.monotonic_folds_required ?? 6;
  const mcN = val.mc_resamples ?? 10_000;
  const mcMax = val.mc_dd95_max_pct ?? 25;
  const riskPct = mx.risk.tiers.MTF.riskPct;

  const perConfig = configRuns.map((r) => {
    const oosTrades = r.trades.filter(inTest);
    const oos = block(oosTrades);
    const foldTests = folds.map((f) => block(r.trades.filter((t) => t.openedAt >= f.test[0] && t.openedAt < f.test[1])));
    const foldTrains = folds.map((f) => block(r.trades.filter((t) => t.openedAt >= f.train[0] && t.openedAt < f.train[1])));
    const a = randomEntryNull(oosTrades, outcomes, runs, dailySign);
    const c = shuffledScore(cands[r.weightSet]!, lookups[r.weightSet]!, r.threshold, folds, runs);
    const mc = monteCarloDrawdown(oosTrades.map((t) => t.r), riskPct, mcN);
    return { weightSet: r.weightSet, threshold: r.threshold, oos, foldTests, foldTrains, a, c, mc,
      foldsMeetingMinimum: folds.filter((_, i) => foldTrains[i]!.n >= minTrain && foldTests[i]!.n >= minOos).length,
      beatsMtfFolds: folds.filter((_, i) => (foldTests[i]!.expectancyR ?? -Infinity) > (mtfFolds[i]!.expectancyR ?? -Infinity)).length };
  });
  const selA = randomEntryNull(wf.oosTrades, outcomes, runs, dailySign);
  const selMc = monteCarloDrawdown(wf.oosTrades.map((t) => t.r), riskPct, mcN);
  log(`${clock()} benchmarks done`);

  // Acceptance (SPEC §7) for the walk-forward selection.
  const exp = wf.oos.expectancyR ?? -Infinity;
  const bestMono = Math.max(...sets.map((w) => mono[w]!.positive));
  const selRows = wf.rows.filter((r) => r.chosen);
  const cSel = selRows.length ? selRows.map((r) => perConfig.find((p) => p.weightSet === r.chosen!.weightSet && p.threshold === r.chosen!.threshold)!.c) : [];
  const checks = [
    { name: `every fold: >= ${minTrain} train and >= ${minOos} test trades`, ok: wf.rows.every((r) => r.chosen && r.chosenTest.n >= minOos) },
    { name: 'out-of-sample net expectancy > 0', ok: exp > 0 },
    { name: `monotonicity: Spearman > 0 in >= ${monoRequired}/${folds.length} folds (best weight set ${bestMono})`, ok: bestMono >= monoRequired },
    { name: '(a) total R above the random-entry null 95th percentile', ok: selA.real > selA.random.p95 },
    { name: `(b) expectancy above MTF on the same windows (${fmt(mtfOos.expectancyR)}R)`, ok: exp > (mtfOos.expectancyR ?? -Infinity) },
    { name: '(c) above the shuffled-score 95th percentile for every chosen config', ok: cSel.length > 0 && cSel.every((c) => c.real > c.p95) },
    { name: `Monte Carlo 95th-percentile drawdown <= ${mcMax}% at ${riskPct}% risk (${selMc.p95.toFixed(1)}%)`, ok: selMc.p95 <= mcMax },
  ];
  const verdict = checks.every((c) => c.ok) ? 'holds' : 'fails';

  const b = (x: Block) => `${String(x.n).padStart(4)} tr  win ${x.winRate == null ? '   -' : (x.winRate * 100).toFixed(0).padStart(3) + '%'}  exp ${fmt(x.expectancyR).padStart(6)}R  PF ${x.profitFactor == null ? '   -' : x.profitFactor.toFixed(2).padStart(4)}  total ${x.totalR.toFixed(1).padStart(6)}R`;
  const nr = (x: NullResult) => `real ${x.real.toFixed(3)} vs p95 ${x.p95.toFixed(3)} (pctile ${(x.pctile * 100).toFixed(0)}%, n ${x.n})`;
  const lines = [
    `CONFLUENCE STAGE A (T5), Mode X  ${iso(from)} → ${iso(to)} (holdout excluded), ${symbols.length} coins, ${folds.length} folds`,
    `config ${hash}; flat ${riskPct}% risk; fill realism on; walk-forward train 12m / test 3m / step 3m; minimum ${minTrain} train, ${minOos} per test block`,
    '',
    `VERDICT: ${verdict.toUpperCase()}`,
    ...checks.map((c) => `  [${c.ok ? 'x' : ' '}] ${c.name}`),
    '',
    'WALK-FORWARD SELECTION (best train expectancy among configs with enough train trades)',
    ...wf.rows.map((r) => `  fold ${r.fold.index}  test ${iso(r.fold.test[0])}→${iso(r.fold.test[1])}  ${r.chosen ? `${r.chosen.weightSet}@${r.chosen.threshold}`.padEnd(7) : 'none   '} ${b(r.chosenTest)}   MTF ${b(mtfFolds[r.fold.index - 1]!)}`),
    `  all test blocks  ${b(wf.oos)}   MTF ${b(mtfOos)}`,
    `  (a) random direction: ${nr(selA.random)}${selA.biasDirected ? `; daily-bias direction: ${nr(selA.biasDirected)}` : ''}; ${selA.covered}/${selA.n} trades had both outcomes`,
    `  Monte Carlo drawdown: median ${selMc.median.toFixed(1)}%, 95th pct ${selMc.p95.toFixed(1)}%`,
    '',
    'EVERY CONFIG, ALL TEST BLOCKS TOGETHER',
    ...perConfig.map((p) => [
      `  ${p.weightSet}@${String(p.threshold).padEnd(3)} ${b(p.oos)}  folds meeting minimum ${p.foldsMeetingMinimum}/${folds.length}; beats MTF in ${p.beatsMtfFolds}/${folds.length} test blocks`,
      `        per test block R: ${p.foldTests.map((x) => `${x.totalR.toFixed(1)}(${x.n})`).join(' ')}`,
      `        (a) ${nr(p.a.random)}${p.a.biasDirected ? `; bias-directed p95 ${p.a.biasDirected.p95.toFixed(1)}` : ''}`,
      `        (c) shuffled score, expectancy of isolated setups: ${nr(p.c)}`,
      `        Monte Carlo DD p95 ${p.mc.p95.toFixed(1)}%`,
    ].join('\n')),
    '',
    `MONOTONICITY (isolated setups, out of sample, by aligned |S| bucket: expectancy R (n))`,
    ...sets.flatMap((w) => [
      `  ${w}: Spearman > 0 in ${mono[w]!.positive}/${folds.length} folds`,
      ...mono[w]!.folds.map((f) => `    fold ${f.fold}  ${f.buckets.map((x) => `[${x.from},${x.to}) ${fmt(x.expectancyR)} (${x.n})`).join('  ')}  rho ${Number.isNaN(f.rho) ? '-' : f.rho.toFixed(2)}`),
    ]),
    '',
    `Benchmark (c) and monotonicity use every setup taken alone (${candTrades.length} traded setups), so portfolio caps are left out of both sides.`,
    `Symbols: ${symbols.join(', ')}`,
  ];
  const report = lines.join('\n');
  writeFileSync('score-report.txt', report);
  writeFileSync('stage-a-results.json', JSON.stringify({ from, to, folds, checks, verdict, walkForward: wf.rows, oos: wf.oos, mtfOos, mtfFolds, perConfig: perConfig.map(({ a, c, ...p }) => ({ ...p, a: { ...a }, c })), monotonicity: mono }, null, 2));

  const stamp = new Date().toISOString();
  const row = (rule: string, variant: string, name: string, [a, z]: [number, number], x: Block, extra: Partial<RunLogRow> = {}): RunLogRow => ({
    timestamp: stamp, gitHash: gitHash(), rulesHash: hash, rule, variant, tier: 'CONFLUENCE', window: { name, from: iso(a), to: iso(z) },
    n: x.n, expectancyR: x.expectancyR, profitFactor: x.profitFactor, totalR: x.totalR, winRate: x.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info', ...extra,
  });
  const rows: RunLogRow[] = [];
  for (const p of perConfig) {
    const variant = `${p.weightSet}@${p.threshold}`;
    folds.forEach((f: Fold, i) => {
      rows.push(row('confluence_v1 stage-a', variant, `wf${f.index}-train`, f.train, p.foldTrains[i]!));
      rows.push(row('confluence_v1 stage-a', variant, `wf${f.index}-test`, f.test, p.foldTests[i]!));
    });
    rows.push(row('confluence_v1 stage-a', variant, 'oos', [from, to], p.oos, { nullPctile: p.a.random.pctile, randomFilterPctile: p.c.pctile }));
  }
  rows.push(row('confluence_v1 stage-a', 'walk-forward selection', 'oos', [from, to], wf.oos, { nullPctile: selA.random.pctile, verdict }));
  appendRunLog(rows);
  console.log(report);
}

function fmt(x: number | null): string { return x == null ? '-' : x.toFixed(3); }
