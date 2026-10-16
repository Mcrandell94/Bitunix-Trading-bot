import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { aiInput, coinCard, coinCardText, coinChartCheck, coinEvents, nearestGroups, pois, SCRIPT_COUNT, SCRIPT_OF, type Fam, type Piece } from '../src/screen/coincard';

const Q = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });

/** 15m random walk with regimes and volume spikes, and its 1H / 4H / 1D bars. */
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

describe('confluence groups', () => {
  test('the nearest piece above / below and what overlaps it; a piece holding the price apart', () => {
    const p = (lo: number, hi: number, src: string, tf: Piece['tf'] = 'D'): Piece => ({ lo, hi, tf, src });
    const pieces = [p(110, 112, 'MM'), p(111.5, 113, 'Lux', '4H'), p(120, 121, 'MM'), p(95, 97, 'Lux'), p(90, 91, 'MM'), p(99, 101, 'MM', 'W')];
    const g = nearestGroups(pieces, 100, 0.1);
    expect([g.above!.lo, g.above!.hi, g.above!.pieces.map((x) => x.src)]).toEqual([110, 113, ['MM', 'Lux']]);
    expect([g.below!.lo, g.below!.hi, g.below!.pieces.length]).toEqual([95, 97, 1]);
    expect(g.inside!.pieces.map((x) => x.tf)).toEqual(['W']);
    expect(nearestGroups([p(100.5, 100.5, 'CP'), p(100.8, 100.8, 'Opt'), p(102, 102, 'Smart')], 100, 0.4).above!.pieces.map((x) => x.src)).toEqual(['CP', 'Opt']);
  });

  test('not chained, and zones keep the nearest piece\'s edges: one wide zone cannot stretch a group', () => {
    const p = (lo: number, hi: number, src: string): Piece => ({ lo, hi, tf: 'D', src });
    const g = nearestGroups([p(110, 112, 'MM'), p(111.5, 113, 'Lux'), p(112.9, 130, 'FVG'), p(99, 101, 'MM'), p(80, 125, 'IFVG')], 100, 0.1, false);
    expect([g.above!.lo, g.above!.hi, g.above!.pieces.map((x) => x.src)]).toEqual([110, 112, ['MM', 'Lux']]);
    expect([g.inside!.lo, g.inside!.hi, g.inside!.pieces.map((x) => x.src)]).toEqual([99, 101, ['MM', 'IFVG']]);
  });
});

describe('the POI ladder', () => {
  test('zones on their own side, 2+ families, wide zones only as confluence, no overlap, nearest first', () => {
    const z = (fam: Fam, lo: number, hi: number, tf: Piece['tf'], note?: string) => ({ fam, p: { lo, hi, tf, src: fam, note } as Piece });
    const all = [
      z('OB', 110, 112, 'D', 'bear'), z('FVG', 111, 113, '4H', 'bear'), z('S/R', 112.2, 112.2, 'D'), // a short POI, 3 families
      z('OB', 105, 106, '4H', 'bull'), z('Fib', 105.5, 105.5, 'D'), // a bull OB over the price is no short POI: the level is alone
      z('OB', 95, 97, 'D', 'bull'), z('Liq', 96.5, 96.8, '4H'), z('FVG', 80, 98, 'W', 'bull'), // a long POI: the OB's range
      z('FVG', 101, 102, '4H', 'bull'), // a bull gap over the price: not a short POI
      z('S/R', 60, 60, 'D'), z('Fib', 60.1, 60.1, 'D'), // too far
    ];
    const r = pois(all, 100, { tolLevel: 0.4, tolZone: 0.1, maxDist: 20, maxWidth: 5, minFams: 2, n: 3 });
    expect(r.short.map((x) => [x.lo, x.hi, x.fams, x.tfs, x.sources])).toEqual([[110, 112, ['OB', 'FVG', 'S/R'], ['D', '4H'], 3]]);
    expect(r.long.map((x) => [x.lo, x.hi, x.fams, x.tfs])).toEqual([[95, 97, ['OB', 'FVG', 'Liq'], ['W', 'D', '4H']]]);
    expect(pois(all, 100, { tolLevel: 0.4, tolZone: 0.1, maxDist: 20, maxWidth: 5, minFams: 4, n: 3 })).toEqual({ short: [], long: [] });
  });
});

