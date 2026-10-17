import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { anchoredVwaps } from '../src/screen/vwapanchor';

const M15 = 15 * 60_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
/** Bars of `ms` from `from` for `n` bars; price rises 1 a bar; coins 1 + (k % 3). */
const series = (from: number, ms: number, n: number, p0 = 100): Candle[] => Array.from({ length: n }, (_, k) => {
  const c = p0 + k, h = c + 1, l = c - 1, coins = 1 + (k % 3);
  return { openTime: from + k * ms, open: c, high: h, low: l, close: c, volume: coins * (h + l + c) / 3 };
});
const byHand = (bars: Candle[]) => {
  const s = bars.map((b) => (b.high + b.low + b.close) / 3), v = bars.map((b) => b.volume! / ((b.high + b.low + b.close) / 3)), V = v.reduce((a, b) => a + b, 0);
  const vw = s.reduce((a, x, k) => a + x * v[k]!, 0) / V;
  return { vwap: vw, sd: Math.sqrt(s.reduce((a, x, k) => a + x * x * v[k]!, 0) / V - vw * vw) };
};

describe('Anchored VWAPs (weekly, daily, 4H)', () => {
  const mon = Date.UTC(2026, 9, 12); // a Monday
  const h1 = series(mon - 3 * DAY, H, 3 * 24 + 2 * 24 + 12), h4 = series(mon - 30 * DAY, H4, 30 * 6 + 2 * 6 + 3);
  const t = mon + 2 * DAY + 12 * H; // Wednesday 12:00, a 4H close
  const m15 = series(t - 2 * DAY, M15, 2 * 96 + 4); // two days back; the last 4 bars open after t

  test('weekly from Monday on 1H bars, daily from 00:00 and the 4H bar just closed on 15m; closed bars only', () => {
    const r = Object.fromEntries(anchoredVwaps(m15, h1, h4, t).map((x) => [x.tf, x]));
    const wBars = h1.filter((b) => b.openTime >= mon && b.openTime + H <= t), dBars = m15.filter((b) => b.openTime >= mon + 2 * DAY && b.openTime + M15 <= t);
    const qBars = m15.filter((b) => b.openTime >= t - H4 && b.openTime + M15 <= t);
    expect([r.W!.from, r.W!.barMs, r.W!.bars]).toEqual([mon, H, 60]);
    expect([r.D!.from, r.D!.barMs, r.D!.bars]).toEqual([mon + 2 * DAY, M15, 48]);
    expect([r['4H']!.from, r['4H']!.barMs, r['4H']!.bars]).toEqual([t - H4, M15, 16]);
    for (const [x, bars] of [[r.W!, wBars], [r.D!, dBars], [r['4H']!, qBars]] as const) {
      const h = byHand(bars as Candle[]);
      expect(x.vwap).toBeCloseTo(h.vwap, 9);
      expect(x.sd).toBeCloseTo(h.sd, 9);
    }
  });

  test('at 00:00 the day and 4H bar are the ones that just ended; a series that does not reach back is skipped', () => {
    const t0 = mon + 2 * DAY, r = Object.fromEntries(anchoredVwaps(m15, h1, h4, t0).map((x) => [x.tf, x]));
    expect([r.D!.from, r.D!.bars]).toEqual([mon + DAY, 96]);
    expect([r['4H']!.from, r['4H']!.bars]).toEqual([t0 - H4, 16]);
    // 15m bars from 06:00 only: the day falls back to 1H bars.
    const late = m15.filter((b) => b.openTime >= mon + 2 * DAY + 6 * H), d = anchoredVwaps(late, h1, h4, t).find((x) => x.tf === 'D')!;
    expect([d.barMs, d.bars]).toEqual([H, 12]);
    expect(anchoredVwaps([], [], [], t)).toEqual([]);
  });
});
