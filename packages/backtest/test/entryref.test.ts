import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinCard } from '../src/screen/coincard';
import { ER, ER_SCRIPTS, erDecode, erEncode, erMerge, erReport, erRunner, erSections, erSnap, erStats, erTrade, nullName, runQ, type ErSnap, type ErTrade } from '../src/screen/entryref';
import { ETH_PERIODS } from '../src/screen/eth';

const Q = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H, T0 = Date.UTC(2024, 0, 1);
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
/** 15m bars from T0, one per [open, high, low, close]. */
const bars = (rows: [number, number, number, number][], t0 = T0) => rows.map(([o, h, l, c], i) => bar(t0 + i * Q, o, h, l, c));
const cost = (ER.costPct / 100) * 100; // at an entry of 100

/** 15m random walk with regimes and volume spikes, and its 1H / 4H / 1D bars (as in coincard.test.ts). */
function market(days: number, seed = 5, p0 = 2500) {
  let s = seed >>> 0, p = p0;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const m15: Candle[] = [];
  for (let i = 0; i < days * 96; i++) {
    const ret = Math.sin(i / 700) * 0.0004 + (r() < 0.004 ? (r() < 0.5 ? -1 : 1) * 0.01 : 0) + (r() - 0.5) * 0.004, o = p, c = o * (1 + ret);
    p = c;
    m15.push(bar(Date.UTC(2023, 0, 2) + i * Q, o, Math.max(o, c) * (1 + 0.001 * r()), Math.min(o, c) * (1 - 0.001 * r()), c, 1e6 * (1 + r()) * (r() < 0.01 ? 6 : 1)));
  }
  const up = (ms: number) => {
    const out: Candle[] = [];
    for (const x of m15) { const t = Math.floor(x.openTime / ms) * ms, l = out.at(-1); if (l && l.openTime === t) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume! += x.volume!; } else out.push({ ...x, openTime: t }); }
    return out;
  };
  return { m15, h1: up(H), h4: up(H4), d1: up(DAY) };
}

