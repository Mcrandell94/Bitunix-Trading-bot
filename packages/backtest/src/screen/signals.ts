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


/**
 * The owner's multi-timeframe RSI framework (2026-09-27). RSI 14 on every
 * frame, each read from its last bar closed at the entry bar's close.
 *  - Daily sets the bias: long only above `biasLong`, short only below
 *    `biasShort`; in between, stand aside. Optional: daily close vs its 200 SMA.
 *  - 4H must be pulling back against the bias: long zone `pull` (e.g. 30-45),
 *    short zone the mirror (55-70).
 *  - The trigger frame (the signal's own timeframe) times it: RSI crosses back
 *    above `trig` (long) or below 100 - trig (short).
 *  - On a 15m trigger, 1H RSI must also be turning the trade's way.
 */
export interface RsiMtf { biasLong: number; biasShort: number; pull: [number, number]; trig: number; ma200?: boolean; oneHourTurn?: boolean; period?: number; trigPeriod?: number; biasPeriod?: number }

function rsiMtf(x: SignalContext, p: RsiMtf): Int8Array {
  const n = p.period ?? 14;
  const iv = intervalMs(x.tf);
  const series = (tf: Tf, len = n) => {
    const c = x.data.candles[tf] ?? [];
    return { c, r: rsi(closes(c), len), iv: intervalMs(tf) };
  };
  const d = series('1d', p.biasPeriod ?? n);
  const h4 = series('4h');
  const h1 = series('1h');
  const own = rsi(closes(x.candles), p.trigPeriod ?? n);
  const ma = p.ma200 ? sma(closes(d.c), 200) : null;
  const at = (s: { c: ReadonlyArray<Candle>; iv: number }, t: number) => barAt(s.c, s.iv, t);
  const out = new Int8Array(x.candles.length);
  for (let i = 1; i < x.candles.length; i++) {
    const r0 = own[i - 1], r1 = own[i];
    if (r0 == null || r1 == null) continue;
    const up = r0 < p.trig && r1 >= p.trig;
    const down = r0 > 100 - p.trig && r1 <= 100 - p.trig;
    if (!up && !down) continue;
    const t = x.candles[i]!.openTime + iv;
    const jd = at(d, t), j4 = at(h4, t);
    const rd = jd >= 0 ? d.r[jd] : null, r4 = j4 >= 0 ? h4.r[j4] : null;
    if (rd == null || r4 == null) continue;
    let side: Sign = 0;
    if (up && rd > p.biasLong && r4 >= p.pull[0] && r4 <= p.pull[1]) side = 1;
    if (down && rd < p.biasShort && r4 >= 100 - p.pull[1] && r4 <= 100 - p.pull[0]) side = -1;
    if (!side) continue;
    if (ma) {
      const m = ma[jd];
      if (m == null || (side > 0 ? d.c[jd]!.close <= m : d.c[jd]!.close >= m)) continue;
    }
    if (p.oneHourTurn) {
      const j1 = at(h1, t);
      const a = j1 >= 1 ? h1.r[j1 - 1] : null, b = j1 >= 0 ? h1.r[j1] : null;
      if (a == null || b == null || (side > 0 ? !(b > a) : !(b < a))) continue;
    }
    out[i] = side;
  }
  return out;
}

const RSI_BASE: RsiMtf = { biasLong: 60, biasShort: 40, pull: [30, 45], trig: 30 };

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
  // The owner's multi-timeframe RSI framework and its tweaks.
  { id: 'rsi_mtf', family: 'mean-reversion', what: 'daily RSI > 60 (< 40), 4H RSI pulled back to 30-45 (55-70), trigger RSI back above 30 (below 70); 15m also needs 1H RSI turning', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_b50', family: 'mean-reversion', what: 'as rsi_mtf, daily bias at 50 / 50', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, biasLong: 50, biasShort: 50, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_ma200', family: 'mean-reversion', what: 'as rsi_mtf, plus daily close above (below) its 200 SMA', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, ma200: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_wide', family: 'mean-reversion', what: 'crypto-widened: daily > 55 (< 45), 4H 30-50 (50-70), trigger back above 35 (below 65)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { biasLong: 55, biasShort: 45, pull: [30, 50], trig: 35, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_4h', family: 'mean-reversion', what: 'daily bias > 60 (< 40), trigger on 4H itself: RSI back above 35 (below 65) from the pullback', tfs: ['4h'], build: (x) => rsiMtf(x, { biasLong: 60, biasShort: 40, pull: [0, 100], trig: 35 }) },
  // Round 2 (owner's RSI settings note): one change at a time against rsi_mtf.
  { id: 'rsi_mtf_p9', family: 'mean-reversion', what: 'as rsi_mtf, 15m trigger RSI period 9 (everything else 14)', tfs: ['15m'], build: (x) => rsiMtf(x, { ...RSI_BASE, trigPeriod: 9, oneHourTurn: true }) },
  { id: 'rsi_mtf_regime', family: 'mean-reversion', what: 'as rsi_mtf, regime levels: trigger back above 40 in a daily uptrend (below 60 in a downtrend)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, trig: 40, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_x20', family: 'mean-reversion', what: 'as rsi_mtf, wider 15m extremes: trigger back above 20 (below 80)', tfs: ['15m'], build: (x) => rsiMtf(x, { ...RSI_BASE, trig: 20, oneHourTurn: true }) },
  { id: 'rsi_mtf_d21', family: 'mean-reversion', what: 'as rsi_mtf, daily RSI period 21 for a smoother bias', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, biasPeriod: 21, oneHourTurn: x.tf === '15m' }) },
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
