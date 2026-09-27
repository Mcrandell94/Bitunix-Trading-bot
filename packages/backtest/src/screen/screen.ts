// Signal screen (owner, 2026-09-27: "remove the indicators that are failing
// us and find things that backtest positive; no ~50% win-rate models").
//
// Every signal in signals.ts, on 15m / 1H / 4H / daily, with three exit
// profiles, as-is and faded, through the real engine (market entry at the
// next 15m open, taker fees, slippage, funding, the 0.667% cost veto).
//
// A candidate passes only if, on the discovery window (first 24 of the 36
// research months) AND again on the confirmation window (last 12):
//   - net expectancy > 0 after costs,
//   - win rate >= --min-win (default 60%),
//   - it beats the same entries with a random direction (500 draws; 99th
//     percentile on discovery since ~400 candidates are screened, 90th on
//     confirmation),
//   - enough trades (100 discovery, 30 confirmation), and positive in at
//     least 5 of 8 discovery quarters.
// The random-direction test matters most here: a high win rate is easy to
// get from exits alone (a target closer than the stop), and only beating
// random direction shows the signal adds anything. The 6-month holdout is
// never loaded.
//
//   npm run -s screen -- --months 36 --extras 60 --min-volume 3000000 --min-win 0.6

import { writeFileSync } from 'node:fs';
import { intervalMs } from '@bot/marketdata';
import type { Side } from '@bot/risk';
import { researchWindow } from '../baseline';
import { runBacktest, type CandidateOverride } from '../engine';
import { atrWilder } from '../indicators';
import { appendRunLog, gitHash, profitFactor, type RunLogRow } from '../runlog';
import type { ScoreConfig } from '../score/config';
import { defaultConfig, type BacktestConfig, type SymbolData, type Tf } from '../types';
import { addMonths } from '../walkforward';
import { contextFor, SIGNALS, type SignalDef } from './signals';

export interface ExitProfile {
  id: string; what: string; stopAtr: number; targetAtr: number; maxBars: number;
  /** ATR trailing stop (owner's ATR layer): once `activateAtr` ATR in profit, trail `mult` x ATR(14) behind the best price, on the signal's timeframe closes. */
  trail?: { activateAtr: number; mult: number };
  /** Hybrid exit: take `fraction` of the position at `atAtr` ATR, then move the stop to entry (the rest rides the trail or the cap). */
  partial?: { atAtr: number; fraction: number };
}

export const EXITS: ExitProfile[] = [
  { id: 'hiwin', what: 'stop 2 ATR, target 1 ATR (0.5R), out after 24 bars', stopAtr: 2, targetAtr: 1, maxBars: 24 },
  { id: 'even', what: 'stop 1.5 ATR, target 1.5 ATR (1R), out after 24 bars', stopAtr: 1.5, targetAtr: 1.5, maxBars: 24 },
  { id: 'trend', what: 'stop 1.5 ATR, target 4.5 ATR (3R), out after 72 bars', stopAtr: 1.5, targetAtr: 4.5, maxBars: 72 },
];

/** The ATR trailing exits (owner's ATR layer), screened on request (--exits). */
export const TRAIL_EXITS: ExitProfile[] = [
  { id: 'hiwin_trail', what: 'stop 2 ATR; from +1 ATR trail 1.5 ATR behind the best price; cap 6 ATR; out after 72 bars', stopAtr: 2, targetAtr: 6, maxBars: 72, trail: { activateAtr: 1, mult: 1.5 } },
  { id: 'trail', what: 'stop 1.5 ATR; from +1.5 ATR (1R) trail 1.5 ATR behind the best price; cap 6 ATR; out after 72 bars', stopAtr: 1.5, targetAtr: 6, maxBars: 72, trail: { activateAtr: 1.5, mult: 1.5 } },
];

/**
 * Owner's R-raising tests (2026-09-27), one change at a time against `hiwin`
 * (2 ATR stop, 1 ATR target, 24 bars): wider targets, a hybrid exit, shorter
 * time stops.
 */
