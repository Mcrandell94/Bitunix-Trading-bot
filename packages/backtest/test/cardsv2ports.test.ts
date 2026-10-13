import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { cpPeaks, cpSr } from '../src/screen/cpsr';
import { absAt, fvgAbsorb } from '../src/screen/fvgabsorb';
import { htfFvg, htfFvgFor, htfShown } from '../src/screen/htffvg';
import { liqHeat } from '../src/screen/liqheat';
import { luxDynOb, luxShown } from '../src/screen/luxdynob';
import { mmLive, mmob } from '../src/screen/mmob';
import { optimusSr } from '../src/screen/optimussr';
import { taAtr } from '../src/screen/pine';
import { smartSr } from '../src/screen/smartsr';
import { taCmo, vidyaHeat, vidyaLine } from '../src/screen/vidyaheat';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
/** Bars along a close path: open = the previous close, wicks 0.2 past the body. */
const path = (cl: number[], ms = H4, t0 = Date.UTC(2025, 0, 6)): Candle[] =>
  cl.map((x, k) => { const o = k ? cl[k - 1]! : x; return { openTime: t0 + k * ms, open: o, high: Math.max(o, x) + 0.2, low: Math.min(o, x) - 0.2, close: x, volume: 1000 * (1 + (k % 7)) * x }; });
function walk(n: number, seed = 7, ms = H4): Candle[] {
  let s = seed;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const cl: number[] = [2000];
  for (let k = 1; k < n; k++) cl.push(Math.max(50, cl[k - 1]! + (r() - 0.5) * 30 + Math.sin(k / 40) * 5));
  return path(cl, ms).map((b) => ({ ...b, volume: 1000 * (1 + 5 * r()) * b.close }));
}
/** Alternating closes: every high and every low equal, so no pivots form. */
const flat = (n: number) => Array.from({ length: n }, (_, k) => (k % 2 ? 100.5 : 100));

describe('MarketMaulers Order Blocks', () => {
  test('a close over the swing high makes a bullish OB from the run of down candles; a close under its bottom breaks it', () => {
    const c = path([...flat(20), 101, 102, 103, 104, 105, 108, 106, 105, 104, 103, 102, 112, 113, 107.5, 112, 101]);
    c[25]!.high = 109; // the swing high (bar 26's high would otherwise equal it)
    const zs = mmob(c), z = zs.find((x) => x.dir === 1)!;
    // Pivot high: bar 25 confirmed at bar 30; bar 31 closes 112 over it. Down run: bars 26..30.
    expect([z.createdAt, z.near, z.left]).toEqual([31, 30, 26]);
    expect(z.top).toBeCloseTo(108, 9); // highest body high of the run (bar 26 opens at 108)
    expect(z.bot).toBeCloseTo(101.8, 9); // lowest wick low (bar 30)
    expect(z.mitigatedAt).toBe(31); // the breaking bar's own low is inside: tapped at birth, as the script does
    expect([z.removedAt, z.how]).toEqual([35, 'broken']); // bar 35 closes at 101, under the bottom
    expect(mmLive(zs, 34).map((x) => x.z)).toEqual([z]);
  });

  test('every OB passed the 1.5 ATR displacement; at most 12 live; no look-ahead', () => {
    const c = walk(1500), full = mmob(c), atr = taAtr(c, 14);
    expect(full.length).toBeGreaterThan(20);
    for (const z of full) expect(Math.abs(c[z.createdAt]!.close - c[z.near]!.open)).toBeGreaterThanOrEqual(1.5 * atr[z.createdAt]!);
    for (let i = 300; i < c.length; i += 97) expect(mmLive(full, i).length).toBeLessThanOrEqual(12);
    const cut = 1100, part = mmob(c.slice(0, cut)), clip = (v: number) => (v >= cut ? -1 : v);
    expect(part).toEqual(full.filter((z) => z.createdAt < cut).map((z) => ({ ...z, mitigatedAt: clip(z.mitigatedAt), removedAt: clip(z.removedAt), how: z.removedAt >= cut ? null : z.how })));
  });
});

describe('LuxAlgo Dynamic Order Blocks', () => {
  test('after a swing bottom and a swing top, the first close over the top makes a block from the lowest body low after it', () => {
    const cl: number[] = [];
    for (let k = 0; k <= 10; k++) cl.push(110 - k); // down to 100 at bar 10
    for (let k = 1; k <= 15; k++) cl.push(100 + k); // up to 115 at bar 25
    for (let k = 1; k <= 10; k++) cl.push(115 - k * 1.5); // down to 100 at bar 35
    for (let k = 1; k <= 12; k++) cl.push(100 + k * 2); // up through the top
    const c = path(cl), ks = luxDynOb(c), b = ks.find((k) => k.dir === 1)!;
    // The swing top is bar 26 (high 115.2, the first one strictly over the next 10); bar 43 closes 116 over it.
    expect(b.createdAt).toBe(43);
    // Bars 35 and 36 share the lowest body low (100): the one further back (bar 35, body 100..101.5) is the block.
    expect([b.btm, b.top]).toEqual([100, 101.5]);
    expect(luxShown(ks, 43).bull).toBe(b);
  });

  test('no look-ahead', () => {
    const c = walk(1500, 3), full = luxDynOb(c), cut = 1000, part = luxDynOb(c.slice(0, cut));
    expect(full.length).toBeGreaterThan(10);
    expect(part).toEqual(full.filter((k) => k.createdAt < cut).map((k) => ({ ...k, removedAt: k.removedAt >= cut ? -1 : k.removedAt })));
  });
});

