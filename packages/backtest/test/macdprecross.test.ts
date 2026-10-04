import { describe, expect, test } from 'vitest';
import { macdState } from '../src/screen/macdprecross';

describe('MACD pre-cross state', () => {
  test('against and closing = pre-cross; crossing = just crossed; long crossed = older; growing against = widening', () => {
    const closing = [null, -5, -4, -3, -2, -1];
    expect(macdState(closing, 5, 1)).toEqual({ state: 'pre-cross', shrinking: 4 });
    expect(macdState(closing, 5, -1)).toMatchObject({ state: 'with, older' }); // for a short, below the signal is the trade's way
    expect(macdState([-3, -2, -1, 0.5, 1, 1.5], 5, 1)).toMatchObject({ state: 'just crossed' });
    expect(macdState([1, 2, 3, 4, 5, 6], 5, 1)).toMatchObject({ state: 'with, older' });
    expect(macdState([-1, -2, -3, -4, -5, -6], 5, 1)).toEqual({ state: 'against, widening', shrinking: 0 });
    expect(macdState([1, 2, 3], 2, 1)).toBeNull(); // not enough history
  });
});
