import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { dvrsi } from '../src/screen/dvrsi';

const H4 = 4 * 3_600_000;
function walk(n: number, seed = 9): Candle[] {
  let s = seed, p = 2000;
  const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return Array.from({ length: n }, (_, k) => { const o = p; p = Math.max(50, p + (r() - 0.5) * 30 + Math.sin(k / 25) * 8); return { openTime: k * H4, open: o, high: Math.max(o, p) + r() * 6, low: Math.min(o, p) - r() * 6, close: p, volume: 1000 * (1 + 4 * r()) * p }; });
}

/** The script written out bar by bar (Pine's SMA-seeded ta.rma / ta.ema), with the coin volume. */
function byHand(c: Candle[]): number[] {
  const L = 14, vol = c.map((b) => b.volume! / ((b.high + b.low + b.close) / 3)), src = c.map((b) => (b.high + b.low + b.close) / 3), out: number[] = [];
  const rma = (xs: number[]) => { const o: number[] = []; let p = NaN, s = 0, k = 0; for (const x of xs) { if (Number.isNaN(p)) { if (!Number.isNaN(x)) { s += x; k++; if (k === L) p = s / L; } } else p = (p * (L - 1) + x) / L; o.push(p); } return o; };
  const ema = (xs: number[]) => { const o: number[] = []; let p = NaN, s = 0, k = 0; for (const x of xs) { if (Number.isNaN(p)) { if (!Number.isNaN(x)) { s += x; k++; if (k === L) p = s / L; } } else p = (2 / 15) * x + (13 / 15) * p; o.push(p); } return o; };
  const rv = rma(vol), sv = vol.map((v, i) => {
    if (i < L) return NaN;
    let vt = 0;
    for (let k = i - L + 1; k <= i; k++) vt += Math.abs(vol[k]! - vol[k - 1]!);
    const er = Math.abs(v - vol[i - L]!) / vt, f = (er * (2 / 3 - 2 / 31) + 2 / 31) ** 2;
    return rv[i]! + f * (v - rv[i]!);
  });
  const ch = src.map((x, i) => (i ? x - src[i - 1]! : NaN));
  const up = rma(ch.map((d, i) => (Number.isNaN(d) || Number.isNaN(sv[i]!) ? NaN : Math.max(d, 0) * sv[i]!)));
  const dn = rma(ch.map((d, i) => (Number.isNaN(d) || Number.isNaN(sv[i]!) ? NaN : -Math.min(d, 0) * sv[i]!)));
  const idx = up.map((u, i) => (Number.isNaN(u) ? NaN : dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i]!)));
  const e = ema(idx);
  for (let i = 0; i < c.length; i++) out.push(e[i]! + (2 / 15) * (idx[i]! - e[i]!));
  return out;
}

describe('Dynamic Volume RSI (DVRSI) [QuantAlgo]', () => {
  test('matches the script written out bar by bar; na through the warm-up', () => {
    const c = walk(300), v = dvrsi(c).value, h = byHand(c);
    expect([Number.isNaN(v[39]!), Number.isNaN(v[40]!)]).toEqual([true, false]); // smoothed volume from bar 14, its RMA from 27, the EMA from 40
    for (let i = 0; i < c.length; i++) Number.isNaN(h[i]!) ? expect(Number.isNaN(v[i]!)).toBe(true) : expect(v[i]!).toBeCloseTo(h[i]!, 9);
    expect(v.filter((x) => !Number.isNaN(x)).length).toBeGreaterThan(200);
  });

  test('only rising prices read 100, only falling 0; the volume scale does not matter', () => {
    const up = walk(120).map((b, k) => ({ ...b, open: 100 + k, high: 101.5 + k, low: 99.5 + k, close: 101 + k }));
    expect(dvrsi(up).value.at(-1)).toBeCloseTo(100, 9);
    const down = up.map((b, k) => ({ ...b, open: 500 - k, high: 500.5 - k, low: 498.5 - k, close: 499 - k }));
    expect(dvrsi(down).value.at(-1)).toBeCloseTo(0, 9);
    const c = walk(400, 4), big = c.map((b) => ({ ...b, volume: b.volume! * 1000 }));
    const a = dvrsi(c).value, b = dvrsi(big).value;
    for (let i = 100; i < 400; i++) expect(b[i]!).toBeCloseTo(a[i]!, 9);
  });

  test('marks: 50 crossed over / under, under 60, over 40; the candle colour; no look-ahead', () => {
    const c = walk(900, 21), s = dvrsi(c), v = s.value;
    expect(s.bullShift.filter(Boolean).length).toBeGreaterThan(3);
    for (let i = 1; i < v.length; i++) {
      expect(s.bullShift[i]).toBe(v[i]! > 50 && v[i - 1]! <= 50);
      expect(s.bearShift[i]).toBe(v[i]! < 50 && v[i - 1]! >= 50);
      expect(s.overbought[i]).toBe(v[i]! < 60 && v[i - 1]! >= 60);
      expect(s.oversold[i]).toBe(v[i]! > 40 && v[i - 1]! <= 40);
      if (v[i]! > 50) expect(s.trend[i]).toBe(1);
      if (v[i]! < 50) expect(s.trend[i]).toBe(-1);
    }
    const part = dvrsi(c.slice(0, 600));
    expect(part.value).toEqual(v.slice(0, 600));
    expect(part.trend).toEqual(s.trend.slice(0, 600));
  });
});
