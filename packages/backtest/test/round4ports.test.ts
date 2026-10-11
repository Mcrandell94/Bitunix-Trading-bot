import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { fibClusters, FIBCL, liveMagnets } from '../src/screen/fibclusters';
import { blockActive, fvgActive, fvgFirstTouch, fvgOb, fvgStrong, overlapShare } from '../src/screen/fvgob';
import { taAtr } from '../src/screen/pine';
import { openTargets, percentileNearestRank, rangeTargets, targetOutcome } from '../src/screen/rangetargets';
import { roundNear, srScore, srZones, SRZ } from '../src/screen/srzones';

const H4 = 4 * 3_600_000, DAY = 86_400_000;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v * c });

/** A seeded random walk (4H) and its daily bars, for the no-look-ahead checks. */
function walk(n: number, seed = 7): { h4: Candle[]; d1: Candle[] } {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const T0 = Date.UTC(2023, 0, 2), h4: Candle[] = [];
  let p = 2000;
  for (let k = 0; k < n; k++) {
    const o = p, c = o + (rnd() - 0.5) * 40 + Math.sin(k / 60) * 4;
    h4.push(bar(T0 + k * H4, o, Math.max(o, c) + rnd() * 15, Math.min(o, c) - rnd() * 15, c, 1000 + rnd() * 3000 * (rnd() < 0.1 ? 4 : 1)));
    p = c;
  }
  const d1: Candle[] = [];
  for (let k = 0; k < h4.length; k += 6) { const g = h4.slice(k, k + 6); d1.push({ openTime: g[0]!.openTime, open: g[0]!.open, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)), close: g.at(-1)!.close, volume: g.reduce((a, b) => a + b.volume!, 0) }); }
  return { h4, d1 };
}

describe('S/R Confluence Zones [AxeAlgo]', () => {
  test('score curve and round numbers', () => {
    expect(srScore(2, false, false, false)).toBe(40);
    expect(srScore(4, false, false, false)).toBe(49); // 80 - 40 / 1.3
    expect(srScore(2, true, true, true)).toBe(60);
    expect(srScore(9, false, false, false)).toBe(60); // 80 - 40 / 2.05 = 60.49
    expect(srScore(200, true, true, true)).toBe(98);
    expect(roundNear(110.5, 0.2)).toBe(true); // a multiple of 0.5 at magnitude 100
    expect(roundNear(110.3, 0.1)).toBe(false);
    expect(roundNear(2500, 1)).toBe(true);
    expect(roundNear(2502.4, 0.5)).toBe(false); // nearest step of 5 is 2.4 away
  });

  // A triangle wave: up 0.5 a bar for 20 bars, down for 20. Highs peak at 110.5 (bars 21, 61, ...; the 20th has an
  // equal high, so the pivot is the 21st), lows bottom at 99.5 (bars 41, 81, ...).
  const tri = (k: number) => { const f = k % 40; return f <= 20 ? 100 + f / 2 : 110 - (f - 20) / 2; };
  const wave = (n: number) => Array.from({ length: n }, (_, k) => { const o = k ? tri(k - 1) : tri(0), c = tri(k); return bar(k * H4, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c); });

  test('two pivots within 0.35 ATR open a zone; retests and later pivots add touches; strong at 60+', () => {
    const c = wave(200), S = srZones(c, '4H', []);
    const news = S.events.filter((e) => e.kind === 'new');
    expect(news.map((e) => [e.i, e.zone.dir])).toEqual([[64, 1], [84, -1]]); // confirmed 3 bars after the second pivot
    const z = S.snaps[64]!.find((x) => x.dir === 1)!, a = taAtr(c, 14)[64]!;
    expect(z.mid).toBe(110.5);
    expect(z.touch).toBe(2);
    expect(z.top - z.bot).toBeCloseTo(SRZ.clusterTolAtr * a * 0.5, 10); // padded to max(0.08, 0.175) ATR
    // Bar 100 trades into it (36 bars after the last touch): retest; bar 104 confirms the third pivot: merge.
    expect(S.snaps[100]!.find((x) => x.id === z.id)!.touch).toBe(3);
    expect(S.snaps[104]!.find((x) => x.id === z.id)!.touch).toBe(4);
    // Round tag on (110.5), no HTF (no daily bars), no volume spike: 6 touches -> 55 + 6 = 61, the first strong score.
    const strong = S.events.find((e) => e.kind === 'strong' && e.zone.id === z.id)!;
    expect(strong.i).toBe(144);
    expect(strong.zone.score).toBe(61);
  });

  test('rejection only off a 60+ zone; a close through flips the role and keeps the touches', () => {
    const c = wave(200), S = srZones(c, '4H', []);
    const rej = S.events.filter((e) => e.kind === 'reject' && e.zone.dir === 1).map((e) => e.i);
    expect(rej).not.toContain(141); // 5 touches = 58: not strong yet
    expect(rej).toContain(181); // bearish bar wicking into it and closing under it, 7 touches = 63
    const before = S.snaps[199]!.find((x) => x.dir === 1)!;
    const up = [...c, bar(200 * H4, 110, 113, 109.8, 112.5)], T = srZones(up, '4H', []);
    const flip = T.events.find((e) => e.kind === 'flip' && e.i === 200)!;
    expect(flip.zone.id).toBe(before.id);
    expect(flip.zone.dir).toBe(-1);
    expect(flip.zone.touch).toBe(1);
    expect(flip.zone.preTouch).toBe(before.touch + before.preTouch);
    expect(flip.prevScore).toBe(before.score);
  });

  test('no look-ahead: a run cut at bar k equals the full run up to k', () => {
    const { h4, d1 } = walk(1500), full = srZones(h4, '4H', d1), cut = 1100, t = h4[cut - 1]!.openTime + H4;
    const part = srZones(h4.slice(0, cut), '4H', d1.filter((b) => b.openTime + DAY <= t));
    expect(part.snaps[cut - 1]).toEqual(full.snaps[cut - 1]);
    expect(part.events).toEqual(full.events.filter((e) => e.i < cut));
  });
});

