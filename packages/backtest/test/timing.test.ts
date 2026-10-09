import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { LIVE_VARIANT } from '../src/screen/rsisignals';
import { pick, randomDirectionTwins, randomTimeTwins, timingEdge } from '../src/screen/timing';

const DAY = 86_400_000;
// Falls 2 a bar for 50 bars (200 -> 100), then rises 2 a bar.
const vee: Candle[] = Array.from({ length: 130 }, (_, i) => {
  const o = i < 50 ? 200 - 2 * i : 100 + 2 * (i - 50), c = i < 50 ? o - 2 : o + 2;
  return { openTime: i * DAY, open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c, volume: 1 };
});
const none = vee.map(() => null);

describe('timing baselines', () => {
  test('random-time twins enter only after the entry, within the span, same side and stop %', () => {
    // Long at the bottom (bar 50, open 100), stop 95 (5%), 2R target: every twin enters on the way up and wins 2R less costs.
    const twins = randomTimeTwins(vee, none, 'X', 50, 95, 1, { name: '2R', target: 2 }, 30, 20);
    expect(twins).toHaveLength(20);
    for (const r of twins) expect(r).toBeCloseTo(2 - 0.0022 / 0.05, 6);
    // On the way down a long would lose: the same call from bar 10 (span inside the fall) gives only stops.
    for (const r of randomTimeTwins(vee, none, 'X', 10, 180 * 0.95, 1, { name: '2R', target: 2 }, 20, 10)) expect(r).toBeLessThan(0);
    // No room after the entry: no twins.
    expect(randomTimeTwins(vee, none, 'X', vee.length - 2, 100, 1, { name: '2R', target: 2 }, 30, 10)).toHaveLength(0);
  });

  test('random-direction twins: the same entry and distance, both sides over the seeds', () => {
    const twins = randomDirectionTwins(vee, none, 'X', 50, 95, 1, { name: '2R', target: 2 }, 20);
    expect(twins).toHaveLength(20);
    expect(twins.some((r) => r > 0) && twins.some((r) => r < 0)).toBe(true);
  });

  test('pick: deterministic and in range', () => {
    for (const n of [1, 7, 1000]) for (let k = 1; k <= 50; k++) {
      const x = pick(k, 'ETHUSDT', 123, n);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(n);
      expect(pick(k, 'ETHUSDT', 123, n)).toBe(x);
    }
  });

  test('timingEdge: mean of R minus own twins, with t; trades without twins left out', () => {
    const e = timingEdge([{ r: 1, rtime: [0] }, { r: 3, rtime: [1, 1] }, { r: 0, rtime: [] }, { r: -1, rtime: [-2] }]);
    expect(e.n).toBe(3);
    expect(e.mean).toBeCloseTo(4 / 3, 9);
    expect(e.t).toBeCloseTo(4, 9);
  });

  test('live exit versions: bottom divergence A, triple divergence B, the rest A', () => {
    expect(LIVE_VARIANT['bottom-div'] ?? 0).toBe(0);
    expect(LIVE_VARIANT['triple-div'] ?? 0).toBe(1);
    for (const m of ['under-floor', 'w-bear-div', 'w-top-div', 'w-dbl-bottom', 'd-fail-short', '4h-fail-short', '15m-rsi10'] as const) expect(LIVE_VARIANT[m] ?? 0).toBe(0);
  });
});
