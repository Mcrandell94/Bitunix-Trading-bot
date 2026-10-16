// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Liquidity Structure & Order Flow [LuxAlgo]"
// (Pine v6, © LuxAlgo) for the owner's ETH / BTC cards (owner 2026-10-16, cards v3). Calculations only (no heatmap,
// curves, delta panel, bubbles or dashboard), default inputs: lookback 300, not weighted, value area 70%, smoothing 3,
// bubbles at a z-score of 2. This port is shared under the same licence: non-commercial use only.
//
// Bar-for-bar notes (the script draws on the last bar only; here "the last bar" is bar i):
// - Range: the highest high and lowest low of the last 300 bars (the bar itself included), 150 bins of equal height.
// - Profile: each of the 300 bars puts its volume in the bin of its close (int((close - low) / step), clamped). Each bin
//   is then smoothed over the 3 bins either side, weight 1 / (1 + distance), divided by the weights in range.
// - POC: the smoothed bin with the most volume (the first if tied), at its middle. Value area: from the POC, add the
//   bigger neighbour (up on a tie) until 70% of the raw total; VAH = the top of the last bin up, VAL = the bottom of the
//   last bin down. Mid = the middle of the range.
// - Widest void: the longest run of smoothed bins under 15% of the POC's (the first if tied); with none the script still
//   draws its box on the bottom bin.
// - Dashboard: the mass over / under the mid (smoothed bins whose bottom is at the mid or over it count up), the skew,
//   the buy / sell volume of up / down closes (the aggregated delta), the distance to the POC and the range location.
// - Unusual volume bubbles: bars of the last 300 whose volume is at least 2 stdevs over its 200-bar mean (population)
//   and over 1.5x that mean.
// - The card takes the POC, VAH and VAL as Liq levels (the profile's own lines). The mid and the range edges are the
//   300-bar range itself, and the void is where volume is missing, so they are shown in the chart check only.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taSma, taStdev } from './pine';

export const LSOF = { lookback: 300, bins: 150, va: 70, smoothing: 3, voidShare: 0.15, volLen: 200, z: 2, rvol: 1.5 } as const;

export interface LsofProfile {
  highs: number; lows: number; mid: number; step: number;
  raw: number[]; smooth: number[]; pocIdx: number; poc: number; vah: number; val: number;
  void: { lo: number; hi: number; bins: number };
  upperVol: number; lowerVol: number; upperPct: number; lowerPct: number; skew: number;
  buyVol: number; sellVol: number; delta: number; total: number; distToPoc: number; rangeLoc: number;
  /** The unusual-volume bars of the window (bar index, z-score, up close), oldest first. */
  bubbles: { i: number; z: number; bull: boolean }[];
}

/** The profile at the close of bar i (bars up to i only), or null before 300 bars. */
export function lsofProfile(c: ReadonlyArray<Candle>, i: number = c.length - 1): LsofProfile | null {
  const { lookback: L, bins: N, smoothing: S } = LSOF;
  if (i < L - 1 || i >= c.length) return null;
  const cc = c.slice(0, i + 1), vol = coinVolume(cc).map((v) => (Number.isNaN(v) ? 0 : v));
  let highs = -Infinity, lows = Infinity;
  for (let k = i - L + 1; k <= i; k++) { highs = Math.max(highs, cc[k]!.high); lows = Math.min(lows, cc[k]!.low); }
  const range = highs - lows, mid = (highs + lows) / 2, step = range / N;
  if (!(range > 0)) return null;
  const raw = new Array<number>(N).fill(0);
  let buyVol = 0, sellVol = 0;
  for (let k = i; k > i - L; k--) {
    const b = cc[k]!, v = vol[k]!;
    if (b.close > b.open) buyVol += v; else if (b.close < b.open) sellVol += v;
    raw[Math.min(N - 1, Math.max(0, Math.trunc((b.close - lows) / step)))]! += v;
  }
  const smooth = raw.map((_, k) => {
    let sum = 0, w = 0;
    for (let s = -S; s <= S; s++) { const x = k + s; if (x >= 0 && x < N) { const sw = 1 / (1 + Math.abs(s)); sum += raw[x]! * sw; w += sw; } }
    return sum / w;
  });
  const maxVol = Math.max(...smooth), total = raw.reduce((a, b) => a + b, 0), pocIdx = smooth.indexOf(maxVol), poc = lows + step * pocIdx + step / 2;

  const thr = maxVol * LSOF.voidShare;
  let vs = 0, ve = 0, cur = -1, best = 0;
  for (let k = 0; k < N; k++) {
    if (smooth[k]! < thr) { if (cur === -1) cur = k; if (k - cur + 1 > best) { best = k - cur + 1; vs = cur; ve = k; } } else cur = -1;
  }

  const target = total * (LSOF.va / 100);
  let vaVol = smooth[pocIdx]!, up = pocIdx, dn = pocIdx;
  while (vaVol < target && (up < N - 1 || dn > 0)) {
    const uV = up < N - 1 ? smooth[up + 1]! : 0, dV = dn > 0 ? smooth[dn - 1]! : 0;
    if (uV >= dV && up < N - 1) { up++; vaVol += uV; } else if (dn > 0) { dn--; vaVol += dV; } else break;
  }

  let upperVol = 0, lowerVol = 0;
  for (let k = 0; k < N; k++) if (lows + k * step >= mid) upperVol += smooth[k]!; else lowerVol += smooth[k]!;
  const close = cc[i]!.close;

  const ma = taSma(vol, LSOF.volLen), sd = taStdev(vol, LSOF.volLen), bubbles: LsofProfile['bubbles'] = [];
  for (let k = i - L + 1; k <= i; k++) {
    const m = Number.isNaN(ma[k]!) ? 0 : ma[k]!, s = Number.isNaN(sd[k]!) ? 0 : sd[k]!, z = s > 0 ? (vol[k]! - m) / s : 0;
    if (z >= LSOF.z && (m > 0 ? vol[k]! / m : 0) > LSOF.rvol) bubbles.push({ i: k, z, bull: cc[k]!.close > cc[k]!.open });
  }
  return {
    highs, lows, mid, step, raw, smooth, pocIdx, poc, vah: lows + (up + 1) * step, val: lows + dn * step,
    void: { lo: lows + vs * step, hi: lows + (ve + 1) * step, bins: best },
    upperVol, lowerVol, upperPct: (upperVol / total) * 100, lowerPct: (lowerVol / total) * 100, skew: upperVol / Math.max(0.1, lowerVol),
    buyVol, sellVol, delta: buyVol - sellVol, total, distToPoc: ((close - poc) / close) * 100, rangeLoc: ((close - lows) / Math.max(0.0001, range)) * 100,
    bubbles,
  };
}
