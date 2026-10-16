import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taSma, taStdev } from '../src/screen/pine';
import { pinePivot } from '../src/screen/srbreaks';
import { LIQZONES, liqZones, liqZonesAt } from '../src/screen/liqzones';

const H4 = 4 * 3_600_000;
const bar = (i: number, h: number, l: number, c: number, v = 1000, o = c): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v });
const rng = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; };

describe('Liquidity Zones [BigBeluga]', () => {
  test('a pivot high 8 bars back draws a line at high + ATR(200); a bar through the line grabs it; an outside bar takes the high', () => {
    const r = rng(1);
    const c = Array.from({ length: 600 }, (_, i) => (i === 550 ? bar(i, 105, 95, 100, 1000) : i === 580 ? bar(i, 110, 100, 100, 1000) : bar(i, 101, 99, 100, 1000 * (1 + 0.1 * r()))));
    const zs = liqZones(c), atr = taAtr(c, 200);
    expect(zs.filter((z) => z.pivotAt === 550)).toHaveLength(1);
    const z = zs.find((x) => x.pivotAt === 550)!;
    expect([z.side, z.at, z.edge]).toEqual([1, 558, 105]);
    expect(z.level).toBeCloseTo(105 + atr[558]!, 12);
    expect(liqZonesAt(zs, c, 579).find((x) => x.pivotAt === 550)!.grabbedAt).toBeNull();
    expect(liqZonesAt(zs, c, 599).find((x) => x.pivotAt === 550)!.grabbedAt).toBe(580);
  });

  test('zones only from pivots whose SMA 8 volume is over 2 stdevs (of 500 bars); 10 on the chart; grabs are the first bar through the line', () => {
    const r = rng(7);
    let p = 100;
    const c = Array.from({ length: 1400 }, (_, i) => {
      const o = p; p = o * (1 + (r() - 0.5) * 0.03);
      const v = 1000 * Math.exp(2.5 * Math.sin(i / 90) + (r() - 0.5));
      return bar(i, Math.max(o, p) * (1 + 0.004 * r()), Math.min(o, p) * (1 - 0.004 * r()), p, v, o);
    });
    const zs = liqZones(c), avg = taSma(coinVolume(c), 8), sd = taStdev(avg, 500), hi = c.map((b) => b.high), lo = c.map((b) => b.low);
    let kept = 0, dropped = 0;
    for (let i = 8; i < c.length; i++) {
      const ph = pinePivot(hi, i, 10, 8, true), pl = pinePivot(lo, i, 10, 8, false);
      if (ph == null && pl == null) continue;
      const s = avg[i - 8]! / sd[i - 8]!, z = zs.find((x) => x.at === i);
      if (s > 2) { kept++; expect(z?.side).toBe(ph != null ? 1 : -1); expect(z?.strength).toBeCloseTo(s, 12); } else { dropped++; expect(z).toBeUndefined(); }
    }
    expect(kept).toBeGreaterThan(10);
    expect(dropped).toBeGreaterThan(10);
    const i = c.length - 1, on = liqZonesAt(zs, c, i);
    expect(on.map((x) => x.at)).toEqual(zs.filter((x) => x.at <= i).slice(-LIQZONES.qty).map((x) => x.at));
    for (const x of on) {
      const k = c.findIndex((b, j) => j >= x.at && b.high > x.level && b.low < x.level);
      expect(x.grabbedAt).toBe(k < 0 ? null : k);
    }
    // No look-ahead: the zones at bar 1000 are the zones from the bars up to it.
    const cut = c.slice(0, 1001);
    expect(liqZones(cut)).toEqual(zs.filter((x) => x.at <= 1000));
    expect(liqZonesAt(liqZones(cut), cut, 1000)).toEqual(liqZonesAt(zs, c, 1000));
  });
});
