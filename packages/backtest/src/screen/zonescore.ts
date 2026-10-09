// Zone strength (owner 2026-10-09: "use fvg, s/r channel and order block to build its own indicator", with LuxAlgo Smart
// Money Concepts as the template). One score per side at a bar, from the zones the bar's range touches: Smart Money
// Concepts order blocks (swing / internal) and fair value gaps (smclux.ts) and the deep S/R channels (srchannels.ts,
// 3+ pivots, as the 15M-RSI10 zone rules). Weights fixed before any test (no tuning):
//   swing OB 2, internal OB 1, FVG 1, deep S/R 2; daily zones x1.5, 4H x1; +1 if a touched OB / FVG is touched for the
//   first time; +1 in discount for a long / premium for a short (lower / upper half of the swing range); +1 if the swing
//   trend points the trade's way; capped at 10.

import type { Candle } from '@bot/marketdata';
import { smcZonesBefore, type Bias, type SmcSeries, type SmcZone } from './smclux';
import type { SrSeries } from './srchannels';

export type ZoneKind = 'ob-swing' | 'ob-internal' | 'fvg' | 'sr-deep';
export type ZoneTf = '4h' | '1d';
export interface ZoneHit { kind: ZoneKind; tf: ZoneTf; first: boolean; top: number; bottom: number }
export const ZONE_WEIGHTS: Record<ZoneKind, number> = { 'ob-swing': 2, 'ob-internal': 1, fvg: 1, 'sr-deep': 2 };
export const TF_MULT: Record<ZoneTf, number> = { '4h': 1, '1d': 1.5 };
const LABEL: Record<ZoneKind, string> = { 'ob-swing': 'swing OB', 'ob-internal': 'internal OB', fvg: 'FVG', 'sr-deep': 'S/R channel' };

/** The score and its labels; each kind / timeframe pair counts once. */
export function zoneScore(x: { hits: ReadonlyArray<ZoneHit>; discount: boolean; trendWith: boolean }): { score: number; labels: string[] } {
  const seen = new Map<string, ZoneHit>();
  for (const h of x.hits) if (!seen.has(`${h.kind}|${h.tf}`)) seen.set(`${h.kind}|${h.tf}`, h);
  let s = 0;
  for (const h of seen.values()) s += ZONE_WEIGHTS[h.kind] * TF_MULT[h.tf];
  if (x.hits.some((h) => h.first && h.kind !== 'sr-deep')) s += 1;
  if (x.discount) s += 1;
  if (x.trendWith) s += 1;
  return { score: Math.min(10, Math.round(s * 10) / 10), labels: [...seen.values()].map((h) => `${h.tf === '1d' ? '1D' : '4H'} ${LABEL[h.kind]}`) };
}

export interface TfZones { tf: ZoneTf; c: ReadonlyArray<Candle>; smc: SmcSeries; sr: SrSeries }

/** Did any bar after the zone formed and before t trade into it? */
function touchedBefore(c: ReadonlyArray<Candle>, z: SmcZone, t: number): boolean {
  for (let k = z.created + 1; k < t; k++) if (c[k]!.low <= z.top && c[k]!.high >= z.bottom) return true;
  return false;
}

/**
 * The zones of `side` (1 = bullish zones for a long, -1 = bearish for a short) alive entering bar t that the range
 * [lo, hi] overlaps; S/R channels (no side) as of the previous close. `zones` = the alive list for t if already known.
 */
export function zoneHitsAt(z: TfZones, t: number, side: Bias, lo: number, hi: number, zones?: ReadonlyArray<SmcZone>, firstTouch = true): ZoneHit[] {
  const out: ZoneHit[] = [];
  for (const x of zones ?? smcZonesBefore(z.smc, t)) {
    if (x.bias !== side || x.bottom > hi || x.top < lo) continue;
    out.push({ kind: x.kind, tf: z.tf, first: firstTouch && !touchedBefore(z.c, x, t), top: x.top, bottom: x.bottom });
  }
  for (const ch of t > 0 ? z.sr.channels[t - 1] ?? [] : []) if (ch.pivots >= 3 && ch.lo <= hi && ch.hi >= lo) out.push({ kind: 'sr-deep', tf: z.tf, first: false, top: ch.hi, bottom: ch.lo });
  return out;
}

/** Position of `px` in the swing range after bar t (0 = swing low, 1 = swing high); NaN if not known yet. */
export function rangePos(s: SmcSeries, t: number, px: number): number {
  const top = s.trailTop[t]!, bottom = s.trailBottom[t]!;
  return Number.isFinite(top) && Number.isFinite(bottom) && top > bottom ? (px - bottom) / (top - bottom) : NaN;
}