describe('entry references', () => {
  test('the window: 4H closes, two halves, trades end before the ETH holdout', () => {
    expect(ER.from < ER.split && ER.split < ER.to).toBe(true);
    for (const t of [ER.from, ER.split, ER.to]) expect(t % H4).toBe(0);
    expect(ER.to + ER.holdMs).toBeLessThanOrEqual(ETH_PERIODS.holdoutFrom);
    expect(ER_SCRIPTS).toHaveLength(43); // the card's 47 less the 4 live-only sources
    expect(ER_SCRIPTS).not.toContain('LiqWall order-book walls');
    const groups = erSections().flatMap((s) => s.groups);
    expect(new Set(groups).size).toBe(groups.length);
  });

  test('a long: the fill at the near edge, the targets and the next POI before the stop, the stop bar last; held and run', () => {
    // Zone 98–100 under a close of 102, 4H ATR 2: entry 100, stop 97 (0.5 ATR under 98), R = 3.
    const m = bars([[102, 102.5, 101, 101.5], [101.5, 101.8, 99.5, 100.5], [100.5, 103.2, 100.2, 103], [103, 106.5, 102.8, 106], [106, 106.2, 96.5, 97], [97, 120, 96, 119]]);
    const tr = erTrade(m, 0, { t: T0, side: 'long', ref: { lo: 98, hi: 100 }, atr4h: 2, next: 105 })!;
    expect(tr).toMatchObject({ fillAt: T0 + Q, entry: 100, stop: 97, held: true, endAt: T0 + 5 * Q });
    expect(tr.runPct).toBeCloseTo(6.5, 9); // the stop bar's high (106.2) and the fill bar's high (101.8) do not count
    expect(tr.stopPct).toBeCloseTo(3, 9);
    expect(tr.r[0]).toBeCloseTo((3 - cost) / 3, 9);
    expect(tr.r[1]).toBeCloseTo((6 - cost) / 3, 9);
    expect(tr.r[2]).toBeCloseTo(-1 - cost / 3, 9); // 3R (109) never before the stop
    expect(tr.rPoi).toBeCloseTo((5 - cost) / 3, 9);
    // A bar reaching the stop and a target: the stop.
    const both = bars([[102, 102.5, 101, 101.5], [101.5, 101.8, 99.5, 100.5], [100.5, 106.5, 96.9, 103]]);
    for (const x of erTrade(both, 0, { t: T0, side: 'long', ref: { lo: 98, hi: 100 }, atr4h: 2, next: null })!.r) expect(x).toBeCloseTo(-1 - cost / 3, 9);
    // The fill bar reaching the stop: stopped there, run 0.
    expect(erTrade(bars([[101, 101, 96, 99]]), 0, { t: T0, side: 'long', ref: { lo: 98, hi: 100 }, atr4h: 2, next: null })).toMatchObject({ runPct: 0, held: false, endAt: T0 + Q });
  });

  test('no fill after the next 4H bar; a gap fills at the open; after 7 days the close; a short mirrored', () => {
    const flat = (n: number, p: number, t0 = T0) => bars(Array.from({ length: n }, () => [p, p + 0.2, p - 0.2, p] as [number, number, number, number]), t0);
    expect(erTrade([...flat(16, 102), ...bars([[101, 101, 99, 100]], T0 + H4)], 0, { t: T0, side: 'long', ref: { lo: 99, hi: 100 }, atr4h: 2, next: null })).toBeNull();
    const gap = erTrade(bars([[99, 99.5, 98.8, 99.2]]), 0, { t: T0, side: 'long', ref: { lo: 98, hi: 100 }, atr4h: 2, next: null })!;
    expect([gap.entry, gap.stopPct]).toEqual([99, (2 / 99) * 100]);
    // Sideways for 8 days after the fill at 100: out at the close 7 days on (100.4), R = (0.4 − cost) / 3.
    const side = erTrade([...bars([[101, 101, 99.9, 100.4]]), ...flat(8 * 96, 100.4, T0 + Q)], 0, { t: T0, side: 'long', ref: { lo: 98, hi: 100 }, atr4h: 2, next: null })!;
    expect(side.r[1]).toBeCloseTo((0.4 - cost) / 3, 9);
    expect(side.endAt).toBe(T0 + 7 * DAY);
    // Short: zone 100–102 over a close of 98, entry 100, stop 103; 1R at 97.
    const sh = erTrade(bars([[99, 100.2, 98.8, 99.8], [99.8, 99.9, 96.8, 97]]), 0, { t: T0, side: 'short', ref: { lo: 100, hi: 102 }, atr4h: 2, next: 95 })!;
    expect([sh.entry, sh.stop]).toEqual([100, 103]);
    expect(sh.r[0]).toBeCloseTo((3 - cost) / 3, 9);
    expect(sh.runPct).toBeCloseTo(3.2, 9);
  });

  test('one trade a group and side at a time: the next from the first close after the stop or the 7 days', () => {
    const m = bars(Array.from({ length: 10 * 96 }, () => [100.5, 101, 99.8, 100.5] as [number, number, number, number]));
    const run = erRunner(m), snap = (t: number): ErSnap => ({ t, price: 100.5, atr4h: 2, atrD: 4, refs: new Map([['card POI', { long: { lo: 100, hi: 100 } }]]), next: { long: null, short: null } });
    for (let t = T0; t < T0 + 9 * DAY; t += H4) run.step(snap(t));
    expect(run.trades.map((x) => x.fillAt)).toEqual([T0, T0 + 7 * DAY]);
    expect(run.trades[0]).toMatchObject({ group: 'card POI', side: 'long', dist: 0.5 / 4 });
  });

  test('the snapshot: the card POIs, the clusters, each script alone, the null lines, the next POI', () => {
    const mk = market(420), t = mk.h4.at(-1)!.openTime;
    const w = <T extends { openTime: number }>(xs: T[], days: number) => xs.filter((x) => x.openTime >= t - days * DAY && x.openTime < t);
    const b = coinCard({ symbol: 'ETHUSDT', m15: w(mk.m15, 3), h1: w(mk.h1, 75), h4: w(mk.h4, 1095), d1: w(mk.d1, 1100), funding: null, now: t });
    const s = erSnap(b)!, price = b.card.price;
    expect(s.t).toBe(t);
    const n1 = s.refs.get('null · a level 0.25 daily ATR from the close')!, z1 = s.refs.get('null · a 0.5 daily ATR zone 0.25 daily ATR from the close')!;
    expect([n1.long, n1.short]).toEqual([{ lo: price - 0.25 * s.atrD, hi: price - 0.25 * s.atrD }, { lo: price + 0.25 * s.atrD, hi: price + 0.25 * s.atrD }]);
    expect([z1.long, z1.short]).toEqual([{ lo: price - 0.75 * s.atrD, hi: price - 0.25 * s.atrD }, { lo: price + 0.25 * s.atrD, hi: price + 0.75 * s.atrD }]);
    const poi = b.card.poi.long[0];
    if (poi) {
      expect(s.refs.get('card POI')!.long).toEqual({ lo: poi.lo, hi: poi.hi });
      expect(s.refs.has(`card POI · with ${poi.fams[0]}`)).toBe(true);
    }
    expect(s.next.long).toBe(b.card.poi.short[0]?.lo ?? null);
    expect([...s.refs.keys()].some((k) => k.startsWith('cluster · '))).toBe(true);
    const scripts = [...s.refs].filter(([k]) => k.startsWith('script · '));
    expect(scripts.length).toBeGreaterThan(10);
    for (const [, e] of scripts) {
      if (e.long) expect(e.long.hi < price && e.long.hi - e.long.lo <= s.atrD && price - e.long.hi <= b.card.poi.maxDist).toBe(true);
      if (e.short) expect(e.short.lo > price && e.short.hi - e.short.lo <= s.atrD && e.short.lo - price <= b.card.poi.maxDist).toBe(true);
    }
  });

  test('the stats add up across cells, survive the log lines, and the report lists only what holds up in every cell', () => {
    const tr = (group: string, r: number, run = 2, side: 'long' | 'short' = 'long'): ErTrade => ({ group, side, t: T0, fillAt: T0, endAt: T0, entry: 100, stop: 99, dist: 1, stopPct: 1, held: run >= 1, runPct: run, r: [r, r, r], rPoi: null });
    const cell = (k: number, rPoi: number) => erStats([
      ...Array.from({ length: 20 }, (_, i) => tr('card POI', rPoi, 1 + (i % 10))),
      ...Array.from({ length: 20 }, () => tr('script · Shaakuni levels', k === 0 ? -0.5 : 0.8)),
      ...ER.nulls.flatMap((x) => Array.from({ length: 10 }, () => tr(nullName(x), -0.2))),
    ]);
    const a = cell(0, 0.4), b = cell(1, 0.3);
    expect(erMerge([a, b])['card POI|long']).toMatchObject({ n: 40, held: 40 });
    expect(runQ(a['card POI|long']!, 0.5)).toBeCloseTo(5.05, 9); // runs 1..10 twice: the 10th is 5 (bin 50, its middle 5.05)
    const lines = [...erEncode('BTC-H1', a, 200), ...erEncode('ETH-H1', b, 200)].map((x) => `2026-10-18T10:00:00.0000000Z ${x}`).join('\n');
    expect(erDecode(lines)).toEqual([{ name: 'BTC-H1', stats: a }, { name: 'ETH-H1', stats: b }]);
    const out = erReport(erDecode(lines)).join('\n');
    expect(out).toContain(' card POI: n 40 · held 100%');
    expect(out).toContain('| 2R by cell +0.40 / +0.30');
    expect(out).toContain(' long · card POI · target 1R: avg R +0.35 (n 40, win 100%) · cells +0.40 / +0.30');
    expect(out).not.toContain(' long · card POI · target next POI'); // no POI target in these trades
    expect(out).not.toContain(' long · script · Shaakuni levels · target'); // over 0 pooled, under 0 in one cell
    expect(out).toContain(' script · BigBeluga S/D: no trades');
  });
});
