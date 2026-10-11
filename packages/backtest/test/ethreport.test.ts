import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { IDEA_RULE, buildIdea, replayIdeas, type Idea, type IdeaCandidate } from '../src/screen/entryideas';
import { ETH_CARD, displayLevels, ethCard, ethCardText, ethEvents, ideaAt, ideaCandidates, keyLevels, px, tfData } from '../src/screen/ethreport';
import { chopState } from '../src/screen/chop';
import { lastClosed } from '../src/screen/scalp2';
import { shaakuniLevelSeries, type ObZone } from '../src/screen/shaakuni';
import { confluence, obStrength, pickZones, ZONE_RULE } from '../src/screen/zonestrength';

const Q = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });

/** 15m random walk with regimes and volume spikes, and its 4H / 1D bars. */
function market(days: number, seed = 5) {
  let s = seed >>> 0, p = 2500;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const m15: Candle[] = [];
  for (let i = 0; i < days * 96; i++) {
    const ret = Math.sin(i / 700) * 0.0004 + (r() < 0.004 ? (r() < 0.5 ? -1 : 1) * 0.01 : 0) + (r() - 0.5) * 0.004, o = p, c = o * (1 + ret);
    p = c;
    m15.push(bar(Date.UTC(2025, 0, 6) + i * Q, o, Math.max(o, c) * (1 + 0.001 * r()), Math.min(o, c) * (1 - 0.001 * r()), c, 1e6 * (1 + r()) * (r() < 0.01 ? 6 : 1)));
  }
  const up = (ms: number) => {
    const out: Candle[] = [];
    for (const x of m15) { const t = Math.floor(x.openTime / ms) * ms, l = out.at(-1); if (l && l.openTime === t) { l.high = Math.max(l.high, x.high); l.low = Math.min(l.low, x.low); l.close = x.close; l.volume! += x.volume!; } else out.push({ ...x, openTime: t }); }
    return out;
  };
  return { m15, h4: up(H4), d1: up(DAY) };
}

describe('zone strength filter', () => {
  test('strong = impulse >= 1 ATR and volume >= 1.5x the 20 bars before', () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * H4, 100, 101, 99, 100, 1000));
    c.push(bar(30 * H4, 100, 103, 99.9, 102.6, 1600)); // body 2.6, volume 1.6x
    const z = (atr: number): ObZone => ({ side: 1, top: 101, bottom: 99, obBar: 29, createdAt: 31, impulseBar: 30, atr, mitigatedAt: -1, droppedAt: -1 });
    const vol = c.map((b) => b.volume!);
    expect(obStrength(c, z(2), vol)).toMatchObject({ strong: true });
    expect(obStrength(c, z(2), vol).impulseAtr).toBeCloseTo(1.3, 9);
    expect(obStrength(c, z(2), vol).volumeMult).toBeCloseTo(1.6, 9);
    expect(obStrength(c, z(3), vol).strong).toBe(false); // 0.87 ATR
    c[30] = { ...c[30]!, volume: 1400 };
    expect(obStrength(c, z(2), c.map((b) => b.volume!)).strong).toBe(false); // 1.4x
  });

  test('at most 2 strong zones per side, nearest first; the rest only counted', () => {
    const mk = (side: 1 | -1, bottom: number, strong: boolean) => ({ side, top: bottom + 1, bottom, strong });
    const zs = [mk(1, 90, true), mk(1, 95, true), mk(1, 80, true), mk(1, 97, false), mk(-1, 105, true), mk(-1, 120, false)];
    const p = pickZones(zs, (z) => z.strong, 100);
    expect(p.shown.map((z) => z.bottom)).toEqual([95, 90, 105]);
    expect(p.hidden).toBe(3);
    expect(ZONE_RULE.perSide).toBe(2);
  });
});

