import { describe, expect, test } from 'vitest';
import type { Candle } from '@bot/marketdata';
import { BE_MODELS, beCheckReport, beVariants } from '../src/screen/becheck';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, ms: number): Candle => ({ openTime: Date.UTC(2020, 0, 1) + i * ms, open: o, high: h, low: l, close: c, volume: 1000 });

describe('breakeven check', () => {
  test('models and variants: the live models with breakeven; +3R / +5R only where the target is beyond them', () => {
    expect([...BE_MODELS].sort()).toEqual(['4h-fail-short', 'bottom-div', 'd-fail-short', 'triple-div', 'w-bear-div', 'w-dbl-bottom', 'w-top-div']);
    expect(beVariants('bottom-div').map((v) => v.be ?? null)).toEqual([2, null, 3, 5]);
    expect(beVariants('4h-fail-short').map((v) => v.be ?? null)).toEqual([2, null]);
  });

  test('on a random walk: the as-live run is the bot\'s own trades, and every model gets its lines', () => {
    const coins: Record<string, { candles: Record<string, Candle[]> }> = {};
    let seed = 11; // mulberry32
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
      const h4: Candle[] = [];
      let px = 100;
      for (let i = 0; i < 6 * 1500; i++) { const o = px; px = o * Math.exp((rnd() - 0.5) * 0.05); h4.push(bar(i, o, Math.max(o, px) * (1 + 0.01 * rnd()), Math.min(o, px) * (1 - 0.01 * rnd()), px, 4 * H)); }
      const d1: Candle[] = [];
      for (let k = 0; k + 6 <= h4.length; k += 6) { const g = h4.slice(k, k + 6); d1.push({ ...g[0]!, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)), close: g[5]!.close }); }
      coins[sym] = { candles: { '4h': h4, '1d': d1 } };
    }
    const d1 = coins['ETHUSDT']!.candles['1d']!;
    const out = beCheckReport(coins, Object.keys(coins), d1[300]!.openTime, d1[d1.length - 1]!.openTime, d1[900]!.openTime, new Set(['BTCUSDT']));
    expect(out[0]).toContain('3 coins');
    const [, matched, rows] = /matching the bot's signal rows: (\d+) of (\d+)/.exec(out[0]!)!.map(Number);
    expect(rows).toBeGreaterThan(5);
    expect(matched).toBe(rows);
    const be = out.filter((l) => l.startsWith('BE ')).map((l) => JSON.parse(l.slice(3)) as { m: string; v: string; n: number; be: number });
    expect(be.some((x) => x.v === 'no breakeven' && x.be === 0 && x.n > 0)).toBe(true); // no breakeven, no breakeven exits
    expect(out.some((l) => l.startsWith('  closed at breakeven, as live:'))).toBe(true);
    expect(out.some((l) => l.startsWith('All these models together'))).toBe(true);
  });
});
