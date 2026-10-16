import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinVolume, taSma, taStdev } from '../src/screen/pine';
import { lsofProfile } from '../src/screen/lsof';

const H4 = 4 * 3_600_000;
// High / low 1 either side of the close, so the typical price is the close and a volume of close x 10 is 10 coins.
const bar = (i: number, c: number, o = c, v = c * 10): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: c + 1, low: c - 1, close: c, volume: v });

describe('Liquidity Structure & Order Flow [LuxAlgo]', () => {
  test('300 bars, 150 bins: POC, value area, widest void and the dashboard on a built profile', () => {
    // Range 99..249 (bin = 1): one close at 100 (bin 1), one at 248 (bin 149), 298 at 150.5 (bin 51); 149 of those close up.
    const c = Array.from({ length: 300 }, (_, i) => (i === 0 ? bar(i, 100) : i === 1 ? bar(i, 248) : bar(i, 150.5, i <= 150 ? 150.4 : 150.5)));
    const p = lsofProfile(c)!;
    expect([p.highs, p.lows, p.mid, p.step]).toEqual([249, 99, 174, 1]);
    expect([p.raw[1], p.raw[51], p.raw[149], p.total]).toEqual([10, 2980, 10, 3000]);
    const W = 1 + 2 * (1 / 2 + 1 / 3 + 1 / 4);
    expect(p.smooth[51]).toBeCloseTo(2980 / W, 9);
    expect(p.smooth[53]).toBeCloseTo(2980 / 3 / W, 9);
    // POC bin 51; the value area adds 52 (tie, up first), 50, then 53 (tie) to pass 70% of 3,000.
    expect([p.pocIdx, p.poc, p.vah, p.val]).toEqual([51, 150.5, 153, 149]);
    // Under 15% of the POC: bins 0..47 and 55..149; the widest is 55..149.
    expect(p.void).toEqual({ lo: 154, hi: 249, bins: 95 });
    expect(p.upperVol + p.lowerVol).toBeCloseTo(p.smooth.reduce((a, b) => a + b, 0), 9);
    expect(p.upperVol).toBeGreaterThan(0);
    expect([p.buyVol, p.sellVol, p.delta, p.distToPoc]).toEqual([1490, 0, 1490, 0]);
    expect(p.rangeLoc).toBeCloseTo(((150.5 - 99) / 150) * 100, 9);
    expect(p.bubbles).toEqual([]); // flat volume: no spikes
  });

  test('every close in its bin, the bubbles as defined, nothing before 300 bars, no look-ahead', () => {
    let s = 11, px = 100;
    const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
    const c = Array.from({ length: 800 }, (_, i) => { const o = px; px = o * (1 + (rnd() - 0.5) * 0.02); return bar(i, px, o, px * 10 * (rnd() < 0.02 ? 8 : 0.5 + rnd())); });
    const i = 760, p = lsofProfile(c, i)!, vol = coinVolume(c);
    const raw = new Array<number>(150).fill(0);
    for (let k = i - 299; k <= i; k++) raw[Math.min(149, Math.floor((c[k]!.close - p.lows) / p.step))]! += vol[k]!;
    raw.forEach((x, k) => expect(p.raw[k]).toBeCloseTo(x, 8));
    expect(p.val).toBeLessThanOrEqual(p.poc);
    expect(p.vah).toBeGreaterThanOrEqual(p.poc);
    const ma = taSma(vol, 200), sd = taStdev(vol, 200), want: number[] = [];
    for (let k = i - 299; k <= i; k++) if ((vol[k]! - ma[k]!) / sd[k]! >= 2 && vol[k]! / ma[k]! > 1.5) want.push(k);
    expect(p.bubbles.map((b) => b.i)).toEqual(want);
    expect(want.length).toBeGreaterThan(2);
    expect(lsofProfile(c, 298)).toBeNull();
    expect(lsofProfile(c, i)).toEqual(lsofProfile(c.slice(0, i + 1)));
  });
});
