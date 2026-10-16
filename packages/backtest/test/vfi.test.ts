import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinVolume, taEma, taSma, taStdev } from '../src/screen/pine';
import { vfi } from '../src/screen/vfi';

const H4 = 4 * 3_600_000;
// Flat bars (hlc3 = close) with a volume of `coins` coins.
const bar = (i: number, c: number, coins = 10, h = c, l = c): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: c, high: h, low: l, close: c, volume: coins * ((h + l + c) / 3) });

describe('Volume Flow Indicator [LazyBear]', () => {
  test('a steady climb on flat volume: every bar counts up, VFI = 130; a steady fall -130; flat 0', () => {
    const up = vfi(Array.from({ length: 400 }, (_, i) => bar(i, 100 * 1.01 ** i)));
    expect(up.vfi[399]).toBeCloseTo(130, 9);
    expect(up.signal[399]).toBeCloseTo(130, 9);
    expect(up.hist[399]).toBeCloseTo(0, 9);
    expect(vfi(Array.from({ length: 400 }, (_, i) => bar(i, 100 * 0.99 ** i))).vfi[399]).toBeCloseTo(-130, 9);
    expect(vfi(Array.from({ length: 400 }, (_, i) => bar(i, 100))).vfi[399]).toBe(0);
  });

  test('capped volume over the cutoff, summed over 130 bars / the previous SMA 130; signal EMA 5; no look-ahead', () => {
    let s = 9, p = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const c = Array.from({ length: 900 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.02); return bar(i, p, rnd() < 0.03 ? 60 : 5 + 10 * rnd(), Math.max(o, p) * 1.002, Math.min(o, p) * 0.998); });
    const r = vfi(c), vol = coinVolume(c), typ = c.map((b) => (b.high + b.low + b.close) / 3);
    const sd = taStdev(typ.map((x, i) => (i ? Math.log(x) - Math.log(typ[i - 1]!) : NaN)), 30), ma = taSma(vol, 130);
    let capped = 0;
    for (let i = 300; i < c.length; i++) {
      let sum = 0;
      for (let k = i - 129; k <= i; k++) {
        const vave = ma[k - 1]!, cut = 0.2 * sd[k]! * c[k]!.close, vc = Math.min(vol[k]!, 2.5 * vave), mf = typ[k]! - typ[k - 1]!;
        if (vol[k]! > 2.5 * vave) capped++;
        sum += mf > cut ? vc : mf < -cut ? -vc : 0;
      }
      expect(r.vfi[i]).toBeCloseTo(sum / ma[i - 1]!, 9);
    }
    expect(capped).toBeGreaterThan(0);
    const e = taEma(r.vfi, 5);
    expect(r.signal[899]).toBe(e[899]);
    expect(r.hist[899]).toBeCloseTo(r.vfi[899]! - e[899]!, 12);
    const cut = vfi(c.slice(0, 601));
    for (const k of ['vfi', 'signal', 'hist'] as const) expect(cut[k]).toEqual(r[k].slice(0, 601));
    expect(vfi(c, true).vfi[899]).toBeCloseTo((r.vfi[897]! + r.vfi[898]! + r.vfi[899]!) / 3, 9);
  });
});
