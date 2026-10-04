// Plain indicators for the momentum LTF model (owner's proposal, 2026-09-27).
// Bar-indexed arrays; null until the indicator has enough history.

import type { Candle } from '@bot/marketdata';

export function ema(values: ReadonlyArray<number>, period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    e = e == null ? v : v * k + e * (1 - k);
    out.push(i < period - 1 ? null : e);
  }
  return out;
}

/** MACD histogram = MACD line (fast EMA - slow EMA) minus its signal EMA. */
export function macdHistogram(closes: ReadonlyArray<number>, fast = 12, slow = 26, signal = 9): (number | null)[] {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  const first = line.findIndex((x) => x != null);
  if (first < 0) return closes.map(() => null);
  const sig = ema(line.slice(first) as number[], signal);
  return line.map((x, i) => (x == null || i - first < 0 || sig[i - first] == null ? null : x - sig[i - first]!));
}

/** MACD line and signal line (12/26/9 by default). */
export function macdLines(closes: ReadonlyArray<number>, fast = 12, slow = 26, signal = 9): { line: (number | null)[]; sig: (number | null)[] } {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  const first = line.findIndex((x) => x != null);
  if (first < 0) return { line, sig: line.map(() => null) };
  const se = ema(line.slice(first) as number[], signal);
  return { line, sig: line.map((x, i) => (x == null || i < first ? null : se[i - first] ?? null)) };
}

/** Stochastic %K (smoothed) and %D. */
export function stochastic(candles: ReadonlyArray<Candle>, period = 14, kSmooth = 3, dSmooth = 3): { k: (number | null)[]; d: (number | null)[] } {
  const raw: (number | null)[] = candles.map((c, i) => {
    if (i < period - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, candles[j]!.high); lo = Math.min(lo, candles[j]!.low); }
    return hi > lo ? ((c.close - lo) / (hi - lo)) * 100 : 50;
  });
  const sma = (xs: (number | null)[], n: number) => xs.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) { const v = xs[j]; if (v == null) return null; sum += v; }
    return sum / n;
  });
  const k = sma(raw, kSmooth);
  return { k, d: sma(k, dSmooth) };
}

// ---- Indicators for the trend / mean-reversion LTF model (owner's proposal, 2026-09-27) ----

export function sma(values: ReadonlyArray<number | null>, period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) { const v = values[j]; if (v == null) return null; sum += v; }
    return sum / period;
  });
}

/** Wilder's RSI. */
export function rsi(closes: ReadonlyArray<number>, period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { out.push(null); continue; }
    const d = closes[i]! - closes[i - 1]!;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g; loss += l;
      if (i < period) { out.push(null); continue; }
      gain /= period; loss /= period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

/** Wilder's ATR (true range smoothed like RSI). */
export function atrWilder(candles: ReadonlyArray<Candle>, period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let a: number | null = null;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = i > 0 ? candles[i - 1]!.close : c.close;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    if (i < period) { sum += tr; out.push(i === period - 1 ? (a = sum / period) : null); continue; }
    a = (a! * (period - 1) + tr) / period;
    out.push(a);
  }
  return out;
}

/** Supertrend: direction (+1 up, -1 down) and the stop line, per bar. */
export function supertrend(candles: ReadonlyArray<Candle>, period = 10, mult = 3): { dir: (1 | -1 | null)[]; line: (number | null)[] } {
  const atr = atrWilder(candles, period);
  const dir: (1 | -1 | null)[] = [];
  const line: (number | null)[] = [];
  let upper: number | null = null;
  let lower: number | null = null;
  let d: 1 | -1 | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const a = atr[i];
    if (a == null) { dir.push(null); line.push(null); continue; }
    const mid = (c.high + c.low) / 2;
    let up = mid + mult * a;
    let lo = mid - mult * a;
    const pc = i > 0 ? candles[i - 1]!.close : c.close;
    // Bands only ratchet in the trend's favour.
    if (upper != null && (up > upper && pc <= upper)) up = upper;
    if (lower != null && (lo < lower && pc >= lower)) lo = lower;
    if (d == null) d = c.close > up ? 1 : -1;
    else if (d === -1 && c.close > upper!) d = 1;
    else if (d === 1 && c.close < lower!) d = -1;
    upper = up; lower = lo;
    dir.push(d);
    line.push(d === 1 ? lo : up);
  }
  return { dir, line };
}

/** Session VWAP: volume-weighted typical price, reset at 00:00 UTC. null where volume is missing. */
export function sessionVwap(candles: ReadonlyArray<Candle>): (number | null)[] {
  const DAY = 86_400_000;
  const out: (number | null)[] = [];
  let day = -1;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const d = Math.floor(c.openTime / DAY);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    if (c.volume == null || !(c.volume > 0)) { out.push(null); continue; }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    out.push(pv / vol);
  }
  return out;
}

/** Bollinger Bands on the close. */
export function bollinger(closes: ReadonlyArray<number>, period = 20, mult = 2): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid = sma(closes, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) { upper.push(null); lower.push(null); continue; }
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(ss / period);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}

/** Wilder's ADX (with +DI / -DI). */
export function adx(candles: ReadonlyArray<Candle>, period = 14): { adx: (number | null)[]; pdi: (number | null)[]; mdi: (number | null)[] } {
  const n = candles.length, out = { adx: Array<number | null>(n).fill(null), pdi: Array<number | null>(n).fill(null), mdi: Array<number | null>(n).fill(null) };
  let tr = 0, pdm = 0, mdm = 0, dxSum = 0, adxV: number | null = null;
  for (let i = 1; i < n; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    const up = c.high - p.high, dn = p.low - c.low;
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const pm = up > dn && up > 0 ? up : 0, mm = dn > up && dn > 0 ? dn : 0;
    if (i <= period) { tr += t; pdm += pm; mdm += mm; if (i < period) continue; }
    else { tr = tr - tr / period + t; pdm = pdm - pdm / period + pm; mdm = mdm - mdm / period + mm; }
    const pdi = tr > 0 ? (100 * pdm) / tr : 0, mdi = tr > 0 ? (100 * mdm) / tr : 0, dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    out.pdi[i] = pdi; out.mdi[i] = mdi;
    if (i < 2 * period - 1) { dxSum += dx; continue; }
    if (adxV == null) { dxSum += dx; adxV = dxSum / period; } else adxV = (adxV * (period - 1) + dx) / period;
    out.adx[i] = adxV;
  }
  return out;
}
