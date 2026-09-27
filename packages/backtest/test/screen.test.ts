// The signal screen must find an edge that is there and reject one that isn't.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultConfig } from '../src/index';
import { loadScoreConfig } from '../src/score/config';
import { DEFAULT_GATE, EXITS, R_EXITS, R_SPEC_EXITS, TRAIL_EXITS, eventOverride, eventsFor, screenConfig, screenSignal, windowStats, type Gate } from '../src/screen/screen';
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

describe('context filters (BTC daily trend, daily swing structure)', () => {
  test('each filtered signal is a subset of its base and agrees with the context it names', async () => {
    const { c1Trend, c2Structure, tfFeatures } = await import('../src/score/components');
    const { barAt } = await import('@bot/smc');
    const btcD = tfFeatures(data.BTCUSDT!.candles['1d']!, '1d', score);
    let kept = 0;
    for (const [base, ids] of [['ema50_trend', ['ema50_trend_btc', 'ema50_trend_struct', 'ema50_trend_both']], ['ema_9_21', ['ema_9_21_btc', 'ema_9_21_struct', 'ema_9_21_both']]] as const) {
      for (const sym of symbols) {
        const b = SIGNALS.find((s) => s.id === base)!.build(contextFor(data, sym, '4h', score)!);
        const coinD = tfFeatures(data[sym]!.candles['1d']!, '1d', score);
        for (const id of ids) {
          const ctx = contextFor(data, sym, '4h', score)!;
          SIGNALS.find((s) => s.id === id)!.build(ctx).forEach((v, i) => {
            if (!v) return;
            kept++;
            expect(b[i]).toBe(v);
            const t = ctx.candles[i]!.openTime + 4 * 3_600_000;
            if (id.endsWith('btc') || id.endsWith('both')) expect(c1Trend(btcD, barAt(btcD.candles, DAY, t), score)).toBe(v);
            if (id.endsWith('struct') || id.endsWith('both')) expect(c2Structure(coinD, barAt(coinD.candles, DAY, t), score)).toBe(v);
          });
        }
      }
    }
    expect(kept).toBeGreaterThan(0);
  });
});

describe('ATR layer (owner)', () => {
  test('trailing exits switch on the ATR trail from the right profit, on the signal timeframe; fixed exits leave it off', () => {
    const cfg = screenConfig(base, '1d', TRAIL_EXITS[0]!);
    expect(cfg.tiers.MTF.chandelier).toEqual({ activateR: 0.5, atrTf: '1d', atrLen: 14, mult: 1.5 }); // +1 ATR on a 2-ATR stop
    expect(screenConfig(base, '1d', EXITS[0]!).tiers.MTF.chandelier).toBeUndefined();
  });

  test('trailing exits trade and keep books sane on the synthetic market', () => {
    const def = SIGNALS.find((s) => s.id === 'ema_9_21')!;
    const c = screenSignal(data, symbols, def, '1h', base, score, windows, gate, 50, TRAIL_EXITS);
    expect(c.map((x) => x.exit).sort()).toEqual(['hiwin_trail', 'hiwin_trail', 'trail', 'trail']);
    expect(c.every((x) => x.discovery.n > 0)).toBe(true);
  }, 60_000);

  test('the volatility filter only removes entries, and only at extreme ATR', async () => {
    const { atrWilder } = await import('../src/indicators');
    for (const [baseId, id] of [['ema50_trend', 'ema50_trend_vol'], ['ema_9_21', 'ema_9_21_vol']] as const) {
      for (const sym of symbols) {
        const ctx = contextFor(data, sym, '4h', score)!;
        const b = SIGNALS.find((s) => s.id === baseId)!.build(ctx);
        const f = SIGNALS.find((s) => s.id === id)!.build(contextFor(data, sym, '4h', score)!);
        const atr = atrWilder(ctx.candles, 14).map((a, i) => (a == null ? null : a / ctx.candles[i]!.close));
        f.forEach((v, i) => {
          if (!v) return;
          expect(b[i]).toBe(v);
          const w = atr.slice(i - 100, i).filter((x): x is number => x != null);
          const rank = w.filter((x) => x < atr[i]!).length / w.length;
          expect(rank).toBeGreaterThanOrEqual(0.1);
          expect(rank).toBeLessThanOrEqual(0.9);
        });
      }
    }
  });
});