describe('entry ideas', () => {
  const cand = (src: IdeaCandidate['src'], entry: number, stop: number): IdeaCandidate => ({ src, id: `${src}:${entry}`, entry, stop, label: src });
  const levels = [{ price: 112, label: 'PDH' }, { price: 108, label: 'D-EQ' }, { price: 108.05, label: 'ribbon T1' }, { price: 120, label: 'PWH' }];

  test('2+ sources within 1 ATR: zone, farthest stop, targets with R (>= 0.25R away, close ones merged), T1 >= 1.5R', () => {
    const idea = buildIdea(1, 104, 2, [cand('order block', 101, 99), cand('ribbon', 102, 98.5), cand('trinity', 110, 108)], levels, false)!;
    expect(idea).toMatchObject({ side: 1, zoneLo: 101, zoneHi: 102, entry: 102, stop: 98.5, paused: false });
    expect(idea.sources.map((s) => s.src).sort()).toEqual(['order block', 'ribbon']);
    expect(idea.targets.map((t) => [t.price, t.label])).toEqual([[108, 'D-EQ / ribbon T1'], [112, 'PDH'], [120, 'PWH']]);
    expect(idea.targets[0]!.r).toBeCloseTo(6 / 3.5, 9);
    expect(idea.inTheWay).toEqual([]);
    // A level under 1.5R is not T1: it is listed as in the way (owner 2026-10-11).
    const blocked = buildIdea(1, 104, 2, [cand('order block', 101, 99), cand('ribbon', 102, 98.5)], [{ price: 104, label: 'D-EQ' }, { price: 110, label: 'PDH' }], false)!;
    expect(blocked.targets.map((t) => t.label)).toEqual(['PDH']);
    expect(blocked.inTheWay.map((t) => [t.label, +t.r.toFixed(3)])).toEqual([['D-EQ', +(2 / 3.5).toFixed(3)]]);
    expect(buildIdea(1, 104, 2, [cand('order block', 101, 99)], levels, false)).toBeNull(); // one source
    expect(buildIdea(1, 104, 2, [cand('order block', 101, 99), cand('order block', 101.5, 99)], levels, false)).toBeNull(); // same source twice
    expect(buildIdea(1, 104, 2, [cand('order block', 101, 99), cand('ribbon', 102, 98.5)], [{ price: 104, label: 'X' }], false)).toBeNull(); // no level 1.5R away
    expect(buildIdea(1, 104, 2, [cand('order block', 101, 99), cand('ribbon', 102, 98.5)], levels, true)!.paused).toBe(true);
    const short = buildIdea(-1, 96, 2, [cand('order block', 99, 101), cand('trinity', 98.5, 100.5)], [{ price: 90, label: 'PDL' }], false)!;
    expect(short).toMatchObject({ side: -1, zoneLo: 98.5, zoneHi: 99, entry: 98.5, stop: 101 });
  });

  test('replay: a fill at the entry, then T1 or the stop (stop first on a tie), costs in; no fill in 30 bars', () => {
    const idea: Idea = { side: 1, zoneLo: 100, zoneHi: 100, entry: 100, stop: 95, targets: [{ price: 110, label: 'T', r: 2 }], inTheWay: [], sources: [], key: 'a', paused: false };
    const c = [{ open: 104, high: 105, low: 103, close: 104 }, { open: 104, high: 104, low: 99.5, close: 101 }, { open: 101, high: 111, low: 100, close: 110 }];
    const win = replayIdeas(c, [idea, idea, idea])[0]!;
    expect(win).toMatchObject({ filled: true, how: 'target' });
    expect(win.r).toBeCloseTo(2 - (IDEA_RULE.cost * 100) / 5, 9);
    const both = [{ open: 104, high: 105, low: 103, close: 104 }, { open: 104, high: 104, low: 99.5, close: 101 }, { open: 101, high: 111, low: 94, close: 100 }];
    expect(replayIdeas(both, [idea, null, null])[0]!.how).toBe('stop');
    const never = Array.from({ length: 40 }, () => ({ open: 104, high: 105, low: 103, close: 104 }));
    expect(replayIdeas(never, [idea])[0]).toMatchObject({ filled: false, how: 'no fill' });
    expect(replayIdeas(c, [{ ...idea, paused: true }, null, null])).toEqual([]);
  });
});

