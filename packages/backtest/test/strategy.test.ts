// The real strategy (setup + bias + RRG gate + risk), end to end on a
// synthetic 120-day, 5-symbol market. These check invariants, not returns:
// synthetic prices say nothing about how the strategy does on real ones.
import { describe, expect, test } from 'vitest';
import { defaultConfig, formatReport, runBacktest } from '../src/index';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAYS = 120;
const DAY = 86_400_000;

describe.each([2, 5])('real strategy, synthetic market seed %i', (seed) => {
  const cfg = defaultConfig(START + 10 * DAY, START + DAYS * DAY);
  const r = runBacktest(syntheticMarket(DAYS, seed), cfg);

  test('it trades, and the books balance', () => {
    expect(r.trades.length).toBeGreaterThan(3);
    const net = r.trades.reduce((a, t) => a + t.netPnl, 0);
    expect(r.endEquity - cfg.startEquity).toBeCloseTo(net, 6);
    for (const t of r.trades) {
      expect(Number.isFinite(t.r)).toBe(true);
      expect(t.fills[0]!.reason).toBe('entry');
      expect(t.fills.slice(1).reduce((a, f) => a + f.qty, 0)).toBeCloseTo(t.qty, 9);
      expect(t.openedAt).toBeGreaterThan(cfg.from);
    }
  });

  test('no trade risks more than its tier allows (at the highest equity reached)', () => {
    const peak = Math.max(cfg.startEquity, ...r.equityCurve.map((p) => p.equity));
    for (const t of r.trades) {
      expect(t.riskAmount).toBeLessThanOrEqual((cfg.risk.tiers[t.tier].riskPct / 100) * peak * 1.02);
    }
  });

  test('extras only trade on an RRG signal; BTC/ETH/XRP on bias alone', () => {
    for (const t of r.trades) {
      if (cfg.risk.coreSymbols.includes(t.symbol)) expect(t.source).toBe('core');
      else expect(t.source).not.toBe('core');
    }
  });

  test('every LTF trade sits under an MTF trade in the same symbol and direction', () => {
    for (const l of r.trades.filter((t) => t.tier === 'LTF')) {
      const parent = r.trades.find((m) => m.tier === 'MTF' && m.symbol === l.symbol && m.side === l.side && m.openedAt <= l.openedAt);
      expect(parent, `LTF trade ${l.id}`).toBeDefined();
    }
  });

  test('the report renders', () => {
    expect(formatReport(r)).toContain('Setups not taken:');
  });
});
