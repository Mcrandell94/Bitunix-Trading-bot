import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { RSI_MODELS, rsiFrameworkSignals } from '../src/screen/rsisignals';

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

  test('exactly the 8 live models: the 6 kept after the pooled grid plus the 2 failure-swing shorts (owner 2026-10-04)', () => {
    expect((Object.keys(RSI_MODELS) as (keyof typeof RSI_MODELS)[]).filter((m) => !RSI_MODELS[m].dropped).sort()).toEqual(['4h-fail-short', 'bottom-div', 'd-fail-short', 'triple-div', 'under-floor', 'w-bear-div', 'w-dbl-bottom', 'w-top-div']);
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
