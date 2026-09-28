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
import { readRrg, resolveConfig } from '@bot/signals';
import { computeSeries, firstValidIndex, RRG_PRESETS, type RrgPoint } from '@bot/rrg';
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
  /** Optional stop distance (price) per signal bar, for exits in R; null = skip that trade. */
  stop?: (ctx: SignalContext, sig: Int8Array) => (number | null)[];
}

/**
 * The component settings the signals read (config/confluence.yaml's
 * `components`), built in so the bot can run a signal without reading the
 * research config. A test keeps them equal to the file.
 */
export const SIGNAL_SETTINGS = {
  components: {
    C1_trend: { ema_len: 50, slope_lookback_bars: 10 },
    C2_structure: { swings_compared: 2 },
    C3_location: { discount_max: 0.40, premium_min: 0.60 },
    C4_smc_event: { lookback_bars: 6, displacement_atr: 1.2, body_ratio: 0.60 },
    M1_btc_regime: { uses: 'C1_trend', timeframe: '1D' },
    M2_rotation: { timeframe: '4H', bullish: ['leading', 'improving'], bearish: ['lagging', 'weakening'] },
    M3_funding: { mean_of_last: 3, long_crowded_pct: 0.03, short_crowded_pct: -0.01 },
  },
} as unknown as ScoreConfig;

