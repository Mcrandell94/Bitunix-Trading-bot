import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { momentumDownEvents, rsiCeilingEvents } from '../src/screen/newmodels';

describe('new short models', () => {
  test('ceiling: RSI back within 5 of its running max after the warm-up; a new max is over-ceiling', () => {
    const r: (number | null)[] = Array.from({ length: 300 }, (_, i) => (i === 100 ? 80 : 50));
    r[270] = 77; r[290] = 85;
    const e = rsiCeilingEvents(r);
    expect(e.map((x) => [x.i, x.kind])).toEqual([[270, 'ceiling'], [290, 'over-ceiling']]);
  });
  test('momentum breakdown: first daily RSI close under 25 while the last completed weekly RSI is over 38', () => {
    const DAY = 86_400_000, start = Date.UTC(2024, 0, 1); // a Monday
    const c: Candle[] = Array.from({ length: 200 }, (_, i) => ({ openTime: start + i * DAY, open: 100, high: 101, low: 99, close: 100 + Math.sin(i / 3) * 5, volume: 1 }));
    const r: (number | null)[] = c.map(() => 40);
    r[150] = 20;
    const e = momentumDownEvents(c, r);
    expect(e.map((x) => x.i)).toEqual([150]);
    expect(momentumDownEvents(c, r, 25, 99)).toHaveLength(0); // weekly filter blocks it
  });
});
