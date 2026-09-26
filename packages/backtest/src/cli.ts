// npm run backtest [-- --days 90 --extras 10 --symbols SOLUSDT,DOGEUSDT --equity 10000]
//
// Downloads Bitunix history into .cache/backtest (reused next time), runs
// the backtest and writes backtest-report.txt and backtest-trades.csv here.
// Public data only: no API keys.

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { intervalMs } from '@bot/marketdata';
import { CORE_SYMBOLS } from '@bot/signals';
import { selectUniverse } from '@bot/worker';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { formatReport } from './metrics';
import { defaultConfig, type BacktestResult } from './types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function tradesCsv(r: BacktestResult): string {
  const head = 'id,symbol,tier,side,source,opened_utc,closed_utc,entry,initial_stop,qty,risk_usd,gross_usd,fees_usd,funding_usd,net_usd,r,exits';
  const iso = (t: number) => new Date(t).toISOString();
  return [head, ...r.trades.map((t) => [
    t.id, t.symbol, t.tier, t.side, t.source, iso(t.openedAt), iso(t.closedAt), t.entry, t.initialStop, t.qty,
    t.riskAmount.toFixed(4), t.grossPnl.toFixed(4), t.fees.toFixed(4), t.funding.toFixed(4), t.netPnl.toFixed(4), t.r.toFixed(3),
    t.fills.slice(1).map((f) => f.reason).join('|'),
  ].join(','))].join('\n');
}

async function main() {
  const days = Number(arg('days') ?? 90);
  const extras = Number(arg('extras') ?? 10);
  const equity = Number(arg('equity') ?? 10_000);
  const q = intervalMs('15m');
  const to = Math.floor(Date.now() / q) * q;
  const from = to - days * 86_400_000;
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);

  let symbols = arg('symbols')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols) symbols = [...new Set([...CORE_SYMBOLS, ...symbols])];
  else {
    log('picking symbols by 24h volume...');
    symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras });
  }
  log(`symbols: ${symbols.join(', ')}`);
  log('downloading history (first run takes a few minutes; later runs reuse .cache/backtest)...');
  const { data, notes } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to, log });

  log('running backtest...');
  const cfg = { ...defaultConfig(from, to), startEquity: equity };
  const result = runBacktest(data, cfg);
  result.warnings.push(...notes);
  const report = [formatReport(result), '', `Symbols: ${symbols.join(', ')}`].join('\n');
  writeFileSync('backtest-report.txt', report);
  writeFileSync('backtest-trades.csv', tradesCsv(result));
  console.log(report);
  log('\nwrote backtest-report.txt and backtest-trades.csv');
}

main().catch((err) => {
  console.error(`backtest failed: ${(err as Error).message}`);
  process.exit(1);
});
