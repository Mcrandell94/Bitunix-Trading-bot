import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { IDEA_RULE, buildIdea, replayIdeas, type Idea, type IdeaCandidate } from '../src/screen/entryideas';
import { dinapoli, type DnSetup } from '../src/screen/dinapoli';
import { ETH_CARD, dinapoliReport, displayLevels, dnAfterClose, dnEvents, dnView, ethCard, ethCardText, ethEvents, kamaReport, outlookReport, outlookSplits, px, templateReport, wyckoffCoverage } from '../src/screen/ethreport';
import { FIBCL } from '../src/screen/fibclusters';
import { fvgActive, fvgStrong } from '../src/screen/fvgob';
import { SRZ } from '../src/screen/srzones';
import { OUTLOOK_METRICS, outlookAt } from '../src/screen/outlook';
import { lastClosed } from '../src/screen/scalp2';
import { type ObZone } from '../src/screen/shaakuni';
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
  return { m15, h1: up(H), h4: up(H4), d1: up(DAY) };
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
  const { m15, h1, h4, d1 } = market(420, 9), now = h4.at(-1)!.openTime + H4;
  const btcD1 = d1.map((b, k) => ({ ...b, open: b.open * 20, high: b.high * 20, low: b.low * 20, close: b.close * 20 * (1 + Math.sin(k / 9) * 0.01) }));
  const fundingHistory = Array.from({ length: 420 * 3 }, (_, k) => ({ time: d1[0]!.openTime + (k + 1) * 8 * 3_600_000, rate: 0.0001 * Math.sin(k / 30) }));
  const built = ethCard({ m15, h4, d1, funding: { rate: 0.0001, intervalHours: 8 }, now, otherD1: btcD1, fundingHistory, h1 });

  test('one card per timeframe: each fits Telegram, KAMA section with the label first; no entry ideas, Fib section or small print', () => {
    const c4 = ethCardText(built.card, '4H'), c1 = ethCardText(built.card, '1D');
    for (const m of [...c4, ...c1]) expect(m.length).toBeLessThanOrEqual(4096);
    const t4 = c4.join('\n'), t1 = c1.join('\n'), text = `${t4}\n${t1}`;
    expect(t4).toContain('📊 <b>ETHUSDT</b> · 4H card');
    expect(t1).toContain('📊 <b>ETHUSDT</b> · 1D card');
    for (const [t, tf] of [[t4, '4H'], [t1, '1D']] as const) {
      expect(t).toContain(`<b>KAMA signal ${tf}</b> (daily HA vs EMA 20 of KAMA) · ${ETH_CARD.label}`);
      expect(t.indexOf('KAMA signal')).toBeLessThan(t.indexOf('<b>Chop Zone</b>'));
      for (const k of ['<b>Outlook</b>', 'Chop Zone', 'RSI 14 / MACD 12/26/9', 'Levels', 'Trend ribbon', '<b>S/R zones</b>', '<b>FVG</b>', '<b>Range targets</b>']) expect(t).toContain(k);
      expect(t).not.toContain('Record'); // record stats are preview-only (owner)
    }
    // 4H-only and 1D-only lines.
    for (const k of ['<b>EMA trigger</b>', 'Daily bias: ', 'Session: ', 'Funding ']) { expect(t4).toContain(k); expect(t1).not.toContain(k); }
    for (const k of ['<b>EMA stack</b>', 'Bias: ', 'Short confirmation', ' BTC 1D ', ' Weekly (week of ']) { expect(t1).toContain(k); expect(t4).not.toContain(k); }
    for (const k of ['Entry ideas', 'Swing Fib arcs', 'weaker not shown', 'weekend:', 'idea only', 'Trinity', 'Fib clusters']) expect(text).not.toContain(k); // Trinity and Fib clusters removed (owner, after round 4)
    for (const z of built.card.tf['4H'].zones) expect(z.s.strong).toBe(true);
    for (const z of built.card.tf['1D'].zones) if (!z.s.strong) expect(t1).toContain(`POI (weak) ${px(z.z.bottom)}`);
    for (const t of ['4H', '1D'] as const) for (const { s } of built.card.tf[t].trinity.levels) expect(s.strength).toBeGreaterThanOrEqual(ZONE_RULE.trinityStrength);
    expect(text).toContain(`week before: high ${px(built.card.levels.pwh2)} · low ${px(built.card.levels.pwl2)}`);
  });

  test('display tags: a Trinity level or zone on a shown level (the week before included) names it', () => {
    const L = { ...built.card.levels, pwh2: 2778.5 };
    expect(displayLevels(L).find((x) => x.label === 'week-before high')!.price).toBe(2778.5);
    expect(confluence({ top: 2778.5, bottom: 2778.5 }, 20, displayLevels(L))).toContain('week-before high');
    expect(confluence({ top: 2790, bottom: 2790 }, 20, displayLevels(L))).not.toContain('week-before high'); // 11.5 > 0.25 ATR
  });

  test('KAMA: a BUY in 4H Chop Zone yellow is held off, sells never; held-off entries never in the record', () => {
    let held = 0, taken = 0;
    for (const tf of ['4H', '1D'] as const) {
      const k = built.kama[tf], S = tf === '4H' ? built.d4 : built.dd;
      expect(k.sigs.length).toBeGreaterThan(0);
      for (const s of k.sigs) {
        const k4 = lastClosed(h4, H4, S.c[s.i]!.openTime + S.ms);
        expect(s.chop).toBe(built.d4.cz.color[k4] ?? null);
        expect(s.heldOff).toBe(s.dir > 0 && s.chop === 'yellow');
        if (s.heldOff) held++; else taken++;
      }
      const heldI = new Set(k.sigs.filter((s) => s.heldOff).map((s) => s.i));
      expect(k.record.every((t) => !heldI.has(t.i))).toBe(true);
      expect(k.unfiltered).toHaveLength(k.sigs.length);
      // Exits are not filtered: each closed trade ends on the next opposite cross, held off or not.
      for (const t of k.record.filter((r) => r.exitAt >= 0)) expect(k.sigs.find((s) => s.i > t.i && s.dir !== t.dir)!.i).toBe(t.exitAt);
    }
    expect(taken).toBeGreaterThan(0);
    expect(kamaReport(built).join('\n')).toContain('every cross (no filter)');
  });

  test('KAMA notes: supports on the signal side, the next level on the other side, a fixed factor list', () => {
    for (const tf of ['4H', '1D'] as const) for (const s of built.kama[tf].sigs) {
      for (const l of s.note.support) expect(s.dir * (s.price - l.price)).toBeGreaterThanOrEqual(0);
      if (s.note.next) expect(s.dir * (s.note.next.price - s.price)).toBeGreaterThan(0); // a zone around the price is never "next"
      for (const l of s.note.support) expect(l.label).not.toContain('Trinity');
      expect(s.note.support.length).toBeLessThanOrEqual(ETH_CARD.supports);
      expect(s.note.factors.map((f) => f.name).slice(0, 4)).toEqual([`ribbon ${tf}`, `ribbon ${tf === '4H' ? '1D' : '4H'}`, 'MACD', 'RSI']);
    }
  });

  test('alerts: KAMA signals carry the label, held-off crosses are never a signal; weak 4H zones never alert; keys unique', () => {
    const evs = ethEvents(built, h4[h4.length - 600]!.openTime);
    expect(evs.length).toBeGreaterThan(20);
    for (const e of evs) {
      if (e.kind === 'kama') expect(e.text).toContain(ETH_CARD.label);
      if (e.kind === 'ob' && e.tf === '4H') expect(e.text).toContain('new strong');
      if (e.kind === 'ob' && e.tf === '1D') expect(e.text).toMatch(/new (strong|weak)/);
      expect(e.kind.startsWith('idea')).toBe(false);
    }
    for (const tf of ['4H', '1D'] as const) {
      const S = tf === '4H' ? built.d4 : built.dd;
      for (const s of built.kama[tf].sigs.filter((x) => x.heldOff)) expect(evs.some((e) => e.kind === 'kama' && e.tf === tf && e.t === S.c[s.i]!.openTime + S.ms)).toBe(false);
    }
    const weakNew = built.d4.obs.filter((z) => !built.d4.obStr.get(z)!.strong).map((z) => `4H|ob|${h4[z.createdAt]!.openTime + H4}|${z.createdAt}`);
    for (const k of weakNew) expect(evs.some((e) => e.key === k)).toBe(false);
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
  });

  test('no look-ahead: the KAMA crosses, chop calls and notes up to a cut are the same from the bars up to it', () => {
    const cutT = h4[1800]!.openTime + H4, cut = ethCard({ m15: m15.filter((b) => b.openTime + 15 * 60_000 <= cutT), h4: h4.filter((b) => b.openTime + H4 <= cutT), d1: d1.filter((b) => b.openTime + DAY <= cutT), funding: null, now: cutT, otherD1: btcD1.filter((b) => b.openTime + DAY <= cutT), fundingHistory: fundingHistory.filter((f) => f.time <= cutT) });
    let compared = 0;
    for (const tf of ['4H', '1D'] as const) {
      const S = tf === '4H' ? cut.d4 : cut.dd, full = built.kama[tf].sigs.filter((s) => s.i < S.c.length);
      expect(cut.kama[tf].sigs).toEqual(full);
      compared += full.length;
    }
    expect(compared).toBeGreaterThan(0);
  });

  test('Outlook: the four lines are on the card; each metric splits the filtered record into agree / disagree / n/a', () => {
    const text = [...ethCardText(built.card, '4H'), ...ethCardText(built.card, '1D')].join('\n');
    expect(text).toContain('<b>Outlook</b>');
    for (const k of [' BTC 1D ', ' Weekly (week of ', ' Volatility BB width ', ' the 20-bar avg', 'Funding 7d avg ']) expect(text).toContain(k);
    expect(text.indexOf('<b>Outlook</b>')).toBeLessThan(text.indexOf('<b>Chop Zone</b>'));
    const sp = outlookSplits(built);
    for (const tf of ['4H', '1D'] as const) for (const m of OUTLOOK_METRICS) {
      const g = sp[tf][m];
      expect(g.agree.length + g.disagree.length + g.na).toBe(built.kama[tf].record.length);
    }
    expect(outlookReport(built).join('\n')).toContain('BTC ribbon');
    // No look-ahead: the values at a past close are the same from the data up to it.
    const t = h4[1500]!.openTime + H4, cut = ethCard({ m15: m15.filter((b) => b.openTime + 15 * 60_000 <= t), h4: h4.filter((b) => b.openTime + H4 <= t), d1: d1.filter((b) => b.openTime + DAY <= t), funding: null, now: t, otherD1: btcD1.filter((b) => b.openTime + DAY <= t), fundingHistory: fundingHistory.filter((f) => f.time <= t) });
    expect(cut.card.outlook.at).toEqual(outlookAt(built.outlook, t));
  });

  test('round 4: the ETH card lists "BTC ribbon (on watch)"; a BTC card builds with its own stack and no such factor', () => {
    for (const sg of built.kama['4H'].sigs.slice(-20)) expect(sg.note.factors.map((f) => f.name)).toContain('BTC ribbon (on watch)');
    const btc = ethCard({ symbol: 'BTCUSDT', m15: m15.map((b) => ({ ...b, open: b.open * 20, high: b.high * 20, low: b.low * 20, close: b.close * 20 })), h4: h4.map((b) => ({ ...b, open: b.open * 20, high: b.high * 20, low: b.low * 20, close: b.close * 20 })), d1: btcD1, funding: null, now, otherD1: d1, fundingHistory });
    const text = [...ethCardText(btc.card, '4H'), ...ethCardText(btc.card, '1D')].join('\n');
    expect(text).toContain('<b>BTCUSDT</b>');
    expect(text).toContain('slow: ');
    expect(text).toMatch(/Short check (n\/a|\d\/3)/);
    expect(text).toContain(' ETH 1D ');
    for (const sg of btc.kama['4H'].sigs) expect(sg.note.factors.map((f) => f.name)).not.toContain('BTC ribbon (on watch)');
    const evs = ethEvents(btc, h4[h4.length - 600]!.openTime);
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
    expect(evs.every((e) => e.text.includes('BTCUSDT'))).toBe(true);
  });

  test('round 4 templates: strong items only on the card, alerts only for strong items, the records report', () => {
    const msgs = [...ethCardText(built.card, '4H'), ...ethCardText(built.card, '1D')], text = msgs.join('\n');
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    for (const k of ['<b>S/R zones</b>', '<b>FVG</b>', '<b>Range targets</b>']) expect(text).toContain(k);
    for (const t of ['4H', '1D'] as const) {
      const v = built.card.tf[t], S = t === '4H' ? built.d4 : built.dd, i = S.c.length - 1;
      for (const z of [v.sr.above, v.sr.below]) if (z) expect(z.score).toBeGreaterThanOrEqual(SRZ.strongScore);
      for (const g of [v.fvg.above, v.fvg.below]) if (g) { expect(fvgStrong(g)).toBe(true); expect(fvgActive(g, i)).toBe(true); }
      for (const { k } of v.iob) expect(k.str.strong).toBe(true);
      expect(v.fib).toBeNull(); // Fib clusters off the card
    }
    expect(FIBCL.strong).toBe(4);
    const evs = ethEvents(built, h4[0]!.openTime + 400 * H4);
    expect(evs.some((e) => /^(fvg|range-)/.test(e.kind))).toBe(true);
    expect(evs.some((e) => /^(trinity|fib-)/.test(e.kind))).toBe(false);
    for (const e of evs) if (/^(sr-|fvg)/.test(e.kind)) expect(e.text).toContain('strong');
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
    const rep = templateReport(built).join('\n');
    for (const k of ['S/R rejection off a strong zone', 'strong FVG first touch', 'range breakout', 'range targets', 'some rows will look good by chance']) expect(rep).toContain(k);
  });

  test('DiNapoli: the 4H card shows the 4H setup, the 1D card the 1D one, with the label; 1H only as new-setup alerts', () => {
    const t4 = ethCardText(built.card, '4H').join('\n'), t1 = ethCardText(built.card, '1D').join('\n');
    for (const t of [t4, t1]) expect(t).toContain(`<b>DiNapoli</b> (MarkitTick; entry node, stop, COP / OP / XOP) · ${ETH_CARD.label}`);
    expect(t4).toMatch(/\n 4H (🟢 BULL|🔴 BEAR|no setup yet|no open setup)/);
    expect(t1).toMatch(/\n 1D (🟢 BULL|🔴 BEAR|no setup yet|no open setup)/);
    for (const t of [t4, t1]) expect(t).not.toContain('(closed)');
    for (const t of [t4, t1]) expect(t).not.toMatch(/\n 1H /);
    expect(built.h1.dn.setups.length).toBeGreaterThan(0);
    const evs = ethEvents(built, h4[h4.length - 300]!.openTime);
    const h1e = evs.filter((e) => e.tf === '1H');
    expect(h1e.length).toBeGreaterThan(0);
    expect(h1e.every((e) => e.kind === 'dn-setup' && (e.t - h4[0]!.openTime) % H === 0)).toBe(true); // new setups only
    const fresh = built.h1.dn.setups.filter((x, n, all) => n === 0 || !(all[n - 1]!.dir === x.dir && all[n - 1]!.a === x.a && all[n - 1]!.b === x.b));
    const h1Setups = fresh.filter((x) => h1[x.i]!.openTime + H > h4[h4.length - 300]!.openTime);
    expect(h1e).toHaveLength(h1Setups.length);
    for (const e of evs) if (e.kind === 'dn-setup') expect(e.text).toContain(ETH_CARD.label);
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
    expect(dinapoliReport(built).join('\n')).toContain('as a trade (signal close -> stop / OP / next setup)');
  });

  test('a closed DiNapoli setup leaves the card until a new one; its re-presentation sends no target / stop alerts', () => {
    // Bull A (bar 10) - B (bar 20) - C (bar 27); flat highs after C (no pivot high), the stop is hit, C moves lower
    // (bar 39) and the same A-B swing is re-presented at bar 44; then price runs through its COP.
    const k4 = (k: number) => Date.UTC(2025, 0, 6) + k * H4, cl: number[] = [];
    for (let k = 0; k <= 10; k++) cl.push(110 - 2 * k);
    for (let k = 11; k <= 20; k++) cl.push(90 + 3 * (k - 10));
    for (let k = 21; k <= 27; k++) cl.push(120 + ((105.2 - 120) * (k - 20)) / 7);
    const c: Candle[] = cl.map((x, k) => { const o = k ? cl[k - 1]! : x; return bar(k4(k), o, Math.max(o, x) + 0.2, Math.min(o, x) - 0.2, x); });
    const add = (x: number, hi?: number) => { const o = c.at(-1)!.close; c.push(bar(k4(c.length), o, hi ?? Math.max(o, x) + 0.2, Math.min(o, x) - 0.2, x)); };
    for (let k = 1; k <= 5; k++) add(105.2 + 0.8 * k, 109.5);
    for (const x of [108, 106, 104, 102, 100.5, 99.5, 99]) add(x);
    for (let k = 1; k <= 5; k++) add(99 + 0.8 * k);
    for (let k = 1; k <= 10; k++) add(103 + 2 * k);
    const S = dinapoli(c), [s1, s2] = S.setups;
    expect(S.setups).toHaveLength(2);
    expect([s1!.i, s1!.stopAt >= 0, s2!.i, s2!.a === s1!.a && s2!.b === s1!.b, s2!.copAt > s2!.i, s2!.stopAt]).toEqual([32, true, 44, true, true, -1]);
    expect(dnAfterClose(S)).toEqual([false, true]);
    const v = dnView('4H', c, S)!;
    expect([v.at!.s, v.open]).toEqual([s2, false]);
    const t4 = ethCardText({ ...built.card, dn: { ...built.card.dn, '4H': v } }, '4H').join('\n');
    expect(t4).toContain('\n 4H no open setup (waiting for a new one)');
    const kinds = (i: number) => { const out: string[] = []; dnEvents(c, S, i, '4H', 'ETHUSDT', (kind) => out.push(kind)); return out; };
    expect(kinds(s1!.stopAt)).toContain('dn-stop'); // the closing alert still goes out
    for (let i = s1!.stopAt + 1; i < c.length; i++) expect(kinds(i)).toEqual([]); // the re-presentation: no setup, COP or stop alerts
    // Before the stop the first setup is open and shown.
    const before = dnView('4H', c.slice(0, s1!.stopAt), dinapoli(c.slice(0, s1!.stopAt)))!;
    expect(before.open).toBe(true);
    expect(ethCardText({ ...built.card, dn: { ...built.card.dn, '4H': before } }, '4H').join('\n')).toMatch(/\n 4H 🟢 BULL .* entry F38\.2 /);
  });

  test('dnAfterClose: a re-presentation of a closed setup is excluded; a new A-B swing shows again', () => {
    const s = (a: number, b: number, closed: boolean, dir: 1 | -1 = 1) => ({ a, b, dir, stopAt: closed ? 5 : -1, xopAt: -1 }) as unknown as DnSetup;
    const S = (xs: DnSetup[]) => ({ atr: [], setups: xs });
    expect(dnAfterClose(S([s(1, 2, true), s(1, 2, false), s(1, 2, false), s(1, 3, false), s(1, 3, false)]))).toEqual([false, true, true, false, false]);
    expect(dnAfterClose(S([s(1, 2, false), s(1, 2, true), s(1, 2, false), s(1, 2, false, -1)]))).toEqual([false, false, true, false]);
  });

  test('a closed trend ribbon trade (SL or T4) leaves the card until the next flip; no stop alert after T4', () => {
    const v = built.card.tf['4H'], p = v.ribbon.pos!;
    const card = (closed: boolean) => ethCardText({ ...built.card, tf: { ...built.card.tf, '4H': { ...v, ribbon: { ...v.ribbon, trend: p.dir, closed } } } }, '4H').join('\n');
    expect(card(false)).toContain(`    Entry ${px(p.entry)} · SL ${px(p.stop)} · T1 `);
    expect(card(true)).toContain(' · no open trade until the next flip');
    expect(card(true)).not.toContain('    Entry ');
    // Alerts: a position that reached T4 and was later stopped sends no stop alert; one stopped before T4 does.
    const n = built.d4.c.length, mk = (i: number, t4: boolean) => ({ dir: 1 as const, i, entry: 100, stop: 90, risk: 10, targets: [1, 2, 3, 4].map((k) => ({ price: 100 + 10 * k, hitAt: k < 4 || t4 ? i + k : -1 })), endAt: i + 6, how: 'stop' as const });
    const b2 = { ...built, d4: { ...built.d4, rib: { ...built.d4.rib, positions: [mk(n - 30, true), mk(n - 15, false)] } } };
    const rs = ethEvents(b2, built.d4.c[n - 31]!.openTime).filter((e) => e.tf === '4H' && e.kind.startsWith('ribbon-'));
    expect(rs.filter((e) => e.kind === 'ribbon-target')).toHaveLength(7);
    expect(rs.filter((e) => e.kind === 'ribbon-stop').map((e) => e.t)).toEqual([built.d4.c[n - 9]!.openTime + H4]);
  });

  test('Wyckoff coverage counts the closes with a Phase B+ structure, own and with the override', () => {
    const w = wyckoffCoverage(built.d4, built.ctx.wy['4H'], h4[0]!.openTime);
    expect(w.closes).toBe(h4.length);
    expect(w.withOverride).toBeGreaterThanOrEqual(0);
    expect(Object.values(w.byTf).reduce((a, b) => a + b, 0)).toBe(w.withOverride);
  });
});
