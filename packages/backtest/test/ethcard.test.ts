import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { taAlma, taEma, taHighest, taLowest, taSma, taStdev, taPivot } from '../src/screen/pine';
import { chopIndex, chopState } from '../src/screen/chop';
import { trendRibbon } from '../src/screen/trendribbon';
import { trinity } from '../src/screen/trinity';
import { activeBlocks, nySession, shaakuniBlocks, shaakuniLevels } from '../src/screen/shaakuni';
import { fibArcs, volumePoc } from '../src/screen/fibarcs';
import { DIR_ACCUM, DIR_NONE, EV, PHASE_A, PHASE_B, PHASE_C, PHASE_D, PHASE_E, PHASE_NONE, wyckoff } from '../src/screen/wyckoff';
import { atrWilder } from '../src/indicators';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
const bar = (t: number, o: number, h: number, l: number, c: number, v = 1000): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: v });
/** A seeded random walk of `n` bars `ms` apart with trend regimes and volume spikes. */
function walk(n: number, ms: number, seed = 3, start = Date.UTC(2024, 0, 1)): Candle[] {
  let s = seed >>> 0, p = 2000;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const ret = Math.sin(i / 60) * 0.004 + (r() < 0.03 ? (r() < 0.5 ? -1 : 1) * 0.03 : 0) + (r() - 0.5) * 0.02, o = p, c = o * (1 + ret), w = Math.abs(ret) * 0.4 + 0.004 * r();
    p = c;
    out.push(bar(start + i * ms, o, Math.max(o, c) * (1 + w * r()), Math.min(o, c) * (1 - w * r()), c, 1e6 * (1 + r()) * (r() < 0.04 ? 5 : 1)));
  }
  return out;
}