const closes = (c: ReadonlyArray<Candle>) => c.map((x) => x.close);
const sign =(x: number | null | undefined): Sign => (x == null || x === 0 ? 0 : x > 0 ? 1 : -1);

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
export interface RsiMtf { biasLong: number; biasShort: number; pull: [number, number]; trig: number; ma200?: boolean; oneHourTurn?: boolean; period?: number; trigPeriod?: number; biasPeriod?: number;
  /** Daily and 4H swing structure (two higher highs and lows, or lower) agree with the trade. */
  structure?: boolean;
  /** Daily EMA 50 above EMA 200 and close above EMA 200 (mirror for shorts). */
  emaStack?: boolean;
  /** OBV on the trigger frame higher than 5 bars ago (lower for shorts). */
  obv?: boolean;
  /** 4H MACD (12, 26, 9) histogram rising (falling for shorts). */
  macd4h?: boolean;
  /** Skip longs when funding is crowded long and shorts when crowded short (the M3 levels). */
  funding?: boolean;
  /** The last closed 4H bar pulled back to its EMA (20 or 50): low at or under it and close above it (mirror for shorts). */
  ema4hTouch?: 20 | 50;
  /** Daily EMAs in order: 20 > 50 > 100 > 200 (mirror for shorts). */
  ribbon?: boolean }

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
  const emaD = p.emaStack ? { e50: ema(closes(d.c), 50), e200: ema(closes(d.c), 200) } : null;
  let obv: number[] | null = null;
  if (p.obv) {
    obv = [0];
    for (let i = 1; i < x.candles.length; i++) {
      const c = x.candles[i]!, v = c.volume ?? 0, pc = x.candles[i - 1]!.close;
      obv.push(obv[i - 1]! + (c.close > pc ? v : c.close < pc ? -v : 0));
    }
  }
  const macd4 = p.macd4h ? macdHistogram(closes(h4.c)) : null;
  const e4 = p.ema4hTouch ? ema(closes(h4.c), p.ema4hTouch) : null;
  const rib = p.ribbon ? [20, 50, 100, 200].map((n2) => ema(closes(d.c), n2)) : null;
  const fund = x.data.funding ?? [];
  let fk = 0;
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
    if (p.structure) {
      const fd = x.featuresOf('coin', '1d'), f4 = x.featuresOf('coin', '4h');
      if (!fd || !f4 || c2Structure(fd, jd, x.score) !== side || c2Structure(f4, j4, x.score) !== side) continue;
    }
    if (emaD) {
      const e50 = emaD.e50[jd], e200 = emaD.e200[jd], c = d.c[jd]!.close;
      if (e50 == null || e200 == null || (side > 0 ? !(e50 > e200 && c > e200) : !(e50 < e200 && c < e200))) continue;
    }
    if (obv) {
      if (i < 5 || (side > 0 ? !(obv[i]! > obv[i - 5]!) : !(obv[i]! < obv[i - 5]!))) continue;
    }
    if (macd4) {
      const a = j4 >= 1 ? macd4[j4 - 1] : null, b = macd4[j4];
      if (a == null || b == null || (side > 0 ? !(b > a) : !(b < a))) continue;
    }
    if (e4) {
      const e = e4[j4], b = h4.c[j4]!;
      if (e == null || (side > 0 ? !(b.low <= e && b.close > e) : !(b.high >= e && b.close < e))) continue;
    }
    if (rib) {
      const v = rib.map((r) => r[jd]);
      if (v.some((y) => y == null)) continue;
      const ordered = v.every((y, k) => k === 0 || (side > 0 ? v[k - 1]! > y! : v[k - 1]! < y!));
      if (!ordered) continue;
    }
    if (p.funding) {
      const fp = x.score.components.M3_funding;
      while (fk < fund.length && fund[fk]!.time <= t) fk++;
      if (fk >= fp.mean_of_last) {
        let sum = 0;
        for (let j = fk - fp.mean_of_last; j < fk; j++) sum += fund[j]!.rate;
        const pct = (sum / fp.mean_of_last) * 100;
        if ((side > 0 && pct > fp.long_crowded_pct) || (side < 0 && pct < fp.short_crowded_pct)) continue;
      }
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

/**
 * EMA pullback with no RSI: daily close above its 200 SMA, 4H EMA 20 above
 * EMA 50, and a 4H bar that dips to the EMA 20 and closes back above it
 * (mirror for shorts). Fires on 4H closes.
 */
function emaPullback4h(x: SignalContext): Int8Array {
  const d = x.data.candles['1d'] ?? [];
  const ma = sma(closes(d), 200);
  const c = x.candles;
  const e20 = ema(closes(c), 20), e50 = ema(closes(c), 50);
  const iv = intervalMs(x.tf);
  return Int8Array.from(c, (b, i) => {
    const a = e20[i], z = e50[i];
    if (a == null || z == null) return 0;
    const jd = barAt(d, intervalMs('1d'), b.openTime + iv);
    const m = jd >= 0 ? ma[jd] : null;
    if (m == null) return 0;
    const dc = d[jd]!.close;
    if (dc > m && a > z && b.low <= a && b.close > a) return 1;
    if (dc < m && a < z && b.high >= a && b.close < a) return -1;
    return 0;
  });
}

const RSI_BASE: RsiMtf = { biasLong: 60, biasShort: 40, pull: [30, 45], trig: 30 };

/**
 * Context filters on another signal's entries (owner: BTC's daily trend and
 * swing structure are essential context, not triggers). Keeps an entry only
 * when BTC's daily trend (close and EMA 50 slope) and/or the coin's daily
 * swing structure (two higher highs and lows, or lower) agree with it, read
 * from the last daily bar closed at the entry.
 */
function withContext(x: SignalContext, entries: Int8Array, p: {
  btc?: boolean; structure?: boolean; vol?: boolean;
  /** The coin's own daily EMA 50 trend (close and EMA 50 slope, confluence C1) must agree. */
  htfTrend?: boolean;
  /** EMA 50 must have moved at least this % over the last 10 bars, the trade's way. */
  slopePct?: number;
  /** Entry-bar volume at least this multiple of its 20-bar mean. */
  volumeMult?: number;
  /** Close on the trade's side of both EMA 20 and EMA 100 as well. */
  secondaryEmas?: boolean;
}): Int8Array {
  const iv = intervalMs(x.tf);
  const day = intervalMs('1d');
  const btc = p.btc ? x.featuresOf('btc', '1d') : null;
  const own = p.structure || p.htfTrend ? x.featuresOf('coin', '1d') : null;
  const cl = closes(x.candles);
  const e50 = p.slopePct != null ? ema(cl, 50) : null;
  const vols = p.volumeMult != null ? x.candles.map((c) => c.volume ?? 0) : null;
  const volMean = vols ? sma(vols, 20) : null;
  const e20 = p.secondaryEmas ? ema(cl, 20) : null;
  const e100 = p.secondaryEmas ? ema(cl, 100) : null;
  // ATR regime (owner's ATR layer): ATR(14) as % of price, ranked against its last 100 bars; skip the top and bottom 10%.
  const atr = p.vol ? atrWilder(x.candles, 14) : null;
  const atrPct = atr ? atr.map((a, i) => (a == null ? null : a / x.candles[i]!.close)) : null;
  return Int8Array.from(entries, (s, i) => {
    if (!s) return 0;
    const t = x.candles[i]!.openTime + iv;
    if (atrPct) {
      const now = atrPct[i];
      if (now == null || i < 100) return 0;
      let below = 0, n = 0;
      for (let k = i - 100; k < i; k++) { const v = atrPct[k]; if (v == null) continue; n++; if (v < now) below++; }
      const rank = n ? below / n : 0.5;
      if (rank < 0.1 || rank > 0.9) return 0;
    }
    if (e50) {
      const a = e50[i], b = i >= 10 ? e50[i - 10] : null;
      if (a == null || b == null || !(s * ((a - b) / b) * 100 >= p.slopePct!)) return 0;
    }
    if (vols && volMean) {
      const m = i > 0 ? volMean[i - 1] : null;
      if (m == null || !(m > 0) || vols[i]! < p.volumeMult! * m) return 0;
    }
    if (e20 && e100) {
      const c = cl[i]!, a = e20[i], b = e100[i];
      if (a == null || b == null || (s > 0 ? !(c > a && c > b) : !(c < a && c < b))) return 0;
    }
    if (p.btc) {
      const j = btc ? barAt(btc.candles, day, t) : -1;
      if (j < 0 || c1Trend(btc!, j, x.score) !== s) return 0;
    }
    if (p.structure) {
      const j = own ? barAt(own.candles, day, t) : -1;
      if (j < 0 || c2Structure(own!, j, x.score) !== s) return 0;
    }
    if (p.htfTrend) {
      const j = own ? barAt(own.candles, day, t) : -1;
      if (j < 0 || c1Trend(own!, j, x.score) !== s) return 0;
    }
    return s;
  });
}

const ema50Trend = (x: SignalContext) => { const f = x.features(); return onChange(x.candles.map((_, i) => c1Trend(f, i, x.score))); };
/** The daily EMA 50 trend state per bar (+1 close above a rising EMA 50, -1 below a falling one, 0 neither), for the dashboard radar. */
export const ema50TrendState = (x: SignalContext): Sign[] => { const f = x.features(); return x.candles.map((_, i) => c1Trend(f, i, x.score)); };
/**
 * EMA 12-23-50 stack (owner, 2026-09-27), on the bar close. Long: close above
 * EMA 50 and EMA 23 above EMA 50 (the trend), and either EMA 12 crosses above
 * EMA 23 (breakout) or, with EMA 12 already above EMA 23, the close comes back
 * above EMA 12 after the previous close at or below it (pullback and reclaim).
 * Short is the mirror.
 */
function ema122350(x: SignalContext): Int8Array {
  const c = closes(x.candles);
  const e12 = ema(c, 12), e23 = ema(c, 23), e50 = ema(c, 50);
  return Int8Array.from(c, (close, i) => {
    if (i < 1) return 0;
    const a = e12[i], b = e23[i], z = e50[i], a0 = e12[i - 1], b0 = e23[i - 1];
    if (a == null || b == null || z == null || a0 == null || b0 == null) return 0;
    const prev = c[i - 1]!;
    if (close > z && b > z) {
      if ((a0 <= b0 && a > b) || (a > b && close > a && prev <= a0)) return 1;
    }
    if (close < z && b < z) {
      if ((a0 >= b0 && a < b) || (a < b && close < a && prev >= a0)) return -1;
    }
    return 0;
  });
}

/**
 * Dual higher-timeframe bias (owner, 2026-09-27), read from the last daily and
 * 4H bars closed at each 1H close. Long: daily close above its EMA 50 and 4H
 * close above its EMA 50; with `slope`, also the daily EMA 50 up more than
 * minSlope over 4 bars and the 4H EMA 50 up more than 0.7 x minSlope (the
 * owner's slope(): total change over the lookback). Short: the mirror.
 * Owner's start values, fixed: EMA 50, lookback 4, minSlope 0.0004.
 */
const DUAL = { period: 50, lookback: 4, minSlope: 0.0004, softer4h: 0.7 } as const;
function dualBias(x: SignalContext, slope: boolean): Int8Array {
  const read = (tf: Tf) => {
    const c = x.data.candles[tf] ?? [];
    return { c, iv: intervalMs(tf), e: ema(closes(c), DUAL.period) };
  };
  const d = read('1d'), h4 = read('4h');
  const iv = intervalMs(x.tf);
  const side = (s: ReturnType<typeof read>, t: number, min: number): number => {
    const j = barAt(s.c, s.iv, t);
    const e = j >= 0 ? s.e[j] : null, e0 = j >= DUAL.lookback ? s.e[j - DUAL.lookback] : null;
    if (e == null || e0 == null) return 0;
    const close = s.c[j]!.close, sl = (e - e0) / e0;
    if (close > e && (!slope || sl > min)) return 1;
    if (close < e && (!slope || sl < -min)) return -1;
    return 0;
  };
  return Int8Array.from(x.candles, (b) => {
    const t = b.openTime + iv;
    const a = side(d, t, DUAL.minSlope), c = side(h4, t, DUAL.minSlope * DUAL.softer4h);
    return a !== 0 && a === c ? a : 0;
  });
}

/** Owner's structure add-on: 5-bar pivots on the execution timeframe; long needs the last swing high above the one before, short the last swing low below. */
function pivotStructure(x: SignalContext): Int8Array {
  const c = x.candles;
  const hi = (from: number, to: number) => { let m = -Infinity; for (let k = from; k <= to; k++) m = Math.max(m, c[k]!.high); return m; };
  const lo = (from: number, to: number) => { let m = Infinity; for (let k = from; k <= to; k++) m = Math.min(m, c[k]!.low); return m; };
  // highest(high, 5)[5] = bars i-9..i-5; highest(high, 5)[10] = bars i-14..i-10.
  return Int8Array.from(c, (_, i) => {
    if (i < 14) return 0;
    const up = hi(i - 9, i - 5) > hi(i - 14, i - 10), down = lo(i - 9, i - 5) < lo(i - 14, i - 10);
    return up && !down ? 1 : down && !up ? -1 : up && down ? 2 : 0; // 2 = both (a wide bar): either side passes
  });
}

/** 12-23-50 entries kept only where the dual bias (and optionally structure) agrees; then the ATR regime filter. */
function ema122350Dual(x: SignalContext, p: { slope: boolean; structure: boolean }): Int8Array {
  const entry = ema122350(x), bias = dualBias(x, p.slope), st = p.structure ? pivotStructure(x) : null;
  const kept = Int8Array.from(entry, (s, i) => {
    if (!s || bias[i] !== s) return 0;
    if (st && st[i] !== s && st[i] !== 2) return 0;
    return s;
  });
  return withContext(x, kept, { vol: true });
}

/**
 * Owner's structure stop (2026-09-27): beyond the slow EMA or the pullback's
 * swing (last 3 bars), plus 0.15 ATR; kept between 1.0 and 1.8 ATR; farther
 * than 1.8 ATR = not a pullback, no trade.
 */
export function structureStop(slow: number, p: { buffer?: number; min?: number; max?: number; minStopPct?: number } = {}) {
  const buffer = p.buffer ?? 0.15, min = p.min ?? 1.0, max = p.max ?? 1.8;
  return (x: SignalContext, sig: Int8Array): (number | null)[] => {
    const c = x.candles, e = ema(closes(c), slow), atr = atrWilder(c, 14);
    return Array.from(sig, (sd, i) => {
      const a = atr[i], z = e[i];
      if (!sd || a == null || z == null || i < 2) return null;
      const close = c[i]!.close;
      const swing = sd > 0 ? Math.min(c[i]!.low, c[i - 1]!.low, c[i - 2]!.low) : Math.max(c[i]!.high, c[i - 1]!.high, c[i - 2]!.high);
      const raw = sd > 0 ? Math.min(z, swing) - buffer * a : Math.max(z, swing) + buffer * a;
      const dist = Math.abs(close - raw);
      if (dist > max * a) return null;
      const out = Math.max(dist, min * a);
      // Cost gate (owner, 2026-09-27): skip when round-trip costs exceed ~6% of the stop, i.e. the stop is under minStopPct of price.
      if (p.minStopPct != null && (out / close) * 100 < p.minStopPct) return null;
      return out;
    });
  };
}

/**
 * Owner's optimized 1H spec (2026-09-27): 9/21/50 pullback. Bias: daily close
 * above an EMA 50 higher than 5 daily bars ago, unless 4H closes below a
 * falling 4H EMA 50 (veto). Entry (long): EMA 9 > 21 > 50 and EMA 21 not
 * falling; the last 3 bars dipped to EMA 9 without closing more than 0.1 ATR
 * below EMA 21; close back above EMA 9 (previous close at or below it); close
 * no more than 0.8 ATR above EMA 9; ATR regime filter; one signal per side per
 * 6 bars. `sep`: EMA 21 at least 0.25 ATR clear of EMA 50. Short: the mirror.
 */
/** ATR regime on the signal's own timeframe: skip when ATR% sits in the top or bottom `tail` of its last `n` bars. */
function atrRegime(x: SignalContext, sig: Int8Array, n: number, tail: number): Int8Array {
  const atr = atrWilder(x.candles, 14);
  const pct = atr.map((a, i) => (a == null ? null : a / x.candles[i]!.close));
  return Int8Array.from(sig, (s, i) => {
    if (!s) return 0;
    const now = pct[i];
    if (now == null || i < n) return 0;
    let below = 0, k2 = 0;
    for (let k = i - n; k < i; k++) { const v = pct[k]; if (v == null) continue; k2++; if (v < now) below++; }
    const rank = k2 ? below / k2 : 0.5;
    return rank < tail || rank > 1 - tail ? 0 : s;
  });
}

/**
 * One pullback per swing (owner): after a long, no new long until a close
 * below the slow EMA or a high above the highest high since that entry (a new
 * swing high); mirror for shorts. Plus a minimum gap of `cooldown` bars.
 */
function onePerSwing(x: SignalContext, sig: Int8Array, slow: (number | null)[], cooldown: number): Int8Array {
  const c = x.candles;
  const st = { 1: { armed: true, ext: 0, at: -1e9 }, [-1]: { armed: true, ext: 0, at: -1e9 } } as Record<number, { armed: boolean; ext: number; at: number }>;
  return Int8Array.from(sig, (s, i) => {
    const b = c[i]!, z = slow[i];
    const L = st[1]!, S = st[-1]!;
    if (!L.armed && ((z != null && b.close < z) || b.high > L.ext)) L.armed = true;
    if (!S.armed && ((z != null && b.close > z) || b.low < S.ext)) S.armed = true;
    L.ext = Math.max(L.ext, b.high); S.ext = Math.min(S.ext, b.low);
    if (!s) return 0;
    const me = st[s]!;
    if (!me.armed || i - me.at < cooldown) return 0;
    me.armed = false; me.at = i; me.ext = s > 0 ? b.high : b.low;
    return s;
  });
}

/** Owner's daily range location: long only when the daily close sits in the upper 55% of its last 20 daily bars' range (short: lower 55%). */
function dailyRangeLocation(x: SignalContext, sig: Int8Array): Int8Array {
  const d = x.data.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  return Int8Array.from(sig, (s, i) => {
    if (!s) return 0;
    const j = barAt(d, day, x.candles[i]!.openTime + iv);
    if (j < 19) return 0;
    let hi = -Infinity, lo = Infinity;
    for (let k = j - 19; k <= j; k++) { hi = Math.max(hi, d[k]!.high); lo = Math.min(lo, d[k]!.low); }
    if (!(hi > lo)) return 0;
    const loc = (d[j]!.close - lo) / (hi - lo);
    return (s > 0 ? loc >= 0.45 : loc <= 0.55) ? s : 0;
  });
}

/**
 * Overbought veto on longs (owner, 2026-09-28, after NEAR's long stalled into
 * resistance with RSI stretched): no long when the weekly RSI(14) is at or
 * above 70 or the daily RSI(14) at or above 76 (`both`: only when both are).
 * Read at the last closed daily bar; the weekly RSI uses completed weeks
 * (Monday 00:00 UTC) plus the current week so far. Shorts pass unchanged.
 */
/**
 * Room to the first target (owner, 2026-09-28, after NEAR's long stalled into
 * resistance): skip an entry when daily resistance (long) or support (short)
 * sits between the entry and the first target (`tpR` x the trade's stop
 * distance). Levels are confirmed daily swing highs / lows (the high or low of
 * 7 daily bars centred on it, so confirmed 3 bars later) from the last
 * `lookback` days, grouped into zones within 0.5 daily ATR; `minTouches` = 1
 * counts any swing, 2 only zones hit at least twice.
 */
function roomToTarget(x: SignalContext, sig: Int8Array, stopFn: SignalDef['stop'], p: { tpR?: number; minTouches?: number; lookback?: number } = {}): Int8Array {
  const tpR = p.tpR ?? 1.6, minTouches = p.minTouches ?? 1, lookback = p.lookback ?? 120;
  const d = x.data.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const datr = atrWilder(d, 14);
  const stops = stopFn ? stopFn(x, sig) : null;
  return Int8Array.from(sig, (s, i) => {
    if (!s) return 0;
    const dist = stops?.[i];
    if (dist == null || !(dist > 0)) return s;
    const j = barAt(d, day, x.candles[i]!.openTime + iv);
    const a = j >= 0 ? datr[j] : null;
    if (j < 10 || a == null) return s;
    const entry = x.candles[i]!.close;
    const target = s > 0 ? entry + tpR * dist : entry - tpR * dist;
    return roomBlockedAt(d, j, s > 0, entry, target, a, minTouches, lookback) ? 0 : s;
  });
}

/**
 * Whether resistance (support for a short) sits between `entry` and `target`
 * at daily bar `j` (owner, 2026-09-28): levels are the daily swing highs (lows)
 * of the last `lookback` days, bar k being a swing when it is the extreme of
 * k-3..k+3 and k+3 <= j. minTouches 1 = any swing blocks; 2+ = only zones,
 * a level with at least that many swings within 0.5 daily ATR (`atr`) of it.
 */
export function roomBlockedAt(
  d: ReadonlyArray<Candle>, j: number, long: boolean, entry: number, target: number, atr: number, minTouches = 2, lookback = 120,
): boolean {
  const levels: number[] = [];
  for (let k = Math.max(3, j - lookback); k <= j - 3; k++) {
    let piv = true;
    for (let m = k - 3; m <= k + 3 && piv; m++) if (m !== k) piv = long ? d[m]!.high < d[k]!.high || (d[m]!.high === d[k]!.high && m > k) : d[m]!.low > d[k]!.low || (d[m]!.low === d[k]!.low && m > k);
    if (piv) levels.push(long ? d[k]!.high : d[k]!.low);
  }
  // Levels in the way: beyond the entry, before the target.
  const inWay = levels.filter((l) => (long ? l > entry && l < target : l < entry && l > target));
  if (!inWay.length) return false;
  if (minTouches <= 1) return true;
  return inWay.some((l) => levels.filter((o) => Math.abs(o - l) <= 0.5 * atr).length >= minTouches);
}

/**
 * Whether a coin is overbought at daily bar `j` (owner, 2026-09-28): the weekly
 * RSI(14) at or above `w` or the daily RSI(14) at or above `d` (`both`: only
 * when both are). The weekly RSI uses completed weeks (Monday 00:00 UTC) plus
 * the current week so far, built from closed daily bars. `dailyRsi` may be
 * passed in to save recomputing it per call.
 */
export function overboughtAt(
  d: ReadonlyArray<Candle>, j: number, lim: { w?: number | null; d?: number | null }, mode: 'either' | 'both' = 'either',
  dailyRsi: ReadonlyArray<number | null> = rsi(d.map((c) => c.close), 14),
): boolean {
  if (j < 0 || j >= d.length) return false;
  const v = weeklyDailyRsi(d, j, dailyRsi, lim.w != null);
  const hot: boolean[] = [];
  if (lim.d != null) hot.push(v.d != null && v.d >= lim.d);
  if (lim.w != null) hot.push(v.w != null && v.w >= lim.w);
  return mode === 'both' ? hot.length > 0 && hot.every(Boolean) : hot.some(Boolean);
}

/**
 * Weekly and daily RSI(14) at daily bar `j`: the weekly from completed weeks
 * (Monday 00:00 UTC) plus the current week so far, built from closed daily bars.
 */
export function weeklyDailyRsi(
  d: ReadonlyArray<Candle>, j: number, dailyRsi: ReadonlyArray<number | null> = rsi(d.map((c) => c.close), 14), withWeekly = true,
): { w: number | null; d: number | null } {
  if (j < 0 || j >= d.length) return { w: null, d: null };
  let w: number | null = null;
  if (withWeekly) {
    const day = intervalMs('1d');
    const weekOf = (t: number) => Math.floor((t - 4 * day) / (7 * day)); // 1970-01-01 was a Thursday
    const wk = weekOf(d[j]!.openTime);
    const weekly: number[] = [];
    for (let k = Math.max(0, j - 7 * 60); k < j; k++) if (weekOf(d[k]!.openTime) < wk && (k + 1 >= d.length || weekOf(d[k + 1]!.openTime) !== weekOf(d[k]!.openTime))) weekly.push(d[k]!.close);
    weekly.push(d[j]!.close);
    w = weekly.length > 15 ? rsi(weekly, 14).at(-1) ?? null : null;
  }
  return { w, d: dailyRsi[j] ?? null };
}

/**
 * Research (owner, 2026-09-28): which RSI state stops the losing shorts. `low`:
 * no short when weekly RSI <= w or daily RSI <= d (already sold off, bounce
 * risk); `high`: no short when weekly RSI >= w (the higher trend still strong).
 */
function shortRsiVeto(x: SignalContext, sig: Int8Array, lim: { low?: { w?: number; d?: number }; high?: { w?: number; d?: number } }): Int8Array {
  const d = x.data.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const dailyRsi = rsi(d.map((c) => c.close), 14);
  return Int8Array.from(sig, (s, i) => {
    if (s >= 0) return s;
    const j = barAt(d, day, x.candles[i]!.openTime + iv);
    if (j < 0) return 0;
    const v = weeklyDailyRsi(d, j, dailyRsi);
    const lo = lim.low, hi = lim.high;
    const veto = (lo?.w != null && v.w != null && v.w <= lo.w) || (lo?.d != null && v.d != null && v.d <= lo.d)
      || (hi?.w != null && v.w != null && v.w >= hi.w) || (hi?.d != null && v.d != null && v.d >= hi.d);
    return veto ? 0 : s;
  });
}

function overboughtLongVeto(x: SignalContext, sig: Int8Array, mode: 'either' | 'both' = 'either', lim: { w?: number | null; d?: number | null; h4?: number | null } = { w: 70, d: 76 }): Int8Array {
  const d = x.data.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const dailyRsi = rsi(d.map((c) => c.close), 14);
  const ownRsi = lim.h4 != null ? rsi(closes(x.candles), 14) : null; // the signal's own timeframe (4H)
  return Int8Array.from(sig, (s, i) => {
    if (s <= 0) return s;
    const j = barAt(d, day, x.candles[i]!.openTime + iv);
    if (j < 0) return 0;
    const htf = lim.w != null || lim.d != null ? overboughtAt(d, j, lim, mode, dailyRsi) : mode === 'both';
    const own = ownRsi && lim.h4 != null ? (ownRsi[i] ?? -1) >= lim.h4 : mode === 'both';
    const veto = mode === 'both' ? htf && own && (lim.w != null || lim.d != null || lim.h4 != null) : htf || own;
    return veto ? 0 : s;
  });
}

/**
 * Owner's 4H model (2026-09-27): 13/34/50 pullback on 4H closes. Bias: daily
 * close above an EMA 50 higher than 5 daily bars ago (mirror for shorts);
 * `d200`: also on the trade's side of the daily EMA 200. Entry (long): EMA 13
 * > 34 > 50, EMA 34 at least 0.30 ATR clear of EMA 50 and not falling over 3
 * bars; the last 3 bars dipped to EMA 13 without closing more than 0.15 ATR
 * below EMA 34; close back above EMA 13; not more than 0.7 ATR above it; ATR
 * regime (15% tails of the last 80 bars); 4-bar cooldown, one per swing.
 */
function pullback4h(x: SignalContext, d200: boolean): Int8Array {
  const c = x.candles, cl = closes(c);
  const e13 = ema(cl, 13), e34 = ema(cl, 34), e50 = ema(cl, 50), atr = atrWilder(c, 14);
  const dk = x.data.candles['1d'] ?? [];
  const de50 = ema(closes(dk), 50), de200 = ema(closes(dk), 200);
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const raw = Int8Array.from(c, (b, i) => {
    if (i < 3) return 0;
    const a = atr[i], f = e13[i], m = e34[i], z = e50[i], f0 = e13[i - 1], m3 = e34[i - 3];
    if (a == null || f == null || m == null || z == null || f0 == null || m3 == null) return 0;
    const j = barAt(dk, day, b.openTime + iv);
    const e = j >= 5 ? de50[j] : null, e0 = j >= 5 ? de50[j - 5] : null;
    if (e == null || e0 == null) return 0;
    const dc = dk[j]!.close;
    let s = dc > e && e > e0 ? 1 : dc < e && e < e0 ? -1 : 0;
    if (s && d200) { const t = de200[j]; if (t == null || (s > 0 ? !(dc > t) : !(dc < t))) s = 0; }
    if (!s) return 0;
    const bars = [c[i]!, c[i - 1]!, c[i - 2]!], close = b.close, prev = c[i - 1]!.close;
    if (s > 0) {
      if (!(f > m && m > z && m - z >= 0.30 * a && m >= m3)) return 0;
      if (!(Math.min(...bars.map((k) => k.low)) <= f && Math.min(...bars.map((k) => k.close)) >= m - 0.15 * a)) return 0;
      if (!(close > f && prev <= f0 && close - f <= 0.7 * a)) return 0;
      return 1;
    }
    if (!(f < m && m < z && z - m >= 0.30 * a && m <= m3)) return 0;
    if (!(Math.max(...bars.map((k) => k.high)) >= f && Math.max(...bars.map((k) => k.close)) <= m + 0.15 * a)) return 0;
    if (!(close < f && prev >= f0 && f - close <= 0.7 * a)) return 0;
    return -1;
  });
  return onePerSwing(x, atrRegime(x, raw, 80, 0.15), e34, 4);
}

/** Owner's 1H round 2: the same 9/21/50 pullback, plus daily range location and one pullback per swing. */
function pullback92150v3(x: SignalContext): Int8Array {
  const base = pullback92150(x, false);
  return onePerSwing(x, dailyRangeLocation(x, base), ema(closes(x.candles), 21), 6);
}

/**
 * RRG as the selection layer (owner, 2026-09-27): keep an entry only when the
 * coin's daily RRG reading vs BTC is strong the trade's way (RS-Ratio +
 * RS-Momentum above 200 for longs, below for shorts), read on the last daily
 * bar closed at the entry. BTC itself passes.
 */
const RRG_CFG = resolveConfig({});
function rrgAgree(x: SignalContext, sig: Int8Array, bars = 120): Int8Array {
  if (x.symbol === 'BTCUSDT') return sig;
  const d = x.data.candles['1d'] ?? [], b = x.btc.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const btcAt = new Map(b.map((c) => [c.openTime, c.close]));
  const memo = new Map<number, number | null>();
  return Int8Array.from(sig, (s, i) => {
    if (!s) return 0;
    const j = barAt(d, day, x.candles[i]!.openTime + iv);
    if (j < 0) return 0;
    let v = memo.get(j);
    if (v === undefined) {
      const rows = d.slice(Math.max(0, j - bars - 1), j + 1).filter((c) => btcAt.has(c.openTime));
      const r = rows.length > 20 ? readRrg(rows.map((c) => c.close), rows.map((c) => btcAt.get(c.openTime)!), 'BTC', RRG_CFG) : null;
      v = r ? r.point.x - 100 + (r.point.y - 100) : null;
      memo.set(j, v);
    }
    if (v == null) return 0;
    return (s > 0 ? v > 0 : v < 0) ? s : 0;
  });
}

/**
 * RRG geometry filters (owner, 2026-09-27, from a second model's notes): read
 * which way the daily tail is turning instead of where the dot sits.
 * Daily points are computed once per coin over its whole history; every
 * window in computeSeries is trailing, so the point at a day uses only data
 * up to that day's close.
 */
type DailyRrg = { at: Map<number, number>; pts: RrgPoint[]; first: number; own: ReadonlyArray<Candle>; bench: ReadonlyArray<Candle> | null };
// One entry per coin x benchmark x preset, rebuilt when the candle arrays change (so a long-running worker doesn't grow it).
const DAILY_RRG = new Map<string, DailyRrg>();
function dailyRrg(key: string, own: ReadonlyArray<Candle>, bench: ReadonlyArray<Candle> | null, preset: 'fast' | 'balanced'): DailyRrg {
  const k = `${key}|${bench ? 'BTC' : 'USD'}|${preset}`;
  let r = DAILY_RRG.get(k);
  if (!r || r.own !== own || r.bench !== bench) {
    const settings = RRG_PRESETS.find((p) => p.key === preset)!.settings;
    const b = bench ? new Map(bench.map((c) => [c.openTime, c.close])) : null;
    const rows = b ? own.filter((c) => b.has(c.openTime)) : [...own];
    const pts = computeSeries(rows.map((c) => c.close), rows.map((c) => (b ? b.get(c.openTime)! : 1)), { ...settings, zscore: true });
    r = { at: new Map(rows.map((c, i) => [c.openTime, i])), pts, first: firstValidIndex(settings), own, bench };
    DAILY_RRG.set(k, r);
  }
  return r;
}

/** +1 / -1 / 0: the tail's 3-day heading leans up-right / down-left (dx + dy); with `mom`, RS-Momentum must also be rising / falling on the day. */
function rrgTurn(r: DailyRrg, dayOpen: number, mom: boolean): number {
  const k = r.at.get(dayOpen);
  if (k == null || k - 3 < r.first) return 0;
  const p = r.pts[k]!, a = r.pts[k - 3]!, q = r.pts[k - 1]!;
  const lean = p.x - a.x + (p.y - a.y);
  const dm = p.y - q.y;
  if (!Number.isFinite(lean)) return 0;
  if (lean > 0 && (!mom || dm > 0)) return 1;
  if (lean < 0 && (!mom || dm < 0)) return -1;
  return 0;
}

/**
 * The bot's RRG direction selection at one daily close (`dayOpen` = that
 * day's open time): +1 = longs allowed, -1 = shorts allowed, 0 = neither.
 * heading: 3-day lean with RS-Momentum rising / falling; fastslow: the lean
 * agrees on the Balanced and Fast presets.
 */
export function rrgDirectionAt(symbol: string, own: ReadonlyArray<Candle>, btc: ReadonlyArray<Candle>, dayOpen: number, mode: 'heading' | 'fastslow'): number {
  const slow = rrgTurn(dailyRrg(symbol, own, btc, 'balanced'), dayOpen, mode === 'heading');
  if (mode === 'heading' || slow === 0) return slow;
  return rrgTurn(dailyRrg(symbol, own, btc, 'fast'), dayOpen, false) === slow ? slow : 0;
}

/** BTC's own daily RRG vs USD at one daily close: +1 = leaning up-right (longs allowed), -1 = down-left (shorts), 0 = neither. */
export function btcRegimeAt(btc: ReadonlyArray<Candle>, dayOpen: number): number {
  return rrgTurn(dailyRrg('BTCUSDT', btc, null, 'balanced'), dayOpen, false);
}

/** The daily RRG tail's 3-day lean vs BTC (dx + dy; > 0 = turning up-right) at one daily close, or null without enough history. */
export function rrgLeanAt(symbol: string, own: ReadonlyArray<Candle>, btc: ReadonlyArray<Candle>, dayOpen: number, preset: 'fast' | 'balanced'): number | null {
  const r = dailyRrg(symbol, own, btc, preset);
  const k = r.at.get(dayOpen);
  if (k == null || k - 3 < r.first) return null;
  const v = r.pts[k]!.x - r.pts[k - 3]!.x + (r.pts[k]!.y - r.pts[k - 3]!.y);
  return Number.isFinite(v) ? v : null;
}

type RrgGeo = 'heading' | 'fastslow' | 'btcregime';
function rrgGeometry(x: SignalContext, sig: Int8Array, mode: RrgGeo): Int8Array {
  const d = x.data.candles['1d'] ?? [], b = x.btc.candles['1d'] ?? [];
  const day = intervalMs('1d'), iv = intervalMs(x.tf);
  const isBtc = x.symbol === 'BTCUSDT';
  const vsBtc = mode !== 'btcregime' && !isBtc ? dailyRrg(x.symbol, d, b, 'balanced') : null;
  const vsBtcFast = mode === 'fastslow' && !isBtc ? dailyRrg(x.symbol, d, b, 'fast') : null;
  const btcUsd = mode === 'btcregime' ? dailyRrg('BTCUSDT', b, null, 'balanced') : null;
  return Int8Array.from(sig, (s, i) => {
    if (!s) return 0;
    const t = x.candles[i]!.openTime + iv;
    if (mode === 'btcregime') {
      const j = barAt(b, day, t);
      return j >= 0 && rrgTurn(btcUsd!, b[j]!.openTime, false) === s ? s : 0;
    }
    if (isBtc) return s;
    const j = barAt(d, day, t);
    if (j < 0) return 0;
    const o = d[j]!.openTime;
    if (mode === 'heading') return rrgTurn(vsBtc!, o, true) === s ? s : 0;
    return rrgTurn(vsBtc!, o, false) === s && rrgTurn(vsBtcFast!, o, false) === s ? s : 0;
  });
}

/** Owner's 1H round 3: the 9/21/50 pullback with RRG agreement (replacing daily range location) and one pullback per swing. */
function pullback92150v4(x: SignalContext): Int8Array {
  return onePerSwing(x, rrgAgree(x, pullback92150(x, false)), ema(closes(x.candles), 21), 6);
}

function pullback92150(x: SignalContext, sep: boolean): Int8Array {
  const c = x.candles, cl = closes(c);
  const e9 = ema(cl, 9), e21 = ema(cl, 21), e50 = ema(cl, 50), atr = atrWilder(c, 14);
  const read = (tf: Tf) => { const k = x.data.candles[tf] ?? []; return { k, iv: intervalMs(tf), e: ema(closes(k), 50) }; };
  const d = read('1d'), h4 = read('4h');
  const iv = intervalMs(x.tf);
  const bias = (t: number): number => {
    const j = barAt(d.k, d.iv, t);
    const e = j >= 5 ? d.e[j] : null, e0 = j >= 5 ? d.e[j - 5] : null;
    if (e == null || e0 == null) return 0;
    const dc = d.k[j]!.close;
    const side = dc > e && e > e0 ? 1 : dc < e && e < e0 ? -1 : 0;
    if (!side) return 0;
    const h = barAt(h4.k, h4.iv, t);
    const he = h >= 4 ? h4.e[h] : null, he0 = h >= 4 ? h4.e[h - 4] : null;
    if (he != null && he0 != null) {
      const hc = h4.k[h]!.close;
      if (side > 0 && hc < he && he < he0) return 0;
      if (side < 0 && hc > he && he > he0) return 0;
    }
    return side;
  };
  const raw = Int8Array.from(c, (b, i) => {
    if (i < 3) return 0;
    const a = atr[i], f = e9[i], m = e21[i], z = e50[i], f0 = e9[i - 1], m0 = e21[i - 1];
    if (a == null || f == null || m == null || z == null || f0 == null || m0 == null) return 0;
    const s = bias(b.openTime + iv);
    if (!s) return 0;
    const close = b.close, prev = c[i - 1]!.close;
    const lows = [c[i]!, c[i - 1]!, c[i - 2]!];
    if (s > 0) {
      if (!(f > m && m > z && m >= m0)) return 0;
      if (sep && m - z < 0.25 * a) return 0;
      if (!(Math.min(...lows.map((k) => k.low)) <= f && Math.min(...lows.map((k) => k.close)) >= m - 0.1 * a)) return 0;
      if (!(close > f && prev <= f0 && close - f <= 0.8 * a)) return 0;
      return 1;
    }
    if (!(f < m && m < z && m <= m0)) return 0;
    if (sep && z - m < 0.25 * a) return 0;
    if (!(Math.max(...lows.map((k) => k.high)) >= f && Math.max(...lows.map((k) => k.close)) <= m + 0.1 * a)) return 0;
    if (!(close < f && prev >= f0 && f - close <= 0.8 * a)) return 0;
    return -1;
  });
  const vol = withContext(x, raw, { vol: true });
  // One signal per side per 6 bars.
  const last = { 1: -1e9, [-1]: -1e9 } as Record<number, number>;
  return Int8Array.from(vol, (s, i) => {
    if (!s) return 0;
    if (i - last[s]! < 6) return 0;
    last[s] = i;
    return s;
  });
}

const ema921 = (x: SignalContext) => crossOf(ema(closes(x.candles), 9), ema(closes(x.candles), 21));

export const SIGNALS: SignalDef[] = [
  // Trend following.
  { id: 'ema_9_21', family: 'trend', what: 'EMA 9 crosses EMA 21', build: ema921 },
  { id: 'ema_50_200', family: 'trend', what: 'EMA 50 crosses EMA 200', build: (x) => crossOf(ema(closes(x.candles), 50), ema(closes(x.candles), 200)) },
  { id: 'supertrend', family: 'trend', what: 'Supertrend (10, 3) flips', build: (x) => onChange(supertrend(x.candles, 10, 3).dir.map((d) => (d ?? 0) as Sign)) },
  { id: 'macd_flip', family: 'trend', what: 'MACD (12, 26, 9) histogram changes sign', build: (x) => onChange(macdHistogram(closes(x.candles)).map(sign)) },
  { id: 'ema50_trend', family: 'trend', what: 'close and EMA 50 slope agree (confluence C1) starts', build: ema50Trend },
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
  // Round 3 (owner's EMA / structure note): one layer at a time on rsi_mtf, then the recommended stack.
  { id: 'rsi_mtf_struct', family: 'mean-reversion', what: 'as rsi_mtf, plus daily and 4H swing structure agree (HH/HL or LH/LL)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, structure: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_ema', family: 'mean-reversion', what: 'as rsi_mtf, plus daily EMA 50 above 200 and close above 200 (mirror)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, emaStack: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_obv', family: 'mean-reversion', what: 'as rsi_mtf, plus OBV rising over 5 trigger bars (falling for shorts)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, obv: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_macd', family: 'mean-reversion', what: 'as rsi_mtf, plus 4H MACD histogram turning the trade\'s way', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, macd4h: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_fund', family: 'mean-reversion', what: 'as rsi_mtf, skipping longs when funding is crowded long (shorts when crowded short)', tfs: ['1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, funding: true }) },
  { id: 'rsi_mtf_stack', family: 'mean-reversion', what: 'recommended stack: daily RSI > 50, daily + 4H structure, daily EMA 50/200 stack, 4H pullback 30-45, trigger back above 30', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, biasLong: 50, biasShort: 50, structure: true, emaStack: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_stack_obv', family: 'mean-reversion', what: 'recommended stack plus the OBV confirmation', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, biasLong: 50, biasShort: 50, structure: true, emaStack: true, obv: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi4h_ma200', family: 'mean-reversion', what: 'the cited BTC test: 4H RSI back above 30 (below 70) with the daily close above (below) its 200 SMA; no other filter', tfs: ['4h'], build: (x) => rsiMtf(x, { biasLong: -1, biasShort: 101, pull: [0, 100], trig: 30, ma200: true }) },
  // Round 4 (owner's EMA settings note): EMA roles by timeframe, one change at a time.
  { id: 'rsi_mtf_e20', family: 'mean-reversion', what: 'as rsi_mtf, plus the last 4H bar dipped to its EMA 20 and closed back above (mirror)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, ema4hTouch: 20, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_e50', family: 'mean-reversion', what: 'as rsi_mtf, plus the last 4H bar dipped to its EMA 50 and closed back above (mirror)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, ema4hTouch: 50, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_ribbon', family: 'mean-reversion', what: 'as rsi_mtf, plus daily EMA 20 > 50 > 100 > 200 (mirror)', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { ...RSI_BASE, ribbon: true, oneHourTurn: x.tf === '15m' }) },
  { id: 'rsi_mtf_lean', family: 'mean-reversion', what: '"start simple": daily RSI > 50 and close above the 200 SMA, 4H bar dipped to EMA 20, trigger RSI back above 30', tfs: ['15m', '1h'], build: (x) => rsiMtf(x, { biasLong: 50, biasShort: 50, pull: [0, 100], trig: 30, ma200: true, ema4hTouch: 20, oneHourTurn: x.tf === '15m' }) },
  { id: 'ema_pullback_4h', family: 'trend', what: 'no RSI: daily close above 200 SMA, 4H EMA 20 > 50, a 4H bar dips to EMA 20 and closes above (mirror)', tfs: ['4h'], build: (x) => emaPullback4h(x) },
  // Context (owner: BTC's daily trend and swing structure are essential) as filters on the passers.
  { id: 'ema50_trend_btc', family: 'trend', what: 'ema50_trend, only when BTC\'s daily trend agrees', tfs: ['4h', '1d'], build: (x) => withContext(x, ema50Trend(x), { btc: true }) },
  { id: 'ema50_trend_struct', family: 'trend', what: 'ema50_trend, only when the coin\'s daily swing structure agrees', tfs: ['4h', '1d'], build: (x) => withContext(x, ema50Trend(x), { structure: true }) },
  { id: 'ema50_trend_both', family: 'trend', what: 'ema50_trend, only when BTC\'s daily trend and the coin\'s daily structure agree', tfs: ['4h', '1d'], build: (x) => withContext(x, ema50Trend(x), { btc: true, structure: true }) },
  { id: 'ema_9_21_btc', family: 'trend', what: 'ema_9_21, only when BTC\'s daily trend agrees', tfs: ['4h', '1d'], build: (x) => withContext(x, ema921(x), { btc: true }) },
  { id: 'ema_9_21_struct', family: 'trend', what: 'ema_9_21, only when the coin\'s daily swing structure agrees', tfs: ['4h', '1d'], build: (x) => withContext(x, ema921(x), { structure: true }) },
  // ATR layer (owner): skip entries when volatility is in the extreme top or bottom 10% of its last 100 bars.
  { id: 'ema50_trend_vol', family: 'trend', what: 'ema50_trend, only when ATR(14) % is between the 10th and 90th percentile of its last 100 bars', tfs: ['4h', '1d'], build: (x) => withContext(x, ema50Trend(x), { vol: true }) },
  // Owner, 2026-09-27: the RRG direction filters from the 1H/4H pullback tests, on the daily EMA 50 lead.
  { id: 'ema50_trend_vol_heading', family: 'trend', what: 'ema50_trend_vol + daily RRG vs BTC heading up-right with RS-Momentum rising (short: mirror)', tfs: ['1d'], build: (x) => rrgGeometry(x, withContext(x, ema50Trend(x), { vol: true }), 'heading') },
  { id: 'ema50_trend_vol_fastslow', family: 'trend', what: 'ema50_trend_vol + daily RRG vs BTC heading agreeing on the Balanced and Fast presets', tfs: ['1d'], build: (x) => rrgGeometry(x, withContext(x, ema50Trend(x), { vol: true }), 'fastslow') },
  { id: 'ema50_trend_vol_btcregime', family: 'trend', what: 'ema50_trend_vol + BTC own daily RRG vs USD heading in the trade direction (regime switch)', tfs: ['1d'], build: (x) => rrgGeometry(x, withContext(x, ema50Trend(x), { vol: true }), 'btcregime') },
  { id: 'ema50_trend_vol_range', family: 'trend', what: 'ema50_trend_vol + daily range location (close in the upper 55% of 20 daily bars; short: lower)', tfs: ['1d'], build: (x) => dailyRangeLocation(x, withContext(x, ema50Trend(x), { vol: true })) },
  { id: 'ema50_trend_vol_rrg', family: 'trend', what: 'ema50_trend_vol + daily RRG vs BTC position agreeing (strong the trade\'s way)', tfs: ['1d'], build: (x) => rrgAgree(x, withContext(x, ema50Trend(x), { vol: true })) },
  // Owner's R-raising filters, one at a time on the lead (ema50_trend_vol).
  { id: 'ema50_trend_vol_slope', family: 'trend', what: 'ema50_trend_vol, plus EMA 50 moved at least 1% over 10 bars the trade\'s way', tfs: ['1d'], build: (x) => withContext(x, ema50Trend(x), { vol: true, slopePct: 1 }) },
  { id: 'ema50_trend_vol_volume', family: 'trend', what: 'ema50_trend_vol, plus entry-bar volume at least 1.5x its 20-bar mean', tfs: ['1d'], build: (x) => withContext(x, ema50Trend(x), { vol: true, volumeMult: 1.5 }) },
  { id: 'ema50_trend_vol_ema', family: 'trend', what: 'ema50_trend_vol, plus close on the trade\'s side of EMA 20 and EMA 100', tfs: ['1d'], build: (x) => withContext(x, ema50Trend(x), { vol: true, secondaryEmas: true }) },
  // Owner's intraday model (2026-09-27): EMA 12-23-50 stack on 1H, pure and with the daily EMA 50 trend + ATR regime filters.
  { id: 'ema_12_23_50', family: 'trend', what: 'EMA 12-23-50 stack: close and EMA 23 on the trend side of EMA 50; EMA 12/23 cross or pullback-and-reclaim of EMA 12', tfs: ['1h'], build: ema122350, stop: structureStop(23) },
  // Owner's optimized 1H spec: 9/21/50 pullback, daily EMA 50 boss + 4H veto, structure stop (used by the r2 exit).
  { id: 'pb_9_21_50', family: 'trend', what: '1H 9/21/50 pullback: daily EMA 50 slope boss, 4H veto; dip to EMA 9, hold EMA 21, reclaim EMA 9; not extended; ATR regime; 6-bar cooldown', tfs: ['1h'], build: (x) => pullback92150(x, false), stop: structureStop(21) },
  { id: 'pb_9_21_50_v3', family: 'trend', what: 'pb_9_21_50 plus daily range location (close in the upper 55% of 20 daily bars; short: lower) and one pullback per swing; stop collar 1.0-1.6 ATR', tfs: ['1h'], build: pullback92150v3, stop: structureStop(21, { max: 1.6 }) },
  { id: 'pb_13_34_50_4h', family: 'trend', what: '4H 13/34/50 pullback: daily EMA 50 slope bias; EMA 34 >= 0.30 ATR clear of EMA 50; dip to EMA 13 holding EMA 34, reclaim EMA 13; not extended (0.7 ATR); ATR regime 15%/80; one per swing; stop 1.0-2.0 ATR', tfs: ['4h'], build: (x) => pullback4h(x, false), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0 }) },
  // Owner's round 3 (2026-09-27): cost gate on the stop (round trip ~0.12% on 1H, ~0.17% on 4H incl. funding, <= ~6% of the stop).
  { id: 'pb_9_21_50_v4', family: 'trend', what: 'pb_9_21_50 + RRG vs BTC agreeing (daily) + one pullback per swing; stop 1.0-1.6 ATR and at least 2.0% of price (cost gate)', tfs: ['1h'], build: pullback92150v4, stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_9_21_50_sw', family: 'trend', what: 'pb_9_21_50 + one pullback per swing; stop 1.0-1.6 ATR and at least 2.0% of price (cost gate); selection (range / RRG) applied by the bot slot', tfs: ['1h'], build: (x) => onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  // The bot slot's other two coin selections, applied after one per swing like the slot does (owner, 2026-09-27: test every dashboard variant).
  { id: 'pb_9_21_50_sw_range', family: 'trend', what: 'pb_9_21_50_sw (2.0% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower)', tfs: ['1h'], build: (x) => dailyRangeLocation(x, onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6)), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_9_21_50_sw_rrg', family: 'trend', what: 'pb_9_21_50_sw (2.0% cost gate) + daily RRG vs BTC position agreeing (strong the trade\'s way)', tfs: ['1h'], build: (x) => rrgAgree(x, onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6)), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_13_34_50_4h_v2', family: 'trend', what: 'pb_13_34_50_4h with a cost gate: stop 1.0-2.0 ATR and at least 2.8% of price', tfs: ['4h'], build: (x) => pullback4h(x, false), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower)', tfs: ['4h'], build: (x) => dailyRangeLocation(x, pullback4h(x, false)), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 70 or daily RSI >= 76 (owner)', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false))), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv2', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 70 and daily RSI >= 76 (owner)', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'both'), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv_h4', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 70, daily >= 76 or 4H >= 78.5 (owner)', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 70, d: 76, h4: 78.5 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_h4rsi', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when 4H RSI >= 78.5 (owner)', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: null, d: null, h4: 78.5 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_wrsi', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 70', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 70, d: null }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_drsi', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when daily RSI >= 76', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: null, d: 76 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv_tight', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 65 or daily >= 72', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 65, d: 72 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv_60_68', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 60 or daily >= 68', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 60, d: 68 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv_62_70', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 62 or daily >= 70', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 62, d: 70 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_range_obv_loose', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily range location (close in the upper 55% of 20 daily bars; short: lower) + no long when weekly RSI >= 75 or daily >= 80', tfs: ['4h'], build: (x) => overboughtLongVeto(x, dailyRangeLocation(x, pullback4h(x, false)), 'either', { w: 75, d: 80 }), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_rrg', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily RRG vs BTC agreeing', tfs: ['4h'], build: (x) => rrgAgree(x, pullback4h(x, false)), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_13_34_50_4h_heading', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily RRG vs BTC heading up-right with RS-Momentum rising (short: mirror)', tfs: ['4h'], build: (x) => rrgGeometry(x, pullback4h(x, false), 'heading'), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_9_21_50_sw_heading', family: 'trend', what: 'pb_9_21_50_sw (2.0% cost gate) + daily RRG vs BTC heading up-right with RS-Momentum rising (short: mirror)', tfs: ['1h'], build: (x) => rrgGeometry(x, onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6), 'heading'), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_13_34_50_4h_fastslow', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + daily RRG vs BTC heading agreeing on the Balanced and Fast presets', tfs: ['4h'], build: (x) => rrgGeometry(x, pullback4h(x, false), 'fastslow'), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_9_21_50_sw_fastslow', family: 'trend', what: 'pb_9_21_50_sw (2.0% cost gate) + daily RRG vs BTC heading agreeing on the Balanced and Fast presets', tfs: ['1h'], build: (x) => rrgGeometry(x, onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6), 'fastslow'), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_13_34_50_4h_btcregime', family: 'trend', what: 'pb_13_34_50_4h_v2 (2.8% cost gate) + BTC own daily RRG vs USD heading in the trade direction (regime switch)', tfs: ['4h'], build: (x) => rrgGeometry(x, pullback4h(x, false), 'btcregime'), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0, minStopPct: 2.8 }) },
  { id: 'pb_9_21_50_sw_btcregime', family: 'trend', what: 'pb_9_21_50_sw (2.0% cost gate) + BTC own daily RRG vs USD heading in the trade direction (regime switch)', tfs: ['1h'], build: (x) => rrgGeometry(x, onePerSwing(x, pullback92150(x, false), ema(closes(x.candles), 21), 6), 'btcregime'), stop: structureStop(21, { max: 1.6, minStopPct: 2.0 }) },
  { id: 'pb_13_34_50_4h_d200', family: 'trend', what: 'pb_13_34_50_4h plus the daily EMA 200 veto (longs above it, shorts below)', tfs: ['4h'], build: (x) => pullback4h(x, true), stop: structureStop(34, { buffer: 0.2, min: 1.0, max: 2.0 }) },
  { id: 'pb_9_21_50_sep', family: 'trend', what: 'pb_9_21_50 plus separation: EMA 21 at least 0.25 ATR clear of EMA 50', tfs: ['1h'], build: (x) => pullback92150(x, true), stop: structureStop(21) },
  { id: 'ema_12_23_50_htf_vol', family: 'trend', what: 'ema_12_23_50, only with the coin\'s daily EMA 50 trend and ATR(14) % between its 10th and 90th percentile', tfs: ['1h'], build: (x) => withContext(x, ema122350(x), { htfTrend: true, vol: true }) },
  // Owner's dual higher-timeframe bias for the 1H 12-23-50 model, in the owner's testing order.
  { id: 'ema_12_23_50_dual', family: 'trend', what: 'ema_12_23_50 with the dual HTF bias (daily and 4H close on the same side of their EMA 50) and the ATR regime filter', tfs: ['1h'], build: (x) => ema122350Dual(x, { slope: false, structure: false }) },
  { id: 'ema_12_23_50_dual_slope', family: 'trend', what: 'ema_12_23_50_dual plus slope strength (daily EMA 50 moved > 0.04% over 4 bars, 4H > 0.028%)', tfs: ['1h'], build: (x) => ema122350Dual(x, { slope: true, structure: false }) },
  { id: 'ema_12_23_50_dual_slope_struct', family: 'trend', what: 'ema_12_23_50_dual_slope plus 5-bar pivot structure on 1H (higher swing high for longs, lower swing low for shorts)', tfs: ['1h'], build: (x) => ema122350Dual(x, { slope: true, structure: true }) },
  { id: 'ema_9_21_vol', family: 'trend', what: 'ema_9_21, only when ATR(14) % is between the 10th and 90th percentile of its last 100 bars', tfs: ['4h', '1d'], build: (x) => withContext(x, ema921(x), { vol: true }) },
  { id: 'ema_9_21_both', family: 'trend', what: 'ema_9_21, only when BTC\'s daily trend and the coin\'s daily structure agree', tfs: ['4h', '1d'], build: (x) => withContext(x, ema921(x), { btc: true, structure: true }) },
];

