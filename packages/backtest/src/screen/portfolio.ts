// Full-loop portfolio backtest of one screened configuration (owner's layer
// 4): the signal's entries, its ATR bracket, realistic fills, and the
// portfolio controls all switched on. Where the screen scores every trade in
// isolation, this shows what the account would have done: equity curve, max
// drawdown, how often the caps and the circuit breaker blocked entries, R per
// quarter. Research window only; the 6-month holdout is never loaded.
//
//   npm run -s portfolio -- --signal ema50_trend_vol --tf 1d --exit hiwin --extras 60
//   options: --risk 1 --max-open-risk 6 --max-alts 2 --daily-loss 8 --dd 15 --pause 7
//
// The one-time 6-month check (--holdout) runs the frozen configuration
// (HOLDOUT_FROZEN) on the held-out months and grades it against the rule
// declared before it runs (HOLDOUT_RULE, docs/RESULTS.md). It is LOCKED: it
// runs only with HOLDOUT_CONFIRM set to HOLDOUT_PHRASE (the owner decides when),
// refuses any other flags, and refuses to run again once its result file exists.

import { intervalMs } from '@bot/marketdata';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { researchWindow } from '../baseline';
import { runBacktest } from '../engine';
import { maxDrawdown, stats } from '../metrics';
import { appendRunLog, gitHash, profitFactor, type RunLogRow } from '../runlog';
import type { ScoreConfig } from '../score/config';
import { defaultConfig, type RrgRank, type BacktestConfig, type BacktestResult, type SymbolData, type Tf, type Trade } from '../types';
import { addMonths } from '../walkforward';
import { ALL_EXITS, eventOverride, eventsFor, screenConfig, type EntryDip, type ExitProfile } from './screen';
import { scalpReport } from './scalp';
import { scalp2Report } from './scalp2';
import { waveTrendModelsReport, waveTrendReport } from './wavetrend';
import { rsiPatternsReport, shortModelReport } from './rsipatterns';
import { rsiProModelsReport, rsiProReport } from './rsipro';
import { postmortemReport } from './postmortem';
import { fixesReport, liveRulesReport } from './fixes';
import { macdGapReport } from './macdgap';
import { macdPreCrossReport } from './macdprecross';
import { ltfSplitReport } from './ltfsplit';
import { fundingCarryReport, leadLagReport, liveLtfReport, ltfCostReport } from './ltfcost';
import { ltfGateReport } from './ltfgate';
import { ltfDivReport } from './ltfdiv';
import { liveRobustReport } from './liverobust';
import { fngReport, parseFng } from './fng';
import { tf2hReport } from './tf2h';
import { tf2hTriggerReport } from './tf2htrigger';
import { rsi10Report, rsi10Trace, WINDOW } from './rsi10';
import { manualExitReport } from './manualexits';
import { smcReport } from './smcreport';
import { smcTopDownReport } from './smctopdown';
import { weeklyDoubleBottomReport } from './wdbltiming';
import { newModelsReport } from './newmodels';
import { diagnoseReport, exitStudyReport, finalGridReport, pooledGridReport, frameworkV2Report, timedVsUntimedReport, macdAgainReport, noTimeStopReport, tpGridReport, tripleTopReport } from './research2';
import { sdTestReport, zoneEntryReport, ladderReport, optimiseEntriesReport, ltfEntryReport } from './sdtest';
import { frameworkReport, macdTriggerReport, rrgSplitReport, rsiGridReport, signalTradeReport, weeklyDailyStopReport } from './rsitrades';
import { rsiComboReport, rsiMapReport, weeklyEventReport } from './rsimap';
import { contextFor, FIBX_TRIGGERS, SIGNALS, type SignalDef } from './signals';
import { bucketReport, fibTradeFeatures, tradeDump, type FeatureRow } from './fibfeatures';

/**
 * Coin holdout (owner 2026-10-03, after the 6 held-back months were used too early): coins that no Fib run has seen,
 * frozen as a list in research/holdout-coins.json, untouched until the owner calls the model final (then one run).
 * Research runs drop these coins even if they later rank into the top 60.
 */
export const HOLDOUT_COINS_PATH = 'research/holdout-coins.json';
/** Every coin that appeared in a Fib research run (runs 210-277), as logged. */
export const FIB_RESEARCH_SEEN: readonly string[] = [
  'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'ZECUSDT', 'XAUUSDT', 'SUIUSDT', 'SANDUSDT', 'HYPEUSDT', 'NEARUSDT', 'DOGEUSDT',
  'LINKUSDT', 'ADAUSDT', 'QNTUSDT', 'ENAUSDT', '1000PEPEUSDT', 'BNBUSDT', 'AAVEUSDT', 'WLDUSDT', 'TAOUSDT', 'UNIUSDT',
  'PUMPFUNUSDT', 'AVAXUSDT', 'ONDOUSDT', 'LTCUSDT', 'GTCUSDT', 'HBARUSDT', 'MOVRUSDT', 'XAUTUSDT', 'MAGMAUSDT', 'USUSDT',
  'TRUMPUSDT', 'VELVETUSDT', 'XPLUSDT', 'FARTCOINUSDT', 'BCHUSDT', 'XLMUSDT', 'ARBUSDT', 'FILUSDT', 'PENGUUSDT', 'ASTERUSDT',
  'DOTUSDT', 'GALAUSDT', 'TIAUSDT', 'NIGHTUSDT', 'CTUSDT', 'ZROUSDT', 'ENSUSDT', 'LIGHTERUSDT', 'BTWUSDT', 'ENJUSDT', 'FETUSDT',
  'APTUSDT', 'PAXGUSDT', 'ALGOUSDT', 'MANAUSDT', 'APEUSDT', 'INJUSDT', 'CRVUSDT', 'ONEUSDT', 'AKEUSDT', 'PONSUSDT',
];
export function loadHoldoutCoins(path = HOLDOUT_COINS_PATH): string[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { symbols: string[] }).symbols;
}
/** Pinned research coins (owner 2026-10-03): the live top-60 drifts daily, so research runs use this fixed list. */
export const RESEARCH_COINS_PATH = 'research/research-coins.json';
export function loadResearchCoins(path = RESEARCH_COINS_PATH): string[] {
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { symbols: string[] }).symbols;
}
/** The holdout tier: eligible extras ranked by volume, skipping today's top `skip` and anything already seen. */
export function pickHoldoutCoins(ranked: ReadonlyArray<string>, seen: ReadonlySet<string>, skip = 60, n = 60): string[] {
  return ranked.slice(skip).filter((s) => !seen.has(s)).slice(0, n);
}

/**
 * Max favourable excursion before the initial stop (owner 2026-10-03: how far past 1.8R does price get before the
 * stop?). Walks bars from the entry; a bar that touches the stop ends the walk before its favourable extreme counts
 * (conservative). Returns the best excursion in R.
 */
