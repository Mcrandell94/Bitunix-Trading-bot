import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { coinVolume } from '../src/screen/pine';
import { vdpm } from '../src/screen/vdpm';

const H4 = 4 * 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: Date.UTC(2024, 0, 1) + i * H4, open: o, high: h, low: l, close: c, volume: v * (h + l + c) / 3 });

describe('Volume Delta Pivot Matrix [BigBeluga]', () => {
  test('a pivot high is a resistance with the delta of its 11 bars; a close at or over it removes it', () => {
    // Bars close at 75% of their range (+0.5 x volume each); bar 20 is the pivot high (105), bar 18 has no range.
    const c = Array.from({ length: 40 }, (_, i) => (i === 20 ? bar(i, 100, 105, 99, 103.5) : i === 18 ? bar(i, 101, 100, 100, 100) : bar(i, 99.5, 101, 99, 100.5)));
    const r = vdpm(c, 30), v = coinVolume(c);
    const res = r.open.filter((x) => !x.support);
    expect(res.map((x) => [x.level, x.at])).toEqual([[105, 20]]);
    let d = 0;
    for (let k = 15; k <= 25; k++) d += k === 18 ? -v[k]! : v[k]! * (((c[k]!.close - c[k]!.low) / (c[k]!.high - c[k]!.low)) * 2 - 1);
    expect(res[0]!.delta).toBeCloseTo(d, 9);
    const broken = [...c.slice(0, 31), bar(31, 104, 106, 103, 105)];
    expect(vdpm(broken).open.filter((x) => !x.support)).toEqual([]);
  });

  test('random walk: the 10 newest unbroken levels, % of the largest |delta|, shown from 20%, newest first; the 5000-bar window; no look-ahead', () => {
    let sd = 11, p = 100;
    const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
    const c = Array.from({ length: 5300 }, (_, i) => { const o = p; p = o * (1 + (rnd() - 0.5) * 0.02); return bar(i, o, Math.max(o, p) * (1 + 0.003 * rnd()), Math.min(o, p) * (1 - 0.003 * rnd()), p, 500 + 1000 * rnd()); });
    const r = vdpm(c), last = c.at(-1)!.close;
    expect(r.open.length).toBeLessThanOrEqual(10);
    for (const x of r.open) expect(x.support ? x.level < last : x.level > last).toBe(true);
    const max = Math.max(...r.open.map((x) => Math.abs(x.delta)));
    for (const x of r.open) expect(x.pct).toBeCloseTo((Math.abs(x.delta) / max) * 100, 9);
    expect(r.shown.every((x) => x.pct >= 20)).toBe(true);
    expect(r.shown.map((x) => x.at)).toEqual([...r.open].reverse().filter((x) => x.pct >= 20).map((x) => x.at));
    // The script only sees its last 5000 bars: the same as a chart holding only those.
    const w = vdpm(c.slice(300));
    expect(w.open.map((x) => ({ ...x, at: x.at + 300 }))).toEqual(r.open);
    expect(vdpm(c, 4000)).toEqual(vdpm(c.slice(0, 4001)));
  });
});
