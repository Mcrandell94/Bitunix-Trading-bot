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

describe('supply and demand visible range (LuxAlgo port)', () => {
  test('supply = top bands holding > 10% of the volume by highs; demand mirrors with lows', async () => {
    const { sdVisibleRange } = await import('../src/screen/sdzones');
    // 100 bars between 90 and 110; a few heavy bars with highs near the top and lows near the bottom.
    const c: Candle[] = Array.from({ length: 100 }, (_, i) => ({ openTime: i, open: 100, high: 105, low: 95, close: 100, volume: 10 }));
    // As in the script, a bar whose high IS the window high (or low the window low) never counts (strict < / >).
    c[5] = { ...c[5]!, high: 110, low: 90 };
    c[10] = { ...c[10]!, high: 109.9, volume: 200 }; // > 10% of the volume: the top band alone
    c[20] = { ...c[20]!, low: 90.1, volume: 200 };
    const z = sdVisibleRange(c, 99, 100);
    expect(z.supply!.top).toBe(110);
    expect(z.supply!.bottom).toBeCloseTo(109.6, 6); // one band of (110 - 90) / 50
    expect(z.demand!.bottom).toBe(90);
    expect(z.demand!.top).toBeCloseTo(90.4, 6);
  });
});

describe('order blocks (LuxAlgo port)', () => {
  test('a volume pivot after a new low makes a bullish OB (low to mid); a lower low mitigates it', async () => {
    const { orderBlocks, orderBlocksAt } = await import('../src/screen/sdzones');
    const c: Candle[] = Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 10 }));
    c[10] = { ...c[10]!, high: 100, low: 90, volume: 50 }; // a new low on the highest volume: confirmed 5 bars later
    const z = orderBlocks(c);
    expect(z).toHaveLength(1);
    expect(z[0]).toMatchObject({ kind: 'demand', bottom: 90, top: 95, created: 15 });
    expect(orderBlocksAt(z, 14)).toHaveLength(0);
    expect(orderBlocksAt(z, 15)).toHaveLength(1);
    c[20] = { ...c[20]!, low: 89 };
    expect(orderBlocks(c)[0]!.removed).toBe(20);
  });
});

describe('LuxAlgo daily demand filter (4H under-floor)', () => {
  test('a signal bar inside the daily demand zone passes; one above it does not; only closed days count', async () => {
    const { luxDailyDemandTouched } = await import('../src/screen/sdzones');
    const DAY = 86_400_000;
    const d1: Candle[] = Array.from({ length: 160 }, (_, i) => ({ openTime: i * DAY, open: 100, high: 105, low: 95, close: 100, volume: 10 }));
    d1[100] = { ...d1[100]!, low: 90.1, volume: 300 }; // heavy volume at the lows: demand at the bottom band
    d1[50] = { ...d1[50]!, low: 90 }; // the window low (never counted itself, as in the script)
    const known = 160 * DAY;
    const bar = (lo: number, hi: number): Candle => ({ openTime: known - 4 * 3_600_000, open: hi, high: hi, low: lo, close: lo, volume: 1 });
    expect(luxDailyDemandTouched(d1, bar(90.2, 91), known)).toBe(true);
    expect(luxDailyDemandTouched(d1, bar(99, 101), known)).toBe(false);
    expect(luxDailyDemandTouched(d1, bar(90.2, 91), 5 * DAY)).toBe(false); // too little daily history then
  });
});
