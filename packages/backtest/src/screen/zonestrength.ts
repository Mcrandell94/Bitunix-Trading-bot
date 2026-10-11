// Zone strength filter for the ETH card (owner 2026-10-11: "Make sure what it sends doesn't prioritize passing along any
// weak fvg, orderblocks or supply demand zones"). Fixed before the preview run (plan "zonestrength.ts"):
// - An order block / POI is STRONG when it is unmitigated, its impulse (displacement) candle's body is >= 1.0 x ATR(14)
//   (the script draws a block from 0.7), and that candle's volume is >= 1.5 x the mean of the 20 bars before it.
// - Confluence tag: a strong zone within 0.25 ATR of a key level (PWH / PWL / PDH / PDL / either EQ) or of a 1D zone.
// - At most the 2 strong zones nearest the price, per side and timeframe, are sent; weaker ones are only counted.
// - A Trinity reversal is STRONG when the script's own strength is >= 60%; only strong signals and levels are sent.
// - Later templates' FVGs and supply / demand zones get a rule of the same kind before they are added.
// - Check (preview run): how often strong and weak blocks held on their first touch (price moved 1 ATR away from the
//   zone before a close through it).
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume } from './pine';
import type { ObZone } from './shaakuni';
import type { TrinitySignal } from './trinity';

export const ZONE_RULE = { impulseAtr: 1.0, volumeMult: 1.5, volumeBars: 20, confluenceAtr: 0.25, perSide: 2, trinityStrength: 60, holdAtr: 1 } as const;
export interface ObStrength { impulseAtr: number; volumeMult: number; strong: boolean }

/** The impulse size (in ATRs at the confirming bar) and volume multiple of a block, and whether it is strong (unmitigation is checked where it is used). */
export function obStrength(c: ReadonlyArray<Candle>, z: ObZone, vol: ReadonlyArray<number> = coinVolume(c)): ObStrength {
  const b = c[z.impulseBar]!, body = Math.abs(b.close - b.open), impulseAtr = z.atr > 0 ? body / z.atr : 0;
  let sum = 0, n = 0;
  for (let k = Math.max(0, z.impulseBar - ZONE_RULE.volumeBars); k < z.impulseBar; k++) if (!Number.isNaN(vol[k]!)) { sum += vol[k]!; n++; }
  const volumeMult = n > 0 && sum > 0 && !Number.isNaN(vol[z.impulseBar]!) ? vol[z.impulseBar]! / (sum / n) : 0;
  return { impulseAtr, volumeMult, strong: impulseAtr >= ZONE_RULE.impulseAtr && volumeMult >= ZONE_RULE.volumeMult };
}

export const strongTrinity = (s: TrinitySignal) => s.strength >= ZONE_RULE.trinityStrength;

/** The labels of the key levels / other zones within 0.25 ATR of the zone. */
export function confluence(z: { top: number; bottom: number }, atr: number, levels: ReadonlyArray<{ price: number; label: string }>): string[] {
  const tol = ZONE_RULE.confluenceAtr * atr;
  return levels.filter((l) => Number.isFinite(l.price) && l.price >= z.bottom - tol && l.price <= z.top + tol).map((l) => l.label);
}

/** The strong zones nearest `price` on each side (at most 2 each) and how many weaker ones are not shown. */
export function pickZones<T extends { side: 1 | -1; top: number; bottom: number }>(zones: ReadonlyArray<T>, strong: (z: T) => boolean, price: number): { shown: T[]; hidden: number } {
  const dist = (z: T) => (price > z.top ? price - z.top : price < z.bottom ? z.bottom - price : 0);
  const shown: T[] = [];
  for (const side of [1, -1] as const) shown.push(...zones.filter((z) => z.side === side && strong(z)).sort((a, b) => dist(a) - dist(b)).slice(0, ZONE_RULE.perSide));
  return { shown, hidden: zones.length - shown.length };
}

/** First touch of each touched block: held = price moved 1 ATR (at creation) away before a close through the zone. */
export function firstTouchHolds(c: ReadonlyArray<Candle>, zones: ReadonlyArray<ObZone>): { zone: ObZone; held: boolean }[] {
  const out: { zone: ObZone; held: boolean }[] = [];
  for (const z of zones) {
    if (z.mitigatedAt < 0 || (z.droppedAt >= 0 && z.droppedAt <= z.mitigatedAt)) continue;
    const away = ZONE_RULE.holdAtr * z.atr;
    for (let k = z.mitigatedAt; k < c.length; k++) {
      const b = c[k]!;
      if (z.side > 0 ? b.close < z.bottom : b.close > z.top) { out.push({ zone: z, held: false }); break; }
      if (z.side > 0 ? b.high >= z.top + away : b.low <= z.bottom - away) { out.push({ zone: z, held: true }); break; }
    }
  }
  return out;
}
