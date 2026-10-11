// ETH bot research (owner 2026-10-11: "Take everything you have access to and build an ETH specific bot"; swing and
// intraday as separate parts, long and short, Binance history from 2020 for research, Bitunix prices to confirm, live
// trades on Bitunix). Plan: research on ETH alone, so the guard against luck is time: rules fixed before the runs, judged
// on an early and a late period separately, the last months locked.
//
// PHASE A, THE DATA CHECK (fixed before the run). Binance USDT-M ETHUSDT against Bitunix ETHUSDT over their overlap
// (Bitunix 1h from late 2022, funding from 2024-03-04) up to the research end:
//   - 1h close-to-close log return correlation >= 0.98 over the matched bars;
//   - close difference |Binance / Bitunix - 1|: median <= 0.2%, 99th percentile <= 1%;
//   - daily funding sign agreement >= 80% (UTC-day sums of the settlement rates, days where both are non-zero);
//   - missing Binance bars (ETH and BTC, every timeframe) <= 1% of the span.
// Any check failing = the Binance history does not stand in for Bitunix ETH: stop and report, no screen.

import type { Candle } from '@bot/marketdata';
import { binanceCandles, binanceFunding, klineGaps, type Archive, type BinanceCandle } from '../binancevision';
import type { FundingPoint, Tf } from '../types';

const DAY = 86_400_000;
const at = (s: string) => Date.parse(`${s}T00:00:00Z`);
/** Fixed dates (not moving with today): development, validation, and the locked holdout after the research end. */
export const ETH_PERIODS = { dev: { from: at('2020-01-01'), to: at('2024-01-01') }, val: { from: at('2024-01-01'), to: at('2026-04-12') }, holdoutFrom: at('2026-04-12') } as const;
export const ETH_TFS: readonly Tf[] = ['15m', '1h', '4h', '1d'];
/** Binance lists ETHUSDT and BTCUSDT perps from late 2019; loading starts there so the indicators warm up before 2020. */
export const ETH_LOAD_FROM = at('2019-09-01');

export interface EthSeries { candles: Record<Tf, BinanceCandle[]>; funding: FundingPoint[] }

/** ETH or BTC from the Binance archive: every timeframe and the funding settlements over [from, to). */
export async function loadBinanceSeries(a: Archive, symbol: string, from: number, to: number): Promise<EthSeries> {
  const candles = {} as Record<Tf, BinanceCandle[]>;
  for (const tf of ETH_TFS) {
    candles[tf] = await binanceCandles(a, symbol, tf, from, to);
    a.log(`binance ${symbol} ${tf}: ${candles[tf].length} bars, ${klineGaps(candles[tf], tf)} missing`);
  }
  return { candles, funding: await binanceFunding(a, symbol, from, to) };
}

const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };
function corr(x: number[], y: number[]): number {
  const n = x.length, mx = x.reduce((p, q) => p + q, 0) / n, my = y.reduce((p, q) => p + q, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; syy += (y[i]! - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const daySums = (fs: ReadonlyArray<FundingPoint>) => { const m = new Map<number, number>(); for (const f of fs) { const d = f.time - (f.time % DAY); m.set(d, (m.get(d) ?? 0) + f.rate); } return m; };

export interface DataCheck { ok: boolean; lines: string[] }
/** Phase A: Binance against Bitunix ETH on matched 1h bars and UTC-day funding sums, with the gap counts. Pure. */
export function ethDataCheck(bin1h: ReadonlyArray<Candle>, bx1h: ReadonlyArray<Candle>, binFunding: ReadonlyArray<FundingPoint>, bxFunding: ReadonlyArray<FundingPoint>, gaps: ReadonlyArray<{ name: string; missing: number; span: number }>): DataCheck {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const bx = new Map(bx1h.map((b) => [b.openTime, b])), rb: number[] = [], rx: number[] = [], diff: number[] = [];
  let prev: [Candle, Candle] | null = null;
  for (const b of bin1h) {
    const x = bx.get(b.openTime);
    if (!x) { prev = null; continue; }
    diff.push(Math.abs(b.close / x.close - 1));
    if (prev && prev[0].openTime === b.openTime - 3_600_000) { rb.push(Math.log(b.close / prev[0].close)); rx.push(Math.log(x.close / prev[1].close)); }
    prev = [b, x];
  }
  const fb = daySums(binFunding), fx = daySums(bxFunding);
  let both = 0, agree = 0;
  const pb: number[] = [], px: number[] = [];
  for (const [d, x] of fx) { const b = fb.get(d); if (b == null) continue; pb.push(b); px.push(x); if (b !== 0 && x !== 0) { both++; if (Math.sign(b) === Math.sign(x)) agree++; } }
  const c = rb.length > 1 ? corr(rb, rx) : NaN, med = quantile(diff, 0.5), p99 = quantile(diff, 0.99), sign = both ? agree / both : NaN;
  const checks = [
    { name: '1h return correlation', ok: c >= 0.98, value: c.toFixed(4), need: '>= 0.98' },
    { name: 'median close difference', ok: med <= 0.002, value: `${(100 * med).toFixed(3)}%`, need: '<= 0.2%' },
    { name: '99th percentile close difference', ok: p99 <= 0.01, value: `${(100 * p99).toFixed(3)}%`, need: '<= 1%' },
    { name: 'daily funding sign agreement', ok: sign >= 0.8, value: `${(100 * sign).toFixed(1)}% of ${both} days`, need: '>= 80%' },
    ...gaps.map((g) => ({ name: `missing Binance bars, ${g.name}`, ok: g.span > 0 && g.missing <= 0.01 * g.span, value: `${g.missing} of ${g.span}`, need: '<= 1%' })),
  ];
  const ok = checks.every((x) => x.ok);
  const span = diff.length ? `${day(bin1h.find((b) => bx.has(b.openTime))!.openTime)} to ${day([...bin1h].reverse().find((b) => bx.has(b.openTime))!.openTime)}` : 'no overlap';
  return {
    ok,
    lines: [
      `ETH DATA CHECK (Binance USDT-M against Bitunix; rules fixed before the run): ${diff.length} matched 1h bars (${span}), ${rb.length} return pairs, ${pb.length} funding days (daily sum correlation ${pb.length > 1 ? corr(pb, px).toFixed(3) : '-'}).`,
      ...checks.map((x) => `  ${x.ok ? 'ok  ' : 'FAIL'} ${x.name}: ${x.value} (needs ${x.need})`),
      ok ? 'READ: the Binance history stands in for Bitunix ETH.' : 'READ: the sources disagree: stop here, no ETH screen on the Binance history.',
    ],
  };
}

/** The gap rows for the check: each loaded series from its first bar to the load end. */
export function gapRows(series: Readonly<Record<string, EthSeries>>): { name: string; missing: number; span: number }[] {
  const ms: Record<Tf, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': DAY };
  return Object.entries(series).flatMap(([sym, s]) => ETH_TFS.map((tf) => {
    const c = s.candles[tf];
    return { name: `${sym} ${tf}`, missing: klineGaps(c, tf), span: c.length ? Math.round((c[c.length - 1]!.openTime - c[0]!.openTime) / ms[tf]) + 1 : 0 };
  }));
}
