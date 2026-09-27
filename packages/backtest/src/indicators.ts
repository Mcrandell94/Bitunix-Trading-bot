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
