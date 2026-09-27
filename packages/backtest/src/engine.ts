// Event-driven backtest on closed 15m bars. At each bar close, in order:
//   1. pending limit entries fill (maker) or expire,
//   2. open positions: stop first (pessimistic), then partials / target,
//      triggered on mark price, filled as taker with slippage,
//   3. funding settlements that fell in the bar are paid or received,
//   4. RRG scans at 1H / 4H / 1D closes,
//   5. new setups: MTF on 1H closes, LTF on 15m closes, each through the
//      same bias, RRG gate and checkEntry() the live bot will use.
// Setups found at a close can only fill from the next bar on.

import { alignSeries, intervalMs, type Candle } from '@bot/marketdata';
import {
  bracket, checkEntry, killzoneAt, nextFundingAfter, utcDay,
  type AccountState, type ContractLimits, type Side, type Tier,
} from '@bot/risk';
import { buildWatchlist, readRrg, resolveConfig, type SymbolSeries, type Timeframe, type WatchlistEntry } from '@bot/signals';
import { analyze, barAt, biasAt, combineBias, detectSetup, insideZone, roomToLiquidity, swingsKnownAt, unmitigatedZones, watchSweeps, type Direction, type SeriesAnalysis } from '@bot/smc';
import { atrWilder, bollinger, ema, macdHistogram, rsi, sessionVwap, sma, stochastic, supertrend } from './indicators';
import { contextFor, ema50TrendState, SIGNAL_SETTINGS, SIGNALS } from './screen/signals';
import { DEFAULT_MOMENTUM, DEFAULT_TREND, FOMC_TIMES, NO_FILTERS, type BacktestConfig, type MomentumConfig, type TrendConfig, type BacktestResult, type Fill, type FundingPoint, type RadarRow, type Source, type SymbolData, type Tf, type TierPlan, type Trade } from './types';

const BENCH = ['BTCUSDT', 'ETHUSDT'];
const TFS: Tf[] = ['15m', '1h', '4h', '1d'];
const TIERS: Tier[] = ['HTF', 'MTF', 'LTF'];
const DEFAULT_LIMITS: ContractLimits = { qtyStep: 1e-6, minQty: 1e-6 };

interface Pending {
  symbol: string; tier: Tier; side: Side; source: Source;
  entry: number; stop: number; tp: number; qty: number; placedAt: number; expiresAt: number; market?: boolean;
  zoneFar?: number; tag?: number; rrg?: number;
}

interface Position {
  id: number; symbol: string; tier: Tier; side: Side; source: Source;
  entry: number; stop: number; initialStop: number; tp: number;
  qtyInitial: number; qty: number; riskAmount: number; openedAt: number;
  partialsHit: number; fills: Fill[]; gross: number; fees: number; funding: number;
  /** Best excursion so far in R, and the price extreme behind it (chandelier). */
  mfeR: number; extreme: number; tag?: number; rrg?: number;
}

// Reused across runs on the same data object (a tuning search runs dozens):
// structure analysis depends only on the candles and structure settings,
// RRG scans only on the candles, RRG settings and time.
const analysisCache = new WeakMap<object, Map<string, Record<string, Partial<Record<Tf, SeriesAnalysis>>>>>();
// Only what rrgGate needs is memoized: full WatchlistEntry objects (tails,
// readings) for every close of a multi-year run ran a research job out of
// memory at 4 GB.
type GateEntry = Pick<WatchlistEntry, 'symbol' | 'tiers' | 'direction' | 'signal'>;
const rrgCache = new WeakMap<object, Map<string, GateEntry[]>>();

const roundDown = (x: number, step: number) => Number((Math.floor(x / step + 1e-9) * step).toFixed(12));

/** A trade idea before risk checks. */
export interface Candidate {
  side: Side;
  entry: number;
  stop: number;
  source: Source;
  /** Explicit target (else the tier's rewardR). */
  takeProfit?: number;
  /** Fill at the next bar's open as taker (a market entry) instead of resting a limit. */
  market?: boolean;
  /** The entry gap's far edge (F1 cancel on a close through it). */
  zoneFar?: number;
  /** Carried to the trade (the gate's tag). */
  tag?: number;
  /** How long a limit entry rests before it expires (else the tier's expiryBars). */
  expiresInMs?: number;
}

/**
 * Replaces the strategy (setup + bias + RRG gate) for tests: return a
 * candidate to place, or null. Risk checks and execution are unchanged.
 */
export type CandidateOverride = (q: { tier: Tier; symbol: string; time: number }) => Candidate | null;

export interface RunMode {
  /**
   * true (backtest): close everything at the last bar. false (paper): leave
   * positions and pending entries open and report them in `open`.
   */
  closeAtEnd: boolean;
  /**
   * Entries paused from the dashboard: the reason if `tier` may not enter at
   * `time`, else null. Setups found while paused are rejected with it.
   */
  entriesBlocked?: (tier: Tier, time: number) => string | null;
  /** Also report what each symbol is waiting for at the last close. */
  radar?: boolean;
  /** When cfg.entryPriority applies (the dashboard's RRG influence switch, as time windows). Unset = always. */
  rrgPriorityAt?: (time: number) => boolean;
  /**
   * Entry gate for the strategy's setups (the confluence score, Mode X):
   * a string rejects with that reason; an object accepts and tags the trade;
   * null accepts. Called with the MSS bar's close time.
   */
  gate?: (q: { tier: Tier; symbol: string; time: number; side: Side; mssTime: number }) => string | { tag: number } | null;
}

