// TypeScript port of TradingView's built-in "Chop Zone" for the owner's ETH / BTC cards (2026-10-11: the owner circled it
// in TradingView's search, "for no longs but it doesn't stop shorts"). It replaces the Choppiness Index (chop.ts) in the
// KAMA filter and on the card. Calculations only (no columns drawn), default inputs.
//
// Bar-for-bar notes (built-in source kept):
// - avg = hlc3; span = 25 / (highest(high, 30) - lowest(low, 30)) x lowest(low, 30); EMA 34 of the close (ta.ema,
//   SMA-seeded, pine.ts); y = (EMA[1] - EMA) / avg x span; angle = round(180 x acos(1 / sqrt(1 + y^2)) / pi), negated
//   when y > 0 (EMA rising -> positive angle).
// - Colours: >= 5 turquoise, >= 3.57 dark green, >= 2.14 pale green, >= 0.71 lime; <= -5 dark red, <= -3.57 red,
//   <= -2.14 orange, <= -0.71 light orange; anything between (angle 0 after the rounding) is yellow = chop.
// - The owner's rule (ethreport.ts): a KAMA BUY is held off while the 4H Chop Zone is yellow; sells always go through.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taEma, taHighest, taLowest } from './pine';

export type ChopColor = 'turquoise' | 'dark green' | 'pale green' | 'lime' | 'yellow' | 'light orange' | 'orange' | 'red' | 'dark red';
export const CHOP_ZONE = { emaLen: 34, periods: 30 } as const;

export function zoneColor(angle: number): ChopColor | null {
  if (Number.isNaN(angle)) return null;
  return angle >= 5 ? 'turquoise' : angle >= 3.57 ? 'dark green' : angle >= 2.14 ? 'pale green' : angle >= 0.71 ? 'lime'
    : angle <= -5 ? 'dark red' : angle <= -3.57 ? 'red' : angle <= -2.14 ? 'orange' : angle <= -0.71 ? 'light orange' : 'yellow';
}
/** The colour's group: up shades, yellow (chop) or down shades. */
export const zoneGroup = (c: ChopColor | null): 'up' | 'chop' | 'down' | null => (c == null ? null : c === 'yellow' ? 'chop' : ['turquoise', 'dark green', 'pale green', 'lime'].includes(c) ? 'up' : 'down');
export const zoneEmoji = (c: ChopColor | null) => (c == null ? '·' : c === 'yellow' ? '🟨' : zoneGroup(c) === 'up' ? '🟩' : '🟥');

/** The Chop Zone angle and colour per bar. */
export function chopZone(c: ReadonlyArray<Candle>): { angle: number[]; color: (ChopColor | null)[] } {
  const Z = CHOP_ZONE, e = taEma(c.map((b) => b.close), Z.emaLen), hh = taHighest(c.map((b) => b.high), Z.periods), ll = taLowest(c.map((b) => b.low), Z.periods);
  const angle = c.map((b, i) => {
    const avg = (b.high + b.low + b.close) / 3, rng = hh[i]! - ll[i]!;
    if (i < 1 || Number.isNaN(e[i]!) || Number.isNaN(e[i - 1]!) || !(rng > 0) || !(avg > 0)) return NaN;
    const span = (25 / rng) * ll[i]!, y = ((e[i - 1]! - e[i]!) / avg) * span, a = Math.round((180 * Math.acos(1 / Math.sqrt(1 + y * y))) / Math.PI);
    return y > 0 ? -a : a;
  });
  return { angle, color: angle.map(zoneColor) };
}
