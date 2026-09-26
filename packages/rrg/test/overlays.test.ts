// Overlay port. The first three tests replay the dashboard's own
// app/lib/rrgOverlays.test.js values for the helpers that were ported.

import { describe, expect, test } from 'vitest';
import {
  relativeVolume, absoluteTrend, fundingFlag, annualizeFundingRate, FUNDING_HOT,
} from '../src/index';

describe('dashboard rrgOverlays.test.js, replayed', () => {
  test('relativeVolume: recent vs longer average, null without enough data', () => {
    const flat = Array(30).fill(100);
    expect(relativeVolume(flat, 29)).toBe(1);
    const spike = [...Array(23).fill(100), ...Array(7).fill(300)];
    // recent 7 = 300; last 30 = (23*100 + 7*300) / 30
    expect(relativeVolume(spike, 29)!.toFixed(4)).toBe((300 / ((2300 + 2100) / 30)).toFixed(4));
    expect(relativeVolume(flat, 10)).toBeNull();
    expect(relativeVolume(null, 29)).toBeNull();
    expect(relativeVolume(Array(30).fill(null), 29)).toBeNull();
  });

  test('absoluteTrend: price vs its own 20-bar average', () => {
    const rising = Array.from({ length: 25 }, (_, i) => 100 + i);
    expect(absoluteTrend(rising, 24)!.above).toBe(true);
    const falling = Array.from({ length: 25 }, (_, i) => 100 - i);
    const t = absoluteTrend(falling, 24)!;
    expect(t.above).toBe(false);
    expect(t.pct).toBeLessThan(0);
    expect(absoluteTrend(rising, 5)).toBeNull();
  });

  test('fundingFlag thresholds', () => {
    expect(FUNDING_HOT).toBe(33);
    expect(fundingFlag(10.95)).toBe('neutral');
    expect(fundingFlag(40)).toBe('crowded-long');
    expect(fundingFlag(-5)).toBe('shorts-paying');
    expect(fundingFlag(undefined)).toBeNull();
  });
});

describe('bar-based windows', () => {
  test('relativeVolume and absoluteTrend take their windows in bars', () => {
    // 4 bars of 300 after 8 of 100: over the last 4 vs last 12 bars.
    const vols = [...Array(8).fill(100), ...Array(4).fill(300)];
    expect(relativeVolume(vols, 11, 4, 12)).toBeCloseTo(300 / ((800 + 1200) / 12), 12);
    expect(relativeVolume(vols, 10, 4, 12)).toBeNull(); // needs 12 bars
    const prices = [10, 10, 10, 13];
    expect(absoluteTrend(prices, 3, 4)).toEqual({ above: true, pct: (13 / 10.75 - 1) * 100 });
  });
});

describe('annualizeFundingRate', () => {
  test('0.01% per 8h is the 10.95%/yr neutral baseline', () => {
    expect(annualizeFundingRate(0.0001, 8)).toBeCloseTo(10.95, 10);
    expect(fundingFlag(annualizeFundingRate(0.0001, 8))).toBe('neutral');
    expect(fundingFlag(annualizeFundingRate(0.0004, 8))).toBe('crowded-long'); // 43.8%/yr
    expect(fundingFlag(annualizeFundingRate(-0.0001, 8))).toBe('shorts-paying');
    expect(annualizeFundingRate(0.0001, 4)).toBeCloseTo(21.9, 10);
  });

  test('bad inputs give null', () => {
    expect(annualizeFundingRate(Number.NaN, 8)).toBeNull();
    expect(annualizeFundingRate(0.0001, 0)).toBeNull();
  });
});

// The end-to-end check (a scan's RS readings are identical whatever the
// volume and funding inputs) is in packages/signals/test/watchlist.test.ts.
test('overlays do not mutate their inputs', () => {
  const vols = Object.freeze([...Array(30).keys()].map((i) => 100 + i));
  const prices = Object.freeze([...Array(30).keys()].map((i) => 50 + i));
  expect(() => relativeVolume(vols, 29)).not.toThrow();
  expect(() => absoluteTrend(prices, 29)).not.toThrow();
});