describe('Pine helpers', () => {
  test('sma, ema seeding, population stdev, highest / lowest', () => {
    expect(taSma([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
    expect(taEma([1, 2, 3, 4, 5], 3)).toEqual([NaN, NaN, 2, 3, 4]);
    expect(taStdev([2, 4, 4, 4, 5, 5, 7, 9], 8)[7]).toBeCloseTo(2, 12);
    expect(taHighest([1, 3, 2, 5, 4], 3)).toEqual([NaN, NaN, 3, 5, 5]);
    expect(taLowest([1, 3, 2, 5, 4], 3)).toEqual([NaN, NaN, 1, 2, 2]);
  });

  test('ALMA: the Pine weights (oldest bar first) and a flat series', () => {
    const m = 0.85 * 2, s = 3 / 6, w = [0, 1, 2].map((i) => Math.exp(-((i - m) ** 2) / (2 * s * s)));
    expect(taAlma([1, 2, 3], 3, 0.85, 6)[2]).toBeCloseTo((1 * w[0]! + 2 * w[1]! + 3 * w[2]!) / (w[0]! + w[1]! + w[2]!), 12);
    expect(taAlma([5, 5, 5, 5], 3, 0.85, 6).slice(2)).toEqual([5, 5]);
  });

  test('pivots: confirmed `len` bars later', () => {
    const h = [1, 2, 5, 2, 1, 1];
    expect(taPivot(h, 4, 2, true)).toBe(5);
    expect(taPivot(h, 3, 2, true)).toBeNaN();
  });
});

describe('Chop (CHOP 14)', () => {
  test('the formula on a hand example (len 2) and the states', () => {
    const c = [bar(0, 10, 11, 9, 10), bar(H, 10, 12, 10, 11), bar(2 * H, 11, 11.5, 10.5, 11)];
    const x = chopIndex(c, 2);
    // bar 2: TR(1) = 2 (12-10), TR(2) = max(1, 0.5, 0.5) = 1; HH 12, LL 10 -> 100 log10(3/2) / log10(2)
    expect(x[2]).toBeCloseTo((100 * Math.log10(3 / 2)) / Math.log10(2), 10);
    expect(chopState([70, 70, 71, 72], 3)).toBe('chop');
    expect(chopState([75, 72, 68, 65], 3)).toBe('fading'); // above 61.8 but falling 3 bars
    expect(chopState([70, 50, 40, 45, 45, 45, 45], 6)).toBe('fading'); // chop within the last 6 bars
    expect(chopState([50, 50, 50, 50, 50, 50, 50, 30], 7)).toBe('trending');
    expect(chopState([50, 50, 50, 50, 50, 50, 50, 50], 7)).toBe('neutral');
  });
});

describe('Trend ribbon (BOSWaves)', () => {
  test('flips, stop clamp, targets and the stop', () => {
    const c: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 300; i++) { const d = i < 100 ? 0 : i < 200 ? 0.6 : -0.6; const o = p; p += d + Math.sin(i) * 0.3; c.push(bar(i * H4, o, Math.max(o, p) + 0.4, Math.min(o, p) - 0.4, p)); }
    const r = trendRibbon(c), atr = atrWilder(c, 14);
    expect(r.positions.length).toBeGreaterThanOrEqual(2);
    const bull = r.positions.find((x) => x.dir === 1)!, bear = r.positions.find((x) => x.dir === -1)!;
    expect(bull.i).toBeGreaterThan(100);
    expect(bear.i).toBeGreaterThan(200);
    for (const x of r.positions) {
      const a = atr[x.i]!;
      expect(x.risk).toBeGreaterThanOrEqual(a * 0.75 - 1e-9);
      expect(x.risk).toBeLessThanOrEqual(a * 3 + 1e-9);
      expect(x.targets.map((t) => t.price)).toEqual([1, 2, 3, 4].map((k) => x.entry + x.dir * x.risk * k));
    }
    // The stop: the 12-bar extreme up to the bar before the flip, clamped to 0.75 - 3 ATR.
    for (const x of r.positions) {
      const w = c.slice(x.i - 12, x.i), ext = x.dir === 1 ? Math.min(...w.map((b) => b.low)) : Math.max(...w.map((b) => b.high)), a = atr[x.i]!;
      expect(x.risk).toBeCloseTo(Math.min(Math.max(x.dir * (x.entry - ext), 0.75 * a), 3 * a), 9);
    }
    expect(bull.endAt).toBeGreaterThan(bull.i);
    expect(r.trend[299]).toBe(-1);
  });
});

describe('Trinity reversal (AlgoAlpha)', () => {
  test('a bull pattern, its strength and level, a touch; expiry after 100 bars', () => {
    const c = [bar(0, 10, 10.5, 9.5, 10), bar(H, 10, 10.2, 8, 8.5), bar(2 * H, 8.5, 9, 7.5, 7.8), bar(3 * H, 7.8, 10.6, 7.7, 10.4)];
    for (let i = 4; i < 10; i++) c.push(bar(i * H, 10.4, 10.8, 10.1, 10.5));
    c.push(bar(10 * H, 10.5, 10.6, 7.4, 8));
    const s = trinity(c);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ i: 3, dir: 1, level: 7.5, levelBar: 2, touchedAt: 10, expiredAt: -1 });
    expect(s[0]!.strength).toBeCloseTo(100, 6); // the largest body of the window
    const d = c.slice(0, 4);
    for (let i = 4; i < 110; i++) d.push(bar(i * H, 10.4, 10.8, 10.1, 10.5));
    expect(trinity(d)[0]!.expiredAt).toBe(103);
  });
});

