import { describe, expect, test } from 'vitest';
import { alignSeries, closedOnly, intervalMs, lastClosedOpenTime, nextCloseTime, type Candle } from '../src/index';

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 26, 16, 30); // 16:30 UTC

const bar = (openTime: number, close = 100, volume: number | null = 10): Candle => ({ openTime, open: close, high: close, low: close, close, volume });
const hours = (fromHour: number, n: number, dayStart = Date.UTC(2026, 8, 26)) => Array.from({ length: n }, (_, i) => bar(dayStart + (fromHour + i) * H, 100 + i));

describe('bar clock', () => {
  test('last closed bar and next close, per interval, on UTC boundaries', () => {
    expect(lastClosedOpenTime('1h', NOW)).toBe(Date.UTC(2026, 8, 26, 15));
    expect(lastClosedOpenTime('4h', NOW)).toBe(Date.UTC(2026, 8, 26, 12));
    expect(lastClosedOpenTime('1d', NOW)).toBe(Date.UTC(2026, 8, 25));
    expect(nextCloseTime('4h', NOW)).toBe(Date.UTC(2026, 8, 26, 20));
    // Exactly on a close, that bar has just closed.
    expect(lastClosedOpenTime('1h', Date.UTC(2026, 8, 26, 16))).toBe(Date.UTC(2026, 8, 26, 15));
    expect(intervalMs('15m')).toBe(15 * 60_000);
  });

  test('closedOnly drops the bar still open', () => {
    const bars = hours(14, 3); // 14:00, 15:00, 16:00 (open at 16:30)
    expect(closedOnly(bars, '1h', NOW).map((b) => new Date(b.openTime).getUTCHours())).toEqual([14, 15]);
  });
});

describe('alignSeries', () => {
  test('cuts every symbol to the same closed window', () => {
    const a = alignSeries({ BTCUSDT: hours(0, 17), XRPUSDT: hours(5, 12) }, '1h', 10, NOW);
    expect(a.openTimes).toHaveLength(10);
    expect(a.openTimes.at(-1)).toBe(Date.UTC(2026, 8, 26, 15));
    expect(a.series.BTCUSDT!.close).toEqual(hours(0, 17).slice(6, 16).map((b) => b.close));
    expect(a.series.XRPUSDT!.close).toHaveLength(10);
    expect(a.dropped).toEqual([]);
  });

  test('drops stale, short, gappy and off-grid symbols instead of filling them', () => {
    const gappy = hours(0, 16).filter((_, i) => i !== 10);
    const offGrid = hours(0, 16).map((b) => ({ ...b, openTime: b.openTime + 60_000 }));
    const a = alignSeries({
      BTCUSDT: hours(0, 16),
      STALEUSDT: hours(0, 15), // missing the 15:00 bar
      NEWUSDT: hours(10, 6), // listed after the window starts
      GAPUSDT: gappy,
      ODDUSDT: offGrid,
    }, '1h', 10, NOW);
    expect(Object.keys(a.series)).toEqual(['BTCUSDT']);
    expect(a.dropped).toEqual([
      { symbol: 'STALEUSDT', reason: 'stale' },
      { symbol: 'NEWUSDT', reason: 'short' },
      { symbol: 'GAPUSDT', reason: 'gap' },
      { symbol: 'ODDUSDT', reason: 'misaligned' },
    ]);
  });

  test('the still-open bar never enters the window; volumes keep their nulls', () => {
    const withOpen = [...hours(0, 16), bar(Date.UTC(2026, 8, 26, 16), 999)];
    withOpen[15] = bar(Date.UTC(2026, 8, 26, 15), 115, null);
    const a = alignSeries({ BTCUSDT: withOpen }, '1h', 5, NOW);
    expect(a.series.BTCUSDT!.close.at(-1)).toBe(115);
    expect(a.series.BTCUSDT!.volume.at(-1)).toBeNull();
  });

  test('bars must be a whole number', () => {
    expect(() => alignSeries({}, '1h', 0, NOW)).toThrow(RangeError);
  });
});