describe('HTF FVG / IFVG', () => {
  test('a bullish gap turns into a bearish IFVG after 2 closes under it and goes on 1 close back over it', () => {
    const c = path([100, 101, 106, 107, 106.5, 101, 100.5, 100, 99, 104, 105]), zs = htfFvg(c, { lookbackDays: 30, ordinals: false }), z = zs[0]!;
    expect([z.dir, z.createdAt, z.lo, z.hi]).toEqual([1, 2, c[0]!.high, c[2]!.low]); // bar 2's low over bar 0's high
    expect(z.convertedAt).toBe(8); // closes under 100.2 on bars 7 and 8
    expect([z.removedAt, z.how]).toEqual([9, 'invalidated']); // bar 9 closes over its top
    expect(htfShown(zs, 8).find((x) => x.z === z)).toMatchObject({ ifvg: true, side: -1 });
  });

  test('4H: only the 1st of consecutive same-direction gaps shows; the daily lookback drops gaps after 30 days', () => {
    const c = path([100, 101, 104, 108, 112, 113, 113.5, 113.2]), zs = htfFvgFor(c, '4H');
    expect(zs.map((z) => [z.createdAt, z.fvgOrd])).toEqual([[2, 1], [3, 2], [4, 3], [5, 4], [6, 5]]);
    expect(htfShown(zs, 7).map((x) => x.z.createdAt)).toEqual([2]);
    const d = path([100, 101, 106, ...Array.from({ length: 40 }, () => 107)], DAY), zd = htfFvgFor(d, 'D');
    expect([zd[0]!.how, zd[0]!.removedAt]).toEqual(['lookback', 33]);
  });

  test('no look-ahead', () => {
    const o = { lookbackDays: 30, ordinals: true }, c = walk(1500, 11), full = htfFvg(c, o), cut = 1200, part = htfFvg(c.slice(0, cut), o);
    const clip = (v: number) => (v >= cut ? -1 : v);
    expect(full.length).toBeGreaterThan(50);
    expect(part).toEqual(full.filter((z) => z.createdAt < cut).map((z) => ({ ...z, convertedAt: clip(z.convertedAt), removedAt: clip(z.removedAt), how: z.removedAt >= cut ? null : z.how, ifvgOrd: z.convertedAt >= cut ? 0 : z.ifvgOrd })));
  });
});

describe('LuxAlgo FVG Absorption', () => {
  test('a bullish gap is absorbed from the top down; a low through its bottom ends it', () => {
    const c = path([...flat(10), 100.5, 104, 108, 104, 102, 100]);
    c[15] = { ...c[15]!, high: 104, low: 99.5 }; // a long bar: through the bottom without leaving a bearish gap
    const gs = fvgAbsorb(c), g = gs[0]!;
    // Bar 12: its low (103.8) over bar 10's high (100.7) by more than the filter (0 before ATR(144)), bar 11 closed over it.
    expect(gs).toHaveLength(1);
    expect([g.dir, g.createdAt, g.bot, g.top]).toEqual([1, 12, c[10]!.high, c[12]!.low]);
    expect(absAt(gs, 13)!.absorbed).toBe(0); // bar 13's low (103.8) only reaches the top
    expect(absAt(gs, 14)!.absorbed).toBeCloseTo((103.8 - 101.8) / (103.8 - 100.7), 9); // bar 14 dips to 101.8
    expect([g.endAt, g.how]).toEqual([15, 'absorbed']); // bar 15's low (99.5) is under the bottom
    expect(absAt(gs, 15)).toBeNull();
  });

  test('only the latest gap is tracked; no look-ahead', () => {
    const c = walk(1500, 5), full = fvgAbsorb(c);
    expect(full.length).toBeGreaterThan(20);
    for (let k = 1; k < full.length; k++) expect(full[k - 1]!.endAt).toBeLessThanOrEqual(full[k]!.createdAt);
    const cut = 900, part = fvgAbsorb(c.slice(0, cut));
    expect(part).toEqual(full.filter((g) => g.createdAt < cut).map((g) => ({ ...g, fills: g.fills.filter((f) => f.i < cut), endAt: g.endAt >= cut ? -1 : g.endAt, how: g.endAt >= cut ? null : g.how })));
  });
});