export function mfeBeforeStop(
  candles: ReadonlyArray<{ openTime: number; high: number; low: number }>,
  t: { side: 'long' | 'short'; entry: number; initialStop: number; openedAt: number }, maxMs = 60 * 86_400_000,
): number {
  const long = t.side === 'long', risk = Math.abs(t.entry - t.initialStop);
  if (!(risk > 0)) return 0;
  let best = 0;
  for (const b of candles) {
    if (b.openTime < t.openedAt) continue;
    if (b.openTime > t.openedAt + maxMs) break;
    if (long ? b.low <= t.initialStop : b.high >= t.initialStop) break;
    best = Math.max(best, (long ? b.high - t.entry : t.entry - b.low) / risk);
  }
  return best;
}
function mfeReport(trades: ReadonlyArray<Trade>, data: Readonly<Record<string, SymbolData>>, tf: Tf, to: number, label: string): string[] {
  const cut = addMonths(to, -12);
  const rows = trades.map((t) => ({ old: t.openedAt < cut, m: mfeBeforeStop(data[t.symbol]?.candles[tf] ?? [], t) }));
  const pct = (xs: typeof rows, x: number) => (xs.length ? (100 * xs.filter((r) => r.m >= x).length) / xs.length : 0);
  const out = [`MFE before the initial stop (${label}, ${rows.length} trades): target / reached overall / older two years / newest year / gross R of all-out at the target`];
  for (const x of [1.5, 1.8, 2.0, 2.2, 2.5, 3.0, 3.5, 4.0, 5.0]) {
    const p = pct(rows, x) / 100;
    out.push(`  ${x.toFixed(1)}R  ${pct(rows, x).toFixed(1)}% / ${pct(rows.filter((r) => r.old), x).toFixed(1)}% / ${pct(rows.filter((r) => !r.old), x).toFixed(1)}% / ${(p * x - (1 - p)).toFixed(3)}R`);
  }
  return out;
}

/** Trade features for the Fib model's trades (owner 2026-10-03: what separates winners from losers). */
function featureReport(trades: ReadonlyArray<Trade>, data: Readonly<Record<string, SymbolData>>, tf: Tf, to: number, score: ScoreConfig, signalId: string): string[] {
  const getTrig = FIBX_TRIGGERS[signalId];
  if (!getTrig) return [`(--features: no trigger records for ${signalId})`];
  const cut = addMonths(to, -12);
  const btc = data.BTCUSDT?.candles['1d'] ?? [];
  const rows: FeatureRow[] = [];
  const ctxs = new Map<string, { x: NonNullable<ReturnType<typeof contextFor>>; trig: ReturnType<typeof getTrig>; at: Map<number, number> }>();
  for (const t of trades) {
    let e = ctxs.get(t.symbol);
    if (!e) {
      const x = contextFor(data, t.symbol, tf, score);
      if (!x) continue;
      e = { x, trig: getTrig(x), at: new Map(x.candles.map((c, i) => [c.openTime, i])) };
      ctxs.set(t.symbol, e);
    }
    // The signal bar: the last trigger (same side) whose bar closed at or before the entry, within 4 bars.
    const iv = intervalMs(tf), d = t.side === 'long' ? 1 : -1;
    let k: number | undefined;
    const last = e.at.get(Math.floor(t.openedAt / iv) * iv - iv);
    for (let q = last ?? -1; q >= 0 && last != null && q >= last - 4; q--) if (e.trig[q]?.d === d) { k = q; break; }
    const trig = k != null ? e.trig[k] : null;
    if (k == null || !trig) continue;
    rows.push({ r: t.r, old: t.openedAt < cut, f: fibTradeFeatures(e.x, k, trig, btc), label: `${new Date(t.openedAt).toISOString().slice(0, 10)} ${t.symbol.replace('USDT', '').padEnd(9)} ${t.side.padEnd(5)}` });
  }
  return [`(features found for ${rows.length} of ${trades.length} trades)`, ...bucketReport(rows), '', ...tradeDump(rows)];
}

/**
 * Per-coin check (owner 2026-10-03: a model that may work on one or two coins only). A coin is a specialist
 * candidate only if it has >= 30 trades, avg R >= +0.15 in the older two years (where it is picked), and is still
 * positive in the newest year it was not picked on. Lists the candidates for every exit and the top coins for the best exit.
 */
function perCoin(runs: { id: string; trades: ReadonlyArray<{ symbol: string; r: number; openedAt: number }>; to: number; avgR: number }[]): string[] {
  const out = ['PERCOIN: coin / trades / avg R older two years (n) / R newest year (n); CANDIDATE = >= 30 trades, older avg R >= +0.15, newest year > 0'];
  const best = [...runs].sort((a, b) => b.avgR - a.avgR)[0];
  for (const r of runs) {
    const cut = addMonths(r.to, -12);
    const by = new Map<string, { n: number; oR: number; oN: number; nR: number; nN: number }>();
    for (const t of r.trades) {
      const s = by.get(t.symbol) ?? { n: 0, oR: 0, oN: 0, nR: 0, nN: 0 };
      s.n++;
      if (t.openedAt < cut) { s.oR += t.r; s.oN++; } else { s.nR += t.r; s.nN++; }
      by.set(t.symbol, s);
    }
    const rows = [...by].map(([sym, s]) => ({ sym, ...s, oAvg: s.oN ? s.oR / s.oN : 0 }));
    const cand = rows.filter((x) => x.n >= 30 && x.oAvg >= 0.15 && x.nR > 0);
    const fmt = (x: (typeof rows)[number]) => `${x.sym.replace('USDT', '')} ${x.n} / ${x.oAvg >= 0 ? '+' : ''}${x.oAvg.toFixed(2)}R (${x.oN}) / ${x.nR >= 0 ? '+' : ''}${x.nR.toFixed(1)}R (${x.nN})`;
    out.push(`  ${r.id}: candidates: ${cand.length ? cand.map(fmt).join('; ') : 'none'}`);
    if (r === best) {
      out.push(`  ${r.id} (best exit) top 10 coins by older avg R (>= 10 trades):`);
      for (const x of rows.filter((y) => y.n >= 10).sort((a, b) => b.oAvg - a.oAvg).slice(0, 10)) out.push(`    ${fmt(x)}`);
    }
  }
  return out;
}

