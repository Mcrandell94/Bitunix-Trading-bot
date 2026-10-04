import { describe, expect, test } from 'vitest';
import { macdHistogram } from '../src/indicators';
import { macdGap, macdLines } from '../src/screen/macdgap';

describe('MACD gap', () => {
  test('lines match the histogram helper; gap is signed the trade\'s way', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 9) + i * 0.05);
    const { line, sig } = macdLines(closes), h = macdHistogram(closes);
    for (const i of [60, 120, 199]) expect(line[i]! - sig[i]!).toBeCloseTo(h[i]!, 9);
    expect(macdGap(2, 1.8, 1)).toBeCloseTo(0.1, 9);   // MACD 10% above its signal: with a long
    expect(macdGap(2, 1.8, -1)).toBeCloseTo(-0.1, 9); // against a short
    expect(macdGap(-2, -1.7, -1)).toBeCloseTo(0.15, 9); // MACD below its signal: with a short
    expect(macdGap(0, 1, 1)).toBeNull();
    expect(macdGap(null, 1, 1)).toBeNull();
  });
});
