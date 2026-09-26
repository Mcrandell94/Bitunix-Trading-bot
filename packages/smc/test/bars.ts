// Hand-built candles for the SMC tests. Each row is [open, high, low, close].
import type { Candle } from '@bot/marketdata';

export const H = 3_600_000;
export const T0 = Date.UTC(2026, 0, 5);

export function bars(rows: ReadonlyArray<readonly [number, number, number, number]>, start = T0, step = H): Candle[] {
  return rows.map(([open, high, low, close], i) => ({ openTime: start + i * step, open, high, low, close, volume: 1000 }));
}

const flat = Array.from({ length: 14 }, () => [100, 101, 99, 100] as const);

/**
 * A textbook long: range, rally to a swing high (15), pullback to a swing
 * low (18) and a lower high (20), a wick below that low that closes back
 * above it (sweep, 22), a displacement candle closing through the lower
 * high (MSS, 24), then a candle that completes the displacement FVG (25).
 */
export const LONG_ROWS = [
  ...flat,
  [100, 103, 99.5, 102], // 14
  [102, 105, 101, 104], // 15 swing high
  [104, 104.5, 100, 101], // 16
  [101, 102, 98, 99], // 17
  [99, 100, 96, 97], // 18 swing low 96
  [97, 100, 97, 99.5], // 19
  [99.5, 101, 98, 100], // 20 lower high 101
  [100, 100.5, 97, 97.5], // 21
  [97.5, 98, 95, 96.5], // 22 sweep: wick to 95, close back above 96
  [96.5, 99, 96, 98.5], // 23
  [98.5, 104, 98.3, 103.8], // 24 displacement, closes above 101: MSS
  [103.8, 105, 102, 104.5], // 25 completes the FVG 99–102
] as const;
