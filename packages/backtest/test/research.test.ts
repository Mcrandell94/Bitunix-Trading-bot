import { describe, expect, test } from 'vitest';
import { CANDIDATES, HTF_CANDIDATES, LTF_CANDIDATES, formatResearch, research } from '../src/research';
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

  test('LTF mode: MTF off, LTF candidates, judged on total R', () => {
    const l = research(data, START + 10 * DAY, START + 90 * DAY, 30, () => {}, 'ltf');
    expect(l.mode).toBe('ltf');
    expect(l.candidates.map((c) => c.label)).toEqual(LTF_CANDIDATES.map((c) => c.label));
    for (const c of l.candidates.filter((x) => x.holds)) {
      expect(c.train.totalR - l.baseline.train.totalR).toBeGreaterThanOrEqual(1);
      expect(c.test.totalR - l.baseline.test.totalR).toBeGreaterThanOrEqual(1);
    }
    expect(formatResearch(l)).toContain('LTF ON ITS OWN');
  });

  test('HTF mode: only HTF on, HTF candidates, judged on total R', () => {
    const h = research(data, START + 10 * DAY, START + 90 * DAY, 30, () => {}, 'htf');
    expect(h.mode).toBe('htf');
    expect(h.candidates.map((c) => c.label)).toEqual(HTF_CANDIDATES.map((c) => c.label));
    expect(h.attribution.tier!.every((b) => b.key === 'HTF')).toBe(true);
    for (const c of h.candidates.filter((x) => x.holds)) {
      expect(c.train.totalR - h.baseline.train.totalR).toBeGreaterThanOrEqual(1);
      expect(c.test.totalR - h.baseline.test.totalR).toBeGreaterThanOrEqual(1);
    }
    expect(formatResearch(h)).toContain('HTF ON ITS OWN');
  });
});
