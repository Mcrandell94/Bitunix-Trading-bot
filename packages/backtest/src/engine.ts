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
import { buildWatchlist, type SymbolSeries, type Timeframe, type WatchlistEntry } from '@bot/signals';
import { analyze, barAt, biasAt, combineBias, detectSetup, insideZone, roomToLiquidity, swingsKnownAt, unmitigatedZones, watchSweeps, type Direction, type SeriesAnalysis } from '@bot/smc';
import { FOMC_TIMES, NO_FILTERS, type BacktestConfig, type BacktestResult, type Fill, type FundingPoint, type RadarRow, type Source, type SymbolData, type Tf, type Trade } from './types';

const BENCH = ['BTCUSDT', 'ETHUSDT'];
const TFS: Tf[] = ['15m', '1h', '4h', '1d'];
const DEFAULT_LIMITS: ContractLimits = { qtyStep: 1e-6, minQty: 1e-6 };

interface Pending {
  symbol: string; tier: Tier; side: Side; source: Source;
  entry: number; stop: number; tp: number; qty: number; placedAt: number; expiresAt: number;
}

interface Position {
  id: number; symbol: string; tier: Tier; side: Side; source: Source;
  entry: number; stop: number; initialStop: number; tp: number;
  qtyInitial: number; qty: number; riskAmount: number; openedAt: number;
  partialsHit: number; fills: Fill[]; gross: number; fees: number; funding: number;
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
  let day = -1;
  let dayStartEquity = equity;
  const realizedToday: Record<Tier, number> = { LTF: 0, MTF: 0 };
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

