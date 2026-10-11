// Weekly top short (owner 2026-10-10: "Let's start fresh on a new bot, remember I am keeping each model separate. This
// would be called the weekly top short model"). A short at a blow-off top: the weekly RSI above 72.5, the daily RSI at an
// extreme, bearish RSI divergence on the 4H and the 1H, then on the 15m a series of lower RSI peaks while price makes
// higher highs, entered when a last price spike only lifts the 15m RSI to about 70 and it turns down. Research only
// (wtsReport, `--wts`); nothing in the bot uses it, and it shares no state with the RSI models or the funding squeeze.
//
// Rules, fixed before the runs (owner's answers 2026-10-10: stop 2-3% and target 30-60% of price, traded at 5x-10x; the
// daily "run the test and let me know"; 15m lower peaks "Test both"; the window "Test 8hr and 12hr"; lookbacks as planned):
// - RSI = Wilder RSI(14) on closes. "Live" RSI = the forming candle's RSI at the last closed 15m close, as the chart shows
//   it; nothing after the decision time is used. Weeks start Monday 00:00 UTC (complete weeks built from daily candles).
// - Peaks: daily / 4H / 1H RSI pivot highs, 5 bars left and 3 right (known once the 3 right bars closed); 15m, 3 left and
//   1 right (known when the next 15m candle closes with a lower RSI).
// - Weekly: live weekly RSI >= 72.5. Daily A (main): live daily RSI >= 75. Daily B (compared): A, plus an earlier daily
//   peak with RSI >= 80, 5-120 days back, today's high above its high and the live daily RSI below its RSI.
// - 4H divergence: an earlier 4H peak with RSI >= 80, 1-30 days back; the highest high of the last 24 hours above its
//   high; the highest 4H RSI of the last 24 hours (closed candles and the live one) >= 75 and below its RSI. 1H: the same
//   with an earlier 1H peak >= 80, 6 hours to 5 days back, over the last 12 hours.
// - 15m series: an anchor peak with RSI >= 85 (or the live 1H RSI >= 85 at that peak); then peaks each with a lower RSI
//   than the one before and a high at or above the series' highest high minus 0.25 ATR(15m). A peak with a higher RSI
//   ends the series (it starts a new one if it is an anchor); a lower peak at a lower price is passed over. Trigger: a
//   peak with a high above every earlier high in the series and RSI 65-75 (below the last series peak), after at least 1
//   or 2 lower peaks (two variants), within 8 or 12 hours of the anchor (two variants).
// - Entry: once the trigger is confirmed and the 15m RSI has closed below 70 (waiting up to 4 more 15m closes; a high
//   above the trigger's cancels), with the weekly, daily, 4H and 1H checks passing at that close: short at the next 15m
//   open. A trigger that does not enter counts as a lower peak and the series goes on.
// - Exits: stop 2%, 2.5% or 3% of price above the entry, target 30%, 45% or 60% below (9 exits, each its own run); no time
//   limit, no breakeven, no BTC filter; costs 0.22%; Bitunix funding added (it starts 2024-03-04, earlier trades have
//   none); one trade per coin at a time, per variant and exit. Leverage: the stop costs 2% of the account whatever the
//   leverage, so it only sets the margin; trades whose exit price was 9.5% (10x) or 19% (5x) above the entry, liquidation
//   on isolated margin, are counted (only a gap past the stop can do it).
// - Per cell: trades (a month), win %, avg R, avg R with funding, total R, max drawdown (R with funding), the random-
//   direction edge, the timing edge (t; the same side at random 15m bars within 60 days), older / newer. A funnel of the
//   15m triggers through each check, and the latest trades as examples.
// - Read: the main cell (daily A, at least 2 lower peaks, 8 hours, stop 2.5%, target 45%) works if, on research coins and
//   on fresh $0.5M+ coins separately, it has >= 20 trades, avg R with funding > 0, a random-direction edge > 0 and a
//   timing edge > 0. Under 20 trades on a set: too few to judge there. Daily A against B is shown for the owner. The other
//   71 cells are shown; none replaces the main cell in this round.
// Round 1 (2026-10-11): too few trades to judge (no trade in the main cell; docs/RESULTS.md).
// Round 2 (owner 2026-10-11: "Create a range around the rsi levels. +/- 2.5-5 rsi at all the levels", RSI peaks returning
// to the same levels "leading to the top / entry"; the range on both the fixed levels and the peak matching; "Test both
// +/-2.5 and +/-5"). Rules fixed before the runs, a range b = 2.5 or 5 RSI points on every level, the rest as round 1:
// - Weekly >= 72.5 - b; daily (A) >= 75 - b; daily B / 4H / 1H earlier peak >= 80 - b, "now" >= 75 - b and at most b
//   above the earlier peak (equal-level peaks count); 15m anchor (15m or 1H RSI) >= 85 - b; 15m series peaks each at
//   most b above the one before and the anchor (more than b above ends the series); trigger RSI 65 - b to 75 + b, at most
//   b above the last peak; entry once the 15m RSI closes below 70 + b. b = 0 is round 1 exactly.
// - 16 variants (b x daily A / B x 1+ / 2+ peaks x 8h / 12h) x the same 9 exits. Read: two named cells, daily A, 2+ peaks,
//   8 hours, stop 2.5%, target 45%, at b = 2.5 and at b = 5; each passes on the round-1 terms (>= 20 trades, avg R with
//   funding > 0, both edges > 0, on research and fresh $0.5M+ coins separately). The other 142 cells are shown; none
//   replaces a named cell. For information only (decides nothing): the 15m entry alone, without the weekly, daily, 4H and
//   1H checks, at both ranges, on the main exit.
// Round 2 (2026-10-11): no edge (+/-5 failed on research coins, -0.24 R a trade; +/-2.5 too few trades).
// Round 3 (owner 2026-10-11: "Minimum weekly requirement is 57rsi now"; "The 15m should be making a new high in price
// while rsi is failing the 68-73 range"; the entry "Test both"). Rules fixed before the runs, the rest as round 2:
// - Weekly: the live weekly RSI >= 57, a flat floor (no range).
// - 15m trigger: a peak above every earlier high in the series with its 15m RSI 68-73 (flat), after 1+ or 2+ series
//   peaks, within 8 or 12 hours of the anchor.
// - Entry, two versions: "below 68" = short at the next 15m open after the 15m RSI closes below 68 (within 4 candles; a
//   new high cancels); "turn down" = short at the next 15m open once the candle after the peak closes with a lower RSI
//   (unless it made a new high).
// - Daily A only (daily B took fewer trades and did worse in rounds 1-2). The ranges +/-2.5 / +/-5 stay on the daily,
//   4H / 1H, 15m anchor and peak matching. 16 variants (range x entry x 1+ / 2+ peaks x 8h / 12h) x the same 9 exits.
// - Read: four named cells, daily A, 2+ peaks, 8 hours, stop 2.5%, target 45%, per range and entry, each on the round-1
//   terms. The third round of changes to one model: a named cell passing on both coin sets is confirmed on the untouched
//   $0.1-0.5M coins before any signal work. The 15m entry alone is shown for information.
// Round 3 (2026-10-11): no edge. Owner 2026-10-11: "Let's scrap this model" - scrapped; kept only so the three rounds
// can be re-run (`--wts`). No signal, dashboard or Telegram work.