describe('S/R scripts', () => {
  test('ChartPrime peak finder: a single peak, a plateau counts once at its middle', () => {
    expect(cpPeaks([1, 2, 5, 2, 1], 30, 1)).toEqual([2]);
    expect(cpPeaks([1, 4, 4, 4, 1], 30, 1)).toEqual([2]);
    expect(cpPeaks([1, 4, 4, 1], 30, 1)).toEqual([1.5]); // even width: int((1 + 3) / 2) - 0.5, as written
  });

  test('ChartPrime levels: supports under the close, resistances at or over it', () => {
    const c = walk(1200, 13), r = cpSr(c, c.length - 1), close = c.at(-1)!.close;
    expect(r.levels.length).toBeGreaterThan(1);
    for (const l of r.support) expect(l).toBeLessThan(close);
    for (const l of r.resistance) expect(l).toBeGreaterThanOrEqual(close);
  });

  test('Optimus: a twice-touched pivot low is a support, ranked by touches, 1.8% apart, 3 at most', () => {
    const c = walk(800, 17), at = c.length - 1, r = optimusSr(c, at, '4H'), close = c[at]!.close;
    for (const l of r.support) expect(l.price).toBeLessThan(close);
    for (const l of r.resistance) expect(l.price).toBeGreaterThan(close);
    for (const side of [r.support, r.resistance]) {
      expect(side.length).toBeLessThanOrEqual(3);
      for (const l of side) expect(l.touches).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < side.length; k++) expect(side[k]!.touches).toBeLessThanOrEqual(side[k - 1]!.touches);
      for (const a of side) for (const b of side) if (a !== b) expect(Math.abs(a.price - b.price) / b.price).toBeGreaterThanOrEqual(0.018 - 1e-12);
    }
    expect(r.zone).toBeCloseTo(close * 0.0025, 9);
  });

  test('Smart S/R: candidates on the right side, ranked by score, with the script tags', () => {
    const c = walk(1500, 19), d = walk(400, 23, DAY), h1 = walk(4000, 29, H), at = c.length - 1;
    const r = smartSr(c, at, H4, { c: h1, ms: H, label: '1H' }, { c: d, ms: DAY, label: 'Daily' }), price = c[at]!.close;
    expect(r.support.length + r.resistance.length).toBeGreaterThan(2);
    for (const s of r.support) expect(s.level).toBeLessThan(price);
    for (const s of r.resistance) expect(s.level).toBeGreaterThan(price);
    for (const side of [r.support, r.resistance]) for (let k = 1; k < side.length; k++) expect(side[k]!.score).toBeLessThanOrEqual(side[k - 1]!.score);
    const tags = new Set([...r.support, ...r.resistance].map((s) => s.tag.replace(/ \(.*\)$/, '')));
    for (const t of tags) expect(['Flipped Resistance', 'Flipped Support', '50 SMA', '200 SMA', 'Swing Low', 'Swing High', 'Period Low', 'Period High', 'Extended Low']).toContain(t);
  });
});

describe('VIDYA heat map and liquidity profile', () => {
  test('CMO by hand; VIDYA starts from 0 once the CMO exists', () => {
    expect(taCmo([1, 2, 4, 3, 5], 3)[3]).toBeCloseTo((100 * (1 + 2 - 1)) / (1 + 2 + 1), 9);
    expect(taCmo([1, 2, 4, 3, 5], 3)[4]).toBeCloseTo((100 * (2 + 2 - 1)) / (2 + 1 + 2), 9);
    const c = walk(400, 31), v = vidyaLine(c), first = v.findIndex((x) => !Number.isNaN(x));
    expect(first).toBeGreaterThan(10);
    expect(v[first]).toBeLessThan(c[first]!.close * 0.5); // pulled up from 0 slowly
  });

  test('trend value sign and UP / DOWN labels alternate; weekly uses the weeks there are; no look-ahead', () => {
    // An oscillating market (the VIDYA lags it, so the score swings both ways), with random volume.
    const c = walk(1500, 37).map((b, k) => { const x = 2000 + 300 * Math.sin(k / 45) + 40 * Math.sin(k / 7); return { ...b, open: x - 5, high: x + 15, low: x - 20, close: x }; }), s = vidyaHeat(c);
    const labels = s.label.map((l, i) => [l, i] as const).filter(([l]) => l !== 0);
    expect(labels.length).toBeGreaterThan(2);
    for (let k = 1; k < labels.length; k++) expect(labels[k]![0]).toBe(-labels[k - 1]![0]);
    expect(labels[0]![0]).toBe(1);
    for (let i = 0; i < c.length; i++) expect(s.up[i]).toBe(s.value[i]! > 0);
    expect(vidyaHeat(walk(120, 3, 7 * DAY), true).devLen).toBe(120);
    const part = vidyaHeat(c.slice(0, 1000));
    expect(part.value).toEqual(s.value.slice(0, 1000));
    expect(part.label).toEqual(s.label.slice(0, 1000));
  });

  test('liquidity profile: no bin holds the price; the max bin is the biggest shown', () => {
    const c = walk(1200, 41), p = liqHeat(c, c.length - 1);
    expect(p.bins.length).toBeGreaterThan(0);
    for (const b of p.bins) expect(p.price < b.hi && p.price > b.lo).toBe(false);
    if (p.max) for (const b of p.bins) expect(b.vol).toBeLessThanOrEqual(p.max.vol);
  });
});
