import { describe, expect, test } from 'vitest';
import {
  DEFAULT_RISK, bracket, checkEntry, killzoneAt, nextFundingAfter, nyMinutes, sizePosition,
  type AccountState, type EntryIntent,
} from '../src/index';

const limits = { qtyStep: 0.001, minQty: 0.001 };
const flat: AccountState = { equity: 10_000, dayStartEquity: 10_000, realizedToday: { LTF: 0, MTF: 0 }, positions: [], pending: [] };
// 2026-01-06 08:00 New York (EST, UTC-5): inside the NY AM killzone.
const NY_AM = Date.UTC(2026, 0, 6, 13, 0);
const env = { time: NY_AM, nextFundingTime: Date.UTC(2026, 0, 6, 16, 0) };
const intent = (over: Partial<EntryIntent> = {}): EntryIntent => ({
  symbol: 'SOLUSDT', tier: 'MTF', side: 'long', bracket: bracket('long', 100, 98, 2), limits, ...over,
});

describe('sizing', () => {
  test('size from stop distance: 0.5% of 10k over a 2-point stop = 25 units', () => {
    expect(sizePosition({ equity: 10_000, riskPct: 0.5, entry: 100, stop: 98, maxEffectiveLeverage: 100, limits }))
      .toEqual({ qty: 25, notional: 2500, riskAmount: 50, cappedBy: 'risk' });
  });

  test('capped by effective leverage, rounded down to the step, rejected below the minimum', () => {
    // A 0.1-point stop would want 500 units ($50k); 3x of 10k allows 300.
    expect(sizePosition({ equity: 10_000, riskPct: 0.5, entry: 100, stop: 99.9, maxEffectiveLeverage: 3, limits }))
      .toMatchObject({ qty: 300, cappedBy: 'leverage' });
    expect(sizePosition({ equity: 10_000, riskPct: 0.25, entry: 60_000, stop: 59_100, maxEffectiveLeverage: 3, limits: { qtyStep: 0.001, minQty: 0.001 } })!.qty)
      .toBe(0.027); // 25 / 900 = 0.02777… → 0.027
    expect(sizePosition({ equity: 100, riskPct: 0.25, entry: 60_000, stop: 59_100, maxEffectiveLeverage: 3, limits })).toBeNull();
  });
});

describe('bracket', () => {
  test('every entry carries SL and TP on mark price', () => {
    expect(bracket('long', 100, 98, 2)).toEqual({ entry: 100, stop: 98, takeProfit: 104, trigger: 'MARK_PRICE' });
    expect(bracket('short', 100, 103, 2)).toEqual({ entry: 100, stop: 103, takeProfit: 94, trigger: 'MARK_PRICE' });
  });
});

describe('killzones (New York time, DST-aware)', () => {
  const zones = DEFAULT_RISK.tiers.LTF.killzones!;
  test('winter (EST) and summer (EDT) map to the same local windows', () => {
    expect(killzoneAt(Date.UTC(2026, 0, 6, 7, 0), zones)?.name).toBe('London'); // 02:00 EST
    expect(killzoneAt(Date.UTC(2026, 6, 7, 6, 0), zones)?.name).toBe('London'); // 02:00 EDT
    expect(killzoneAt(Date.UTC(2026, 0, 6, 12, 0), zones)?.name).toBe('New York AM'); // 07:00 EST
    expect(killzoneAt(Date.UTC(2026, 0, 6, 15, 0), zones)).toBeNull(); // 10:00: end is exclusive
    expect(killzoneAt(Date.UTC(2026, 0, 7, 1, 0), zones)?.name).toBe('Asia'); // 20:00 EST
    expect(killzoneAt(Date.UTC(2026, 0, 7, 4, 59), zones)?.name).toBe('Asia'); // 23:59
    expect(killzoneAt(Date.UTC(2026, 0, 7, 5, 0), zones)).toBeNull(); // 00:00
  });

  test('the DST switch day skips 02:00-03:00', () => {
    expect(nyMinutes(Date.UTC(2026, 2, 8, 6, 59))).toBe(1 * 60 + 59);
    expect(nyMinutes(Date.UTC(2026, 2, 8, 7, 0))).toBe(3 * 60);
  });
});

describe('funding settlements', () => {
  test('next settlement on the interval grid from 00:00 UTC', () => {
    expect(nextFundingAfter(Date.UTC(2026, 0, 6, 13, 0), 8)).toBe(Date.UTC(2026, 0, 6, 16, 0));
    expect(nextFundingAfter(Date.UTC(2026, 0, 6, 16, 0), 8)).toBe(Date.UTC(2026, 0, 7, 0, 0));
    expect(nextFundingAfter(Date.UTC(2026, 0, 6, 13, 30), 1)).toBe(Date.UTC(2026, 0, 6, 14, 0));
  });
});

