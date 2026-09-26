import { describe, expect, test } from 'vitest';
import { FACTORS, SPEC_CHANGES, formatTune, tune } from '../src/tune';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;

describe('tune', () => {
  const data = syntheticMarket(90, 2);
  const t = tune(data, START + 10 * DAY, START + 90 * DAY, 25);

  test('tries every option of every factor on the train window, then compares on test', () => {
    expect(t.factors.map((f) => f.name)).toEqual(Object.keys(FACTORS));
    for (const f of t.factors) {
      expect(f.options.map((o) => o.label)).toEqual(FACTORS[f.name]!.map((o) => o.label));
      expect(f.options.map((o) => o.label)).toContain(f.chosen);
    }
    expect(t.windows.test[0]).toBe(START + 65 * DAY);
    for (const w of ['train', 'test', 'full'] as const) {
      expect(Number.isFinite(t.baseline[w].totalR)).toBe(true);
      expect(Number.isFinite(t.tuned[w].totalR)).toBe(true);
    }
  });

  test('keeps the default unless an option clears the bar; spec changes are only reported', () => {
    for (const f of t.factors) {
      const base = f.options[0]!.train;
      const chosen = f.options.find((o) => o.label === f.chosen)!.train;
      if (f.chosen !== f.options[0]!.label) {
        expect(chosen.trades).toBeGreaterThanOrEqual(25);
        expect(chosen.totalR - (base.trades >= 25 ? base.totalR : -Infinity)).toBeGreaterThanOrEqual(1);
      }
    }
    expect(t.specChanges.map((s) => s.label)).toEqual(SPEC_CHANGES.map((s) => s.label));
    const text = formatTune(t);
    expect(text).toContain('BEFORE vs AFTER');
    expect(text).toContain('NOT ADOPTED');
  });
});
