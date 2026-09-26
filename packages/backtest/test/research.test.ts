import { describe, expect, test } from 'vitest';
import { CANDIDATES, formatResearch, research } from '../src/research';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;

describe('win-rate research', { timeout: 300_000 }, () => {
  const data = syntheticMarket(90, 2);
  const r = research(data, START + 10 * DAY, START + 90 * DAY, 30);

  test('runs every candidate on train and test, next to the baseline', () => {
    expect(r.candidates.map((c) => c.label)).toEqual(CANDIDATES.map((c) => c.label));
    for (const c of r.candidates) {
      expect(c.train.trades).toBeGreaterThanOrEqual(0);
      // "holds" means better win rate AND no less total R, on both windows.
      if (c.holds) {
        expect(c.train.winRate).toBeGreaterThan(r.baseline.train.winRate);
        expect(c.test.totalR).toBeGreaterThanOrEqual(r.baseline.test.totalR);
      }
    }
    expect(formatResearch(r)).toContain('BASELINE');
  });
});
