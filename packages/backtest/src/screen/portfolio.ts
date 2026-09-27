// Full-loop portfolio backtest of one screened configuration (owner's layer
// 4): the signal's entries, its ATR bracket, realistic fills, and the
// portfolio controls all switched on. Where the screen scores every trade in
// isolation, this shows what the account would have done: equity curve, max
// drawdown, how often the caps and the circuit breaker blocked entries, R per
// quarter. Research window only; the 6-month holdout is never loaded.
//
//   npm run -s portfolio -- --signal ema50_trend_vol --tf 1d --exit hiwin --extras 60
//   options: --risk 1 --max-open-risk 6 --max-alts 2 --daily-loss 8 --dd 15 --pause 7

import { writeFileSync } from 'node:fs';
import { researchWindow } from '../baseline';
import { runBacktest } from '../engine';
import { maxDrawdown, stats } from '../metrics';
import { appendRunLog, gitHash, profitFactor, type RunLogRow } from '../runlog';
import type { ScoreConfig } from '../score/config';
import { defaultConfig, type BacktestConfig, type BacktestResult, type SymbolData, type Tf, type Trade } from '../types';
import { addMonths } from '../walkforward';
import { ALL_EXITS, eventOverride, eventsFor, screenConfig, type ExitProfile } from './screen';
import { SIGNALS, type SignalDef } from './signals';

export interface PortfolioControls {
  /** Risk at the stop per trade, % of equity. */
  riskPct: number;
  maxOpenRiskPct: number;
  maxSameDirAlts: number;
  dailyLossPct: number;
  /** Circuit breaker: drawdown % from the realized peak that pauses entries, and for how many days. */
  drawdownPct: number;
  pauseDays: number;
}

/** Guideline values (docs/GUIDELINES.md layer 4). */
export const DEFAULT_CONTROLS: PortfolioControls = { riskPct: 1, maxOpenRiskPct: 6, maxSameDirAlts: 2, dailyLossPct: 8, drawdownPct: 15, pauseDays: 7 };

/** The screen's isolated config with the portfolio layer switched on. */
export function portfolioConfig(base: BacktestConfig, tf: Tf, exit: ExitProfile, c: PortfolioControls): BacktestConfig {
  const s = screenConfig(base, tf, exit);
  return {
    ...s,
    fillRealism: true,
    portfolio: { maxOpenRiskPct: c.maxOpenRiskPct, maxSameDirAlts: c.maxSameDirAlts },
    circuitBreaker: { drawdownPct: c.drawdownPct, pauseDays: c.pauseDays },
    risk: {
      ...s.risk,
      coreExposureCap: base.risk.coreExposureCap,
      tiers: { ...s.risk.tiers, MTF: { ...s.risk.tiers.MTF, riskPct: c.riskPct, dailyLossPct: c.dailyLossPct, maxEffectiveLeverage: base.risk.tiers.MTF.maxEffectiveLeverage } },
    },
  };
}

export interface QuarterRow { from: number; to: number; n: number; totalR: number; winRate: number | null }

export interface PortfolioReport {
  signal: string; tf: Tf; exit: string; controls: PortfolioControls;
  from: number; to: number; symbols: string[];
  trades: number; winRate: number; expectancyR: number; profitFactor: number | null; totalR: number;
  returnPct: number; maxDrawdownPct: number; endEquity: number;
  longs: number; shorts: number;
  /** Entries the layer-4 controls turned away, by reason. */
  blocked: Record<string, number>;
  breakerTrips: number;
  quarters: QuarterRow[];
  /** Exposure: mean and max number of open positions at 15m closes. */
  openMean: number; openMax: number;
  warnings: string[];
}

const BLOCK_REASONS = ['portfolio open-risk cap', 'same-direction alts cap', 'daily-loss-limit', 'drawdown circuit breaker', 'core-exposure-cap'];

export function quarters(trades: ReadonlyArray<Trade>, from: number, to: number): QuarterRow[] {
  const out: QuarterRow[] = [];
  for (let q = from; q < to; q = addMonths(q, 3)) {
    const end = Math.min(addMonths(q, 3), to);
    const w = trades.filter((t) => t.openedAt >= q && t.openedAt < end);
    out.push({ from: q, to: end, n: w.length, totalR: w.reduce((a, t) => a + t.r, 0), winRate: w.length ? w.filter((t) => t.r > 0).length / w.length : null });
  }
  return out;
}

