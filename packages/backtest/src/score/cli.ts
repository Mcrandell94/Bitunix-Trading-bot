// Confluence score model tasks on real data (docs/confluence/TASKS.md).
//   npm run -s score -- lookahead --samples 1000 --months 36 --extras 20   (T2)

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { apiTradable, selectUniverse } from '@bot/worker';
import { researchWindow } from '../baseline';
import { loadMarket } from '../load';
import { appendRunLog, gitHash } from '../runlog';
import { addMonths } from '../walkforward';
import { loadScoreConfig } from './config';
import { lookaheadCheck } from './pipeline';

async function main() {
  const task = process.argv[2];
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const months = Number(arg('months') ?? 36);
  const extras = Number(arg('extras') ?? 20);
  const holdoutStart = researchWindow(0).to; // nothing after this is loaded
  const from = addMonths(holdoutStart, -months);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols: ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to: holdoutStart, log });
  const { config, hash } = loadScoreConfig();
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
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
  throw new Error(`unknown task ${task} (lookahead)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