export function runBacktest(
  data: Readonly<Record<string, SymbolData>>,
  cfg: BacktestConfig,
  override?: CandidateOverride,
  mode: RunMode = { closeAtEnd: true },
): BacktestResult {
  const warnings: string[] = [];
  const symbols = Object.keys(data);
  for (const b of BENCH) if (!data[b]?.candles['15m']?.length) throw new Error(`backtest needs ${b} 15m candles`);
  const coreSet = new Set(cfg.risk.coreSymbols);

  // Structure for every symbol and timeframe, built once (queries are as-of, no lookahead).
  const byStructure = analysisCache.get(data) ?? new Map();
  analysisCache.set(data, byStructure);
  const structureKey = JSON.stringify(cfg.structure);
  let analysis = byStructure.get(structureKey);
  if (!analysis) {
    analysis = {};
    for (const s of symbols) {
      analysis[s] = {};
      for (const tf of TFS) {
        const c = data[s]!.candles[tf];
        if (c?.length) analysis[s]![tf] = analyze(c, cfg.structure);
      }
    }
    byStructure.set(structureKey, analysis);
  }
  const rrgMemo = rrgCache.get(data) ?? new Map<string, GateEntry[]>();
  rrgCache.set(data, rrgMemo);
  const rrgKey = `${JSON.stringify(cfg.rrg)}|${cfg.rrgHistoryBars}`;
  if (symbols.some((s) => !data[s]!.mark15m)) warnings.push('some symbols have no mark-price candles: their stops and targets trigger on last price');
  if (symbols.some((s) => !data[s]!.funding?.length)) {
    warnings.push(`some symbols have no funding history: ${(cfg.defaultFunding.rate * 100).toFixed(4)}% every ${cfg.defaultFunding.intervalHours}h assumed`);
  }
  if (symbols.some((s) => !data[s]!.limits)) warnings.push('some symbols have no contract limits: quantities are not rounded to exchange steps');

  const fundingOf = (s: string): FundingPoint[] => data[s]!.funding ?? [];
  const intervalOf = (s: string) => data[s]!.fundingIntervalHours ?? cfg.defaultFunding.intervalHours;

  let equity = cfg.startEquity;
  // Drawdown circuit breaker (cfg.circuitBreaker): peak of realized equity, entries paused until breakerUntil.
  let equityPeak = equity;
  let breakerUntil = 0;
  let day = -1;
  let dayStartEquity = equity;
  const realizedToday: Record<Tier, number> = { LTF: 0, MTF: 0, HTF: 0 };
  const equityCurve: BacktestResult['equityCurve'] = [];
  const trades: Trade[] = [];
  const rejected: BacktestResult['rejected'] = [];
  let pending: Pending[] = [];
  let positions: Position[] = [];
  let nextId = 1;
  let setupsSeen = 0;
  let expired = 0;
  const watch: Partial<Record<Tf, GateEntry[]>> = {};

  const book = (tier: Tier, amount: number, time: number) => {
    equity += amount;
    realizedToday[tier] += amount;
    equityCurve.push({ time, equity });
  };
  const slip = (price: number, side: Side, exiting: boolean) => {
    // Adverse: buying pays more, selling gets less.
    const buying = (side === 'long') !== exiting;
    return price * (1 + ((buying ? 1 : -1) * cfg.slippageBps) / 10_000);
  };

  function exit(p: Position, rawPrice: number, qty: number, reason: Fill['reason'], time: number, from: Fill['from'] = 'level') {
    // Resting limit targets fill at their price as maker; everything else is a market fill.
    const maker = cfg.targetFill === 'maker' && (reason === 'target' || reason === 'partial');
    const price = maker ? rawPrice : slip(rawPrice, p.side, true);
    const gross = (p.side === 'long' ? price - p.entry : p.entry - price) * qty;
    const fee = price * qty * (maker ? cfg.fees.maker : cfg.fees.taker);
    p.qty = Number((p.qty - qty).toFixed(12));
    p.gross += gross;
    p.fees += fee;
    p.fills.push({ time, price, qty, fee, reason, from });
    book(p.tier, gross - fee, time);
    if (p.qty <= 0) {
      const net = p.gross - p.fees + p.funding;
      trades.push({
        id: p.id, symbol: p.symbol, tier: p.tier, side: p.side, source: p.source, openedAt: p.openedAt, closedAt: time,
        entry: p.entry, initialStop: p.initialStop, riskAmount: p.riskAmount, qty: p.qtyInitial, fills: p.fills,
        grossPnl: p.gross, fees: p.fees, funding: p.funding, netPnl: net, r: net / p.riskAmount, ...(p.tag != null ? { tag: p.tag } : {}), ...(p.rrg != null ? { rrg: p.rrg } : {}),
      });
      positions = positions.filter((x) => x !== p);
    }
  }

  const bar = (s: string, tf: Tf, time: number): { i: number; c: Candle } | null => {
    const list = data[s]!.candles[tf];
    if (!list) return null;
    const i = barAt(list, intervalMs(tf), time);
    // Only the bar that closes exactly now counts as "this bar".
    return i >= 0 && list[i]!.openTime + intervalMs(tf) === time ? { i, c: list[i]! } : null;
  };
  const markBar = (s: string, time: number): Candle | null => {
    const list = data[s]!.mark15m;
    if (!list) return bar(s, '15m', time)?.c ?? null;
    const i = barAt(list, intervalMs('15m'), time);
    return i >= 0 && list[i]!.openTime + intervalMs('15m') === time ? list[i]! : null;
  };

  function manageBar(time: number) {
    // 1. Pending entries.
    for (const o of [...pending]) {
      const b = bar(o.symbol, '15m', time)?.c;
      if (time > o.expiresAt) { pending = pending.filter((x) => x !== o); expired++; continue; }
      if (!b) continue;
      const long = o.side === 'long';
      const oplan = cfg.tiers[o.tier];
      if (!o.market && oplan.cancelOn1RTouch) {
        // The 1R level traded before the fill: cancel (in a bar that also touched the entry, assume 1R came first).
        const r1 = long ? o.entry + (o.entry - o.stop) : o.entry - (o.stop - o.entry);
        if (long ? b.high >= r1 : b.low <= r1) { pending = pending.filter((x) => x !== o); expired++; continue; }
      }
      if (!o.market && oplan.cancelOnZoneClose && o.zoneFar != null) {
        const eb = bar(o.symbol, oplan.entryTf, time);
        if (eb && (long ? eb.c.close < o.zoneFar : eb.c.close > o.zoneFar)) { pending = pending.filter((x) => x !== o); expired++; continue; }
      }
      if (cfg.fundingFillBlackoutMinutes) {
        const w = cfg.fundingFillBlackoutMinutes * 60_000;
        const hist = fundingOf(o.symbol);
        const barStart = time - intervalMs('15m');
        const near = hist.length
          ? hist.some((f) => f.time > barStart - w && f.time < time + w)
          : nextFundingAfter(barStart - w, intervalOf(o.symbol)) < time + w;
        if (near) continue; // no fill this bar; the order stays
      }
      // Fill realism: a resting limit needs price to trade through it by a tick, not just touch it.
      const tick = cfg.fillRealism && !o.market ? (data[o.symbol]!.limits?.priceTick ?? o.entry * 1e-5) : 0;
      const touched = o.market || (long ? b.low <= o.entry - tick : b.high >= o.entry + tick);
      if (!touched) continue;
      const gapped = o.market || (long ? b.open < o.entry : b.open > o.entry);
      const price = gapped ? slip(b.open, o.side, false) : o.entry;
      const fee = price * o.qty * (gapped ? cfg.fees.taker : cfg.fees.maker);
      pending = pending.filter((x) => x !== o);
      const p: Position = {
        id: nextId++, symbol: o.symbol, tier: o.tier, side: o.side, source: o.source,
        entry: price, stop: o.stop, initialStop: o.stop, tp: o.tp, qtyInitial: o.qty, qty: o.qty,
        riskAmount: Math.abs(price - o.stop) * o.qty, openedAt: time, partialsHit: 0,
        fills: [{ time, price, qty: o.qty, fee, reason: 'entry', from: gapped ? 'open' : 'level' }], gross: 0, fees: fee, funding: 0,
        mfeR: 0, extreme: price, ...(o.tag != null ? { tag: o.tag } : {}), ...(o.rrg != null ? { rrg: o.rrg } : {}),
      };
      positions.push(p);
      book(p.tier, -fee, time);
      // Fill bar: only the stop is checked (we can't know if the target came first).
      const m = markBar(o.symbol, time) ?? b;
      if (long ? m.low <= p.stop : m.high >= p.stop) exit(p, p.stop, p.qty, 'stop', time);
    }

    // 2. Open positions (those not filled on this bar).
    for (const p of [...positions]) {
      if (p.openedAt === time) continue;
      const m = markBar(p.symbol, time);
      if (!m) continue;
      const long = p.side === 'long';
      const plan = cfg.tiers[p.tier];
      if (long ? m.low <= p.stop : m.high >= p.stop) {
        const gapped = long ? m.open < p.stop : m.open > p.stop;
        exit(p, gapped ? m.open : p.stop, p.qty, 'stop', time, gapped ? 'open' : 'level');
        continue;
      }
      const r1 = Math.abs(p.entry - p.initialStop);
      const reached = (r: number) => (long ? m.high >= p.entry + r * r1 : m.low <= p.entry - r * r1);
      for (let k = p.partialsHit; k < plan.partials.length; k++) {
        const pt = plan.partials[k]!;
        if (!reached(pt.atR)) break;
        const step = data[p.symbol]!.limits?.qtyStep ?? DEFAULT_LIMITS.qtyStep;
        const q = Math.min(p.qty, roundDown(p.qtyInitial * pt.fraction, step));
        p.partialsHit = k + 1;
        if (q > 0) exit(p, long ? p.entry + pt.atR * r1 : p.entry - pt.atR * r1, q, 'partial', time);
        if (p.qty <= 0) break;
      }
      if (p.qty <= 0) continue;
      if (r1 > 0) {
        p.extreme = long ? Math.max(p.extreme, m.high) : Math.min(p.extreme, m.low);
        p.mfeR = Math.max(p.mfeR, (long ? p.extreme - p.entry : p.entry - p.extreme) / r1);
      }
      if (plan.stopSteps) {
        for (const st of plan.stopSteps) {
          if (!reached(st.atR)) continue;
          const to = st.toR != null ? (long ? p.entry + st.toR * r1 : p.entry - st.toR * r1)
            : (long ? p.entry * (1 + (st.toPct ?? 0) / 100) : p.entry * (1 - (st.toPct ?? 0) / 100));
          p.stop = long ? Math.max(p.stop, to) : Math.min(p.stop, to);
        }
      } else if (plan.breakevenAtR != null && reached(plan.breakevenAtR)) {
        p.stop = long ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
      }
      if (long ? m.high >= p.tp : m.low <= p.tp) { exit(p, p.tp, p.qty, 'target', time); continue; }
      if (plan.timeStop && time % intervalMs(plan.timeStop.barTf) === 0) {
        const bars = (time - p.openedAt) / intervalMs(plan.timeStop.barTf);
        if (bars >= plan.timeStop.maxBars || (bars >= plan.timeStop.checkBars && p.mfeR < plan.timeStop.minMfeR)) {
          exit(p, m.close, p.qty, 'time', time, 'close');
        }
      }
    }
  }

  function applyFunding(prev: number, time: number) {
    for (const p of positions) {
      const hist = fundingOf(p.symbol);
      const points = hist.length
        ? hist.filter((f) => f.time > prev && f.time <= time)
        : (() => { const t = nextFundingAfter(prev, intervalOf(p.symbol)); return t <= time ? [{ time: t, rate: cfg.defaultFunding.rate }] : []; })();
      const m = markBar(p.symbol, time);
      if (!m) continue;
      for (const f of points) {
        // Positive rate: longs pay shorts.
        const amount = (p.side === 'long' ? -1 : 1) * p.qty * m.close * f.rate;
        p.funding += amount;
        book(p.tier, amount, time);
      }
    }
  }

  const chandelierAtr = new Map<string, (number | null)[]>();
  function chandelier(time: number) {
    for (const p of positions) {
      const ch = cfg.tiers[p.tier].chandelier;
      if (!ch || p.mfeR < ch.activateR || time % intervalMs(ch.atrTf) !== 0) continue;
      const list = data[p.symbol]!.candles[ch.atrTf];
      const b = bar(p.symbol, ch.atrTf, time);
      if (!list || !b) continue;
      const key = `${p.symbol}|${ch.atrTf}|${ch.atrLen}`;
      let atr = chandelierAtr.get(key);
      if (!atr) { atr = atrWilder(list, ch.atrLen); chandelierAtr.set(key, atr); }
      const a = atr[b.i];
      if (a == null) continue;
      const level = p.side === 'long' ? p.extreme - ch.mult * a : p.extreme + ch.mult * a;
      p.stop = p.side === 'long' ? Math.max(p.stop, level) : Math.min(p.stop, level);
    }
  }

  function trail(time: number) {
    chandelier(time);
    for (const p of positions) {
      const plan = cfg.tiers[p.tier];
      if (!plan.trailTf || p.partialsHit === 0) continue;
      const b = bar(p.symbol, plan.trailTf, time);
      const a = analysis[p.symbol]![plan.trailTf];
      if (!b || !a) continue;
      if (p.side === 'long') {
        const low = swingsKnownAt(a.long, b.i, 'low').at(-1);
        if (low && low.price > p.stop && low.price < b.c.close) p.stop = low.price;
      } else {
        const high = swingsKnownAt(a.long, b.i, 'high').at(-1);
        if (high && high.price < p.stop && high.price > b.c.close) p.stop = high.price;
      }
    }
  }

  function scanRrg(tf: Tf, time: number) {
    const memoKey = `${rrgKey}|${tf}|${time}`;
    const memo = rrgMemo.get(memoKey);
    if (memo) { watch[tf] = memo; return; }
    const ms = intervalMs(tf);
    const recent: Record<string, Candle[]> = {};
    for (const s of symbols) {
      const list = data[s]!.candles[tf];
      if (!list) continue;
      const i = barAt(list, ms, time);
      if (i >= 0) recent[s] = list.slice(Math.max(0, i - cfg.rrgHistoryBars - 2), i + 1);
    }
    const aligned = alignSeries(recent, tf, cfg.rrgHistoryBars, time);
    if (BENCH.some((b) => !aligned.series[b])) { watch[tf] = []; rrgMemo.set(memoKey, []); return; }
    const series: Record<string, SymbolSeries> = {};
    for (const [s, v] of Object.entries(aligned.series)) {
      const last = fundingOf(s).filter((f) => f.time <= time).at(-1);
      const annual = last ? last.rate * 100 * (24 / intervalOf(s)) * 365 : null;
      series[s] = { close: v.close, volume: v.volume, fundingAnnualizedPct: annual };
    }
    watch[tf] = buildWatchlist({ timeframe: tf as Timeframe, series, config: cfg.rrg }).entries
      .map(({ symbol, tiers, direction, signal }) => ({ symbol, tiers, direction, signal }));
    rrgMemo.set(memoKey, watch[tf]!);
  }

  /** Direction(s) RRG allows an extra symbol in a tier, with the signal that allowed it. */
  function rrgGate(symbol: string, tier: Tier): { side: Side; source: Source } | null {
    const hits = cfg.tiers[tier].rrgTfs.flatMap((tf) => watch[tf] ?? [])
      .filter((e) => e.symbol === symbol && e.tiers.includes(tier));
    if (hits.length === 0) return null;
    const sides = new Set(hits.map((e) => e.direction));
    if (sides.size > 1) return null;
    return { side: hits[0]!.direction, source: hits[0]!.signal };
  }

  /** Bias: higher timeframe decides, lower may veto. BTC and ETH use each other for SMT. */
  function biasFor(symbol: string, tier: Tier, time: number): RadarRow['bias'] {
    const byTf = cfg.tiers[tier].biasTfs.map((tf) => {
      const ctx = analysis[symbol]![tf];
      const hb = ctx && barAt(data[symbol]!.candles[tf]!, intervalMs(tf), time);
      if (!ctx || hb == null || hb < 0) return { tf, direction: 'neutral' as Direction, reasons: ['no data'] };
      const pair = symbol === 'BTCUSDT' ? 'ETHUSDT' : symbol === 'ETHUSDT' ? 'BTCUSDT' : null;
      const other = pair ? analysis[pair]?.[tf] : undefined;
      const aligned = other && data[pair!]!.candles[tf]!.length === data[symbol]!.candles[tf]!.length
        && data[pair!]!.candles[tf]![0]!.openTime === data[symbol]!.candles[tf]![0]!.openTime;
      const b = biasAt(ctx.long, hb, cfg.bias, aligned ? other!.long : undefined);
      return { tf, direction: b.direction, reasons: b.reasons };
    });
    const dirs = byTf.map((x) => x.direction);
    const combined = cfg.biasCombine === 'higher' ? dirs[0]!
      : cfg.biasCombine === 'both' ? (dirs[0] === dirs[1] ? dirs[0]! : 'neutral')
      : combineBias(dirs[0]!, dirs[1]!);
    return { combined, byTf };
  }

  /** The strategy: a setup on the entry timeframe, agreeing with HTF bias and (for extras) RRG. */
  function strategy(tier: Tier, symbol: string, time: number, reject: (r: string) => void): Candidate | null {
    const plan = cfg.tiers[tier];
    const a = analysis[symbol]![plan.entryTf];
    const b = bar(symbol, plan.entryTf, time);
    if (!a || !b) return null;
    const setup = detectSetup(a, b.i, cfg.setup);
    if (!setup) return null;
    setupsSeen++;

    if (plan.bias !== 'off') {
      const bias = biasFor(symbol, tier, time).combined;
      if (bias !== setup.side) { reject(`bias ${bias}`); return null; }
    }
    let tag: number | undefined;
    if (mode.gate) {
      const mssTime = a.long.candles[setup.mssIndex]!.openTime + intervalMs(plan.entryTf);
      const g = mode.gate({ tier, symbol, time, side: setup.side, mssTime });
      if (typeof g === 'string') { reject(g); return null; }
      tag = g?.tag;
    }

    let source: Source = 'core';
    if (!coreSet.has(symbol)) {
      const gate = rrgGate(symbol, tier);
      const mode = cfg.extrasRrg ?? 'required';
      if (mode === 'required') {
        if (!gate) { reject('no RRG signal'); return null; }
        if (gate.side !== setup.side) { reject('RRG direction'); return null; }
        source = gate.source;
      } else if (gate && gate.side === setup.side) {
        source = gate.source;
      } else if (gate && mode === 'veto') {
        reject('RRG direction'); return null;
      }
    } else if (cfg.coreRrgVeto) {
      const gate = rrgGate(symbol, tier);
      if (gate && gate.side !== setup.side) { reject('RRG against core'); return null; }
    }
    if (cfg.minRoomR > 0 && roomToLiquidity(a, b.i, setup) < cfg.minRoomR) { reject('no room to liquidity'); return null; }
    const blocked = filtersBlock(symbol, tier, time, a, b.i, setup);
    if (blocked) { reject(blocked); return null; }
    const zoneFar = setup.side === 'long' ? setup.zone.bottom : setup.zone.top;
    return { side: setup.side, entry: setup.entry, stop: setup.stop, source, zoneFar, ...(tag != null ? { tag } : {}) };
  }

  /** The win-rate filters (cfg.filters): the reason the setup is skipped, or null. */
  function filtersBlock(symbol: string, tier: Tier, time: number, a: SeriesAnalysis, i: number, setup: { side: Side; sweepIndex: number }): string | null {
    const f = cfg.filters ?? NO_FILTERS;
    const plan = cfg.tiers[tier];
    const long = setup.side === 'long';

    if (f.atrRegime) {
      const atr = a.long.atr;
      const now = atr[i];
      if (now != null) {
        let below = 0;
        let n = 0;
        for (let j = Math.max(0, i - f.atrRegime.lookback); j < i; j++) {
          const v = atr[j];
          if (v == null) continue;
          n++;
          if (v < now) below++;
        }
        if (n >= 20) {
          const pct = (below / n) * 100;
          if (pct < f.atrRegime.minPct) return 'volatility too low';
          if (pct > f.atrRegime.maxPct) return 'volatility too high';
        }
      }
    }

    if (f.htfZone) {
      const tf = plan.biasTfs[f.htfZone === 'higher' ? 0 : 1];
      const ctx = analysis[symbol]![tf];
      const list = data[symbol]!.candles[tf];
      const hb = ctx && list ? barAt(list, intervalMs(tf), time) : -1;
      if (!ctx || hb < 0) return 'no HTF zone data';
      const sweep = a.long.candles[setup.sweepIndex]!;
      const price = long ? sweep.low : sweep.high;
      if (!insideZone(unmitigatedZones(ctx.long, hb, cfg.bias), long ? 'bull' : 'bear', price)) return `sweep not at a ${tf} zone`;
    }

    if (f.emaTrend) {
      const tf = plan.biasTfs[0];
      const list = data[symbol]!.candles[tf];
      const hb = list ? barAt(list, intervalMs(tf), time) : -1;
      if (!list || hb < f.emaTrend * 2) return 'no EMA data';
      const k = 2 / (f.emaTrend + 1);
      let ema = list[0]!.close;
      let prev = ema;
      for (let j = 1; j <= hb; j++) { prev = ema; ema = list[j]!.close * k + ema * (1 - k); }
      const close = list[hb]!.close;
      if (long ? !(close > ema && ema > prev) : !(close < ema && ema < prev)) return `against the ${tf} EMA${f.emaTrend}`;
    }

    if (f.btcGate && symbol !== 'BTCUSDT') {
      const tf = plan.biasTfs[1];
      const ctx = analysis.BTCUSDT?.[tf];
      const list = data.BTCUSDT?.candles[tf];
      const hb = ctx && list ? barAt(list, intervalMs(tf), time) : -1;
      if (ctx && hb >= 0) {
        const d = biasAt(ctx.long, hb, cfg.bias).direction;
        if (d !== 'neutral' && d !== setup.side) return `BTC ${tf} bias ${d}`;
      }
    }

    // Confluence: structure on each confirmation timeframe already points the trade's way.
    for (const tf of plan.confirmTfs ?? []) {
      const ctx = analysis[symbol]![tf];
      const list = data[symbol]!.candles[tf];
      const cb = ctx && list ? barAt(list, intervalMs(tf), time) : -1;
      if (!ctx || cb < 0) return `no ${tf} data`;
      if (ctx.long.trend[cb] !== (long ? 'up' : 'down')) return `${tf} structure not ${long ? 'up' : 'down'}`;
    }

    if (f.fomcBlackoutMinutes > 0) {
      const w = f.fomcBlackoutMinutes * 60_000;
      if (FOMC_TIMES.some((t) => Math.abs(t - time) <= w)) return 'FOMC blackout';
    }
    return null;
  }

  /** RRG strength against BTC the trade's way on `tf` at `time`: (RS-Ratio - 100) + (RS-Momentum - 100), sign-flipped for shorts; 0 without a reading. */
  const rrgStrengthMemo = new Map<string, number>();
  const rrgClassifier = resolveConfig(cfg.rrg);
  function rrgStrength(symbol: string, side: Side, tf: Tf, time: number): number {
    const key = `${symbol}|${tf}|${time}`;
    let v = rrgStrengthMemo.get(key);
    if (v === undefined) {
      v = 0;
      const ms = intervalMs(tf);
      const own = data[symbol]?.candles[tf];
      const btc = data.BTCUSDT?.candles[tf];
      const i = own ? barAt(own, ms, time) : -1;
      const j = btc ? barAt(btc, ms, time) : -1;
      if (symbol !== 'BTCUSDT' && own && btc && i >= 0 && j >= 0) {
        const bt = new Map(btc.slice(Math.max(0, j - cfg.rrgHistoryBars - 2), j + 1).map((c) => [c.openTime, c.close]));
        const pairs = own.slice(Math.max(0, i - cfg.rrgHistoryBars - 2), i + 1).filter((c) => bt.has(c.openTime));
        const r = pairs.length > 10 ? readRrg(pairs.map((c) => c.close), pairs.map((c) => bt.get(c.openTime)!), 'BTC', rrgClassifier) : null;
        if (r) v = r.point.x - 100 + (r.point.y - 100);
      }
      rrgStrengthMemo.set(key, v);
    }
    return side === 'long' ? v : -v;
  }

  function lookForEntries(tier: Tier, time: number) {
    const plan = cfg.tiers[tier];
    const found: { symbol: string; cand: Candidate; reject: (r: string) => void }[] = [];
    const prioritize = cfg.entryPriority != null && (mode.rrgPriorityAt?.(time) ?? true);
    for (const symbol of symbols) {
      if (plan.symbols && !plan.symbols.includes(symbol)) continue;
      if (plan.model === 'trend') trendExits(tier, symbol, time);
      const reject = (reason: string) => rejected.push({ time, symbol, tier, reason });
      const cand = override ? override({ tier, symbol, time })
        : plan.model === 'momentum' ? momentumStrategy(tier, symbol, time, reject)
        : plan.model === 'trend' ? trendStrategy(tier, symbol, time, reject)
        : plan.model === 'signal' ? signalStrategy(tier, symbol, time) : strategy(tier, symbol, time, reject);
      if (!cand) continue;
      if (prioritize) found.push({ symbol, cand, reject });
      else consider(tier, time, symbol, cand, reject);
    }
    if (!prioritize || !found.length) return;
    // Magnifying glass: strongest-against-BTC first; ties keep symbol order.
    const tf = cfg.entryPriority!.rrgTf;
    const ranked = found.map((f, k) => ({ ...f, k, st: rrgStrength(f.symbol, f.cand.side, tf, time) }))
      .sort((a, b) => b.st - a.st || a.k - b.k);
    for (const f of ranked) consider(tier, time, f.symbol, f.cand, f.reject);
  }

  function consider(tier: Tier, time: number, symbol: string, cand: Candidate, reject: (r: string) => void) {
    const plan = cfg.tiers[tier];
    // do/while(false): `continue` below leaves this one candidate, as it did inside the per-symbol loop.
    do {
      if (override) setupsSeen++;
      const paused = mode.entriesBlocked?.(tier, time);
      if (paused) { reject(paused); continue; }
      if (time < breakerUntil) { reject('drawdown circuit breaker'); continue; }
      // Momentum model: an opposite signal flips the position (the script has no pyramiding).
      if (plan.model === 'momentum' && (plan.momentum ?? DEFAULT_MOMENTUM).reverse) {
        const open = positions.find((p) => p.symbol === symbol && p.tier === tier && p.side !== cand.side);
        if (open) {
          const m = markBar(symbol, time) ?? bar(symbol, '15m', time)?.c;
          if (m) exit(open, m.close, open.qty, 'reverse', time, 'close');
        }
        pending = pending.filter((o) => !(o.symbol === symbol && o.tier === tier && o.side !== cand.side));
      }

      const hist = fundingOf(symbol);
      const nextFunding = hist.find((f) => f.time > time)?.time ?? nextFundingAfter(time, intervalOf(symbol));
      const state: AccountState = {
        equity, dayStartEquity, realizedToday: { ...realizedToday },
        positions: positions.map((p) => ({ symbol: p.symbol, tier: p.tier, side: p.side, qty: p.qty, entry: p.entry })),
        pending: pending.map((o) => ({ symbol: o.symbol, tier: o.tier, side: o.side, qty: o.qty, entry: o.entry })),
      };
      if (cfg.minStopPct > 0 && Math.abs(cand.entry - cand.stop) / cand.entry < cfg.minStopPct / 100) {
        reject('stop too tight');
        continue;
      }
      if (cfg.portfolio) {
        // Open risk: positions at their current stop (0 once past entry) plus pending entries at theirs; the new trade adds its tier's risk.
        const mineOnly = <T extends { tier: Tier }>(xs: T[]) => (cfg.portfolio!.perTier ? xs.filter((x) => x.tier === tier) : xs);
        const openRisk = mineOnly(positions).reduce((a, p) => a + Math.max(0, (p.side === 'long' ? p.entry - p.stop : p.stop - p.entry) * p.qty), 0)
          + mineOnly(pending).reduce((a, o) => a + Math.abs(o.entry - o.stop) * o.qty, 0);
        if ((openRisk / equity) * 100 + cfg.risk.tiers[tier].riskPct > cfg.portfolio.maxOpenRiskPct + 1e-9) { reject('portfolio open-risk cap'); continue; }
        const isAlt = (s: string) => s !== 'BTCUSDT' && s !== 'ETHUSDT';
        if (isAlt(symbol)) {
          const same = [...mineOnly(positions), ...mineOnly(pending)].filter((x) => isAlt(x.symbol) && x.side === cand.side).length;
          if (same >= cfg.portfolio.maxSameDirAlts) { reject('same-direction alts cap'); continue; }
        }
      }
      const br = bracket(cand.side, cand.entry, cand.stop, plan.rewardR);
      if (cand.takeProfit != null) br.takeProfit = cand.takeProfit;
      const decision = checkEntry(
        { symbol, tier, side: cand.side, bracket: br, limits: data[symbol]!.limits ?? DEFAULT_LIMITS },
        state, { time, nextFundingTime: nextFunding }, cfg.risk,
      );
      if (!decision.ok) { reject(decision.reason); continue; }
      pending.push({
        symbol, tier, side: cand.side, source: cand.source, entry: br.entry, stop: br.stop, tp: br.takeProfit,
        qty: decision.sizing.qty, placedAt: time, expiresAt: time + (cand.expiresInMs ?? plan.expiryBars * intervalMs(plan.entryTf)), market: cand.market,
        ...(cand.zoneFar != null ? { zoneFar: cand.zoneFar } : {}), ...(cand.tag != null ? { tag: cand.tag } : {}),
        ...(cfg.rrgLogTf ? { rrg: Number(rrgStrength(symbol, cand.side, cfg.rrgLogTf, time).toFixed(3)) } : {}),
      });
    } while (false);
  }

  // model 'signal': the screened signal's events and ATR on the entry timeframe, built once per symbol.
  const signalCache = new Map<string, { at: Map<number, number>; closeAt: number[]; sig: Int8Array; close: number[]; atr: (number | null)[]; trend: number[] | null } | null>();
  function signalEvents(plan: TierPlan, symbol: string) {
    const s = plan.signal!;
    const key = `${symbol}|${plan.entryTf}|${s.id}`;
    let ev = signalCache.get(key);
    if (ev === undefined) {
      const def = SIGNALS.find((d) => d.id === s.id);
      if (!def) throw new Error(`unknown signal ${s.id}`);
      const ctx = contextFor(data, symbol, plan.entryTf, SIGNAL_SETTINGS);
      const iv = intervalMs(plan.entryTf);
      ev = ctx ? {
        at: new Map(ctx.candles.map((c, i) => [c.openTime + iv, i])), closeAt: ctx.candles.map((c) => c.openTime + iv),
        sig: def.build(ctx), close: ctx.candles.map((c) => c.close), atr: atrWilder(ctx.candles, 14),
        trend: s.id.startsWith('ema50_trend') ? ema50TrendState(ctx) : null,
      } : null;
      signalCache.set(key, ev);
    }
    return ev;
  }

  function signalStrategy(tier: Tier, symbol: string, time: number): Candidate | null {
    const plan = cfg.tiers[tier];
    const s = plan.signal;
    if (!s) return null;
    const key = `${symbol}|${plan.entryTf}|${s.id}`;
    const ev = signalEvents(plan, symbol);
    const i = ev?.at.get(time);
    if (!ev || i == null) return null;
    const raw = ev.sig[i]!;
    const a = ev.atr[i];
    if (!raw || a == null || !(a > 0)) return null;
    const side = raw > 0 ? 'long' : 'short';
    const px = ev.close[i]!;
    const d = raw > 0 ? 1 : -1;
    return { side, entry: px, stop: px - d * s.stopAtr * a, takeProfit: px + d * s.targetAtr * a, source: 'core', market: true, tag: time };
  }

  // Momentum model indicators, built once per symbol and timeframe.
  const momentumCache =new Map<string, { ema: (number | null)[]; emaSlow: (number | null)[]; hist: (number | null)[]; k: (number | null)[] }>();
  function momentumIndicators(symbol: string, tf: Tf, m: MomentumConfig) {
    const key = `${symbol}|${tf}|${m.fastEma}|${m.slowEma}|${m.macd}|${m.stoch}`;
    let ind = momentumCache.get(key);
    if (!ind) {
      const candles = data[symbol]!.candles[tf]!;
      const closes = candles.map((c) => c.close);
      ind = {
        ema: ema(closes, m.fastEma), emaSlow: ema(closes, m.slowEma),
        hist: macdHistogram(closes, ...m.macd), k: stochastic(candles, ...m.stoch).k,
      };
      momentumCache.set(key, ind);
    }
    return ind;
  }

  /** The owner's EMA + MACD + Stochastic model on the entry timeframe. */
  function momentumStrategy(tier: Tier, symbol: string, time: number, reject: (r: string) => void): Candidate | null {
    const plan = cfg.tiers[tier];
    const m = plan.momentum ?? DEFAULT_MOMENTUM;
    const b = bar(symbol, plan.entryTf, time);
    const candles = data[symbol]!.candles[plan.entryTf];
    if (!b || !candles) return null;
    const i = b.i;
    const ind = momentumIndicators(symbol, plan.entryTf, m);
    const fast = ind.ema[i];
    const slow = ind.emaSlow[i];
    const hist = ind.hist[i];
    const k = ind.k[i];
    if (fast == null || slow == null || hist == null || k == null || i < m.crossLookback) return null;
    const close = candles[i]!.close;

    for (const side of ['long', 'short'] as const) {
      const long = side === 'long';
      // Trigger: a close crossed the fast EMA (either way) in the last N bars, or a wick touched it recently.
      let crossed = false;
      for (let j = i - m.crossLookback + 1; j <= i; j++) {
        const pe = ind.ema[j - 1];
        const e = ind.ema[j];
        if (pe == null || e == null) continue;
        const pc = candles[j - 1]!.close;
        const c = candles[j]!.close;
        if ((pc <= pe && c > e) || (pc >= pe && c < e)) crossed = true;
      }
      for (let j = i - m.touchLookback; j < i && !crossed; j++) {
        const e = ind.ema[j];
        if (e != null && j >= 0 && candles[j]!.low <= e && candles[j]!.high >= e) crossed = true;
      }
      if (!crossed) continue;
      // Stochastic: %K crossing the oversold line up (long) / overbought down (short), on this bar or within the lookback.
      let stochCross = false;
      for (let j = m.stochCrossNow ? i : i - m.crossLookback + 1; j <= i; j++) {
        const pk = ind.k[j - 1];
        const kk = ind.k[j];
        if (pk != null && kk != null && (long ? pk <= m.oversold && kk > m.oversold : pk >= m.overbought && kk < m.overbought)) stochCross = true;
      }
      if (!stochCross) continue;
      if (long ? !(close > fast && fast > slow && hist >= 0) : !(close < fast && fast < slow && hist <= 0)) continue;
      setupsSeen++;
      if (m.useBias) {
        const bias = biasFor(symbol, tier, time).combined;
        if (bias !== side) { reject(`bias ${bias}`); return null; }
      }
      let source: Source = 'core';
      if (m.useRrg && !coreSet.has(symbol)) {
        const gate = rrgGate(symbol, tier);
        if (!gate) { reject('no RRG signal'); return null; }
        if (gate.side !== side) { reject('RRG direction'); return null; }
        source = gate.source;
      }
      const atr = analysis[symbol]![plan.entryTf]?.long.atr[i] ?? null;
      const stop = m.slPct != null ? close * (1 - (long ? 1 : -1) * m.slPct / 100)
        : atr != null ? (long ? Math.min(slow, close) - atr : Math.max(slow, close) + atr) : null;
      if (stop == null) return null;
      const takeProfit = m.tpPct != null ? close * (1 + (long ? 1 : -1) * m.tpPct / 100) : undefined;
      return { side, entry: close, stop, source, takeProfit, market: true };
    }
    return null;
  }

  // Trend / mean-reversion model indicators, built once per symbol and timeframe.
  interface TrendInd {
    fast: (number | null)[]; slow: (number | null)[]; st: { dir: (1 | -1 | null)[]; line: (number | null)[] } | null;
    vwap: (number | null)[] | null; rsi: (number | null)[]; hist: (number | null)[] | null; volMa: (number | null)[];
    bb: { upper: (number | null)[]; lower: (number | null)[] }; atr: (number | null)[];
  }
  const trendCache = new Map<string, TrendInd>();
  function trendIndicators(symbol: string, tf: Tf, t: TrendConfig): TrendInd {
    const key = `${symbol}|${tf}|${t.fastEma}|${t.slowEma}|${t.supertrend}|${t.vwap}|${t.rsiPeriod}|${t.macd}|${t.volumeMa}|${t.bollinger}|${t.atrPeriod}`;
    let ind = trendCache.get(key);
    if (!ind) {
      const candles = data[symbol]!.candles[tf]!;
      const closes = candles.map((c) => c.close);
      ind = {
        fast: ema(closes, t.fastEma), slow: ema(closes, t.slowEma),
        st: t.supertrend ? supertrend(candles, ...t.supertrend) : null,
        vwap: t.vwap ? sessionVwap(candles) : null,
        rsi: rsi(closes, t.rsiPeriod),
        hist: t.macd ? macdHistogram(closes, ...t.macd) : null,
        volMa: sma(candles.map((c) => c.volume), t.volumeMa),
        bb: bollinger(closes, ...t.bollinger),
        atr: atrWilder(candles, t.atrPeriod),
      };
      trendCache.set(key, ind);
    }
    return ind;
  }

  /** Trend model: close the tier's position on this symbol when the Supertrend flips against it. */
  function trendExits(tier: Tier, symbol: string, time: number) {
    const plan = cfg.tiers[tier];
    const t = plan.trend ?? DEFAULT_TREND;
    if (!t.exitOnFlip || !t.supertrend) return;
    const b = bar(symbol, plan.entryTf, time);
    if (!b) return;
    const dir = trendIndicators(symbol, plan.entryTf, t).st!.dir[b.i];
    if (dir == null) return;
    for (const open of positions.filter((p) => p.symbol === symbol && p.tier === tier)) {
      if ((dir === 1 && open.side === 'short') || (dir === -1 && open.side === 'long')) {
        const m = markBar(symbol, time) ?? b.c;
        exit(open, m.close, open.qty, 'reverse', time, 'close');
      }
    }
  }

  /** The owner's trend / mean-reversion model on the entry timeframe. */
  function trendStrategy(tier: Tier, symbol: string, time: number, reject: (r: string) => void): Candidate | null {
    const plan = cfg.tiers[tier];
    const t = plan.trend ?? DEFAULT_TREND;
    const b = bar(symbol, plan.entryTf, time);
    const candles = data[symbol]!.candles[plan.entryTf];
    if (!b || !candles) return null;
    const i = b.i;
    const ind = trendIndicators(symbol, plan.entryTf, t);
    const fast = ind.fast[i];
    const slow = ind.slow[i];
    const r = ind.rsi[i];
    const atr = ind.atr[i];
    if (fast == null || slow == null || r == null || atr == null || i < Math.max(t.rsiLookback, 2)) return null;
    const close = b.c.close;
    const dir = ind.st?.dir[i] ?? null;
    if (ind.st && dir == null) return null;
    const hist = ind.hist ? ind.hist[i] : null;
    if (ind.hist && hist == null) return null;
    const vw = ind.vwap ? ind.vwap[i] : null;
    if (ind.vwap && vw == null) return null;

    // Volume confirmation: this bar against the average of the previous `volumeMa` bars.
    if (t.volumeMult > 0) {
      const v = b.c.volume;
      const avg = ind.volMa[i - 1];
      if (v == null || avg == null || !(v >= t.volumeMult * avg)) return null;
    }

    for (const side of ['long', 'short'] as const) {
      const long = side === 'long';
      // RSI trigger within the lookback.
      let rsiOk = false;
      for (let j = i - t.rsiLookback + 1; j <= i && !rsiOk; j++) {
        const pr = ind.rsi[j - 1];
        const cr = ind.rsi[j];
        if (pr == null || cr == null) continue;
        const cross50 = long ? pr <= 50 && cr > 50 : pr >= 50 && cr < 50;
        const outOfZone = long ? pr < t.oversold && cr >= t.oversold : pr > t.overbought && cr <= t.overbought;
        rsiOk = t.rsiTrigger === 'cross50' ? cross50 : t.rsiTrigger === 'oversold' ? outOfZone : cross50 || outOfZone;
      }
      if (!rsiOk) continue;
      if (t.mode === 'trend') {
        if (long ? !(close > slow && fast > slow) : !(close < slow && fast < slow)) continue;
        if (dir != null && dir !== (long ? 1 : -1)) continue;
      } else {
        // Mean reversion: the previous close was beyond the band, this one is back inside.
        const pl = ind.bb.lower[i - 1]; const pu = ind.bb.upper[i - 1];
        const cl = ind.bb.lower[i]; const cu = ind.bb.upper[i];
        if (pl == null || pu == null || cl == null || cu == null) continue;
        const pc = candles[i - 1]!.close;
        if (long ? !(pc < pl && close >= cl) : !(pc > pu && close <= cu)) continue;
      }
      if (vw != null && (long ? close <= vw : close >= vw)) continue;
      if (hist != null && (long ? hist < 0 : hist > 0)) continue;
      setupsSeen++;
      if (t.useBias) {
        const bias = biasFor(symbol, tier, time).combined;
        if (bias !== side) { reject(`bias ${bias}`); return null; }
      }
      let source: Source = 'core';
      if (t.useRrg && !coreSet.has(symbol)) {
        const gate = rrgGate(symbol, tier);
        if (!gate) { reject('no RRG signal'); return null; }
        if (gate.side !== side) { reject('RRG direction'); return null; }
        source = gate.source;
      }
      const stop = long ? close - t.stopAtr * atr : close + t.stopAtr * atr;
      const rr = t.rewardR ?? plan.rewardR;
      const takeProfit = long ? close + rr * (close - stop) : close - rr * (stop - close);
      return { side, entry: close, stop, source, takeProfit, market: true };
    }
    return null;
  }

  // The clock: BTC's 15m closes inside [from, to].
  const q = intervalMs('15m');
  const clock = data.BTCUSDT!.candles['15m']!.map((c) => c.openTime + q).filter((t) => t > cfg.from && t <= cfg.to);
  let prev = clock.length ? clock[0]! - q : cfg.from;
  for (const time of clock) {
    if (day < 0) day = utcDay(time);
    // The bar ending at 00:00 (and the 00:00 funding) belong to the day that
    // just ended; entries at 00:00 belong to the new one.
    manageBar(time);
    applyFunding(prev, time);
    if (cfg.circuitBreaker) {
      if (breakerUntil && time >= breakerUntil) { breakerUntil = 0; equityPeak = equity; }
      equityPeak = Math.max(equityPeak, equity);
      if (!breakerUntil && equity <= equityPeak * (1 - cfg.circuitBreaker.drawdownPct / 100)) {
        breakerUntil = time + cfg.circuitBreaker.pauseDays * 86_400_000;
        warnings.push(`circuit breaker: ${cfg.circuitBreaker.drawdownPct}% below the peak on ${new Date(time).toISOString().slice(0, 10)}; entries paused ${cfg.circuitBreaker.pauseDays} days`);
      }
    }
    if (utcDay(time) !== day) {
      day = utcDay(time);
      dayStartEquity = equity;
      for (const t of TIERS) realizedToday[t] = 0;
    }
    // Trailing only moves when the trail timeframe's bar closes (checked inside).
    trail(time);
    for (const tf of ['1h', '4h', '1d'] as Tf[]) {
      if (time % intervalMs(tf) !== 0) continue;
      if (TIERS.some((t) => cfg.tiers[t].enabled && cfg.tiers[t].rrgTfs.includes(tf))) scanRrg(tf, time);
    }
    // Higher tiers look first: on a shared bar close they get the risk budget before the lower ones.
    for (const t of TIERS) if (cfg.tiers[t].enabled && time % intervalMs(cfg.tiers[t].entryTf) === 0) lookForEntries(t, time);
    prev = time;
  }

  const end = clock.at(-1) ?? cfg.to;
  const open: BacktestResult['open'] = { positions: [], pending: [] };
  if (mode.closeAtEnd) {
    // Close whatever is still open at the last close.
    for (const p of [...positions]) {
      const m = markBar(p.symbol, end) ?? data[p.symbol]!.candles['15m']?.at(-1);
      if (m) exit(p, m.close, p.qty, 'end', end, 'close');
    }
    expired += pending.length;
  } else {
    for (const p of positions) {
      const last = markBar(p.symbol, end)?.close ?? data[p.symbol]!.candles['15m']?.at(-1)?.close ?? p.entry;
      open.positions.push({
        symbol: p.symbol, tier: p.tier, side: p.side, source: p.source, openedAt: p.openedAt,
        entry: p.entry, stop: p.stop, initialStop: p.initialStop, takeProfit: p.tp, qty: p.qty, qtyInitial: p.qtyInitial,
        riskAmount: p.riskAmount, realizedNet: p.gross - p.fees + p.funding,
        unrealizedPnl: (p.side === 'long' ? last - p.entry : p.entry - last) * p.qty, lastPrice: last, ...(p.rrg != null ? { rrg: p.rrg } : {}),
      });
    }
    open.pending = pending.map((o) => ({
      symbol: o.symbol, tier: o.tier, side: o.side, source: o.source, entry: o.entry, stop: o.stop, takeProfit: o.tp, qty: o.qty, placedAt: o.placedAt, expiresAt: o.expiresAt, ...(o.rrg != null ? { rrg: o.rrg } : {}),
    }));
  }

  const radar = mode.radar ? { time: end, rows: buildRadar(end) } : undefined;
  return { config: cfg, trades, open, equityCurve, endEquity: equity, setupsSeen, expired, rejected, warnings, radar };

  /** Whether RRG stops an extra symbol from trading `dir`, under cfg.extrasRrg. */
  function rrgBlocks(core: boolean, rrg: { side: Side } | null, dir: Side): boolean {
    if (core) return false;
    const mode = cfg.extrasRrg ?? 'required';
    if (mode === 'required') return !rrg || rrg.side !== dir;
    if (mode === 'veto') return rrg != null && rrg.side !== dir;
    return false;
  }

  /**
   * Radar for screened-signal strategies (EMA 50): each strategy's position or
   * order on its own row; otherwise one row per coin, shared by every strategy
   * on that signal, saying where the daily trend stands.
   */
  function signalRadar(time: number, tiers: Tier[]): RadarRow[] {
    const rows: RadarRow[] = [];
    const px = (x: number) => Number(x.toPrecision(6));
    const plan0 = cfg.tiers[tiers[0]!];
    const tf = plan0.entryTf;
    for (const symbol of symbols) {
      const core = coreSet.has(symbol);
      const ev = signalEvents(plan0, symbol);
      let i = -1;
      if (ev) for (let k = ev.closeAt.length - 1; k >= 0; k--) if (ev.closeAt[k]! <= time) { i = k; break; }
      const t = i >= 0 && ev?.trend ? ev.trend[i]! : 0;
      const dir: 'long' | 'short' | 'neutral' = t > 0 ? 'long' : t < 0 ? 'short' : 'neutral';
      const reasons = dir === 'long' ? ['daily close above a rising EMA 50'] : dir === 'short' ? ['daily close below a falling EMA 50'] : ['daily close and EMA 50 slope disagree'];
      const bias: RadarRow['bias'] = { combined: dir, byTf: [{ tf, direction: dir, reasons }] };
      const recent = (tier: Tier) => rejected
        .filter((r) => r.symbol === symbol && r.tier === tier && r.time > time - 86_400_000)
        .slice(-5).reverse().map((r) => ({ time: r.time, reason: r.reason }));
      let any = false;
      for (const tier of tiers) {
        const pos = positions.find((p) => p.symbol === symbol && p.tier === tier);
        const ord = pending.find((o) => o.symbol === symbol && o.tier === tier);
        if (!pos && !ord) continue;
        any = true;
        const note = pos ? `${pos.side} open from ${px(pos.entry)}, stop ${px(pos.stop)}, target ${px(pos.tp)}` : `${ord!.side} entry at the next open, stop ${px(ord!.stop)}, target ${px(ord!.tp)}`;
        rows.push({ symbol, tier, core, status: pos ? 'in-position' : 'order-pending', note, bias, rrg: null, watch: null, gates: [], recentRejections: recent(tier), model: 'signal' });
      }
      if (any) continue;
      const gates: string[] = [];
      const paused = tiers.every((tier) => mode.entriesBlocked?.(tier, time)) ? mode.entriesBlocked?.(tiers[0]!, time) : null;
      if (paused) gates.push(paused);
      const fired = i >= 0 && ev ? ev.sig[i]! : 0;
      const trendStarted = i > 0 && ev?.trend ? ev.trend[i]! !== 0 && ev.trend[i]! !== ev.trend[i - 1]! : false;
      let note: string;
      if (fired) note = `EMA 50 trend ${fired > 0 ? 'long' : 'short'} signal on the last daily close`;
      else if (trendStarted) note = `a ${dir} trend started on the last daily close, but volatility was outside its normal range: skipped`;
      else if (dir === 'neutral') note = 'no daily trend: waiting for the close and the EMA 50 slope to agree';
      else note = `in a daily ${dir} trend already; the next entry comes when a new trend starts`;
      rows.push({
        symbol, tier: tiers[0]!, core, status: fired ? 'watching' : dir === 'neutral' ? 'blocked' : 'ready', note, bias, rrg: null, watch: null,
        gates, recentRejections: tiers.flatMap(recent).sort((a, b) => b.time - a.time).slice(0, 5), model: 'signal', shared: tiers.length > 1,
      });
    }
    return rows;
  }

  function buildRadar(time: number): RadarRow[] {
    const rows: RadarRow[] = [];
    const px = (x: number) => Number(x.toPrecision(6));
    // The default strategy (MTF) first: shared rows are filed under it.
    const signalTiers = (['MTF', 'HTF', 'LTF'] as Tier[]).filter((t) => cfg.tiers[t].enabled && cfg.tiers[t].model === 'signal' && cfg.tiers[t].signal);
    if (signalTiers.length) rows.push(...signalRadar(time, signalTiers));
    for (const tier of TIERS) {
      const plan = cfg.tiers[tier];
      if (!plan.enabled || signalTiers.includes(tier)) continue;
      const tr = cfg.risk.tiers[tier];
      for (const symbol of symbols) {
        const core = coreSet.has(symbol);
        const bias = biasFor(symbol, tier, time);
        const rrg = core ? null : rrgGate(symbol, tier);
        const pos = positions.find((p) => p.symbol === symbol && p.tier === tier);
        const ord = pending.find((o) => o.symbol === symbol && o.tier === tier);

        const gates: string[] = [];
        const paused = mode.entriesBlocked?.(tier, time);
        if (paused) gates.push(paused);
        if (tr.killzones && !killzoneAt(time, tr.killzones)) gates.push(`outside ${tier} killzones (${tr.killzones.map((k) => k.name).join(', ')})`);
        const nextFunding = fundingOf(symbol).find((f) => f.time > time)?.time ?? nextFundingAfter(time, intervalOf(symbol));
        if (nextFunding - time <= cfg.risk.fundingGapMinutes * 60_000) gates.push('funding settlement within 15 min');
        if (-realizedToday[tier] >= (tr.dailyLossPct / 100) * dayStartEquity) gates.push(`${tier} daily loss limit reached`);
        if (tier === 'LTF' && cfg.risk.ltfRequiresMtf && !positions.some((p) => p.symbol === symbol && p.tier === 'MTF')) {
          gates.push('LTF only trades alongside an open MTF position');
        }

        let watch: RadarRow['watch'] = null;
        const list = data[symbol]!.candles[plan.entryTf];
        const a = analysis[symbol]![plan.entryTf];
        const i = list ? barAt(list, intervalMs(plan.entryTf), time) : -1;
        if (a && list && i >= 0) {
          const lastClose = list[i]!.close;
          const w = watchSweeps(a, i, cfg.setup).find((x) => x.side === bias.combined) ?? null;
          if (w) {
            watch = {
              side: w.side, sweptLevel: px(w.sweptLevel), mssLevel: px(w.mssLevel), lastClose,
              distancePct: Number((((w.mssLevel - lastClose) / lastClose) * 100 * (w.side === 'long' ? 1 : -1)).toFixed(2)), barsLeft: w.barsLeft,
            };
          }
        }

        let status: RadarRow['status'];
        let note: string;
        const dir = bias.combined;
        if (pos) {
          status = 'in-position';
          note = `${pos.side} open from ${px(pos.entry)}, stop ${px(pos.stop)}, target ${px(pos.tp)}`;
        } else if (ord) {
          status = 'order-pending';
          note = `${ord.side} limit at ${px(ord.entry)}, stop ${px(ord.stop)}, target ${px(ord.tp)}`;
        } else if (dir === 'neutral') {
          status = 'blocked';
          note = `no ${plan.biasTfs.join('/')} bias: structure and confluence don't agree`;
        } else if (rrgBlocks(core, rrg, dir)) {
          status = 'blocked';
          note = rrg ? `bias ${dir} but the RRG signal points ${rrg.side}` : `bias ${dir}, but no RRG rotation signal for ${tier}`;
        } else if (watch) {
          status = 'watching';
          const word = watch.side === 'long' ? 'above' : 'below';
          note = `swept ${watch.side === 'long' ? 'sell' : 'buy'}-side liquidity at ${watch.sweptLevel}; needs a ${plan.entryTf} close ${word} ${watch.mssLevel} `
            + `(${Math.abs(watch.distancePct)}% away) within ${watch.barsLeft} bars, with displacement`;
        } else {
          status = 'ready';
          note = `bias ${dir}: waiting for a ${plan.entryTf} sweep of ${dir === 'long' ? 'a swing low' : 'a swing high'}`;
        }
        const recentRejections = rejected
          .filter((r) => r.symbol === symbol && r.tier === tier && r.time > time - 86_400_000)
          .slice(-5).reverse().map((r) => ({ time: r.time, reason: r.reason }));
        rows.push({ symbol, tier, core, status, note, bias, rrg, watch, gates, recentRejections });
      }
    }
    return rows;
  }
}
