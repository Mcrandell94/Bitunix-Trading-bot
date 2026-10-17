import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taEma } from '../src/screen/pine';
import { usdtSig } from '../src/screen/usdtsig';

const H4 = 4 * 3_600_000, DAY = 86_400_000;
const bar = (t: number, h: number, l: number, c: number, coins = 10): Candle => ({ openTime: t, open: c, high: h, low: l, close: c, volume: coins * (h + l + c) / 3 });

describe('USDT/USDC Signal v2.0: VWAP, blue line, EMA 80', () => {
  test('the VWAP restarts each UTC day (4H bars add up within the day)', () => {
    const t0 = Date.UTC(2024, 0, 1), c = [bar(t0, 101, 99, 100), bar(t0 + H4, 104, 102, 103, 20), bar(t0 + DAY, 91, 89, 90)];
    const s = usdtSig(c);
    expect(s.vwap[0]).toBeCloseTo(100, 12);
    expect(s.vwap[1]).toBeCloseTo((100 * 10 + 103 * 20) / 30, 9);
    expect(s.vwap[2]).toBeCloseTo(90, 12); // a new day
  });

  test('daily bars: the biggest excursion from VWAP over 40 bars sets both lines; EMA 80 as Pine', () => {
    const t0 = Date.UTC(2024, 0, 1);
    const c = Array.from({ length: 120 }, (_, i) => (i === 100 ? bar(t0 + i * DAY, 110, 99, 100) : bar(t0 + i * DAY, 101, 99, 100)));
    const s = usdtSig(c), d = 110 / 103; // bar 100: hlc3 103 is its own VWAP (each daily bar is a session)
    expect(s.upper[119]).toBeCloseTo(100 * d, 9);
    expect(s.lower[119]).toBeCloseTo(100 * (2 - d), 9);
    expect(s.upper[60]).toBeCloseTo(s.vwap[60]!, 12); // equal deviations up and down: neither case, the lines sit on the VWAP
    expect(s.ema80).toEqual(taEma(c.map((b) => b.close), 80));
    expect(usdtSig(c.slice(0, 111))).toEqual({ vwap: s.vwap.slice(0, 111), upper: s.upper.slice(0, 111), lower: s.lower.slice(0, 111), ema80: s.ema80.slice(0, 111) });
  });
});