describe('the POI ladder counts scripts (cards v3)', () => {
  test('one script counts once whatever it gives; the most scripts ranks first; under 3 scripts is never a POI', () => {
    const z = (fam: Fam, lo: number, hi: number, src: string, tf: Piece['tf'] = 'D', note?: string) => ({ fam, p: { lo, hi, tf, src, note } as Piece });
    const all = [
      // Above: HTF FVG + IFVG are one script, the detector's FVG and block one more: 2 scripts, 2 families.
      z('FVG', 110, 111, 'FVG', 'D', 'bear'), z('FVG', 110.2, 110.8, 'IFVG', '4H', 'bear'), z('OB', 110.1, 110.9, 'IOB', 'D', 'bear'), z('FVG', 110.3, 110.7, 'strong', 'W', 'bear'),
      // Higher: 4 scripts over 2 families.
      z('S/R', 115, 115, 'CP'), z('S/R', 115.2, 115.2, 'Opt'), z('Lvl', 115.1, 115.1, 'Shaakuni', 'W', 'PWH'), z('Lvl', 114.9, 114.9, 'EMA', 'D', 'EMA 26'),
      // Higher still: 3 scripts over 4 families (the detector gives the block and the gap).
      z('OB', 118, 119, 'IOB', 'D', 'bear'), z('FVG', 118.2, 118.8, 'strong', '4H', 'bear'), z('Fib', 118.5, 118.5, 'Auto'), z('Liq', 118.6, 118.6, 'EQ', '4H', 'EQH'),
    ];
    const r = pois(all, 100, { tolLevel: 0.4, tolZone: 0.1, maxDist: 30, maxWidth: 5, minFams: 2, minScripts: 3, n: 3 });
    expect(r.short.map((x) => [x.lo, x.scripts, x.fams.length])).toEqual([[115, 4, 2], [118, 3, 4]]); // nearest first; 110-111 has 2 scripts
    const one = pois(all, 100, { tolLevel: 0.4, tolZone: 0.1, maxDist: 30, maxWidth: 5, minFams: 2, minScripts: 3, n: 1 });
    expect(one.short.map((x) => x.lo)).toEqual([115]); // 4 scripts beat 4 families
    expect(SCRIPT_OF.FVG).toBe(SCRIPT_OF.IFVG);
    expect(SCRIPT_OF.SMC).toBe(SCRIPT_OF.EQ);
    expect(SCRIPT_COUNT).toBe(28);
  });
});

