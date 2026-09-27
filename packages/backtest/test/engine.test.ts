import { describe, expect, test } from 'vitest';
import { defaultConfig, formatReport, runBacktest, summarize, type BacktestConfig, type SymbolData } from '../src/index';
import type { CandidateOverride } from '../src/engine';
import { explainLoss } from '../src/audit';
import { HOUR, Q, START, flatBars, symbolData, toCandles, type Bar } from './market';

const DAY = 24 * HOUR;
/** Orders are placed at this 1H close: Tue 2026-01-06 00:00 UTC (bar 96 is the first after it). */
const T = START + DAY;
const TOTAL_BARS = 3 * 96;

/** SOL: flat 100, then `after` from bar 96 on, then flat at the last close. */
function market(after: Bar[], solExtra: Partial<SymbolData> = {}): Record<string, SymbolData> {
  const sol = [...flatBars(96, 100), ...after];
  const last = sol[sol.length - 1]!.c;
  sol.push(...flatBars(TOTAL_BARS - sol.length, last));
  return {
    BTCUSDT: symbolData(toCandles(flatBars(TOTAL_BARS, 100))),
    ETHUSDT: symbolData(toCandles(flatBars(TOTAL_BARS, 100))),
    SOLUSDT: symbolData(toCandles(sol), solExtra),
  };
}

// These mechanics tests are written for market-order (taker) targets; the
// maker default has its own test below.
// They also pin the first risk settings (0.5% MTF risk, 3% daily), which the hand-computed numbers use.
function config(over: Partial<BacktestConfig> = {}): BacktestConfig {
  const c = defaultConfig(START, START + TOTAL_BARS * Q);
  const risk = { ...c.risk, ltfRequiresMtf: true, tiers: { LTF: { ...c.risk.tiers.LTF, riskPct: 0.25, dailyLossPct: 1.5 }, MTF: { ...c.risk.tiers.MTF, riskPct: 0.5, dailyLossPct: 3 }, HTF: { ...c.risk.tiers.HTF, riskPct: 0.5, dailyLossPct: 3 } } };
  // The engine tests were written for the MTF tier alone.
  return { ...c, risk, targetFill: 'taker', tiers: { ...c.tiers, LTF: { ...c.tiers.LTF, enabled: false }, MTF: { ...c.tiers.MTF, enabled: true }, HTF: { ...c.tiers.HTF, enabled: false } }, ...over };
}

const once = (at: number, side: 'long' | 'short', entry: number, stop: number): CandidateOverride =>
  ({ tier, symbol, time }) => (tier === 'MTF' && symbol === 'SOLUSDT' && time === at ? { side, entry, stop, source: 'core' } : null);

const slipDown = (p: number) => p * (1 - 2 / 10_000);
const slipUp = (p: number) => p * (1 + 2 / 10_000);

function expectBooksBalance(r: ReturnType<typeof runBacktest>) {
  const net = r.trades.reduce((a, t) => a + t.netPnl, 0);
  expect(r.endEquity - r.config.startEquity).toBeCloseTo(net, 8);
}

