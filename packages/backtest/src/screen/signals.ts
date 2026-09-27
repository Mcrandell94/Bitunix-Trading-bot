// The signal screen's library: every indicator and data source we have,
// each turned into entry events (+1 long / -1 short at a bar's close, 0 =
// nothing) on one timeframe. Each event uses only bars closed by then and
// funding settled by then. Signals fire on the bar a condition starts, not
// on every bar it holds, so a signal is a decision, not a state.

import { intervalMs, type Candle } from '@bot/marketdata';
import { analyze, barAt, detectShift, DEFAULT_SETUP, type SetupConfig } from '@bot/smc';
import { atrWilder, bollinger, ema, macdHistogram, rsi, sma, stochastic, supertrend } from '../indicators';
import { c1Trend, c2Structure, m2Rotation, tfFeatures, type Sign, type TfFeatures } from '../score/components';
import type { ScoreConfig } from '../score/config';
import type { SymbolData, Tf } from '../types';

export interface SignalContext {
  symbol: string;
  tf: Tf;
  candles: ReadonlyArray<Candle>;
  data: SymbolData;
  btc: SymbolData;
  score: ScoreConfig;
  /** Built once per (symbol, tf) and shared by the structure signals. */
  features: () => TfFeatures;
  /** Built once per (symbol, tf) for other timeframes (RRG on 4H, BTC daily trend). */
  featuresOf: (s: 'coin' | 'btc', tf: Tf) => TfFeatures | null;
}

export interface SignalDef {
  id: string;
  family: 'trend' | 'breakout' | 'mean-reversion' | 'structure' | 'market' | 'volume';
  what: string;
  /** Timeframes it makes sense on (default: all four). */
  tfs?: Tf[];
  build: (ctx: SignalContext) => Int8Array;
}

const closes = (c: ReadonlyArray<Candle>) => c.map((x) => x.close);
const sign = (x: number | null | undefined): Sign => (x == null || x === 0 ? 0 : x > 0 ? 1 : -1);

/** Fire when a signed state changes to +1 or -1 (the first bar of the new state). */
function onChange(states: ReadonlyArray<Sign>): Int8Array {
  const out = new Int8Array(states.length);
  for (let i = 1; i < states.length; i++) if (states[i] !== 0 && states[i] !== states[i - 1]) out[i] = states[i]!;
  return out;
}

function crossOf(fast: (number | null)[], slow: (number | null)[]): Int8Array {
  return onChange(fast.map((f, i) => (f == null || slow[i] == null ? 0 : sign(f - slow[i]!))));
}

/** Enter the first bar a band condition holds: long while `lo(i)`, short while `hi(i)`. */
function onEnter(n: number, lo: (i: number) => boolean, hi: (i: number) => boolean): Int8Array {
  return onChange(Array.from({ length: n }, (_, i) => (lo(i) ? 1 : hi(i) ? -1 : 0) as Sign));
}

/** A value read at each bar's close from a series on another timeframe (the last bar of it closed by then). */
function readAt(ctx: SignalContext, f: TfFeatures, at: (j: number) => Sign): Sign[] {
  const iv = intervalMs(ctx.tf);
  const fv = intervalMs(f.tf);
  const cache = new Map<number, Sign>();
  return ctx.candles.map((c) => {
    const j = barAt(f.candles, fv, c.openTime + iv);
    if (j < 0) return 0;
    let v = cache.get(j);
    if (v === undefined) { v = at(j); cache.set(j, v); }
    return v;
  });
}

function donchian(c: ReadonlyArray<Candle>, n: number): Int8Array {
  const out = new Int8Array(c.length);
  let prev: Sign = 0;
  for (let i = n; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) { hi = Math.max(hi, c[j]!.high); lo = Math.min(lo, c[j]!.low); }
    const s: Sign = c[i]!.close > hi ? 1 : c[i]!.close < lo ? -1 : 0;
    if (s !== 0 && s !== prev) out[i] = s;
    prev = s;
  }
  return out;
}

