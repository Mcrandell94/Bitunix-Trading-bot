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
// Result (run 38117264524): passes (correlation 0.9998, median difference 0.000%, 99th 0.024%, funding 89.3% of 769
// days, no missing bars). Binance's archive starts both perps on 2020-01-01, so indicators warm up inside 2020.
//
// PHASE B, THE ETH SCREEN (fixed before the runs). ETH alone on the Binance history, every line with its existing
// rules (nothing tuned to ETH; ETH was one of the research coins those rules came from). Entries from 2020-01-01; the
// development period is 2020-01-01 to 2024-01-01, validation 2024-01-01 to 2026-04-12; the months since stay locked.
// Costs 0.22% a round trip in every line; funding (Binance settlements) is added per trade in R.
// Swing lines (4H / daily / weekly), each side its own line:
//   1-8  the live RSI models (rsisignals.ts, rule set option 1, each on its one exit SIGNAL_EXITS, the live code):
//        bottom-div, triple-div, under-floor (long); w-bear-div, w-top-div, d-fail-short, 4h-fail-short (short);
//        w-dbl-bottom (long). BTC daily from Binance for the shorts' BTC filter.
//   9-10 the funding squeeze live line (fvConfluenceTrades: 4H squeeze, 1H confirmation, stop 2 ATR(4H), 2R), long / short.
//   11   S/R Breaks 4H support "B" traded with the break (short), stop 2 ATR(14), 2R: the one line that worked on both
//        coin sets (srbreaks.ts, docs/RESULTS.md).
//   12-13 baseline trend: a daily close crossing the 50-day SMA the way the 50-day SMA sits against the 200-day
//        (long: close crosses over, 50 > 200; short mirrored); next open, stop 2 ATR(14), chandelier 3 ATR from entry.
//   14-15 baseline breakout: a daily close beyond the prior 55-day high (low); next open, stop 2 ATR(14), exit on the
//        20-day low (high) trail from entry.
// Intraday lines (15m / 1h):
//   16   15M-RSI10 long (rsi10live.ts, live rules, its one exit).
//   17-18 the RSI scalp (scalp2.ts), 1h, rising-RSI-low family, first per anchor, 4H RSI side, anchor 25 / 75, 3R:
//        the one line positive in both periods (as a short); its long mirror as the other side.
//   19   the 1h divergence short (ltfdiv.ts base: RSI 70 / confirm 50, daily RSI < 50, stop 1.5x the pattern stop,
//        stop >= 10 x the 0.22% cost, 3R, 120 bars), entered at the next open (taker) instead of the maker fill.
//   20-21 WaveTrend 1h (wavetrend.ts): wt1 crossing wt2 at or beyond -53 / +53, daily close on the trade's side of its
//        200-day SMA, stop past the 5-bar extreme + 0.2 ATR, 3R, 120 bars.
//   22-23 the funding squeeze on 1H bars (fundVolLtfReport's line, all signals): stop 2 ATR(1H), 2R.
//   24-25 baseline pullback: 1h RSI(2) under 10 (over 90) with the last daily close over (under) its 200-day SMA; next
//        open, stop 2 ATR(14), 2R.
// One trade at a time per line. Baselines (20 seeds): the same entry in a random direction; the same side at a random
// bar in the next 60 days with the same stop % and exit (the scalp, divergence and WaveTrend lines use the equivalent
// target + bar cap for their twins).
// A line QUALIFIES if, on development and on validation separately: >= 20 trades (swing) / >= 30 (intraday); avg R
// with funding > 0; random-direction edge > 0; timing edge > 0; avg R with funding still > 0 without its best 3 trades.
// Context filters, on qualifiers only: BTC daily close vs its 50-day SMA, ETH/BTC daily close vs its 50-day SMA, and
// the 24h funding sign, each split with / against the trade; a split is kept only if the same bucket beats the line's
// avg R with funding in both periods and keeps the line's minimum trades in both. If no line qualifies, there is no ETH
// bot. Qualifiers go to the locked months once, on the owner's go, then to Bitunix prices (2022 on).