export const R_EXITS: ExitProfile[] = [
  { id: 's2t15', what: 'stop 2 ATR, target 1.5 ATR (0.75R), out after 24 bars', stopAtr: 2, targetAtr: 1.5, maxBars: 24 },
  { id: 's2t2', what: 'stop 2 ATR, target 2 ATR (1R), out after 24 bars', stopAtr: 2, targetAtr: 2, maxBars: 24 },
  { id: 's15t2', what: 'stop 1.5 ATR, target 2 ATR (1.33R), out after 24 bars', stopAtr: 1.5, targetAtr: 2, maxBars: 24 },
  { id: 'hybrid', what: 'stop 2 ATR; 60% off at 1 ATR, stop to entry, rest trails 2.5 ATR behind the best price; cap 8 ATR; out after 72 bars', stopAtr: 2, targetAtr: 8, maxBars: 72, partial: { atAtr: 1, fraction: 0.6 }, trail: { activateAtr: 1, mult: 2.5 } },
  { id: 'hybrid15', what: 'stop 2 ATR; 50% off at 1.5 ATR, stop to entry, rest trails 3 ATR behind the best price; cap 8 ATR; out after 72 bars', stopAtr: 2, targetAtr: 8, maxBars: 72, partial: { atAtr: 1.5, fraction: 0.5 }, trail: { activateAtr: 1.5, mult: 3 } },
  { id: 'hiwin_t12', what: 'stop 2 ATR, target 1 ATR, out after 12 bars', stopAtr: 2, targetAtr: 1, maxBars: 12 },
  { id: 'hiwin_t16', what: 'stop 2 ATR, target 1 ATR, out after 16 bars', stopAtr: 2, targetAtr: 1, maxBars: 16 },
];

export const ALL_EXITS: ExitProfile[] = [...EXITS, ...TRAIL_EXITS, ...R_EXITS];

export const SCREEN_TFS: Tf[] = ['15m', '1h', '4h', '1d'];

/** One slot (MTF) on the signal's timeframe, market entries, fixed bracket, time exit; nothing else in the way. */
export function screenConfig(base: BacktestConfig, tf: Tf, exit: ExitProfile): BacktestConfig {
  return {
    ...base,
    minStopPct: 0.10 / 0.15, // the cost veto
    portfolio: null,
    risk: {
      ...base.risk, fundingGapMinutes: 0, coreExposureCap: 1e9, maxPositionsPerSymbolTier: 1,
      tiers: { ...base.risk.tiers, MTF: { ...base.risk.tiers.MTF, riskPct: 1, dailyLossPct: 1e9, maxEffectiveLeverage: 1e9, killzones: null } },
    },
    tiers: {
      LTF: { ...base.tiers.LTF, enabled: false },
      HTF: { ...base.tiers.HTF, enabled: false },
      MTF: {
        ...base.tiers.MTF, enabled: true, entryTf: tf, rrgTfs: [], expiryBars: 2, rewardR: 100,
        partials: exit.partial ? [{ atR: exit.partial.atAtr / exit.stopAtr, fraction: exit.partial.fraction }] : [],
        breakevenAtR: exit.partial ? exit.partial.atAtr / exit.stopAtr : null,
        trailTf: null,
        timeStop: { barTf: tf, checkBars: exit.maxBars, minMfeR: -1e9, maxBars: exit.maxBars },
        ...(exit.trail ? { chandelier: { activateR: exit.trail.activateAtr / exit.stopAtr, atrTf: tf, atrLen: 14, mult: exit.trail.mult } } : {}),
      },
    },
  };
}

/** Per coin: signal events and ATR on the timeframe, indexed by bar close time. */
export interface Events { at: Map<number, number>; sig: Int8Array; close: number[]; atr: (number | null)[] }

export function eventsFor(all: Readonly<Record<string, SymbolData>>, symbols: string[], tf: Tf, def: SignalDef, score: ScoreConfig): Map<string, Events> {
  const out = new Map<string, Events>();
  const iv = intervalMs(tf);
  for (const s of symbols) {
    const ctx = contextFor(all, s, tf, score);
    if (!ctx) continue;
    const sig = def.build(ctx);
    out.set(s, { at: new Map(ctx.candles.map((c, i) => [c.openTime + iv, i])), sig, close: ctx.candles.map((c) => c.close), atr: atrWilder(ctx.candles, 14) });
  }
  return out;
}

/** Market entries on the events; `fade` trades the other way. Tag = the signal bar's close. */
/**
 * Entry timing (owner's Asia-session idea): instead of a market entry at the
 * next open, rest a limit `atr` daily ATRs better than the signal close for
 * `minutes`; unfilled = no trade. Stop and target keep their ATR distances
 * from the limit price.
 */
export interface EntryDip { atr: number; minutes: number }

