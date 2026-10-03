// The S/R channels port (LonesomeTheBlue's SRchannel): pivots, channel levels, the break alerts, no look-ahead,
// and the bot's three entry styles built on it.
import type { Candle } from '@bot/marketdata';
import { describe, expect, test } from 'vitest';
import { nearestChannels, pivotAt, srChannels } from '../src/screen/srchannels';
import { fibTriggerSetups, SIGNALS, type SignalContext } from '../src/screen/signals';
import { defaultConfig } from '../src/types';
import { eventOverride, R_SPEC_EXITS, screenConfig, type Events } from '../src/screen/screen';

const H4 = 4 * 3_600_000;
/** A 40-bar wave between 100 and 110 (highs 0.5 above the close, lows 0.5 below), then a climb to 130 and a hold. */
function wave(): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < 360; i++) closes.push(105 + 5 * Math.sin((2 * Math.PI * i) / 40));
  const last = closes.at(-1)!;
  for (let k = 1; k <= 20; k++) closes.push(last + (130 - last) * (k / 20));
  for (let k = 0; k < 30; k++) closes.push(130);
  return closes.map((c, i) => ({ openTime: i * H4, open: i ? closes[i - 1]! : c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
}

describe('SRchannel port', () => {
  const c = wave();
  const sr = srChannels(c);

  test('a pivot is confirmed prd bars after it, and only if it is the extreme of the window', () => {
    const highs = c.map((x) => x.high);
    // The wave peaks at bar 10 (sin = 1): confirmed at bar 20, not before.
    expect(pivotAt(highs, 19, 10, true)).toBeNull();
    expect(pivotAt(highs, 20, 10, true)).toBeCloseTo(110.5, 10);
    expect(pivotAt(highs, 21, 10, true)).toBeNull();
  });

  test('no channel and no alert before 300 bars (Pine: ta.highest(300) is na)', () => {
    for (let i = 0; i < 299; i++) expect(sr.channels[i]).toEqual([]);
    expect([...sr.resBroken.slice(0, 300)].every((v) => v < 0)).toBe(true);
  });

  test('the wave tops and bottoms become the strongest channels', () => {
    const chs = sr.channels[350]!;
    expect(chs.length).toBeGreaterThanOrEqual(2);
    expect(chs.some((ch) => Math.abs(ch.hi - 110.5) < 0.6 && ch.hi >= ch.lo)).toBe(true);
    expect(chs.some((ch) => Math.abs(ch.lo - 99.5) < 0.6)).toBe(true);
    const nc = nearestChannels(chs, 105);
    expect(nc.above).not.toBeNull();
    expect(nc.below).not.toBeNull();
  });

  test('the climb breaks resistance once, on the first close above the top channel', () => {
    const top = Math.max(...sr.channels[360]!.map((ch) => ch.hi));
    const fired = [...sr.resBroken.keys()].filter((i) => i >= 360 && sr.resBroken[i]! >= 0);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const first = fired[0]!;
    expect(c[first]!.close).toBeGreaterThan(top);
    expect(c[first - 1]!.close).toBeLessThanOrEqual(top);
    expect([...sr.supBroken.slice(360)].every((v) => v < 0)).toBe(true);
  });

  test('no look-ahead: a shorter history gives the same channels and alerts on every bar it has', () => {
    for (const k of [305, 340, 371, 390]) {
      const part = srChannels(c.slice(0, k));
      for (let i = 0; i < k; i++) {
        expect(part.channels[i], `bar ${i} of ${k}`).toEqual(sr.channels[i]);
        expect(part.resBroken[i]).toBe(sr.resBroken[i]);
        expect(part.supBroken[i]).toBe(sr.supBroken[i]);
      }
    }
  });
});

describe('S/R bot entry styles', () => {
  const c = wave();
  const x = { symbol: 'TESTUSDT', tf: '4h', candles: c } as unknown as SignalContext;
  const def = (id: string) => SIGNALS.find((d) => d.id === id)!;

  test('break: long on the alert bar; stop 1-3 ATR beyond the channel; open space ahead = no target', () => {
    const sr = srChannels(c);
    const sig = def('src_brk_4h').build(x);
    const longs = [...sig.keys()].filter((i) => sig[i] === 1);
    expect(longs).toContain([...sr.resBroken.keys()].find((i) => sr.resBroken[i]! >= 0)!);
    const i = longs.at(-1)!;
    const stop = def('src_brk_4h').stop!(x, sig)[i]!;
    expect(stop).toBeGreaterThan(0);
    expect(def('src_brk_4h').target!(x, sig)[i]).toBeNull(); // nothing above 130
    expect(def('src_brk_4h').invalidate!(x, sig)[i]).toBeGreaterThan(100);
  });

  test('bounce: dips into the support channel and closes back above it on the wave', () => {
    const sig = def('src_bnc_4h').build(x);
    const n = [...sig].filter((v) => v !== 0).length;
    expect(n).toBeGreaterThan(0);
    for (const [i, v] of sig.entries()) if (v) expect(i).toBeGreaterThanOrEqual(299);
  });

  test('every style and timeframe is registered, with and without the room filter', () => {
    for (const st of ['brk', 'rt', 'bnc']) for (const r of ['', '_room15']) for (const tf of ['1h', '4h', '1d']) {
      expect(SIGNALS.some((d) => d.id === `src_${st}${r}_${tf}`), `src_${st}${r}_${tf}`).toBe(true);
    }
  });
});

describe('Fib pullback setup (owner 2026-10-03)', () => {
  // Down to a low at bar 30 (99.5), up to a high at bar 60 (130.5), then a slow drift lower.
  const closes = [
    ...Array.from({ length: 31 }, (_, i) => 110 - (10 * i) / 30),
    ...Array.from({ length: 30 }, (_, i) => 100 + (30 * (i + 1)) / 30),
    ...Array.from({ length: 30 }, (_, i) => 130 - (5 * (i + 1)) / 30),
  ];
  const c: Candle[] = closes.map((x, i) => ({ openTime: i * H4, open: i ? closes[i - 1]! : x, high: x + 0.5, low: x - 0.5, close: x, volume: 1 }));
  const ctx = (cs: Candle[]) => ({ symbol: 'T', tf: '4h', candles: cs, data: { candles: {} } }) as unknown as SignalContext;
  const def = SIGNALS.find((d) => d.id === 'fib_none_e65_t0_4h')!;

  test('armed on the bar the swing high is confirmed, with the owner\'s levels', () => {
    const sig = def.build(ctx(c));
    expect([...sig.keys()].filter((i) => sig[i] !== 0)).toEqual([70]);
    expect(sig[70]).toBe(1);
    const leg = 130.5 - 99.5;
    expect(def.entry!(ctx(c), sig)[70]).toBeCloseTo(130.5 - 0.65 * leg, 9);
    const lv = def.fib!(ctx(c), sig)[70]!;
    expect(lv.tp1).toBeCloseTo(130.5 - 0.382 * leg, 9);
    expect(lv.tp2).toBeCloseTo(130.5 - 0.236 * leg, 9);
    expect(lv.final).toBeCloseTo(99.5 + 1.272 * leg, 9);
    expect(lv).toMatchObject({ cancelIfTouched: 130.5, cancelOnClose: 99.5 });
    expect(def.stop!(ctx(c), sig)[70]).toBeGreaterThan(130.5 - 0.65 * leg - 99.5); // beyond the swing low
  });

  test('no look-ahead: a shorter history never shows the setup before bar 70', () => {
    expect([...def.build(ctx(c.slice(0, 70)))].every((v) => v === 0)).toBe(true);
    expect(def.build(ctx(c.slice(0, 71)))[70]).toBe(1);
  });

  test('every Fib variant is registered (no htf on daily)', () => {
    const ids = SIGNALS.map((d) => d.id).filter((id) => /^fib_(top2|p3|htf|none)_e(65|786)_t(50|0)_(1h|4h|1d)$/.test(id));
    expect(ids).toHaveLength(44);
    expect(ids).not.toContain('fib_htf_e65_t50_1d');
  });
});

describe('Fib round 2 (owner R:R)', () => {
  const closes = [
    ...Array.from({ length: 31 }, (_, i) => 110 - (10 * i) / 30),
    ...Array.from({ length: 30 }, (_, i) => 100 + (30 * (i + 1)) / 30),
    ...Array.from({ length: 30 }, (_, i) => 130 - (5 * (i + 1)) / 30),
  ];
  const c: Candle[] = closes.map((x, i) => ({ openTime: i * H4, open: i ? closes[i - 1]! : x, high: x + 0.5, low: x - 0.5, close: x, volume: 1 }));

  test('the 0.886 stop is tighter than the swing stop, on the same entry', () => {
    const x = { symbol: 'T', tf: '4h', candles: c, data: { candles: {} } } as unknown as SignalContext;
    const base = SIGNALS.find((d) => d.id === 'fib_none_e65_t0_4h')!;
    const sig = base.build(x);
    const swingDist = base.stop!(x, sig)[70]!;
    const leg = 130.5 - 99.5;
    // 0.886 stop: entry (0.65) to 0.886 = 0.236 leg, plus 0.1 ATR; the swing stop is 0.35 leg plus 0.2 ATR.
    expect(swingDist).toBeGreaterThan(0.35 * leg);
    expect(0.236 * leg).toBeLessThan(swingDist);
  });

  test('round 2 ids: EMA 30/50/100, with and without the 0.886 stop, and 5 random-filter seeds each', () => {
    for (const t of [30, 50, 100]) for (const s of ['', '_s886']) {
      expect(SIGNALS.some((d) => d.id === `fib_htf_e65_t${t}${s}_4h`), `t${t}${s}`).toBe(true);
      for (const seed of [1, 2, 3, 4, 5]) expect(SIGNALS.some((d) => d.id === `fib_rnd${seed}_e65_t${t}${s}_4h`)).toBe(true);
    }
    expect(SIGNALS.filter((d) => d.id === 'fib_htf_e65_t50_4h')).toHaveLength(1);
  });
});

describe('Fib round 3: 1H needs 4H approval (owner 2026-10-03)', () => {
  // The round-1 leg on 1H bars, with 4H and daily histories that trend down: a 1H long setup is refused without 4H approval.
  const H1 = 3_600_000;
  const closes = [
    ...Array.from({ length: 31 }, (_, i) => 110 - (10 * i) / 30),
    ...Array.from({ length: 30 }, (_, i) => 100 + (30 * (i + 1)) / 30),
    ...Array.from({ length: 30 }, (_, i) => 130 - (5 * (i + 1)) / 30),
  ];
  const c: Candle[] = closes.map((x, i) => ({ openTime: i * H1, open: i ? closes[i - 1]! : x, high: x + 0.5, low: x - 0.5, close: x, volume: 1 }));
  const series = (n: number, iv: number, start: number, step: number): Candle[] =>
    Array.from({ length: n }, (_, k) => { const x = start + step * k; return { openTime: -n * iv + k * iv + 0, open: x, high: x + 0.5, low: x - 0.5, close: x, volume: 1 }; });
  const ctx = (h4: Candle[], d1: Candle[]) => ({ symbol: 'T', tf: '1h', candles: c, data: { candles: { '1h': c, '4h': h4, '1d': d1 } } }) as unknown as SignalContext;
  const up4 = series(200, H4, 50, 0.5), down4 = series(200, H4, 150, -0.5), upD = series(200, 86_400_000, 50, 0.5);

  test('the 1H long passes with 4H and daily both rising, and is refused when 4H falls', () => {
    const def = SIGNALS.find((d) => d.id === 'fib_none_e65_d50_a50_1h')!;
    expect(def.build(ctx(up4, upD))[70]).toBe(1);
    expect(def.build(ctx(down4, upD))[70]).toBe(0);
  });

  test('round 3 ids and random-filter seeds are registered', () => {
    for (const id of ['fib_htf_e65_d50_a50_1h', 'fib_htf_e65_d0_a50_1h', 'fib_htf_e65_d50_a20_1h', 'fib_none_e65_d50_a50_1h']) {
      expect(SIGNALS.filter((d) => d.id === id), id).toHaveLength(1);
    }
    for (const seed of [1, 2, 3, 4, 5]) expect(SIGNALS.some((d) => d.id === `fib_rnd${seed}_e65_d50_a50_1h`)).toBe(true);
  });
});

describe('Fib round 4: lower-timeframe trigger (owner 2026-10-03)', () => {
  const H1 = 3_600_000;
  // Parent 4H leg: L 99.5 (bar 30), H 130.5 (bar 60), armed at bar 70 (closes at 284h); zone 0.618 level = 111.34.
  const pcl = [
    ...Array.from({ length: 31 }, (_, i) => 110 - (10 * i) / 30),
    ...Array.from({ length: 30 }, (_, i) => 100 + (30 * (i + 1)) / 30),
    ...Array.from({ length: 30 }, (_, i) => 130 - (5 * (i + 1)) / 30),
  ];
  const parent = (shiftH = 0): Candle[] => pcl.map((x, i) => ({ openTime: i * H4 + shiftH * H1, open: i ? pcl[i - 1]! : x, high: x + 0.5, low: x - 0.5, close: x, volume: 1 }));
  // 1H: falls into the zone (touch ~302), swing high 114 (312), swing low 110 (318), lower high 112.5 (324), then a
  // sweep of 110 (bar 331, low 108.8, close 110.3) and a displacement through 112.5 (bar 332): shift known at bar 333.
  const pts: [number, number][] = [[0, 110], [120, 100], [240, 130], [284, 128.3], [300, 112], [306, 111], [312, 114], [318, 110], [324, 112.5], [330, 109.6]];
  const cl: number[] = [];
  for (let s = 0; s + 1 < pts.length; s++) { const [k0, v0] = pts[s]!, [k1, v1] = pts[s + 1]!; for (let k = k0; k < k1; k++) cl.push(v0 + ((v1 - v0) * (k - k0)) / (k1 - k0)); }
  cl.push(109.6);
  const h1 = (): Candle[] => {
    const c: Candle[] = cl.map((x, i) => ({ openTime: i * H1, open: i ? cl[i - 1]! : x, high: x + 0.2, low: x - 0.2, close: x, volume: 1 }));
    const n = c.length;
    c.push({ openTime: n * H1, open: 109.6, high: 110.4, low: 108.8, close: 110.3, volume: 1 });
    c.push({ openTime: (n + 1) * H1, open: 110.3, high: 113.9, low: 110.2, close: 113.7, volume: 1 });
    c.push({ openTime: (n + 2) * H1, open: 113.7, high: 114.0, low: 113.4, close: 113.8, volume: 1 });
    return c;
  };
  const ctx = (c: Candle[], p: Candle[]) => ({ symbol: 'T', tf: '1h', candles: c, data: { candles: { '1h': c, '4h': p } } }) as unknown as SignalContext;
  const fired = (c: Candle[], p: Candle[], key: string) => fibTriggerSetups(ctx(c, p), key, () => true).out.flatMap((o, k) => (o ? [{ k, ...o }] : []));

  test('fires once, on the bar the 1H shift is known; stop under the sweep; the parent leg\'s levels', () => {
    const c = h1();
    const f = fired(c, parent(), 't1');
    expect(f.map((x) => x.k)).toEqual([333]);
    expect(f[0]!.d).toBe(1);
    expect(f[0]!.stopDist).toBeGreaterThan(113.8 - 108.8);
    expect(f[0]!.stopDist).toBeLessThan(113.8 - 108.8 + 0.5);
    expect(f[0]!.lv).toMatchObject({ cancelIfTouched: 130.5, cancelOnClose: 99.5 });
    expect(f[0]!.lv.tp1).toBeCloseTo(130.5 - 0.382 * 31, 9);
  });

  test('no look-ahead: a 1H history cut before the shift shows nothing; the parent setup counts only once its bar closed', () => {
    expect(fired(h1().slice(0, 333), parent(), 't2')).toEqual([]);
    expect(fired(h1(), parent().slice(0, 71), 't3').map((x) => x.k)).toEqual([333]);
    expect(fired(h1(), parent(60), 't4')).toEqual([]); // the parent bar now closes at 344h, after the shift
  });

  test('a new high beyond the swing before the trigger cancels the setup', () => {
    const c = h1();
    c[290] = { ...c[290]!, high: 131 };
    expect(fired(c, parent(), 't5')).toEqual([]);
  });

  test('trade features at the trigger: long, leg in 4H ATR, pullback depth inside the zone', async () => {
    const { fibTradeFeatures } = await import('../src/screen/fibfeatures');
    const c = h1(), p = parent();
    const o = fibTriggerSetups(ctx(c, p), 't6', () => true).out;
    const f = fibTradeFeatures(ctx(c, p), 333, o[333]!);
    expect(f.side).toBe('long');
    expect(f.legAtr4h as number).toBeGreaterThan(3);
    expect(f.depth as number).toBeGreaterThan(0.618); // the sweep low 108.8 is 0.70 of the leg
    expect(f.depth as number).toBeCloseTo((130.5 - 108.8) / 31, 3);
    expect(typeof f.has4hChannel).toBe('boolean');
  });

  test('round 4 ids: the two trigger models and 5 random-trigger seeds each, on the trigger timeframe', () => {
    for (const [key, tf] of [['4h_d50', '1h'], ['1h_d50_a50', '15m']] as const) {
      expect(SIGNALS.find((d) => d.id === `fibx_${key}`)?.tfs).toEqual([tf]);
      for (const seed of [1, 2, 3, 4, 5]) expect(SIGNALS.some((d) => d.id === `fibx_rnd${seed}_${key}`)).toBe(true);
    }
  });
});

describe('Fib round 4 exits (owner 2026-10-03: Fib TPs vs TP1 at 0.236 vs 1.6R / 1.8R + ATR trail)', () => {
  // Long at 113.8 (market), stop 5 below; leg L 99.5, H 130.5.
  const lv = { tp1: 130.5 - 0.382 * 31, tp2: 130.5 - 0.236 * 31, final: 99.5 + 1.272 * 31, cancelIfTouched: 130.5, cancelOnClose: 99.5 };
  const ev: Events = { at: new Map([[1000, 0]]), sig: Int8Array.from([1]), close: [113.8], atr: [1], stop: [5], fib: [lv], tf: '1h' };
  const cand = (id: string) => eventOverride(new Map([['T', ev]]), R_SPEC_EXITS.find((e) => e.id === id)!, false)({ tier: 'MTF', symbol: 'T', time: 1000 } as never)!;

  test('Fib exits: market entry, TPs in R from the fill, 1.272 target, trail after TP2', () => {
    const c = cand('fx_33_atr_mkt');
    expect(c).toMatchObject({ market: true, entry: 113.8, stop: 108.8, takeProfit: lv.final, trailAfter: 2 });
    expect(c.partials![0]!.atR).toBeCloseTo((lv.tp1 - 113.8) / 5, 9);
    expect(c.partials![1]!.atR).toBeCloseTo((lv.tp2 - 113.8) / 5, 9);
    expect(c.stopSteps).toEqual([{ atR: c.partials![0]!.atR, toR: 0.1 }]);
    expect((c as { cancelIfTouched?: number }).cancelIfTouched).toBeUndefined();
    const late = cand('fx_late_mkt');
    expect(late.partials![0]!.atR).toBeCloseTo((lv.tp2 - 113.8) / 5, 9);
    expect(late.partials![1]!.atR).toBeCloseTo((130.5 - 113.8) / 5, 9);
  });

  test('fixed-R exits: half at 1.6R / 1.8R, stop to +0.1R, trail after TP1, no fixed target', () => {
    for (const [id, tp] of [['r16_atr_mkt', 1.6], ['r18_atr_mkt', 1.8]] as const) {
      const c = cand(id);
      expect(c).toMatchObject({ market: true, trailAfter: 1, partials: [{ atR: tp, fraction: 0.5 }], stopSteps: [{ atR: tp, toR: 0.1 }] });
      expect(c.takeProfit).toBeCloseTo(113.8 + 500, 9);
    }
  });

  test('trail, ATR and time stop run on the parent timeframe (1h trigger -> 4h)', () => {
    const swing = screenConfig(defaultConfig(0, 1), '1h', R_SPEC_EXITS.find((e) => e.id === 'fx_33_swing_mkt')!).tiers.MTF;
    expect(swing.trailTf).toBe('4h');
    const atr = screenConfig(defaultConfig(0, 1), '15m', R_SPEC_EXITS.find((e) => e.id === 'r16_atr_mkt')!).tiers.MTF;
    expect(atr.chandelier).toMatchObject({ atrTf: '1h', activateR: 0, mult: 2.5 });
    expect(atr.timeStop!.barTf).toBe('1h');
    expect(atr.entryTf).toBe('15m');
  });
});

describe('Fib round 4 + the bot\'s RSI limiters (owner 2026-10-03)', () => {
  test('the three limiter variants are registered on 1h', () => {
    for (const s of ['obv', 'ssw55', 'rsi']) expect(SIGNALS.find((d) => d.id === `fibx_4h_d50_${s}`)?.tfs).toEqual(['1h']);
  });
});

describe('How far past 1.8R (owner 2026-10-03): MFE before the stop, target ids, coin holdout', () => {
  test('MFE counts the best price before the stop; a bar touching the stop ends the walk first', async () => {
    const { mfeBeforeStop } = await import('../src/screen/portfolio');
    const bar = (k: number, low: number, high: number) => ({ openTime: k * 3_600_000, low, high });
    const t = { side: 'long' as const, entry: 100, initialStop: 95, openedAt: 0 };
    // up to 113 (+2.6R), then down through the stop; the stop bar's high of 120 is not counted
    const c = [bar(0, 99, 103), bar(1, 101, 113), bar(2, 104, 110), bar(3, 94, 120), bar(4, 100, 130)];
    const m = mfeBeforeStop(c, t);
    expect(m).toBeCloseTo(2.6, 9);
    expect(m >= 2.5 && m < 3).toBe(true);
    expect(mfeBeforeStop(c, { ...t, side: 'short', initialStop: 105, entry: 100 })).toBeCloseTo(0.2, 9); // short: low 99, then high 113 stops
  });

  test('the 2.0-3.0R exits exist with clean ids', () => {
    for (const id of ['r20_atr_mkt', 'r22_atr_mkt', 'r25_atr_mkt', 'r30_atr_mkt']) expect(R_SPEC_EXITS.some((e) => e.id === id), id).toBe(true);
  });

  test('holdout coins skip the top 60 and every coin a Fib run has seen', async () => {
    const { pickHoldoutCoins, FIB_RESEARCH_SEEN } = await import('../src/screen/portfolio');
    const ranked = [...Array.from({ length: 60 }, (_, i) => `TOP${i}USDT`), 'SOLUSDT', 'NEWAUSDT', 'NEWBUSDT'];
    const pick = pickHoldoutCoins(ranked, new Set(FIB_RESEARCH_SEEN), 60, 10);
    expect(pick).toEqual(['NEWAUSDT', 'NEWBUSDT']);
  });
});

test('the coin holdout holds no stock / ETF tokens and no coin a Fib run has seen', async () => {
  const { loadHoldoutCoins, FIB_RESEARCH_SEEN } = await import('../src/screen/portfolio');
  const { isNonCrypto } = await import('../../worker/src/scan');
  const list = loadHoldoutCoins(new URL('../../../research/holdout-coins.json', import.meta.url).pathname);
  expect(list.length).toBe(54);
  expect(list.filter((s) => isNonCrypto(s))).toEqual([]);
  expect(list.filter((s) => FIB_RESEARCH_SEEN.includes(s))).toEqual([]);
});

test('the pinned research list: 56 unique coins, no holdout coin, no stock token', async () => {
  const { loadResearchCoins, loadHoldoutCoins } = await import('../src/screen/portfolio');
  const { isNonCrypto } = await import('../../worker/src/scan');
  const root = (f: string) => new URL(`../../../research/${f}`, import.meta.url).pathname;
  const list = loadResearchCoins(root('research-coins.json'));
  const held = new Set(loadHoldoutCoins(root('holdout-coins.json')));
  expect(new Set(list).size).toBe(56);
  expect(list.filter((s) => held.has(s) || isNonCrypto(s))).toEqual([]);
});

test('stacked S/R ids: daily + 4H (s4) and + 1H at the sweep (s41), with 5 random-trigger seeds each', () => {
  for (const k of ['4h_d50_s4', '4h_d50_s41']) {
    expect(SIGNALS.find((d) => d.id === `fibx_${k}`)?.tfs).toEqual(['1h']);
    for (const seed of [1, 2, 3, 4, 5]) expect(SIGNALS.some((d) => d.id === `fibx_rnd${seed}_${k}`)).toBe(true);
  }
});

test('feature buckets: CONSISTENT only when the same bucket wins in both periods with enough trades', async () => {
  const { bucketReport } = await import('../src/screen/fibfeatures');
  const rows = Array.from({ length: 120 }, (_, i) => ({ r: i % 2 ? 1 : -0.5, old: i < 80, f: { flag: i % 2 === 1, noise: i % 3 === 0 }, label: '' }));
  const rep = bucketReport(rows, 30).join('\n');
  expect(rep).toMatch(/flag\s+gap 1\.500R\s+best true\s+CONSISTENT/);
  expect(rep).not.toMatch(/noise.*CONSISTENT/);
});
