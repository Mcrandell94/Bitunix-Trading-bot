// Fill-realism audit (docs/backtest/TASKS.md, T3). On the research window
// (holdout excluded), MTF and HTF alone:
//  (d) every trade that lost more than 3R, with entry, stop, the stop's
//      fill price, the 15m mark bar it filled on and where the price came
//      from (the stop level, or the bar's open after a gap);
//  and the baseline next to the fill-realism variant (limit entries need a
//  trade-through by one tick), whose fixture is printed for the record.
//
//   npm run -s audit -- --days 730 --extras 20

import { writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { intervalMs, type Candle } from '@bot/marketdata';
import { CORE_SYMBOLS } from '@bot/signals';
import { barAt } from '@bot/smc';
import { apiTradable, selectUniverse } from '@bot/worker';
import { researchWindow, soloTier, tierFixture } from './baseline';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { loadRules } from './rules';
import { appendRunLog, rowFromTrades } from './runlog';
import { defaultConfig, type BacktestConfig, type SymbolData, type Trade } from './types';

const Q = intervalMs('15m');

export interface LossRow {
  tier: string; symbol: string; side: string; opened: string; closed: string;
  entry: number; stop: number; stopPct: number; exitPrice: number; exitFrom: string;
  bar: { open: number; high: number; low: number; close: number } | null;
  r: number; gapR: number; costR: number; cause: string;
}

/** Why a trade lost more than 1R: the part from the price moving past the stop, and the part from fees, slippage and funding. */
export function explainLoss(t: Trade, data: Readonly<Record<string, SymbolData>>): LossRow {
  const exit = t.fills.at(-1)!;
  const long = t.side === 'long';
  const dist = Math.abs(t.entry - t.initialStop);
  const perR = dist * t.qty;
  // Price loss beyond the stop, in R (0 when the stop filled at its level).
  const gapR = perR > 0 ? Math.max(0, (long ? t.initialStop - exit.price : exit.price - t.initialStop) * t.qty) / perR : 0;
  const costR = perR > 0 ? (t.fees - t.funding) / perR : 0;
  const list: ReadonlyArray<Candle> | undefined = data[t.symbol]!.mark15m ?? data[t.symbol]!.candles['15m'];
  const i = list ? barAt(list, Q, exit.time) : -1;
  const c = i >= 0 ? list![i]! : null;
  const stopPct = (dist / t.entry) * 100;
  const cause = exit.from === 'open' ? `gapped: the bar opened ${Math.abs(((c?.open ?? exit.price) - t.initialStop) / t.initialStop * 100).toFixed(2)}% past the stop`
    : stopPct < 0.3 ? `tiny stop (${stopPct.toFixed(2)}%): fees and slippage are ${costR.toFixed(1)}R`
    : exit.reason !== 'stop' ? `closed by ${exit.reason}` : 'stop at its level; costs';
  return {
    tier: t.tier, symbol: t.symbol, side: t.side, opened: new Date(t.openedAt).toISOString().slice(0, 16), closed: new Date(t.closedAt).toISOString().slice(0, 16),
    entry: t.entry, stop: t.initialStop, stopPct, exitPrice: exit.price, exitFrom: exit.from ?? 'level',
    bar: c ? { open: c.open, high: c.high, low: c.low, close: c.close } : null,
    r: t.r, gapR, costR, cause,
  };
}

export interface AuditTier {
  tier: 'MTF' | 'HTF';
  base: ReturnType<typeof tierFixture>;
  realism: ReturnType<typeof tierFixture>;
  bigLosses: LossRow[];
}

export function audit(data: Readonly<Record<string, SymbolData>>, cfg: BacktestConfig): AuditTier[] {
  return (['MTF', 'HTF'] as const).map((tier) => {
    const base = runBacktest(data, soloTier({ ...cfg, fillRealism: false }, tier)).trades;
    const real = runBacktest(data, soloTier({ ...cfg, fillRealism: true }, tier)).trades;
    return { tier, base: tierFixture(base), realism: tierFixture(real), bigLosses: base.filter((t) => t.r < -3).map((t) => explainLoss(t, data)) };
  });
}

export function formatAudit(a: AuditTier[], window: { from: number; to: number }): string {
  const day = (x: number) => new Date(x).toISOString().slice(0, 10);
  const f = (x: ReturnType<typeof tierFixture>) => `${String(x.trades).padStart(4)} tr  total ${x.totalR.toFixed(1).padStart(7)}R  exp ${(x.expectancyR ?? 0).toFixed(3)}R  PF ${x.profitFactor?.toFixed(2) ?? '-'}`;
  const lines = [`FILL-REALISM AUDIT  ${day(window.from)} → ${day(window.to)} (holdout excluded)`, ''];
  for (const t of a) {
    lines.push(`${t.tier}`, `  baseline (limit fills on touch)       ${f(t.base)}`, `  fill realism (trade-through 1 tick)  ${f(t.realism)}`);
    const excess = t.bigLosses.reduce((s, x) => s + (-x.r - 1), 0);
    lines.push(`  losses worse than -3R: ${t.bigLosses.length}, costing ${excess.toFixed(1)}R beyond the planned -1R each`);
    for (const x of t.bigLosses) {
      const b = x.bar ? `bar O ${x.bar.open} H ${x.bar.high} L ${x.bar.low} C ${x.bar.close}` : 'bar n/a';
      lines.push(`   ${x.symbol.padEnd(12)} ${x.side.padEnd(5)} ${x.opened}→${x.closed}  entry ${x.entry.toPrecision(6)} stop ${x.stop.toPrecision(6)} (${x.stopPct.toFixed(2)}%)  exit ${x.exitPrice.toPrecision(6)} from ${x.exitFrom}  ${b}  ${x.r.toFixed(1)}R (gap ${x.gapR.toFixed(1)}R, costs ${x.costR.toFixed(1)}R)  ${x.cause}`);
    }
    lines.push('');
  }
  lines.push(
    'Checks (SPEC §6):',
    '  (a) limit trade-through by 1 tick: the "fill realism" rows above (flag execution.fill_realism).',
    '  (b) stops fill at the worse of the stop or the bar open, plus 2 bps slippage: already the engine rule (exit "from open" = gapped).',
    '  (c) intrabar stop vs target: the engine steps on 15m mark bars and checks the stop first when both are inside one bar (pessimistic).',
  );
  return lines.join('\n');
}

function csv(a: AuditTier[]): string {
  const head = 'tier,symbol,side,opened_utc,closed_utc,entry,stop,stop_pct,exit_price,exit_from,bar_open,bar_high,bar_low,bar_close,r,gap_r,cost_r,cause';
  return [head, ...a.flatMap((t) => t.bigLosses.map((x) => [x.tier, x.symbol, x.side, x.opened, x.closed, x.entry, x.stop, x.stopPct.toFixed(3), x.exitPrice, x.exitFrom,
    x.bar?.open ?? '', x.bar?.high ?? '', x.bar?.low ?? '', x.bar?.close ?? '', x.r.toFixed(2), x.gapR.toFixed(2), x.costR.toFixed(2), `"${x.cause}"`].join(',')))].join('\n');
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const days = Number(arg('days') ?? 730);
  const extras = Number(arg('extras') ?? 20);
  const { from, to } = researchWindow(days);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  let symbols = arg('symbols')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols) symbols = [...new Set([...CORE_SYMBOLS, ...symbols])];
  else symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols: ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to, log });
  const { hash: rulesHash } = loadRules();
  const result = audit(data, defaultConfig(from, to));
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (const t of result) {
    for (const [rule, x] of [['baseline', t.base], ['fill_realism', t.realism]] as const) {
      appendRunLog({ ...rowFromTrades({ rulesHash, rule, tier: t.tier, window: { name: 'research', from: iso(from), to: iso(to) }, verdict: rule === 'baseline' ? 'baseline' : 'info' }, []),
        n: x.trades, totalR: x.totalR, expectancyR: x.expectancyR, profitFactor: x.profitFactor, winRate: x.trades ? x.wins / x.trades : null });
    }
  }
  const report = `${formatAudit(result, { from, to })}\n\nSymbols: ${symbols.join(', ')}\n\nFill-realism fixture:\n${JSON.stringify(Object.fromEntries(result.map((t) => [t.tier, t.realism])), null, 2)}`;
  writeFileSync('audit-report.txt', report);
  writeFileSync('audit-losses.csv', csv(result));
  console.log(report);
}

if (process.argv[1]?.endsWith('audit.ts')) main().catch((e) => { console.error(e); process.exit(1); });
