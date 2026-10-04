// Daily MACD read for a trade (owner 2026-10-04: "pre cross is optimal ... having some gap during entry and not at
// cross over or post cross over", "also consider spotting divergences in the MACD"). Shared by the live signal rows
// (display only, no rule uses it) and the research reports. MACD 12/26/9; h = MACD minus its signal line.

import type { Candle } from '@bot/marketdata';

export type MacdState = 'pre-cross' | 'just crossed' | 'with, older' | 'against, widening';

/**
 * The histogram's state at bar k for a trade in direction d:
 *  - pre-cross: h still against the trade, |h| shrinking (the lines converging, a gap still there);
 *  - just crossed: h the trade's way now, against it on one of the 3 bars before;
 *  - with, older: h the trade's way for 4+ bars;
 *  - against, widening: h against the trade and |h| not shrinking.
 * `shrinking` = bars in a row |h| has shrunk (up to 5); `sinceCross` = bars since h last changed side (up to 30).
 */
export function macdState(h: ReadonlyArray<number | null>, k: number, d: 1 | -1): { state: MacdState; shrinking: number; sinceCross: number | null } | null {
  const v = h[k];
  if (v == null || k < 4) return null;
  let shrinking = 0;
  for (let j = k; j > k - 6 && j > 0; j--) { const a = h[j], b = h[j - 1]; if (a == null || b == null || !(Math.abs(a) < Math.abs(b))) break; shrinking++; }
  let sinceCross: number | null = null;
  for (let j = 1; j <= 30 && k - j >= 0; j++) { const p = h[k - j]; if (p == null) break; if (Math.sign(p) !== Math.sign(v)) { sinceCross = j; break; } }
  if (d * v > 0) return { state: sinceCross != null && sinceCross <= 3 ? 'just crossed' : 'with, older', shrinking, sinceCross };
  return { state: shrinking > 0 ? 'pre-cross' : 'against, widening', shrinking, sinceCross };
}

/**
 * Regular MACD divergence at bar k for a trade in direction d, from the last two daily price pivots known by k
 * (pivot = the lowest low / highest high of 5 bars before and 2 after, so known 2 bars later), within `lookback` bars:
 * longs: price makes a lower (or equal) low while the MACD line makes a higher low; shorts mirror with highs.
 */
export function macdDivergence(c: ReadonlyArray<Candle>, line: ReadonlyArray<number | null>, k: number, d: 1 | -1, lookback = 60): boolean {
  const piv: number[] = [];
  for (let i = k - 2; i >= Math.max(5, k - lookback) && piv.length < 2; i--) {
    let ok = true;
    for (let j = i - 5; j <= i + 2 && ok; j++) {
      if (j === i) continue;
      // Strictly lower than the bars before it (a flat stretch is no pivot), not undercut by the 2 after.
      const a = d > 0 ? c[j]!.low : -c[j]!.high, b = d > 0 ? c[i]!.low : -c[i]!.high;
      if (j < i ? a <= b : a < b) ok = false;
    }
    if (ok && line[i] != null) piv.push(i);
  }
  if (piv.length < 2) return false;
  const [p2, p1] = piv as [number, number]; // p2 = the later pivot
  return d > 0
    ? c[p2]!.low <= c[p1]!.low && line[p2]! > line[p1]!
    : c[p2]!.high >= c[p1]!.high && line[p2]! < line[p1]!;
}