describe('the W / D / 4H card', () => {
  const mk = (sym: 'ETHUSDT' | 'BTCUSDT', seed: number, p0: number) => {
    const { m15, h1, h4, d1 } = market(900, seed, p0), now = h4.at(-1)!.openTime + H4;
    return { now, built: coinCard({ symbol: sym, m15, h1: h1.filter((b) => b.openTime >= now - 75 * DAY), h4, d1, funding: { rate: 0.0001, intervalHours: 8 }, now }) };
  };
  const eth = mk('ETHUSDT', 9, 2500), btc = mk('BTCUSDT', 21, 60000);

  test('the POIs only (cards v3): price, the AI read on top when given, the POI ladder; fits Telegram', () => {
    for (const { built } of [eth, btc]) {
      const msgs = coinCardText(built.card, 'The nearest long POI sits 2% under the price with 9 scripts.'), text = msgs.join('\n');
      for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
      expect(text).toContain(`📊 <b>${built.card.symbol}</b> · POIs · `);
      expect(text.indexOf('🤖 <b>AI read</b> (Claude Sonnet 5.5 · not advice)')).toBeLessThan(text.indexOf('<b>POIs</b>'));
      for (const k of ['Price ', `<b>POIs</b> (${SCRIPT_COUNT} scripts · W / D / 4H · ⚠️ manage your own risk)`, ' ── price ']) expect(text).toContain(k);
      for (const k of ['<b>Trend</b>', '<b>EMA</b>', '<b>Chop Zone</b>', '<b>RSI / MACD</b>', '<b>Volume</b>', '<b>Order blocks</b>', '<b>FVG</b>', '<b>S/R</b>', '<b>Fib</b>', '<b>Liquidity</b>', '<b>Range targets</b>', 'funding ']) expect(text).not.toContain(k);
      const rows = text.split('\n').filter((l) => / (🔴 short|🟢 long) <b>/.test(l));
      expect(rows.length).toBe(built.card.poi.short.length + built.card.poi.long.length);
      for (const z of [...built.card.poi.short, ...built.card.poi.long]) { expect(z.scripts).toBeGreaterThanOrEqual(3); expect(z.fams.length).toBeGreaterThanOrEqual(2); }
      for (const l of rows) expect(l).toMatch(/ · \d+ scripts · (W|D|4H)/);
      expect(coinCardText(built.card, null).join('\n')).not.toContain('AI read');
    }
    if (process.env.CARD_OUT) writeFileSync(process.env.CARD_OUT, [eth, btc].map(({ built }) => `${coinCardText(built.card, '(AI read goes here)').join('\n----\n')}\n\n[${coinCardText(built.card, null).join('').length} chars without the AI read]`).join('\n\n======\n\n'));
  });

  test('every level / zone script gives pieces (cards v3 additions included)', () => {
    const srcs = new Set([eth, btc].flatMap(({ built }) => Object.values(built.pieces).flat().map((p) => p.src)));
    for (const s0 of ['MM', 'Lux', 'SMC', 'OBD', 'VR', 'Axe', 'Chan', 'Breaks', 'Clusters', 'Shaakuni', 'EMA', 'CP', 'Opt', 'Auto', 'OLH', 'LTH', 'LTT', 'LZ', 'LSOF', 'TL']) expect(srcs).toContain(s0);
    expect([...srcs].every((x) => SCRIPT_OF[x] != null)).toBe(true);
  });

  test('the chart check lists every script on every timeframe', () => {
    const lines = coinChartCheck(eth.built).join('\n');
    for (const k of ['--- W: ', '--- D: ', '--- 4H: ', 'VIDYA heat map: ', 'Chop Zone: ', 'RedK i-Amp (RSI 14 preset): ', 'Squeeze Momentum (LazyBear): momentum ', 'MarketMaulers OBs live', 'LuxAlgo Dynamic OB: ', 'HTF FVG/IFVG', 'LuxAlgo FVG Absorption: ', 'Strong FVGs', 'ChartPrime S/R: ', 'Optimus S/R', 'Smart S/R', 'Liquidity HeatMap: ', 'Range targets (FEELS): ', 'Heatmap Volume (xdecow): ', 'Volume divergence (BigBeluga)', 'Auto-Fib (ChartWhizzperer): ', 'Fib Confluence Toolkit (LuxAlgo): ', 'Liquidation HeatMap (BigBeluga): ', 'LuxAlgo SMC order blocks: ', 'LuxAlgo Order Block Detector: ', 'BigBeluga Supply and Demand: ', 'LuxAlgo S/D Visible Range', 'AxeAlgo S/R Confluence Zones', 'S/R Channels', 'LuxAlgo S/R Levels with Breaks: ', 'Strong Fibo Clusters', 'BigBeluga Open Liquidity Heatmap (bright bands): ', 'BigBeluga Liquidity Trend Heatmap (nodes from 50% of the POC): ', 'Trend Lines v2 (LonesomeTheBlue): ', 'BigBeluga Liquidity Zones (the ', 'LuxAlgo Liquidity Structure & Order Flow (300 bars, range ', 'Liquidity Trend Heatmap trend line: ', 'Shaakuni (previous week / day): ', 'EMA stack: ', 'FEELS range box: ']) expect(lines).toContain(k);
    if (process.env.CARD_OUT) writeFileSync(`${process.env.CARD_OUT}.check`, lines);
  });

  test('a followed trader\'s level inside a POI tags that POI; the note goes under the AI read', () => {
    const z = eth.built.card.poi.long[0] ?? eth.built.card.poi.short[0]!;
    const text = coinCardText(eth.built.card, 'read', { title: 'Community traders', lines: ['Community trader #1: S 1 <b>'] }, [{ tag: 'CT#1', levels: [(z.lo + z.hi) / 2] }]).join('\n');
    expect(text.split('\n').filter((l) => l.includes('👤 CT#1'))).toHaveLength(1);
    expect(text).toContain('🗞 <b>Community traders</b>\n Community trader #1: S 1 &lt;b&gt;');
    expect(text.indexOf('🗞')).toBeLessThan(text.indexOf('<b>POIs</b>'));
    expect(aiInput(eth.built.card, null, [{ tag: 'CT#1', levels: [(z.lo + z.hi) / 2] }])).toContain('👤 CT#1');
  });

  test('the AI input is the price and the POI ladder as plain text', () => {
    const s = aiInput(eth.built.card);
    expect(s).not.toMatch(/<\/?b>/);
    expect(s).toContain('ETHUSDT at the ');
    expect(s).toContain('POIs (');
    expect(s).toContain(' ── price ');
    expect(s).not.toContain('Order blocks (');
  });

  test('change alerts: in the window, keys unique, removed families never alert', () => {
    const since = eth.now - 7 * DAY, evs = coinEvents(eth.built, since);
    expect(evs.length).toBeGreaterThan(0);
    expect(new Set(evs.map((e) => e.key)).size).toBe(evs.length);
    for (const e of evs) { expect(e.t).toBeGreaterThan(since); expect(e.t).toBeLessThanOrEqual(eth.now); expect(e.key.startsWith('v2|')).toBe(true); }
    for (const e of evs) expect(e.kind).not.toMatch(/kama|dn-|ribbon|wyckoff|trinity|fibarc|cluster|sr-/);
    if (process.env.CARD_OUT) writeFileSync(`${process.env.CARD_OUT}.alerts`, evs.map((e) => `${new Date(e.t).toISOString().slice(0, 16)} ${e.text}`).join('\n'));
  });

  test('no look-ahead: a card for an earlier close equals one built from the bars up to it', () => {
    const { m15, h1, h4, d1 } = market(500, 9, 2500), now = h4[h4.length - 40]!.openTime + H4;
    const a = coinCard({ symbol: 'ETHUSDT', m15: m15.filter((b) => b.openTime + Q <= now), h1, h4, d1, funding: null, now }).card;
    const b = coinCard({ symbol: 'ETHUSDT', m15: m15.filter((b) => b.openTime + Q <= now), h1: h1.filter((x) => x.openTime + H <= now), h4: h4.filter((x) => x.openTime + H4 <= now), d1: d1.filter((x) => x.openTime + DAY <= now), funding: null, now }).card;
    expect(a).toEqual(b);
  });
});
