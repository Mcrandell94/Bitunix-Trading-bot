import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { domKeyLevels, domPeriodStart } from '../src/screen/luxdom';

const M15 = 15 * 60_000, DAY = 86_400_000;
const bar = (t: number, o: number, h: number, l: number, c: number, coins = 1): Candle => ({ openTime: t, open: o, high: h, low: l, close: c, volume: coins * (h + l + c) / 3 });

describe('Depth of Market (DOM) [LuxAlgo]: key levels', () => {
  const day = Date.UTC(2026, 9, 14); // a Wednesday
  // Daily bars for the week before (Mon 10-05 .. Sun 10-11) and Mon / Tue of this week.
  const d1: Candle[] = Array.from({ length: 9 }, (_, k) => bar(day - (9 - k) * DAY, 100 + k, 110.7 + k, 90.2 + k, 105.6 + k));

  test('periods restart at 00:00 and 15:30 UTC', () => {
    expect(domPeriodStart(day + 15 * 3_600_000 + 15 * 60_000)).toBe(day);
    expect(domPeriodStart(day + 15.5 * 3_600_000)).toBe(day + 15.5 * 3_600_000);
    expect(domPeriodStart(day + 23.75 * 3_600_000)).toBe(day + 15.5 * 3_600_000);
  });

  test('previous week / day, the period range, opening range, initial balance, VWAP bands and POC (whole numbers)', () => {
    // 15m bars from 12:00 to 17:45 on 10-14; the 15:30 period has 6 bars: 15:30 .. 16:45 (the card at 17:00).
    const s = day + 15.5 * 3_600_000, m15: Candle[] = [];
    for (let t = day + 12 * 3_600_000; t < s; t += M15) m15.push(bar(t, 200, 201, 199, 200));
    const p = [[200.4, 203.9, 199.2, 203.1, 2], [203.1, 205.6, 202.8, 205.0, 1], [205.0, 206.3, 204.1, 204.5, 3], [204.5, 204.9, 201.7, 202.2, 1], [202.2, 202.9, 200.1, 200.8, 2], [200.8, 207.2, 200.5, 207.0, 4]] as const;
    p.forEach(([o, h, l, c, v], k) => m15.push(bar(s + k * M15, o, h, l, c, v)));
    m15.push(bar(s + 6 * M15, 207, 208, 206, 207)); // opens at 17:00: not closed at t
    const t = s + 6 * M15, r = domKeyLevels(m15, d1, t), L = Object.fromEntries(r.levels.map((x) => [x.note, x.v]));
    expect([r.periodStart, r.bars]).toEqual([s, 6]);
    // The week before: daily bars 10-05 .. 10-11 (k = 0..6): high 116.7, low 90.2, close 111.6.
    expect([L.PWS, L.PWH, L.PWL, L.PWM]).toEqual([111, 116, 90, 103]);
    // The day before (10-13, k = 8): high 118.7, low 98.2, close 113.6.
    expect([L.PDS, L.PDH, L.PDL, L.PDM]).toEqual([113, 118, 98, 108]);
    expect([L['session open'], L.HOD, L.LOD, L.MOD]).toEqual([200, 207, 199, 203]);
    expect([L.ORH, L.ORL]).toEqual([203, 199]);
    expect([L.IBH, L.IBL]).toEqual([206, 199]); // bars opening 15:30 .. 16:15
    const tp = p.map(([, h, l, c]) => (h + l + c) / 3), vs = p.map((x) => x[4]), V = vs.reduce((a, b) => a + b, 0);
    const vw = tp.reduce((a, x, k) => a + x * vs[k]!, 0) / V, sd = Math.sqrt(tp.reduce((a, x, k) => a + x * x * vs[k]!, 0) / V - vw * vw);
    expect(L['session VWAP']).toBe(Math.trunc(vw));
    expect([L['VWAP +1SD'], L['VWAP −2SD'], L['VWAP +3SD']]).toEqual([Math.trunc(vw + sd), Math.trunc(vw - 2 * sd), Math.trunc(vw + 3 * sd)]);
    // POC from the first 5 bars: each spreads its coins over the whole numbers from its high down to its low.
    const tot = new Map<number, number>();
    p.slice(0, 5).forEach(([, h, l, , v]) => { const n = Math.trunc(h - l) + 1; for (let x = Math.trunc(h); x >= Math.trunc(l); x--) tot.set(x, (tot.get(x) ?? 0) + v / n); });
    const best = [...tot].reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(L['session POC']).toBe(best[0]);
    expect(r.levels.find((x) => x.note === 'PWH')!.tf).toBe('W');
    expect(r.levels.find((x) => x.note === 'HOD')!.tf).toBe('4H');
  });

  test('on the period\'s first bar the POC reads 0 (not a level); bars after t change nothing', () => {
    const s = day + 15.5 * 3_600_000, m15 = [bar(s - M15, 100, 101, 99, 100), bar(s, 100, 102, 98, 101), bar(s + M15, 101, 150, 101, 149)];
    const r = domKeyLevels(m15, d1, s + M15);
    expect(r.levels.some((x) => x.note === 'session POC')).toBe(false);
    expect(r.bars).toBe(1);
    expect(domKeyLevels(m15, d1, s + M15)).toEqual(domKeyLevels(m15.slice(0, 2), d1, s + M15));
  });
});
