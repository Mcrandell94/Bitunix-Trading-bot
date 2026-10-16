import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taSma, trueRange } from '../src/screen/pine';
import { alphaTrend, mfiHlc3 } from '../src/screen/alphatrend';

const H4 = 4 * 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v });

describe('AlphaTrend [KivancOzbilgic]', () => {
  test('MFI of hlc3: rising bars feed the upper sum, falling the lower; the first bar both; no falling bar = na', () => {
    // hlc3 = close (flat bars) and volume = close, so 1 coin a bar.
    const c = [10, 11, 10.5].map((x, i) => bar(i, x, x, x, x, x));
    const m = mfiHlc3(c, 2);
    expect(m[0]).toBeNaN();
    expect(m[1]).toBeCloseTo(100 - 100 / (1 + 21 / 10), 12);
    expect(m[2]).toBeCloseTo(100 - 100 / (1 + 11 / 10.5), 12);
    expect(mfiHlc3([1, 2, 3, 4].map((x, i) => bar(i, x, x, x, x, x)), 2)[3]).toBeNaN();
  });

  test('the line ratchets: low - ATR never lower while MFI >= 50, high + ATR never higher otherwise; crosses and labels as defined', () => {
    let s = 17, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const c = Array.from({ length: 1200 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.48) * 0.03); return bar(i, o, Math.max(o, p) * (1 + 0.004 * rnd()), Math.min(o, p) * (1 - 0.004 * rnd()), p, 1e5 * (0.5 + rnd())); });
    const a = alphaTrend(c), atr = taSma(trueRange(c).map((x, i) => (i === 0 ? NaN : x)), 14), m = mfiHlc3(c, 14);
    for (let i = 20; i < c.length; i++) {
      const prev = a.at[i - 1]!, up = c[i]!.low - atr[i]!, dn = c[i]!.high + atr[i]!;
      expect(a.at[i]).toBe(m[i]! >= 50 ? Math.max(prev, up) : Math.min(prev, dn));
      expect(a.buy[i]).toBe(a.at[i]! > a.at[i - 2]! && a.at[i - 1]! <= a.at[i - 3]!);
      expect(a.sell[i]).toBe(a.at[i]! < a.at[i - 2]! && a.at[i - 1]! >= a.at[i - 3]!);
      // barssince(buy[1]) > barssince(sell) for a BUY label, mirrored for SELL.
      const since = (xs: boolean[], to: number) => { for (let k = to; k >= 0; k--) if (xs[k]) return to - k; return NaN; };
      expect(a.buyLabel[i]).toBe(a.buy[i]! && since(a.buy, i - 1) > since(a.sell, i));
      expect(a.sellLabel[i]).toBe(a.sell[i]! && since(a.sell, i - 1) > since(a.buy, i));
    }
    expect(a.buyLabel.filter(Boolean).length).toBeGreaterThan(5);
    expect(a.sellLabel.filter(Boolean).length).toBeGreaterThan(5);
    const cut = alphaTrend(c.slice(0, 801));
    for (const k of ['at', 'green', 'buy', 'sell', 'buyLabel', 'sellLabel'] as const) expect(cut[k]).toEqual(a[k].slice(0, 801));
  });
});
