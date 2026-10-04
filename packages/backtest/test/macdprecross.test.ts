import { describe, expect, test } from 'vitest';
import { macdState } from '../src/screen/macdprecross';

describe('MACD pre-cross state', () => {
  test('against and closing = pre-cross; crossing = just crossed; long crossed = older; growing against = widening', () => {
    const closing = [null, -5, -4, -3, -2, -1];
    expect(macdState(closing, 5, 1)).toMatchObject({ state: 'pre-cross', shrinking: 4 });
    expect(macdState(closing, 5, -1)).toMatchObject({ state: 'with, older' }); // for a short, below the signal is the trade's way
    expect(macdState([-3, -2, -1, 0.5, 1, 1.5], 5, 1)).toMatchObject({ state: 'just crossed' });
    expect(macdState([1, 2, 3, 4, 5, 6], 5, 1)).toMatchObject({ state: 'with, older' });
    expect(macdState([-1, -2, -3, -4, -5, -6], 5, 1)).toMatchObject({ state: 'against, widening', shrinking: 0 });
    expect(macdState([-3, -2, -1, 0.5, 1, 1.5], 5, 1)).toMatchObject({ sinceCross: 3 });
    expect(macdState([1, 2, 3], 2, 1)).toBeNull(); // not enough history
  });
});

describe('MACD divergence', () => {
  test('lower price low with a higher MACD low is a bullish divergence; mirror for shorts', async () => {
    const { macdDivergence } = await import('../src/screen/macdstate');
    // Pivot lows at bars 10 (price 90) and 30 (price 85); MACD line -5 then -2: bullish divergence.
    const c = Array.from({ length: 40 }, (_, i) => {
      const low = i === 10 ? 90 : i === 30 ? 85 : 100;
      const high = i === 12 ? 120 : i === 28 ? 125 : 110;
      return { openTime: i, open: 105, high, low, close: 105, volume: 1 };
    });
    const line = c.map((_, i) => (i === 10 ? -5 : i === 30 ? -2 : i === 12 ? 6 : i === 28 ? 3 : 0));
    expect(macdDivergence(c, line, 35, 1)).toBe(true);
    expect(macdDivergence(c, line.map((x, i) => (i === 30 ? -8 : x)), 35, 1)).toBe(false); // MACD lower low too: no divergence
    expect(macdDivergence(c, line, 35, -1)).toBe(true); // higher price high (125 > 120), lower MACD high (3 < 6)
    expect(macdDivergence(c, line, 31, 1)).toBe(false); // the second pivot isn't known until 2 bars later
  });
});