import type { Candle } from '@bot/marketdata';
import { binanceCandles, binanceFunding, klineGaps, type Archive, type BinanceCandle } from '../binancevision';
import { atrWilder, rsi, sma } from '../indicators';
import type { FundingPoint, Tf } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { FV_LIVE, fundingR, funding8h, fvConfluenceTrades, fvEvents } from './fundvol';
import { BASE_DIV, regDivShorts } from './ltfdiv';
import { BE_R, frameworkSetups, planUsesBe, RSI_MODELS, rowsFromSetups, rsiFrameworkSignals, SIGNAL_EXITS, type RsiModelId, type RsiSignalRow, type Setup } from './rsisignals';
import { rsi10LiveSetups } from './rsi10live';
import { buildScalp2Rows, dirOk, lastClosed, scalp2Trade } from './scalp2';
import { srBreaks } from './srbreaks';
import { randomDirectionTwins, randomTimeTwins, timingEdge } from './timing';
import { waveTrend, wtCrosses } from './wavetrend';

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

// ---- Phase B: the ETH screen ----

const H = 3_600_000, SEEDS = 20, SPAN_DAYS = 60, SYM = 'ETHUSDT', COST = 0.22;
export type Part = 'swing' | 'intraday';
export interface EthLine { id: string; part: Part; label: string }
const SWING_MODELS: readonly RsiModelId[] = ['bottom-div', 'triple-div', 'under-floor', 'w-bear-div', 'w-top-div', 'w-dbl-bottom', 'd-fail-short', '4h-fail-short'];
const sides = (id: string, part: Part, label: string): EthLine[] => [{ id: `${id}:long`, part, label: `${label}, long` }, { id: `${id}:short`, part, label: `${label}, short` }];
export const ETH_LINES: readonly EthLine[] = [
  ...SWING_MODELS.map((m): EthLine => ({ id: `rsi:${m}`, part: 'swing', label: `${RSI_MODELS[m].label} (${RSI_MODELS[m].side}, ${SIGNAL_EXITS[m]!.exit.spec.name})` })),
  ...sides('fv4h', 'swing', 'Funding squeeze 4H + 1H confirmation (2R)'),
  { id: 'srb4h:short', part: 'swing', label: 'S/R Breaks 4H support "B" (short, 2R)' },
  ...sides('sma', 'swing', 'Baseline: daily close across the 50-day SMA with the 50/200 trend (chandelier 3 ATR)'),
  ...sides('dc', 'swing', 'Baseline: 55-day breakout (20-day trail)'),
  { id: 'rsi10:long', part: 'intraday', label: `15M-RSI10 (long, ${SIGNAL_EXITS['15m-rsi10']!.exit.spec.name})` },
  ...sides('scalp', 'intraday', 'RSI scalp 1h, rising RSI lows, first per anchor, 4H RSI side, 25 / 75 (3R)'),
  { id: 'div1h:short', part: 'intraday', label: '1h divergence (short, daily RSI < 50, 3R, 120 bars, taker entry)' },
  ...sides('wt1h', 'intraday', 'WaveTrend 1h at -53 / +53 with the 200-day SMA (3R, 120 bars)'),
  ...sides('fv1h', 'intraday', 'Funding squeeze 1H (2R)'),
  ...sides('rsi2', 'intraday', 'Baseline: 1h RSI(2) pullback with the 200-day SMA (2R)'),
];
export const MIN_TRADES: Record<Part, number> = { swing: 20, intraday: 30 };

/** One trade: entry time `t`, exit bar time `end`, R after costs, funding in R, and its two baselines' R. */
export interface EthTrade { line: string; d: 1 | -1; t: number; end: number; r: number; f: number; rand: number[]; rtime: number[] }

