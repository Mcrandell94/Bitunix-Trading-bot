// TypeScript port of "Squeeze Momentum Indicator [LazyBear]" (shorttitle SQZMOM_LB, Pine v1, by LazyBear) for the
// owner's script library (owner 2026-10-16). The copy given has no licence header; TradingView's default for open
// scripts is MPL 2.0. Calculations only (no plots), default inputs: BB 20 / 2.0, KC 20 / 1.5, true range on.
//
// Bar-for-bar notes:
// - Bollinger bands: SMA 20 of the close ± 1.5 x stdev 20 (population). As written, the script multiplies the stdev by
//   the KC factor (multKC 1.5), not the BB factor (mult 2.0); the port keeps that, so it matches the chart.
// - Keltner channel: SMA 20 of the close ± 1.5 x SMA 20 of the true range (the `tr` variable: na on the first bar).
// - Squeeze on (black cross): both bands inside the channel; off (gray): both outside; no squeeze (blue) otherwise,
//   and on warm-up bars (a comparison with na is false).
// - Momentum: linreg(close - avg(avg(highest high 20, lowest low 20), SMA 20 of the close), 20, 0). Colour: over 0 and
//   over the previous bar (nz) = lime, over 0 otherwise = green; under the previous bar = red, otherwise maroon.
// It gives no price levels, so it is not one of the card's POI scripts; the preview's chart check shows its reading.
// Pure.

import type { Candle } from '@bot/marketdata';
import { nz, taHighest, taLinreg, taLowest, taSma, taStdev, trueRange } from './pine';

export const SQZ = { length: 20, mult: 2.0, lengthKC: 20, multKC: 1.5, useTrueRange: true } as const;
export type SqzState = 'on' | 'off' | 'none';
export type SqzColor = 'lime' | 'green' | 'red' | 'maroon';

export interface SqzSeries {
  /** Per bar: the momentum histogram and its colour (null on warm-up bars), and the squeeze state. */
  val: number[]; color: (SqzColor | null)[]; state: SqzState[];
  upperBB: number[]; lowerBB: number[]; upperKC: number[]; lowerKC: number[];
}

export function sqzMom(c: ReadonlyArray<Candle>): SqzSeries {
  const { length, lengthKC, multKC, useTrueRange } = SQZ, close = c.map((b) => b.close);
  const basis = taSma(close, length), sd = taStdev(close, length);
  const upperBB = basis.map((b, i) => b + multKC * sd[i]!), lowerBB = basis.map((b, i) => b - multKC * sd[i]!);
  const ma = taSma(close, lengthKC), tr = trueRange(c).map((x, i) => (i === 0 ? NaN : x));
  const rangema = taSma(useTrueRange ? tr : c.map((b) => b.high - b.low), lengthKC);
  const upperKC = ma.map((m, i) => m + rangema[i]! * multKC), lowerKC = ma.map((m, i) => m - rangema[i]! * multKC);
  const state = c.map((_, i): SqzState => (lowerBB[i]! > lowerKC[i]! && upperBB[i]! < upperKC[i]! ? 'on' : lowerBB[i]! < lowerKC[i]! && upperBB[i]! > upperKC[i]! ? 'off' : 'none'));
  const hh = taHighest(c.map((b) => b.high), lengthKC), ll = taLowest(c.map((b) => b.low), lengthKC);
  const val = taLinreg(close.map((x, i) => x - ((hh[i]! + ll[i]!) / 2 + ma[i]!) / 2), lengthKC, 0);
  const color = val.map((v, i): SqzColor | null => {
    if (Number.isNaN(v)) return null;
    const p = nz(i > 0 ? val[i - 1]! : NaN);
    return v > 0 ? (v > p ? 'lime' : 'green') : v < p ? 'red' : 'maroon';
  });
  return { val, color, state, upperBB, lowerBB, upperKC, lowerKC };
}