export interface PortfolioControls {
  /** Risk at the stop per trade, % of equity. */
  riskPct: number;
  maxOpenRiskPct: number;
  maxSameDirAlts: number;
  dailyLossPct: number;
  /** Circuit breaker: drawdown % from the realized peak that pauses entries, and for how many days. */
  drawdownPct: number;
  pauseDays: number;
  /** RRG magnifying glass (owner): strongest-against-BTC signals get the slots first; null/unset = first come, first served. */
  rrgPriorityTf?: Tf | null;
  /** How the RRG ranking orders competing signals (default position = the original magnifying glass). */
  rankBy?: RrgRank;
  /** Entry timing: a limit dip after the signal instead of a market entry (see EntryDip). Unset = market. */
  entryDip?: EntryDip | null;
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
    entryPriority: c.rrgPriorityTf ? { rrgTf: c.rrgPriorityTf, by: c.rankBy ?? 'position' } : null,
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
  const result = runBacktest(data, cfg, eventOverride(events, exit, false, controls.entryDip ?? null));
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

export function formatPortfolio(r: PortfolioReport, what: string, title = 'PORTFOLIO BACKTEST'): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const c = r.controls;
  return [
    `${title}  ${r.signal} ${r.tf} ${r.exit}  ${iso(r.from)} → ${iso(r.to)}${title === 'PORTFOLIO BACKTEST' ? ' (holdout excluded)' : ''}, ${r.symbols.length} coins`,
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

// ---- The one-time 6-month check (locked until the owner says go) -------------

/** Exactly what runs on the holdout: the configuration the 36-month portfolio backtest chose (docs/RESULTS.md). */
export const HOLDOUT_FROZEN = { signal: 'ema50_trend_vol', tf: '1d' as Tf, exit: 'hiwin', extras: 60, minVolume: 3_000_000, controls: DEFAULT_CONTROLS } as const;

/**
 * Declared before the check runs; not to be changed after it. Pass = all of:
 * enough trades to judge, positive average R, win rate at the owner's bar,
 * a survivable drawdown, and at least half the research average R.
 */
export const HOLDOUT_RULE = { minTrades: 30, minWinRate: 0.6, maxDrawdownPct: 25, researchAvgR: 0.103, minFractionOfResearch: 0.5 } as const;

/** The owner's go-ahead, typed into the workflow. */
export const HOLDOUT_PHRASE = 'OWNER SAYS GO';
export const HOLDOUT_RESULT_PATH = 'research/holdout-ema50.json';

export function holdoutUnlocked(confirm: string | undefined, resultExists: boolean): { ok: true } | { ok: false; why: string } {
  if (confirm !== HOLDOUT_PHRASE) return { ok: false, why: `the 6-month check is locked until the owner says go (set HOLDOUT_CONFIRM to "${HOLDOUT_PHRASE}")` };
  if (resultExists) return { ok: false, why: `the 6-month check already ran (${HOLDOUT_RESULT_PATH}); it runs once` };
  return { ok: true };
}

export interface HoldoutVerdict { pass: boolean; checks: { name: string; value: string; need: string; ok: boolean }[] }

export function holdoutVerdict(r: Pick<PortfolioReport, 'trades' | 'winRate' | 'expectancyR' | 'maxDrawdownPct'>): HoldoutVerdict {
  const R = HOLDOUT_RULE;
  const minR = R.researchAvgR * R.minFractionOfResearch;
  const checks = [
    { name: 'trades', value: String(r.trades), need: `>= ${R.minTrades}`, ok: r.trades >= R.minTrades },
    { name: 'average R', value: r.expectancyR.toFixed(3), need: '> 0', ok: r.expectancyR > 0 },
    { name: 'win rate', value: `${(r.winRate * 100).toFixed(1)}%`, need: `>= ${R.minWinRate * 100}%`, ok: r.winRate >= R.minWinRate },
    { name: 'max drawdown', value: `${r.maxDrawdownPct.toFixed(1)}%`, need: `< ${R.maxDrawdownPct}%`, ok: r.maxDrawdownPct < R.maxDrawdownPct },
    { name: 'average R vs research', value: r.expectancyR.toFixed(3), need: `>= ${minR.toFixed(3)} (half of ${R.researchAvgR})`, ok: r.expectancyR >= minR },
  ];
  return { pass: checks.every((c) => c.ok), checks };
}

// ---- A vs B: RRG as a magnifying glass (owner) --------------------------------

export interface SwapStats { n: number; winRate: number | null; avgR: number | null; totalR: number }
const swapStats = (ts: ReadonlyArray<Trade>): SwapStats => ({
  n: ts.length, totalR: ts.reduce((a, t) => a + t.r, 0),
  winRate: ts.length ? ts.filter((t) => t.r > 0).length / ts.length : null, avgR: ts.length ? ts.reduce((a, t) => a + t.r, 0) / ts.length : null,
});

/** Which trades B took that A didn't (swapped in), and the reverse (swapped out), matched by coin, side and entry time. */
export function compareTrades(a: ReadonlyArray<Trade>, b: ReadonlyArray<Trade>): { swappedIn: SwapStats; swappedOut: SwapStats; common: number } {
  const key = (t: Trade) => `${t.symbol}|${t.side}|${t.openedAt}`;
  const ka = new Set(a.map(key));
  const kb = new Set(b.map(key));
  return { swappedIn: swapStats(b.filter((t) => !ka.has(key(t)))), swappedOut: swapStats(a.filter((t) => !kb.has(key(t)))), common: b.filter((t) => ka.has(key(t))).length };
}

export function formatAvsB(a: PortfolioReport, b: PortfolioReport, d: ReturnType<typeof compareTrades>, rrgTf: Tf,
  names: { title: string; a: string; b: string } = { title: `A vs B: RRG as a magnifying glass (${rrgTf} RRG vs BTC), same signal, exits and controls`, a: 'A: first come, first served', b: 'B: strongest vs BTC first' }): string {
  const row = (name: string, r: PortfolioReport) =>
    `${name.padEnd(34)} ${String(r.trades).padStart(6)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${r.expectancyR.toFixed(3).padStart(7)}R ${r.totalR.toFixed(1).padStart(7)}R ${r.returnPct.toFixed(1).padStart(7)}% ${r.maxDrawdownPct.toFixed(1).padStart(6)}%  ${r.quarters.filter((q) => q.totalR > 0).length}/${r.quarters.length}`;
  const sw = (name: string, x: SwapStats) => `  ${name}: ${x.n} trades, win ${x.winRate == null ? '-' : (x.winRate * 100).toFixed(1) + '%'}, avg ${x.avgR == null ? '-' : x.avgR.toFixed(3) + 'R'}, total ${x.totalR.toFixed(1)}R`;
  // Short tags for the two sides ("A" / "C" when the names start "A: ..." / "C: ..."), so a 4-way report labels each pair right.
  const tag = (n: string, d: string) => /^([A-Z]):/.exec(n)?.[1] ?? d;
  const ta = tag(names.a, 'A'), tb = tag(names.b, 'B');
  return [
    names.title,
    '',
    `${''.padEnd(34)} ${'trades'.padStart(6)} ${'win'.padStart(7)} ${'avg'.padStart(8)} ${'total'.padStart(8)} ${'return'.padStart(8)} ${'maxDD'.padStart(7)}  q+`,
    row(names.a, a),
    row(names.b, b),
    '',
    `Same trades in both: ${d.common}`,
    sw(`${tb} took instead (swapped in)`, d.swappedIn),
    sw(`${tb} gave up (swapped out)`, d.swappedOut),
    `Blocked by the alts cap: ${ta} ${a.blocked['same-direction alts cap'] ?? 0}, ${tb} ${b.blocked['same-direction alts cap'] ?? 0}`,
  ].join('\n');
}

/**
 * The same entries under two exits (--compare-exit): trades both runs took, matched by coin, side and entry time,
 * split into the older years and the newest year, plus the newest year's trades where the exits differed most.
 */
export function formatExitPairs(a: ReadonlyArray<Trade>, b: ReadonlyArray<Trade>, cut: number, names: { a: string; b: string }, top = 12): string {
  const key = (t: Trade) => `${t.symbol}|${t.side}|${t.openedAt}`;
  const bm = new Map(b.map((t) => [key(t), t]));
  const pairs = a.flatMap((x) => { const y = bm.get(key(x)); return y ? [{ a: x, b: y }] : []; });
  const how = (t: Trade) => [...new Set(t.fills.filter((f) => f.reason !== 'entry').map((f) => f.reason))].join('+');
  const held = (t: Trade) => { const h = (t.closedAt - t.openedAt) / 3_600_000; return h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(1)}d`; };
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const block = (label: string, ps: typeof pairs) => {
    const ra = ps.reduce((s, p) => s + p.a.r, 0), rb = ps.reduce((s, p) => s + p.b.r, 0);
    const bWins = ps.filter((p) => p.b.r > p.a.r + 0.05), aWins = ps.filter((p) => p.a.r > p.b.r + 0.05);
    const sum = (xs: typeof pairs, f: (p: (typeof pairs)[number]) => number) => xs.reduce((s, p) => s + f(p), 0);
    const avgH = (xs: typeof pairs, side: 'a' | 'b') => xs.length ? xs.reduce((s, p) => s + (p[side].closedAt - p[side].openedAt), 0) / xs.length / 3_600_000 : 0;
    return [
      `${label}: ${ps.length} shared trades  ${names.a} ${ra.toFixed(1)}R  ${names.b} ${rb.toFixed(1)}R  (difference ${(rb - ra >= 0 ? '+' : '') + (rb - ra).toFixed(1)}R)`,
      `  ${names.b} better on ${bWins.length} trades by ${sum(bWins, (p) => p.b.r - p.a.r).toFixed(1)}R; ${names.a} better on ${aWins.length} by ${sum(aWins, (p) => p.a.r - p.b.r).toFixed(1)}R; ${ps.length - bWins.length - aWins.length} about the same`,
      `  average hold: ${names.a} ${avgH(ps, 'a').toFixed(0)}h, ${names.b} ${avgH(ps, 'b').toFixed(0)}h`,
    ];
  };
  const newer = pairs.filter((p) => p.a.openedAt >= cut);
  const row = (p: (typeof pairs)[number]) =>
    `  ${day(p.a.openedAt)}  ${p.a.symbol.replace('USDT', '').padEnd(9)} ${p.a.side.padEnd(5)} ${names.a} ${(p.a.r >= 0 ? '+' : '') + p.a.r.toFixed(2)}R ${how(p.a).padEnd(14)} ${held(p.a).padStart(6)}   ${names.b} ${(p.b.r >= 0 ? '+' : '') + p.b.r.toFixed(2)}R ${how(p.b).padEnd(14)} ${held(p.b).padStart(6)}`;
  const byGap = [...newer].sort((x, y) => (y.b.r - y.a.r) - (x.b.r - x.a.r));
  return [
    `SAME ENTRIES, TWO EXITS: ${names.a} vs ${names.b} (${pairs.length} trades taken by both of ${a.length} / ${b.length})`,
    ...block(`Older (before ${day(cut)})`, pairs.filter((p) => p.a.openedAt < cut)),
    ...block(`Newest year (from ${day(cut)})`, newer),
    '',
    `Newest year, where ${names.b} beat ${names.a} most:`,
    ...byGap.slice(0, top).map(row),
    '',
    `Newest year, where ${names.a} beat ${names.b} most:`,
    ...byGap.slice(-top).reverse().map(row),
  ].join('\n');
}

/** The most recent `n` winners and `n` losers, newest first (--trades n). */
export function formatTradeList(trades: ReadonlyArray<Trade>, n: number): string {
  const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const px = (v: number) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
  const row = (t: Trade) => {
    const exits = t.fills.filter((f) => f.reason !== 'entry');
    const q = exits.reduce((a, f) => a + f.qty, 0);
    const avg = q > 0 ? exits.reduce((a, f) => a + f.price * f.qty, 0) / q : t.entry;
    const how = [...new Set(exits.map((f) => f.reason))].join('+');
    const hrs = (t.closedAt - t.openedAt) / 3_600_000;
    return `  ${day(t.openedAt)}  ${t.symbol.replace('USDT', '').padEnd(9)} ${t.side.padEnd(5)} entry ${px(t.entry).padStart(10)}  stop ${px(t.initialStop).padStart(10)}  exit avg ${px(avg).padStart(10)} (${how.padEnd(14)}) ${(t.r >= 0 ? '+' : '') + t.r.toFixed(2)}R  ${hrs < 48 ? `${hrs.toFixed(0)}h` : `${(hrs / 24).toFixed(1)}d`}${t.rrg != null ? `  rrg ${t.rrg}` : ''}`;
  };
  const byClose = [...trades].sort((a, b) => b.closedAt - a.closedAt);
  const wins = byClose.filter((t) => t.r > 0).slice(0, n), losses = byClose.filter((t) => t.r <= 0).slice(0, n);
  return [
    `TRADES: the ${wins.length} most recent winners (newest first; opened UTC, exit = size-weighted average of all exits, R after costs)`,
    ...wins.map(row), '',
    `TRADES: the ${losses.length} most recent losers`,
    ...losses.map(row),
  ].join('\n');
}

async function holdoutMain() {
  const unlocked = holdoutUnlocked(process.env.HOLDOUT_CONFIRM, existsSync(HOLDOUT_RESULT_PATH));
  if (!unlocked.ok) throw new Error(unlocked.why);
  const extra = process.argv.slice(2).filter((a) => a.startsWith('--') && a !== '--holdout');
  if (extra.length) throw new Error(`the 6-month check runs the frozen configuration only; remove ${extra.join(' ')}`);
  const { createClient, fetchTickers } = await import('@bot/bitunix');
  const { apiTradable, selectUniverse } = await import('@bot/worker');
  const { loadMarket } = await import('../load');
  const { loadScoreConfig } = await import('../score/config');
  const F = HOLDOUT_FROZEN;
  const def = SIGNALS.find((x) => x.id === F.signal)!;
  const exit = ALL_EXITS.find((e) => e.id === F.exit)!;
  const from = researchWindow(0).to;
  const to = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: F.minVolume, maxExtraSymbols: F.extras }, await apiTradable(client));
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, -3), to, log });
  const { config: score, hash } = loadScoreConfig();
  const { report } = runPortfolio(data, symbols, def, F.tf, exit, defaultConfig(from, to), score, F.controls);
  const verdict = holdoutVerdict(report);
  const text = [
    formatPortfolio(report, exit.what, 'THE 6-MONTH CHECK (holdout, one time)'),
    '',
    `Pass rule (declared before running): ${verdict.pass ? 'PASS' : 'FAIL'}`,
    ...verdict.checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.value} (needs ${c.need})`),
  ].join('\n');
  writeFileSync('portfolio-report.txt', text);
  mkdirSync('research', { recursive: true });
  writeFileSync(HOLDOUT_RESULT_PATH, JSON.stringify({ ranAt: new Date().toISOString(), gitHash: gitHash(), frozen: F, rule: HOLDOUT_RULE, verdict, report }, null, 2));
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  appendRunLog({
    timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${F.tf} ${exit.id}`, tier: 'PORTFOLIO', params: { ...F.controls },
    window: { name: 'holdout', from: iso(from), to: iso(to) }, n: report.trades, expectancyR: report.expectancyR, profitFactor: report.profitFactor, totalR: report.totalR,
    winRate: report.winRate, nullPctile: null, randomFilterPctile: null, verdict: verdict.pass ? 'holds' : 'fails',
  } satisfies RunLogRow);
  console.log(text);
}

async function main() {
  if (process.argv.includes('--holdout')) return holdoutMain();
  // Read-only check of named coins against the live scan and models (owner 2026-10-07), e.g. --coin-check TAU,RIVER.
  const cc = process.argv.indexOf('--coin-check');
  if (cc >= 0) {
    const { coinCheck } = await import('../../../worker/src/coinCheck');
    return coinCheck((process.argv[cc + 1] ?? '').split(',').filter(Boolean));
  }
  // --compare-dip <atr> <minutes>: A = market entry after the daily close, B = limit dip within the window, else no trade.
  const dipAt = process.argv.indexOf('--compare-dip');
  const cmpDip: EntryDip | null = dipAt >= 0 ? { atr: Number(process.argv[dipAt + 1] ?? 0.25), minutes: Number(process.argv[dipAt + 2] ?? 90) } : null;
  const cmpTf = process.argv.includes('--compare-rrg') ? ((process.argv[process.argv.indexOf('--compare-rrg') + 1] ?? '1d') as Tf) : null;
  const { createClient, fetchTickers } = await import('@bot/bitunix');
  const { apiTradable, selectUniverse } = await import('@bot/worker');
  const { loadMarket, loadFunding } = await import('../load');
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
    // --rank position|heading|fastslow: the RRG ranking card on (daily), as live.
    ...(arg('rank') ? { rrgPriorityTf: '1d' as Tf, rankBy: arg('rank') as RrgRank } : {}),
  };
  const listN = num('trades', 0);
  const months = num('months', 36);
  // --oos (owner 2026-10-03): one out-of-sample run on the held-back months after the research window, for a model
  // chosen on research data only. The window then runs from the research end to today (logged as 'holdout').
  const oos = process.argv.includes('--oos');
  const researchEnd = researchWindow(0).to;
  // --to-today (owner 2026-10-03): RSI studies may run to today; the held-back months are already spent.
  const holdout = oos || process.argv.includes('--to-today') ? Math.floor(Date.now() / 86_400_000) * 86_400_000 : researchEnd; // the window's end
  const from = oos ? researchEnd : addMonths(holdout, -months);
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const tickers = await fetchTickers(client), tradable = await apiTradable(client);
  if (process.argv.includes('--freeze-holdout')) {
    // Prints the coin holdout list (ranked by today's volume, past the top 60, nothing a Fib run has seen) to commit.
    const ranked = selectUniverse(tickers, { universe: 'all', minQuoteVolume24h: 500_000, maxExtraSymbols: 100_000 }, tradable);
    const seen = new Set(FIB_RESEARCH_SEEN);
    const core = new Set(selectUniverse(tickers, { universe: 'core', minQuoteVolume24h: 0, maxExtraSymbols: 0 }));
    const pick = pickHoldoutCoins(ranked.filter((sym) => !core.has(sym)), seen); // extras in volume order
    const text = `HOLDOUT ${JSON.stringify({ frozenAt: new Date().toISOString().slice(0, 10), rule: 'ranks 61+ by 24h volume (>= 0.5M), minus every coin seen in a Fib run; untouched until the model is final', symbols: pick })}`;
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  const held = new Set(loadHoldoutCoins());
  const useHoldout = arg('coins') === 'holdout';
  // --coins pooled (owner 2026-10-04, after the holdout run): research + holdout coins together, to re-tune on both.
  const pooled = arg('coins') === 'pooled';
  if ((useHoldout || pooled) && !process.argv.includes('--final')) throw new Error('the coin holdout is locked until the model is final (pass --final with the owner\'s go-ahead)');
  const pinned = arg('coins') === 'live' || arg('coins') === 'fresh' ? [] : loadResearchCoins();
  // --coins fresh (owner 2026-10-03, the inverse RRG test): liquid coins in neither the research list nor the holdout,
  // never used by any research run, so a rule found on the research coins can be checked without spending the holdout.
  const research = new Set(loadResearchCoins());
  const symbols = arg('coins') === 'fresh'
    ? selectUniverse(tickers.filter((t) => !held.has(t.symbol) && !research.has(t.symbol) && (!arg('max-volume') || (t.quoteVolume24h ?? 0) < num('max-volume', Infinity))), { universe: 'all', minQuoteVolume24h: num('min-volume', 1_000_000), maxExtraSymbols: num('extras', 80) }, tradable).filter((sym) => !research.has(sym)).concat('BTCUSDT') // BTC: the RRG benchmark only (no RRG vs itself, so no BTC trades count)
    : useHoldout ? [...held]
    : pooled ? [...new Set([...loadResearchCoins(), ...held])]
    : pinned.length ? pinned.filter((sym) => !held.has(sym))
    : selectUniverse(tickers.filter((t) => !held.has(t.symbol)), { universe: 'all', minQuoteVolume24h: num('min-volume', 3_000_000), maxExtraSymbols: num('extras', 60) }, tradable);
  log(`symbols (${arg('coins') === 'fresh' ? 'fresh coins (not research, not holdout)' : useHoldout ? 'coin holdout' : pooled ? 'pooled research + holdout coins' : pinned.length ? 'pinned research list' : 'live top by volume'}, ${symbols.length}): ${symbols.join(', ')}`);
  // Daily signals need a longer warm-up (the S/R channels need 300 bars).
  const weeklyStudy = process.argv.includes('--rsi-weekly') || process.argv.includes('--rsi-trades') || process.argv.includes('--scalp') || process.argv.includes('--scalp2') || process.argv.includes('--wavetrend') || process.argv.includes('--rsi-patterns') || process.argv.includes('--rsi-pro') || process.argv.includes('--short-model') || process.argv.includes('--ltf-cost') || process.argv.includes('--lead-lag') || process.argv.includes('--funding-carry') || process.argv.includes('--ltf-gate') || process.argv.includes('--ltf-div') || process.argv.includes('--tf2h') || process.argv.includes('--tf2h-trigger') || process.argv.includes('--rsi10');
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, tf === '1d' || oos ? -12 : -3), to: holdout, log, ...(weeklyStudy ? { onlyTfs: (process.argv.includes('--ltf-div') || process.argv.includes('--tf2h') || process.argv.includes('--tf2h-trigger') ? ['1h', '4h', '1d'] : process.argv.includes('--ltf-gate') || process.argv.includes('--rsi10') ? ['15m', '1h', '4h', '1d'] : process.argv.includes('--ltf-cost') ? ['1h', '4h', '1d'] : process.argv.includes('--lead-lag') ? ['15m'] : process.argv.includes('--funding-carry') ? ['1h'] : process.argv.includes('--short-model') ? ['4h', '1d'] : process.argv.includes('--rsi-pro') && !process.argv.includes('--rsi-trades') ? (process.argv.includes('--rp-htf') ? ['4h', '1d'] : ['1h', '1d']) : process.argv.includes('--rsi-patterns') ? (process.argv.includes('--rp-htf') ? ['4h', '1d'] : ['1h', '4h', '1d']) : process.argv.includes('--wavetrend') && !process.argv.includes('--rsi-trades') ? (process.argv.includes('--wt-htf') ? ['4h', '1d'] : ['15m', '1h', '1d']) : process.argv.includes('--scalp2') ? ['15m', '1h', '4h', '1d'] : process.argv.includes('--scalp') ? ['15m', '1h'] : process.argv.includes('--rsi-trades') ? ['1d', '4h'] : [arg('event-tf') === '4h' ? '4h' : '1d']) as Tf[] } : {}) }); // oos: daily S/R channels need 300 daily bars before the window
  const { config: score, hash } = loadScoreConfig();
  if (process.argv.includes('--rsi-weekly')) {
    // Owner 2026-10-03: weekly Prism flips, exhaustion flips, RSI 14 divergences (use --months for a longer history).
    const evTf = (arg('event-tf') ?? '1w') as '1w' | '1d' | '4h';
    const text = weeklyEventReport(data, symbols, from, holdout, arg('cut-months') ? addMonths(holdout, -num('cut-months', 24)) : addMonths(from, Math.round(months / 2)), (arg('show') ?? 'ETHUSDT,LINKUSDT').split(','), evTf, arg('horizons')?.split(',').map(Number)).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi10')) {
    // Owner 2026-10-06: the 15M-RSI10 long model (docs/RESULTS.md).
    if (arg('window')) WINDOW.days = Math.max(7, Math.min(21, num('window', 10)));
    const text = (arg('trace') ? rsi10Trace(data, arg('trace')!.split(',')) : rsi10Report(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 12)), (arg('show') ?? 'ETHUSDT,SOLUSDT,LINKUSDT').split(','))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--tf2h-trigger')) {
    // Owner 2026-10-05: 2h entry trigger on the live models, longs and shorts (docs/RESULTS.md).
    const text = tf2hTriggerReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 24))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--ltf-gate') || process.argv.includes('--ltf-div') || process.argv.includes('--tf2h')) {
    // Owner 2026-10-05: cost / stop gate and realistic maker fills on the 15m / 1h lines (docs/RESULTS.md).
    const { fetchTradingPairs } = await import('@bot/bitunix');
    const specs = await fetchTradingPairs(client).catch(() => []);
    const ticks = new Map(specs.filter((x) => x.quotePrecision != null).map((x) => [x.symbol, 10 ** -x.quotePrecision!] as [string, number]));
    for (const sym of symbols) if (data[sym]) data[sym]!.funding = await loadFunding(client, '.cache/backtest', sym, from, holdout).catch(() => []);
    const cut = addMonths(holdout, -num('cut-months', 8));
    const text = (process.argv.includes('--tf2h') ? tf2hReport(data, symbols, from, holdout, cut, ticks) : process.argv.includes('--ltf-div') ? ltfDivReport(data, symbols, from, holdout, cut, ticks, arg('div-combo')) : ltfGateReport(data, symbols, from, holdout, cut, ticks)).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--ltf-cost') || process.argv.includes('--lead-lag') || process.argv.includes('--funding-carry')) {
    // Owner 2026-10-05: the outside review's 15m / 1h tests (docs/RESULTS.md "15m / 1h follow-up").
    const cut = addMonths(holdout, -num('cut-months', 8));
    if (process.argv.includes('--funding-carry')) for (const sym of symbols) if (data[sym]) data[sym]!.funding = await loadFunding(client, '.cache/backtest', sym, from, holdout).catch(() => []);
    const text = (process.argv.includes('--lead-lag') ? leadLagReport : process.argv.includes('--funding-carry') ? fundingCarryReport : ltfCostReport)(data, symbols, from, holdout, cut).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--short-model')) {
    // Owner 2026-10-04: "build the short model and test it" (downtrend shorts on 4H / daily).
    const text = shortModelReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 24))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi-pro') && !process.argv.includes('--rsi-trades')) {
    // Owner 2026-10-04: RSI Pro+ Suite signals, each tested by itself.
    const text = rsiProReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 8))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi-patterns')) {
    // Owner 2026-10-04: the RSI pattern catalogue and daily / 4H / 1H stacks from the owner's write-up.
    const text = rsiPatternsReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 8))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--wavetrend') && !process.argv.includes('--rsi-trades')) {
    // Owner 2026-10-04: WaveTrend [LazyBear] by itself (1h / 15m, or 4H / daily with --wt-htf) and with the RSI scalp.
    const text = waveTrendReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 8))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--scalp2')) {
    // Owner 2026-10-04: the selective 1h / 15m RSI scalp from the ETH (and SUI) charts.
    const text = scalp2Report(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 8)), (arg('show') ?? 'ETHUSDT,SUIUSDT').split(',')).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--scalp')) {
    // Owner 2026-10-03: 15m / 1h RSI scalp signals (LINK screenshots), alone and together.
    const text = scalpReport(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 8)), (arg('show') ?? 'LINKUSDT').split(',')).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi-trades')) {
    // Owner 2026-10-03: the RSI framework's signals run as trades (daily bars; weekly built from them).
    if (process.argv.includes('--fng')) {
      // Owner 2026-10-05: Fear & Greed at entry as a factor on the live models (alternative.me daily history, cached).
      const file = '.cache/backtest/fng.json';
      let json: unknown = null;
      try { json = await (await fetch('https://api.alternative.me/fng/?limit=0&format=json')).json(); mkdirSync('.cache/backtest', { recursive: true }); writeFileSync(file, JSON.stringify(json)); } catch (e) { log(`fear & greed fetch failed: ${String(e)}`); if (existsSync(file)) json = JSON.parse(readFileSync(file, 'utf8')); }
      const text = fngReport(data, symbols, from, addMonths(holdout, -num('cut-months', 24)), parseFng(json)).join('\n');
      writeFileSync('portfolio-report.txt', text);
      console.log(text);
      return;
    }
    if (process.argv.includes('--smc-topdown')) {
      // Owner 2026-10-10: SMC top-down model (weekly / daily POI, 4H or 1H entry); 1H entries need the 1h history (Oct 2022 on).
      const { data: h1 } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(holdout, -48), to: holdout, log, onlyTfs: ['1h'] as Tf[] });
      const merged = Object.fromEntries(symbols.map((sym) => [sym, { candles: { ...(data[sym]?.candles ?? {}), '1h': h1[sym]?.candles['1h'] ?? [] } }]));
      const text = smcTopDownReport(merged, symbols, from, holdout, addMonths(holdout, -num('cut-months', 24))).join('\n');
      writeFileSync('portfolio-report.txt', text);
      console.log(text);
      return;
    }
    if (process.argv.includes('--ltf-split') || process.argv.includes('--ltf-entry') || process.argv.includes('--ltf-live')) {
      // Owner 2026-10-03: framework trades split by the 1h / 15m RSI at entry; the 1h / 15m history covers the last 26 months.
      const { data: ltf } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(holdout, -26), to: holdout, log, onlyTfs: ['1h', '15m'] as Tf[] });
      const merged = Object.fromEntries(symbols.map((sym) => [sym, { candles: { ...(data[sym]?.candles ?? {}), '1h': ltf[sym]?.candles['1h'] ?? [], '15m': ltf[sym]?.candles['15m'] ?? [] } }]));
      const text = (process.argv.includes('--ltf-live') ? liveLtfReport : process.argv.includes('--ltf-entry') ? ltfEntryReport : ltfSplitReport)(merged, symbols, from, holdout, addMonths(holdout, -num('cut-months', 24))).join('\n');
      writeFileSync('portfolio-report.txt', text);
      console.log(text);
      return;
    }
    const text = (process.argv.includes('--smc-zones') ? smcReport : process.argv.includes('--manual-exits') ? manualExitReport : process.argv.includes('--live-robust') ? (d: typeof data, s: string[], f: number) => liveRobustReport(d, s, f) : process.argv.includes('--wdb-timing') ? weeklyDoubleBottomReport : process.argv.includes('--macd-precross') ? macdPreCrossReport : process.argv.includes('--macd-gap') ? macdGapReport : process.argv.includes('--live-rules') ? liveRulesReport : process.argv.includes('--fixes') ? fixesReport : process.argv.includes('--postmortem') ? postmortemReport : process.argv.includes('--rsi-pro') ? rsiProModelsReport : process.argv.includes('--wavetrend') ? waveTrendModelsReport : process.argv.includes('--pooled-grid') ? (...a: Parameters<typeof finalGridReport>) => pooledGridReport(...a, held) : process.argv.includes('--final-grid') ? finalGridReport : process.argv.includes('--timed-vs-untimed') ? timedVsUntimedReport : process.argv.includes('--framework-v2') ? frameworkV2Report : process.argv.includes('--exit-study') ? exitStudyReport : process.argv.includes('--macd-again') ? macdAgainReport : process.argv.includes('--no-time-stop') ? noTimeStopReport : process.argv.includes('--diagnose') ? diagnoseReport : process.argv.includes('--triple-top') ? tripleTopReport : process.argv.includes('--tp-grid') ? tpGridReport : process.argv.includes('--new-models') ? newModelsReport : process.argv.includes('--optimise') ? optimiseEntriesReport : process.argv.includes('--ladder') ? ladderReport : process.argv.includes('--zone-entry') ? zoneEntryReport : process.argv.includes('--sd-test') ? sdTestReport : process.argv.includes('--rrg-split') ? rrgSplitReport : process.argv.includes('--framework') ? frameworkReport : process.argv.includes('--grid') ? rsiGridReport : process.argv.includes('--macd') ? macdTriggerReport : process.argv.includes('--daily-stop') ? weeklyDailyStopReport : signalTradeReport)(data, symbols, from, holdout, addMonths(holdout, -num('cut-months', 24))).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi-combo')) {
    // Owner 2026-10-03: weekly x daily RSI map (research window only, pinned coins).
    const text = rsiComboReport(data, symbols, from, holdout, addMonths(holdout, -12)).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (process.argv.includes('--rsi-map')) {
    // Owner 2026-10-03: model-free RSI map per timeframe (research window only, pinned coins).
    const text = rsiMapReport(data, symbols, from, holdout, addMonths(holdout, -12)).join('\n');
    writeFileSync('portfolio-report.txt', text);
    console.log(text);
    return;
  }
  if (cmpDip) {
    const a = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, controls);
    const b = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, { ...controls, entryDip: cmpDip });
    const names = {
      title: `A vs B: entry timing after the daily close (${exit.id}); same signal, exits and controls`,
      a: 'A: market at the next open', b: `B: limit ${cmpDip.atr} ATR better, ${cmpDip.minutes} min`,
    };
    const text = [formatAvsB(a.report, b.report, compareTrades(a.result.trades, b.result.trades), tf, names), '', '---- A', formatPortfolio(a.report, exit.what), '', '---- B', formatPortfolio(b.report, exit.what)].join('\n');
    writeFileSync('portfolio-report.txt', text);
    writeFileSync('portfolio-results.json', JSON.stringify({ a: a.report, b: b.report }, null, 2));
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const [name, r] of [['A market', a.report], [`B dip-${cmpDip.atr}atr-${cmpDip.minutes}m`, b.report]] as const) {
      appendRunLog({
        timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${exit.id} ${name}`, tier: 'PORTFOLIO', params: { ...controls },
        window: { name: oos ? 'holdout' : 'research', from: iso(from), to: iso(holdout) }, n: r.trades, expectancyR: r.expectancyR, profitFactor: r.profitFactor, totalR: r.totalR,
        winRate: r.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
      } satisfies RunLogRow);
    }
    console.log(text);
    return;
  }
  const exitList = arg('exits');
  if (exitList) {
    // --exits a,b,c: the same signal and controls under each exit (data loaded once); one SUMMARY line per exit.
    const exits = exitList.split(',').map((id) => {
      const e = ALL_EXITS.find((x) => x.id === id.trim());
      if (!e) throw new Error(`unknown exit ${id} (known: ${ALL_EXITS.map((x) => x.id).join(', ')})`);
      return e;
    });
    const runs = exits.map((e) => ({ exit: e, ...runPortfolio(data, symbols, def, tf, e, defaultConfig(from, holdout), score, controls) }));
    const text = [
      ...runs.flatMap((r) => [`---- ${r.exit.id}`, formatPortfolio(r.report, r.exit.what), '']),
      `SUMMARY ${def.id} ${tf}: exit / return / max drawdown / profitable quarters / R older two years / R newer year / trades / win / avg R`,
      ...runs.map((r) => {
        const cut = addMonths(r.report.to, -12);
        const q = r.report.quarters;
        const older = q.filter((x) => x.from < cut).reduce((s, x) => s + x.totalR, 0);
        const newer = q.filter((x) => x.from >= cut).reduce((s, x) => s + x.totalR, 0);
        return `  ${r.exit.id.padEnd(10)} ${r.report.returnPct.toFixed(1).padStart(7)}% / ${r.report.maxDrawdownPct.toFixed(1)}% / ${q.filter((x) => x.totalR > 0).length}/${q.length} / ${older.toFixed(1)}R / ${newer.toFixed(1)}R / ${r.report.trades} / ${(r.report.winRate * 100).toFixed(1)}% / ${r.report.expectancyR.toFixed(3)}R`;
      }),
      '',
      ...(process.argv.includes('--features') ? [...featureReport(runs[0]!.result.trades, data, tf, runs[0]!.report.to, score, def.id), ''] : []),
      ...(process.argv.includes('--mfe') ? [...mfeReport(runs[0]!.result.trades, data, tf, runs[0]!.report.to, `${def.id} ${runs[0]!.exit.id}`), ''] : []),
      ...perCoin(runs.map((r) => ({ id: r.exit.id, trades: r.result.trades, to: r.report.to, avgR: r.report.expectancyR }))),
    ].join('\n');
    writeFileSync('portfolio-report.txt', text);
    writeFileSync('portfolio-results.json', JSON.stringify(Object.fromEntries(runs.map((r) => [r.exit.id, r.report])), null, 2));
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const r of runs) {
      appendRunLog({
        timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${r.exit.id}`, tier: 'PORTFOLIO', params: { ...controls },
        window: { name: oos ? 'holdout' : 'research', from: iso(from), to: iso(holdout) }, n: r.report.trades, expectancyR: r.report.expectancyR, profitFactor: r.report.profitFactor, totalR: r.report.totalR,
        winRate: r.report.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
      } satisfies RunLogRow);
    }
    console.log(text);
    return;
  }
  const cmpExit = arg('compare-exit');
  if (cmpExit) {
    // --compare-exit <id>: A = --exit, B = this exit; same signal, entries and controls.
    const exitB = ALL_EXITS.find((e) => e.id === cmpExit);
    if (!exitB) throw new Error(`unknown --compare-exit (known: ${ALL_EXITS.map((e) => e.id).join(', ')})`);
    const a = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, controls);
    const b = runPortfolio(data, symbols, def, tf, exitB, defaultConfig(from, holdout), score, controls);
    const names = { title: `A vs B: exits on ${def.id} ${tf}; same signal and controls`, a: `A: ${exit.id}`, b: `B: ${exitB.id}` };
    const text = [
      formatAvsB(a.report, b.report, compareTrades(a.result.trades, b.result.trades), tf, names), '',
      formatExitPairs(a.result.trades, b.result.trades, addMonths(holdout, -12), { a: exit.id, b: exitB.id }), '',
      '---- A', formatPortfolio(a.report, exit.what), '', '---- B', formatPortfolio(b.report, exitB.what),
    ].join('\n');
    writeFileSync('portfolio-report.txt', text);
    writeFileSync('portfolio-results.json', JSON.stringify({ a: a.report, b: b.report }, null, 2));
    console.log(text);
    return;
  }
  if (process.argv.includes('--compare-rank')) {
    // First come, first served vs the three RRG rankings (position / heading / fast + slow), same signal, exits and controls.
    const variants: [string, PortfolioControls][] = [
      ['A: first come, first served', { ...controls, rrgPriorityTf: null }],
      ['B: RRG position (strongest vs BTC)', { ...controls, rrgPriorityTf: '1d', rankBy: 'position' }],
      ['C: RRG heading (turning hardest)', { ...controls, rrgPriorityTf: '1d', rankBy: 'heading' }],
      ['D: RRG fast + slow (both turning)', { ...controls, rrgPriorityTf: '1d', rankBy: 'fastslow' }],
    ];
    const runs = variants.map(([name, c]) => ({ name, ...runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, c) }));
    const a = runs[0]!;
    const text = [
      `RRG ranking: which signal gets a capped slot (${def.id} ${tf} ${exit.id}; same signal, exits and controls)`,
      ...runs.slice(1).flatMap((r) => ['', formatAvsB(a.report, r.report, compareTrades(a.result.trades, r.result.trades), '1d', { title: `${a.name} vs ${r.name}`, a: a.name, b: r.name })]),
      ...runs.flatMap((r) => ['', `---- ${r.name}`, formatPortfolio(r.report, exit.what)]),
      '',
      `SUMMARY ${def.id} ${tf} ${exit.id}: return / max drawdown / profitable quarters / R older two years / R newer year / trades`,
      ...runs.map((r) => {
        const cut = addMonths(r.report.to, -12);
        const older = r.report.quarters.filter((q) => q.from < cut).reduce((x, q) => x + q.totalR, 0);
        const newer = r.report.quarters.filter((q) => q.from >= cut).reduce((x, q) => x + q.totalR, 0);
        const q = r.report.quarters;
        return `  ${r.name.padEnd(36)} ${r.report.returnPct.toFixed(1).padStart(6)}% / ${r.report.maxDrawdownPct.toFixed(1)}% / ${q.filter((x) => x.totalR > 0).length}/${q.length} / ${older.toFixed(1)}R / ${newer.toFixed(1)}R / ${r.report.trades}`;
      }),
    ].join('\n');
    writeFileSync('portfolio-report.txt', text);
    writeFileSync('portfolio-results.json', JSON.stringify(Object.fromEntries(runs.map((r) => [r.name, r.report])), null, 2));
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const r of runs) {
      appendRunLog({
        timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${exit.id} ${r.name}`, tier: 'PORTFOLIO', params: { ...r.report.controls },
        window: { name: oos ? 'holdout' : 'research', from: iso(from), to: iso(holdout) }, n: r.report.trades, expectancyR: r.report.expectancyR, profitFactor: r.report.profitFactor, totalR: r.report.totalR,
        winRate: r.report.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
      } satisfies RunLogRow);
    }
    console.log(text);
    return;
  }
  if (cmpTf) {
    const a = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, { ...controls, rrgPriorityTf: null });
    const b = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, { ...controls, rrgPriorityTf: cmpTf });
    const text = [formatAvsB(a.report, b.report, compareTrades(a.result.trades, b.result.trades), cmpTf), '', '---- A', formatPortfolio(a.report, exit.what), '', '---- B', formatPortfolio(b.report, exit.what)].join('\n');
    writeFileSync('portfolio-report.txt', text);
    writeFileSync('portfolio-results.json', JSON.stringify({ a: a.report, b: b.report }, null, 2));
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    for (const [name, r] of [['A first-come', a.report], [`B rrg-${cmpTf}`, b.report]] as const) {
      appendRunLog({
        timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${exit.id} ${name}`, tier: 'PORTFOLIO', params: { ...controls },
        window: { name: oos ? 'holdout' : 'research', from: iso(from), to: iso(holdout) }, n: r.trades, expectancyR: r.expectancyR, profitFactor: r.profitFactor, totalR: r.totalR,
        winRate: r.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
      } satisfies RunLogRow);
    }
    console.log(text);
    return;
  }
  const { report, result } = runPortfolio(data, symbols, def, tf, exit, defaultConfig(from, holdout), score, controls);
  const text = [formatPortfolio(report, exit.what), ...(listN > 0 ? ['', formatTradeList(result.trades, listN)] : [])].join('\n');
  writeFileSync('portfolio-report.txt', text);
  writeFileSync('portfolio-results.json', JSON.stringify(report, null, 2));
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  appendRunLog({
    timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash: hash, rule: `portfolio ${def.id}`, variant: `${tf} ${exit.id}`, tier: 'PORTFOLIO', params: { ...controls },
    window: { name: oos ? 'holdout' : 'research', from: iso(from), to: iso(holdout) }, n: report.trades, expectancyR: report.expectancyR, profitFactor: report.profitFactor, totalR: report.totalR,
    winRate: report.winRate, nullPctile: null, randomFilterPctile: null, verdict: 'info',
  } satisfies RunLogRow);
  console.log(text);
}

if (process.argv[1]?.endsWith('portfolio.ts')) main().catch((e) => { console.error(e); process.exit(1); });
