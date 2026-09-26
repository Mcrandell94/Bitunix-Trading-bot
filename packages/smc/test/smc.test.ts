import { describe, expect, test } from 'vitest';
import { analyze, barAt, biasAt, buildContext, combineBias, detectSetup, mirror, smt } from '../src/index';
import { H, LONG_ROWS, T0, bars } from './bars';

type Row = readonly [number, number, number, number];
const withRow = (rows: ReadonlyArray<Row>, i: number, row: Row) => rows.map((r, j) => (j === i ? row : r));
const setupsIn = (rows: ReadonlyArray<Row>) => {
  const a = analyze(bars(rows));
  return rows.map((_, t) => detectSetup(a, t)).filter((s) => s != null);
};

describe('detectSetup: sweep → MSS with displacement → FVG', () => {
  test('the textbook long, reported once, the bar after the MSS', () => {
    const found = setupsIn(LONG_ROWS);
    expect(found).toHaveLength(1);
    const s = found[0]!;
    expect(s).toMatchObject({
      side: 'long', index: 25, mssIndex: 24, sweepIndex: 22, sweptLevel: 96, mssLevel: 101,
      displacementIndex: 24, zone: { kind: 'fvg', top: 102, bottom: 99 }, entry: 100.5,
    });
    // Stop: the sweep wick (95) less 0.1 ATR.
    const atr = analyze(bars(LONG_ROWS)).long.atr[25]!;
    expect(s.stop).toBeCloseTo(95 - 0.1 * atr, 10);
  });

  test('the mirrored series gives the mirrored short', () => {
    const flip = (p: number) => 200 - p;
    const rows = LONG_ROWS.map(([o, h, l, c]) => [flip(o), flip(l), flip(h), flip(c)] as const);
    const [s] = setupsIn(rows);
    const [l] = setupsIn(LONG_ROWS);
    expect(s).toMatchObject({ side: 'short', index: 25, sweptLevel: 104, mssLevel: 99, zone: { kind: 'fvg', top: 101, bottom: 98 } });
    expect(s!.entry).toBeCloseTo(flip(l!.entry), 10);
    expect(s!.stop).toBeCloseTo(flip(l!.stop), 10);
  });

  test('no sweep, a breakdown instead of a sweep, or no displacement: no setup', () => {
    // Bar 22 stays above the 96 low.
    expect(setupsIn(withRow(LONG_ROWS, 22, [97.5, 98, 96.5, 97]))).toEqual([]);
    // Bar 22 closes below 96: that's a breakdown, not a sweep.
    expect(setupsIn(withRow(LONG_ROWS, 22, [97.5, 98, 95, 95.5]))).toEqual([]);
    // Bar 24 closes above 101 on a small, wicky body.
    expect(setupsIn(withRow(withRow(LONG_ROWS, 24, [98.5, 104, 98.3, 101.5]), 25, [101.5, 102, 100.5, 101.8]))).toEqual([]);
  });

  test('with no FVG in the leg, a bearish gap the leg closed back above is used (iFVG)', () => {
    let rows: ReadonlyArray<Row> = withRow(LONG_ROWS, 18, [99, 99.5, 96, 97]); // bearish gap 99.5–100 on the way down
    rows = withRow(rows, 24, [98.5, 104, 97.9, 103.8]); // no gap between 22 and 24
    rows = withRow(rows, 25, [103.8, 105, 98.9, 104.5]); // none between 23 and 25
    const [s] = setupsIn(rows);
    expect(s).toMatchObject({ side: 'long', zone: { kind: 'ifvg', top: 100, bottom: 99.5 }, entry: 99.75 });
  });
});

describe('no lookahead', () => {
  test('every structure query at t is identical on the full series and on candles[0..t]', () => {
    // A long random walk with regime changes, so many swings, gaps and setups.
    let s = 7;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const rows: Row[] = [];
    let p = 100;
    for (let i = 0; i < 400; i++) {
      const drift = Math.sin(i / 25) * 0.6;
      const o = p;
      // Occasional impulse candles, so displacement actually happens.
      const impulse = rnd() < 0.08 ? (rnd() < 0.5 ? -1 : 1) * (5 + rnd() * 4) : 0;
      const c = o + drift + impulse + (rnd() - 0.5) * 3;
      rows.push([o, Math.max(o, c) + rnd() * 1.5, Math.min(o, c) - rnd() * 1.5, c]);
      p = c;
    }
    const all = bars(rows);
    const full = analyze(all);
    let found = 0;
    for (let t = 20; t < all.length; t++) {
      const cut = analyze(all.slice(0, t + 1));
      expect(detectSetup(cut, t), `setup at ${t}`).toEqual(detectSetup(full, t));
      expect(biasAt(cut.long, t), `bias at ${t}`).toEqual(biasAt(full.long, t));
      if (detectSetup(full, t)) found++;
    }
    expect(found).toBeGreaterThan(3);
  });
});

describe('bias', () => {
  test('up-structure in premium with nothing else is neutral; a bullish FVG tap makes it long', () => {
    const ctx = buildContext(bars(LONG_ROWS));
    const b = biasAt(ctx, 25);
    expect(b).toMatchObject({ structure: 'up', zone: 'premium', direction: 'neutral' });
    const tap = buildContext(bars([...LONG_ROWS, [104.5, 104.6, 100.8, 101.5]])); // dips into 99–102
    expect(biasAt(tap, 26)).toMatchObject({ direction: 'long', tapped: { bull: true, bear: false } });
    expect(biasAt(tap, 26).reasons).toContain('tapped bullish FVG');
  });

  test('SMT: one series makes a lower low, the other a higher low → bullish', () => {
    const a = buildContext(bars(LONG_ROWS)); // lows 96 then 95
    let other: ReadonlyArray<Row> = withRow(LONG_ROWS, 22, [97.5, 98, 96.5, 97]);
    other = withRow(other, 23, [97, 99, 97, 98.5]); // lows 96 then 96.5
    const b = buildContext(bars(other));
    expect(smt(a, b, 25)).toBe('bullish');
    expect(smt(a, a, 25)).toBeNull();
    expect(biasAt(a, 25, undefined, b)).toMatchObject({ smt: 'bullish', direction: 'long' });
  });

  test('the mirrored series has the mirrored bias', () => {
    const tap = bars([...LONG_ROWS, [104.5, 104.6, 100.8, 101.5]]);
    expect(biasAt(buildContext(mirror(tap)), 26)).toMatchObject({ direction: 'short', structure: 'down' });
  });

  test('combineBias: the higher timeframe decides, the lower can only veto', () => {
    expect(combineBias('long', 'long')).toBe('long');
    expect(combineBias('long', 'neutral')).toBe('long');
    expect(combineBias('long', 'short')).toBe('neutral');
    expect(combineBias('neutral', 'long')).toBe('neutral');
  });

  test('barAt: last bar closed by a time', () => {
    const c = bars(LONG_ROWS);
    expect(barAt(c, H, T0 + 3 * H)).toBe(2);
    expect(barAt(c, H, T0 + 3 * H - 1)).toBe(1);
    expect(barAt(c, H, T0)).toBe(-1);
  });
});
