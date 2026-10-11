// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of "Trinity Reversal Pattern [AlgoAlpha]" (Pine Script v6, MPL-2.0, (c) AlgoAlpha), for the owner's ETH
// card (2026-10-11). Calculations only, default inputs: strength lookback 100, minimum strength 0, level expiry 100 bars,
// confirm on close, EMA trend filter off.
//
// Bar-for-bar notes (Pine semantics kept):
// - Bull: a green bar whose high clears the high 2 bars back, after two red bars whose lows / highs sit inside that bar
//   (low[1] < low[2], high[1] < high[2]); bear mirrored. From bar 2 on.
// - Strength = the bar's body / the largest body of the last 100 bars (this one included) x 100, capped at 100.
// - Level: the pattern's lowest low (bull) / highest high (bear). From the bar after the signal, a wick through the level
//   (low <= level for bull, high >= level for bear) ends it ("touched"); otherwise it expires at the close of the bar 100
//   bars after the signal. Existing levels are checked before the bar's own new level is added.
// Pure.

import type { Candle } from '@bot/marketdata';

export const TRINITY = { strengthLookback: 100, expiry: 100 } as const;
export interface TrinitySignal { i: number; dir: 1 | -1; strength: number; level: number; levelBar: number; touchedAt: number; expiredAt: number }

export function trinity(c: ReadonlyArray<Candle>): TrinitySignal[] {
  const out: TrinitySignal[] = [], bodies: number[] = [], active: TrinitySignal[] = [];
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, body = Math.abs(b.close - b.open);
    bodies.push(body);
    if (bodies.length > TRINITY.strengthLookback) bodies.shift();
    const largest = Math.max(...bodies), strength = largest > 0 ? Math.min(100, (body / largest) * 100) : 0;
    for (let k = active.length - 1; k >= 0; k--) {
      const s = active[k]!, age = i - s.i;
      if (age <= 0) continue;
      const touch = s.dir === 1 ? b.low <= s.level : b.high >= s.level;
      if (touch) { s.touchedAt = i; active.splice(k, 1); } else if (age >= TRINITY.expiry) { s.expiredAt = i; active.splice(k, 1); }
    }
    if (i < 2) continue;
    const p1 = c[i - 1]!, p2 = c[i - 2]!;
    const bull = b.close > b.open && b.high > p2.high && p1.low < p2.low && p1.high < p2.high && p1.close < p1.open && p2.close < p2.open;
    const bear = b.close < b.open && b.low < p2.low && p1.high > p2.high && p1.low > p2.low && p1.close > p1.open && p2.close > p2.open;
    if (!bull && !bear) continue;
    const lo = Math.min(b.low, p1.low, p2.low), hi = Math.max(b.high, p1.high, p2.high);
    const lowOff = b.low === lo ? 0 : p1.low === lo ? 1 : 2, highOff = b.high === hi ? 0 : p1.high === hi ? 1 : 2;
    const s: TrinitySignal = { i, dir: bull ? 1 : -1, strength, level: bull ? lo : hi, levelBar: i - (bull ? lowOff : highOff), touchedAt: -1, expiredAt: -1 };
    out.push(s);
    active.push(s);
  }
  return out;
}
