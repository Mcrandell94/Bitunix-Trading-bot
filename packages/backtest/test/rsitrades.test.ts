import { describe, expect, test } from 'vitest';
import { momentumEvents, simulateSignal } from '../src/screen/rsitrades';

const bar = (o: number, h: number, l: number, cl: number, i: number) => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 1 });

describe('signal trades', () => {
  // 10 flat bars (low 98), signal at bar 9, entry at the open of bar 10 (100); ATR 2 -> stop 98 - 1 = 97, risk 3.
  const base = Array.from({ length: 10 }, (_, i) => bar(100, 101, 98, 100, i));
  const atr = Array.from({ length: 30 }, () => 2);

  test('long stop: a low through the stop exits at the stop, costs charged in R', () => {
    const c = [...base, bar(100, 101, 99, 100, 10), bar(100, 100, 96, 97, 11), bar(97, 98, 96, 97, 12)];
    const res = simulateSignal(c, atr, 9, 1, 3, 'hold')!;
    expect(res.r).toBeCloseTo(-1 - (0.0022 * 100) / 3, 6);
    expect(res.bars).toBe(2);
  });

  test('3R target and time cap', () => {
    const c = [...base, bar(100, 104, 99, 103, 10), bar(103, 110, 102, 109, 11), bar(109, 110, 108, 109, 12)];
    expect(simulateSignal(c, atr, 9, 1, 3, '3R')!.r).toBeCloseTo(3 - (0.0022 * 100) / 3, 6);
    expect(simulateSignal(c, atr, 9, 1, 3, 'hold')!.r).toBeCloseTo(3 - (0.0022 * 100) / 3, 6); // closes 109 at the cap
  });

  test('short mirror and gap through the stop fills at the open', () => {
    const hi = Array.from({ length: 10 }, (_, i) => bar(100, 102, 99, 100, i)); // stop 102 + 1 = 103, risk 3
    const c = [...hi, bar(100, 101, 99, 100, 10), bar(106, 107, 105, 106, 11), bar(106, 107, 105, 106, 12)];
    expect(simulateSignal(c, atr, 9, -1, 3, 'hold')!.r).toBeCloseTo(-2 - (0.0022 * 100) / 3, 6);
  });

  test('no trade when the data ends before the time cap', () => {
    expect(simulateSignal([...base, bar(100, 101, 99, 100, 10)], atr, 9, 1, 3, 'hold')).toBeNull();
  });

  test('momentum long: first daily RSI close over 75, only while the last completed week is under 62', () => {
    const DAY = 86_400_000, monday = Date.UTC(2024, 0, 1);
    const mk = (px: (i: number) => number) => Array.from({ length: 140 }, (_, i) => bar(px(i), px(i) + 1, px(i) - 1, px(i), monday + i * DAY));
    const r: (number | null)[] = Array.from({ length: 140 }, () => 50);
    r[120] = 80; r[121] = 81; // crosses 75 at 120 only
    const chop = mk((i) => 100 + 5 * Math.sin(i / 3)); // weekly RSI near 50
    expect(momentumEvents(chop, r).map((e) => e.i)).toEqual([120]);
    const trend = mk((i) => 100 + i); // weekly RSI near 100: blocked
    expect(momentumEvents(trend, r)).toEqual([]);
  });
});
