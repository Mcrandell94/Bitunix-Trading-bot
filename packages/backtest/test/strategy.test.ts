// The real strategy (setup + bias + RRG gate + risk), end to end on a
// synthetic 120-day, 5-symbol market. These check invariants, not returns:
// synthetic prices say nothing about how the strategy does on real ones.
import { describe, expect, test } from 'vitest';
import { FOMC_TIMES, defaultConfig, formatReport, runBacktest } from '../src/index';
import { attribution, formatAttribution } from '../src/attribution';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAYS = 120;
const DAY = 86_400_000;

describe.each([2, 5])('real strategy, synthetic market seed %i', (seed) => {
  // LTF is off by default since 2026-09-27; these invariants still cover it, so switch it on here.
  const base = defaultConfig(START + 10 * DAY, START + DAYS * DAY);
  const cfg = { ...base, tiers: { ...base.tiers, LTF: { ...base.tiers.LTF, enabled: true } } };
  const r = runBacktest(syntheticMarket(DAYS, seed), cfg);

  test('LTF and HTF are off by default (owner, 2026-09-27); only MTF trades', () => {
    expect(base.tiers.LTF.enabled).toBe(false);
    expect(base.tiers.HTF.enabled).toBe(false);
    expect(base.tiers.MTF.enabled).toBe(true);
    expect(runBacktest(syntheticMarket(DAYS, seed), base).trades.every((t) => t.tier === 'MTF')).toBe(true);
  });

  test('HTF trades when switched on', () => {
    const on = { ...base, tiers: { ...base.tiers, HTF: { ...base.tiers.HTF, enabled: true } } };
    const r2 = runBacktest(syntheticMarket(DAYS, seed), on);
    expect(r2.trades.some((t) => t.tier === 'HTF')).toBe(true);
  });

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

  test('LTF and MTF trade independently', () => {
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
    // Only MTF is on by default.
    expect(rows).toHaveLength(Object.keys(data).length);
    expect(rows.every((x) => x.tier === 'MTF')).toBe(true);
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

describe('win-rate filters (round 3)', () => {
  const data = syntheticMarket(DAYS, 2);
  const cfg = defaultConfig(START + 10 * DAY, START + DAYS * DAY);
  const base = runBacktest(data, cfg);

  test('every filter only removes setups, and records why', () => {
    const variants: [string, Partial<typeof cfg.filters>][] = [
      ['volatility', { atrRegime: { lookback: 200, minPct: 30, maxPct: 90 } }],
      ['zone', { htfZone: 'higher' }],
      ['ema', { emaTrend: 50 }],
      ['btc', { btcGate: true }],
    ];
    for (const [name, f] of variants) {
      const r = runBacktest(data, { ...cfg, filters: { ...cfg.filters, ...f } });
      expect(r.setupsSeen, name).toBe(base.setupsSeen);
      expect(r.trades.length, name).toBeLessThanOrEqual(base.trades.length);
      const kept = new Set(base.trades.map((t) => `${t.symbol}|${t.tier}|${t.openedAt}`));
      expect(r.trades.filter((t) => kept.has(`${t.symbol}|${t.tier}|${t.openedAt}`)).length, name).toBeGreaterThanOrEqual(Math.floor(r.trades.length * 0.8));
    }
    const zone = runBacktest(data, { ...cfg, filters: { ...cfg.filters, htfZone: 'higher' } });
    expect(zone.rejected.some((x) => /zone/.test(x.reason))).toBe(true);
  });

  test('bigger swings mean fewer setups', () => {
    const big = runBacktest(data, { ...cfg, structure: { ...cfg.structure, swingLeft: 5, swingRight: 5 } });
    expect(big.setupsSeen).toBeLessThan(base.setupsSeen);
  });

  test('FOMC blackout: statement times parse to 14:00 New York, and block entries around them', () => {
    expect(FOMC_TIMES.every((t) => Number.isFinite(t))).toBe(true);
    expect(new Date(FOMC_TIMES[0]!).toISOString()).toBe('2024-01-31T19:00:00.000Z'); // winter: 14:00 EST
    expect(new Date(FOMC_TIMES[3]!).toISOString()).toBe('2024-06-12T18:00:00.000Z'); // summer: 14:00 EDT
    const r = runBacktest(data, { ...cfg, filters: { ...cfg.filters, fomcBlackoutMinutes: 60 } });
    expect(r.trades.length).toBeLessThanOrEqual(base.trades.length);
  });

  test('attribution buckets cover every trade', () => {
    const a = attribution(base.trades);
    for (const buckets of Object.values(a)) expect(buckets.reduce((n, b) => n + b.trades, 0)).toBe(base.trades.length);
    expect(formatAttribution(a)).toContain('ATTRIBUTION');
  });
});