describe('MTF trade lifecycle', () => {
  test('limit fill (maker) → 1R and 2R partials (taker, slipped) → breakeven stop, paying funding', () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 }, // fills the 99 limit
      { o: 99.5, h: 101.2, l: 99.4, c: 101 }, // 1R: a third off, stop to entry
      { o: 101, h: 103.1, l: 100.8, c: 103 }, // 2R: another third
      ...flatBars(40, 103), // holds through the 08:00 funding
      { o: 103, h: 103, l: 98.5, c: 98.8 }, // back through entry: breakeven stop
    ]), config(), once(T, 'long', 99, 97));

    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    // 0.5% of 10,000 over a 2-point stop.
    expect(t).toMatchObject({ symbol: 'SOLUSDT', tier: 'MTF', side: 'long', source: 'core', qty: 25, entry: 99, initialStop: 97, riskAmount: 50 });
    expect(t.fills.map((f) => [f.reason, f.qty])).toEqual([['entry', 25], ['partial', 8.333], ['partial', 8.333], ['stop', 8.334]]);
    expect(t.fills[1]!.price).toBeCloseTo(slipDown(101), 10);
    expect(t.fills[2]!.price).toBeCloseTo(slipDown(103), 10);
    expect(t.fills[3]!.price).toBeCloseTo(slipDown(99), 10);

    const gross = 8.333 * (slipDown(101) - 99) + 8.333 * (slipDown(103) - 99) + 8.334 * (slipDown(99) - 99);
    const fees = 25 * 99 * 0.0002 + (8.333 * slipDown(101) + 8.333 * slipDown(103) + 8.334 * slipDown(99)) * 0.0006;
    const funding = -8.334 * 103 * 0.0001; // one 08:00 settlement at the default 0.01%
    expect(t.grossPnl).toBeCloseTo(gross, 8);
    expect(t.fees).toBeCloseTo(fees, 8);
    expect(t.funding).toBeCloseTo(funding, 8);
    expect(t.netPnl).toBeCloseTo(gross - fees + funding, 8);
    expect(t.r).toBeCloseTo((gross - fees + funding) / 50, 8);
    expectBooksBalance(r);
  });

  test('a stop-out loses about 1R plus costs', () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 },
      { o: 99.5, h: 99.6, l: 96.5, c: 96.8 },
    ]), config(), once(T, 'long', 99, 97));
    const t = r.trades[0]!;
    expect(t.fills.map((f) => f.reason)).toEqual(['entry', 'stop']);
    expect(t.fills[1]!.price).toBeCloseTo(slipDown(97), 10);
    expect(t.r).toBeLessThan(-1);
    expect(t.r).toBeGreaterThan(-1.1);
    expectBooksBalance(r);
  });

  test('pessimistic: a fill bar that also reaches the stop is stopped out, even if it hit the target too', () => {
    const r = runBacktest(market([{ o: 100, h: 112, l: 96, c: 100 }]), config(), once(T, 'long', 99, 97));
    expect(r.trades[0]!.fills.map((f) => f.reason)).toEqual(['entry', 'stop']);
  });

  test('a bar that opens through the limit fills at the open, as taker', () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 99.6, c: 99.7 },
      { o: 98.6, h: 98.8, l: 98.2, c: 98.5 }, // gapped below 99
      { o: 98.5, h: 99, l: 96.5, c: 96.6 },
    ]), config(), once(T, 'long', 99, 97));
    const entry = r.trades[0]!.fills[0]!;
    expect(entry.price).toBeCloseTo(slipUp(98.6), 10);
    expect(entry.fee).toBeCloseTo(slipUp(98.6) * 25 * 0.0006, 10);
  });

  test('an order never touched expires after 6 entry bars', () => {
    const r = runBacktest(market(flatBars(40, 100)), config(), once(T, 'long', 99, 97));
    expect(r.trades).toEqual([]);
    expect(r.expired).toBe(1);
  });

  test('shorts mirror longs', () => {
    const r = runBacktest(market([
      { o: 100, h: 101.1, l: 100, c: 100.5 }, // fills the 101 short
      { o: 100.5, h: 100.6, l: 96.5, c: 96.8 }, // past 2R (97): two partials
      { o: 96.8, h: 103.5, l: 96.7, c: 103.2 }, // back above entry: breakeven stop
    ]), config(), once(T, 'short', 101, 103));
    const t = r.trades[0]!;
    expect(t.side).toBe('short');
    expect(t.fills.map((f) => f.reason)).toEqual(['entry', 'partial', 'partial', 'stop']);
    expect(t.fills[1]!.price).toBeCloseTo(slipUp(99), 10);
    expect(t.fills[3]!.price).toBeCloseTo(slipUp(101), 10);
    expect(t.grossPnl).toBeGreaterThan(0);
    expectBooksBalance(r);
  });
});

