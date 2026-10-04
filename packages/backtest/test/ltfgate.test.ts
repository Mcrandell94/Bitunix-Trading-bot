import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { gateOk, makerFill } from '../src/screen/ltfgate';
import { scalp2Trade } from '../src/screen/scalp2';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: i * H, open: o, high: h, low: l, close: c, volume: 1 });

describe('cost / stop gate', () => {
  test('K x 0.22%: K = 10 needs a stop of at least 2.2%', () => {
    expect(gateOk(2.1, 10)).toBe(false);
    expect(gateOk(2.2, 10)).toBe(true);
    expect(gateOk(1.2, 5)).toBe(true);
    expect(gateOk(3.2, 15)).toBe(false);
    expect(gateOk(0.1, null)).toBe(true);
  });
});

describe('maker fill: trade through by one tick, 2 bars', () => {
  const tick = 0.01;
  test('a long fills only when the low reaches the limit minus a tick', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 99.995, 100.5), bar(2, 100.5, 101, 99.99, 100)];
    expect(makerFill(c, 0, 1, tick)).toEqual({ q: 2, px: 100 }); // bar 1 only touched (99.995 > 99.99)
  });
  test('missed after 2 bars', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 101, 100, 100.5), bar(2, 100.5, 101, 100, 100.5), bar(3, 100, 100, 98, 99)];
    expect(makerFill(c, 0, 1, tick)).toBeNull();
  });
  test('a short fills when the high reaches the limit plus a tick', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(1, 100, 100.01, 99, 99.5)];
    expect(makerFill(c, 0, -1, tick)).toEqual({ q: 1, px: 100 });
  });
});

describe('take-profit limit needs a trade-through', () => {
  test('a touch of the 2R target is not a fill; one tick through is', () => {
    // Long at 100 (bar 0 open), stop 99, 2R = 102. Bar 1 touches 102 only; bar 2 trades 102.01.
    const c = [bar(0, 100, 100.5, 99.5, 100), bar(1, 100, 102, 99.5, 101), bar(2, 101, 102.01, 100.5, 101.5), bar(3, 101.5, 101.5, 101, 101)];
    const t = scalp2Trade(c, [], [], 0, 99, 1, 4, '2R', [], undefined, 0.01)!;
    expect(t.end).toBe(2);
    expect(t.how).toBe('target');
    expect(scalp2Trade(c, [], [], 0, 99, 1, 4, '2R')!.end).toBe(1); // the old touch rule
  });
});

describe('independent coin flips', () => {
  test('different seeds are not mirror images of each other', async () => {
    const { coin, flip } = await import('../src/screen/scalp2');
    const keys = Array.from({ length: 400 }, (_, j) => j);
    const agree = (f: (s: number, y: string, j: number) => boolean, a: number, b: number) => keys.filter((j) => f(a, 'BTCUSDT', j) === f(b, 'BTCUSDT', j)).length;
    expect(agree(flip, 1, 3)).toBe(400); // the old helper: odd seeds identical
    const x = agree(coin, 1, 3);
    expect(x).toBeGreaterThan(150);
    expect(x).toBeLessThan(250);
    const heads = keys.filter((j) => coin(7, 'ETHUSDT', j)).length;
    expect(heads).toBeGreaterThan(160);
    expect(heads).toBeLessThan(240);
  });
});
