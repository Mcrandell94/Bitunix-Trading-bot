// The RSI framework's RSI length (owner 2026-10-18: "we could test our rsi14 system against a rsi 21 and rsi30 for most
// things we've built"). 14 is the live length. portfolio.ts --rsi-len 21 | 30 changes it for one research run: every
// study that builds the framework's setups (frameworkSetups in rsisignals.ts, momentumEvents' weekly RSI) and the
// 15M-RSI10 model's 4H / 1H / 15m / daily RSI (rsi10.ts; RSI 14 as live: the "10" in its name is not the length, owner
// 2026-10-18), the thresholds unchanged. The worker never changes it.
// Matched levels (owner 2026-10-19, "Try number 1": the RSI 14 levels mean something else on a slower RSI): with
// --rsi-match the longer RSI is mapped, per bar length, onto the RSI 14 reading reached as often (quantile matching on
// the run's own coins, bars before the run's older / newer cut only), so every level and pattern keeps its rule.
import { rsi } from '../indicators';

/** Per bar length (ms): RSI `len` at 0, 0.1 … 100 → the RSI 14 value reached as often. */
export interface RsiMatch { tables: Record<number, Float64Array>; to: number }
export const RSI_FRAMEWORK: { len: number; match: RsiMatch | null } = { len: 14, match: null };

const lookup = (t: Float64Array, v: number) => { const x = Math.min(1000, Math.max(0, v * 10)), i = Math.floor(x); return i >= 1000 ? t[1000]! : t[i]! + (x - i) * (t[i + 1]! - t[i]!); };

/** The framework's RSI of closes of one bar length: RSI 14 live; in a research run RSI `len`, matched to RSI 14 when set. */
export function frameworkRsi(closes: ReadonlyArray<number>, barMs: number): (number | null)[] {
  const r = rsi(closes, RSI_FRAMEWORK.len), t = RSI_FRAMEWORK.len !== 14 ? RSI_FRAMEWORK.match?.tables[barMs] : undefined;
  return t ? r.map((v) => (v == null ? null : lookup(t, v))) : r;
}

/** The quantile map from RSI `len` to RSI 14 over the given close series (pooled): for each RSI `len` level, the RSI 14
 * level with the same share of readings at or under it. */
export function rsiMatchTable(series: ReadonlyArray<ReadonlyArray<number>>, len: number): Float64Array {
  const a: number[] = [], b: number[] = [];
  for (const c of series) {
    for (const v of rsi(c, 14)) if (v != null) a.push(v);
    for (const v of rsi(c, len)) if (v != null) b.push(v);
  }
  a.sort((x, y) => x - y);
  b.sort((x, y) => x - y);
  const t = new Float64Array(1001);
  if (!a.length || !b.length) { for (let k = 0; k <= 1000; k++) t[k] = k / 10; return t; }
  let j = 0;
  for (let k = 0; k <= 1000; k++) {
    while (j < b.length && b[j]! <= k / 10) j++;
    const pos = (j / b.length) * (a.length - 1), i = Math.floor(pos);
    t[k] = i >= a.length - 1 ? a[a.length - 1]! : a[i]! + (pos - i) * (a[i + 1]! - a[i]!);
  }
  return t;
}
