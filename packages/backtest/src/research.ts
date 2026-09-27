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
import { SESSION_KILLZONES, type Tier } from '@bot/risk';
import { CORE_SYMBOLS } from '@bot/signals';
import { apiTradable, selectUniverse } from '@bot/worker';
import { attribution, formatAttribution, type Bucket } from './attribution';
import { runBacktest } from './engine';
import { loadMarket } from './load';
import { maxDrawdown, stats } from './metrics';
import { enabledRules, loadRules } from './rules';
import { appendRunLog, gitHash, profitFactor, type RunLogRow } from './runlog';
import { DEFAULT_MOMENTUM, DEFAULT_TREND, defaultConfig, type BacktestConfig, type MomentumConfig, type SymbolData, type TierPlan, type TrendConfig } from './types';

const DAY = 86_400_000;
const MIN_TRADES = 25;
/** Win-rate gain (percentage points) a change needs on each window to hold. */
const MIN_WIN_GAIN = 1;

type Patch = (c: BacktestConfig) => BacktestConfig;
export interface Candidate { label: string; why: string; patch: Patch }

const setup = (over: Partial<BacktestConfig['setup']>): Patch => (c) => ({ ...c, setup: { ...c.setup, ...over } });
const tier = (t: Tier, over: Partial<TierPlan>): Patch => (c) =>
  ({ ...c, tiers: { ...c.tiers, [t]: { ...c.tiers[t], ...over } } });
const filters = (over: Partial<BacktestConfig['filters']>): Patch => (c) => ({ ...c, filters: { ...c.filters, ...over } });
const structure = (n: number): Patch => (c) => ({ ...c, structure: { ...c.structure, swingLeft: n, swingRight: n } });

