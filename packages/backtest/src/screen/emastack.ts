// The EMA stacks on the ETH and BTC cards (owner 2026-10-11, from the owner's notes on which EMA is the switch on each
// coin; their figures are checked separately by emaregime.ts before anything leans on them). Display only. Each value
// uses closed bars: daily values at the last daily close, weekly values at the last closed week (Monday weeks), 4H
// values at the last 4H close. EMAs are Pine's ta.ema (taEma, SMA-seeded).
//
// The stacks, as the notes give them:
// - ETH: bias = the daily close vs EMA 26 (long above, flat below); pair 13 / 21; weekly close vs W13 and W21; short
//   confirmation = under 26 with EMA 12 under EMA 26; 4H trigger = an 8 / 21 or 5 / 8 cross in the bias direction,
//   limits at EMA 8 / 13.
// - BTC: bias = the daily close vs EMA 26, slow bias vs EMA 144; pair 9 / 89; weekly permission = the weekly close over
//   W5, veto = under W34; 4H trigger = a 5 / 8 cross under the 26 / 144 permission, limits at EMA 8 / 13.
// - BTC short check (shown under 26, "short OK" at 2 of 3): (1) EMA 9 under 89 or EMA 12 under 26; (2) three daily
//   closes under 26, or a failed retest in the current stretch under 26 (a bar after the first whose high reaches EMA 26
//   and closes back under it); (3) not the first tag after a vertical run. The notes give no number for a run; fixed
//   here: a close >= 15% over EMA 26 within the 20 days before the stretch began, with no other stretch under 26 since.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taEma } from './pine';
import { aggregate } from './wyckoffhtf';

export type StackCoin = 'ETHUSDT' | 'BTCUSDT';
export const EMA_STACK = {
  ETHUSDT: { bias: 26, slow: null, pair: [13, 21], weekly: [13, 21], trigger: [[8, 21], [5, 8]], limits: [8, 13] },
  BTCUSDT: { bias: 26, slow: 144, pair: [9, 89], weekly: [5, 34], trigger: [[5, 8]], limits: [8, 13] },
} as const;
export const VERTICAL_RUN = { pct: 15, days: 20 } as const;

/** Daily, weekly and 4H EMA series of one coin. */
export interface StackSeries {
  coin: StackCoin; d1: ReadonlyArray<Candle>; h4: ReadonlyArray<Candle>; weeks: { c: Candle[]; ends: number[] };
  dEma: Map<number, number[]>; wEma: Map<number, number[]>; hEma: Map<number, number[]>;
}
export function stackSeries(coin: StackCoin, d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>): StackSeries {
  const S = EMA_STACK[coin], dc = d1.map((b) => b.close), weeks = aggregate(d1, 'W'), wc = weeks.c.map((b) => b.close), hc = h4.map((b) => b.close);
  const dLens = new Set<number>([S.bias, 12, 26, ...S.pair, ...(S.slow ? [S.slow] : [])]), hLens = new Set<number>([...S.trigger.flat(), ...S.limits]);
  return {
    coin, d1, h4, weeks,
    dEma: new Map([...dLens].map((n) => [n, taEma(dc, n)])), wEma: new Map(S.weekly.map((n) => [n, taEma(wc, n)])), hEma: new Map([...hLens].map((n) => [n, taEma(hc, n)])),
  };
}

