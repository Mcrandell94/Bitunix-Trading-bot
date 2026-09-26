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

  test('with the old rule on, every LTF trade sits under an MTF trade in the same symbol and direction', () => {
    const old = runBacktest(syntheticMarket(DAYS, seed), { ...cfg, risk: { ...cfg.risk, ltfRequiresMtf: true } });
    for (const l of old.trades.filter((t) => t.tier === 'LTF')) {
      const parent = old.trades.find((m) => m.tier === 'MTF' && m.symbol === l.symbol && m.side === l.side && m.openedAt <= l.openedAt);
      expect(parent, `LTF trade ${l.id}`).toBeDefined();
    }
  });

  test('by default LTF and MTF trade independently', () => {
    const ltf = r.trades.filter((t) => t.tier === 'LTF');
    expect(ltf.length).toBeGreaterThan(0);
    expect(r.rejected.some((x) => x.reason === 'ltf-needs-mtf-position')).toBe(false);
  });

  test('the report renders', () => {
    expect(formatReport(r)).toContain('Setups not taken:');
  });
});

describe('radar (paper mode)', () => {
  const data = syntheticMarket(DAYS, 3);
  const cfg = defaultConfig(START + 30 * DAY, START + DAYS * DAY);
  const r = runBacktest(data, cfg, undefined, { closeAtEnd: false, radar: true });

  test('one row per symbol and enabled tier, with a status and a plain note', () => {
    const rows = r.radar!.rows;
    expect(rows).toHaveLength(Object.keys(data).length * 2);
    for (const x of rows) {
      expect(['in-position', 'order-pending', 'watching', 'ready', 'blocked']).toContain(x.status);
      expect(x.note.length).toBeGreaterThan(10);
      expect(x.bias.byTf).toHaveLength(2);
      if (x.core) expect(x.rrg).toBeNull();
      if (x.status === 'watching') expect(x.watch?.side).toBe(x.bias.combined);
      if (x.bias.combined === 'neutral' && x.status !== 'in-position' && x.status !== 'order-pending') expect(x.status).toBe('blocked');
    }
    const open = new Set(r.open.positions.map((p) => `${p.symbol}|${p.tier}`));
    for (const x of rows) expect(x.status === 'in-position').toBe(open.has(`${x.symbol}|${x.tier}`));
  });

  test('the radar changes nothing about trading', () => {
    const plain = runBacktest(data, cfg, undefined, { closeAtEnd: false });
    expect(plain.trades).toEqual(r.trades);
    expect(plain.open).toEqual(r.open);
  });
});

describe('research options on the real strategy', () => {
  const data = syntheticMarket(DAYS, 2);
  const cfg = defaultConfig(START + 10 * DAY, START + DAYS * DAY);
  const base = runBacktest(data, cfg);
  const core = new Set(cfg.risk.coreSymbols);

  test('RRG as a guide: extras may trade without a signal; required mode never does', () => {
    const guide = runBacktest(data, { ...cfg, extrasRrg: 'guide' });
    expect(base.trades.filter((t) => !core.has(t.symbol)).every((t) => t.source !== 'core')).toBe(true);
    expect(guide.trades.filter((t) => !core.has(t.symbol)).length).toBeGreaterThanOrEqual(base.trades.filter((t) => !core.has(t.symbol)).length);
    expect(guide.rejected.some((r) => r.reason === 'no RRG signal')).toBe(false);
  });

  test('stricter filters only remove trades, never add them', () => {
    for (const c of [{ ...cfg, minRoomR: 2 }, { ...cfg, biasCombine: 'both' as const }, { ...cfg, setup: { ...cfg.setup, allowIfvg: false } }]) {
      const r = runBacktest(data, c);
      expect(r.setupsSeen).toBeLessThanOrEqual(base.setupsSeen);
      const keys = new Set(base.trades.map((t) => `${t.symbol}|${t.tier}|${t.openedAt}`));
      // Most surviving trades are ones the baseline also took (different fills can shift a few).
      const kept = r.trades.filter((t) => keys.has(`${t.symbol}|${t.tier}|${t.openedAt}`)).length;
      expect(kept).toBeGreaterThanOrEqual(Math.floor(r.trades.length * 0.8));
    }
  });
});
