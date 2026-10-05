import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../src/indicators';
import { BASE_DIV, divTrade, parseCombo, regDivShorts } from '../src/screen/ltfdiv';
import { rsiPatterns } from '../src/screen/rsipatterns';

const H = 3_600_000;
function walk(n: number, seed: number): Candle[] {
  let x = seed, p = 100;
  const rnd = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 2 ** 32; };
  return Array.from({ length: n }, (_, i) => {
    const o = p, c = o * (1 + (rnd() - 0.5) * 0.03);
    p = c;
    return { openTime: i * H, open: o, high: Math.max(o, c) * (1 + rnd() * 0.01), low: Math.min(o, c) * (1 - rnd() * 0.01), close: c, volume: 1 };
  });
}

describe('parametrised bearish regular divergence', () => {
  test('with the base settings it finds exactly the catalogue\'s regular-div shorts', () => {
    for (const seed of [1, 7, 42]) {
      const c = walk(3000, seed), r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
      const mine = regDivShorts(c, r, atr, BASE_DIV).map((e) => `${e.i}|${e.stop.toFixed(6)}`);
      const cat = rsiPatterns(c, r, atr).filter((e) => e.d === -1 && e.pat === 'regular div').map((e) => `${e.i}|${e.stop.toFixed(6)}`);
      expect(cat.length).toBeGreaterThan(5);
      expect(mine).toEqual(cat);
    }
  });
  test('a stricter A level gives a subset', () => {
    const c = walk(3000, 3), r = rsi(c.map((b) => b.close), 14), atr = atrWilder(c, 14);
    const base = new Set(regDivShorts(c, r, atr).map((e) => e.i));
    expect(regDivShorts(c, r, atr, { ...BASE_DIV, a: 80 }).every((e) => base.has(e.i))).toBe(true);
  });
});

describe('trade and spec parsing', () => {
  test('breakeven after a close at +2R, then out at the entry', () => {
    const b = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: i * H, open: o, high: h, low: l, close: c, volume: 1 });
    const c = [b(0, 100, 100.5, 97.5, 98), b(1, 98, 99, 97.9, 98), b(2, 98, 100.5, 97.5, 100)];
    // short at 100, stop 101 (1R = 1), close 98 = +2R -> stop to 100, bar 2 trades 100.5 -> out at 100
    const t = divTrade(c, [], 0, 100, 101, -1, 3, { tgtR: 3, trail: false, be: 2 }, false, 0)!;
    expect(t.gross).toBeCloseTo(0);
    expect(t.how).toBe('stop');
  });
  test('combo string', () => {
    const s = parseCombo('stop:2,exit:be,daily:45,filter:btc50,k:none,entry:atr');
    expect(s).toMatchObject({ stop: 2, exit: '3R + BE 2R', daily: 45, k: null, filters: ['btc < 50d'], entry: 'maker +0.25 ATR' });
    expect(() => parseCombo('filter:nope')).toThrow(/unknown filter/);
  });
});