describe('Shaakuni levels and order blocks', () => {
  test('previous week / day, EQ, day status, the weekend roll and the NY session', () => {
    const mon = Date.UTC(2026, 9, 5); // a Monday
    const c: Candle[] = [];
    for (let k = 0; k < 7 * 6; k++) c.push(bar(mon + k * H4, 100, 110 + (k === 3 ? 20 : 0), 90 - (k === 4 ? 10 : 0), 100)); // week 1: H 130, L 80
    for (let k = 0; k < 6; k++) c.push(bar(mon + 7 * DAY + k * H4, 100, 105, 95, 100)); // Mon of week 2
    c.push(bar(mon + 8 * DAY, 100, 106, 99, 104)); // Tue 00:00: high over Monday's 105, close under it
    const tue = Date.UTC(2026, 9, 13, 4);
    const L = shaakuniLevels(c, tue);
    expect(L).toMatchObject({ pwh: 130, pwl: 80, weq: 105, pdh: 105, pdl: 95, deq: 100, pdhStatus: 'Sweep', pdlStatus: 'Active', weekendRoll: false });
    c.push(bar(mon + 8 * DAY + H4, 104, 104, 93, 94));
    expect(shaakuniLevels(c, tue).pdlStatus).toBe('Break');
    const sat = Date.UTC(2026, 9, 17, 12);
    const R = shaakuniLevels(c, sat);
    expect(R.weekendRoll).toBe(true);
    expect(R.pwh).toBe(106); // the current week so far, as the script shows on weekends
    expect(nySession(Date.UTC(2026, 9, 13, 8))).toBe('London'); // 04:00 New York (EDT)
    expect(nySession(Date.UTC(2026, 9, 13, 12))).toBe('New York');
    expect(nySession(Date.UTC(2026, 9, 13, 18))).toBe('-');
  });

  test('every block meets the script rule; mitigation is the first overlap after it', () => {
    const c = walk(1500, H4, 11), atr = atrWilder(c, 14), zs = shaakuniBlocks(c, H4);
    expect(zs.length).toBeGreaterThan(5);
    for (const z of zs) {
      const i = z.createdAt, d = z.side;
      const ext = d > 0 ? Math.max(...c.slice(i - 10, i).map((b) => b.high)) : Math.min(...c.slice(i - 10, i).map((b) => b.low));
      expect(d > 0 ? c[i]!.close > ext : c[i]!.close < ext).toBe(true);
      const imp = c[z.impulseBar]!, body = d > 0 ? imp.close - imp.open : imp.open - imp.close;
      expect(body).toBeGreaterThanOrEqual(atr[i]! * 0.7 - 1e-9);
      expect(z.top).toBe(c[z.obBar]!.high);
      expect(z.bottom).toBe(c[z.obBar]!.low);
      for (let k = z.obBar + 2; k <= i; k++) expect(d > 0 ? c[k]!.low > z.top : c[k]!.high < z.bottom).toBe(true); // fresh
      const first = c.findIndex((b, k) => k > i && b.high >= z.bottom && b.low <= z.top);
      const dropped = z.droppedAt >= 0 && (first < 0 || z.droppedAt <= first);
      if (!dropped) expect(z.mitigatedAt).toBe(first);
    }
    const act = activeBlocks(zs, c.length - 1);
    for (const z of act) expect(z.createdAt).toBeGreaterThanOrEqual(c.length - 1 - 250);
  });
});

describe('Swing Fibonacci arcs and volume profile (BigBeluga)', () => {
  test('swing flips, the anchor and the arcs at the last bar', () => {
    const c: Candle[] = [];
    for (let i = 0; i < 400; i++) { const p = i < 150 ? 200 - i * 0.5 : i < 300 ? 125 + (i - 150) : 275 - (i - 300) * 0.3; c.push(bar(i * H4, p, p + 1, p - 1, p)); }
    const r = fibArcs(c);
    expect(r.flips.map((f) => f.dir)).toEqual([1, -1]); // the start is already "down" (the script's initial state)
    const f = r.last!;
    // From bar ~353 the falling lows are the 70-bar lows again: the swing runs down from the top.
    expect(f).toMatchObject({ dir: -1, anchorBar: 300, anchor: 276, extremeBar: 399, leg: 152 }); // the top (bar 300's high); leg: 276 - the 124 low before
    expect(f.extreme).toBeCloseTo(244.3, 9);
    const dx = Math.max(f.extremeBar - f.anchorBar, 70) * 1.5, dy = Math.max(Math.abs(f.extreme - f.anchor), f.leg) * 1.5;
    for (const a of f.arcs) {
      const u = (399 - f.anchorBar) / (dx * a.ratio);
      if (Math.abs(u) > 1) expect(a.price).toBeNull();
      else expect(a.price!).toBeCloseTo(f.anchor - dy * a.ratio * Math.sqrt(1 - u * u), 6);
    }
    expect(f.arcs.filter((a) => a.price != null).length).toBeGreaterThan(0);
  });

  test('POC sits where the closes and the volume cluster', () => {
    const c: Candle[] = [];
    for (let i = 0; i < 200; i++) { const cl = i % 4 === 0 ? 150 : 100 + (i % 50); c.push(bar(i * H, cl, cl + 1, cl - 1, cl, i % 4 === 0 ? 1e7 : 1e5)); }
    expect(Math.abs(volumePoc(c, 0)! - 150)).toBeLessThan(3);
  });
});

