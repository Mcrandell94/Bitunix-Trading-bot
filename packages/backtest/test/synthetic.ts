// A synthetic multi-symbol market for end-to-end runs of the real strategy:
// 15m random walks with trend regimes and occasional impulse candles, BTC
// and ETH correlated, alts partly following BTC.
import type { Candle } from '@bot/marketdata';
import { Q, START, symbolData } from './market';
import type { SymbolData } from '../src/index';

function lcg(seed: number) {
  let s = Math.imul(seed, 0x9e3779b1) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

export function syntheticMarket(days: number, seed = 1): Record<string, SymbolData> {
  const n = days * 96;
  const base = lcg(seed);
  const common: number[] = [];
  for (let i = 0; i < n; i++) {
    const regime = Math.sin(i / 300) * 0.0006;
    const impulse = base() < 0.02 ? (base() < 0.5 ? -1 : 1) * 0.012 : 0;
    common.push(regime + impulse + (base() - 0.5) * 0.006);
  }
  const make = (start: number, beta: number, own: number, s: number): Candle[] => {
    const r = lcg(s);
    let p = start;
    return common.map((m, i) => {
      const impulse = r() < 0.015 ? (r() < 0.5 ? -1 : 1) * own * 3 : 0;
      const ret = beta * m + Math.sin(i / (200 + s * 13)) * own * 0.15 + impulse + (r() - 0.5) * own;
      const o = p;
      const c = o * (1 + ret);
      const wick = Math.abs(ret) * 0.5 + own * 0.3 * r();
      p = c;
      return { openTime: START + i * Q, open: o, high: Math.max(o, c) * (1 + wick * r()), low: Math.min(o, c) * (1 - wick * r()), close: c, volume: 1000 * (1 + r()) };
    });
  };
  return {
    BTCUSDT: symbolData(make(60000, 1, 0.002, seed + 10)),
    ETHUSDT: symbolData(make(3000, 1.1, 0.003, seed + 20)),
    XRPUSDT: symbolData(make(0.6, 1.2, 0.005, seed + 30)),
    SOLUSDT: symbolData(make(150, 1.3, 0.006, seed + 40)),
    DOGEUSDT: symbolData(make(0.2, 1.4, 0.008, seed + 50)),
  };
}
