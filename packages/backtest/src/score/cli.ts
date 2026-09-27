// Confluence score model tasks on real data (docs/confluence/TASKS.md).
//   npm run -s score -- lookahead --samples 1000 --months 36 --extras 20   (T2)
//   npm run -s score -- diagnostics --months 36 --extras 20                (T3, T4)
//   npm run -s score -- stage-a --months 36 --extras 60                    (T5)
// --min-volume: the research universe's 24h quote volume floor (owner,
// 2026-09-27: $3M for research; the live universe keeps $10M).

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { apiTradable, selectUniverse } from '@bot/worker';
import { researchWindow } from '../baseline';
import { loadMarket } from '../load';
import { appendRunLog, gitHash } from '../runlog';
import { addMonths } from '../walkforward';
import { loadScoreConfig } from './config';
import { diagnostics, distribution, formatDiagnostics } from './diagnostics';
import { lookaheadCheck, scoreTable } from './pipeline';
import { makeFolds } from '../walkforward';
import { runStageA } from './stagearun';

async function main() {
  const task = process.argv[2];
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const months = Number(arg('months') ?? 36);
  const extras = Number(arg('extras') ?? 20);
  const holdoutStart = researchWindow(0).to; // nothing after this is loaded
  const from = addMonths(holdoutStart, -months);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const minVolume = Number(arg('min-volume') ?? 3_000_000);
  const symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: minVolume, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols (${symbols.length}, floor $${minVolume / 1e6}M): ${symbols.join(', ')}`);
  const { config, hash } = loadScoreConfig();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  if (task === 'stage-a') {
    // Three warm-up months before the 36 (daily EMA50 + slope, 120-bar RRG), so the walk-forward gets its 8 folds.
    const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, -3), to: holdoutStart, log });
    const btcFirst = data.BTCUSDT?.candles['1d']?.[0]?.openTime ?? from;
    const start = Math.max(from, Math.ceil(addMonths(btcFirst, 3) / 86_400_000) * 86_400_000);
    await runStageA({ data, symbols, from: start, to: holdoutStart, config, hash, log, runs: Number(arg('runs') ?? (config.validation as { null_runs?: number } | undefined)?.null_runs ?? 500) });
    return;
  }
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to: holdoutStart, log });
  const scoreFrom = addMonths(from, 3); // daily EMA50 + slope and 120-bar RRG need history before the first decision

  if (task === 'lookahead') {
    const samples = Number(arg('samples') ?? 1000);
    let r;
    try {
      r = lookaheadCheck(data, symbols, scoreFrom, holdoutStart, config, samples, Number(arg('seed') ?? 1));
    } catch (err) {
      appendRunLog({ timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: 'confluence_v1 lookahead', tier: 'SCORE', window: { name: 'research', from: iso(scoreFrom), to: iso(holdoutStart) }, n: 0, expectancyR: null, profitFactor: null, totalR: 0, winRate: null, nullPctile: null, randomFilterPctile: null, verdict: 'error', error: (err as Error).message });
      throw err;
    }
    const report = [
      `CONFLUENCE SCORE LOOKAHEAD CHECK (T2)  ${iso(scoreFrom)} → ${iso(holdoutStart)} (holdout excluded), ${symbols.length} coins`,
      `checked ${r.checked} random (coin, 1H close) points; mismatches: ${r.mismatches.length}`,
      ...r.mismatches.slice(0, 20).map((m) => `  ${m.symbol} ${new Date(m.t).toISOString()} ${m.key}: full ${m.full} vs truncated ${m.truncated}`),
    ].join('\n');
    appendRunLog({ timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: 'confluence_v1 lookahead', tier: 'SCORE', window: { name: 'research', from: iso(scoreFrom), to: iso(holdoutStart) }, n: r.checked, expectancyR: null, profitFactor: null, totalR: 0, winRate: null, nullPctile: null, randomFilterPctile: null, verdict: r.mismatches.length ? 'fails' : 'holds' });
    writeFileSync('score-report.txt', report);
    console.log(report);
    if (r.mismatches.length) process.exit(1);
    return;
  }
  if (task === 'diagnostics') {
    // T3 + T4. The folds start where the score has enough history.
    const folds = makeFolds(scoreFrom, holdoutStart);
    const tables = Object.fromEntries(symbols.map((s) => { log(`scoring ${s}`); return [s, scoreTable(data, s, scoreFrom, holdoutStart, config)]; }));
    const d = diagnostics(tables, data, folds[0]!.train);
    const grid = (config.entry.grid?.t_entry ?? [config.entry.t_entry]) as number[];
    const dist = distribution(tables, data, folds, grid);
    const minTrain = Number((config.validation as { min_trades?: { train?: number } })?.min_trades?.train ?? 100);
    const report = `${formatDiagnostics(d, dist, folds, minTrain)}\n\nWindow ${iso(scoreFrom)} → ${iso(holdoutStart)} (holdout excluded), ${folds.length} folds.\nSymbols: ${symbols.join(', ')}`;
    writeFileSync('score-report.txt', report);
    writeFileSync('score-diagnostics.json', JSON.stringify({ diagnostics: d, distribution: dist, folds }, null, 2));
    appendRunLog({ timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: 'confluence_v1 diagnostics', tier: 'SCORE', window: { name: 'research', from: iso(scoreFrom), to: iso(holdoutStart) }, n: Object.values(tables).reduce((a, t) => a + t.length, 0), expectancyR: null, profitFactor: null, totalR: 0, winRate: null, nullPctile: null, randomFilterPctile: null, verdict: 'info' });
    console.log(report);
    return;
  }
  throw new Error(`unknown task ${task} (lookahead | diagnostics | stage-a)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