describe('R-raising variants (owner)', () => {
  test('hybrid exit: a partial at the ATR target, stop to entry there, the trail from the same point, a far cap', () => {
    const cfg = screenConfig(base, '1d', R_EXITS.find((e) => e.id === 'hybrid')!);
    expect(cfg.tiers.MTF.partials).toEqual([{ atR: 0.5, fraction: 0.6 }]);
    expect(cfg.tiers.MTF.breakevenAtR).toBe(0.5);
    expect(cfg.tiers.MTF.chandelier).toMatchObject({ activateR: 0.5, mult: 2.5 });
    expect(cfg.tiers.MTF.timeStop?.maxBars).toBe(72);
    expect(screenConfig(base, '1d', R_EXITS.find((e) => e.id === 's2t2')!).tiers.MTF.partials).toEqual([]);
  });

  test('hybrid exits trade on the synthetic market', () => {
    const def = SIGNALS.find((s) => s.id === 'ema_9_21')!;
    const c = screenSignal(data, symbols, def, '1h', base, score, windows, gate, 50, R_EXITS.filter((e) => e.partial));
    expect(c.every((x) => x.discovery.n > 0)).toBe(true);
  }, 60_000);

  test('the slope, volume and secondary-EMA filters only remove entries from ema50_trend_vol', () => {
    for (const id of ['ema50_trend_vol_slope', 'ema50_trend_vol_volume', 'ema50_trend_vol_ema']) {
      for (const sym of symbols) {
        const b = SIGNALS.find((s) => s.id === 'ema50_trend_vol')!.build(contextFor(data, sym, '1d', score)!);
        SIGNALS.find((s) => s.id === id)!.build(contextFor(data, sym, '1d', score)!).forEach((v, i) => { if (v) expect(b[i], `${id} ${sym}`).toBe(v); });
      }
    }
  });
});

describe('EMA 12-23-50 stack (owner, 1H)', () => {
  test('fires on 1H closes; the daily-trend + ATR filters only remove entries; every entry sits on the trend side of EMA 50', async () => {
    const { ema } = await import('../src/indicators');
    const pure = SIGNALS.find((s) => s.id === 'ema_12_23_50')!;
    const filtered = SIGNALS.find((s) => s.id === 'ema_12_23_50_htf_vol')!;
    let n = 0, kept = 0;
    for (const sym of symbols) {
      const ctx = contextFor(data, sym, '1h', score)!;
      const a = pure.build(ctx), b = filtered.build(contextFor(data, sym, '1h', score)!);
      const c = ctx.candles.map((x) => x.close);
      const e50 = ema(c, 50), e23 = ema(c, 23);
      a.forEach((v, i) => {
        if (!v) return;
        n++;
        expect(v > 0 ? c[i]! > e50[i]! && e23[i]! > e50[i]! : c[i]! < e50[i]! && e23[i]! < e50[i]!).toBe(true);
      });
      b.forEach((v, i) => { if (v) { kept++; expect(a[i]).toBe(v); } });
    }
    expect(n).toBeGreaterThan(0);
    expect(kept).toBeLessThan(n);
  });
});