import type { Candle } from '@bot/marketdata';
import { atrWilder, rsi } from '../indicators';
import type { FundingPoint } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { fundingR } from './fundvol';
import { weeklyFromDaily } from './rsimap';
import { lastClosed } from './scalp2';
import { randomDirectionTwins, randomTimeTwins, timingEdge } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const M15 = 900_000, H = 3_600_000, H4 = 4 * H, DAY = 24 * H, WEEK = 7 * DAY, SEEDS = 20, SPAN_DAYS = 60;

export const WTS = {
  weekly: 72.5, daily: 75,
  dailyDiv: { peak: 80, now: 75, min: 5 * DAY, max: 120 * DAY },
  h4: { peak: 80, now: 75, min: DAY, max: 30 * DAY, recent: DAY },
  h1: { peak: 80, now: 75, min: 6 * H, max: 5 * DAY, recent: 12 * H },
  anchor: 85, tol: 0.25, trigLo: 65, trigHi: 75, below: 70, wait: 4,
  stops: [0.02, 0.025, 0.03], targets: [0.3, 0.45, 0.6], liq: { x10: 0.095, x5: 0.19 },
} as const;

/**
 * A variant. Round 3's optional fields (unset = rounds 1-2): `weeklyFloor` = a flat weekly minimum (no range), `trig` = a
 * flat trigger RSI range, `entry` = 'below' (the 15m RSI closes under `belowLevel`) or 'turn' (the next close is lower).
 */