describe('the ETH card', () => {
  const { m15, h4, d1 } = market(420, 9), now = h4.at(-1)!.openTime + H4;
  const built = ethCard({ m15, h4, d1, funding: { rate: 0.0001, intervalHours: 8 }, now });

  test('fits Telegram (split if needed), shows the risk label with the ideas; 4H zones only when strong, 1D strong or weak (marked)', () => {
    const msgs = ethCardText(built.card);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    const text = msgs.join('\n');
    expect(text).toContain(`<b>Entry ideas</b> · ${ETH_CARD.label}`);
    for (const k of ['Chop', 'RSI 14 / MACD 12/26/9', 'Levels', 'Wyckoff', 'Trend ribbon', 'Trinity reversal', 'Swing Fib arcs']) expect(text).toContain(k);
    for (const z of built.card.tf['4H'].zones) expect(z.s.strong).toBe(true);
    for (const z of built.card.tf['1D'].zones) if (!z.s.strong) expect(text).toContain(`POI (weak) ${z.z.bottom.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
    for (const t of ['4H', '1D'] as const) for (const { s } of built.card.tf[t].trinity.levels) expect(s.strength).toBeGreaterThanOrEqual(ZONE_RULE.trinityStrength);
    expect(text).toContain(`week before: high ${px(built.card.levels.pwh2)} · low ${px(built.card.levels.pwl2)}`);
  });

  test('display tags: a Trinity level or zone on a shown level (the week before included) names it', () => {
    const L = { ...built.card.levels, pwh2: 2778.5 };
    expect(displayLevels(L).find((x) => x.label === 'week-before high')!.price).toBe(2778.5);
    expect(confluence({ top: 2778.5, bottom: 2778.5 }, 20, displayLevels(L))).toContain('week-before high');
    expect(confluence({ top: 2790, bottom: 2790 }, 20, displayLevels(L))).not.toContain('week-before high'); // 11.5 > 0.25 ATR
  });

  test('alerts: each idea alert carries the label; weak 4H zones never alert, 1D ones say whether they are weak', () => {
    const evs = ethEvents(built.d4, built.dd, built.series, shaakuniLevelSeries(h4), h4[300]!.openTime);
    expect(evs.length).toBeGreaterThan(20);
    for (const e of evs) {
      if (e.kind.startsWith('idea-')) expect(e.text).toContain('manage your own risk');
      if (e.kind === 'ob' && e.tf === '4H') expect(e.text).toContain('new strong');
      if (e.kind === 'ob' && e.tf === '1D') expect(e.text).toMatch(/new (strong|weak)/);
    }
    const weakNew = built.d4.obs.filter((z) => !built.d4.obStr.get(z)!.strong).map((z) => `4H|ob|${h4[z.createdAt]!.openTime + H4}|${z.createdAt}`);
    for (const k of weakNew) expect(evs.some((e) => e.key === k)).toBe(false);
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
  });

  test('no look-ahead: an idea at bar i is the same from the bars up to i', () => {
    const lv = shaakuniLevelSeries(h4);
    let compared = 0;
    for (const i of [400, 900, 1500, h4.length - 2]) {
      const t = h4[i]!.openTime + H4, cut = h4.slice(0, i + 1), S = tfData(cut, '4H');
      const k4 = lastClosed(h4, H4, t), levels = keyLevels(lv[k4]!), ch = chopState(built.d4.chop, k4);
      for (const side of [1, -1] as const) {
        const full = side > 0 ? built.series['4H'].long[i] : built.series['4H'].short[i];
        expect(ideaAt(S, i, side, levels, ch)).toEqual(full ?? null);
        const cands = ideaCandidates(built.d4, i, side, levels);
        expect(ideaCandidates(S, i, side, levels)).toEqual(cands);
        compared += cands.length;
      }
    }
    expect(compared).toBeGreaterThan(0); // the candidates (the ribbon's at least) exist on some of these bars
  });
});
