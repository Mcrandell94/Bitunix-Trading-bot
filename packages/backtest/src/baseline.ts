// Baseline lock (docs/backtest/TASKS.md, T2): runs MTF and HTF alone on the
// 2-year research window (holdout excluded) and prints a fixture. The
// baseline-check workflow compares a fresh run against the committed
// fixture, so any change to baseline logic fails CI until the fixture is
// regenerated on purpose.
//
//   npm run -s baseline -- --days 730 --extras 20 [--write research/baseline-2y.json] [--check research/baseline-2y.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, fetchTickers } from '@bot/bitunix';
import { CORE_SYMBOLS } from '@bot/signals';
import { apiTradable, selectUniverse } from '@bot/worker';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { profitFactor } from './runlog';
import type { Tier } from '@bot/risk';
import { defaultConfig, type BacktestConfig, type SymbolData, type Trade } from './types';

const DAY = 86_400_000;
/** The last 6 months are the holdout (SPEC §6): never evaluated before T13. */
export const HOLDOUT_DAYS = 182;

export interface TierFixture {
  trades: number; wins: number; totalR: number; expectancyR: number | null; profitFactor: number | null;
  /** Order-sensitive digest of every trade (symbol, open time, entry, stop, R). */
  digest: string;
}
export interface BaselineFixture {
  window: { from: string; to: string };
  symbols: string[];
  tiers: Record<'MTF' | 'HTF', TierFixture>;
}

function digest(trades: ReadonlyArray<Trade>): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  for (const t of trades) feed(`${t.symbol}|${t.openedAt}|${t.entry.toPrecision(10)}|${t.initialStop.toPrecision(10)}|${t.r.toFixed(6)};`);
  return h.toString(16).padStart(8, '0');
}

export function tierFixture(trades: ReadonlyArray<Trade>): TierFixture {
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  return {
    trades: trades.length, wins: trades.filter((t) => t.r > 0).length, totalR: Number(totalR.toFixed(4)),
    expectancyR: trades.length ? Number((totalR / trades.length).toFixed(4)) : null, profitFactor: profitFactor(trades),
    digest: digest(trades),
  };
}

/** The research window: `days` long, ending where the holdout starts, anchored to 00:00 UTC. */
export function researchWindow(days: number, now = Date.now()): { from: number; to: number } {
  const to = Math.floor((now - HOLDOUT_DAYS * DAY) / DAY) * DAY;
  return { from: to - days * DAY, to };
}

/** The config with only `tier` switched on. */
export function soloTier(base: BacktestConfig, tier: Tier): BacktestConfig {
  return { ...base, tiers: { LTF: { ...base.tiers.LTF, enabled: tier === 'LTF' }, MTF: { ...base.tiers.MTF, enabled: tier === 'MTF' }, HTF: { ...base.tiers.HTF, enabled: tier === 'HTF' }, P4H: { ...base.tiers.P4H, enabled: tier === 'P4H' } } };
}

export function baselineFixture(data: Record<string, SymbolData>, base: BacktestConfig, symbols: string[]): BaselineFixture {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const solo = (tier: 'MTF' | 'HTF') => soloTier(base, tier);
  return {
    window: { from: iso(base.from), to: iso(base.to) }, symbols,
    tiers: { MTF: tierFixture(runBacktest(data, solo('MTF')).trades), HTF: tierFixture(runBacktest(data, solo('HTF')).trades) },
  };
}

export function compareFixtures(expected: BaselineFixture, actual: BaselineFixture): string[] {
  const diffs: string[] = [];
  if (expected.window.from !== actual.window.from || expected.window.to !== actual.window.to) diffs.push(`window ${expected.window.from}→${expected.window.to} vs ${actual.window.from}→${actual.window.to}`);
  const es = [...expected.symbols].sort().join(','); const as = [...actual.symbols].sort().join(',');
  if (es !== as) diffs.push(`symbols differ: expected ${es}; got ${as}`);
  for (const tier of ['MTF', 'HTF'] as const) {
    const e = expected.tiers[tier]; const a = actual.tiers[tier];
    for (const k of ['trades', 'wins', 'totalR', 'digest'] as const) if (String(e[k]) !== String(a[k])) diffs.push(`${tier}.${k}: expected ${e[k]}, got ${a[k]}`);
  }
  return diffs;
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const days = Number(arg('days') ?? 730);
  const extras = Number(arg('extras') ?? 20);
  const check = arg('check');
  const pinned = check ? (JSON.parse(readFileSync(check, 'utf8')) as BaselineFixture) : null;
  // A check replays the fixture's own window and universe; a fresh run ends where the holdout starts.
  const w = researchWindow(days);
  const to = pinned ? Date.parse(pinned.window.to) : arg('to') ? Date.parse(arg('to')!) : w.to;
  const from = pinned ? Date.parse(pinned.window.from) : arg('from') ? Date.parse(arg('from')!) : to - days * DAY;
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  let symbols = arg('symbols')?.split(',').map((s) => s.trim()).filter(Boolean);
  if (symbols) symbols = [...new Set([...CORE_SYMBOLS, ...symbols])];
  else symbols = selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: 10_000_000, maxExtraSymbols: extras }, await apiTradable(client));
  if (pinned) symbols = pinned.symbols; // the same universe as the fixture
  log(`symbols: ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from, to, log });
  const fillRealism = process.argv.includes('--fill-realism') || (pinned as { fillRealism?: boolean } | null)?.fillRealism === true;
  const fixture = baselineFixture(data, { ...defaultConfig(from, to), fillRealism }, symbols);
  const text = JSON.stringify(fixture, null, 2);
  console.log(text);
  const write = arg('write');
  if (write) { writeFileSync(write, `${text}\n`); log(`wrote ${write}`); }
  if (pinned) {
    const diffs = compareFixtures(pinned, fixture);
    if (diffs.length) { console.error(`BASELINE CHANGED:\n  ${diffs.join('\n  ')}`); process.exit(1); }
    log('baseline unchanged');
  }
}

if (process.argv[1]?.endsWith('baseline.ts')) main().catch((e) => { console.error(e); process.exit(1); });
