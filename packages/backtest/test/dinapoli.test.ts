import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { DINAPOLI, dinapoli, dnAt, dnPivot, dnTrades } from '../src/screen/dinapoli';
import { taAtr } from '../src/screen/pine';

const H4 = 4 * 3_600_000;
/** Bars along a close path: open = the previous close, wicks 0.2 past the body. */
const path = (cl: number[]): Candle[] => cl.map((x, k) => { const o = k ? cl[k - 1]! : x; return { openTime: k * H4, open: o, high: Math.max(o, x) + 0.2, low: Math.min(o, x) - 0.2, close: x, volume: 1000 }; });
/** 110 -> 90 (A, bar 10), -> 120 (B, bar 20), -> C (bar 27), then up 1.6 a bar for `up` bars. */
function abc(cClose: number, up = 30): number[] {
  const cl: number[] = [];
  for (let k = 0; k <= 10; k++) cl.push(110 - 2 * k);
  for (let k = 11; k <= 20; k++) cl.push(90 + 3 * (k - 10));
  for (let k = 21; k <= 27; k++) cl.push(120 + ((cClose - 120) * (k - 20)) / 7);
  for (let k = 1; k <= up; k++) cl.push(cClose + 1.6 * k);
  return cl;
}

describe('DiNapoli Levels Confluence Targets [MarkitTick]', () => {
  test('the script\'s pivots: an equal high on the left disqualifies, an equal one on the right does not', () => {
    const src = [1, 1, 1, 1, 1, 5, 4, 3, 2, 1, 0];
    expect(dnPivot(src, 10, 5, 5, true)).toBe(5);
    expect(dnPivot(src.map((v, k) => (k === 2 ? 5 : v)), 10, 5, 5, true)).toBeNaN();
    expect(dnPivot(src.map((v, k) => (k === 7 ? 5 : v)), 10, 5, 5, true)).toBe(5);
    expect(dnPivot(src.map((v, k) => (k === 7 ? 6 : v)), 10, 5, 5, true)).toBeNaN();
  });

  test('A-B-C bull: a 50% retrace gives the F38.2 entry, the stop under C and COP / OP / XOP from C; fires when C is confirmed', () => {
    const c = path(abc(105.2)), S = dinapoli(c), s = S.setups[0]!, a = taAtr(c, DINAPOLI.atrLen)[32]!;
    expect(S.setups).toHaveLength(1);
    expect([s.i, s.cBar, s.dir, s.node]).toEqual([32, 27, 1, 382]); // C (bar 27) confirmed 5 bars later
    expect(s.a).toBeCloseTo(89.8, 9);
    expect(s.b).toBeCloseTo(120.2, 9);
    expect(s.c).toBeCloseTo(105.0, 9);
    const sw = s.b - s.a;
    expect(s.retr).toBeCloseTo((s.b - s.c) / sw, 12);
    expect(s.entry).toBeCloseTo(s.b - 0.382 * sw, 12);
    expect(s.stop).toBeCloseTo(s.c - 0.5 * a, 12);
    expect([s.cop, s.op, s.xop]).toEqual([s.c + 0.618 * sw, s.c + sw, s.c + 1.618 * sw]);
    const first = (lvl: number) => c.findIndex((b, k) => k > s.i && b.high >= lvl);
    expect([s.copAt, s.opAt, s.stopAt]).toEqual([first(s.cop), first(s.op), -1]);
    const tr = dnTrades(c, S)[0]!;
    expect(tr.how).toBe('op');
    expect(tr.ret).toBeCloseTo(s.op / c[32]!.close - 1 - 0.0022, 12);
    expect(dnAt(S, 31)).toBeNull();
    expect(dnAt(S, s.copAt)!.cop).toBe(true);
    expect(dnAt(S, s.copAt - 1)!.cop).toBe(false);
  });

  test('a 70% retrace uses the F61.8 node; over 90% is no setup', () => {
    const deep = dinapoli(path(abc(120.2 - 0.7 * 30.4 + 0.2))).setups[0]!;
    expect(deep.node).toBe(618);
    expect(deep.entry).toBeCloseTo(deep.b - 0.618 * (deep.b - deep.a), 12);
    expect(dinapoli(path(abc(120.2 - 0.95 * 30.4 + 0.2))).setups).toHaveLength(0);
  });

  test('a bar reaching both the stop and COP counts the stop (the setup closes)', () => {
    const c = path(abc(105.2, 6)), s0 = dinapoli(c).setups[0]!;
    c.push({ openTime: c.length * H4, open: c.at(-1)!.close, high: s0.cop + 1, low: s0.stop - 1, close: c.at(-1)!.close, volume: 1000 });
    const s = dinapoli(c).setups[0]!;
    expect(s.stopAt).toBe(c.length - 1);
    expect(s.copAt).toBe(-1);
    expect(dnTrades(c, dinapoli(c))[0]!.how).toBe('stop');
  });

  test('no look-ahead: a run cut at bar k equals the full run up to k', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const cl: number[] = [2000];
    for (let k = 1; k < 2500; k++) cl.push(cl[k - 1]! + (rnd() - 0.5) * 40 + Math.sin(k / 50) * 6);
    const c = path(cl), full = dinapoli(c), cut = 1800, part = dinapoli(c.slice(0, cut)), clip = (v: number) => (v >= cut ? -1 : v);
    expect(full.setups.length).toBeGreaterThan(10);
    expect(part.setups).toEqual(full.setups.filter((s) => s.i < cut).map((s) => ({ ...s, replacedAt: clip(s.replacedAt), copAt: clip(s.copAt), opAt: clip(s.opAt), xopAt: clip(s.xopAt), stopAt: clip(s.stopAt) })));
  });
});
