// Rotation scanner: classifies every symbol against BTC and ETH on one
// timeframe and returns a ranked watchlist. Pure: the caller supplies
// aligned closes (and optionally volume and funding) for every symbol,
// including BTCUSDT and ETHUSDT, which double as the benchmarks.

import { absoluteTrend, fundingFlag, relativeVolume } from '@bot/rrg';
import { classifyReading, readRrg } from './classify';
import { BENCHMARKS, CORE_SYMBOLS, resolveConfig, routeSignal, type ClassifierConfig } from './config';
import {
  absoluteTrendScore, agreementScore, fundingScore, relativeVolumeScore, timeInQuadrantScore,
  velocityScore, weightedScore, type OtherBenchmark,
} from './score';
import type {
  Benchmark, Classification, Filters, RrgReading, SignalType, SkipReason, SymbolSeries, Timeframe,
  Watchlist, WatchlistEntry,
} from './types';

export interface ScanInput {
  timeframe: Timeframe;
  /** Keyed by symbol, e.g. BTCUSDT. Must include the benchmark symbols. */
  series: Readonly<Record<string, SymbolSeries>>;
  /** Defaults to BTCUSDT, ETHUSDT, XRPUSDT. */
  core?: ReadonlyArray<string>;
  config?: Partial<ClassifierConfig>;
}

const BENCHMARK_KEYS = Object.keys(BENCHMARKS) as Benchmark[];
const SIGNAL_ORDER: SignalType[] = ['LEADING_ENTRY', 'LAGGING_BREAKOUT', 'WEAKENING_HOOK', 'SHORT_ROLLOVER'];

function validCloses(close: ReadonlyArray<number>): boolean {
  return close.every((c) => Number.isFinite(c) && c > 0);
}

interface Slot {
  benchmark: Benchmark;
  reading: RrgReading | null;
  classification: Classification | null;
}

export function buildWatchlist(input: ScanInput): Watchlist {
  const cfg = resolveConfig(input.config);
  const core = new Set(input.core ?? CORE_SYMBOLS);

  const bench = {} as Record<Benchmark, ReadonlyArray<number>>;
  for (const b of BENCHMARK_KEYS) {
    const s = input.series[BENCHMARKS[b]];
    if (!s) throw new Error(`Benchmark ${BENCHMARKS[b]} is missing from the scan input`);
    if (!validCloses(s.close)) throw new Error(`Benchmark ${BENCHMARKS[b]} has non-positive or non-finite closes`);
    bench[b] = s.close;
  }
  const bars = bench.BTC.length;
  if (bench.ETH.length !== bars) throw new Error('BTCUSDT and ETHUSDT closes are not the same length');

  const entries: WatchlistEntry[] = [];
  const skipped: Watchlist['skipped'] = [];
  const skip = (symbol: string, reason: SkipReason) => skipped.push({ symbol, reason });

  for (const [symbol, s] of Object.entries(input.series)) {
    if (s.close.length !== bars || (s.volume != null && s.volume.length !== bars)) { skip(symbol, 'length-mismatch'); continue; }
    if (!validCloses(s.close)) { skip(symbol, 'bad-data'); continue; }

    // One slot per benchmark. A symbol isn't read against itself; that slot
    // stays empty and counts as "no second read" for agreement.
    const slots: Slot[] = BENCHMARK_KEYS.map((b) => {
      const reading = BENCHMARKS[b] === symbol ? null : readRrg(s.close, bench[b], b, cfg);
      return { benchmark: b, reading, classification: reading && classifyReading(reading, cfg) };
    });
    const readable = slots.filter((sl) => BENCHMARKS[sl.benchmark] !== symbol);
    if (readable.every((sl) => !sl.reading)) { skip(symbol, 'insufficient-history'); continue; }

    const end = bars - 1;
    const fundingPct = s.fundingAnnualizedPct ?? null;
    const filters: Filters = {
      relativeVolume: relativeVolume(s.volume ?? null, end, cfg.relVolShortBars, cfg.relVolLongBars),
      absoluteTrend: absoluteTrend(s.close, end, cfg.trendSmaBars),
      funding: fundingFlag(fundingPct),
      fundingAnnualizedPct: fundingPct,
    };
    const readings: WatchlistEntry['readings'] = {};
    for (const sl of slots) if (sl.reading) readings[sl.benchmark] = sl.reading;

    for (const signal of SIGNAL_ORDER) {
      const fired = slots.filter((sl) => sl.classification?.signal === signal);
      if (fired.length === 0) continue;
      const direction = fired[0]!.classification!.direction;
      const firedReadings = fired.map((sl) => sl.reading!);
      const others: OtherBenchmark[] = slots.filter((sl) => !fired.includes(sl));

      const components = {
        agreement: agreementScore(signal, direction, others),
        velocity: velocityScore(firedReadings, cfg),
        timeInQuadrant: timeInQuadrantScore(firedReadings, cfg),
        relativeVolume: relativeVolumeScore(filters.relativeVolume, cfg),
        absoluteTrend: absoluteTrendScore(filters.absoluteTrend, direction),
        funding: fundingScore(filters.funding, direction),
      };

      entries.push({
        symbol,
        timeframe: input.timeframe,
        signal,
        direction,
        tiers: routeSignal(signal, input.timeframe),
        core: core.has(symbol),
        score: weightedScore(components, cfg.weights),
        components,
        firedOn: fired.map((sl) => sl.benchmark),
        readings,
        filters,
        reasons: [...fired.flatMap((sl) => sl.classification!.reasons), ...filterNotes(filters)],
      });
    }
  }

  entries.sort((a, b) => b.score - a.score
    || a.symbol.localeCompare(b.symbol)
    || SIGNAL_ORDER.indexOf(a.signal) - SIGNAL_ORDER.indexOf(b.signal));
  return { timeframe: input.timeframe, entries, skipped };
}

function filterNotes(f: Filters): string[] {
  const out: string[] = [];
  if (f.relativeVolume != null) out.push(`volume ${f.relativeVolume.toFixed(2)}× its average`);
  if (f.absoluteTrend) out.push(`${f.absoluteTrend.pct >= 0 ? '+' : ''}${f.absoluteTrend.pct.toFixed(1)}% vs its own SMA`);
  if (f.funding) out.push(`funding ${f.funding} (${f.fundingAnnualizedPct!.toFixed(1)}%/yr)`);
  return out;
}
