import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { fundingR, funding8h, fundVolReport, fvEvents, moveAt, relVolume } from '../src/screen/fundvol';

const H = 3_600_000, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v: number | null = 100): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
const f = (time: number, rate: number) => ({ time, rate });

describe('funding + volume extremes: building blocks', () => {
  test('24h funding as a per-8h rate, whatever the interval; null until the history covers the window', () => {
    const eight = [f(0, 0.0001), f(8 * H, 0.0006), f(16 * H, 0.0009), f(24 * H, 0.0015)];
    expect(funding8h(eight, 24 * H)).toBeCloseTo((0.0006 + 0.0009 + 0.0015) / 3, 12); // (0h, 24h]: 8h, 16h, 24h
    expect(funding8h(eight, 23 * H)).toBeNull(); // the window starts before the first settlement
    const four = Array.from({ length: 13 }, (_, k) => f(k * 4 * H, 0.0002)); // a 4h interval: 6 settlements a day
    expect(funding8h(four, 48 * H)).toBeCloseTo(0.0004, 12);
    expect(funding8h([], DAY)).toBeNull();
  });

  test('relative volume against the 20 bars before; null without the history or a volume', () => {
    const c = Array.from({ length: 22 }, (_, k) => bar(k * H, 1, 1, 1, 1, k === 21 ? 300 : 100));
    expect(relVolume(c, 21)).toBeCloseTo(3, 12);
    expect(relVolume(c, 19)).toBeNull();
    expect(relVolume([...c.slice(0, 21), bar(21 * H, 1, 1, 1, 1, null)], 21)).toBeNull();
  });

  test('signal bars: crowd from the funding sign, squeeze or blow-off from the bar, dojis and weak readings skipped', () => {
    const c: Candle[] = Array.from({ length: 24 }, (_, k) => bar(DAY + k * 4 * H, 100, 101, 99, 100.5));
    c[20] = bar(c[20]!.openTime, 100, 110, 99, 109, 400); // up bar, 4x volume
    c[21] = bar(c[21]!.openTime, 109, 110, 100, 101, 250); // down bar, 2.5x: too weak
    c[22] = bar(c[22]!.openTime, 101, 105, 97, 101, 900); // doji
    const shortsCrowded = Array.from({ length: 30 }, (_, k) => f(k * 8 * H, -0.001));
    const ev = fvEvents(c, shortsCrowded, 4 * H, 0.0005, 3);
    expect(ev.map((e) => [e.i, e.crowd, e.bar])).toEqual([[20, -1, 1]]); // shorts crowded, up bar: a squeeze bar
    expect(ev[0]!.rate8).toBeCloseTo(-0.001, 12);
    expect(fvEvents(c, shortsCrowded, 4 * H, 0.0015, 3)).toEqual([]);
    expect(fvEvents(c, shortsCrowded.map((x) => ({ ...x, rate: 0.0005 })), 4 * H, 0.0005, 3).map((e) => e.crowd)).toEqual([1]); // exactly at the level counts
  });

  test('funding in R: received when on the other side of the crowd, paid with it; only settlements while open', () => {
    const fs = [f(0, 0.001), f(8 * H, 0.001), f(16 * H, 0.002)];
    expect(fundingR(fs, -1, 8 * H, 16 * H, 100, 2)).toBeCloseTo(0.05, 12); // short receives 0.1% of 100 = 0.1, over a risk of 2
    expect(fundingR(fs, 1, 0, 17 * H, 100, 2)).toBeCloseTo(-0.2, 12); // long pays all three: 0.4% of 100 over 2
  });

  test('moves after the entry, the trade\'s way', () => {
    const c = [bar(0, 100, 101, 99, 100), bar(DAY, 100, 106, 99, 105), bar(2 * DAY, 105, 111, 104, 110)];
    expect(moveAt(c, 1, 1, 1)).toBeCloseTo(5, 9);
    expect(moveAt(c, 1, 2, -1)).toBeCloseTo(-10, 9);
    expect(moveAt(c, 1, 3, 1)).toBeNull();
  });
});

describe('funding + volume report', () => {
  test('runs on a synthetic coin and prints every section', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const start = Date.UTC(2024, 0, 1), c4: Candle[] = [], fs: { time: number; rate: number }[] = [];
    let px = 100;
    for (let k = 0; k < 6 * 400; k++) {
      const o = px, spike = k % 37 === 0, move = (rnd() - 0.5) * (spike ? 8 : 2);
      px = Math.max(1, o + move);
      c4.push(bar(start + k * 4 * H, o, Math.max(o, px) + rnd(), Math.min(o, px) - rnd(), px, spike ? 500 : 80 + 40 * rnd()));
    }
    for (let k = 0; k < 3 * 400; k++) fs.push(f(start + k * 8 * H, k % 50 < 10 ? -0.0012 : k % 50 < 20 ? 0.0011 : 0.0001));
    const d1: Candle[] = [];
    for (let k = 0; k + 6 <= c4.length; k += 6) {
      const g = c4.slice(k, k + 6);
      d1.push(bar(g[0]!.openTime, g[0]!.open, Math.max(...g.map((b) => b.high)), Math.min(...g.map((b) => b.low)), g[5]!.close, g.reduce((a, b) => a + (b.volume ?? 0), 0)));
    }
    const out = fundVolReport({ AAAUSDT: { candles: { '4h': c4, '1d': d1 }, funding: fs } }, ['AAAUSDT'], start + 30 * DAY, start + 400 * DAY, start + 200 * DAY);
    expect(out[0]).toContain('1 of 1 coins have funding history');
    expect(out.some((l) => l.startsWith('4H bars:'))).toBe(true);
    expect(out.some((l) => l.startsWith('Daily bars:'))).toBe(true);
    expect(out.some((l) => l.includes('squeeze bar, trade with it (against the crowd), 2R target') && l.includes('timing edge'))).toBe(true);
    expect(out.some((l) => l.includes('dose check'))).toBe(true);
  });
});