describe('checkEntry', () => {
  test('a clean MTF long passes, sized from 0.5% risk', () => {
    expect(checkEntry(intent(), flat, env)).toEqual({ ok: true, killzone: null, sizing: { qty: 25, notional: 2500, riskAmount: 50, cappedBy: 'risk' } });
  });

  test('the bracket must be ordered and mark-price triggered', () => {
    expect(checkEntry(intent({ bracket: { entry: 100, stop: 101, takeProfit: 104, trigger: 'MARK_PRICE' } }), flat, env))
      .toEqual({ ok: false, reason: 'invalid-bracket' });
    expect(checkEntry(intent({ bracket: { ...bracket('long', 100, 98, 2), trigger: 'LAST_PRICE' as 'MARK_PRICE' } }), flat, env))
      .toEqual({ ok: false, reason: 'invalid-bracket' });
  });

  test('daily loss limits are per tier: MTF 3%, LTF 1.5%', () => {
    const lostMtf = { ...flat, realizedToday: { LTF: 0, MTF: -300 } };
    expect(checkEntry(intent(), lostMtf, env)).toEqual({ ok: false, reason: 'daily-loss-limit' });
    expect(checkEntry(intent(), { ...flat, realizedToday: { LTF: 0, MTF: -299 } }, env).ok).toBe(true);
    const withMtf = { ...flat, positions: [{ symbol: 'SOLUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 1, entry: 100 }] };
    expect(checkEntry(intent({ tier: 'LTF' }), { ...withMtf, realizedToday: { LTF: -150, MTF: 0 } }, env)).toEqual({ ok: false, reason: 'daily-loss-limit' });
  });

  test('LTF: only inside killzones, and only with a same-direction MTF position on the symbol', () => {
    const mtfLong = { ...flat, positions: [{ symbol: 'SOLUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 10, entry: 100 }] };
    expect(checkEntry(intent({ tier: 'LTF' }), flat, env)).toEqual({ ok: false, reason: 'ltf-needs-mtf-position' });
    expect(checkEntry(intent({ tier: 'LTF', side: 'short', bracket: bracket('short', 100, 102, 2) }), mtfLong, env))
      .toEqual({ ok: false, reason: 'ltf-needs-mtf-position' });
    const ok = checkEntry(intent({ tier: 'LTF' }), mtfLong, env);
    expect(ok).toMatchObject({ ok: true, killzone: 'New York AM', sizing: { qty: 12.5 } }); // 0.25% risk
    expect(checkEntry(intent({ tier: 'LTF' }), mtfLong, { ...env, time: Date.UTC(2026, 0, 6, 17, 0) })) // 12:00 NY
      .toEqual({ ok: false, reason: 'outside-killzone' });
  });

  test('no entries in the 15 minutes before funding', () => {
    expect(checkEntry(intent(), flat, { time: env.nextFundingTime - 14 * 60_000, nextFundingTime: env.nextFundingTime }))
      .toEqual({ ok: false, reason: 'funding-gap' });
    expect(checkEntry(intent(), flat, { time: env.nextFundingTime - 15 * 60_000, nextFundingTime: env.nextFundingTime }).ok).toBe(true);
  });

  test('one position per symbol per tier, counting pending entries', () => {
    const pending = { ...flat, pending: [{ symbol: 'SOLUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 1, entry: 100 }] };
    expect(checkEntry(intent(), pending, env)).toEqual({ ok: false, reason: 'already-open' });
  });

  test('BTC/ETH/XRP share one exposure cap across tiers: shrink to fit, else reject', () => {
    const btc = intent({ symbol: 'BTCUSDT', bracket: bracket('long', 100, 98, 2) });
    // 3x of 10k = 30k cap; 28k already used by ETH (MTF) and XRP (LTF) → 2k room.
    const used = { ...flat, positions: [
      { symbol: 'ETHUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 200, entry: 100 },
      { symbol: 'XRPUSDT', tier: 'LTF' as const, side: 'short' as const, qty: 80, entry: 100 },
    ] };
    expect(checkEntry(btc, used, env)).toMatchObject({ ok: true, sizing: { qty: 20, notional: 2000, cappedBy: 'core-cap' } });
    const full = { ...used, positions: [...used.positions, { symbol: 'XRPUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 20, entry: 100 }] };
    expect(checkEntry(btc, full, env)).toEqual({ ok: false, reason: 'core-exposure-cap' });
    // Non-core symbols don't count against it.
    expect(checkEntry(intent(), full, env).ok).toBe(true);
  });
});

describe('tunable rules', () => {
  test('stacking: up to maxPositionsPerSymbolTier same-direction positions per symbol per tier', () => {
    const one = { ...flat, positions: [{ symbol: 'SOLUSDT', tier: 'MTF' as const, side: 'long' as const, qty: 1, entry: 100 }] };
    expect(checkEntry(intent(), one, env)).toEqual({ ok: false, reason: 'already-open' });
    const stack = { ...DEFAULT_RISK, maxPositionsPerSymbolTier: 2 };
    expect(checkEntry(intent(), one, env, stack).ok).toBe(true);
    // Never the opposite way on the same symbol and tier.
    expect(checkEntry(intent({ side: 'short', bracket: bracket('short', 100, 102, 2) }), one, env, stack)).toEqual({ ok: false, reason: 'already-open' });
    const two = { ...one, positions: [...one.positions, ...one.positions] };
    expect(checkEntry(intent(), two, env, stack)).toEqual({ ok: false, reason: 'already-open' });
  });

  test('ltfRequiresMtf: false lets LTF trade on its own', () => {
    expect(checkEntry(intent({ tier: 'LTF' }), flat, env, { ...DEFAULT_RISK, ltfRequiresMtf: false }).ok).toBe(true);
  });
});