describe('funding', () => {
  test('uses the settlement history when given: longs pay positive rates, receive negative ones', () => {
    const funding = [
      { time: T + 8 * HOUR, rate: 0.0003 },
      { time: T + 16 * HOUR, rate: -0.0005 },
    ];
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 },
      ...flatBars(80, 99.5), // held past both settlements, below 1R
      { o: 99.5, h: 99.6, l: 96.5, c: 96.8 },
    ], { funding }), config(), once(T, 'long', 99, 97));
    const t = r.trades[0]!;
    expect(t.funding).toBeCloseTo(-25 * 99.5 * 0.0003 + 25 * 99.5 * 0.0005, 8);
    expect(r.warnings.join(' ')).toContain('no funding history'); // BTC/ETH still have none
    expectBooksBalance(r);
  });
});

describe('risk rules inside the engine', () => {
  test('a tier that hit its daily loss limit takes no more entries until the next UTC day', () => {
    const cfg = config();
    const risky = { ...cfg, risk: { ...cfg.risk, tiers: { ...cfg.risk.tiers, MTF: { ...cfg.risk.tiers.MTF, riskPct: 3.5 } } } };
    const orders: CandidateOverride = ({ tier, symbol, time }) =>
      tier === 'MTF' && symbol === 'SOLUSDT' && [T, T + 3 * HOUR, T + DAY].includes(time)
        ? { side: 'long', entry: 99, stop: 97, source: 'core' } : null;
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 },
      { o: 99.5, h: 99.6, l: 96.5, c: 96.8 }, // -3.5% on day one
      ...flatBars(4, 99.5),
    ]), risky, orders);
    expect(r.trades).toHaveLength(1);
    expect(r.rejected).toEqual([{ time: T + 3 * HOUR, symbol: 'SOLUSDT', tier: 'MTF', reason: 'daily-loss-limit' }]);
    expect(r.expired).toBe(1); // the next day's order was allowed (and never filled)
  });

  test('LTF entries need an open MTF position in the same direction', () => {
    const c = config();
    const cfg = { ...c, tiers: { ...c.tiers, LTF: { ...c.tiers.LTF, enabled: true } } };
    // 13:00 UTC = 08:00 New York: inside the NY AM killzone.
    const at = T + 13 * HOUR;
    const ltf: CandidateOverride = ({ tier, symbol, time }) =>
      tier === 'LTF' && symbol === 'SOLUSDT' && time === at ? { side: 'long', entry: 99, stop: 98, source: 'core' } : null;
    const r = runBacktest(market([]), cfg, ltf);
    expect(r.rejected).toEqual([{ time: at, symbol: 'SOLUSDT', tier: 'LTF', reason: 'ltf-needs-mtf-position' }]);
  });
});

describe('report', () => {
  test('summarizes by tier and source', () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 },
      { o: 99.5, h: 99.6, l: 96.5, c: 96.8 },
    ]), config(), once(T, 'long', 99, 97));
    const s = summarize(r);
    expect(s.overall.trades).toBe(1);
    expect(s.byTier.MTF!.trades).toBe(1);
    expect(Object.keys(s.bySource)).toEqual(['MTF core']);
    expect(s.maxDrawdown).toBeGreaterThan(0.005);
    const text = formatReport(r);
    expect(text).toContain('MTF core');
    expect(text).toMatch(/Max drawdown \d/);
  });
});

