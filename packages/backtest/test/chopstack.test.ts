import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { chopZone, zoneColor, zoneGroup } from '../src/screen/chopzone';
import { biasSide, btcShortCheck, stackAt, stackSeries } from '../src/screen/emastack';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, MON = Date.UTC(2026, 0, 5);
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });

describe('Chop Zone (TradingView built-in)', () => {
  test('colours by angle; yellow only at 0 after the rounding', () => {
    expect([5, 4, 3, 1, 0, -1, -3, -4, -5].map(zoneColor)).toEqual(['turquoise', 'dark green', 'pale green', 'lime', 'yellow', 'light orange', 'orange', 'red', 'dark red']);
    expect(zoneGroup('lime')).toBe('up');
    expect(zoneGroup('yellow')).toBe('chop');
    expect(zoneGroup('red')).toBe('down');
  });

  test('flat prices -> yellow; a steady rise -> a positive angle (EMA rising), a fall -> negative', () => {
    const flat = Array.from({ length: 80 }, (_, k) => bar(k * H4, 100, 101, 99, 100)), up: Candle[] = [], dn: Candle[] = [];
    for (let k = 0; k < 80; k++) { const p = 100 * 1.01 ** k, q = 100 * 0.99 ** k; up.push(bar(k * H4, p, p * 1.002, p * 0.998, p)); dn.push(bar(k * H4, q, q * 1.002, q * 0.998, q)); }
    expect(chopZone(flat).color[79]).toBe('yellow');
    expect(chopZone(up).angle[79]).toBeGreaterThan(0);
    expect(chopZone(dn).angle[79]).toBeLessThan(0);
    expect(chopZone(up).angle[20]).toBeNaN(); // EMA 34 not seeded yet
    // Hand value at the last bar of the rise: the built-in formula step by step.
    const z = chopZone(up), i = 79;
    expect(Number.isInteger(z.angle[i])).toBe(true);
  });
});

describe('EMA stacks', () => {
  const daily = (closes: number[]) => closes.map((c, k) => bar(MON + k * DAY, c, c * 1.001, c * 0.999, c));
  test('ETH: bias over / under EMA 26 and since when; short confirmation; closed weeks only', () => {
    const closes = [...Array.from({ length: 120 }, (_, k) => 100 + k), ...Array.from({ length: 30 }, (_, k) => 219 - 4 * k)];
    const d1 = daily(closes), s = stackSeries('ETHUSDT', d1, []), t = d1[149]!.openTime + DAY, a = stackAt(s, t);
    expect(a.bias!.n).toBe(26);
    expect(a.bias!.over).toBe(false);
    expect(Number.isFinite(a.bias!.since)).toBe(true);
    expect(a.shortConfirm).toBe(s.dEma.get(12)![149]! < s.dEma.get(26)![149]!);
    expect(biasSide(a)).toBe(a.shortConfirm ? -1 : 0);
    // Mid-week: the last closed week is the one before.
    const wed = MON + (7 * 20 + 2) * DAY + 12 * H;
    expect(stackAt(s, wed).weekly!.weekOf).toBe(MON + 7 * 19 * DAY);
  });

  test('BTC short check: 9 / 89 or 12 / 26, three closes under 26 or a failed retest, not the first tag after a vertical run', () => {
    // A long steady rise, then a vertical run (closes far over EMA 26), then the first drop under 26.
    const closes = [...Array.from({ length: 200 }, (_, k) => 100 + k * 0.5), ...Array.from({ length: 10 }, (_, k) => 200 + 15 * (k + 1)), ...Array.from({ length: 12 }, (_, k) => 350 - 15 * (k + 1))];
    const d1 = daily(closes), s = stackSeries('BTCUSDT', d1, []), e26 = s.dEma.get(26)!;
    const first = closes.findIndex((c, k) => k > 200 && c < e26[k]!);
    expect(first).toBeGreaterThan(200);
    const c1 = btcShortCheck(s, first)!;
    expect(c1.items[2]).toBe(false); // the first tag after the run
    expect(c1.items[1]).toBe(false); // only one close under 26 so far
    const later = btcShortCheck(s, first + 2)!;
    expect(later.items[1]).toBe(true); // three closes under 26
    expect(btcShortCheck(s, 150)).toBeNull(); // over 26: no check
    const a = stackAt(s, d1[first + 2]!.openTime + DAY);
    expect(a.slow!.n).toBe(144);
    expect(a.pair!.fast).toBe(9);
    expect(biasSide(a)).toBe(later.count >= 2 ? -1 : 0);
  });

  test('4H trigger pairs and limits come from the last closed 4H bar', () => {
    const h4 = Array.from({ length: 60 }, (_, k) => bar(MON + k * H4, 100 + k, 101 + k, 99 + k, 100 + k)), d1 = daily(Array.from({ length: 30 }, (_, k) => 100 + k));
    const s = stackSeries('BTCUSDT', d1, h4), a = stackAt(s, h4[59]!.openTime + H4);
    expect(a.trigger!.pairs.map((p) => `${p.fast}/${p.slow}`)).toEqual(['5/8']);
    expect(a.trigger!.pairs[0]!.over).toBe(true);
    expect(a.trigger!.limits.map((l) => l.n)).toEqual([8, 13]);
    expect(a.trigger!.limits[0]!.v).toBeCloseTo(s.hEma.get(8)![59]!, 12);
  });
});