/** Open positions over time from the trades' open/close stamps, sampled per trade event. */
function exposure(trades: ReadonlyArray<Trade>): { mean: number; max: number } {
  const ev = trades.flatMap((t) => [[t.openedAt, 1], [t.closedAt, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0, max = 0, area = 0, last = ev[0]?.[0] ?? 0;
  for (const [t, d] of ev) { area += open * (t - last); last = t; open += d; max = Math.max(max, open); }
  const span = ev.length ? ev[ev.length - 1]![0] - ev[0]![0] : 0;
  return { mean: span ? area / span : 0, max };
}

export function runPortfolio(data: Readonly<Record<string, SymbolData>>, symbols: string[], def: SignalDef, tf: Tf, exit: ExitProfile, base: BacktestConfig, score: ScoreConfig, controls: PortfolioControls): { report: PortfolioReport; result: BacktestResult } {
  const events = eventsFor(data, symbols, tf, def, score);
  const cfg = portfolioConfig(base, tf, exit, controls);
  const result = runBacktest(data, cfg, eventOverride(events, exit, false));
  const s = stats(result.trades);
  const blocked: Record<string, number> = {};
  for (const r of result.rejected) if (BLOCK_REASONS.includes(r.reason)) blocked[r.reason] = (blocked[r.reason] ?? 0) + 1;
  const ex = exposure(result.trades);
  const report: PortfolioReport = {
    signal: def.id, tf, exit: exit.id, controls, from: base.from, to: base.to, symbols,
    trades: s.trades, winRate: s.winRate, expectancyR: s.expectancyR, profitFactor: profitFactor(result.trades), totalR: s.totalR,
    returnPct: (result.endEquity / cfg.startEquity - 1) * 100, maxDrawdownPct: maxDrawdown(cfg.startEquity, result.equityCurve) * 100, endEquity: result.endEquity,
    longs: result.trades.filter((t) => t.side === 'long').length, shorts: result.trades.filter((t) => t.side === 'short').length,
    blocked, breakerTrips: result.warnings.filter((w) => w.startsWith('circuit breaker')).length,
    quarters: quarters(result.trades, base.from, base.to), openMean: ex.mean, openMax: ex.max, warnings: result.warnings,
  };
  return { report, result };
}

export function formatPortfolio(r: PortfolioReport, what: string): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const c = r.controls;
  return [
    `PORTFOLIO BACKTEST  ${r.signal} ${r.tf} ${r.exit}  ${iso(r.from)} → ${iso(r.to)} (holdout excluded), ${r.symbols.length} coins`,
    `Exit: ${what}. Fill realism on, taker fees, 2 bps slippage, funding, cost veto.`,
    `Controls: ${c.riskPct}% risk per trade; open risk <= ${c.maxOpenRiskPct}%; <= ${c.maxSameDirAlts} same-direction alts; daily loss ${c.dailyLossPct}%; breaker ${c.drawdownPct}% DD -> ${c.pauseDays} days off.`,
    '',
    `Trades ${r.trades} (${r.longs} long / ${r.shorts} short)  win ${(r.winRate * 100).toFixed(1)}%  avg ${r.expectancyR.toFixed(3)}R  PF ${r.profitFactor?.toFixed(2) ?? '-'}  total ${r.totalR.toFixed(1)}R`,
    `Return ${r.returnPct.toFixed(1)}% (end $${r.endEquity.toFixed(0)})  max drawdown ${r.maxDrawdownPct.toFixed(1)}%  open positions mean ${r.openMean.toFixed(1)} / max ${r.openMax}`,
    `Blocked by the controls: ${Object.keys(r.blocked).length ? Object.entries(r.blocked).map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}; circuit breaker tripped ${r.breakerTrips}x`,
    '',
    'Per quarter:',
    ...r.quarters.map((q) => `  ${iso(q.from)} → ${iso(q.to)}  ${String(q.n).padStart(4)} tr  win ${q.winRate == null ? '   -' : `${(q.winRate * 100).toFixed(0).padStart(3)}%`}  ${q.totalR.toFixed(1).padStart(7)}R`),
    `  quarters positive: ${r.quarters.filter((q) => q.totalR > 0).length}/${r.quarters.length}`,
    ...(r.warnings.length ? ['', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`)] : []),
    '',
    `Symbols: ${r.symbols.join(', ')}`,
  ].join('\n');
}

async function main() {
  const { createClient, fetchTickers } = await import('@bot/bitunix');
  const { apiTradable, selectUniverse } = await import('@bot/worker');
  const { loadMarket } = await import('../load');
  const { loadScoreConfig } = await import('../score/config');
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const num = (n: string, d: number) => (arg(n) != null ? Number(arg(n)) : d);
  const def = SIGNALS.find((s) => s.id === (arg('signal') ?? 'ema50_trend_vol'));
  const exit = ALL_EXITS.find((e) => e.id === (arg('exit') ?? 'hiwin'));
  const tf = (arg('tf') ?? '1d') as Tf;
  if (!def) throw new Error(`unknown signal (known: ${SIGNALS.map((s) => s.id).join(', ')})`);
  if (!exit) throw new Error(`unknown exit (known: ${ALL_EXITS.map((e) => e.id).join(', ')})`);
  const controls: PortfolioControls = {
    riskPct: num('risk', DEFAULT_CONTROLS.riskPct), maxOpenRiskPct: num('max-open-risk', DEFAULT_CONTROLS.maxOpenRiskPct), maxSameDirAlts: num('max-alts', DEFAULT_CONTROLS.maxSameDirAlts),
    dailyLossPct: num('daily-loss', DEFAULT_CONTROLS.dailyLossPct), drawdownPct: num('dd', DEFAULT_CONTROLS.drawdownPct), pauseDays: num('pause', DEFAULT_CONTROLS.pauseDays),
  };
  const months = num('months', 36);
  const holdout = researchWindow(0).to;
  const from = addMonths(holdout, -months);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: num('min-volume', 3_000_000), maxExtraSymbols: num('extras', 60) }, await apiTradable(client));
  log(`symbols (${symbols.length}): ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, -3), to: holdout, log });
  const { config: score, hash } = loadScoreConfig();
  const { report } = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, controls);
  const text = formatPortfolio(report, exit.what);
  writeFileSync('portfolio-report.txt', text);
  writeFileSync('portfolio-results.json', JSON.stringify(report, null, 2));
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  appendRunLog({
    timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${exit.id}`, tier: 'PORTFOLIO', params: { ...controls },
    window: { name: 'research', from: iso(from), to: iso(holdout) }, n: report.trades, expectancyR: report.expectancyR, profitFactor: report.profitFactor, totalR: report.totalR,
    winRate: report.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
  } satisfies RunLogRow);
  console.log(text);
}

if (process.argv[1]?.endsWith('portfolio.ts')) main().catch((e) => { console.error(e); process.exit(1); });