export interface WtsVariant {
  daily: 'A' | 'B'; lower: 1 | 2; windowH: 8 | 12; band: 0 | 2.5 | 5;
  weeklyFloor?: number; trig?: readonly [number, number]; entry?: 'below' | 'turn'; belowLevel?: number;
}
/** Round 3's weekly floor and trigger range (owner 2026-10-11). */
export const WTS_R3 = { weeklyFloor: 57, trig: [68, 73] as const, belowLevel: 68 };
/** Round 3's variants: per range, "below 68" then "turn down", 2+ then 1+ peaks, 8 then 12 hours (daily A). */
export const WTS_VARIANTS: ReadonlyArray<WtsVariant> = ([2.5, 5] as const).flatMap((band) => (['below', 'turn'] as const).flatMap((entry) => ([2, 1] as const).flatMap((lower) => ([8, 12] as const).map((windowH) => ({ daily: 'A' as const, lower, windowH, band, entry, weeklyFloor: WTS_R3.weeklyFloor, trig: WTS_R3.trig, belowLevel: WTS_R3.belowLevel })))));
/** The widest range: the coin screen uses its levels so that no coin that could trade is left out. */
export const WTS_MAX_BAND = 5;
const pct = (x: number) => `${+(100 * x).toFixed(1)}%`;
/** The exits, stop-major; index 4 = stop 2.5%, target 45% (the main one). */
export const WTS_EXITS = WTS.stops.flatMap((s) => WTS.targets.map((tg) => ({ s, tg, spec: { name: `stop ${pct(s)}, target ${pct(tg)}`, target: tg / s } as ExitSpec })));
export const WTS_MAIN = { v: 0, x: 4 } as const;
/** The named cells: daily A, 2+ peaks, 8 hours, stop 2.5%, target 45%, per range and entry. */
export const WTS_MAINS = [{ v: 0, x: 4 }, { v: 4, x: 4 }, { v: 8, x: 4 }, { v: 12, x: 4 }] as const;
export const wtsLabel = (v: WtsVariant) => v.entry
  ? `±${v.band} RSI, weekly ${v.weeklyFloor ?? WTS.weekly - v.band}, ${v.entry === 'turn' ? 'turn down' : `below ${v.belowLevel}`}, ${v.lower}+ peaks, ${v.windowH}h`
  : `${v.band ? `±${v.band} RSI` : 'no range'}, daily ${v.daily}, ${v.lower}+ lower peaks, ${v.windowH}h`;
/** `a` above `b` past the range: more than `band` above, or at least equal with no range (round 1's strict "lower"). */
const above = (a: number, b: number, band: number) => (band ? a > b + band : a >= b);

/** Wilder RSI averages after each close (null while warming up), the same sums as `rsi` in indicators.ts. Pure. */
export function wilderState(closes: ReadonlyArray<number>, period = 14): { g: (number | null)[]; l: (number | null)[] } {
  const g: (number | null)[] = [], l: (number | null)[] = [];
  let ag = 0, al = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { g.push(null); l.push(null); continue; }
    const d = closes[i]! - closes[i - 1]!, up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= period) {
      ag += up; al += dn;
      if (i < period) { g.push(null); l.push(null); continue; }
      ag /= period; al /= period;
    } else {
      ag = (ag * (period - 1) + up) / period;
      al = (al * (period - 1) + dn) / period;
    }
    g.push(ag); l.push(al);
  }
  return { g, l };
}

