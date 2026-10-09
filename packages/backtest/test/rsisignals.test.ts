import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { RSI_MODELS, SIGNAL_EXITS, isSignalRow, rsiFrameworkSignals, signalExitName } from '../src/screen/rsisignals';

const DAY = 86_400_000, H4 = 4 * 3_600_000;

/** A seeded random walk with big swings, so RSI reaches its extremes. */
function walk(n: number, step: number, seed = 7): Candle[] {
  let s = seed, px = 100;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const t0 = Date.UTC(2023, 0, 2);
  return Array.from({ length: n }, (_, i) => {
    const drift = 0.04 * Math.sin(i / 37);
    const o = px;
    px = Math.max(1, px * (1 + drift + (rnd() - 0.5) * 0.12));
    return { openTime: t0 + i * step, open: o, high: Math.max(o, px) * (1 + rnd() * 0.02), low: Math.min(o, px) * (1 - rnd() * 0.02), close: px, volume: 1 };
  });
}

describe('RSI framework live signals', () => {
  const d1 = walk(900, DAY), h4 = walk(3000, H4, 11);
  const now = d1.at(-1)!.openTime + DAY;
  const rows = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 400);

  test('exactly the 9 live models: the 6 kept after the pooled grid, the 2 failure-swing shorts (owner 2026-10-04) and 15M-RSI10 (2026-10-06)', () => {
    expect((Object.keys(RSI_MODELS) as (keyof typeof RSI_MODELS)[]).filter((m) => !RSI_MODELS[m].dropped).sort()).toEqual(['15m-rsi10', '4h-fail-short', 'bottom-div', 'd-fail-short', 'triple-div', 'under-floor', 'w-bear-div', 'w-dbl-bottom', 'w-top-div']);
  });
  test('produces rows with consistent fields', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.side).toBe(RSI_MODELS[r.model].side);
      expect(RSI_MODELS[r.model].dropped).toBeUndefined(); // dropped models never signal
      if (r.status === 'closed') { expect(r.exit).not.toBeNull(); expect(r.closedAt).not.toBeNull(); expect(r.r).not.toBeNull(); }
      if (r.status === 'open' || r.status === 'enter') expect(r.stop).not.toBeNull();
      if (r.status === 'enter' && r.stop != null && r.entry != null) expect(r.side === 'long' ? r.stop < r.entry : r.stop > r.entry).toBe(true); // a trailing stop can move past the entry later
    }
  });

  test('no look-ahead: a trade closed before a cut-off reads the same with more data', () => {
    const cut = 700, d1c = d1.slice(0, cut), h4c = h4.filter((b) => b.openTime + H4 <= d1c.at(-1)!.openTime + DAY);
    const nowC = d1c.at(-1)!.openTime + DAY;
    const early = rsiFrameworkSignals('TESTUSDT', d1c, h4c, nowC, 10_000).filter((r) => r.status === 'closed');
    const later = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000);
    expect(early.length).toBeGreaterThan(0);
    for (const r of early) expect(later).toContainEqual({ ...r, lastPrice: later.find((x) => x.signalAt === r.signalAt && x.model === r.model)?.lastPrice ?? -1 });
  });
});

