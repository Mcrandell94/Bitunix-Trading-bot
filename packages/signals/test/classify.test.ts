import { describe, expect, test } from 'vitest';
import {
  classifyReading, readPoints, readRrg, resolveConfig,
  type Benchmark, type ClassifierConfig, type RrgReading, type SignalType,
} from '../src/index';
import { SCENARIOS, earlier, later, market, type Segment } from './fixtures';

const cfg = resolveConfig();

function readAll(segments: ReadonlyArray<Segment>, opts: { seed?: number; config?: ClassifierConfig } = {}) {
  const c = opts.config ?? cfg;
  const m = market({ segments }, { seed: opts.seed });
  const bench: Record<Benchmark, ReadonlyArray<number>> = { BTC: m.BTCUSDT.close, ETH: m.ETHUSDT.close };
  return (['BTC', 'ETH'] as const).map((b) => {
    const reading = readRrg(m.ASSETUSDT.close, bench[b], b, c)!;
    return { reading, classification: classifyReading(reading, c) };
  });
}

const signals = (segments: ReadonlyArray<Segment>, opts?: Parameters<typeof readAll>[1]) =>
  readAll(segments, opts).map((r) => r.classification?.signal ?? null);

describe('synthetic price series: each signal fires vs BTC and ETH', () => {
  test('LEADING_ENTRY: Improving→Leading with heading rising', () => {
    const [btc, eth] = readAll(SCENARIOS.leadingEntry);
    for (const { reading, classification } of [btc!, eth!]) {
      expect(classification).toMatchObject({ signal: 'LEADING_ENTRY', direction: 'long' });
      expect(reading.quadrant).toBe('leading');
      expect(reading.cameFrom).toBe('improving');
      expect(reading.barsInQuadrant).toBeLessThanOrEqual(cfg.freshBars);
      expect(reading.heading!.dy).toBeGreaterThan(0);
      expect(classification!.reasons[0]).toMatch(/Improving→Leading this bar, heading/);
    }
    // One bar earlier it hadn't crossed yet; 4 bars later the entry is stale.
    expect(signals(earlier(SCENARIOS.leadingEntry, 1))).not.toContain('LEADING_ENTRY');
    expect(signals(later(SCENARIOS.leadingEntry, 4))).toEqual([null, null]);
  });

  test('LAGGING_BREAKOUT: Lagging→Improving, steep NE, fast tail, RS-Momentum crossing 100', () => {
    for (const { reading, classification } of readAll(SCENARIOS.laggingBreakout)) {
      expect(classification).toMatchObject({ signal: 'LAGGING_BREAKOUT', direction: 'long' });
      expect(reading.quadrant).toBe('improving');
      expect(reading.cameFrom).toBe('lagging');
      const h = reading.heading!;
      expect(h.deg).toBeGreaterThanOrEqual(45);
      expect(h.deg).toBeLessThanOrEqual(90);
      expect(reading.tailVelocity).toBeGreaterThanOrEqual(cfg.breakoutMinVelocity);
      // RS-Momentum crossed 100 on this bar.
      expect(reading.tail.at(-2)!.y).toBeLessThan(100);
      expect(reading.tail.at(-1)!.y).toBeGreaterThanOrEqual(100);
      expect(classification!.reasons[0]).toContain('RS-Momentum crossed 100');
    }
  });

  test('LAGGING_BREAKOUT: a slow Lagging→Improving drift is not a breakout', () => {
    const slow = readAll(SCENARIOS.slowImprove);
    for (const { reading, classification } of slow) {
      expect(reading.quadrant).toBe('improving');
      expect(reading.cameFrom).toBe('lagging');
      expect(reading.tailVelocity).toBeLessThan(cfg.breakoutMinVelocity);
      expect(classification).toBeNull();
    }
    // It was only the velocity gate: loosen it and the same move qualifies.
    const loose = resolveConfig({ breakoutMinVelocity: 0.5 });
    expect(signals(SCENARIOS.slowImprove, { config: loose })).toEqual(['LAGGING_BREAKOUT', 'LAGGING_BREAKOUT']);
  });

  test('WEAKENING_HOOK: RS-Ratio >= 100, RS-Momentum < 100, heading turned up', () => {
    for (const { reading, classification } of readAll(SCENARIOS.weakeningHook)) {
      expect(classification).toMatchObject({ signal: 'WEAKENING_HOOK', direction: 'long' });
      expect(reading.point.x).toBeGreaterThanOrEqual(100);
      expect(reading.point.y).toBeLessThan(100);
      expect(reading.heading!.dy).toBeGreaterThan(0);
    }
    // At the bottom of the pullback it is still heading down: no hook yet.
    expect(signals(earlier(SCENARIOS.weakeningHook, 2))).toEqual([null, null]);
  });

  test('SHORT_ROLLOVER: Leading→Weakening→Lagging', () => {
    for (const { reading, classification } of readAll(SCENARIOS.rollover)) {
      expect(classification).toMatchObject({ signal: 'SHORT_ROLLOVER', direction: 'short' });
      expect(reading.path.slice(-3).map((r) => r.quadrant)).toEqual(['leading', 'weakening', 'lagging']);
      expect(classification!.reasons[0]).toContain('Leading→Weakening→Lagging');
    }
    // A bar earlier it was still in Weakening.
    expect(signals(earlier(SCENARIOS.rollover, 1))).not.toContain('SHORT_ROLLOVER');
  });

  test('SHORT_ROLLOVER: failed Improving→Lagging', () => {
    for (const { reading, classification } of readAll(SCENARIOS.failedImprove)) {
      expect(classification).toMatchObject({ signal: 'SHORT_ROLLOVER', direction: 'short' });
      expect(reading.path.slice(-2).map((r) => r.quadrant)).toEqual(['improving', 'lagging']);
      expect(classification!.reasons[0]).toContain('failed Improving→Lagging');
    }
  });
});

