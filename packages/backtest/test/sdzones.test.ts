import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { sdZones, zonesAt } from '../src/screen/sdzones';

const bar = (o: number, cl: number, i: number, volume = 100): Candle => ({ openTime: i, open: o, high: Math.max(o, cl) + 0.5, low: Math.min(o, cl) - 0.5, close: cl, volume });

/** 210 quiet alternating bars (ATR warm-up, true range 2 -> zone height 2 x ATR = 4). */
const warm = (): Candle[] => Array.from({ length: 210 }, (_, i) => (i % 2 ? bar(101, 100, i) : bar(100, 101, i)));

describe('supply and demand zones (BigBeluga port)', () => {
  test('supply: three red candles, the middle on high volume -> zone on the last green candle, low + 2 ATR', () => {
    const c = warm(); // bar 209 is red (odd), bar 208 green
    c.push(bar(100, 101, 210)); // green: the anchor
    c.push(bar(101, 99, 211), bar(99, 97, 212, 1000), bar(97, 95, 213)); // three reds, the middle with extra volume
    const z = sdZones(c).filter((x) => x.kind === 'supply');
    expect(z).toHaveLength(1);
    expect(z[0]!.created).toBe(213);
    expect(z[0]!.bottom).toBeCloseTo(99.5, 6); // the green anchor's low
    expect(z[0]!.top - z[0]!.bottom).toBeGreaterThan(3); // 2 x ATR(200), ~4 here
    expect(zonesAt(z, 212)).toHaveLength(0); // not known before its bar closes
    expect(zonesAt(z, 213)).toHaveLength(1);
  });

  test('a close above the top removes the supply zone; no new zone within 14 bars', () => {
    const c = warm();
    c.push(bar(100, 101, 210), bar(101, 99, 211), bar(99, 97, 212, 1000), bar(97, 95, 213));
    c.push(bar(95, 93, 214), bar(93, 91, 215, 1000), bar(91, 89, 216)); // another run inside the cooldown
    c.push(bar(89, 120, 217)); // closes far above the zone
    const z = sdZones(c).filter((x) => x.kind === 'supply');
    expect(z).toHaveLength(1);
    expect(z[0]!.removed).toBe(217);
  });

  test('demand mirrors supply: three green candles after a red one, high - 2 ATR', () => {
    const c = warm(); // bar 209 red
    c.push(bar(100, 102, 210), bar(102, 104, 211, 1000), bar(104, 106, 212));
    const z = sdZones(c).filter((x) => x.kind === 'demand');
    expect(z).toHaveLength(1);
    expect(z[0]!.top).toBeCloseTo(101.5, 6); // bar 209's high
  });
});