describe('tuning options', () => {
  test('minStopPct skips setups whose stop is too tight for fees', () => {
    // A 0.2% stop (99 → 98.8) is skipped at minStopPct 0.3.
    const r = runBacktest(market([{ o: 100, h: 100, l: 98.9, c: 99.5 }]), config({ minStopPct: 0.3 }), once(T, 'long', 99, 98.8));
    expect(r.rejected).toEqual([{ time: T, symbol: 'SOLUSDT', tier: 'MTF', reason: 'stop too tight' }]);
    expect(runBacktest(market([{ o: 100, h: 100, l: 98.9, c: 99.5 }]), config({ minStopPct: 0.3 }), once(T, 'long', 99, 97)).rejected).toEqual([]);
  });

  test("targetFill 'maker': partials fill at the level exactly, with the maker fee", () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 },
      { o: 99.5, h: 101.2, l: 99.4, c: 101 },
      { o: 101, h: 101, l: 96.5, c: 96.8 },
    ]), config({ targetFill: 'maker' }), once(T, 'long', 99, 97));
    const partial = r.trades[0]!.fills[1]!;
    expect(partial).toMatchObject({ reason: 'partial', price: 101 });
    expect(partial.fee).toBeCloseTo(101 * partial.qty * 0.0002, 10);
    // The stop is still a market fill with slippage.
    expect(r.trades[0]!.fills[2]!.price).toBeCloseTo(slipDown(99), 10);
    expectBooksBalance(r);
  });
});

describe('dashboard pauses (entriesBlocked)', () => {
  test('a setup found while paused is rejected with the pause reason and never placed', () => {
    const blocked = (tier: string, time: number) => (tier === 'MTF' && time >= T ? 'entries paused from the dashboard (MTF)' : null);
    const r = runBacktest(market([{ o: 100, h: 100, l: 98.9, c: 99.5 }]), config(), once(T, 'long', 99, 97), { closeAtEnd: true, entriesBlocked: blocked });
    expect(r.trades).toEqual([]);
    expect(r.rejected).toEqual([{ time: T, symbol: 'SOLUSDT', tier: 'MTF', reason: 'entries paused from the dashboard (MTF)' }]);
    // Before the pause window the same setup trades.
    const early = (tier: string, time: number) => (time > T ? 'paused' : null);
    expect(runBacktest(market([{ o: 100, h: 100, l: 98.9, c: 99.5 }]), config(), once(T, 'long', 99, 97), { closeAtEnd: true, entriesBlocked: early }).trades).toHaveLength(1);
  });
});

describe('T3 fill realism (docs/backtest/TASKS.md)', () => {
  const limits = { limits: { qtyStep: 0.001, minQty: 0.001, priceTick: 0.01 } };

  test('a touch fills the limit in the baseline; with fill realism it needs a trade-through by one tick', () => {
    const touch = market([{ o: 100, h: 100, l: 99, c: 99.5 }, { o: 99.5, h: 99.6, l: 99.4, c: 99.5 }], limits);
    expect(runBacktest(touch, config(), once(T, 'long', 99, 97)).trades).toHaveLength(1); // closed at the end of the run
    const real = runBacktest(touch, config({ fillRealism: true }), once(T, 'long', 99, 97));
    expect(real.trades).toHaveLength(0);
    const through = market([{ o: 100, h: 100, l: 98.99, c: 99.5 }], limits);
    const r2 = runBacktest(through, config({ fillRealism: true }), once(T, 'long', 99, 97));
    expect(r2.trades).toHaveLength(1);
  });

  test('fills say where their price came from; a gapped stop fills at the open and the audit explains the loss', () => {
    const r = runBacktest(market([
      { o: 100, h: 100, l: 98.9, c: 99.5 }, // fills the 99 limit at its level
      { o: 90, h: 90.5, l: 89, c: 90 }, // opens 7% below the 97 stop
    ]), config(), once(T, 'long', 99, 97));
    const t = r.trades[0]!;
    expect(t.fills[0]).toMatchObject({ reason: 'entry', from: 'level' });
    expect(t.fills[1]).toMatchObject({ reason: 'stop', from: 'open' });
    expect(t.r).toBeLessThan(-3);
    const row = explainLoss(t, market([{ o: 100, h: 100, l: 98.9, c: 99.5 }, { o: 90, h: 90.5, l: 89, c: 90 }]));
    expect(row.exitFrom).toBe('open');
    expect(row.gapR).toBeGreaterThan(3); // (97 - ~90) / 2
    expect(row.bar).toMatchObject({ open: 90, low: 89 });
    expect(row.cause).toMatch(/gapped/);
  });
});