describe('FVG and Order Blocks Detector', () => {
  // 30 quiet bars at 100 (range 2), then a bull gap: bar 31 jumps, bar 32's low 102.5 clears bar 30's high 101.
  const base = () => Array.from({ length: 31 }, (_, k) => bar(k * H4, 100, 101, 99, 100));
  test('a 3-candle gap, its size and middle-candle volume, first touch and full fill', () => {
    const c = [...base(), bar(31 * H4, 100, 104.5, 99.8, 104, 3000), bar(32 * H4, 104, 105.5, 102.5, 105), bar(33 * H4, 105, 106, 104, 105.5), bar(34 * H4, 104, 104.2, 102.2, 103), bar(35 * H4, 103, 103.5, 100.5, 100.8)];
    const S = fvgOb(c), g = S.fvgs.find((x) => x.side === 1)!, a = taAtr(c, 14)[32]!;
    expect([g.bottom, g.top, g.leftBar, g.createdAt]).toEqual([101, 102.5, 30, 32]);
    expect(g.sizeAtr).toBeCloseTo(1.5 / a, 10);
    expect(g.volMult).toBeCloseTo((3000 * 104) / ((104.5 + 99.8 + 104) / 3) / 1000, 10); // coin volume (quote / typical price) vs the 20 bars before
    expect(fvgStrong(g)).toBe(true);
    expect(g.touchedAt).toBe(34); // low 102.2 <= top 102.5
    expect(g.filledAt).toBe(35); // low 100.5 < bottom 101 (full fill)
    expect(fvgActive(g, 34)).toBe(true);
    expect(fvgActive(g, 35)).toBe(false);
    expect(fvgFirstTouch(c, S.fvgs)[0]!.held).toBe(false); // closed through before moving 1 ATR away
  });

  test('a close over the 8/8 swing high on a 1.2 ATR bar makes the block from the lowest bearish candle in between', () => {
    const c = Array.from({ length: 40 }, (_, k) => bar(k * H4, 100, 101, 99, 100));
    c[20] = bar(20 * H4, 100, 103, 99, 100.5); // the swing high (confirmed at bar 28)
    c[35] = bar(35 * H4, 100.5, 101, 98.5, 99.5); // bearish, lowest low
    c[33] = bar(33 * H4, 100.2, 101, 98.9, 99.9); // bearish, higher low
    c.push(bar(40 * H4, 100, 106.5, 99.8, 106, 3000)); // close 106 > 103, range 6.7
    const S = fvgOb(c), k = S.blocks[0]!;
    expect(S.blocks).toHaveLength(1);
    expect([k.side, k.bottom, k.top, k.obBar, k.createdAt, k.impulseBar]).toEqual([1, 98.5, 101, 35, 40, 40]);
    expect(k.str.strong).toBe(true); // body 6 vs ATR, volume 3x
    const after = [...c, bar(41 * H4, 106, 106.5, 104, 105), bar(42 * H4, 105, 105, 98.4, 99)];
    const T = fvgOb(after);
    expect(T.blocks[0]!.mitigatedAt).toBe(42); // a wick under the block
    expect(blockActive(T.blocks[0]!, 41)).toBe(true);
    expect(blockActive(T.blocks[0]!, 42)).toBe(false);
  });

  test('on a long walk: 5 per type at most, and no new block overlaps an unmitigated same-side one by > 70%', () => {
    const { h4 } = walk(3000), S = fvgOb(h4);
    for (let i = 0; i < h4.length; i += 50) for (const side of [1, -1]) {
      expect(S.fvgs.filter((g) => g.side === side && g.createdAt <= i && (g.droppedAt < 0 || g.droppedAt > i)).length).toBeLessThanOrEqual(5);
      expect(S.blocks.filter((g) => g.side === side && g.createdAt <= i && (g.droppedAt < 0 || g.droppedAt > i)).length).toBeLessThanOrEqual(5);
    }
    for (const k of S.blocks) {
      const live = S.blocks.filter((o) => o !== k && o.side === k.side && o.createdAt < k.createdAt && (o.droppedAt < 0 || o.droppedAt > k.createdAt) && (o.mitigatedAt < 0 || o.mitigatedAt > k.createdAt));
      for (const o of live) expect(overlapShare(k, o)).toBeLessThanOrEqual(0.7);
    }
  });

  test('no look-ahead', () => {
    const { h4 } = walk(1500), full = fvgOb(h4), cut = 1100, part = fvgOb(h4.slice(0, cut));
    const clip = (x: number) => (x >= cut ? -1 : x);
    expect(part.fvgs).toEqual(full.fvgs.filter((g) => g.createdAt < cut).map((g) => ({ ...g, touchedAt: clip(g.touchedAt), filledAt: clip(g.filledAt), droppedAt: clip(g.droppedAt) })));
    expect(part.blocks).toEqual(full.blocks.filter((g) => g.createdAt < cut).map((g) => ({ ...g, mitigatedAt: clip(g.mitigatedAt), droppedAt: clip(g.droppedAt) })));
  });
});

