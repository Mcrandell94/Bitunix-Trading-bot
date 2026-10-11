// TypeScript port of "Range Breakout Targets [FEELS]" (Pine v6, version 2.5) for the ETH / BTC cards (owner 2026-10-11,
// round 4). The copy given has no licence header; TradingView's default for open scripts is MPL 2.0, noted as for
// Wyckoff. Calculations only (no boxes, lines, labels or panel), default inputs.
//
// Bar-for-bar notes (defaults kept), all on closed bars:
// - Tight: the 10-bar range as a share of the close, (highest(high, 10) - lowest(low, 10)) / close, is at or under the
//   30th percentile (nearest rank) of its last 200 values, from bar 201 on.
// - A quiet stretch opens on the first tight bar, starting 9 bars back (never before the bar after the last box
//   ended), and grows while bars stay tight. When it ends (a bar that is not tight), it becomes a box if it ran 15+
//   bars (counted from its start to that bar): its high / low exclude the ending bar. If the newest box still waiting
//   for its break overlaps it, that box widens to cover both and its 80-bar wait restarts; else a new box waits.
// - A waiting box breaks on a close over its high (under its low): the target is the broken edge + / - 1.0 x the box
//   height; a quiet stretch already under way is reset. A box with no break within 80 bars of its last start is dropped.
//   A target within 1% of an open target of the same direction is still followed but marked quiet (no words on the
//   chart; the card does not repeat it).
// - From the bar after the break: reached = a wick through the target; the first return to the broken edge is the
//   retest; a close back beyond the box's far side kills it (failed); otherwise it expires 120 bars after the break.
//   The order each bar: retest, then reached / failed / expired.
// - "Before the break": the newest waiting box (its edges), else a quiet stretch of 15+ bars still forming; its IF UP /
//   IF DOWN targets are its edges + / - its height.
// Pure.

import type { Candle } from '@bot/marketdata';
import { taHighest, taLowest } from './pine';

export const RANGE = { win: 10, hist: 200, pct: 30, minBars: 15, waitBrk: 80, mult: 1.0, expireAt: 120, dedupPct: 1.0 } as const;

export interface RangeBox { left: number; hi: number; lo: number; createdAt: number; waitFrom: number; brokeAt: number; droppedAt: number; joins: number }
export interface RangeTarget {
  up: boolean; px: number; edge: number; far: number; from: number; breakClose: number; box: RangeBox; quiet: boolean;
  retestAt: number; reachedAt: number; failedAt: number; expiredAt: number;
}
export type RangeKind = 'box' | 'join' | 'break' | 'retest' | 'reached' | 'failed' | 'expired' | 'dropped';
export interface RangeEvent { i: number; kind: RangeKind; box?: RangeBox; target?: RangeTarget }
/** The range price is in at each close: a waiting box, or a quiet stretch of 15+ bars still forming (NaN = none). */
export interface RangeNow { hi: Float64Array; lo: Float64Array; left: Int32Array; forming: Uint8Array }
export interface RangeSeries { boxes: RangeBox[]; targets: RangeTarget[]; events: RangeEvent[]; now: RangeNow; tight: boolean[] }

/** ta.percentile_nearest_rank over the last `len` non-NaN values (bar i included). */
export function percentileNearestRank(x: ReadonlyArray<number>, i: number, len: number, p: number): number {
  const w: number[] = [];
  for (let k = Math.max(0, i - len + 1); k <= i; k++) if (!Number.isNaN(x[k]!)) w.push(x[k]!);
  if (!w.length) return NaN;
  w.sort((a, b) => a - b);
  return w[Math.max(0, Math.ceil((p / 100) * w.length) - 1)]!;
}