// The shapes, not one lucky noise path: every seed must fire within a few
// bars of the regime change (vs BTC).
describe('the same shapes across 30 noise seeds', () => {
  function firstSignal(segments: Segment[], fromBar: number, seed: number): SignalType[] {
    const m = market({ segments }, { seed });
    const out: SignalType[] = [];
    for (let end = fromBar; end <= m.BTCUSDT.close.length; end++) {
      const r = readRrg(m.ASSETUSDT.close.slice(0, end), m.BTCUSDT.close.slice(0, end), 'BTC', cfg);
      const c = r && classifyReading(r, cfg);
      if (c) out.push(c.signal);
    }
    return out;
  }
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  const cases: [string, Segment[], number, SignalType][] = [
    ['LEADING_ENTRY', [{ bars: 40, rel: -0.006 }, { bars: 6, rel: 0.012 }], 41, 'LEADING_ENTRY'],
    ['WEAKENING_HOOK', [{ bars: 40, rel: 0 }, { bars: 15, rel: 0.012 }, { bars: 3, rel: -0.006 }, { bars: 6, rel: 0.015 }], 59, 'WEAKENING_HOOK'],
    ['SHORT_ROLLOVER (rollover)', [{ bars: 40, rel: 0 }, { bars: 20, rel: 0.012 }, { bars: 6, rel: -0.012 }], 61, 'SHORT_ROLLOVER'],
    ['SHORT_ROLLOVER (failed)', [{ bars: 40, rel: 0 }, { bars: 15, rel: -0.012 }, { bars: 4, rel: 0.012 }, { bars: 6, rel: -0.015 }], 60, 'SHORT_ROLLOVER'],
  ];

  test.each(cases)('%s fires within 6 bars on every seed', (_, segments, fromBar, want) => {
    for (const seed of seeds) expect(firstSignal(segments, fromBar, seed), `seed ${seed}`).toContain(want);
  });

  test('a V-reversal from Lagging always turns long; it is a breakout when steep and fast enough', () => {
    const v: Segment[] = [{ bars: 45, rel: 0 }, { bars: 3, rel: -0.035 }, { bars: 6, rel: 0.045 }];
    let breakouts = 0;
    for (const seed of seeds) {
      const fired = firstSignal(v, 49, seed);
      expect(fired, `seed ${seed}`).toContain('LEADING_ENTRY');
      expect(fired.every((s) => s !== 'SHORT_ROLLOVER'), `seed ${seed}`).toBe(true);
      if (fired.includes('LAGGING_BREAKOUT')) breakouts++;
    }
    // The rest either jump straight into Leading in one bar or cross
    // Improving flatter than 45°.
    expect(breakouts).toBeGreaterThan(0);
  });
});

