// TypeScript port of "ADX and DI [xdecow]" (Pine v3; the copy given has no licence header, TradingView's default for
// open scripts is MPL 2.0) for the owner's script library (owner 2026-10-17). Calculations only (no plots or bar
// colours), default inputs: ADX length 8, smoothing 8, trend threshold 25, the chart's own resolution.
//
// Bar-for-bar notes:
// - up = high - high[1], down = low[1] - low (na on the first bar, so its DM reads 0). +DM = up when up > down and
//   up > 0, else 0; -DM mirrored. +DI = fixnan(100 x RMA 8 of +DM / RMA 8 of the true range) (the true range is na on
//   the first bar; fixnan keeps the last value through na, e.g. a 0 range: x / 0), -DI the same.
// - ADX = 100 x RMA 8 of |+DI - -DI| / (+DI + -DI, 1 when that is 0).
// - Trend: ADX over 25 = up (+DI over -DI) or down; else none. Rising: ADX over each of its 2 previous values.
// It gives no price levels, so it is not one of the card's POI scripts; the preview's chart check shows its reading.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taRma, trueRange } from './pine';

export const ADXDI = { length: 8, smoothing: 8, threshold: 25 } as const;

export interface AdxSeries { adx: number[]; plus: number[]; minus: number[]; trend: (1 | -1 | 0)[]; rising: boolean[] }

const fixnan = (xs: number[]) => { let last = NaN; return xs.map((x) => (Number.isFinite(x) ? (last = x) : last)); };

export function adxDi(c: ReadonlyArray<Candle>): AdxSeries {
  const { length, smoothing, threshold } = ADXDI;
  const up = c.map((b, i) => (i > 0 ? b.high - c[i - 1]!.high : NaN)), dn = c.map((b, i) => (i > 0 ? c[i - 1]!.low - b.low : NaN));
  const tr = taRma(trueRange(c).map((x, i) => (i === 0 ? NaN : x)), length);
  const pdm = taRma(up.map((u, i) => (u > dn[i]! && u > 0 ? u : 0)), length), mdm = taRma(dn.map((d, i) => (d > up[i]! && d > 0 ? d : 0)), length);
  const plus = fixnan(pdm.map((x, i) => (tr[i]! !== 0 ? (100 * x) / tr[i]! : NaN))), minus = fixnan(mdm.map((x, i) => (tr[i]! !== 0 ? (100 * x) / tr[i]! : NaN)));
  const adx = taRma(plus.map((p, i) => { const s = p + minus[i]!; return Math.abs(p - minus[i]!) / (s === 0 ? 1 : s); }), smoothing).map((x) => 100 * x);
  const trend = adx.map((a, i): 1 | -1 | 0 => (a > threshold ? (plus[i]! > minus[i]! ? 1 : -1) : 0));
  const rising = adx.map((a, i) => i >= 2 && a > adx[i - 1]! && a > adx[i - 2]!);
  return { adx, plus, minus, trend, rising };
}