/** The RSI of a candle forming after closed bar `i` with its close at `price`: one Wilder step from bar i. Pure. */
export function liveRsi(closes: ReadonlyArray<number>, st: { g: ReadonlyArray<number | null>; l: ReadonlyArray<number | null> }, i: number, price: number, period = 14): number | null {
  const ag = st.g[i], al = st.l[i];
  if (ag == null || al == null || i < 0 || i >= closes.length) return null;
  const d = price - closes[i]!, g = (ag * (period - 1) + Math.max(d, 0)) / period, l = (al * (period - 1) + Math.max(-d, 0)) / period;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** RSI pivot highs: above the `left` bars before (ties go to the earlier bar) and at least the `right` bars after. Pure. */
export function rsiPeaks(r: ReadonlyArray<number | null>, left: number, right: number): number[] {
  const out: number[] = [];
  for (let k = left; k + right < r.length; k++) {
    const v = r[k];
    if (v == null) continue;
    let ok = true;
    for (let q = 1; q <= left && ok; q++) { const u = r[k - q]; ok = u != null && v > u; }
    for (let q = 1; q <= right && ok; q++) { const u = r[k + q]; ok = u != null && v >= u; }
    if (ok) out.push(k);
  }
  return out;
}

export interface WtsFrame { c: ReadonlyArray<Candle>; bar: number; closes: number[]; r: (number | null)[]; st: ReturnType<typeof wilderState>; peaks: number[]; right: number }
/** One timeframe: candles, RSI, Wilder state and confirmed peaks. `r` may be given (tests). Pure. */
export function wtsFrame(c: ReadonlyArray<Candle>, bar: number, left = 5, right = 3, r?: (number | null)[]): WtsFrame {
  const closes = c.map((b) => b.close), rr = r ?? rsi(closes, 14);
  return { c, bar, closes, r: rr, st: wilderState(closes, 14), peaks: rsiPeaks(rr, left, right), right };
}

/**
 * The RSI at time t: the bar that just closed at t, else the live RSI of the bar forming at `price` (null across a gap
 * in the data or while warming up). Pure.
 */
export function rsiNow(f: WtsFrame, t: number, price: number): number | null {
  const i = lastClosed(f.c, f.bar, t);
  if (i < 0) return null;
  const next = f.c[i]!.openTime + f.bar;
  if (next === t) return f.r[i] ?? null;
  return t - next < f.bar ? liveRsi(f.closes, f.st, i, price) : null;
}

/** The highest 15m high of the candles that opened at or after `a` and closed by `t` (-Infinity if none). Pure. */
export function hiSince(m: ReadonlyArray<Candle>, a: number, t: number): number {
  let hi = -Infinity;
  for (let k = lastClosed(m, M15, t); k >= 0 && m[k]!.openTime >= a; k--) hi = Math.max(hi, m[k]!.high);
  return hi;
}

/**
 * Bearish divergence at t: a confirmed peak (RSI >= p.peak - band, opened p.min..p.max before t) that price has since
 * topped (`hi`, the highest high since `since`) while the highest RSI since then (bars closed after `since`, and `live`)
 * is >= p.now - band and not above the peak's RSI past the range (below it, with no range). Pure.
 */
export function divergenceAt(f: WtsFrame, t: number, since: number, hi: number, live: number | null, p: { peak: number; now: number; min: number; max: number }, band = 0): boolean {
  let rMax = live ?? -Infinity;
  for (let k = lastClosed(f.c, f.bar, t); k >= 0 && f.c[k]!.openTime + f.bar > since; k--) rMax = Math.max(rMax, f.r[k] ?? -Infinity);
  if (!(rMax >= p.now - band)) return false;
  for (let n = f.peaks.length - 1; n >= 0; n--) {
    const k = f.peaks[n]!, age = t - f.c[k]!.openTime;
    if (age > p.max) break;
    const known = f.c[k + f.right] != null && f.c[k + f.right]!.openTime + f.bar <= t;
    if (!known || age < p.min) continue;
    if (f.r[k]! >= p.peak - band && f.c[k]!.high < hi && !above(rMax, f.r[k]!, band)) return true;
  }
  return false;
}

export interface WtsCoin { sym: string; w: WtsFrame; d1: WtsFrame; h4: WtsFrame; h1: WtsFrame; m15: WtsFrame & { atr: (number | null)[] }; fs: ReadonlyArray<FundingPoint> }
export function wtsCoin(sym: string, d1: ReadonlyArray<Candle>, c4: ReadonlyArray<Candle>, c1: ReadonlyArray<Candle>, c15: ReadonlyArray<Candle>, fs: ReadonlyArray<FundingPoint> = []): WtsCoin {
  return { sym, w: wtsFrame(weeklyFromDaily(d1), WEEK), d1: wtsFrame(d1, DAY), h4: wtsFrame(c4, H4), h1: wtsFrame(c1, H), m15: { ...wtsFrame(c15, M15, 3, 1), atr: atrWilder(c15, 14) }, fs };
}

export type WtsStep = 'weekly' | 'daily' | '4h' | '1h' | 'ok';
/** The higher-timeframe checks at the close of 15m bar `e` (levels widened by `band`): the first that fails, or 'ok'. Pure. */
export function wtsGate(x: WtsCoin, e: number, daily: 'A' | 'B', band = 0, weeklyFloor?: number): WtsStep {
  const m = x.m15.c, t = m[e]!.openTime + M15, px = m[e]!.close;
  const w = rsiNow(x.w, t, px);
  if (w == null || w < (weeklyFloor ?? WTS.weekly - band)) return 'weekly';
  const dl = rsiNow(x.d1, t, px);
  if (dl == null || dl < WTS.daily - band) return 'daily';
  if (daily === 'B') {
    const ds = Math.floor((t - 1) / DAY) * DAY; // today (the day that just closed, at 00:00)
    if (!divergenceAt(x.d1, t, ds, hiSince(m, ds, t), dl, WTS.dailyDiv, band)) return 'daily';
  }
  if (!divergenceAt(x.h4, t, t - WTS.h4.recent, hiSince(m, t - WTS.h4.recent, t), rsiNow(x.h4, t, px), WTS.h4, band)) return '4h';
  if (!divergenceAt(x.h1, t, t - WTS.h1.recent, hiSince(m, t - WTS.h1.recent, t), rsiNow(x.h1, t, px), WTS.h1, band)) return '1h';
  return 'ok';
}

export interface WtsFunnel { series: number; triggers: number; below70: number; weekly: number; daily: number; h4: number; h1: number }
export const emptyFunnel = (): WtsFunnel => ({ series: 0, triggers: 0, below70: 0, weekly: 0, daily: 0, h4: 0, h1: 0 });

/**
 * The 15m series (header): the entry bars (short at their open). `anchor1h(q)` = the live 1H RSI >= 85 at peak q;
 * `gate(e)` = the higher-timeframe checks at the close of bar e. The funnel counts from `from` on. Pure.
 */
export function seriesEntries(
  m: { c: ReadonlyArray<Candle>; r: ReadonlyArray<number | null>; atr: ReadonlyArray<number | null>; peaks: ReadonlyArray<number> },
  v: { lower: number; windowH: number; band?: number; trig?: readonly [number, number]; entry?: 'below' | 'turn'; belowLevel?: number },
  anchor1h: (q: number) => boolean, gate: (e: number) => WtsStep, from = -Infinity, funnel?: WtsFunnel,
): number[] {
  const { c, r, atr } = m, out: number[] = [], b = v.band ?? 0;
  const [trigLo, trigHi] = v.trig ?? [WTS.trigLo - b, WTS.trigHi + b];
  const how = { turn: v.entry === 'turn', level: v.belowLevel ?? WTS.below + b };
  const count = (q: number, f: (x: WtsFunnel) => void) => { if (funnel && c[q]!.openTime >= from) f(funnel); };
  type Series = { anchor: number; last: number; hi: number; lower: number };
  let s = null as Series | null, skipTo = -1;
  const start = (q: number) => { s = { anchor: q, last: q, hi: c[q]!.high, lower: 0 }; count(q, (f) => f.series++); };
  for (const q of m.peaks) {
    if (q < skipTo) continue;
    const rq = r[q]!, isAnchor = rq >= WTS.anchor - b || anchor1h(q);
    if (s && c[q]!.openTime - c[s.anchor]!.openTime > v.windowH * H) s = null; // past the window
    if (!s) { if (isAnchor) start(q); continue; }
    const cur: Series = s;
    if (above(rq, r[cur.last]!, b) || above(rq, r[cur.anchor]!, b)) { s = null; if (isAnchor) start(q); continue; } // a higher RSI peak (past the range) ends the series
    if (c[q]!.high > cur.hi && rq >= trigLo && rq <= trigHi && cur.lower >= v.lower) {
      count(q, (f) => f.triggers++);
      const j = entryAfter(c, r, q, gate, (f) => count(q, f), how);
      if (j != null) { out.push(j); s = null; skipTo = j; continue; }
    }
    if (c[q]!.high >= cur.hi - WTS.tol * (atr[q] ?? 0)) { cur.last = q; cur.hi = Math.max(cur.hi, c[q]!.high); cur.lower++; }
  }
  return out;
}

/**
 * After trigger q: the first close (q+1 .. q+1+wait) with RSI under `how.level` ("turn": only q+1, with an RSI below the
 * peak's), checked there; the entry bar or null.
 */
function entryAfter(c: ReadonlyArray<Candle>, r: ReadonlyArray<number | null>, q: number, gate: (e: number) => WtsStep, count: (f: (x: WtsFunnel) => void) => void, how: { turn: boolean; level: number }): number | null {
  for (let e = q + 1; e <= (how.turn ? q + 1 : q + 1 + WTS.wait) && e + 1 < c.length; e++) {
    if (c[e]!.high > c[q]!.high) return null; // a new high: cancelled
    const re = r[e];
    if (re == null || (how.turn ? re >= r[q]! : re >= how.level)) continue;
    count((f) => f.below70++);
    const g = gate(e), steps: WtsStep[] = ['weekly', 'daily', '4h', '1h'];
    const passed = g === 'ok' ? 4 : steps.indexOf(g);
    count((f) => { if (passed > 0) f.weekly++; if (passed > 1) f.daily++; if (passed > 2) f.h4++; if (passed > 3) f.h1++; });
    return g === 'ok' ? e + 1 : null;
  }
  return null;
}

/** The entry bars of one variant on one coin (`from` only limits the funnel). Pure. */
export function wtsEntries(x: WtsCoin, v: WtsVariant, from = -Infinity, funnel?: WtsFunnel): number[] {
  const m = x.m15;
  return seriesEntries(m, v, (q) => (rsiNow(x.h1, m.c[q]!.openTime + M15, m.c[q]!.close) ?? 0) >= WTS.anchor - v.band, (e) => wtsGate(x, e, v.daily, v.band, v.weeklyFloor), from, funnel);
}

/** For information (round 2): the 15m entry alone, without the higher-timeframe checks. Pure. */
export function wts15mOnly(x: WtsCoin, v: WtsVariant, from = -Infinity, funnel?: WtsFunnel): number[] {
  const m = x.m15;
  return seriesEntries(m, v, (q) => (rsiNow(x.h1, m.c[q]!.openTime + M15, m.c[q]!.close) ?? 0) >= WTS.anchor - v.band, () => 'ok', from, funnel);
}

/** Days in [from, to) whose weekly RSI at the day's high reached 72.5 - band (an upper bound of the live value that day), and with the daily RSI 75 - band too. Pure. */
export function wtsReadyDays(d1: ReadonlyArray<Candle>, from: number, to: number, band = 0, weeklyFloor?: number): { weekly: number; both: number } {
  const w = wtsFrame(weeklyFromDaily(d1), WEEK), d = wtsFrame(d1, DAY);
  let weekly = 0, both = 0;
  for (const b of d1) {
    if (b.openTime < from || b.openTime >= to) continue;
    const t = b.openTime + DAY - M15, wr = rsiNow(w, t, b.high);
    if (wr == null || wr < (weeklyFloor ?? WTS.weekly - band)) continue;
    weekly++;
    const dr = rsiNow(d, t, b.high);
    if (dr != null && dr >= WTS.daily - band) both++;
  }
  return { weekly, both };
}

interface Row { sym: string; t: number; r: number; f: number; ra: number[]; rt: number[]; l: 0 | 1 | 2; how: string; entry: number }

export function wtsReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, dump = false): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10), minute = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const bands = [...new Set(WTS_VARIANTS.map((v) => v.band))];
  const cells = new Map<string, Row[]>(), funnels = WTS_VARIANTS.map(() => emptyFunnel());
  const only = new Map<number, Row[]>(), onlyFunnels = WTS_MAINS.map(() => emptyFunnel()); // the 15m entry alone, per named cell (range and entry)
  const floor = WTS_VARIANTS[0]!.weeklyFloor;
  const readyDays = new Map(bands.map((b) => [b, { weekly: 0, both: 0 }]));
  let coins = 0, start = Infinity;
  for (const sym of symbols) {
    const cd = data[sym]?.candles ?? {}, d1 = cd['1d'] ?? [], c4 = cd['4h'] ?? [], c1 = cd['1h'] ?? [], c15 = cd['15m'] ?? [];
    if (d1.length < 100 || c4.length < 100 || c1.length < 100 || c15.length < 1000) continue;
    coins++;
    start = Math.min(start, c15[0]!.openTime);
    for (const b of bands) { const d = wtsReadyDays(d1, from, to, b, floor), acc = readyDays.get(b)!; acc.weekly += d.weekly; acc.both += d.both; }
    const x = wtsCoin(sym, d1, c4, c1, c15, data[sym]?.funding ?? []), atr = x.m15.atr;
    const twins = new Map<string, { ra: number[]; rt: number[] }>(); // the same entry and exit in several variants: the same twins
    /** One trade per coin at a time over entry bars `js` with exit `xi`, into `rows`. */
    const trade = (js: ReadonlyArray<number>, xi: number, rows: Row[]) => {
      const ex = WTS_EXITS[xi]!;
      let busy = -1;
      for (const j of js) {
        if (j <= busy) continue;
        const entry = c15[j]!.open, stop0 = entry * (1 + ex.s), tr = specTrade(c15, atr, {}, j, stop0, -1, ex.spec);
        if (!tr) continue;
        busy = tr.open ? Infinity : tr.end;
        if (c15[j]!.openTime < from) continue;
        const tk = `${j}|${xi}`;
        let tw = twins.get(tk);
        if (!tw) { tw = { ra: randomDirectionTwins(c15, atr, sym, j, stop0, -1, ex.spec, SEEDS), rt: randomTimeTwins(c15, atr, sym, j, stop0, -1, ex.spec, SPAN_DAYS * 96, SEEDS) }; twins.set(tk, tw); }
        const out = c15[tr.end]!, gap = tr.how === 'stop' && out.open >= stop0 ? out.open / entry - 1 : 0;
        rows.push({ sym, t: c15[j]!.openTime, r: tr.r, f: fundingR(x.fs, -1, c15[j]!.openTime, out.openTime, entry, entry * ex.s), ...tw, l: gap >= WTS.liq.x5 ? 2 : gap >= WTS.liq.x10 ? 1 : 0, how: tr.how, entry });
      }
    };
    WTS_VARIANTS.forEach((v, vi) => {
      const js = wtsEntries(x, v, from, funnels[vi]);
      WTS_EXITS.forEach((_, xi) => { const rows = cells.get(`${vi}|${xi}`) ?? []; trade(js, xi, rows); cells.set(`${vi}|${xi}`, rows); });
    });
    WTS_MAINS.forEach((m, i) => {
      const rows = only.get(i) ?? [];
      trade(wts15mOnly(x, WTS_VARIANTS[m.v]!, from, onlyFunnels[i]), m.x, rows);
      only.set(i, rows);
    });
  }
  const months = (to - Math.max(from, start)) / (30.44 * DAY);
  const avg = (a: ReadonlyArray<number>) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : 0);
  const stat = (xs: ReadonlyArray<Row>) => {
    const rf = xs.map((x) => x.r + x.f), te = timingEdge(xs.map((x) => ({ r: x.r, rtime: x.rt })));
    let eq = 0, peak = 0, dd = 0;
    for (const x of [...xs].sort((a, b) => a.t - b.t)) { eq += x.r + x.f; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    return {
      n: xs.length, perMonth: +(xs.length / months).toFixed(2), win: Math.round((100 * xs.filter((x) => x.r > 0).length) / Math.max(1, xs.length)),
      r: +avg(xs.map((x) => x.r)).toFixed(3), rf: +avg(rf).toFixed(3), total: +rf.reduce((p, q) => p + q, 0).toFixed(1), dd: +dd.toFixed(1),
      edge: +(avg(xs.map((x) => x.r)) - avg(xs.flatMap((x) => x.ra))).toFixed(3), te: +te.mean.toFixed(3), t: +te.t.toFixed(2),
      older: +avg(xs.filter((x) => x.t < cut).map((x) => x.r + x.f)).toFixed(3), newer: +avg(xs.filter((x) => x.t >= cut).map((x) => x.r + x.f)).toFixed(3),
      liq10: xs.filter((x) => x.l >= 1).length, liq5: xs.filter((x) => x.l >= 2).length,
    };
  };
  const st = (vi: number, xi: number) => stat(cells.get(`${vi}|${xi}`) ?? []);
  const sg = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;
  const funnelLine = (label: string, f: WtsFunnel) => `  ${label.padEnd(46)} series ${f.series}, triggers ${f.triggers}, RSI under the entry level in time ${f.below70}, weekly ${f.weekly}, daily ${f.daily}, 4H ${f.h4}, 1H ${f.h1} (entries before one-at-a-time)`;
  const out = [
    `WEEKLY TOP SHORT, ROUND 3: WEEKLY >= ${floor}, 15M RSI FAILING AT ${WTS_R3.trig.join('-')} (rules fixed before the run): ${day(Math.max(from, start))} to ${day(to)} (${months.toFixed(1)} months of 15m candles), ${coins} of ${symbols.length} coins with 15m data (the coins whose weekly and daily RSI reached ${floor ?? WTS.weekly - WTS_MAX_BAND} / ${WTS.daily - WTS_MAX_BAND} in the window). Older / newer = before / after ${day(cut)}.`,
    ...bands.map((b) => { const d = readyDays.get(b)!; return `Coin-days at ±${b}: weekly RSI >= ${floor ?? WTS.weekly - b} at the day's high ${d.weekly}; with the daily RSI >= ${WTS.daily - b} too ${d.both}.`; }),
    'Short at the next 15m open; stop % above the entry, target % below; no time limit, no breakeven, no BTC filter; costs 0.22%; R with Bitunix funding (none before 2024-03-04).',
    '', 'Funnel, per variant (15m series, then the triggers through each check):',
    ...WTS_VARIANTS.map((v, vi) => funnelLine(wtsLabel(v), funnels[vi]!)),
    '', 'Avg R a trade with funding (trades), per variant; rows = stop above the entry, columns = target below:',
  ];
  WTS_VARIANTS.forEach((v, vi) => {
    out.push(`  ${wtsLabel(v)}${WTS_MAINS.some((m) => m.v === vi) ? ' (named)' : ''}`, `    ${'stop \\ target'.padEnd(14)}${WTS.targets.map((tg) => pct(tg).padStart(16)).join('')}`);
    WTS.stops.forEach((s, si) => out.push(`    ${pct(s).padEnd(14)}${WTS.targets.map((_, ti) => { const x = st(vi, si * 3 + ti); return `${sg(x.rf)} (${x.n})`.padStart(16); }).join('')}`));
  });
  const line = (label: string, x: ReturnType<typeof stat>) => `  ${label}: ${x.n} trades (${x.perMonth} a month), win ${x.win}%, avg R ${sg(x.r)}, with funding ${sg(x.rf)}, total ${x.total.toFixed(1)} R, drawdown ${x.dd.toFixed(1)} R; random-direction edge ${sg(x.edge)}; timing edge ${sg(x.te)} (t ${x.t.toFixed(1)}); older ${sg(x.older)} / newer ${sg(x.newer)}; past liquidation at 10x ${x.liq10}, at 5x ${x.liq5}`;
  for (const m of WTS_MAINS) {
    const v = WTS_VARIANTS[m.v]!, main = st(m.v, m.x), bIdx = WTS_VARIANTS.findIndex((u) => u.band === v.band && u.entry === v.entry && u.daily === 'B' && u.lower === v.lower && u.windowH === v.windowH);
    const pass = main.n >= 20 && main.rf > 0 && main.edge > 0 && main.te > 0;
    out.push('', `Named cell (${wtsLabel(v)}, ${WTS_EXITS[m.x]!.spec.name}):`, line('named', main),
      `  Read: ${main.n < 20 ? 'too few trades to judge on this coin set' : pass ? 'passes on this coin set (>= 20 trades, avg R with funding > 0, both edges > 0)' : 'fails on this coin set'}.`,
      ...(bIdx >= 0 ? [`  Daily A against daily B (otherwise this cell):`, line('daily A', main), line('daily B', st(bIdx, m.x))] : []));
    const latest = [...(cells.get(`${m.v}|${m.x}`) ?? [])].sort((a, b) => b.t - a.t).slice(0, 10);
    out.push('  Latest trades:', ...(latest.length ? latest.map((x) => `    ${minute(x.t)}  ${x.sym.padEnd(14)} entry ${+x.entry.toPrecision(5)}  ${sg(x.r + x.f)} R with funding (${x.how})`) : ['    none']));
  }
  out.push('', 'For information only (decides nothing): the 15m entry alone, without the weekly, daily, 4H and 1H checks (the named cells\' settings):');
  WTS_MAINS.forEach((m, i) => { const label = `15m alone: ${wtsLabel(WTS_VARIANTS[m.v]!)}`; out.push(funnelLine(label, onlyFunnels[i]!), line(label, stat(only.get(i) ?? []))); });
  out.push('');
  WTS_VARIANTS.forEach((v, vi) => WTS_EXITS.forEach((ex, xi) => out.push(`CELL ${JSON.stringify({ v: vi, x: xi, variant: wtsLabel(v), exit: ex.spec.name, ...st(vi, xi) })}`)));
  WTS_MAINS.forEach((m, i) => { const v = WTS_VARIANTS[m.v]!; out.push(`ONLY ${JSON.stringify({ i, band: v.band, entry: v.entry ?? null, ...stat(only.get(i) ?? []) })}`); });
  if (dump) {
    const r4 = (x: number) => +x.toFixed(4);
    const row = (y: Row) => ({ s: y.sym, t: y.t, r: r4(y.r), f: r4(y.f), ra: r4(avg(y.ra)), rt: y.rt.length ? r4(avg(y.rt)) : null, l: y.l });
    for (const [k, rows] of cells) {
      const [v, x] = k.split('|').map(Number);
      for (const y of rows) out.push(`TRADE ${JSON.stringify({ v, x, ...row(y) })}`);
    }
    for (const [i, rows] of only) for (const y of rows) out.push(`TRADE15 ${JSON.stringify({ i, ...row(y) })}`);
  }
  return out;
}