export const CANDIDATES: Candidate[] = [
  // Win-rate round 3 (2026-09-27): structure size and location filters.
  { label: 'swings 3 bars each side', why: '2-bar swings make sweeps and structure breaks fire on noise', patch: structure(3) },
  { label: 'swings 5 bars each side', why: 'only meaningful liquidity and structure', patch: structure(5) },
  { label: 'sweep inside a higher-TF zone', why: 'ICT: the sweep must happen at a 4H/daily FVG or order block', patch: filters({ htfZone: 'higher' }) },
  { label: 'sweep inside a lower-bias-TF zone', why: 'same, on the 1H/4H zone', patch: filters({ htfZone: 'lower' }) },
  { label: 'volatility regime 30-90th pct', why: 'skip dead chop and blow-off volatility', patch: filters({ atrRegime: { lookback: 200, minPct: 30, maxPct: 90 } }) },
  { label: 'volatility regime 20-80th pct', why: 'tighter regime band', patch: filters({ atrRegime: { lookback: 200, minPct: 20, maxPct: 80 } }) },
  { label: 'displacement volume >= 1.5x', why: 'real intent behind the displacement candle', patch: setup({ displacementVolumeMult: 1.5 }) },
  { label: 'higher-TF EMA50 trend', why: 'price on the right side of a rising/falling EMA on the higher bias TF', patch: filters({ emaTrend: 50 }) },
  { label: 'BTC gate for alts', why: 'no alt trade against BTC\'s own bias', patch: filters({ btcGate: true }) },
  { label: 'FOMC blackout 60 min', why: 'no entries around the Fed statement', patch: filters({ fomcBlackoutMinutes: 60 }) },
  { label: 'location combo: swings 3 + HTF zone + volatility 30-90', why: 'the three structural filters together', patch: (c) => filters({ htfZone: 'higher', atrRegime: { lookback: 200, minPct: 30, maxPct: 90 } })(structure(3)(c)) },
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
  { label: 'min stop distance 1%', why: '0.5% is the default since 2026-09-27; is stricter better?', patch: (c) => ({ ...c, minStopPct: 1 }) },
  { label: 'LTF: half off at 1R, stop to entry', why: 'bank part of LTF trades early', patch: tier('LTF', { partials: [{ atR: 1, fraction: 0.5 }], breakevenAtR: 1 }) },
  { label: 'MTF: first third off at 0.75R', why: 'bank the first partial sooner', patch: tier('MTF', { partials: [{ atR: 0.75, fraction: 1 / 3 }, { atR: 2, fraction: 1 / 3 }] }) },
  // Combinations of the near-misses from the first run (2026-09-26, 365 days, 13 coins).
  {
    label: 'combo A: both-TF bias + FVG only + min stop 0.5%',
    why: 'the three near-misses that never cost R on either window',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.5, setup: { ...c.setup, allowIfvg: false } }),
  },
  {
    label: 'combo B: combo A + stop buffer 0.25 ATR',
    why: 'plus the extra stop room (win rate up on both windows, -0.4R on train)',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.5, setup: { ...c.setup, allowIfvg: false, stopBufferAtr: 0.25 } }),
  },
  // The four that held up on both windows of the 2-year run (2026-09-26), together.
  {
    label: 'robust four: both-TF bias + stop 0.25 ATR + far-edge entry + min stop 0.5%',
    why: 'each helped on both windows of the 2-year run; do they add up?',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.5, setup: { ...c.setup, stopBufferAtr: 0.25, entryFraction: 0 } }),
  },
  {
    label: 'robust three: both-TF bias + stop 0.25 ATR + min stop 0.5%',
    why: 'the same without the far-edge entry (fewer fills)',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.5, setup: { ...c.setup, stopBufferAtr: 0.25 } }),
  },
  // Reading RRG earlier (owner: RRG lags; catch strength forming before it leaves Lagging or as it enters Improving).
  {
    label: 'RRG early reads (turn in Lagging, fresh Improving, early rollover)',
    why: 'projected tail path: act on strength forming, not on the late quadrant change',
    patch: (c) => ({ ...c, rrg: { ...c.rrg, earlySignals: true } }),
  },
  {
    label: 'RRG early reads, 5-bar projection',
    why: 'same, looking further ahead',
    patch: (c) => ({ ...c, rrg: { ...c.rrg, earlySignals: true, projectionBars: 5 } }),
  },
  {
    label: 'RRG early reads + combo A',
    why: 'the early reads on top of the three safest filters',
    patch: (c) => ({ ...c, biasCombine: 'both', minStopPct: 0.5, setup: { ...c.setup, allowIfvg: false }, rrg: { ...c.rrg, earlySignals: true } }),
  },
  { label: 'LTF only alongside an open MTF position', why: 'info: the earlier rule, now dropped (tiers trade independently)', patch: (c) => ({ ...c, risk: { ...c.risk, ltfRequiresMtf: true } }) },
  { label: 'LTF only in killzones (London, NY AM, Asia)', why: 'info: the windows you dropped; do they win more?', patch: (c) => ({ ...c, risk: { ...c.risk, tiers: { ...c.risk.tiers, LTF: { ...c.risk.tiers.LTF, killzones: SESSION_KILLZONES } } } }) },
];

/** LTF on its own (MTF switched off): what makes the 15m tier profitable without MTF? */
const ltf = (over: Partial<TierPlan>): Patch => tier('LTF', over);
const ltfRisk = (over: Partial<BacktestConfig['risk']['tiers']['LTF']>): Patch => (c) =>
  ({ ...c, risk: { ...c.risk, tiers: { ...c.risk.tiers, LTF: { ...c.risk.tiers.LTF, ...over } } } });