describe('live signals: one rule set, one exit per model, no time limit (owner 2026-10-09)', () => {
  const d1 = walk(900, DAY), h4 = walk(3000, H4, 11);
  const now = d1.at(-1)!.openTime + DAY;
  const all = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000);
  const live = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000, [], { live: true });

  test('one row per trade: option 1, the model\'s own exit by name, never a time exit', () => {
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(all.length);
    for (const r of live) {
      expect(r.plans).toEqual(['option 1']);
      expect(isSignalRow(r)).toBe(true);
      expect(r.exitName).toBe(signalExitName(r.model));
      expect(r.exit).not.toBe('time');
      if (r.status !== 'waiting') expect(r.until).toBeNull(); // a waiting setup still expires; a trade has no time limit
    }
    const keys = live.map((r) => `${r.model}|${r.signalAt}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every live model has one exit without a time limit; isSignalRow picks its rows out of an old snapshot', () => {
    for (const m of Object.keys(RSI_MODELS) as (keyof typeof RSI_MODELS)[]) {
      if (RSI_MODELS[m].dropped) continue;
      expect(SIGNAL_EXITS[m]).toBeDefined();
      expect(SIGNAL_EXITS[m]!.exit.spec.cap).toBeUndefined();
    }
    const old = all.filter(isSignalRow);
    expect(old.length).toBeGreaterThan(0);
    for (const r of old) expect(r.variant).toBe(SIGNAL_EXITS[r.model]!.variant);
  });
});

describe('failure-swing short setups', () => {
  test('only shorts, only while the daily RSI is under 50, stop above the entry', async () => {
    const { frameworkSetups } = await import('../src/screen/rsisignals');
    const { rsi } = await import('../src/indicators');
    const DAY = 86_400_000, H4 = DAY / 6;
    const mk = (n: number, bar: number, k: number) => Array.from({ length: n }, (_, i) => { const p = 100 + 12 * Math.sin(i / k) - i * (bar === DAY ? 0.03 : 0.005); return { openTime: i * bar, open: p, high: p + 1.5, low: p - 1.5, close: p + 0.8 * Math.sin(i * 1.7), volume: 1 }; });
    const d1 = mk(700, DAY, 7), h4 = mk(4200, H4, 9), dr = rsi(d1.map((b) => b.close), 14);
    const s = frameworkSetups(d1, h4).filter((x) => x.model === 'd-fail-short' || x.model === '4h-fail-short');
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) {
      expect(x.d).toBe(-1);
      expect(x.stop!).toBeGreaterThan(x.c[Math.min(x.j!, x.c.length - 1)]!.low);
      let k = -1; for (let q = d1.length - 1; q >= 0; q--) if (d1[q]!.openTime + DAY <= x.known) { k = q; break; }
      expect(dr[k]!).toBeLessThan(50);
    }
  });
});

describe('option 1 / no-exceptions rules (owner 2026-10-04)', () => {
  const d1 = walk(900, DAY), h4 = walk(3000, H4, 11);
  const now = d1.at(-1)!.openTime + DAY;
  // BTC: a steady fall, so its close is always under the 50-day SMA (shorts allowed); and a steady rise (shorts blocked).
  const btc = (dir: 1 | -1) => Array.from({ length: 900 }, (_, i) => { const p = 1000 + dir * i; return { openTime: d1[0]!.openTime + i * DAY, open: p, high: p + 1, low: p - 1, close: p, volume: 1 }; });

  test('no short is entered while BTC is over its 50-day SMA or BTC is unknown; longs do not change', async () => {
    const { btcBearishAt } = await import('../src/screen/rsisignals');
    const { sma } = await import('../src/indicators');
    const down = btc(-1), up = btc(1);
    expect(btcBearishAt(down, sma(down.map((b) => b.close), 50), now)).toBe(true);
    expect(btcBearishAt(up, sma(up.map((b) => b.close), 50), now)).toBe(false);
    expect(btcBearishAt([], [], now)).toBe(false);
    const bear = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000, down), bull = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000, up);
    const none = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000);
    const entered = (rs: typeof bear, side: string) => rs.filter((r) => r.side === side && r.status !== 'waiting');
    expect(entered(bear, 'short').length).toBeGreaterThan(0);
    expect(entered(bull, 'short')).toEqual([]);
    expect(entered(none, 'short')).toEqual([]);
    expect(entered(bull, 'long')).toEqual(entered(bear, 'long'));
  });

  test('every row names its rule sets; breakeven and skip-late follow the plan', async () => {
    const { runBeforeEntry, planUsesBe, planSkipsLate, frameworkSetups } = await import('../src/screen/rsisignals');
    expect(planUsesBe('option 1', 'under-floor')).toBe(false);
    expect(planUsesBe('no exceptions', 'under-floor')).toBe(true);
    expect(planSkipsLate('option 1', 'd-fail-short')).toBe(false);
    expect(planSkipsLate('no exceptions', 'd-fail-short')).toBe(true);
    expect(planUsesBe('option 1', 'bottom-div') && planSkipsLate('option 1', 'bottom-div')).toBe(true);
    const rows = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000, btc(-1));
    const setups = frameworkSetups(d1, h4);
    for (const r of rows) {
      expect(r.plans.length).toBeGreaterThan(0);
      for (const p of r.plans) expect(r.exitName.includes('breakeven at +2R')).toBe(planUsesBe(p, r.model));
      if (r.enteredAt == null) continue;
      const s = setups.find((x) => x.model === r.model && x.known === r.signalAt)!;
      const run = runBeforeEntry(s.c, s.atr, s.j!, s.d, s.c[s.j!]!.open);
      if (r.plans.some((p) => planSkipsLate(p, r.model))) expect(run > 3).toBe(false);
    }
  });
});

describe('MACD gap on signal rows (owner 2026-10-04)', () => {
  test('every row with a formed daily MACD carries its gap, signed the trade\'s way, read before the entry', async () => {
    const { macdLines } = await import('../src/indicators');
    const d1 = walk(900, DAY), h4 = walk(3000, H4, 11), now = d1.at(-1)!.openTime + DAY;
    const rows = rsiFrameworkSignals('TESTUSDT', d1, h4, now, 10_000);
    const { line, sig } = macdLines(d1.map((b) => b.close));
    const withGap = rows.filter((r) => r.macdGap != null);
    expect(withGap.length).toBeGreaterThan(0);
    for (const r of withGap) {
      const t = r.enteredAt ?? now;
      const k = d1.findLastIndex((b) => b.openTime + DAY <= t);
      const want = ((r.side === 'long' ? 1 : -1) * (line[k]! - sig[k]!)) / Math.abs(line[k]!);
      expect(r.macdGap!).toBeCloseTo(want, 3);
    }
  });
});
