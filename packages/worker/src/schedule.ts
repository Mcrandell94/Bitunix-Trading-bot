// When to scan: right after bars close, UTC. 1H closes every hour, 4H on
// hours divisible by 4, daily at 00:00 UTC (the exchange probe checks that
// Bitunix bars sit on these boundaries).

import { nextCloseTime } from '@bot/marketdata';
import type { Timeframe } from '@bot/signals';

const HOUR = 3_600_000;

/** Timeframes whose bar closes exactly at `closeTime`. */
export function closingAt(closeTime: number, timeframes: ReadonlyArray<Timeframe>): Timeframe[] {
  if (closeTime % HOUR !== 0) return [];
  const hour = new Date(closeTime).getUTCHours();
  // Longest first: a daily scan and its 4H/1H scans share candles fetched once.
  return (['1d', '4h', '1h'] as const).filter((tf) => timeframes.includes(tf)
    && (tf === '1h' || (tf === '4h' && hour % 4 === 0) || (tf === '1d' && hour === 0)));
}

/** The next scan after `now`: when to wake up and which timeframes to run. */
export function nextRun(now: number, timeframes: ReadonlyArray<Timeframe>, delayMs: number): { at: number; closeTime: number; timeframes: Timeframe[] } {
  // Every configured timeframe closes on an hour boundary, so walk hours.
  let close = nextCloseTime('1h', now - delayMs);
  for (;;) {
    const due = closingAt(close, timeframes);
    if (due.length) return { at: close + delayMs, closeTime: close, timeframes: due };
    close += HOUR;
  }
}
