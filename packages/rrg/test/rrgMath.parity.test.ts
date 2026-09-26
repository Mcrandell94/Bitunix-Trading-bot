// Parity with the Crypto Rotation Dashboard's RRG math. src/rrgMath.js is a
// byte-for-byte copy of app/lib/rrgMath.js from
// github.com/Mcrandell94/Crypto-rotation-dashboard at commit 3434af8. These tests
//  1. replay every assertion in the dashboard's own app/lib/rrgMath.test.js,
//  2. pin numbers produced by running the dashboard's file on the same
//     inputs (per preset), so a drift in the copy fails loudly, and
//  3. pin the file's SHA-256, so it can only change on purpose.
// The copy stands on its own: nothing here reads from the dashboard repo.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ema, computeSeries, firstValidIndex, quadrantOf, countFlips, quadrantStreak, heading, RRG_PRESETS,
  type RrgPoint,
} from '../src/index';

const VENDORED_SHA256 = '8018fb70b898bbb886fe38826fd2becff6dc3a551b8def373f12d7c245e045db';

// The dashboard test's reference: the original in-component computeSeries,
// before smoothing existed. Kept verbatim (types added).
function legacyComputeSeries(asset: number[], bench: number[], n: number, m: number, zscore: boolean): RrgPoint[] {
  const sma = (arr: number[], i: number, w: number) => { const s = arr.slice(Math.max(0, i - w + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; };
  const stdev = (arr: number[], i: number, w: number) => {
    const s = arr.slice(Math.max(0, i - w + 1), i + 1);
    if (s.length < 2) return 0;
    const mm = s.reduce((a, b) => a + b, 0) / s.length;
    return Math.sqrt(s.reduce((a, b) => a + (b - mm) ** 2, 0) / (s.length - 1));
  };
  const ratio = asset.map((v, i) => v / bench[i]!);
  const rsRatio = zscore
    ? ratio.map((r, i) => { const sd = stdev(ratio, i, n); return sd > 0 ? 100 + (r - sma(ratio, i, n)) / sd : 100; })
    : ratio.map((r, i) => 100 * (r / sma(ratio, i, n)));
  const rsMom = zscore
    ? rsRatio.map((r, i) => { const sd = stdev(rsRatio, i, m); return sd > 0 ? 100 + (r - sma(rsRatio, i, m)) / sd : 100; })
    : rsRatio.map((r, i) => 100 * (r / sma(rsRatio, i, m)));
  return rsRatio.map((_, i) => ({ x: rsRatio[i]!, y: rsMom[i]! }));
}

// Same deterministic pseudo-random price paths as the dashboard test.
function path(seed: number, len: number, drift: number): number[] {
  let s = seed; let p = 100;
  return Array.from({ length: len }, () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    p *= 1 + drift + (s / 4294967296 - 0.5) * 0.08;
    return p;
  });
}

const bench = path(1, 100, 0.001);
const asset = path(7, 100, 0.003);

describe('vendored file', () => {
  test('rrgMath.js is still the unchanged copy of the dashboard file', () => {
    const src = readFileSync(new URL('../src/rrgMath.js', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(VENDORED_SHA256);
  });
});

describe('dashboard rrgMath.test.js, replayed', () => {
  test('smoothing off reproduces the original readings exactly (z-score and simple)', () => {
    for (const zscore of [true, false]) {
      const got = computeSeries(asset, bench, { trendWindow: 14, momentumWindow: 5, zscore, smoothing: 1 });
      const want = legacyComputeSeries(asset, bench, 14, 5, zscore);
      expect(got).toEqual(want);
    }
  });

  test('ema: span <= 1 is a no-op; otherwise it lags toward the new level', () => {
    expect(ema([1, 2, 3], 1)).toEqual([1, 2, 3]);
    expect(ema([0, 0, 10, 10, 10], 3)).toEqual([0, 0, 5, 7.5, 8.75]); // alpha = 0.5
  });

  test('smoothing changes readings but keeps the same length', () => {
    const s3 = computeSeries(asset, bench, { trendWindow: 14, momentumWindow: 5, smoothing: 3 });
    const s1 = computeSeries(asset, bench, { trendWindow: 14, momentumWindow: 5, smoothing: 1 });
    expect(s3).toHaveLength(100);
    expect(s3[99]).not.toEqual(s1[99]);
  });

  test('firstValidIndex covers both rolling windows plus EMA warm-up', () => {
    expect(firstValidIndex({ trendWindow: 14, momentumWindow: 5, smoothing: 1 })).toBe(17);
    expect(firstValidIndex({ trendWindow: 14, momentumWindow: 5, smoothing: 3 })).toBe(26);
  });

  test('quadrantOf splits at 100/100 with ties going to the stronger side', () => {
    expect(quadrantOf(101, 101)).toBe('leading');
    expect(quadrantOf(101, 99)).toBe('weakening');
    expect(quadrantOf(99, 99)).toBe('lagging');
    expect(quadrantOf(99, 101)).toBe('improving');
    expect(quadrantOf(100, 100)).toBe('leading');
  });

  test('countFlips and quadrantStreak', () => {
    const pts = [
      { x: 99, y: 101 }, // improving
      { x: 101, y: 101 }, // leading
      { x: 102, y: 101 }, // leading
      { x: 102, y: 102 }, // leading
    ];
    expect(countFlips(pts)).toBe(1);
    expect(quadrantStreak(pts)).toEqual({ days: 3, from: 'improving' });
    expect(quadrantStreak(pts.slice(1))).toEqual({ days: 3, from: null });
    expect(quadrantStreak([])).toEqual({ days: 0, from: null });
  });

  test('heading uses the net move over the lookback', () => {
    expect(heading([{ x: 100, y: 100 }, { x: 100, y: 101 }, { x: 100, y: 102 }], 2)?.arrow).toBe('↑');
    expect(heading([{ x: 100, y: 100 }, { x: 101, y: 101 }], 1)?.arrow).toBe('↗');
    expect(heading([{ x: 100, y: 100 }, { x: 99, y: 99 }], 1)?.arrow).toBe('↙');
    expect(heading([{ x: 1, y: 1 }])).toBeNull();
    expect(heading([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBeNull();
  });

  test('presets leave most of the 100-day history plottable', () => {
    expect(RRG_PRESETS.map((p) => p.key)).toEqual(['fast', 'balanced', 'steady']);
    for (const p of RRG_PRESETS) {
      expect(firstValidIndex(p.settings) + p.settings.tailLength).toBeLessThanOrEqual(50);
    }
  });
});

// Produced by running the dashboard's app/lib/rrgMath.js (commit 3434af8)
// on the bench/asset paths above, z-score on, each preset's settings.
const GOLDEN = {
  fast: {
    warm: 21,
    at60: { x: 100.14378498731749, y: 98.56678088711243 },
    last: { x: 99.76162400526415, y: 100.12140192832477 },
    quadrant: 'improving', streak: { days: 1, from: 'leading' }, flips: 1,
    head: { deg: 223.23729525345627, arrow: '↙', dx: -1.5188649277918955, dy: -1.428170755016751 },
  },
  balanced: {
    warm: 27,
    at60: { x: 100.79691048843739, y: 98.63247221524418 },
    last: { x: 100.03133660965507, y: 100.7874939557801 },
    quadrant: 'leading', streak: { days: 5, from: 'lagging' }, flips: 1,
    head: { deg: 236.9486646502599, arrow: '↙', dx: -0.36252337278897073, dy: -0.5571435530816871 },
  },
  steady: {
    warm: 37,
    at60: { x: 101.25882045971302, y: 99.58942358943757 },
    last: { x: 99.42251393554146, y: 100.85981242890803 },
    quadrant: 'improving', streak: { days: 5, from: 'lagging' }, flips: 1,
    head: { deg: 241.72370416338018, arrow: '↙', dx: -0.19728516825769304, dy: -0.36676174159559594 },
  },
} as const;

describe('golden values from the dashboard implementation', () => {
  const close = (a: RrgPoint | undefined, b: RrgPoint) => {
    expect(a!.x).toBeCloseTo(b.x, 10);
    expect(a!.y).toBeCloseTo(b.y, 10);
  };

  for (const p of RRG_PRESETS) {
    test(`${p.key} preset`, () => {
      const g = GOLDEN[p.key];
      const s = computeSeries(asset, bench, { zscore: true, ...p.settings });
      const warm = firstValidIndex(p.settings);
      const tail = s.slice(s.length - p.settings.tailLength);
      expect(warm).toBe(g.warm);
      close(s[60], g.at60);
      close(s[99], g.last);
      expect(quadrantOf(s[99]!.x, s[99]!.y)).toBe(g.quadrant);
      expect(quadrantStreak(s.slice(warm))).toEqual(g.streak);
      expect(countFlips(tail)).toBe(g.flips);
      const h = heading(tail, 3)!;
      expect(h.arrow).toBe(g.head.arrow);
      expect(h.deg).toBeCloseTo(g.head.deg, 8);
      expect(h.dx).toBeCloseTo(g.head.dx, 10);
      expect(h.dy).toBeCloseTo(g.head.dy, 10);
    });
  }

  test('simple (non z-score) mode', () => {
    const s = computeSeries(asset, bench, { trendWindow: 14, momentumWindow: 5, zscore: false });
    close(s[99], { x: 98.4812069825338, y: 98.6992160464707 });
  });
});