export const SIGNALS: SignalDef[] = [
  // Trend following.
  { id: 'ema_9_21', family: 'trend', what: 'EMA 9 crosses EMA 21', build: (x) => crossOf(ema(closes(x.candles), 9), ema(closes(x.candles), 21)) },
  { id: 'ema_50_200', family: 'trend', what: 'EMA 50 crosses EMA 200', build: (x) => crossOf(ema(closes(x.candles), 50), ema(closes(x.candles), 200)) },
  { id: 'supertrend', family: 'trend', what: 'Supertrend (10, 3) flips', build: (x) => onChange(supertrend(x.candles, 10, 3).dir.map((d) => (d ?? 0) as Sign)) },
  { id: 'macd_flip', family: 'trend', what: 'MACD (12, 26, 9) histogram changes sign', build: (x) => onChange(macdHistogram(closes(x.candles)).map(sign)) },
  { id: 'ema50_trend', family: 'trend', what: 'close and EMA 50 slope agree (confluence C1) starts', build: (x) => { const f = x.features(); return onChange(x.candles.map((_, i) => c1Trend(f, i, x.score))); } },
  // Breakouts.
  { id: 'donchian_20', family: 'breakout', what: 'close beyond the 20-bar high / low', build: (x) => donchian(x.candles, 20) },
  { id: 'donchian_55', family: 'breakout', what: 'close beyond the 55-bar high / low', build: (x) => donchian(x.candles, 55) },
  // Mean reversion.
  { id: 'rsi2_extreme', family: 'mean-reversion', what: 'RSI(2) under 10 (long) / over 90 (short)', build: (x) => { const r = rsi(closes(x.candles), 2); return onEnter(r.length, (i) => r[i] != null && r[i]! < 10, (i) => r[i] != null && r[i]! > 90); } },
  { id: 'rsi14_reentry', family: 'mean-reversion', what: 'RSI(14) back above 30 (long) / below 70 (short)', build: (x) => { const r = rsi(closes(x.candles), 14); return onEnter(r.length, (i) => i > 0 && r[i - 1] != null && r[i - 1]! < 30 && r[i]! >= 30, (i) => i > 0 && r[i - 1] != null && r[i - 1]! > 70 && r[i]! <= 70); } },
  { id: 'bb_reentry', family: 'mean-reversion', what: 'close back inside the Bollinger (20, 2) band', build: (x) => { const c = closes(x.candles); const b = bollinger(c, 20, 2); return onEnter(c.length, (i) => i > 0 && b.lower[i - 1] != null && c[i - 1]! < b.lower[i - 1]! && c[i]! > b.lower[i]!, (i) => i > 0 && b.upper[i - 1] != null && c[i - 1]! > b.upper[i - 1]! && c[i]! < b.upper[i]!); } },
  { id: 'stoch_reentry', family: 'mean-reversion', what: 'Stochastic %K (14, 3) back above 20 / below 80', build: (x) => { const k = stochastic(x.candles, 14, 3, 3).k; return onEnter(k.length, (i) => i > 0 && k[i - 1] != null && k[i - 1]! < 20 && k[i]! >= 20, (i) => i > 0 && k[i - 1] != null && k[i - 1]! > 80 && k[i]! <= 80); } },
  { id: 'big_bar_fade', family: 'mean-reversion', what: 'a bar over 2.5 ATR: trade against it', build: (x) => { const a = atrWilder(x.candles, 14); return Int8Array.from(x.candles, (c, i) => (i > 0 && a[i - 1] != null && c.high - c.low > 2.5 * a[i - 1]! ? -sign(c.close - c.open) : 0)); } },
  // Structure (the SMC code).
  { id: 'structure_c2', family: 'structure', what: 'two higher highs and lows (or lower) starts', build: (x) => { const f = x.features(); return onChange(x.candles.map((_, i) => c2Structure(f, i, x.score))); } },
  { id: 'smc_shift', family: 'structure', what: 'sweep then market structure shift with displacement (known the bar after)', build: (x) => {
    const setup: SetupConfig = { ...DEFAULT_SETUP, displacementAtr: x.score.components.C4_smc_event.displacement_atr, displacementBodyRatio: x.score.components.C4_smc_event.body_ratio };
    const a = analyze(x.candles);
    return Int8Array.from(x.candles, (_, k) => { const s = k >= 1 ? detectShift(a, k, setup) : null; return s ? (s.side === 'long' ? 1 : -1) : 0; });
  } },
  // Volume.
  { id: 'volume_thrust', family: 'volume', what: 'volume over 2x its 20-bar mean with a strong body: go with it', build: (x) => {
    const v = x.candles.map((c) => c.volume ?? 0);
    const m = sma(v, 20);
    return Int8Array.from(x.candles, (c, i) => (i > 0 && m[i - 1] != null && m[i - 1]! > 0 && v[i]! > 2 * m[i - 1]! && Math.abs(c.close - c.open) > 0.6 * (c.high - c.low) ? sign(c.close - c.open) : 0));
  } },
  // Market data beyond the coin's own chart.
  { id: 'funding_contrarian', family: 'market', what: 'mean of the last 3 funding rates crowded long (> 0.03%) / short (< -0.01%): fade the crowd', tfs: ['1h', '4h', '1d'], build: (x) => {
    const p = x.score.components.M3_funding;
    const f = x.data.funding ?? [];
    const iv = intervalMs(x.tf);
    let k = 0;
    return onChange(x.candles.map((c) => {
      const t = c.openTime + iv;
      while (k < f.length && f[k]!.time <= t) k++;
      if (k < p.mean_of_last) return 0;
      let s = 0;
      for (let j = k - p.mean_of_last; j < k; j++) s += f[j]!.rate;
      const pct = (s / p.mean_of_last) * 100;
      return (pct > p.long_crowded_pct ? -1 : pct < p.short_crowded_pct ? 1 : 0) as Sign;
    }));
  } },
  { id: 'btc_daily_trend', family: 'market', what: 'BTC daily trend (close and EMA 50 slope) turns: trade the coin that way', build: (x) => {
    const d = x.featuresOf('btc', '1d');
    return d ? onChange(readAt(x, d, (j) => c1Trend(d, j, x.score))) : new Int8Array(x.candles.length);
  } },
  { id: 'rrg_rotation', family: 'market', what: 'RRG vs BTC on 4H enters leading/improving (long) or lagging/weakening (short)', tfs: ['1h', '4h', '1d'], build: (x) => {
    if (x.symbol === 'BTCUSDT') return new Int8Array(x.candles.length);
    const a = x.featuresOf('coin', '4h');
    const b = x.featuresOf('btc', '4h');
    if (!a || !b) return new Int8Array(x.candles.length);
    const iv4 = intervalMs('4h');
    return onChange(readAt(x, a, (j) => m2Rotation(a, b, a.candles[j]!.openTime + iv4, x.score)));
  } },
];

/** The features cache the signals share, per coin. */
export function contextFor(all: Readonly<Record<string, SymbolData>>, symbol: string, tf: Tf, score: ScoreConfig): SignalContext | null {
  const data = all[symbol];
  const candles = data?.candles[tf];
  if (!data || !candles?.length) return null;
  let own: TfFeatures | null = null;
  const other = new Map<string, TfFeatures | null>();
  return {
    symbol, tf, candles, data, btc: all.BTCUSDT!, score,
    features: () => (own ??= tfFeatures(candles, tf, score)),
    featuresOf: (s, t) => {
      const key = `${s}|${t}`;
      if (!other.has(key)) {
        const c = (s === 'btc' ? all.BTCUSDT : data)?.candles[t];
        other.set(key, c?.length ? tfFeatures(c, t, score) : null);
      }
      return other.get(key)!;
    },
  };
}