/** The trade row with funding (settlements from the entry to the exit bar's open, as fundvol.ts) and both baselines. */
function rowOf(line: string, c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, bar: number, j: number, stop: number, d: 1 | -1, spec: ExitSpec, fs: ReadonlyArray<FundingPoint>, r: number, end: number): EthTrade {
  const entry = c[j]!.open;
  return {
    line, d, t: c[j]!.openTime, end: c[end]!.openTime, r, f: fundingR(fs, d, c[j]!.openTime, c[end]!.openTime, entry, Math.abs(entry - stop)),
    rand: randomDirectionTwins(c, atr, SYM, j, stop, d, spec, SEEDS), rtime: randomTimeTwins(c, atr, SYM, j, stop, d, spec, Math.round((SPAN_DAYS * DAY) / bar), SEEDS),
  };
}
const sideOf = (d: 1 | -1) => (d > 0 ? 'long' : 'short');

/** Live-code rows of the RSI models (option 1, their one exit) re-simulated with specTrade; `tally` counts matches. */
function modelRows(rows: ReadonlyArray<RsiSignalRow>, setups: ReadonlyArray<Setup>, models: ReadonlySet<RsiModelId>, line: (m: RsiModelId) => string, fs: ReadonlyArray<FundingPoint>, from: number, tally: { rows: number; same: number }): EthTrade[] {
  const byKey = new Map(setups.map((s) => [`${s.model}|${s.known}`, s])), out: EthTrade[] = [];
  for (const r of rows) {
    if (!models.has(r.model) || !r.plans.includes('option 1') || r.enteredAt == null || r.enteredAt < from || r.r == null) continue;
    const s = byKey.get(`${r.model}|${r.signalAt}`), lx = SIGNAL_EXITS[r.model]?.exit;
    if (!s || !lx || s.j == null || s.stop == null || s.j >= s.c.length) continue;
    const spec = planUsesBe('option 1', r.model) ? { ...lx.spec, be: BE_R } : lx.spec, entry = s.c[s.j]!.open, stop = entry - lx.stopMult * (entry - s.stop);
    const tr = specTrade(s.c, s.atr, {}, s.j, stop, s.d, spec);
    tally.rows++;
    if (!tr) continue;
    if (Number(tr.r.toFixed(2)) === r.r) tally.same++;
    out.push(rowOf(line(r.model), s.c, s.atr, s.bar, s.j, stop, s.d, spec, fs, tr.r, tr.end));
  }
  return out;
}

