// The signal screen must find an edge that is there and reject one that isn't.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultConfig } from '../src/index';
import { loadScoreConfig } from '../src/score/config';
import { DEFAULT_GATE, EXITS, screenSignal, windowStats, type Gate } from '../src/screen/screen';
import { SIGNALS, contextFor, type SignalDef } from '../src/screen/signals';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;
const REPO = join(__dirname, '..', '..', '..');
const { config: score } = loadScoreConfig(join(REPO, 'config/confluence.yaml'));
const data = syntheticMarket(160, 6);
const symbols = Object.keys(data);
const base = defaultConfig(START + 30 * DAY, START + 160 * DAY);
const windows = { discovery: [START + 30 * DAY, START + 110 * DAY] as [number, number], confirmation: [START + 110 * DAY, START + 160 * DAY] as [number, number] };
const gate: Gate = { ...DEFAULT_GATE, minWin: 0.55, discovery: { minN: 30, nullPctile: 0.95, minQuarters: 0 }, confirmation: { minN: 10, nullPctile: 0.8 } };

/** Cheats: knows the close 6 bars ahead. */
const oracle: SignalDef = { id: 'oracle', family: 'trend', what: 'lookahead', build: (x) => Int8Array.from(x.candles, (c, i) => (i % 8 === 0 && x.candles[i + 6] ? (x.candles[i + 6]!.close > c.close ? 1 : -1) : 0)) };
/** A coin flip every 8 bars. */
const coin: SignalDef = { id: 'coin', family: 'trend', what: 'random', build: (x) => { let s = 9; return Int8Array.from(x.candles, (_, i) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return i % 8 === 0 ? (s & 1 ? 1 : -1) : 0; }); } };

describe('signal screen', () => {
  test('a lookahead signal passes, and its faded twin loses', () => {
    const c = screenSignal(data, symbols, oracle, '1h', base, score, windows, gate, 200, [EXITS[1]!]);
    const asIs = c.find((x) => !x.fade)!;
    const faded = c.find((x) => x.fade)!;
    expect(asIs.discovery.n).toBeGreaterThan(30);
    expect(asIs.discovery.paired).toBeGreaterThan(20);
    expect(asIs.discovery.nullPctile).toBeGreaterThan(0.95);
    expect(asIs.pass).toBe(true);
    expect(faded.pass).toBe(false);
    expect(faded.discovery.expectancyR!).toBeLessThan(0);
  }, 60_000);

  test('a coin flip does not pass', () => {
    const c = screenSignal(data, symbols, coin, '1h', base, score, windows, gate, 200, [EXITS[1]!]);
    expect(c.some((x) => x.pass)).toBe(false);
  }, 60_000);

  test('every library signal builds on every timeframe without lookahead: truncating history does not change past events', () => {
    for (const tf of ['1h', '4h'] as const) {
      for (const def of SIGNALS) {
        if (def.tfs && !def.tfs.includes(tf)) continue;
        const full = def.build(contextFor(data, 'SOLUSDT', tf, score)!);
        expect(full.length).toBe(data.SOLUSDT!.candles[tf]!.length);
        // Cut history at 120 days (bars and funding) and rebuild: events before the cut must match.
        const cut = START + 120 * DAY;
        const trunc = Object.fromEntries(Object.entries(data).map(([s, d]) => [s, { ...d, candles: Object.fromEntries(Object.entries(d.candles).map(([k, v]) => [k, v!.filter((c) => c.openTime < cut)])), funding: d.funding?.filter((f) => f.time <= cut) }]));
        const part = def.build(contextFor(trunc, 'SOLUSDT', tf, score)!);
        // The last few bars before a cut can differ only for signals that confirm later (none should).
        expect(Array.from(part), `${def.id} ${tf}`).toEqual(Array.from(full.slice(0, part.length)));
      }
    }
  }, 60_000);

  test('random-direction percentile: all winners as-is and all losers faded sit at the top', () => {
    const trades = Array.from({ length: 40 }, (_, i) => ({ key: `S|${i}`, openedAt: i, side: 'long' as const, r: 1 }));
    const other = new Map(trades.map((t) => [t.key, -1]));
    expect(windowStats(trades, other, [0, 100], 200).nullPctile).toBe(1);
  });
});

describe('multi-timeframe RSI framework', () => {
  test('every long has daily RSI above the bias and 4H RSI in the pullback zone at the trigger; shorts mirror', async () => {
    const { rsi } = await import('../src/indicators');
    const { barAt } = await import('@bot/smc');
    const def = SIGNALS.find((s) => s.id === 'rsi_mtf_b50')!;
    let longs = 0, shorts = 0;
    for (const sym of symbols) {
      const ctx = contextFor(data, sym, '1h', score)!;
      const sig = def.build(ctx);
      const d = data[sym]!.candles['1d']!, h4 = data[sym]!.candles['4h']!;
      const rd = rsi(d.map((c) => c.close), 14), r4 = rsi(h4.map((c) => c.close), 14), r1 = rsi(ctx.candles.map((c) => c.close), 14);
      sig.forEach((s, i) => {
        if (!s) return;
        const t = ctx.candles[i]!.openTime + 3_600_000;
        const a = rd[barAt(d, DAY, t)]!, b = r4[barAt(h4, 4 * 3_600_000, t)]!;
        if (s > 0) { longs++; expect(a).toBeGreaterThan(50); expect(b).toBeGreaterThanOrEqual(30); expect(b).toBeLessThanOrEqual(45); expect(r1[i - 1]!).toBeLessThan(30); expect(r1[i]!).toBeGreaterThanOrEqual(30); }
        else { shorts++; expect(a).toBeLessThan(50); expect(b).toBeGreaterThanOrEqual(55); expect(b).toBeLessThanOrEqual(70); expect(r1[i - 1]!).toBeGreaterThan(70); expect(r1[i]!).toBeLessThanOrEqual(70); }
      });
    }
    expect(longs + shorts).toBeGreaterThan(0);
  });
});

describe('RSI framework layers', () => {
  test('each filter only removes entries from rsi_mtf; the base and every layer build on real-shaped data', () => {
    const base = SIGNALS.find((s) => s.id === 'rsi_mtf')!;
    for (const id of ['rsi_mtf_struct', 'rsi_mtf_ema', 'rsi_mtf_obv', 'rsi_mtf_macd', 'rsi_mtf_fund']) {
      const layer = SIGNALS.find((s) => s.id === id)!;
      for (const sym of symbols) {
        const b = base.build(contextFor(data, sym, '1h', score)!);
        const l = layer.build(contextFor(data, sym, '1h', score)!);
        l.forEach((v, i) => { if (v) expect(b[i], `${id} ${sym} ${i}`).toBe(v); });
      }
    }
  });
});