/** Cycles of: a decline, a capitulation bar, an AR on good volume, a range, a Spring and its quiet retest, then an SOS. */
function accumulationCycles(nCycles: number, seed: number): Candle[] {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const out: Candle[] = [];
  let p = 1000, t = Date.UTC(2023, 0, 1);
  const raw = (o: number, h: number, l: number, c: number, v: number) => { out.push(bar(t, o, h, l, c, v * c)); t += H4; };
  const push = (o: number, c: number, v: number, wick = 0.004) => raw(o, Math.max(o, c) * (1 + wick * r()), Math.min(o, c) * (1 - wick * r()), c, v);
  for (let k = 0; k < 220; k++) { const o = p; p *= 1 + (r() - 0.5) * 0.01; push(o, p, 1000); }
  for (let cy = 0; cy < nCycles; cy++) {
    for (let k = 0; k < 60; k++) { const o = p; p *= 1 - 0.006 + (r() - 0.5) * 0.006; push(o, p, 1000 * (1 + r() * 0.3)); }
    { const o = p, c = p * 0.965; raw(o, o * 1.002, p * 0.93, c, 6000); p = c; }
    const lo = out[out.length - 1]!.low, hi = lo * 1.12;
    for (let k = 0; k < 10; k++) { const o = p; p *= 1.011 + (r() - 0.5) * 0.004; push(o, p, 1500); }
    for (let k = 0; k < 120; k++) {
      const target = lo + (hi - lo) * (0.5 + 0.45 * Math.cos((k / 30) * Math.PI)), o = p;
      p = Math.max(o + (target - o) * 0.35 + (r() - 0.5) * (hi - lo) * 0.02, lo * 1.002);
      push(o, p, (Math.abs(p - lo) < (hi - lo) * 0.2 ? 500 : 900) * (1 + r() * 0.2), 0.002);
    }
    { const o = p; p = lo * 0.992; raw(o, o * 1.001, lo * 0.985, p, 900); }
    { const o = p; p = lo * 1.012; raw(o, p * 1.002, o * 0.999, p, 1000); }
    for (let k = 0; k < 6; k++) { const o = p; p = lo * (1.02 + 0.004 * Math.sin(k)); push(o, p, 700, 0.002); }
    for (let k = 0; k < 5; k++) { const o = p; p = lo * (1.006 + 0.002 * k); push(o, p, 450, 0.001); }
    for (let k = 0; k < 40; k++) { const o = p; p *= 1 + 0.008 + (r() - 0.5) * 0.004; push(o, p, 1600); }
    for (let k = 0; k < 60; k++) { const o = p; p *= 1 + (r() - 0.5) * 0.01; push(o, p, 1000); }
  }
  return out;
}

describe('Wyckoff engine', () => {
  test('a built accumulation runs SC -> Phase B -> Spring / Test (C) -> SOS (D) -> markup (E), with long entry labels', () => {
    const c = accumulationCycles(6, 1), r = wyckoff(c, H4);
    // One campaign (a run of bars with a phase) that passes A, B, C, D and E in order.
    let ok = false, run: number[] = [];
    for (const b of [...r.bars, { phase: 0 }]) {
      if (b.phase === PHASE_NONE) {
        const first = [PHASE_A, PHASE_B, PHASE_C, PHASE_D, PHASE_E].map((p) => run.indexOf(p));
        if (first.every((x) => x >= 0) && first.every((x, k) => k === 0 || x > first[k - 1]!)) ok = true;
        run = [];
      } else run.push(b.phase);
    }
    expect(ok).toBe(true);
    const evs = new Set(r.bars.map((b) => b.ev));
    for (const e of [EV.SC, EV.ST, EV.SPRING, EV.TEST, EV.SOS, EV.MARKUP]) expect(evs.has(e)).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
    for (const e of r.entries) expect(e.dir).toBe(DIR_ACCUM);
    expect(r.resets['phase E ended']).toBeGreaterThan(0);
  });

  test('a random walk: valid phases and scores; deterministic', () => {
    const c = walk(3000, H4, 7), r = wyckoff(c, H4);
    expect(r.bars).toHaveLength(3000);
    for (const b of r.bars) {
      expect(b.phase).toBeGreaterThanOrEqual(PHASE_NONE);
      expect(b.phase).toBeLessThanOrEqual(PHASE_E);
      expect(b.conf).toBeGreaterThanOrEqual(0);
      expect(b.conf).toBeLessThanOrEqual(100);
      expect(b.val).toBeLessThanOrEqual(100);
      if (b.phase >= PHASE_B && !Number.isNaN(b.rangeHigh)) expect(b.rangeHigh).toBeGreaterThanOrEqual(b.rangeLow);
    }
    for (const e of r.entries) expect(e.dir).not.toBe(DIR_NONE);
    expect(wyckoff(c, H4).bars).toEqual(r.bars);
  });
});
