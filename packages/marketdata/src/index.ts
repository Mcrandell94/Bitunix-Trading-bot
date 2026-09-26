// Exchange-agnostic candle handling. Pure: no I/O, `now` is passed in.
//
// Only CLOSED bars ever reach the RRG, and symbols are aligned on bar open
// time. A symbol with any missing bar in the window is dropped, never
// forward-filled: a filled gap would fake a flat relative move.

export interface Candle {
  /** Bar open time, ms since epoch (UTC). */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Quote-currency volume; null when the exchange didn't give one. */
  volume: number | null;
}

const MINUTE = 60_000;
const INTERVAL_MS = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': 60 * MINUTE,
  '4h': 240 * MINUTE,
  '1d': 1440 * MINUTE,
} as const;
export type IntervalName = keyof typeof INTERVAL_MS;

export function intervalMs(interval: IntervalName): number {
  return INTERVAL_MS[interval];
}

/**
 * Open time of the most recent bar that has fully closed at `now`. Bars are
 * assumed to sit on UTC boundaries (daily bars open at 00:00 UTC), which the
 * exchange probe checks.
 */
export function lastClosedOpenTime(interval: IntervalName, now: number): number {
  const ms = intervalMs(interval);
  return Math.floor(now / ms) * ms - ms;
}

/** When the bar that is open at `now` will close. */
export function nextCloseTime(interval: IntervalName, now: number): number {
  const ms = intervalMs(interval);
  return Math.floor(now / ms) * ms + ms;
}

/** Drops bars still open at `now`. */
export function closedOnly(candles: ReadonlyArray<Candle>, interval: IntervalName, now: number): Candle[] {
  const ms = intervalMs(interval);
  return candles.filter((c) => c.openTime + ms <= now);
}

export type DropReason = 'stale' | 'short' | 'gap' | 'misaligned';

export interface AlignedSeries {
  interval: IntervalName;
  /** Open times of the window, oldest first; the last one is the last closed bar. */
  openTimes: number[];
  series: Record<string, { close: number[]; volume: (number | null)[] }>;
  dropped: { symbol: string; reason: DropReason }[];
}

/**
 * Cuts every symbol to the same window of `bars` closed bars ending at the
 * last bar closed at `now`. A symbol is dropped when:
 * - stale: it has no bar for the last closed slot,
 * - short: its history starts after the window does (e.g. newly listed),
 * - gap: a bar inside the window is missing,
 * - misaligned: it has a bar off the interval grid.
 */
export function alignSeries(
  candles: Readonly<Record<string, ReadonlyArray<Candle>>>,
  interval: IntervalName,
  bars: number,
  now: number,
): AlignedSeries {
  if (!Number.isInteger(bars) || bars < 1) throw new RangeError(`bars must be a whole number >= 1, got ${bars}`);
  const ms = intervalMs(interval);
  const last = lastClosedOpenTime(interval, now);
  const openTimes = Array.from({ length: bars }, (_, i) => last - (bars - 1 - i) * ms);
  const first = openTimes[0]!;

  const series: AlignedSeries['series'] = {};
  const dropped: AlignedSeries['dropped'] = [];
  for (const [symbol, list] of Object.entries(candles)) {
    const inWindow = new Map<number, Candle>();
    let earliest = Infinity;
    let misaligned = false;
    for (const c of list) {
      if (c.openTime % ms !== 0) misaligned = true;
      earliest = Math.min(earliest, c.openTime);
      if (c.openTime >= first && c.openTime <= last) inWindow.set(c.openTime, c);
    }
    let reason: DropReason | null = null;
    if (misaligned) reason = 'misaligned';
    else if (!inWindow.has(last)) reason = 'stale';
    else if (earliest > first) reason = 'short';
    else if (inWindow.size < bars) reason = 'gap';
    if (reason) { dropped.push({ symbol, reason }); continue; }
    const rows = openTimes.map((t) => inWindow.get(t)!);
    series[symbol] = { close: rows.map((c) => c.close), volume: rows.map((c) => c.volume) };
  }
  return { interval, openTimes, series, dropped };
}
