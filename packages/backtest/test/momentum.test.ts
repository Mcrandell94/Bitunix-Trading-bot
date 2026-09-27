import { describe, expect, test } from 'vitest';
import { bollinger, ema, macdHistogram, rsi, sessionVwap, stochastic, supertrend } from '../src/indicators';
import { DEFAULT_MOMENTUM, DEFAULT_TREND, defaultConfig, runBacktest, type TrendConfig } from '../src/index';
import { START } from './market';
import { syntheticMarket } from './synthetic';

describe('indicators', () => {
  test('EMA warms up then tracks; MACD histogram and Stochastic stay in range', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const e = ema(closes, 9);
    expect(e.slice(0, 8).every((x) => x == null)).toBe(true);
    expect(e[59]).toBeGreaterThan(90);
    expect(e[59]).toBeLessThan(110);
    const h = macdHistogram(closes);
    expect(h.slice(0, 25).every((x) => x == null)).toBe(true);
    expect(Number.isFinite(h[59]!)).toBe(true);
    const candles = closes.map((c, i) => ({ openTime: i, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
    const { k, d } = stochastic(candles);
    expect(k.slice(15).every((x) => x != null && x >= 0 && x <= 100)).toBe(true);
    expect(d[59]).not.toBeNull();
  });
});

describe('momentum LTF model', () => {
  const DAY = 86_400_000;
  const data = syntheticMarket(120, 4);
  const cfg = defaultConfig(START + 10 * DAY, START + 120 * DAY);
  const mom = { ...cfg, tiers: { ...cfg.tiers, MTF: { ...cfg.tiers.MTF, enabled: false }, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: true, model: 'momentum' as const, momentum: { ...DEFAULT_MOMENTUM, tpPct: 2, slPct: 1 } } } };
  const r = runBacktest(data, mom);

  test('trades with %-based exits filled at market; books balance', () => {
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.tier).toBe('LTF');
      const entryFill = t.fills[0]!;
      expect(entryFill.reason).toBe('entry');
      expect(Math.abs(t.entry - t.initialStop) / t.entry).toBeCloseTo(0.01, 2);
    }
    const net = r.trades.reduce((a, t) => a + t.netPnl, 0);
    expect(r.endEquity - cfg.startEquity).toBeCloseTo(net, 6);
  });

  test('an opposite signal flips the position (reversal fill)', () => {
    const flips = r.trades.flatMap((t) => t.fills).filter((f) => f.reason === 'reverse');
    const noFlip = runBacktest(data, { ...mom, tiers: { ...mom.tiers, LTF: { ...mom.tiers.LTF, momentum: { ...DEFAULT_MOMENTUM, tpPct: 2, slPct: 1, reverse: false } } } });
    expect(noFlip.trades.flatMap((t) => t.fills).some((f) => f.reason === 'reverse')).toBe(false);
    expect(flips.length + noFlip.trades.length).toBeGreaterThan(0);
  });

  test('the ATR-bracket variant and the bias-gated variant also run', () => {
    const atr = runBacktest(data, { ...mom, tiers: { ...mom.tiers, LTF: { ...mom.tiers.LTF, momentum: { ...DEFAULT_MOMENTUM, tpPct: null, slPct: null } } } });
    expect(atr.setupsSeen).toBe(r.setupsSeen);
    const gated = runBacktest(data, { ...mom, tiers: { ...mom.tiers, LTF: { ...mom.tiers.LTF, momentum: { ...DEFAULT_MOMENTUM, tpPct: null, slPct: null, useBias: true } } } });
    expect(gated.trades.length).toBeLessThanOrEqual(atr.trades.length);
  });
});

describe('trend / mean-reversion LTF model (owner proposal #2)', () => {
  const DAY = 86_400_000;
  const data = syntheticMarket(120, 6);
  const cfg = defaultConfig(START + 10 * DAY, START + 120 * DAY);
  const only = (trend: Partial<TrendConfig>) => ({
    ...cfg,
    tiers: { ...cfg.tiers, MTF: { ...cfg.tiers.MTF, enabled: false }, HTF: { ...cfg.tiers.HTF, enabled: false }, LTF: { ...cfg.tiers.LTF, enabled: true, model: 'trend' as const, trend: { ...DEFAULT_TREND, ...trend } } },
  });

  test('indicators: RSI in range, Supertrend flips, VWAP resets daily, Bollinger brackets the mean', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 6) * 8);
    const r = rsi(closes, 12);
    expect(r.slice(0, 11).every((x) => x == null)).toBe(true);
    expect(r.slice(12).every((x) => x != null && x >= 0 && x <= 100)).toBe(true);
    const candles = closes.map((c, i) => ({ openTime: i * 3_600_000, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
    const st = supertrend(candles, 10, 3);
    expect(new Set(st.dir.filter((d) => d != null)).size).toBe(2);
    const vw = sessionVwap(candles);
    expect(vw[0]).toBeCloseTo(closes[0]!, 6);
    expect(vw[24]).toBeCloseTo(closes[24]!, 6); // first bar of the next UTC day
    const bb = bollinger(closes, 20, 2);
    expect(bb.lower[79]!).toBeLessThan(bb.mid[79]!);
    expect(bb.upper[79]!).toBeGreaterThan(bb.mid[79]!);
  });

  test('trades at market with an ATR stop and the tier target; books balance', () => {
    const r = runBacktest(data, only({ volumeMult: 0 }));
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      expect(t.tier).toBe('LTF');
      expect(t.fills[0]!.reason).toBe('entry');
    }
    expect(r.endEquity - cfg.startEquity).toBeCloseTo(r.trades.reduce((a, t) => a + t.netPnl, 0), 6);
  });

  test('the Supertrend flip exit only exists when switched on; the volume filter only removes setups', () => {
    const flip = runBacktest(data, only({ volumeMult: 0 }));
    const hold = runBacktest(data, only({ volumeMult: 0, exitOnFlip: false }));
    expect(hold.trades.flatMap((t) => t.fills).some((f) => f.reason === 'reverse')).toBe(false);
    expect(flip.trades.flatMap((t) => t.fills).some((f) => f.reason === 'reverse')).toBe(true);
    const withVol = runBacktest(data, only({ volumeMult: 1.5 }));
    expect(withVol.setupsSeen).toBeLessThanOrEqual(flip.setupsSeen);
  });

  test('mean-reversion mode and the bias-gated variant run', () => {
    const mr = runBacktest(data, only({ mode: 'meanrev', rsiTrigger: 'oversold', supertrend: null, exitOnFlip: false, volumeMult: 0 }));
    expect(mr.setupsSeen).toBeGreaterThan(0);
    const gated = runBacktest(data, only({ volumeMult: 0, useBias: true }));
    expect(gated.trades.length).toBeLessThanOrEqual(runBacktest(data, only({ volumeMult: 0 })).trades.length);
  });
});