describe('Strong Fibo Clusters (weekly anchor, 4H)', () => {
  const MON = Date.UTC(2025, 11, 29); // a Monday
  /** Week 0: flat 140 then down to 104; week 1: low 101 (bar 42), up to 141.5 (bar 58), down to 101.5 (bar 73), up. */
  function build(): Candle[] {
    const cl: number[] = [];
    for (let k = 0; k < 26; k++) cl.push(140);
    for (let k = 26; k <= 42; k++) cl.push(140 - (k - 25) * 2.25); // to 101.75 at bar 42
    for (let k = 43; k <= 58; k++) cl.push(cl[42]! + (k - 42) * 2.5); // to 141.75
    for (let k = 59; k <= 73; k++) cl.push(cl[58]! - (k - 58) * 2.6); // to 102.75
    for (let k = 74; k <= 83; k++) cl.push(cl[73]! + (k - 73) * 2); // to 122.75
    const c = cl.map((x, k) => { const o = k ? cl[k - 1]! : x; return bar(MON + k * H4, o, Math.max(o, x) + 0.1, Math.min(o, x) - 0.1, x); });
    c[42] = { ...c[42]!, low: 101 }; c[58] = { ...c[58]!, high: 142 }; c[73] = { ...c[73]!, low: 101.5 };
    return c;
  }

  test('clusters from the ended week\'s swing pairs, golden pocket, 50%, extensions', () => {
    const c = build(), w2: Candle[] = [];
    for (let k = 84; k < 90; k++) w2.push(bar(MON + k * H4, 122.75, 123, 122.5, 122.75));
    const all = [...c, ...w2], S = fibClusters(all), wk = S.weeks.find((w) => w.i === 84)!, a = taAtr(all, 14)[84]!;
    expect([wk.high, wk.low]).toEqual([142, 101]);
    // Two pairs (142 / 101.5 and 142 / 101): each ratio's two levels sit 0.5 x r apart, inside 0.5 ATR, so five
    // clusters of strength 2 centred on the mean of the two levels (the newest low first), 1.5 ATR+ apart.
    expect(0.5 * 0.786).toBeLessThan(FIBCL.tolAtr * a);
    expect(0.118 * 40.5).toBeGreaterThan(FIBCL.sepAtr * a);
    const cl = wk.zones.filter((z) => z.kind === 'cluster');
    expect(cl.map((z) => z.strength)).toEqual([2, 2, 2, 2, 2]);
    FIBCL.ratios.forEach((r, k) => expect(cl[k]!.center).toBeCloseTo(((142 - 40.5 * r) + (142 - 41 * r)) / 2, 10));
    const gp = wk.zones.find((z) => z.kind === 'gp')!, eq = wk.zones.find((z) => z.kind === 'eq')!;
    expect([gp.bot, gp.top]).toEqual([101 + 41 * 0.5, 101 + 41 * 0.618]);
    expect(eq.center).toBe(121.5);
    expect(wk.zones.filter((z) => z.kind === 'ext').map((z) => z.center)).toEqual([142 + 41 * 0.13, 142 + 41 * 0.27, 101 - 41 * 0.13, 101 - 41 * 0.27]);
  });

  test('prior-week high: sweep -> acceptance -> failed break; an untouched low becomes a virgin magnet until tagged', () => {
    const c = build();
    const w2: Candle[] = [];
    for (let k = 84; k < 126; k++) w2.push(bar(MON + k * H4, 122.75, 123, 122.5, 122.75));
    const A = (() => { const S = fibClusters([...c, ...w2]); return S.weeks.find((w) => w.i === 84)!.atr; })();
    w2[90 - 84] = bar(MON + 90 * H4, 122.75, 142 + 0.08 * A + 0.5, 122.5, 141); // sweep: wick over, close back under
    w2[92 - 84] = bar(MON + 92 * H4, 141, 142 + 0.3 * A + 1.5, 140, 142 + 0.3 * A + 1); // acceptance
    w2[93 - 84] = bar(MON + 93 * H4, 143, 144, 142.8, 143.2); // still over 142: stays accepted
    w2[94 - 84] = bar(MON + 94 * H4, 143, 143.5, 140.5, 141); // close back under: failed break
    const w3: Candle[] = [];
    for (let k = 126; k < 140; k++) w3.push(bar(MON + k * H4, 125, 125.5, 124.5, 125));
    w3[135 - 126] = bar(MON + 135 * H4, 125, 125.5, 100, 102); // trades through last week's untouched low 101
    const S = fibClusters([...c, ...w2, ...w3]);
    const ev = S.events.filter((e) => e.kind !== 'touch' && e.i >= 84 && e.i < 126).map((e) => [e.i, e.kind]);
    expect(ev).toEqual([[90, 'sweep-high'], [92, 'accept-high'], [94, 'fail-high']]);
    expect(S.stHigh[93]).toBe(2);
    expect(S.stHigh[95]).toBe(3);
    const low = S.magnets.find((m) => m.tag === 'virgin week low')!;
    expect([low.price, low.bornAt, low.taggedAt]).toEqual([101, 126, 135]);
    expect(S.magnets.some((m) => m.tag === 'virgin week high')).toBe(false); // the high was traded through
    expect(liveMagnets(S, 134)).toContain(low);
    expect(liveMagnets(S, 135)).not.toContain(low);
  });

  test('no look-ahead', () => {
    const { h4 } = walk(1500), full = fibClusters(h4), cut = 1100, part = fibClusters(h4.slice(0, cut));
    const strip = (e: { i: number; kind: string; price: number }) => [e.i, e.kind, e.price];
    expect(part.events.map(strip)).toEqual(full.events.filter((e) => e.i < cut).map(strip));
    expect(part.weeks.map((w) => [w.i, w.high, w.low, w.zones.map((z) => z.center)])).toEqual(full.weeks.filter((w) => w.i < cut).map((w) => [w.i, w.high, w.low, w.zones.map((z) => z.center)]));
    expect(Array.from(part.stHigh)).toEqual(Array.from(full.stHigh.slice(0, cut)));
  });
});

