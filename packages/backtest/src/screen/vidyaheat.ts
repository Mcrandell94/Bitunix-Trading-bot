// TypeScript port of "Heat Map Trend (VIDYA MA) [BigBeluga]" (Pine v5) for the owner's ETH / BTC cards (owner
// 2026-10-13, cards v2). Calculations only (no heat map, candles or table), default inputs: VIDYA length 10, momentum
// (CMO of volume) 10.
//
// Licence: Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (© BigBeluga). Non-commercial: fine for the
// owner's own cards and group; it must not go into a paid product or group.
//
// Bar-for-bar notes:
// - VIDYA: CMO(10) of the volume (the true range when the symbol has no volume), smoothed by an SMA(10); alpha =
//   2 / 11; vidya = alpha x |cmo| / 100 x close + (1 - alpha x |cmo| / 100) x vidya[1]. It starts from 0 (nz) on the
//   first bar the CMO exists (na before), as the script's `var` does, so it needs a long warm-up.
// - Per timeframe the script reads the previous closed bar's VIDYA (request.security(tf, vidya[1], lookahead_on))
//   and scores the chart bar as (hl2 - that VIDYA) / stdev(hl2 - that VIDYA, 200). The cards run it with the chart and
//   the timeframe the same (4H on 4H bars, daily on daily, weekly on weekly), one value per timeframe, instead of the
//   script's five fixed intraday timeframes (1H..6H) averaged; that average only exists on intraday charts.
// - Up when the value is over 0, down otherwise (the script's table). The labels: UP when the value crosses over 0.5
//   while the last label was not UP, DOWN when it crosses under -0.5 after an UP (a na start counts as not UP).
// - Weekly bars: with fewer than 200 weeks of history the deviation window is all the weeks with a value there are
//   (52 at least), an extension noted on the card; 4H and daily always use 200.
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taSma, trueRange } from './pine';

export const VIDYA = { len: 10, cmoLen: 10, devLen: 200, minDevLen: 52, label: 0.5 } as const;

/** Pine ta.cmo(src, len). */
export function taCmo(src: ReadonlyArray<number>, len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN);
  for (let i = len; i < src.length; i++) {
    let up = 0, dn = 0, bad = false;
    for (let k = i - len + 1; k <= i; k++) {
      const m = src[k]! - src[k - 1]!;
      if (Number.isNaN(m)) { bad = true; break; }
      if (m >= 0) up += m; else dn -= m;
    }
    if (!bad) out[i] = (100 * (up - dn)) / (up + dn);
  }
  return out;
}

export function vidyaLine(c: ReadonlyArray<Candle>): number[] {
  const V = VIDYA, v0 = coinVolume(c), hasVol = v0.some((x) => x > 0), src = hasVol ? v0.map((x) => x || 0) : trueRange(c);
  const cmo = taSma(taCmo(src, V.cmoLen), 10), a = 2 / (V.len + 1), out = new Array<number>(c.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < c.length; i++) {
    const k = (a * Math.abs(cmo[i]!)) / 100;
    prev = k * c[i]!.close + (1 - k) * (Number.isNaN(prev) ? 0 : prev);
    out[i] = prev;
  }
  return out;
}

export interface VidyaSeries { value: number[]; up: boolean[]; label: (1 | -1 | 0)[]; devLen: number }

/** The trend value per bar of one timeframe, its side and the UP / DOWN labels. */
export function vidyaHeat(c: ReadonlyArray<Candle>, weekly = false): VidyaSeries {
  const V = VIDYA, vid = vidyaLine(c), n = c.length;
  const diff = c.map((b, i) => (i >= 1 ? (b.high + b.low) / 2 - vid[i - 1]! : NaN));
  let run = 0;
  for (let i = n - 1; i >= 0 && !Number.isNaN(diff[i]!); i--) run++;
  const devLen = weekly && run < V.devLen ? Math.max(V.minDevLen, run) : V.devLen;
  const value = new Array<number>(n).fill(NaN), up: boolean[] = [], label: (1 | -1 | 0)[] = [];
  for (let i = 0; i < n; i++) {
    if (i >= devLen - 1) {
      let s = 0, ss = 0, bad = false;
      for (let k = i - devLen + 1; k <= i; k++) { const d = diff[k]!; if (Number.isNaN(d)) { bad = true; break; } s += d; }
      if (!bad) { const m = s / devLen; for (let k = i - devLen + 1; k <= i; k++) ss += (diff[k]! - m) ** 2; value[i] = diff[i]! / Math.sqrt(ss / devLen); }
    }
    up.push(value[i]! > 0);
  }
  let last = false;
  for (let i = 0; i < n; i++) {
    const v = value[i]!, p = i > 0 ? value[i - 1]! : NaN;
    let l: 1 | -1 | 0 = 0;
    if (v > V.label && p <= V.label && !last) { l = 1; last = true; }
    else if (v < -V.label && p >= -V.label && last) { l = -1; last = false; }
    label.push(l);
  }
  return { value, up, label, devLen };
}