// Room to TP1 (owner, 2026-09-28) on the 4H daily-range setup: any swing, or zones of 2+ touches; alone and with the RSI filter.
{
  const base = SIGNALS.find((d) => d.id === 'pb_13_34_50_4h_range');
  if (base) {
    const room = (x: SignalContext, sig: Int8Array, minTouches: number) => roomToTarget(x, sig, base.stop, { minTouches });
    SIGNALS.push(
      { ...base, id: 'pb_13_34_50_4h_range_room1', what: `${base.what} + skip when a daily swing sits before TP1`, build: (x) => room(x, base.build(x), 1) },
      { ...base, id: 'pb_13_34_50_4h_range_room2', what: `${base.what} + skip when a daily zone (2+ touches) sits before TP1`, build: (x) => room(x, base.build(x), 2) },
      { ...base, id: 'pb_13_34_50_4h_range_room1_r62', what: `${base.what} + room to TP1 (any swing) + RSI 62/70`, build: (x) => room(x, overboughtLongVeto(x, base.build(x), 'either', { w: 62, d: 70 }), 1) },
      { ...base, id: 'pb_13_34_50_4h_range_room2_r62', what: `${base.what} + room to TP1 (zones) + RSI 62/70`, build: (x) => room(x, overboughtLongVeto(x, base.build(x), 'either', { w: 62, d: 70 }), 2) },
    );
  }
}
// RSI filter (weekly >= 62 or daily >= 70 blocks longs) on every 4H coin selection (owner, 2026-09-28): `<id>_r62`.
for (const id of ['pb_13_34_50_4h_v2', 'pb_13_34_50_4h_range', 'pb_13_34_50_4h_rrg', 'pb_13_34_50_4h_heading', 'pb_13_34_50_4h_fastslow', 'pb_13_34_50_4h_btcregime']) {
  const base = SIGNALS.find((d) => d.id === id);
  if (base) SIGNALS.push({ ...base, id: `${id}_r62`, what: `${base.what} + no long when weekly RSI >= 62 or daily RSI >= 70`, build: (x) => overboughtLongVeto(x, base.build(x), 'either', { w: 62, d: 70 }) });
}