// Hand-built RRG points, one rule at a time.
describe('rules on hand-built RRG points', () => {
  const read = (pts: [number, number][], c: ClassifierConfig = cfg): RrgReading =>
    readPoints(pts.map(([x, y]) => ({ x, y })), 'BTC', c)!;
  const classify = (pts: [number, number][], c: ClassifierConfig = cfg) => classifyReading(read(pts, c), c)?.signal ?? null;

  test('needs a full tail of history', () => {
    expect(readPoints([{ x: 100, y: 100 }], 'BTC', cfg)).toBeNull();
    expect(readPoints(Array(cfg.tailLength + 1).fill({ x: 101, y: 101 }), 'BTC', cfg)).not.toBeNull();
  });

  const improvingToLeading: [number, number][] = [[98, 98], [98.5, 99], [99, 100.5], [99.3, 101.5], [99.6, 102.5], [99.8, 103], [100.5, 102.8]];

  test('LEADING_ENTRY needs momentum rising, and a fresh entry', () => {
    expect(classify([...improvingToLeading, [101, 103.5]])).toBe('LEADING_ENTRY');
    expect(classify([...improvingToLeading, [101, 102.4]])).toBeNull(); // dy < 0 over 3 bars
    const stale: [number, number][] = [...improvingToLeading, [101, 103.5], [101.5, 104], [102, 104.5], [102.5, 105]];
    expect(read(stale).barsInQuadrant).toBe(5);
    expect(classify(stale)).toBeNull();
  });

  test('LAGGING_BREAKOUT: each gate on its own', () => {
    const base: [number, number][] = [[97, 97], [97.5, 97.5], [97, 98], [97.5, 97], [97, 97.5], [97.5, 98.5], [98, 99.5]];
    expect(classify([...base, [98.8, 101]])).toBe('LAGGING_BREAKOUT');
    // Too slow.
    expect(classify([...base, [98.8, 101]], resolveConfig({ breakoutMinVelocity: 1.2 }))).toBeNull();
    // Heading NW (RS-Ratio still falling) is not NE.
    const anyPace = resolveConfig({ breakoutMinVelocity: 0 });
    expect(classify([...base, [96.5, 101]], anyPace)).toBeNull();
    // Shallower than 45° isn't steep.
    const flat: [number, number][] = [[95, 99], [95.5, 99.2], [96, 99.4], [96.5, 99.3], [97, 99.4], [97.8, 99.5], [98.6, 99.7], [99.4, 100.2]];
    expect(read(flat, anyPace).heading!.deg).toBeLessThan(45);
    expect(classify(flat, anyPace)).toBeNull();
    expect(classify(flat, resolveConfig({ breakoutMinVelocity: 0, breakoutMinHeadingDeg: 10 }))).toBe('LAGGING_BREAKOUT');
  });

  test('WEAKENING_HOOK needs a momentum trough inside the tail', () => {
    const hook: [number, number][] = [[102, 101], [102, 100.5], [101.8, 99.8], [101.5, 99], [101.3, 98.5], [101.2, 98.2], [101.2, 98.6], [101.3, 99.2]];
    expect(classify(hook)).toBe('WEAKENING_HOOK');
    // Momentum rising the whole tail (it came up from Lagging): no hook.
    const rising: [number, number][] = [[98, 95], [98.5, 95.5], [99, 96], [99.5, 96.5], [100.2, 97], [100.5, 97.5], [100.8, 98], [101, 98.5]];
    expect(read(rising).quadrant).toBe('weakening');
    expect(classify(rising)).toBeNull();
    // Still falling: no hook.
    expect(classify(hook.slice(0, 6).concat([[101.1, 97.9], [101, 97.5]]))).toBeNull();
  });

  test('SHORT_ROLLOVER: which paths into Lagging count', () => {
    const rolled: [number, number][] = [[101, 101], [101.5, 101.5], [101.8, 101], [101.6, 100.2], [101.2, 99.5], [100.6, 99], [100.1, 98.6], [99.5, 98.3]];
    expect(read(rolled).path.map((r) => r.quadrant)).toEqual(['leading', 'weakening', 'lagging']);
    expect(classify(rolled)).toBe('SHORT_ROLLOVER');
    const failed: [number, number][] = [[98, 98], [98.2, 98.8], [98.5, 99.6], [98.8, 100.4], [99, 101], [99.1, 100.8], [99.2, 100.2], [99, 99.5]];
    expect(classify(failed)).toBe('SHORT_ROLLOVER');
    // Lagging → Weakening → Lagging (RS-Ratio flickered over 100) isn't a rollover.
    const flicker: [number, number][] = [[98, 98], [98.8, 98.5], [99.5, 98.8], [100.2, 99], [100.4, 99.1], [100.1, 99], [99.6, 98.8], [99.2, 98.6]];
    expect(read(flicker).path.map((r) => r.quadrant)).toEqual(['lagging', 'weakening', 'lagging']);
    expect(classify(flicker)).toBeNull();
    // Stale: in Lagging longer than freshBars.
    expect(classify([...rolled, [99, 98], [98.5, 97.8], [98, 97.6]])).toBeNull();
  });

  test('a one-bar diagonal jump counts as passing through the quadrant between', () => {
    // Lagging straight to Leading, crossing y = 100 first: via Improving.
    const jump: [number, number][] = [[98, 97], [98.2, 97.5], [98.4, 98], [98.6, 98.5], [98.8, 99], [99, 99.3], [99.4, 99.6], [100.3, 101.5]];
    const r = read(jump);
    expect(r.quadrant).toBe('leading');
    expect(r.path.map((p) => [p.quadrant, p.bars])).toEqual([['lagging', 7], ['improving', 0], ['leading', 1]]);
    expect(r.cameFrom).toBe('improving');
    expect(classify(jump)).toBe('LEADING_ENTRY');
    // Leading straight to Lagging, crossing y = 100 first: via Weakening.
    const drop: [number, number][] = [[101, 102], [101.2, 101.8], [101.3, 101.5], [101.2, 101.2], [101, 101], [100.8, 100.8], [100.6, 100.6], [99.8, 98.5]];
    expect(read(drop).path.map((p) => p.quadrant)).toEqual(['leading', 'weakening', 'lagging']);
    expect(classify(drop)).toBe('SHORT_ROLLOVER');
  });
});
