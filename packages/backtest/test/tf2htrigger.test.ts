import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { fires, LINES, oppStop, triggerEntry, type Line, type TSetup } from '../src/screen/tf2htrigger';

const H2 = 2 * 3_600_000;
const bar = (k: number, px: number, lo = px - 1, hi = px + 1): Candle => ({ openTime: k * H2, open: px, high: hi, low: lo, close: px, volume: 1 });
const none: (number | null)[] = [];

describe('2h trigger', () => {
  test('grid: 5 RSI x 3 gap x 2 4H = 30 lines, one of them "enter at once"', () => {
    expect(LINES).toHaveLength(30);
    expect(LINES.filter((l) => l.rsi === 'none' && !l.gap && !l.f4)).toHaveLength(1);
  });

  test('RSI cross: longs cross back over the level, shorts under 100 - level', () => {
    const l: Line = { rsi: 30, gap: 0, f4: false };
    expect(fires(l, 1, 2, [20, 28, 33], none, none, true)).toBe(true);
    expect(fires(l, 1, 2, [20, 33, 35], none, none, true)).toBe(false); // already over
    expect(fires(l, -1, 2, [80, 72, 66], none, none, true)).toBe(true);
    expect(fires(l, -1, 2, [80, 66, 60], none, none, true)).toBe(false);
  });

  test('turn, MACD gap in the trade\'s favour and the 4H filter', () => {
    expect(fires({ rsi: 'turn', gap: 0, f4: false }, 1, 2, [40, 35, 38], none, none, true)).toBe(true);
    expect(fires({ rsi: 'turn', gap: 0, f4: false }, 1, 2, [30, 35, 38], none, none, true)).toBe(false); // no bar against first
    const g: Line = { rsi: 'none', gap: 0.1, f4: false };
    expect(fires(g, 1, 0, [50], [1], [0.85], true)).toBe(true); // (1 - 0.85) / 1 = 15%
    expect(fires(g, 1, 0, [50], [1], [0.95], true)).toBe(false); // 5%
    expect(fires(g, -1, 0, [50], [-1], [-0.85], true)).toBe(true);
    expect(fires({ rsi: 'none', gap: 0, f4: true }, 1, 0, [50], none, none, false)).toBe(false);
  });

  test('enter at once = the first 2h open at the live entry time; the trigger enters the open after its close; stop first = missed', () => {
    const c = Array.from({ length: 12 }, (_, k) => bar(k, 100));
    const s: TSetup = { model: '4h-fail-long', sym: 'X', d: 1, start: 4 * H2, stop: 95, spec: { name: 'x', target: 3 }, wait: 6 * H2 };
    const r = c.map((_, k) => (k === 6 ? 28 : k === 7 ? 33 : 50));
    expect(triggerEntry(s, LINES[0]!, c, r, none, none, () => true)).toBe(4);
    expect(triggerEntry(s, { rsi: 30, gap: 0, f4: false }, c, r, none, none, () => true)).toBe(8); // fires on bar 7's close
    const c2 = c.map((b, k) => (k === 5 ? bar(k, 100, 94) : b));
    expect(triggerEntry(s, { rsi: 30, gap: 0, f4: false }, c2, r, none, none, () => true)).toBeNull();
    expect(triggerEntry({ ...s, wait: 3 * H2 }, { rsi: 30, gap: 0, f4: false }, c, r, none, none, () => true)).toBeNull(); // wait ran out
  });

  test('the random twin\'s stop sits the same distance on the other side, for longs and shorts', () => {
    expect(oppStop(100, 95)).toBe(105);
    expect(oppStop(100, 104)).toBe(96);
  });
});