/** Every line's ETH trades entered from `from` (candles oldest first, closed bars only; BTC daily for the shorts' filter). */
export function ethTrades(eth: EthSeries, btc: EthSeries, from: number): { trades: EthTrade[]; tally: { rows: number; same: number } } {
  const { '15m': m15, '1h': h1, '4h': h4, '1d': d1 } = eth.candles, fs = eth.funding, btcD1 = btc.candles['1d'], out: EthTrade[] = [];
  const tally = { rows: 0, same: 0 };
  if (d1.length < 60) return { trades: out, tally };
  const now = d1[d1.length - 1]!.openTime + DAY, push = (x: EthTrade) => { if (x.t >= from) out.push(x); };
  const atr1 = atrWilder(h1, 14), atr4 = atrWilder(h4, 14), atrD = atrWilder(d1, 14), cl = d1.map((b) => b.close);

  // 1-8: the live RSI models; 16: 15M-RSI10 (the same live-code path as livecheck.ts).
  const h4c = h4.filter((b) => b.openTime + 4 * H <= now);
  out.push(...modelRows(rsiFrameworkSignals(SYM, d1, h4c, now, 100_000, btcD1, { live: true }), frameworkSetups(d1, h4c), new Set(SWING_MODELS), (m) => `rsi:${m}`, fs, from, tally));
  if (m15.length >= 2000) {
    const st = rsi10LiveSetups(m15, h1, h4c, d1, Math.max(from, m15[0]!.openTime + 30 * DAY));
    out.push(...modelRows(rowsFromSetups(SYM, st, d1, now, 100_000, btcD1, { live: true }), st, new Set<RsiModelId>(['15m-rsi10']), () => 'rsi10:long', fs, from, tally));
  }

  // 9-10: the funding squeeze live line.
  const fv = fvConfluenceTrades(h4, h1, fs, H, from);
  for (const x of fv.trades) push(rowOf(`fv4h:${sideOf(x.d)}`, h1, fv.latr, H, x.j, x.stop, x.d, FV_LIVE.exit, fs, x.t.r, x.t.end));

  // 11: S/R Breaks 4H support "B", short.
  {
    const sr = srBreaks(h4), spec: ExitSpec = { name: '2R target', target: 2 };
    let busy = -1;
    for (let i = 1; i + 1 < h4.length; i++) {
      const a = atr4[i];
      if (sr.down[i] !== 'B' || a == null || !(a > 0) || i < busy) continue;
      const j = i + 1, stop = h4[j]!.open + 2 * a, tr = specTrade(h4, atr4, {}, j, stop, -1, spec);
      if (!tr) continue;
      busy = tr.open ? Infinity : tr.end;
      push(rowOf('srb4h:short', h4, atr4, 4 * H, j, stop, -1, spec, fs, tr.r, tr.end));
    }
  }

  // 12-15: the daily baselines.
  const s50 = sma(cl, 50), s200 = sma(cl, 200);
  const daily = (id: string, spec: ExitSpec, sig: (i: number, d: 1 | -1) => boolean) => {
    for (const d of [1, -1] as const) {
      let busy = -1;
      for (let i = 1; i + 1 < d1.length; i++) {
        const a = atrD[i];
        if (a == null || !(a > 0) || i < busy || !sig(i, d)) continue;
        const j = i + 1, stop = d1[j]!.open - d * 2 * a, tr = specTrade(d1, atrD, {}, j, stop, d, spec);
        if (!tr) continue;
        busy = tr.open ? Infinity : tr.end;
        push(rowOf(`${id}:${sideOf(d)}`, d1, atrD, DAY, j, stop, d, spec, fs, tr.r, tr.end));
      }
    }
  };
  daily('sma', { name: 'chandelier 3 ATR from entry', trail: { kind: 'chand', k: 3, arm: 0 } }, (i, d) => {
    const m = s50[i], pm = s50[i - 1], l = s200[i];
    return m != null && pm != null && l != null && d * (cl[i]! - m) > 0 && d * (cl[i - 1]! - pm) <= 0 && d * (m - l) > 0;
  });
  daily('dc', { name: '20-day trail from entry', trail: { kind: 'swing', k: 20, arm: 0 } }, (i, d) => {
    if (i < 55) return false;
    let x = d > 0 ? -Infinity : Infinity;
    for (let k = i - 55; k < i; k++) x = d > 0 ? Math.max(x, d1[k]!.high) : Math.min(x, d1[k]!.low);
    return d * (cl[i]! - x) > 0;
  });

  // 17-18: the RSI scalp's named line, both sides.
  const sc = buildScalp2Rows({ [SYM]: { candles: eth.candles } }, [SYM], from, now), p1 = sc.preps.get(SYM)?.['1h'];
  const capped = (t: number): ExitSpec => ({ name: `${t}R target, 120 bars`, target: t, cap: 120 });
  if (p1) for (const side of ['long', 'short'] as const) for (const x of sc.rows.get(`1h|${side}|hl|first|4h rsi|25|3R`) ?? []) {
    push(rowOf(`scalp:${side}`, p1.c, p1.atr, H, x.j, p1.c[x.j]!.open - x.d * x.risk, x.d, capped(3), fs, x.r, x.j + x.bars - 1));
  }

  // 19: the 1h divergence short, taker entry at the next open.
  {
    const r1 = rsi(h1.map((b) => b.close), 14), dr = rsi(cl, 14), spec = capped(3);
    let busy = -1;
    for (const e of regDivShorts(h1, r1, atr1, BASE_DIV)) {
      const j = e.i + 1, k = lastClosed(d1, DAY, h1[e.i]!.openTime + H);
      if (j >= h1.length || e.i < busy || k < 0 || dr[k] == null || !(dr[k]! < 50)) continue;
      const entry = h1[j]!.open, dist = 1.5 * Math.abs(e.stop - entry);
      if (!((100 * dist) / entry >= 10 * COST)) continue; // the K = 10 cost / stop gate
      const stop = entry + dist, tr = specTrade(h1, atr1, {}, j, stop, -1, spec);
      if (!tr) continue;
      busy = tr.open ? Infinity : tr.end;
      push(rowOf('div1h:short', h1, atr1, H, j, stop, -1, spec, fs, tr.r, tr.end));
    }
  }

  // 20-21: WaveTrend 1h.
  {
    const { wt1, wt2 } = waveTrend(h1), xs = wtCrosses(wt1, wt2), dd = { c: d1, sma: s200 }, noH4 = { c: [] as Candle[], r: [] as (number | null)[] };
    const busy = new Map<number, number>();
    for (const x of xs) {
      const j = x.i + 1, a = atr1[x.i];
      if (j >= h1.length || a == null || !(x.d > 0 ? x.level <= -53 : x.level >= 53) || h1[j]!.openTime <= (busy.get(x.d) ?? -Infinity)) continue;
      if (!dirOk('sma200', x.d, h1[x.i]!.openTime + H, dd, noH4)) continue;
      let ext = x.d > 0 ? Infinity : -Infinity;
      for (let k = Math.max(0, x.i - 4); k <= x.i; k++) ext = x.d > 0 ? Math.min(ext, h1[k]!.low) : Math.max(ext, h1[k]!.high);
      const stop = ext - x.d * 0.2 * a, tr = scalp2Trade(h1, [], atr1, j, stop, x.d, 120, '3R');
      if (!tr) continue;
      busy.set(x.d, h1[tr.end]!.openTime + H);
      push(rowOf(`wt1h:${sideOf(x.d)}`, h1, atr1, H, j, stop, x.d, capped(3), fs, tr.gross - COST * tr.costR, tr.end));
    }
  }

  // 22-23: the funding squeeze on 1H bars.
  {
    let busy = -1;
    for (const e of fvEvents(h1, fs, H, FV_LIVE.rate, FV_LIVE.vol)) {
      const a = atr1[e.i];
      if (e.bar !== -e.crowd || e.i + 1 >= h1.length || e.i < busy || a == null || !(a > 0)) continue;
      const d = -e.bar as 1 | -1, j = e.i + 1, stop = h1[j]!.open - d * FV_LIVE.stopAtr * a, tr = specTrade(h1, atr1, {}, j, stop, d, FV_LIVE.exit);
      if (!tr) continue;
      busy = tr.open ? Infinity : tr.end;
      push(rowOf(`fv1h:${sideOf(d)}`, h1, atr1, H, j, stop, d, FV_LIVE.exit, fs, tr.r, tr.end));
    }
  }

  // 24-25: the 1h RSI(2) pullback baseline.
  {
    const r2 = rsi(h1.map((b) => b.close), 2), spec: ExitSpec = { name: '2R target', target: 2 };
    for (const d of [1, -1] as const) {
      let busy = -1;
      for (let i = 0; i + 1 < h1.length; i++) {
        const v = r2[i], a = atr1[i];
        if (v == null || a == null || !(a > 0) || i < busy || !(d > 0 ? v < 10 : v > 90)) continue;
        const k = lastClosed(d1, DAY, h1[i]!.openTime + H), m = k >= 0 ? s200[k] : null;
        if (m == null || !(d * (d1[k]!.close - m) > 0)) continue;
        const j = i + 1, stop = h1[j]!.open - d * 2 * a, tr = specTrade(h1, atr1, {}, j, stop, d, spec);
        if (!tr) continue;
        busy = tr.open ? Infinity : tr.end;
        push(rowOf(`rsi2:${sideOf(d)}`, h1, atr1, H, j, stop, d, spec, fs, tr.r, tr.end));
      }
    }
  }
  return { trades: out.sort((a, b) => a.t - b.t || a.line.localeCompare(b.line)), tally };
}

