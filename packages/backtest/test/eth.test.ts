import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { ETH_PERIODS, ethDataCheck } from '../src/screen/eth';

const H = 3_600_000, DAY = 86_400_000;
/** A seeded random walk of 1h bars. */
function walk(n: number, seed = 7): Candle[] {
  let s = seed, px = 2000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const nx = px * (1 + ((s / 2 ** 31) - 0.5) * 0.02);
    out.push({ openTime: Date.UTC(2023, 0, 1) + i * H, open: px, high: Math.max(px, nx) * 1.001, low: Math.min(px, nx) * 0.999, close: nx, volume: 1 });
    px = nx;
  }
  return out;
}
const fund = (days: number, sign: (d: number) => number) => Array.from({ length: days * 3 }, (_, k) => ({ time: Date.UTC(2023, 0, 1) + k * 8 * H, rate: 0.0001 * sign(Math.floor(k / 3)) }));
const gaps = [{ name: 'ETHUSDT 1h', missing: 3, span: 1000 }];

describe('ETH data check', () => {
  test('the same prices and funding pass; a gap breaks the return pair but not the match', () => {
    const b = walk(500), x = b.map((c) => ({ ...c, close: c.close * 1.0003 })).filter((_, i) => i !== 100);
    const r = ethDataCheck(b, x, fund(20, () => 1), fund(20, () => 1), gaps);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toContain('499 matched 1h bars');
    expect(r.lines[0]).toContain('497 return pairs');
    expect(r.lines.at(-1)).toContain('stands in');
  });

  test('unrelated prices, a price offset, opposite funding or too many missing bars each fail', () => {
    const b = walk(500);
    expect(ethDataCheck(b, walk(500, 99), fund(20, () => 1), fund(20, () => 1), gaps).ok).toBe(false);
    const off = ethDataCheck(b, b.map((c) => ({ ...c, close: c.close * 1.005 })), fund(20, () => 1), fund(20, () => 1), gaps);
    expect(off.ok).toBe(false);
    expect(off.lines.find((l) => l.includes('median'))).toMatch(/^ {2}FAIL/);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, (d) => (d % 3 ? -1 : 1)), gaps).ok).toBe(false);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, () => 1), [{ name: 'BTCUSDT 15m', missing: 20, span: 1000 }]).ok).toBe(false);
    expect(ethDataCheck(b, b, fund(20, () => 1), fund(20, () => 1), [{ name: 'BTCUSDT 15m', missing: 0, span: 0 }]).ok).toBe(false); // nothing loaded
  });

  test('fixed periods: development before validation, the holdout after', () => {
    expect(ETH_PERIODS.dev.to).toBe(ETH_PERIODS.val.from);
    expect(ETH_PERIODS.val.to).toBe(ETH_PERIODS.holdoutFrom);
    expect((ETH_PERIODS.holdoutFrom - Date.UTC(2026, 3, 12)) / DAY).toBe(0);
  });
});
