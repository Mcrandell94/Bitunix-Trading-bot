// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of "Prism Adaptive RSI [NeBlok]" (Pine Script v6, MPL-2.0, (c) NeBlok), for the owner's RSI
// confluence research (2026-10-03). Efficiency Ratio engine only (the script's default); the Dominant Cycle engine
// and all drawing are left out. Five layers: the same adaptive RSI at staggered speeds, fast to slow.

export interface PrismSettings { minLen: number; maxLen: number; erLen: number; spread: number; postSmooth: number }
export const PRISM_DEFAULTS: PrismSettings = { minLen: 8, maxLen: 34, erLen: 20, spread: 0.5, postSmooth: 2 };
export interface PrismSeries { fast: number[]; l2: number[]; mid: number[]; l4: number[]; slow: number[]; baseLen: number[] }

/** Pine ta.ema: na for the first len-1 bars, seeded with the SMA, then alpha = 2 / (len + 1). NaN = na. */
function pineEma(src: ReadonlyArray<number>, len: number): number[] {
  const out = new Array<number>(src.length).fill(NaN), a = 2 / (len + 1);
  let prev = NaN, run = 0, cnt = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    if (Number.isNaN(prev)) {
      if (Number.isNaN(v)) { run = 0; cnt = 0; continue; }
      run += v; cnt++;
      if (cnt >= len) { prev = run / len; out[i] = prev; }
      else if (len === 1) { prev = v; out[i] = v; }
      continue;
    }
    prev = Number.isNaN(v) ? prev : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** The adaptive length per bar: maxLen - (maxLen - minLen) x efficiency ratio (EMA 3 of the raw ratio). */
export function prismBaseLen(src: ReadonlyArray<number>, s: PrismSettings = PRISM_DEFAULTS): number[] {
  const lo = Math.min(s.minLen, s.maxLen), hi = Math.max(s.minLen, s.maxLen), n = src.length;
  const raw = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i < s.erLen) continue; // math.sum is na until erLen bars -> erDen > 0 is false -> 0
    let den = 0;
    for (let k = i - s.erLen + 1; k <= i; k++) den += Math.abs(src[k]! - src[k - 1]!);
    raw[i] = den > 0 ? Math.abs(src[i]! - src[i - s.erLen]!) / den : 0;
  }
  const e = pineEma(raw, 3);
  return raw.map((r, i) => { const er = Number.isNaN(e[i]!) ? r : e[i]!; return hi - (hi - lo) * er; });
}

/** Wilder-style RSI with a fractional length that changes bar by bar (its own running state). */
function adaptiveRsi(src: ReadonlyArray<number>, len: ReadonlyArray<number>): number[] {
  let up = 0, dn = 0;
  return src.map((v, i) => {
    const L = Number.isFinite(len[i]!) ? Math.max(len[i]!, 2) : 14, a = 1 / L;
    const ch = i ? v - src[i - 1]! : 0;
    up = a * Math.max(ch, 0) + (1 - a) * up;
    dn = a * Math.max(-ch, 0) + (1 - a) * dn;
    return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
  });
}

export function prismRsi(src: ReadonlyArray<number>, s: PrismSettings = PRISM_DEFAULTS): PrismSeries {
  const base = prismBaseLen(src, s);
  const layer = (k: number) => pineEma(adaptiveRsi(src, base.map((b) => b * k)), s.postSmooth);
  return {
    fast: layer(1 - s.spread), l2: layer(1 - s.spread * 0.5), mid: layer(1), l4: layer(1 + s.spread * 0.5), slow: layer(1 + s.spread), baseLen: base,
  };
}

/** The owner's zones (longs; shorts use 100 - value): 0-38 optimal, 38-55 safe, 55-75 risky, 75-100 caution. */
export type PrismZone = 'optimal' | 'safe' | 'risky' | 'caution';
export const prismZone = (v: number): PrismZone => (v < 38 ? 'optimal' : v < 55 ? 'safe' : v < 75 ? 'risky' : 'caution');
export const PRISM_ZONE_SCORE: Record<PrismZone, number> = { optimal: 2, safe: 1, risky: -1, caution: -2 };