export function rangeTargets(c: ReadonlyArray<Candle>): RangeSeries {
  const R = RANGE, n = c.length, hh = taHighest(c.map((b) => b.high), R.win), ll = taLowest(c.map((b) => b.low), R.win);
  const rng = c.map((b, i) => (hh[i]! - ll[i]!) / b.close), tight = rng.map((v, i) => i > R.hist && v <= percentileNearestRank(rng, i, R.hist, R.pct));
  const boxes: RangeBox[] = [], targets: RangeTarget[] = [], events: RangeEvent[] = [], pend: RangeBox[] = [], open: RangeTarget[] = [];
  const now: RangeNow = { hi: new Float64Array(n).fill(NaN), lo: new Float64Array(n).fill(NaN), left: new Int32Array(n).fill(-1), forming: new Uint8Array(n) };
  let curOpen = false, curFrom = 0, curHi = NaN, curLo = NaN, lastRight = -1;
  for (let i = 0; i < n; i++) {
    const b = c[i]!;
    // Stage one: the box being formed.
    if (tight[i]) {
      if (!curOpen) {
        curOpen = true; curFrom = Math.max(i - (R.win - 1), lastRight + 1); curHi = b.high; curLo = b.low;
        for (let k = curFrom; k < i; k++) { curHi = Math.max(curHi, c[k]!.high); curLo = Math.min(curLo, c[k]!.low); }
      } else { curHi = Math.max(curHi, b.high); curLo = Math.min(curLo, b.low); }
    } else if (curOpen) {
      curOpen = false;
      if (i - curFrom >= R.minBars) {
        const last = pend.at(-1);
        if (last && curLo <= last.hi && curHi >= last.lo) {
          last.hi = Math.max(last.hi, curHi); last.lo = Math.min(last.lo, curLo); last.waitFrom = i; last.joins++;
          events.push({ i, kind: 'join', box: last });
        } else {
          const x: RangeBox = { left: curFrom, hi: curHi, lo: curLo, createdAt: i, waitFrom: i, brokeAt: -1, droppedAt: -1, joins: 0 };
          boxes.push(x); pend.push(x); events.push({ i, kind: 'box', box: x });
        }
      }
    }
    // Stage two: finished boxes waiting for price to leave them.
    for (let k = pend.length - 1; k >= 0; k--) {
      const x = pend[k]!, up = b.close > x.hi, dn = b.close < x.lo;
      if (up || dn) {
        x.brokeAt = i; lastRight = i;
        const h = x.hi - x.lo, edge = up ? x.hi : x.lo, px = up ? edge + R.mult * h : edge - R.mult * h;
        const quiet = R.dedupPct > 0 && open.some((t) => t.up === up && Math.abs(t.px / px - 1) * 100 <= R.dedupPct);
        const t: RangeTarget = { up, px, edge, far: up ? x.lo : x.hi, from: i, breakClose: b.close, box: x, quiet, retestAt: -1, reachedAt: -1, failedAt: -1, expiredAt: -1 };
        targets.push(t); open.push(t); pend.splice(k, 1);
        events.push({ i, kind: 'break', box: x, target: t });
        if (curOpen) curOpen = false;
      } else if (i - x.waitFrom >= R.waitBrk) {
        lastRight = Math.max(lastRight, i - 1); x.droppedAt = i; pend.splice(k, 1);
        events.push({ i, kind: 'dropped', box: x });
      }
    }
    // Stage three: targets waiting to be reached.
    for (let k = open.length - 1; k >= 0; k--) {
      const t = open[k]!;
      if (i <= t.from) continue;
      if (t.retestAt < 0 && (t.up ? b.low <= t.edge : b.high >= t.edge)) { t.retestAt = i; events.push({ i, kind: 'retest', target: t }); }
      if (t.up ? b.high >= t.px : b.low <= t.px) { t.reachedAt = i; open.splice(k, 1); events.push({ i, kind: 'reached', target: t }); }
      else if (t.up ? b.close < t.far : b.close > t.far) { t.failedAt = i; open.splice(k, 1); events.push({ i, kind: 'failed', target: t }); }
      else if (i - t.from >= R.expireAt) { t.expiredAt = i; open.splice(k, 1); events.push({ i, kind: 'expired', target: t }); }
    }
    // Before the break.
    const w = pend.at(-1);
    if (w) { now.hi[i] = w.hi; now.lo[i] = w.lo; now.left[i] = w.left; }
    else if (curOpen && i - curFrom + 1 >= R.minBars) { now.hi[i] = curHi; now.lo[i] = curLo; now.left[i] = curFrom; now.forming[i] = 1; }
  }
  return { boxes, targets, events, now, tight };
}

/** Targets still open at bar i (broken by i, not yet reached, failed or expired by i). */
export const openTargets = (S: RangeSeries, i: number) => S.targets.filter((t) => t.from <= i && ![t.reachedAt, t.failedAt, t.expiredAt].some((x) => x >= 0 && x <= i));
/** How a target ended, and its result as a trade from the breakout close: to the target, the failure close or the expiry close. */
export function targetOutcome(c: ReadonlyArray<Candle>, t: RangeTarget): { end: 'reached' | 'failed' | 'expired' | 'open'; ret: number } {
  const d = t.up ? 1 : -1;
  if (t.reachedAt >= 0) return { end: 'reached', ret: d * (t.px / t.breakClose - 1) };
  if (t.failedAt >= 0) return { end: 'failed', ret: d * (c[t.failedAt]!.close / t.breakClose - 1) };
  if (t.expiredAt >= 0) return { end: 'expired', ret: d * (c[t.expiredAt]!.close / t.breakClose - 1) };
  return { end: 'open', ret: NaN };
}