export function eventOverride(events: Map<string, Events>, exit: ExitProfile, fade: boolean, dip: EntryDip | null = null): CandidateOverride {
  return ({ tier, symbol, time }) => {
    if (tier !== 'MTF') return null;
    const e = events.get(symbol);
    const i = e?.at.get(time);
    if (e == null || i == null) return null;
    const raw = e.sig[i]!;
    const a = e.atr[i];
    if (!raw || a == null || !(a > 0)) return null;
    const side: Side = (raw > 0) !== fade ? 'long' : 'short';
    const d = side === 'long' ? 1 : -1;
    const px = dip ? e.close[i]! - d * dip.atr * a : e.close[i]!;
    return {
      side, entry: px, stop: px - d * exit.stopAtr * a, takeProfit: px + d * exit.targetAtr * a, source: 'core', tag: time,
      ...(dip ? { market: false, expiresInMs: dip.minutes * 60_000 } : { market: true }),
    };
  };
}

export interface Lite { key: string; openedAt: number; side: Side; r: number }

export interface WindowStats {
  n: number; winRate: number | null; expectancyR: number | null; profitFactor: number | null; totalR: number;
  quartersPositive: number; quarters: number; longN: number; shortN: number;
  /** Where the real expectancy sits among random-direction draws of the same entries (0..1), and on how many paired entries. */
  nullPctile: number | null; paired: number;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function windowStats(trades: Lite[], other: Map<string, number>, [a, b]: [number, number], runs: number, seed = 5): WindowStats {
  const w = trades.filter((t) => t.openedAt >= a && t.openedAt < b);
  const n = w.length;
  const totalR = w.reduce((s, t) => s + t.r, 0);
  const quarters: number[] = [];
  for (let q = a; q < b; q = addMonths(q, 3)) {
    const end = Math.min(addMonths(q, 3), b);
    quarters.push(w.filter((t) => t.openedAt >= q && t.openedAt < end).reduce((s, t) => s + t.r, 0));
  }
  const pairs = w.flatMap((t) => { const o = other.get(t.key); return o == null ? [] : [[t.r, o] as const]; });
  let nullPctile: number | null = null;
  if (pairs.length >= 10) {
    const real = pairs.reduce((s, p) => s + p[0], 0);
    const rand = rng(seed);
    let below = 0;
    for (let k = 0; k < runs; k++) {
      let x = 0;
      for (const p of pairs) x += rand() < 0.5 ? p[0] : p[1];
      if (x < real) below++;
    }
    nullPctile = below / runs;
  }
  return {
    n, winRate: n ? w.filter((t) => t.r > 0).length / n : null, expectancyR: n ? totalR / n : null, profitFactor: profitFactor(w), totalR,
    quartersPositive: quarters.filter((x) => x > 0).length, quarters: quarters.length,
    longN: w.filter((t) => t.side === 'long').length, shortN: w.filter((t) => t.side === 'short').length,
    nullPctile, paired: pairs.length,
  };
}

export interface Gate { minWin: number; discovery: { minN: number; nullPctile: number; minQuarters: number }; confirmation: { minN: number; nullPctile: number } }

export const DEFAULT_GATE: Gate = { minWin: 0.6, discovery: { minN: 100, nullPctile: 0.99, minQuarters: 5 }, confirmation: { minN: 30, nullPctile: 0.9 } };

export function verdict(d: WindowStats, c: WindowStats, g: Gate): { pass: boolean; fails: string[] } {
  const fails: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (d.n < g.discovery.minN) fails.push(`discovery ${d.n} trades < ${g.discovery.minN}`);
  if (!((d.expectancyR ?? -1) > 0)) fails.push('discovery expectancy <= 0');
  if ((d.winRate ?? 0) < g.minWin) fails.push(`discovery win rate ${pct(d.winRate ?? 0)} < ${pct(g.minWin)}`);
  if ((d.nullPctile ?? 0) < g.discovery.nullPctile) fails.push(`discovery random-direction pctile ${pct(d.nullPctile ?? 0)} < ${pct(g.discovery.nullPctile)}`);
  if (d.quartersPositive < g.discovery.minQuarters) fails.push(`discovery ${d.quartersPositive}/${d.quarters} quarters positive`);
  if (c.n < g.confirmation.minN) fails.push(`confirmation ${c.n} trades < ${g.confirmation.minN}`);
  if (!((c.expectancyR ?? -1) > 0)) fails.push('confirmation expectancy <= 0');
  if ((c.winRate ?? 0) < g.minWin) fails.push(`confirmation win rate ${pct(c.winRate ?? 0)} < ${pct(g.minWin)}`);
  if ((c.nullPctile ?? 0) < g.confirmation.nullPctile) fails.push(`confirmation random-direction pctile ${pct(c.nullPctile ?? 0)} < ${pct(g.confirmation.nullPctile)}`);
  return { pass: fails.length === 0, fails };
}

export interface Candidate { signal: string; family: string; tf: Tf; exit: string; fade: boolean; discovery: WindowStats; confirmation: WindowStats; pass: boolean; fails: string[] }

const lite = (trades: ReturnType<typeof runBacktest>['trades']): Lite[] => trades.map((t) => ({ key: `${t.symbol}|${t.tag}`, openedAt: t.openedAt, side: t.side, r: t.r }));

/** Screen one signal on one timeframe with every exit, both directions. */
export function screenSignal(data: Readonly<Record<string, SymbolData>>, symbols: string[], def: SignalDef, tf: Tf, base: BacktestConfig, score: ScoreConfig, windows: { discovery: [number, number]; confirmation: [number, number] }, gate: Gate, runs: number, exits = EXITS): Candidate[] {
  const events = eventsFor(data, symbols, tf, def, score);
  const out: Candidate[] = [];
  for (const exit of exits) {
    const cfg = screenConfig(base, tf, exit);
    const asIs = lite(runBacktest(data, cfg, eventOverride(events, exit, false)).trades);
    const faded = lite(runBacktest(data, cfg, eventOverride(events, exit, true)).trades);
    const rOf = (xs: Lite[]) => new Map(xs.map((t) => [t.key, t.r]));
    for (const [fade, mine, other] of [[false, asIs, rOf(faded)], [true, faded, rOf(asIs)]] as const) {
      const d = windowStats(mine, other, windows.discovery, runs);
      const c = windowStats(mine, other, windows.confirmation, runs);
      const v = verdict(d, c, gate);
      out.push({ signal: def.id, family: def.family, tf, exit: exit.id, fade, discovery: d, confirmation: c, ...v });
    }
  }
  return out;
}

export function formatScreen(cands: Candidate[], gate: Gate, meta: { from: number; split: number; to: number; symbols: string[]; hash: string }): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const f = (x: number | null, d = 3) => (x == null ? '-' : x.toFixed(d));
  const p = (x: number | null) => (x == null ? '  -' : `${Math.round(x * 100)}%`.padStart(4));
  const name = (c: Candidate) => `${c.signal}${c.fade ? ' (faded)' : ''} ${c.tf} ${c.exit}`.padEnd(38);
  const w = (s: WindowStats) => `${String(s.n).padStart(5)} tr win ${p(s.winRate)} exp ${f(s.expectancyR).padStart(6)}R PF ${f(s.profitFactor, 2).padStart(4)} tot ${s.totalR.toFixed(0).padStart(5)}R null ${p(s.nullPctile)}`;
  const row = (c: Candidate) => `  ${name(c)} D: ${w(c.discovery)} q+ ${c.discovery.quartersPositive}/${c.discovery.quarters} | C: ${w(c.confirmation)}`;
  const pass = cands.filter((c) => c.pass);
  const hiWin = cands.filter((c) => (c.discovery.winRate ?? 0) >= gate.minWin && (c.discovery.expectancyR ?? -1) > 0).sort((a, b) => (b.discovery.expectancyR ?? 0) - (a.discovery.expectancyR ?? 0));
  const bestExp = [...cands].filter((c) => c.discovery.n >= gate.discovery.minN).sort((a, b) => (b.discovery.expectancyR ?? -9) - (a.discovery.expectancyR ?? -9)).slice(0, 20);
  const bestNull = [...cands].filter((c) => c.discovery.n >= gate.discovery.minN && (c.discovery.expectancyR ?? -1) > 0).sort((a, b) => (b.discovery.nullPctile ?? 0) - (a.discovery.nullPctile ?? 0)).slice(0, 20);
  // Per signal: does anything about it beat random direction with positive expectancy on BOTH windows?
  const present = SIGNALS.filter((s) => cands.some((c) => c.signal === s.id));
  const usedExits = ALL_EXITS.filter((e) => cands.some((c) => c.exit === e.id));
  const bySignal = present.map((s) => {
    const mine = cands.filter((c) => c.signal === s.id);
    const alive = mine.filter((c) => (c.discovery.expectancyR ?? -1) > 0 && (c.discovery.nullPctile ?? 0) >= 0.95 && (c.confirmation.expectancyR ?? -1) > 0 && (c.confirmation.nullPctile ?? 0) >= 0.8);
    return { s, n: mine.length, pass: mine.filter((c) => c.pass).length, alive };
  });
  return [
    `SIGNAL SCREEN  discovery ${iso(meta.from)} → ${iso(meta.split)}, confirmation ${iso(meta.split)} → ${iso(meta.to)} (holdout excluded), ${meta.symbols.length} coins`,
    `${present.length} signals x up to ${SCREEN_TFS.length} timeframes x ${usedExits.length} exits x as-is/faded = ${cands.length} candidates; config ${meta.hash}`,
    `Gate: win rate >= ${Math.round(gate.minWin * 100)}% and expectancy > 0 on both windows; beats random direction (discovery >= ${Math.round(gate.discovery.nullPctile * 100)}th pct, confirmation >= ${Math.round(gate.confirmation.nullPctile * 100)}th); >= ${gate.discovery.minN} / ${gate.confirmation.minN} trades; >= ${gate.discovery.minQuarters}/8 discovery quarters positive.`,
    `Exits: ${usedExits.map((e) => `${e.id} = ${e.what}`).join('; ')}. Market entry next 15m open, taker fees, 2 bps slippage, funding, cost veto (stop >= 0.667%).`,
    '',
    `PASSED (${pass.length})`,
    ...(pass.length ? pass.map(row) : ['  none']),
    '',
    `WIN RATE >= ${Math.round(gate.minWin * 100)}% WITH POSITIVE EXPECTANCY ON DISCOVERY (${hiWin.length}), best first`,
    ...hiWin.slice(0, 25).map((c) => `${row(c)}\n      fails: ${c.fails.join('; ') || '-'}`),
    '',
    'BEST DISCOVERY EXPECTANCY, ANY WIN RATE (top 20)',
    ...bestExp.map(row),
    '',
    'STRONGEST AGAINST RANDOM DIRECTION WITH POSITIVE EXPECTANCY (top 20)',
    ...bestNull.map(row),
    '',
    'PER SIGNAL (keep = some timeframe/exit beats random direction with positive expectancy on both windows; retire = nothing does)',
    ...bySignal.map((x) => `  ${x.alive.length ? 'KEEP  ' : 'RETIRE'} ${x.s.id.padEnd(20)} ${x.s.family.padEnd(15)} passed ${x.pass}/${x.n}${x.alive.length ? `; holds on: ${x.alive.map((c) => `${c.tf} ${c.exit}${c.fade ? ' faded' : ''}`).join(', ')}` : ''}  (${x.s.what})`),
    '',
    `Symbols: ${meta.symbols.join(', ')}`,
  ].join('\n');
}

