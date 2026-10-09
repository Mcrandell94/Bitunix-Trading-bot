import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { specTrade } from '../src/screen/exits';
import { endingOf, peakR } from '../src/screen/peakr';

const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: 1 });
// A long from 100 with the stop at 90 (1R = 10): up to +12.5R, then back through the entry.
const c: Candle[] = [bar(0, 100, 105, 99, 104), bar(1, 104, 150, 103, 140), bar(2, 140, 225, 135, 200), bar(3, 200, 230, 95, 96)];
const atr = c.map(() => 1);

describe('peak R (20R-target models)', () => {
  test('a trade that reached +12.5R and fell back to the breakeven stop: peak 12.5R, ended at breakeven', () => {
    const t = specTrade(c, atr, {}, 0, 90, 1, { name: '20R', target: 20, be: 2 })!;
    expect(t.how).toBe('stop');
    expect(endingOf(t, 1)).toBe('breakeven');
    expect(t.r).toBeCloseTo(-0.022, 3); // the entry less fees
    expect(peakR(c, 0, t.end, 100, 10, 1, t.how)).toBe(12.5); // the stop bar's 230 is left out
  });

  test('the same entry with a 10R target closes at +10R on the bar that reached it', () => {
    const t = specTrade(c, atr, {}, 0, 90, 1, { name: '10R', target: 10, be: 2 })!;
    expect(endingOf(t, 1)).toBe('target');
    expect(t.r).toBeCloseTo(9.978, 3);
    expect(peakR(c, 0, t.end, 100, 10, 1, t.how)).toBe(12.5);
  });

  test('first stop, still open, and a short', () => {
    const down = [bar(0, 100, 101, 95, 96), bar(1, 96, 97, 85, 86)];
    const t = specTrade(down, atr, {}, 0, 90, 1, { name: '20R', target: 20, be: 2 })!;
    expect(endingOf(t, 1)).toBe('stop');
    expect(peakR(down, 0, t.end, 100, 10, 1, t.how)).toBeCloseTo(0.1, 6);
    const open = specTrade(c.slice(0, 3), atr, {}, 0, 90, 1, { name: '20R', target: 20, be: 2 })!;
    expect(endingOf(open, 1)).toBe('open');
    const s = specTrade(down, atr, {}, 0, 110, -1, { name: '20R', target: 20, be: 2 })!;
    expect(peakR(down, 0, s.end, 100, 10, -1, s.how)).toBe(1.5); // low 85 on a short from 100 with 1R = 10
  });
});