const DAY = 86_400_000, H4 = 4 * 3_600_000;
const lastIdx = (c: ReadonlyArray<{ openTime: number }>, ms: number, t: number) => { let k = -1; for (let lo = 0, hi = c.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (c[m]!.openTime + ms <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
/** The open time of the bar where `above(k)` last changed (NaN if never in range). */
function since(k: number, above: (j: number) => boolean | null, time: (j: number) => number): number {
  const now = above(k);
  if (now == null) return NaN;
  let j = k;
  while (j > 0 && above(j - 1) === now) j--;
  return j > 0 ? time(j) : NaN;
}

export interface LineState { n: number; ema: number; over: boolean; pct: number; since: number }
export interface PairState { fast: number; slow: number; fastV: number; slowV: number; over: boolean; since: number }
export interface StackAt {
  coin: StackCoin; dayAt: number; close: number;
  bias: LineState | null; slow: LineState | null; pair: PairState | null;
  weekly: { weekOf: number; lines: { n: number; ema: number; over: boolean }[] } | null;
  /** ETH: under 26 with 12 under 26. BTC: the 2-of-3 check (null items when not under 26). */
  shortConfirm: boolean | null; shortCheck: { items: [boolean, boolean, boolean]; count: number } | null;
  trigger: { pairs: (PairState & { time: number })[]; limits: { n: number; v: number }[] } | null;
}

function lineAt(s: StackSeries, n: number, k: number): LineState | null {
  const e = s.dEma.get(n)!, c = s.d1;
  if (k < 0 || Number.isNaN(e[k]!)) return null;
  const above = (j: number) => (Number.isNaN(e[j]!) ? null : c[j]!.close > e[j]!);
  return { n, ema: e[k]!, over: c[k]!.close > e[k]!, pct: (c[k]!.close / e[k]! - 1) * 100, since: since(k, above, (j) => c[j]!.openTime) };
}
function pairAt(m: Map<number, number[]>, a: number, b: number, k: number, time: (j: number) => number): PairState | null {
  const f = m.get(a)!, g = m.get(b)!;
  if (k < 0 || Number.isNaN(f[k]!) || Number.isNaN(g[k]!)) return null;
  const above = (j: number) => (Number.isNaN(f[j]!) || Number.isNaN(g[j]!) ? null : f[j]! > g[j]!);
  return { fast: a, slow: b, fastV: f[k]!, slowV: g[k]!, over: f[k]! > g[k]!, since: since(k, above, time) };
}

/** The BTC 2-of-3 short check at daily bar k (null when the close is not under EMA 26). */
export function btcShortCheck(s: StackSeries, k: number): { items: [boolean, boolean, boolean]; count: number } | null {
  const c = s.d1, e26 = s.dEma.get(26)!, e12 = s.dEma.get(12)!, e9 = s.dEma.get(9)!, e89 = s.dEma.get(89)!;
  const under = (j: number) => j >= 0 && !Number.isNaN(e26[j]!) && c[j]!.close < e26[j]!;
  if (!under(k)) return null;
  const i1 = (!Number.isNaN(e89[k]!) && e9[k]! < e89[k]!) || e12[k]! < e26[k]!;
  let start = k;
  while (start > 0 && under(start - 1)) start--;
  let retest = false;
  for (let j = start + 1; j <= k; j++) if (c[j]!.high >= e26[j]! && c[j]!.close < e26[j]!) retest = true;
  const i2 = k - start + 1 >= 3 || retest;
  // (3) The stretch is the first tag after a vertical run: a close >= 15% over 26 within the 20 days before it began,
  // with no close under 26 between that run close and the stretch.
  let runAt = -1;
  for (let j = start - 1; j >= Math.max(0, start - VERTICAL_RUN.days); j--) if (!Number.isNaN(e26[j]!) && c[j]!.close >= e26[j]! * (1 + VERTICAL_RUN.pct / 100)) { runAt = j; break; }
  let firstTag = false;
  if (runAt >= 0) { firstTag = true; for (let j = runAt + 1; j < start; j++) if (under(j)) firstTag = false; }
  const items: [boolean, boolean, boolean] = [i1, i2, !firstTag];
  return { items, count: items.filter(Boolean).length };
}

/** Everything the stack shows at time t (a bar close). */
export function stackAt(s: StackSeries, t: number): StackAt {
  const S = EMA_STACK[s.coin], k = lastIdx(s.d1, DAY, t), dt = (j: number) => s.d1[j]!.openTime;
  let wk = -1;
  for (let j = 0; j < s.weeks.ends.length && s.weeks.ends[j]! <= t; j++) wk = j;
  const kh = lastIdx(s.h4, H4, t), ht = (j: number) => s.h4[j]!.openTime;
  const bias = lineAt(s, S.bias, k), e26 = s.dEma.get(26)!, e12 = s.dEma.get(12)!;
  return {
    coin: s.coin, dayAt: k >= 0 ? dt(k) : NaN, close: k >= 0 ? s.d1[k]!.close : NaN,
    bias, slow: S.slow ? lineAt(s, S.slow, k) : null, pair: pairAt(s.dEma, S.pair[0], S.pair[1], k, dt),
    weekly: wk >= 0 ? { weekOf: s.weeks.c[wk]!.openTime, lines: S.weekly.map((n) => ({ n, ema: s.wEma.get(n)![wk]!, over: s.weeks.c[wk]!.close > s.wEma.get(n)![wk]! })).filter((x) => !Number.isNaN(x.ema)) } : null,
    shortConfirm: s.coin === 'ETHUSDT' && k >= 0 && !Number.isNaN(e26[k]!) ? s.d1[k]!.close < e26[k]! && e12[k]! < e26[k]! : null,
    shortCheck: s.coin === 'BTCUSDT' && k >= 0 ? btcShortCheck(s, k) : null,
    trigger: kh >= 0 ? { pairs: S.trigger.map(([a, b]) => pairAt(s.hEma, a, b, kh, ht)).filter((p): p is PairState => p != null).map((p) => ({ ...p, time: ht(kh) })), limits: S.limits.map((n) => ({ n, v: s.hEma.get(n)![kh]! })) } : null,
  };
}

/**
 * The bias side for the 4H trigger: +1 long allowed, -1 short allowed, 0 neither. ETH: over 26 = long; under 26 with the
 * short confirmation = short. BTC: over 26 and over 144 = long; under 26 with the short check at 2+ = short.
 */
export function biasSide(a: StackAt): 1 | -1 | 0 {
  if (!a.bias) return 0;
  if (a.coin === 'ETHUSDT') return a.bias.over ? 1 : a.shortConfirm ? -1 : 0;
  if (a.bias.over) return a.slow?.over ? 1 : 0;
  return (a.shortCheck?.count ?? 0) >= 2 ? -1 : 0;
}