export function screenRows(cands: Candidate[], hash: string, windows: { discovery: [number, number]; confirmation: [number, number] }): RunLogRow[] {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const stamp = new Date().toISOString();
  return cands.flatMap((c) => (['discovery', 'confirmation'] as const).map((name) => {
    const s = c[name];
    return {
      timestamp: stamp, gitHash: gitHash(), rulesHash: hash, rule: `screen ${c.signal}`, variant: `${c.tf} ${c.exit}${c.fade ? ' faded' : ''}`, tier: 'SCREEN',
      window: { name, from: iso(windows[name][0]), to: iso(windows[name][1]) },
      n: s.n, expectancyR: s.expectancyR, profitFactor: s.profitFactor, totalR: s.totalR, winRate: s.winRate,
      nullPctile: s.nullPctile, randomFilterPctile: null, verdict: c.pass ? 'holds' : 'fails',
    } satisfies RunLogRow;
  }));
}

export interface ScreenFile { windows: { discovery: [number, number]; confirmation: [number, number] }; gate: Gate; meta: { from: number; split: number; to: number; symbols: string[]; hash: string }; cands: Candidate[] }

/**
 * Modes (the Signal screen workflow runs one job per signal in parallel):
 *   --list [--signals a,b]        print the signal ids as JSON
 *   --prepare                     pick the universe, load (and cache) the data, write screen-symbols.txt
 *   [--symbols-file f] [--signals a,b] [--out f] [--shard]
 *                                 screen those signals; --shard writes only the JSON
 *   --merge <dir>                 merge every shard JSON in dir into one report
 */