  function exit(p: Position, rawPrice: number, qty: number, reason: Fill['reason'], time: number) {
    // Resting limit targets fill at their price as maker; everything else is a market fill.
    const maker = cfg.targetFill === 'maker' && (reason === 'target' || reason === 'partial');
    const price = maker ? rawPrice : slip(rawPrice, p.side, true);
    const gross = (p.side === 'long' ? price - p.entry : p.entry - price) * qty;
    const fee = price * qty * (maker ? cfg.fees.maker : cfg.fees.taker);
    p.qty = Number((p.qty - qty).toFixed(12));
    p.gross += gross;
    p.fees += fee;
    p.fills.push({ time, price, qty, fee, reason });
    book(p.tier, gross - fee, time);
    if (p.qty <= 0) {
      const net = p.gross - p.fees + p.funding;
      trades.push({
        id: p.id, symbol: p.symbol, tier: p.tier, side: p.side, source: p.source, openedAt: p.openedAt, closedAt: time,
        entry: p.entry, initialStop: p.initialStop, riskAmount: p.riskAmount, qty: p.qtyInitial, fills: p.fills,
        grossPnl: p.gross, fees: p.fees, funding: p.funding, netPnl: net, r: net / p.riskAmount,
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
      const touched = long ? b.low <= o.entry : b.high >= o.entry;
      if (!touched) continue;
      const gapped = long ? b.open < o.entry : b.open > o.entry;
      const price = gapped ? slip(b.open, o.side, false) : o.entry;
      const fee = price * o.qty * (gapped ? cfg.fees.taker : cfg.fees.maker);
      pending = pending.filter((x) => x !== o);
      const p: Position = {
        id: nextId++, symbol: o.symbol, tier: o.tier, side: o.side, source: o.source,
        entry: price, stop: o.stop, initialStop: o.stop, tp: o.tp, qtyInitial: o.qty, qty: o.qty,
        riskAmount: Math.abs(price - o.stop) * o.qty, openedAt: time, partialsHit: 0,
        fills: [{ time, price, qty: o.qty, fee, reason: 'entry' }], gross: 0, fees: fee, funding: 0,
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
        exit(p, gapped ? m.open : p.stop, p.qty, 'stop', time);
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
      if (plan.breakevenAtR != null && reached(plan.breakevenAtR)) {
        p.stop = long ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry);
      }
      if (long ? m.high >= p.tp : m.low <= p.tp) exit(p, p.tp, p.qty, 'target', time);
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

  function trail(time: number) {
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

    const bias = biasFor(symbol, tier, time).combined;
    if (bias !== setup.side) { reject(`bias ${bias}`); return null; }

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
    return { side: setup.side, entry: setup.entry, stop: setup.stop, source };
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

    if (f.fomcBlackoutMinutes > 0) {
      const w = f.fomcBlackoutMinutes * 60_000;
      if (FOMC_TIMES.some((t) => Math.abs(t - time) <= w)) return 'FOMC blackout';
    }
    return null;
  }

  function lookForEntries(tier: Tier, time: number) {
    const plan = cfg.tiers[tier];
    for (const symbol of symbols) {
      if (plan.symbols && !plan.symbols.includes(symbol)) continue;
      const reject = (reason: string) => rejected.push({ time, symbol, tier, reason });
      const cand = override ? override({ tier, symbol, time }) : strategy(tier, symbol, time, reject);
      if (!cand) continue;
      if (override) setupsSeen++;
      const paused = mode.entriesBlocked?.(tier, time);
      if (paused) { reject(paused); continue; }

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
      const br = bracket(cand.side, cand.entry, cand.stop, plan.rewardR);
      const decision = checkEntry(
        { symbol, tier, side: cand.side, bracket: br, limits: data[symbol]!.limits ?? DEFAULT_LIMITS },
        state, { time, nextFundingTime: nextFunding }, cfg.risk,
      );
      if (!decision.ok) { reject(decision.reason); continue; }
      pending.push({
        symbol, tier, side: cand.side, source: cand.source, entry: br.entry, stop: br.stop, tp: br.takeProfit,
        qty: decision.sizing.qty, placedAt: time, expiresAt: time + plan.expiryBars * intervalMs(plan.entryTf),
      });
    }
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
    if (utcDay(time) !== day) {
      day = utcDay(time);
      dayStartEquity = equity;
      realizedToday.LTF = 0;
      realizedToday.MTF = 0;
    }
    // Trailing only moves when the trail timeframe's bar closes (checked inside).
    trail(time);
    for (const tf of ['1h', '4h', '1d'] as Tf[]) {
      if (time % intervalMs(tf) !== 0) continue;
      if (cfg.tiers.LTF.rrgTfs.includes(tf) || cfg.tiers.MTF.rrgTfs.includes(tf)) scanRrg(tf, time);
    }
    if (cfg.tiers.MTF.enabled && time % intervalMs(cfg.tiers.MTF.entryTf) === 0) lookForEntries('MTF', time);
    if (cfg.tiers.LTF.enabled && time % intervalMs(cfg.tiers.LTF.entryTf) === 0) lookForEntries('LTF', time);
    prev = time;
  }

  const end = clock.at(-1) ?? cfg.to;
  const open: BacktestResult['open'] = { positions: [], pending: [] };
  if (mode.closeAtEnd) {
    // Close whatever is still open at the last close.
    for (const p of [...positions]) {
      const m = markBar(p.symbol, end) ?? data[p.symbol]!.candles['15m']?.at(-1);
      if (m) exit(p, m.close, p.qty, 'end', end);
    }
    expired += pending.length;
  } else {
    for (const p of positions) {
      const last = markBar(p.symbol, end)?.close ?? data[p.symbol]!.candles['15m']?.at(-1)?.close ?? p.entry;
      open.positions.push({
        symbol: p.symbol, tier: p.tier, side: p.side, source: p.source, openedAt: p.openedAt,
        entry: p.entry, stop: p.stop, initialStop: p.initialStop, takeProfit: p.tp, qty: p.qty, qtyInitial: p.qtyInitial,
        riskAmount: p.riskAmount, realizedNet: p.gross - p.fees + p.funding,
        unrealizedPnl: (p.side === 'long' ? last - p.entry : p.entry - last) * p.qty, lastPrice: last,
      });
    }
    open.pending = pending.map((o) => ({
      symbol: o.symbol, tier: o.tier, side: o.side, source: o.source, entry: o.entry, stop: o.stop, takeProfit: o.tp, qty: o.qty, placedAt: o.placedAt, expiresAt: o.expiresAt,
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

  function buildRadar(time: number): RadarRow[] {
    const rows: RadarRow[] = [];
    const px = (x: number) => Number(x.toPrecision(6));
    for (const tier of ['MTF', 'LTF'] as Tier[]) {
      const plan = cfg.tiers[tier];
      if (!plan.enabled) continue;
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