describe('Range Breakout Targets [FEELS]', () => {
  test('percentile, nearest rank', () => {
    expect(percentileNearestRank([5, 1, 4, 2, 3], 4, 5, 30)).toBe(2);
    expect(percentileNearestRank([5, 1, 4, 2, 3], 4, 5, 50)).toBe(3);
    expect(percentileNearestRank([5, 1, 4, 2, 3], 4, 3, 30)).toBe(2); // last 3: 4, 2, 3
  });

  /** 240 bars whose 10-bar range keeps widening (never tight), then 25 tight bars (100 +/- 0.15), then `after`. */
  function build(after: (k: number) => Candle[]): Candle[] {
    const c: Candle[] = [];
    for (let k = 0; k < 240; k++) { const a = 1 + 0.02 * k, x = k % 2 ? 100 + a : 100 - a; c.push(bar(k * H4, k ? c[k - 1]!.close : x, x + 0.5, x - 0.5, x)); }
    c[239] = bar(239 * H4, c[238]!.close, 106.3, 93.7, 100); // wide both ways: the first tight window is 240..249
    for (let k = 240; k < 265; k++) { const x = k % 2 ? 100.1 : 99.9; c.push(bar(k * H4, k === 240 ? 100 : c[k - 1]!.close, x + 0.05, x - 0.05, x)); }
    return [...c, ...after(265)];
  }

  test('a tight stretch of 15+ bars becomes a box; a close out of it sets the measured target; retest, then reached', () => {
    const c = build((k) => [bar(k * H4, 100, 112.5, 99.95, 112), bar((k + 1) * H4, 112, 113, 100.1, 101)]), S = rangeTargets(c);
    const box = S.boxes[0]!;
    expect(S.boxes).toHaveLength(1);
    expect([box.left, box.createdAt]).toEqual([240, 265]);
    expect(box.hi).toBeCloseTo(100.15, 10);
    expect(box.lo).toBeCloseTo(99.85, 10);
    const t = S.targets[0]!;
    expect([t.up, t.from]).toEqual([true, 265]);
    expect(t.edge).toBe(box.hi);
    expect(t.far).toBe(box.lo);
    expect(t.px).toBeCloseTo(100.45, 10);
    expect(S.events.filter((e) => e.i === 266).map((e) => e.kind)).toEqual(['retest', 'reached']);
    expect(targetOutcome(c, t)).toEqual({ end: 'reached', ret: t.px / 112 - 1 });
    expect(S.now.forming[255]).toBe(1); // 16 bars of quiet by bar 255
    expect(S.now.hi[264]).toBeCloseTo(100.15, 10);
  });

  test('a close back beyond the far side kills the target; an untouched one expires after 120 bars', () => {
    const dn = build((k) => [bar(k * H4, 100, 100, 87.5, 88), bar((k + 1) * H4, 100.5, 101.5, 100, 101)]), S = rangeTargets(dn);
    expect(S.targets[0]!.up).toBe(false);
    expect(S.events.filter((e) => e.i === 266).map((e) => e.kind)).toEqual(['retest', 'failed']);
    const flat = build((k) => [bar(k * H4, 100, 112.5, 99.95, 112), ...Array.from({ length: 125 }, (_, q) => bar((k + 1 + q) * H4, 100.3, 100.4, 100.2, 100.3))]);
    // Gap down to 100.3 under the 100.45 target but over the box: neither reached nor failed.
    const T = rangeTargets(flat), t = T.targets[0]!;
    expect(t.reachedAt).toBe(-1);
    expect(t.failedAt).toBe(-1);
    expect(t.expiredAt).toBe(265 + 120);
    expect(openTargets(T, 265 + 119)).toContain(t);
    expect(openTargets(T, 265 + 120)).not.toContain(t);
  });

  test('no look-ahead', () => {
    const { h4 } = walk(1500), full = rangeTargets(h4), cut = 1100, part = rangeTargets(h4.slice(0, cut));
    const strip = (e: { i: number; kind: string; target?: { px: number } }) => [e.i, e.kind, e.target?.px ?? null];
    expect(part.events.map(strip)).toEqual(full.events.filter((e) => e.i < cut).map(strip));
    expect(Array.from(part.now.hi)).toEqual(Array.from(full.now.hi.slice(0, cut)));
  });
});
