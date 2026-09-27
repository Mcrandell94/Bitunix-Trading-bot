import { describe, expect, test } from 'vitest';
import { ema, macdHistogram, stochastic } from '../src/indicators';
import { DEFAULT_MOMENTUM, defaultConfig, runBacktest } from '../src/index';
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
  const mom = { ...cfg, tiers: { ...cfg.tiers, MTF: { ...cfg.tiers.MTF, enabled: false }, LTF: { ...cfg.tiers.LTF, model: 'momentum' as const, momentum: { ...DEFAULT_MOMENTUM, tpPct: 2, slPct: 1 } } } };
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

  test('the ATR-bracket variant and the bias-gated variant also run', () => {
    const atr = runBacktest(data, { ...mom, tiers: { ...mom.tiers, LTF: { ...mom.tiers.LTF, momentum: { ...DEFAULT_MOMENTUM, tpPct: null, slPct: null } } } });
    expect(atr.setupsSeen).toBe(r.setupsSeen);
    const gated = runBacktest(data, { ...mom, tiers: { ...mom.tiers, LTF: { ...mom.tiers.LTF, momentum: { ...DEFAULT_MOMENTUM, tpPct: null, slPct: null, useBias: true } } } });
    expect(gated.trades.length).toBeLessThanOrEqual(atr.trades.length);
  });
});