const LARGE = ['BTC', 'ETH', 'XRP', 'SOL', 'SUI', 'BNB', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'LTC', 'BCH', 'TON'].map((c) => `${c}USDT`);
// Momentum variants stay in the LTF list only: that's where the owner's
// proposed models get compared against the SMC setups. The bot itself is
// the SMC strategy (sweep / MSS / FVG with higher-timeframe bias) on
// every tier; nothing joins a tier without holding on both research windows.
const momentum = (over: Partial<MomentumConfig>): Patch => ltf({ model: 'momentum', momentum: { ...DEFAULT_MOMENTUM, ...over } });
const trend = (over: Partial<TrendConfig>, tierOver: Partial<TierPlan> = {}): Patch => ltf({ model: 'trend', trend: { ...DEFAULT_TREND, ...over }, ...tierOver });
export const LTF_CANDIDATES: Candidate[] = [
  // Owner's momentum model (SoftKill "EMA STOCH"), tested 2026-09-27 (run 36282889652): nothing profitable; one line kept for the record.
  { label: 'EMA STOCH as written: TP 10% / SL 10%, reversals', why: 'the Pine script as given (verdict recorded: no edge)', patch: momentum({}) },
  // Owner's proposal #2 (2026-09-27): EMA 9/21 + Supertrend 10/3 + RSI 12 + volume 1.5x + 1.2 ATR stop, 2R.
  { label: 'TREND as proposed: EMA 9/21, Supertrend, RSI cross 50 or out of oversold, vol 1.5x, 1.2 ATR stop, 2R', why: 'the model as described', patch: trend({}) },
  { label: 'TREND + 1H bias', why: 'the optional filter: 1H bias must agree', patch: (c) => ({ ...trend({ useBias: true }, { biasTfs: ['1h', '15m'] })(c), biasCombine: 'higher' }) },
  { label: 'TREND + 4H/1H bias', why: 'our usual LTF bias on top', patch: trend({ useBias: true }) },
  { label: 'TREND + 4H/1H bias + RRG', why: 'both of our gates on top', patch: trend({ useBias: true, useRrg: true }) },
  { label: 'TREND, RSI cross 50 only', why: 'momentum continuation entries only', patch: trend({ rsiTrigger: 'cross50' }) },
  { label: 'TREND, RSI out of oversold only', why: 'pullback entries only', patch: trend({ rsiTrigger: 'oversold' }) },
  { label: 'TREND, stop 1.0 ATR', why: 'tighter stop', patch: trend({ stopAtr: 1 }) },
  { label: 'TREND, stop 1.5 ATR', why: 'wider stop', patch: trend({ stopAtr: 1.5 }) },
  { label: 'TREND, target 1.5R', why: 'closer target', patch: trend({ rewardR: 1.5 }) },
  { label: 'TREND, target 3R', why: 'further target', patch: trend({ rewardR: 3 }) },
  { label: 'TREND, no Supertrend exit', why: 'hold to the target or stop', patch: trend({ exitOnFlip: false }) },
  { label: 'TREND + session VWAP filter', why: 'price on the right side of the day VWAP', patch: trend({ vwap: true }) },
  { label: 'TREND + MACD 8/21/5 agrees', why: 'histogram must agree', patch: trend({ macd: [8, 21, 5] }) },
  { label: 'TREND, no volume filter', why: 'is the volume spike helping?', patch: trend({ volumeMult: 0 }) },
  { label: 'TREND, volume 2x', why: 'stronger volume confirmation', patch: trend({ volumeMult: 2 }) },
  { label: 'TREND, EMA 12/26, RSI 9', why: 'the other settings named', patch: trend({ fastEma: 12, slowEma: 26, rsiPeriod: 9 }) },
  { label: 'TREND, no Supertrend', why: 'EMAs and RSI only', patch: trend({ supertrend: null }) },
  { label: 'TREND, large caps only', why: 'liquid majors', patch: trend({}, { symbols: LARGE }) },
  { label: 'MEANREV: Bollinger re-entry + RSI out of oversold, 1.2 ATR stop, 2R', why: 'the mean-reversion side of the proposal', patch: trend({ mode: 'meanrev', rsiTrigger: 'oversold', supertrend: null, exitOnFlip: false }) },
  { label: 'MEANREV + 4H/1H bias', why: 'fade only with the bigger trend', patch: trend({ mode: 'meanrev', rsiTrigger: 'oversold', supertrend: null, exitOnFlip: false, useBias: true }) },
  { label: 'MEANREV, target 1R', why: 'quick snap-back target', patch: trend({ mode: 'meanrev', rsiTrigger: 'oversold', supertrend: null, exitOnFlip: false, rewardR: 1 }) },
  { label: 'LTF bias from Daily/4H', why: 'trade 15m setups only with the bigger trend', patch: ltf({ biasTfs: ['1d', '4h'] }) },
  { label: 'LTF bias from 1H/15m', why: 'faster bias, more trades', patch: ltf({ biasTfs: ['1h', '15m'] }) },
  { label: 'LTF target 1.5R', why: 'closer target: more wins, smaller ones', patch: ltf({ rewardR: 1.5 }) },
  { label: 'LTF target 3R', why: 'let winners run further', patch: ltf({ rewardR: 3 }) },
  { label: 'LTF half at 1R, stop to entry, 3R target', why: 'bank half early, give the rest room', patch: ltf({ partials: [{ atR: 1, fraction: 0.5 }], breakevenAtR: 1, rewardR: 3 }) },
  { label: 'LTF half at 1R, stop to entry, trail on 1H', why: 'bank half, trail the rest on 1H swings', patch: ltf({ partials: [{ atR: 1, fraction: 0.5 }], breakevenAtR: 1, rewardR: 4, trailTf: '1h' }) },
  { label: 'LTF in killzones only', why: 'London / NY AM / Asia sessions only', patch: ltfRisk({ killzones: SESSION_KILLZONES }) },
  { label: 'min stop distance 1%', why: '0.5% is the default; is stricter better on 15m?', patch: (c) => ({ ...c, minStopPct: 1 }) },
  { label: 'stop buffer 0.25 ATR', why: 'more room beyond the sweep wick', patch: setup({ stopBufferAtr: 0.25 }) },
  { label: 'displacement >= 1.2 ATR', why: 'stronger displacement only', patch: setup({ displacementAtr: 1.2 }) },
  { label: 'bias: both timeframes agree', why: 'lower bias timeframe must confirm', patch: (c) => ({ ...c, biasCombine: 'both' }) },
  { label: 'FVG only (no iFVG)', why: 'skip inverted-gap entries', patch: setup({ allowIfvg: false }) },
  { label: 'LTF entries expire after 4 bars', why: 'only fresh fills', patch: ltf({ expiryBars: 4 }) },
  { label: 'LTF entries expire after 16 bars', why: 'give the limit longer to fill', patch: ltf({ expiryBars: 16 }) },
  { label: 'LTF rotation from 4H and 1H', why: 'stronger rotation read for extras', patch: ltf({ rrgTfs: ['4h', '1h'] }) },
  { label: 'RRG early reads', why: 'catch rotation before the quadrant change', patch: (c) => ({ ...c, rrg: { ...c.rrg, earlySignals: true } }) },
  { label: 'LTF only BTC/ETH/XRP', why: 'deepest markets only', patch: ltf({ symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'] }) },
  { label: 'LTF only large caps', why: 'liquid majors only', patch: ltf({ symbols: LARGE }) },
];

/**
 * HTF on its own (LTF and MTF off), 2026-09-27: the 4H tier was added
 * untested, so this is its first pass. Same objective as LTF mode: profit.
 * SMC setups only (owner: the bot is the built-up, backtested strategy).
 */
const htf = (over: Partial<TierPlan>): Patch => tier('HTF', over);
export const HTF_CANDIDATES: Candidate[] = [
  // Bias.
  { label: 'HTF bias: daily only', why: 'no 4H veto: the daily read decides', patch: (c) => ({ ...c, biasCombine: 'higher' }) },
  { label: 'HTF bias: daily and 4H agree', why: 'the 4H must confirm, not just not object', patch: (c) => ({ ...c, biasCombine: 'both' }) },
  { label: 'HTF bias from 4H/1H', why: 'faster bias for 4H setups', patch: htf({ biasTfs: ['4h', '1h'] }) },
  { label: 'higher-TF EMA50 trend', why: 'daily price on the right side of a rising/falling EMA50', patch: filters({ emaTrend: 50 }) },
  { label: 'sweep inside a daily zone', why: 'the 4H sweep must land in an unmitigated daily FVG or order block', patch: filters({ htfZone: 'higher' }) },
  { label: 'BTC gate for alts', why: 'no alt trade against BTC\'s own 4H bias', patch: filters({ btcGate: true }) },
  { label: 'volatility regime 30-90th pct', why: 'skip dead chop and blow-off volatility (4H ATR)', patch: filters({ atrRegime: { lookback: 200, minPct: 30, maxPct: 90 } }) },
  // Entry.
  { label: 'HTF entries expire after 3 bars', why: 'only fresh fills (12h)', patch: htf({ expiryBars: 3 }) },
  { label: 'HTF entries expire after 12 bars', why: 'two days for the limit to fill', patch: htf({ expiryBars: 12 }) },
  { label: 'entry at the gap\'s far edge', why: 'deepest price in the gap', patch: setup({ entryFraction: 0 }) },
  { label: 'swings 3 bars each side', why: 'bigger 4H swings only', patch: structure(3) },
  { label: 'displacement >= 1.2 ATR', why: 'stronger displacement only', patch: setup({ displacementAtr: 1.2 }) },
  { label: 'FVG only (no iFVG)', why: 'skip inverted-gap entries', patch: setup({ allowIfvg: false }) },
  { label: 'stop buffer 0.25 ATR', why: 'more room beyond the sweep wick', patch: setup({ stopBufferAtr: 0.25 }) },
  { label: 'stop buffer 0.5 ATR', why: 'even more room', patch: setup({ stopBufferAtr: 0.5 }) },
  { label: 'min stop distance 1%', why: 'stricter', patch: (c) => ({ ...c, minStopPct: 1 }) },
  // Exits.
  { label: 'HTF target 3R, no trail', why: 'fixed target, partials kept', patch: htf({ rewardR: 3, trailTf: null }) },
  { label: 'HTF target 8R cap', why: 'let the trailed runner go further', patch: htf({ rewardR: 8 }) },
  { label: 'HTF no partials, trail from 1R', why: 'full size on the runner; stop to entry at 1R', patch: htf({ partials: [{ atR: 1, fraction: 0.01 }], breakevenAtR: 1 }) },
  { label: 'HTF half at 1R, stop to entry, trail daily', why: 'bank half early', patch: htf({ partials: [{ atR: 1, fraction: 0.5 }], breakevenAtR: 1 }) },
  { label: 'HTF partials at 1.5R and 3R', why: 'later partials', patch: htf({ partials: [{ atR: 1.5, fraction: 1 / 3 }, { atR: 3, fraction: 1 / 3 }] }) },
  { label: 'HTF trail on 4H swings', why: 'tighter trail than daily', patch: htf({ trailTf: '4h' }) },
  // Universe and RRG.
  { label: 'HTF rotation from 4H and daily', why: 'more RRG signals for extras', patch: htf({ rrgTfs: ['4h', '1d'] }) },
  { label: 'RRG as a guide only (extras trade on bias)', why: 'RRG picks the universe, bias decides', patch: (c) => ({ ...c, extrasRrg: 'guide' }) },
  { label: 'RRG veto only for extras', why: 'extras trade on bias unless RRG points the other way', patch: (c) => ({ ...c, extrasRrg: 'veto' }) },
  { label: 'RRG early reads', why: 'catch rotation before the quadrant change', patch: (c) => ({ ...c, rrg: { ...c.rrg, earlySignals: true } }) },
  { label: 'HTF only BTC/ETH/XRP', why: 'deepest markets only', patch: htf({ symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'] }) },
  { label: 'HTF only large caps', why: 'liquid majors only', patch: htf({ symbols: LARGE }) },
  // Round 2 (run 36283794063): 3 trades with stops under 0.3% lost 69R of the baseline's 51R; the holders were
  // min stop 0.5%, FVG only, displacement 1.2 ATR, bias 4H/1H, swings 3. Do they add up?
  { label: 'HTF combo: min stop 0.5% + FVG only', why: 'the two cleanest holders', patch: (c) => setup({ allowIfvg: false })({ ...c, minStopPct: 0.5 }) },
  { label: 'HTF combo: min stop 0.5% + FVG only + displacement 1.2', why: 'plus stronger displacement', patch: (c) => setup({ allowIfvg: false, displacementAtr: 1.2 })({ ...c, minStopPct: 0.5 }) },
  { label: 'HTF combo: min stop 0.5% + FVG only + bias 4H/1H', why: 'plus the faster bias', patch: (c) => htf({ biasTfs: ['4h', '1h'] })(setup({ allowIfvg: false })({ ...c, minStopPct: 0.5 })) },
  { label: 'HTF combo: min stop 0.5% + FVG only + swings 3', why: 'plus bigger swings', patch: (c) => structure(3)(setup({ allowIfvg: false })({ ...c, minStopPct: 0.5 })) },
  { label: 'HTF combo: all five holders', why: 'min stop 0.5% + FVG only + displacement 1.2 + bias 4H/1H + swings 3', patch: (c) => htf({ biasTfs: ['4h', '1h'] })(structure(3)(setup({ allowIfvg: false, displacementAtr: 1.2 })({ ...c, minStopPct: 0.5 }))) },
  { label: 'HTF combo: min stop 1% + FVG only + displacement 1.2', why: 'stricter stop floor (train +18R on its own)', patch: (c) => setup({ allowIfvg: false, displacementAtr: 1.2 })({ ...c, minStopPct: 1 }) },
];

export interface Row { trades: number; winRate: number; avgR: number; totalR: number; returnPct: number; maxDrawdownPct: number; profitFactor: number | null }

export interface ResearchResult {
  mode: ResearchMode;
  attribution: Record<string, Bucket[]>;
  windows: { train: [number, number]; test: [number, number] };
  baseline: { train: Row; test: Row };
  candidates: { label: string; why: string; train: Row; test: Row; holds: boolean }[];
  combined: { labels: string[]; train: Row; test: Row } | null;
}

export type ResearchMode = 'all' | 'ltf' | 'htf';
/** Solo modes: one tier on, the others off, judged on profit. */
const SOLO: Record<'ltf' | 'htf', { tier: Tier; list: Candidate[]; minTrades: number }> = {
  ltf: { tier: 'LTF', list: LTF_CANDIDATES, minTrades: 25 },
  htf: { tier: 'HTF', list: HTF_CANDIDATES, minTrades: 15 },
};
/** A candidate must add at least this much total R on each window (profit mode). */
const MIN_R_GAIN = 1;

/**
 * mode 'all': the whole strategy, judged on win rate (total R must not drop).
 * mode 'ltf' / 'htf': that tier alone (the others off), judged on profit: total R up by >= MIN_R_GAIN on both windows.
 */
export function research(
  data: Readonly<Record<string, SymbolData>>, from: number, to: number, testDays: number,
  log: (m: string) => void = () => {}, mode: ResearchMode = 'all',
): ResearchResult {
  const split = to - testDays * DAY;
  const full = defaultConfig(from, to);
  const solo = mode === 'all' ? null : SOLO[mode];
  const base = solo
    ? { ...full, tiers: Object.fromEntries((['LTF', 'MTF', 'HTF'] as Tier[]).map((t) => [t, { ...full.tiers[t], enabled: t === solo.tier }])) as BacktestConfig['tiers'] }
    : full;
  const list = solo ? solo.list : CANDIDATES;
  const run = (c: BacktestConfig, a: number, b: number): Row => {
    const r = runBacktest(data, { ...c, from: a, to: b });
    const s = stats(r.trades);
    return {
      trades: s.trades, winRate: s.winRate * 100, avgR: s.expectancyR, totalR: s.totalR, profitFactor: profitFactor(r.trades),
      returnPct: (r.endEquity / r.config.startEquity - 1) * 100, maxDrawdownPct: maxDrawdown(r.config.startEquity, r.equityCurve) * 100,
    };
  };
  const both = (c: BacktestConfig) => ({ train: run(c, from, split), test: run(c, split, to) });
  log('  baseline');
  const baseline = both(base);
  const attr = attribution(runBacktest(data, { ...base, from, to }).trades);
  const holds = (x: { train: Row; test: Row }) => (['train', 'test'] as const).every((w) =>
    x[w].trades >= (w === 'train' ? (solo?.minTrades ?? MIN_TRADES) : 1) && (solo
      ? x[w].totalR - baseline[w].totalR >= MIN_R_GAIN
      : x[w].winRate - baseline[w].winRate >= MIN_WIN_GAIN && x[w].totalR >= baseline[w].totalR));
  const candidates = list.map((c) => {
    log(`  ${c.label}`);
    const r = both(c.patch(base));
    return { label: c.label, why: c.why, ...r, holds: holds(r) };
  });
  const good = list.filter((c) => candidates.find((x) => x.label === c.label)!.holds && !c.label.startsWith('LTF only in killzones') && !c.label.startsWith('LTF only alongside'));
  let combined: ResearchResult['combined'] = null;
  if (good.length > 1) {
    log('  combined');
    combined = { labels: good.map((g) => g.label), ...both(good.reduce((c, g) => g.patch(c), base)) };
  }
  return { mode, attribution: attr, windows: { train: [from, split], test: [split, to] }, baseline, candidates, combined };
}

const f = (r: Row) => `${String(r.trades).padStart(4)} tr  win ${r.winRate.toFixed(1).padStart(5)}%  avg ${r.avgR.toFixed(2).padStart(5)}R  total ${r.totalR.toFixed(1).padStart(6)}R  ret ${r.returnPct.toFixed(1).padStart(6)}%  DD ${r.maxDrawdownPct.toFixed(1).padStart(5)}%`;
const d = (r: Row, b: Row) => `win ${(r.winRate - b.winRate >= 0 ? '+' : '') + (r.winRate - b.winRate).toFixed(1)}pt, R ${(r.totalR - b.totalR >= 0 ? '+' : '') + (r.totalR - b.totalR).toFixed(1)}`;

export function formatResearch(r: ResearchResult): string {
  const day = (x: number) => new Date(x).toISOString().slice(0, 10);
  const lines = [
    r.mode === 'all' ? 'WHOLE STRATEGY.' : `${r.mode.toUpperCase()} ON ITS OWN (other tiers off). HOLDS = total R up >= 1R on BOTH windows.`,
    `Research: train ${day(r.windows.train[0])} → ${day(r.windows.train[1])}, test ${day(r.windows.test[0])} → ${day(r.windows.test[1])}`,
    r.mode === 'all' ? `HOLDS = win rate up >= ${MIN_WIN_GAIN}pt on BOTH windows and total R not lower on either.` : '',
    '',
    `BASELINE (current strategy)`,
    `  train ${f(r.baseline.train)}`,
    `  test  ${f(r.baseline.test)}`,
    '',
  ];
  const gain = (c: ResearchResult['candidates'][number]) => r.mode !== 'all'
    ? (c.train.totalR - r.baseline.train.totalR) + (c.test.totalR - r.baseline.test.totalR)
    : (c.train.winRate - r.baseline.train.winRate) + (c.test.winRate - r.baseline.test.winRate);
  const sorted = [...r.candidates].sort((a, b) => Number(b.holds) - Number(a.holds) || gain(b) - gain(a));
  for (const c of sorted) {
    lines.push(`${c.holds ? 'HOLDS ' : '      '}${c.label}  (${c.why})`);
    lines.push(`   train ${f(c.train)}   [${d(c.train, r.baseline.train)}]`);
    lines.push(`   test  ${f(c.test)}   [${d(c.test, r.baseline.test)}]`);
  }
  lines.push('', formatAttribution(r.attribution));
  if (r.combined) {
    lines.push('', `ALL THAT HOLD, TOGETHER: ${r.combined.labels.join(' + ')}`);
    lines.push(`   train ${f(r.combined.train)}   [${d(r.combined.train, r.baseline.train)}]`);
    lines.push(`   test  ${f(r.combined.test)}   [${d(r.combined.test, r.baseline.test)}]`);
  }
  return lines.join('\n');
}

/** One run-log row per variant and window (docs/backtest/TASKS.md, T0). */
export function runLogRows(r: ResearchResult, rulesHash: string | null): RunLogRow[] {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const tier = r.mode === 'all' ? 'ALL' : r.mode.toUpperCase();
  const stamp = new Date().toISOString();
  const row = (rule: string, w: 'train' | 'test', x: Row, verdict: RunLogRow['verdict'], variant?: string): RunLogRow => ({
    timestamp: stamp, gitHash: gitHash(), rulesHash, rule, variant, tier,
    window: { name: w, from: iso(r.windows[w][0]), to: iso(r.windows[w][1]) },
    n: x.trades, expectancyR: x.trades ? x.avgR : null, profitFactor: x.profitFactor, totalR: x.totalR,
    winRate: x.trades ? x.winRate / 100 : null, nullPctile: null, randomFilterPctile: null, verdict,
  });
  const out: RunLogRow[] = [row('baseline', 'train', r.baseline.train, 'baseline'), row('baseline', 'test', r.baseline.test, 'baseline')];
  for (const c of r.candidates) {
    const v: RunLogRow['verdict'] = c.holds ? 'holds' : 'fails';
    out.push(row(c.label, 'train', c.train, v, c.why), row(c.label, 'test', c.test, v, c.why));
  }
  if (r.combined) {
    const label = `combined: ${r.combined.labels.join(' + ')}`;
    out.push(row(label, 'train', r.combined.train, 'info'), row(label, 'test', r.combined.test, 'info'));
  }
  return out;
}

function errorRow(mode: ResearchMode, rulesHash: string | null, from: number, to: number, error: string): RunLogRow {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return {
    timestamp: new Date().toISOString(), gitHash: gitHash(), rulesHash, rule: 'research', tier: mode.toUpperCase(),
    window: { name: 'all', from: iso(from), to: iso(to) }, n: 0, expectancyR: null, profitFactor: null, totalR: 0,
    winRate: null, nullPctile: null, randomFilterPctile: null, verdict: 'error', error,
  };
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
  const t = arg('tier')?.toLowerCase();
  const mode: ResearchMode = t === 'ltf' || t === 'htf' ? t : 'all';
  const { hash: rulesHash, rules } = loadRules();
  if (enabledRules(rules).length) throw new Error(`research runs against the baseline; disable ${enabledRules(rules).join(', ')} in config/rules.yaml`);
  let result: ResearchResult;
  try {
    result = research(data, from, to, testDays, log, mode);
  } catch (err) {
    appendRunLog(errorRow(mode, rulesHash, from, to, (err as Error).message));
    throw err;
  }
  appendRunLog(runLogRows(result, rulesHash));
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