export interface LineStats { n: number; win: number; r: number; rf: number; total: number; dd: number; edge: number; timing: number; t: number; noTop3: number; years: Map<number, { n: number; rf: number }> }
const mean = (xs: ReadonlyArray<number>) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
/** The screen's numbers for a set of trades (any order). Pure. */
export function lineStats(xs: ReadonlyArray<EthTrade>): LineStats {
  const ts = [...xs].sort((a, b) => a.t - b.t), rf = ts.map((x) => x.r + x.f), te = timingEdge(ts);
  let eq = 0, pk = 0, dd = 0;
  for (const v of rf) { eq += v; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const years = new Map<number, { n: number; rf: number }>();
  for (const x of ts) { const y = new Date(x.t).getUTCFullYear(), g = years.get(y) ?? { n: 0, rf: 0 }; g.n++; g.rf += x.r + x.f; years.set(y, g); }
  return {
    n: ts.length, win: (100 * ts.filter((x) => x.r > 0).length) / Math.max(1, ts.length), r: mean(ts.map((x) => x.r)), rf: mean(rf), total: rf.reduce((a, b) => a + b, 0), dd,
    edge: mean(ts.map((x) => x.r)) - mean(ts.flatMap((x) => x.rand)), timing: te.n ? te.mean : NaN, t: te.t, noTop3: mean([...rf].sort((a, b) => b - a).slice(3)), years,
  };
}
/** The fixed rule (header): the failed conditions, empty when the line qualifies in that period. Pure. */
export function failures(s: LineStats, part: Part): string[] {
  const out: string[] = [];
  if (s.n < MIN_TRADES[part]) out.push(`${s.n} trades < ${MIN_TRADES[part]}`);
  if (!(s.rf > 0)) out.push('avg R with funding <= 0');
  if (!(s.edge > 0)) out.push('random edge <= 0');
  if (!(s.timing > 0)) out.push('timing edge <= 0');
  if (!(s.noTop3 > 0)) out.push('<= 0 without the best 3');
  return out;
}

/** The daily context at time t: BTC and ETH/BTC against their 50-day SMAs (+1 above, -1 under), and the 24h funding. */
function contextOf(eth: EthSeries, btc: EthSeries): (t: number) => { btc: number; ratio: number; fund: number | null } {
  const bd = btc.candles['1d'], bs = sma(bd.map((b) => b.close), 50), bmap = new Map(bd.map((b) => [b.openTime, b.close]));
  const rd = eth.candles['1d'].filter((b) => bmap.has(b.openTime)), ratio = rd.map((b) => b.close / bmap.get(b.openTime)!), rs = sma(ratio, 50);
  return (t) => {
    const i = lastClosed(bd, DAY, t), k = lastClosed(rd, DAY, t);
    return { btc: i >= 0 && bs[i] != null ? Math.sign(bd[i]!.close - bs[i]!) : 0, ratio: k >= 0 && rs[k] != null ? Math.sign(ratio[k]! - rs[k]!) : 0, fund: funding8h(eth.funding, t) };
  };
}

/** Phase B report: every line on development and validation, the qualifiers, and their context splits. */
export function ethScreenReport(trades: ReadonlyArray<EthTrade>, eth: EthSeries, btc: EthSeries, tally: { rows: number; same: number }, dump = false): string[] {
  const P = [{ name: 'dev', ...ETH_PERIODS.dev }, { name: 'val', ...ETH_PERIODS.val }];
  const f = (x: number, n = 2) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(n)}` : '-');
  const head = '    period  trades   win   avg R  w/fund   total     DD   edge  timing (t)     w/o best 3';
  const row = (name: string, s: LineStats) => `    ${name.padEnd(6)}  ${String(s.n).padStart(6)}  ${s.win.toFixed(0).padStart(3)}%  ${f(s.r).padStart(6)}  ${f(s.rf).padStart(6)}  ${f(s.total, 1).padStart(6)}  ${s.dd.toFixed(1).padStart(5)}  ${f(s.edge).padStart(5)}  ${f(s.timing).padStart(5)} (${f(s.t, 1)})  ${f(s.noTop3).padStart(6)}`;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [
    '', `ETH SCREEN (rules fixed before the run, screen/eth.ts): ETH alone on the Binance history, entries ${day(P[0]!.from)} to ${day(P[1]!.to)}; development to ${day(P[0]!.to)}, validation after. Costs 0.22% a round trip; funding added per trade.`,
    `Live RSI-model trades re-simulated from the live rows: ${tally.same} of ${tally.rows} match.`,
    'Baselines (20 seeds): edge = avg R minus the same entries in a random direction; timing = R minus the same side at a random bar in the next 60 days (t value).',
  ];
  const ctx = contextOf(eth, btc), qualifiers: EthLine[] = [];
  for (const part of ['swing', 'intraday'] as const) {
    out.push('', `${part.toUpperCase()} (qualifies: >= ${MIN_TRADES[part]} trades, avg R with funding > 0, both edges > 0, > 0 without the best 3; in each period)`, head);
    for (const L of ETH_LINES.filter((x) => x.part === part)) {
      const xs = trades.filter((x) => x.line === L.id), st = P.map((p) => lineStats(xs.filter((x) => x.t >= p.from && x.t < p.to))), why = st.map((s) => failures(s, part));
      const ok = why.every((w) => !w.length);
      if (ok) qualifiers.push(L);
      const all = lineStats(xs.filter((x) => x.t < P[1]!.to));
      out.push(`  ${L.label}`, row('dev', st[0]!), row('val', st[1]!),
        `    by year (avg R with funding, trades): ${[...all.years].map(([y, g]) => `${y} ${f(g.rf / g.n)} (${g.n})`).join(', ') || '-'}`,
        `    ${ok ? 'QUALIFIES' : `fails: ${why.map((w, k) => (w.length ? `${P[k]!.name} ${w.join(', ')}` : '')).filter(Boolean).join('; ')}`}`);
    }
  }
  out.push('', `QUALIFIERS: ${qualifiers.length ? qualifiers.map((q) => q.label).join('; ') : 'none (no ETH bot by the fixed rule)'}`);
  for (const L of qualifiers) {
    const xs = trades.filter((x) => x.line === L.id), base = P.map((p) => lineStats(xs.filter((x) => x.t >= p.from && x.t < p.to)));
    out.push('', `Context splits, ${L.label} (avg R with funding, trades; dev / val; all: ${f(base[0]!.rf)} / ${f(base[1]!.rf)}):`);
    const splits: { name: string; side: (x: EthTrade) => boolean | null }[] = [
      { name: 'BTC on the trade\'s side of its 50-day SMA', side: (x) => { const c = ctx(x.t).btc; return c === 0 ? null : c === x.d; } },
      { name: 'ETH/BTC on the trade\'s side of its 50-day SMA', side: (x) => { const c = ctx(x.t).ratio; return c === 0 ? null : c === x.d; } },
      { name: '24h funding not against the trade (the other side crowded or flat)', side: (x) => { const r = ctx(x.t).fund; return r == null ? null : x.d * r <= 0; } },
    ];
    for (const sp of splits) for (const want of [true, false]) {
      const st = P.map((p) => lineStats(xs.filter((x) => x.t >= p.from && x.t < p.to && sp.side(x) === want)));
      const kept = st.every((s, k) => s.n >= MIN_TRADES[L.part] && s.rf > base[k]!.rf);
      out.push(`  ${want ? 'with' : 'against'}: ${sp.name}: ${st.map((s) => `${f(s.rf)} (${s.n})`).join(' / ')}${kept ? '  KEPT' : ''}`);
    }
  }
  if (dump) for (const x of trades) out.push(`ETHTRADE ${JSON.stringify({ l: x.line, d: x.d, t: x.t, e: x.end, r: +x.r.toFixed(4), f: +x.f.toFixed(4), ra: +mean(x.rand).toFixed(4), rt: x.rtime.length ? +mean(x.rtime).toFixed(4) : null })}`);
  return out;
}
