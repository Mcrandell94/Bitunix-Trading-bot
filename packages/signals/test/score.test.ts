import { describe, expect, test } from 'vitest';
import {
  AGREEMENT, absoluteTrendScore, agreementScore, fundingScore, relativeVolumeScore, resolveConfig,
  timeInQuadrantScore, velocityScore, weightedScore,
  type Classification, type RrgReading,
} from '../src/index';

const cfg = resolveConfig();

function reading(over: Partial<RrgReading>): RrgReading {
  return {
    benchmark: 'ETH', point: { x: 101, y: 101 }, quadrant: 'leading', barsInQuadrant: 1, cameFrom: 'improving',
    heading: null, tailVelocity: 0.5, path: [], tail: [], ...over,
  };
}
const cls = (signal: Classification['signal'], direction: Classification['direction']): Classification => ({ signal, direction, reasons: [] });

describe('agreementScore (the benchmark the signal did not fire on)', () => {
  test('graded from both-fired down to opposed', () => {
    expect(agreementScore('LEADING_ENTRY', 'long', [])).toBe(AGREEMENT.both);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: reading({}), classification: cls('LEADING_ENTRY', 'long') }])).toBe(AGREEMENT.both);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: reading({}), classification: cls('WEAKENING_HOOK', 'long') }])).toBe(AGREEMENT.sameDirection);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: reading({ quadrant: 'improving' }), classification: null }])).toBe(AGREEMENT.supportiveQuadrant);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: null, classification: null }])).toBe(AGREEMENT.unavailable);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: reading({ quadrant: 'lagging' }), classification: null }])).toBe(AGREEMENT.opposed);
    expect(agreementScore('LEADING_ENTRY', 'long', [{ reading: reading({}), classification: cls('SHORT_ROLLOVER', 'short') }])).toBe(AGREEMENT.opposed);
  });

  test('supportive quadrants flip for shorts', () => {
    expect(agreementScore('SHORT_ROLLOVER', 'short', [{ reading: reading({ quadrant: 'weakening' }), classification: null }])).toBe(AGREEMENT.supportiveQuadrant);
    expect(agreementScore('SHORT_ROLLOVER', 'short', [{ reading: reading({ quadrant: 'leading' }), classification: null }])).toBe(AGREEMENT.opposed);
  });

  test('an opposite signal is opposition even from a "supportive" quadrant', () => {
    // WEAKENING_HOOK is a long that lives in Weakening.
    const hook = { reading: reading({ quadrant: 'weakening' }), classification: cls('WEAKENING_HOOK', 'long') };
    expect(agreementScore('SHORT_ROLLOVER', 'short', [hook])).toBe(AGREEMENT.opposed);
  });

  test('with several other benchmarks, the weakest decides', () => {
    const support = { reading: reading({ quadrant: 'improving' }), classification: null };
    const oppose = { reading: reading({ quadrant: 'lagging' }), classification: null };
    expect(agreementScore('LEADING_ENTRY', 'long', [support, oppose])).toBe(AGREEMENT.opposed);
  });
});

describe('component scores', () => {
  test('velocity: mean of the fired readings, capped at velocityRef', () => {
    expect(velocityScore([reading({ tailVelocity: 0.55 })], cfg)).toBeCloseTo(0.5, 12);
    expect(velocityScore([reading({ tailVelocity: 0.44 }), reading({ tailVelocity: 0.66 })], cfg)).toBeCloseTo(0.5, 12);
    expect(velocityScore([reading({ tailVelocity: 5 })], cfg)).toBe(1);
  });

  test('time in quadrant: 1 on the first bar, fading to 0', () => {
    expect(timeInQuadrantScore([reading({ barsInQuadrant: 1 })], cfg)).toBe(1);
    expect(timeInQuadrantScore([reading({ barsInQuadrant: 1 + cfg.timeDecayBars })], cfg)).toBe(0);
    // The staler of two fired readings counts.
    expect(timeInQuadrantScore([reading({ barsInQuadrant: 1 }), reading({ barsInQuadrant: 3 })], cfg))
      .toBeCloseTo(1 - 2 / cfg.timeDecayBars, 12);
  });

  test('relative volume: linear between relVolLow and relVolHigh; unknown is neutral', () => {
    expect(relativeVolumeScore(0.5, cfg)).toBe(0);
    expect(relativeVolumeScore(1.15, cfg)).toBeCloseTo(0.5, 12);
    expect(relativeVolumeScore(3, cfg)).toBe(1);
    expect(relativeVolumeScore(null, cfg)).toBe(0.5);
  });

  test('absolute trend must agree with the direction', () => {
    expect(absoluteTrendScore({ above: true, pct: 3 }, 'long')).toBe(1);
    expect(absoluteTrendScore({ above: false, pct: -3 }, 'long')).toBe(0);
    expect(absoluteTrendScore({ above: false, pct: -3 }, 'short')).toBe(1);
    expect(absoluteTrendScore(null, 'short')).toBe(0.5);
  });

  test('funding: crowded on your side is bad, the other side paying is good', () => {
    expect(fundingScore('crowded-long', 'long')).toBe(0);
    expect(fundingScore('shorts-paying', 'long')).toBe(1);
    expect(fundingScore('crowded-long', 'short')).toBe(1);
    expect(fundingScore('shorts-paying', 'short')).toBe(0);
    expect(fundingScore('neutral', 'long')).toBe(0.7);
    expect(fundingScore(null, 'long')).toBe(0.5);
  });

  test('weightedScore is a 0-100 weighted mean', () => {
    const all = (v: number) => ({ agreement: v, velocity: v, timeInQuadrant: v, relativeVolume: v, absoluteTrend: v, funding: v });
    expect(weightedScore(all(1), cfg.weights)).toBeCloseTo(100, 12);
    expect(weightedScore(all(0), cfg.weights)).toBe(0);
    expect(weightedScore({ ...all(0), agreement: 1 }, cfg.weights)).toBeCloseTo(100 * cfg.weights.agreement, 12);
  });
});
