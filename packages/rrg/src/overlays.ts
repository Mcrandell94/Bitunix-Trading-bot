// Confirmation filters, ported from the dashboard's app/lib/rrgOverlays.js
// (relativeVolume, absoluteTrend, fundingFlag). Same behavior, same default
// windows, typed. The sector-composite helpers weren't needed and aren't ported.
//
// None of these may change an RS-Ratio / RS-Momentum coordinate. They read
// volume, the asset's own price and funding, never the benchmark ratio, and
// they return separate values that only feed the signal score.
//
// All windows are in BARS. The defaults (7/30 volume, 20 trend) are the
// dashboard's daily-chart values. On 1H or 4H they mean 7/30/20 of those bars.

function mean(arr: ReadonlyArray<number | null | undefined>): number | null {
  const v = arr.filter((x): x is number => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Relative volume at bar `end`: average volume over the last `shortBars`
 * bars vs the last `longBars` bars. 1 = normal, 2 = twice normal. null when
 * there isn't enough real volume data.
 */
export function relativeVolume(
  volumes: ReadonlyArray<number | null | undefined> | null | undefined,
  end: number,
  shortBars = 7,
  longBars = 30,
): number | null {
  if (!Array.isArray(volumes) || end < longBars - 1) return null;
  const recent = mean(volumes.slice(end - shortBars + 1, end + 1));
  const base = mean(volumes.slice(end - longBars + 1, end + 1));
  if (!recent || !base) return null;
  return recent / base;
}

export interface AbsoluteTrend {
  above: boolean;
  pct: number;
}

/**
 * Absolute trend: is the price at bar `end` above its own `windowBars` simple
 * average? An RRG only shows strength relative to the benchmark, so an asset
 * can sit in Leading while falling in dollars, just less than BTC.
 */
export function absoluteTrend(
  prices: ReadonlyArray<number> | null | undefined,
  end: number,
  windowBars = 20,
): AbsoluteTrend | null {
  if (!Array.isArray(prices) || end < windowBars - 1) return null;
  const avg = mean(prices.slice(end - windowBars + 1, end + 1));
  const p = prices[end];
  if (!avg || p === undefined || !Number.isFinite(p)) return null;
  return { above: p >= avg, pct: (p / avg - 1) * 100 };
}

export type FundingFlag = 'crowded-long' | 'shorts-paying' | 'neutral';

/**
 * Annualized funding (%/yr) at or above this marks crowded longs. The
 * dashboard set it at 3x Hyperliquid's ~11%/yr neutral baseline; the common
 * CEX baseline of 0.01% per 8h annualizes to the same 10.95%/yr.
 */
export const FUNDING_HOT = 33;

/** Funding flag from a perpetual's annualized funding rate (%/yr). */
export function fundingFlag(annualizedPct: number | null | undefined): FundingFlag | null {
  if (annualizedPct == null || !Number.isFinite(annualizedPct)) return null;
  if (annualizedPct >= FUNDING_HOT) return 'crowded-long';
  if (annualizedPct < 0) return 'shorts-paying';
  return 'neutral';
}

/**
 * Converts a per-interval funding rate, as a fraction (0.0001 = 0.01%), to
 * %/yr for fundingFlag. Not in the dashboard, which gets an annualized
 * figure from Hyperliquid. Check the Bitunix field's units and interval in
 * the data-layer stage before feeding it in.
 */
export function annualizeFundingRate(ratePerInterval: number, intervalHours: number): number | null {
  if (!Number.isFinite(ratePerInterval) || !(intervalHours > 0)) return null;
  return ratePerInterval * 100 * (24 / intervalHours) * 365;
}
