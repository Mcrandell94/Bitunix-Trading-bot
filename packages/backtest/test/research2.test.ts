import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { tripleTopEvents } from '../src/screen/research2';

describe('RSI triple top', () => {
  test('RSI pivots 78 -> 74 -> 70.5 within the span is a triple top; price rule needs the third high near the first', () => {
    const c: Candle[] = Array.from({ length: 60 }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    const r: (number | null)[] = c.map(() => 50);
    r[10] = 78; r[20] = 74; r[30] = 70.5;
    c[10] = { ...c[10]!, high: 110 }; c[30] = { ...c[30]!, high: 111 };
    const e = tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, true);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ i: 33, a: 10 });
    c[30] = { ...c[30]!, high: 105 };
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, true)).toHaveLength(0);
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, false)).toHaveLength(1);
    r[30] = 73; // third too strong
    expect(tripleTopEvents(c, r, 76, 72, 76, 69.5, 71.5, false)).toHaveLength(0);
  });
});
