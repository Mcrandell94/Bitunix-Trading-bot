import { describe, expect, test } from 'vitest';
import { robustLines } from '../src/screen/liverobust';

const Y = (y: number) => Date.UTC(y, 5, 1);
describe('robustness lines', () => {
  test('years, BTC split and coin concentration', () => {
    const ts = [
      { sym: 'A', t: Y(2023), r: 3, model: 'bottom-div' as const, btcUp: true },
      { sym: 'B', t: Y(2023), r: -1, model: 'bottom-div' as const, btcUp: false },
      { sym: 'C', t: Y(2024), r: -1, model: 'bottom-div' as const, btcUp: false },
      { sym: 'D', t: Y(2024), r: 1, model: 'bottom-div' as const, btcUp: true },
    ];
    const l = robustLines('X', ts).join('\n');
    expect(l).toContain('4 trades, avg +0.50 R, total +2.0 R; positive years 1 of 2; best year 2023 = 100% of total');
    expect(l).toContain('BTC above its 200-day: +2.00 (2) | below: -1.00 (2)');
    expect(l).toContain('without the 3 best coins: -1.00 (1)');
  });
});