async function main() {
  const { readdirSync, readFileSync } = await import('node:fs');
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const only = arg('signals')?.split(',').map((x) => x.trim()).filter(Boolean);
  const chosen = SIGNALS.filter((s) => !only?.length || only.includes(s.id));
  if (flag('list')) { console.log(JSON.stringify(chosen.map((s) => s.id))); return; }

  const merge = arg('merge');
  if (merge) {
    const files = readdirSync(merge, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
    const parts = files.map((f) => JSON.parse(readFileSync(`${merge}/${f}`, 'utf8')) as ScreenFile);
    if (!parts.length) throw new Error(`no shard results in ${merge}`);
    const syms = JSON.stringify(parts[0]!.meta.symbols);
    if (parts.some((p) => JSON.stringify(p.meta.symbols) !== syms)) throw new Error('shards ran on different coin lists');
    const cands = parts.flatMap((p) => p.cands);
    const { windows, gate, meta } = parts[0]!;
    const report = formatScreen(cands, gate, meta);
    writeFileSync('screen-report.txt', report);
    writeFileSync('screen-results.json', JSON.stringify({ windows, gate, meta, cands } satisfies ScreenFile, null, 2));
    appendRunLog(screenRows(cands, meta.hash, windows));
    console.log(report);
    return;
  }

  const { createClient, fetchTickers } = await import('@bot/bitunix');
  const { apiTradable, selectUniverse } = await import('@bot/worker');
  const { loadMarket } = await import('../load');
  const { loadScoreConfig } = await import('../score/config');
  const months = Number(arg('months') ?? 36);
  const extras = Number(arg('extras') ?? 60);
  const minVolume = Number(arg('min-volume') ?? 3_000_000);
  const runs = Number(arg('runs') ?? 500);
  const gate: Gate = { ...DEFAULT_GATE, minWin: Number(arg('min-win') ?? DEFAULT_GATE.minWin) };
  const tfs = (arg('tfs')?.split(',') ?? SCREEN_TFS) as Tf[];
  const exitIds = arg('exits')?.split(',').map((x) => x.trim()).filter(Boolean);
  const exits = exitIds?.length ? ALL_EXITS.filter((e) => exitIds.includes(e.id)) : EXITS;
  if (exitIds?.length && exits.length !== exitIds.length) throw new Error(`unknown exit in ${exitIds.join(',')} (known: ${ALL_EXITS.map((e) => e.id).join(', ')})`);
  const holdout = researchWindow(0).to;
  const from = addMonths(holdout, -months);
  const split = addMonths(from, 24);
  const windows = { discovery: [from, split] as [number, number], confirmation: [split, holdout] as [number, number] };
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const file = arg('symbols-file');
  const symbols = file
    ? readFileSync(file, 'utf8').split(/[\s,]+/).filter(Boolean)
    : selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: minVolume, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols (${symbols.length}): ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, -3), to: holdout, log });
  if (flag('prepare')) { writeFileSync('screen-symbols.txt', symbols.join('\n')); return; }
  const { config: score, hash } = loadScoreConfig();
  const base = defaultConfig(from, holdout);
  const started = Date.now();
  const cands: Candidate[] = [];
  for (const def of chosen) {
    for (const tf of tfs.filter((t) => !def.tfs || def.tfs.includes(t))) {
      const got = screenSignal(data, symbols, def, tf, base, score, windows, gate, runs, exits);
      cands.push(...got);
      const best = [...got].sort((a, b) => (b.discovery.expectancyR ?? -9) - (a.discovery.expectancyR ?? -9))[0];
      log(`${((Date.now() - started) / 60_000).toFixed(1)}m ${def.id} ${tf}: best ${best ? `${best.exit}${best.fade ? ' faded' : ''} exp ${best.discovery.expectancyR?.toFixed(3)} win ${((best.discovery.winRate ?? 0) * 100).toFixed(0)}% n ${best.discovery.n}` : '-'}; passed ${got.filter((c) => c.pass).length}`);
    }
  }
  const meta = { from, split, to: holdout, symbols, hash };
  const out: ScreenFile = { windows, gate, meta, cands };
  writeFileSync(arg('out') ?? 'screen-results.json', JSON.stringify(out, null, 2));
  if (flag('shard')) return;
  const report = formatScreen(cands, gate, meta);
  writeFileSync('screen-report.txt', report);
  appendRunLog(screenRows(cands, hash, windows));
  console.log(report);
}

if (process.argv[1]?.endsWith('screen.ts')) main().catch((e) => { console.error(e); process.exit(1); });