// The same filters on the 1H pullback (owner, 2026-09-28): RSI 62/70 on longs and room to TP1 (1.4R there), on no selection and on RRG heading (live).
for (const id of ['pb_9_21_50_sw', 'pb_9_21_50_sw_heading']) {
  const base = SIGNALS.find((d) => d.id === id);
  if (!base) continue;
  const rsiV = (x: SignalContext, sig: Int8Array) => overboughtLongVeto(x, sig, 'either', { w: 62, d: 70 });
  const room = (x: SignalContext, sig: Int8Array, minTouches: number) => roomToTarget(x, sig, base.stop, { tpR: 1.4, minTouches });
  SIGNALS.push(
    { ...base, id: `${id}_r62`, what: `${base.what} + RSI 62/70 on longs`, build: (x) => rsiV(x, base.build(x)) },
    { ...base, id: `${id}_room1`, what: `${base.what} + room to TP1 (any swing)`, build: (x) => room(x, base.build(x), 1) },
    { ...base, id: `${id}_room2`, what: `${base.what} + room to TP1 (zones)`, build: (x) => room(x, base.build(x), 2) },
    { ...base, id: `${id}_room1_r62`, what: `${base.what} + room to TP1 (any swing) + RSI 62/70`, build: (x) => room(x, rsiV(x, base.build(x)), 1) },
    { ...base, id: `${id}_room2_r62`, what: `${base.what} + room to TP1 (zones) + RSI 62/70`, build: (x) => room(x, rsiV(x, base.build(x)), 2) },
  );
}

