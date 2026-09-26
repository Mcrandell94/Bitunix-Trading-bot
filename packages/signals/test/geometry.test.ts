import { describe, expect, test } from 'vitest';
import { crossedThrough, endsWith, momentumTroughInside, quadrantRuns, tailVelocity } from '../src/index';

const P = (x: number, y: number) => ({ x, y });

describe('tailVelocity', () => {
  test('mean step length over the last N steps', () => {
    const pts = [P(0, 0), P(100, 100), P(103, 104), P(106, 108)]; // last two steps are 5 long
    expect(tailVelocity(pts, 2)).toBe(5);
    expect(tailVelocity(pts, 10)).toBeCloseTo((Math.hypot(100, 100) + 10) / 3, 12); // uses what's there
    expect(tailVelocity([P(1, 1)], 3)).toBe(0);
  });
});

describe('quadrantRuns and crossedThrough', () => {
  test('run-length encodes the quadrants visited', () => {
    const pts = [P(99, 99), P(99, 99.5), P(99, 101), P(101, 101), P(101, 99)];
    expect(quadrantRuns(pts)).toEqual([
      { quadrant: 'lagging', bars: 2 },
      { quadrant: 'improving', bars: 1 },
      { quadrant: 'leading', bars: 1 },
      { quadrant: 'weakening', bars: 1 },
    ]);
    expect(quadrantRuns([])).toEqual([]);
  });

  test('a diagonal jump passes through whichever axis it crosses first', () => {
    // y reaches 100 a quarter of the way along, x halfway: via Improving.
    expect(crossedThrough(P(98, 99), P(102, 103))).toBe('improving');
    // x first: via Weakening.
    expect(crossedThrough(P(99, 98), P(103, 102))).toBe('weakening');
    // Leading → Lagging, y first: via Weakening.
    expect(crossedThrough(P(101, 100.5), P(99, 98))).toBe('weakening');
    // Not diagonal, or dead through the centre: nothing to insert.
    expect(crossedThrough(P(99, 99), P(99, 101))).toBeNull();
    expect(crossedThrough(P(99, 99), P(101, 101))).toBeNull();
    expect(quadrantRuns([P(98, 99), P(102, 103)])).toEqual([
      { quadrant: 'lagging', bars: 1 },
      { quadrant: 'improving', bars: 0 },
      { quadrant: 'leading', bars: 1 },
    ]);
  });
});

describe('momentumTroughInside', () => {
  test('true only when momentum fell into a low and rose out of it', () => {
    expect(momentumTroughInside([P(0, 3), P(0, 1), P(0, 2)])).toBe(true);
    expect(momentumTroughInside([P(0, 1), P(0, 2), P(0, 3)])).toBe(false); // rising all along
    expect(momentumTroughInside([P(0, 3), P(0, 2), P(0, 1)])).toBe(false); // still falling
    expect(momentumTroughInside([P(0, 1), P(0, 2)])).toBe(false);
  });
});

test('endsWith', () => {
  expect(endsWith(['a', 'b', 'c'], ['b', 'c'])).toBe(true);
  expect(endsWith(['a', 'b', 'c'], ['a', 'c'])).toBe(false);
  expect(endsWith(['c'], ['b', 'c'])).toBe(false);
  expect(endsWith([], [])).toBe(true);
});