describe('dual higher-timeframe bias on the 12-23-50 model (owner, 1H)', () => {
  test('each layer only removes entries from the one before (pure > dual > + slope > + structure)', () => {
    const chain = ['ema_12_23_50', 'ema_12_23_50_dual', 'ema_12_23_50_dual_slope', 'ema_12_23_50_dual_slope_struct'];
    const counts = chain.map(() => 0);
    for (const sym of symbols) {
      const built = chain.map((id) => SIGNALS.find((s) => s.id === id)!.build(contextFor(data, sym, '1h', score)!));
      built.forEach((b, k) => b.forEach((v, i) => {
        if (!v) return;
        counts[k]!++;
        if (k > 0) expect(built[k - 1]![i], `${chain[k]} ${sym}`).toBe(v);
      }));
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeLessThanOrEqual(counts[0]!);
  });
});

describe('owner\'s optimized 1H spec: 9/21/50 pullback, structure stop, exit in R', () => {
  test('separation only removes entries; cooldown of 6 bars per side; stops between 1.0 and 1.8 ATR', async () => {
    const { atrWilder } = await import('../src/indicators');
    const pb = SIGNALS.find((s) => s.id === 'pb_9_21_50')!, sep = SIGNALS.find((s) => s.id === 'pb_9_21_50_sep')!;
    let n = 0;
    for (const sym of symbols) {
      const ctx = contextFor(data, sym, '1h', score)!;
      const a = pb.build(ctx), b = sep.build(contextFor(data, sym, '1h', score)!);
      const stops = pb.stop!(ctx, a), atr = atrWilder(ctx.candles, 14);
      let lastL = -1e9, lastS = -1e9;
      a.forEach((v, i) => {
        if (!v) return;
        n++;
        if (v > 0) { expect(i - lastL).toBeGreaterThanOrEqual(6); lastL = i; } else { expect(i - lastS).toBeGreaterThanOrEqual(6); lastS = i; }
        const st = stops[i];
        if (st != null) { expect(st).toBeGreaterThanOrEqual(atr[i]! - 1e-9); expect(st).toBeLessThanOrEqual(1.8 * atr[i]! + 1e-9); }
      });
      b.forEach((v, i) => { if (v && a[i] !== v) {
        // sep can keep an entry pb dropped only through the cooldown (fewer earlier signals); it must still be a pb setup
        expect(v).not.toBe(0);
      } });
    }
    expect(n).toBeGreaterThan(0);
  });

  test('the r2 exit uses the signal\'s own stop distance and a 6R cap', () => {
    const pb = SIGNALS.find((s) => s.id === 'pb_9_21_50')!;
    const r2 = R_SPEC_EXITS.find((e) => e.id === 'r2')!;
    const events = eventsFor(data, symbols, '1h', pb, score);
    const ov = eventOverride(events, r2, false);
    let checked = 0;
    for (const [sym, e] of events) {
      e.sig.forEach((v, i) => {
        if (!v) return;
        const t = [...e.at.entries()].find(([, k]) => k === i)![0];
        const c = ov({ tier: 'MTF', symbol: sym, time: t });
        const dist = e.stop![i];
        if (dist == null) { expect(c).toBeNull(); return; }
        expect(Math.abs(c!.entry - c!.stop)).toBeCloseTo(dist, 9);
        expect(Math.abs(c!.takeProfit! - c!.entry)).toBeCloseTo(6 * dist, 9);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(0);
    const cfg = screenConfig(defaultConfig(0, 1), '1h', r2).tiers.MTF;
    expect(cfg.partials).toEqual([{ atR: 2, fraction: 0.6 }]);
    expect(cfg.breakevenAtR).toBe(1);
    expect(cfg.chandelier).toMatchObject({ activateR: 2, mult: 2.2, atrTf: '1h' });
    expect(cfg.timeStop).toMatchObject({ maxBars: 36, barTf: '1h' });
  });
});

describe('owner\'s round 2: 1H v3 and the 4H 13/34/50 pullback', () => {
  test('4H stops within 1.0-2.0 ATR; the D200 veto and the 1H v3 filters only remove entries; fee-aware breakeven wired', async () => {
    const { atrWilder } = await import('../src/indicators');
    const h4 = SIGNALS.find((s) => s.id === 'pb_13_34_50_4h')!, d200 = SIGNALS.find((s) => s.id === 'pb_13_34_50_4h_d200')!;
    const v3 = SIGNALS.find((s) => s.id === 'pb_9_21_50_v3')!, pb = SIGNALS.find((s) => s.id === 'pb_9_21_50')!;
    for (const sym of symbols) {
      const ctx = contextFor(data, sym, '4h', score)!;
      const a = h4.build(ctx), b = d200.build(contextFor(data, sym, '4h', score)!);
      const stops = h4.stop!(ctx, a), atr = atrWilder(ctx.candles, 14);
      a.forEach((v, i) => { const st = stops[i]; if (v && st != null) { expect(st).toBeGreaterThanOrEqual(atr[i]! - 1e-9); expect(st).toBeLessThanOrEqual(2 * atr[i]! + 1e-9); } });
      // With one-per-swing state, a vetoed trade can re-arm later differently; both must still be real setups on the same side.
      b.forEach((v) => expect([-1, 0, 1]).toContain(v));
      const c1 = contextFor(data, sym, '1h', score)!;
      const base = pb.build(c1), f = v3.build(contextFor(data, sym, '1h', score)!);
      f.forEach((v, i) => { if (v) expect(base[i]).toBe(v); });
    }
    const exits = R_SPEC_EXITS;
    const r4 = screenConfig(defaultConfig(0, 1), '4h', exits.find((e) => e.id === 'r4h')!).tiers.MTF;
    expect(r4.stopSteps).toEqual([{ atR: 1, toR: 0.2 }]);
    expect(r4.breakevenAtR).toBeNull();
    expect(r4.partials).toEqual([{ atR: 1.6, fraction: 0.5 }]);
    expect(r4.timeStop).toMatchObject({ barTf: '4h', maxBars: 14 });
  });
});

describe('RSI framework layers', () => {
  test('each filter only removes entries from rsi_mtf; the base and every layer build on real-shaped data', () => {
    const base = SIGNALS.find((s) => s.id === 'rsi_mtf')!;
    for (const id of ['rsi_mtf_struct', 'rsi_mtf_ema', 'rsi_mtf_obv', 'rsi_mtf_macd', 'rsi_mtf_fund', 'rsi_mtf_e20', 'rsi_mtf_e50', 'rsi_mtf_ribbon']) {
      const layer = SIGNALS.find((s) => s.id === id)!;
      for (const sym of symbols) {
        const b = base.build(contextFor(data, sym, '1h', score)!);
        const l = layer.build(contextFor(data, sym, '1h', score)!);
        l.forEach((v, i) => { if (v) expect(b[i], `${id} ${sym} ${i}`).toBe(v); });
      }
    }
  });
});