// Short-side RSI on the live 4H setup (range + RSI 62/70 + room zones), owner 2026-09-28: `<id>_s<name>`.
{
  const base = SIGNALS.find((d) => d.id === 'pb_13_34_50_4h_range_room2_r62');
  const variants: [string, Parameters<typeof shortRsiVeto>[2]][] = [
    ['lo40_30', { low: { w: 40, d: 30 } }],
    ['lo35_25', { low: { w: 35, d: 25 } }],
    ['lo45_35', { low: { w: 45, d: 35 } }],
    ['lod30', { low: { d: 30 } }],
    ['hiw55', { high: { w: 55 } }],
    ['hiw50', { high: { w: 50 } }],
    ['hiw53', { high: { w: 53 } }],
    ['hiw57', { high: { w: 57 } }],
  ];
  if (base) for (const [n, lim] of variants) SIGNALS.push({ ...base, id: `${base.id}_s${n}`, what: `${base.what} + short RSI veto ${n}`, build: (x) => shortRsiVeto(x, base.build(x), lim) });
}

// Entry timing tests on the live 4H setup (owner, 2026-09-28): `_rand<seed>` moves each signal to a random 4H
// close within +-6 bars (same coin, same side; the stop rules still apply there), a null for the pullback trigger;
// `_confirm` waits one more close and enters only if it is still on the trade's side of EMA 13.
{
  const base = SIGNALS.find((d) => d.id === 'pb_13_34_50_4h_range_room2_r62_shiw55');
  if (base) {
    const jitter = (x: SignalContext, sig: Int8Array, seed: number): Int8Array => {
      let h = seed * 2654435761;
      for (const ch of x.symbol) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      const rnd = () => { h = (Math.imul(h, 1103515245) + 12345) >>> 0; return h / 4294967296; };
      const out = new Int8Array(sig.length);
      sig.forEach((s, i) => {
        if (!s) return;
        const j = i + Math.floor(rnd() * 13) - 6;
        if (j >= 0 && j < sig.length) out[j] = s;
      });
      return out;
    };
    const confirm = (x: SignalContext, sig: Int8Array): Int8Array => {
      const e = ema(closes(x.candles), 13);
      const out = new Int8Array(sig.length);
      sig.forEach((s, i) => {
        const z = e[i + 1];
        if (!s || i + 1 >= sig.length || z == null) return;
        const c = x.candles[i + 1]!.close;
        if (s > 0 ? c > z : c < z) out[i + 1] = s;
      });
      return out;
    };
    for (const seed of Array.from({ length: 20 }, (_, k) => k + 1)) SIGNALS.push({ ...base, id: `${base.id}_rand${seed}`, what: `${base.what} + entry moved to a random close within 6 bars (seed ${seed})`, build: (x) => jitter(x, base.build(x), seed) });
    // Fixed shift: every signal moved by exactly k bars (k < 0 = before the signal fired: look-ahead, not tradeable; k > 0 = wait k closes).
    const shift = (sig: Int8Array, k: number): Int8Array => {
      const out = new Int8Array(sig.length);
      sig.forEach((s, i) => { const j = i + k; if (s && j >= 0 && j < sig.length) out[j] = s; });
      return out;
    };
    for (let k = -6; k <= 6; k++) if (k) SIGNALS.push({ ...base, id: `${base.id}_sh${k < 0 ? 'm' : 'p'}${Math.abs(k)}`, what: `${base.what} + every entry shifted ${k} bars`, build: (x) => shift(base.build(x), k) });
    SIGNALS.push({ ...base, id: `${base.id}_confirm`, what: `${base.what} + enter one close later if still beyond EMA 13`, build: (x) => confirm(x, base.build(x)) });
  }
}

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
