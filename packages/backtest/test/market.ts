// Scripted markets for the engine tests: 15m candles from explicit prices,
// resampled to 1H / 4H / 1D the way an exchange would.

import { intervalMs, type Candle } from '@bot/marketdata';
import type { SymbolData, Tf } from '../src/index';

export const Q = intervalMs('15m');
export const HOUR = intervalMs('1h');
/** Monday 2026-01-05 00:00 UTC. */
export const START = Date.UTC(2026, 0, 5);

export type Bar = { o: number; h: number; l: number; c: number };

/** Flat bars at `price` (tiny range so ATR is non-zero). */
export const flatBars = (n: number, price: number): Bar[] => Array.from({ length: n }, () => ({ o: price, h: price + 0.05, l: price - 0.05, c: price }));

export function toCandles(bars: ReadonlyArray<Bar>, start = START): Candle[] {
  return bars.map((b, i) => ({ openTime: start + i * Q, open: b.o, high: b.h, low: b.l, close: b.c, volume: 1000 }));
}

export function resample(c15: ReadonlyArray<Candle>, tf: Tf): Candle[] {
  const ms = intervalMs(tf);
  const out: Candle[] = [];
  for (const c of c15) {
    const open = Math.floor(c.openTime / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.openTime === open) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = (last.volume ?? 0) + (c.volume ?? 0);
    } else out.push({ ...c, openTime: open });
  }
  // Keep only complete bars.
  const per = ms / Q;
  return out.filter((b) => c15.filter((c) => c.openTime >= b.openTime && c.openTime < b.openTime + ms).length === per);
}

export function symbolData(c15: Candle[], extra: Partial<SymbolData> = {}): SymbolData {
  return {
    candles: { '15m': c15, '1h': resample(c15, '1h'), '4h': resample(c15, '4h'), '1d': resample(c15, '1d') },
    limits: { qtyStep: 0.001, minQty: 0.001 },
    ...extra,
  };
}
