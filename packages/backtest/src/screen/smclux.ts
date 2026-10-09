// This work is licensed under Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)
// https://creativecommons.org/licenses/by-nc-sa/4.0/ — TypeScript port of "Smart Money Concepts [LuxAlgo]" (© LuxAlgo,
// TradingView Pine Script v5), shared under the same license. Ported for the owner (2026-10-09: "I like this indicator
// template"). Only the calculations are ported (no drawing), on the chart's own timeframe, with the script's defaults:
// swing structure length 50, internal structure 5, order block filter ATR(200), mitigation High/Low, FVG auto threshold,
// equal highs / lows 3 bars and 0.1 x ATR(200).
//
// Bar-for-bar notes (Pine semantics kept):
// - leg(size): a bar `size` back whose high is above the highest high of the last `size` bars starts a bearish leg (the
//   bar was a swing high); one whose low is below the lowest low starts a bullish leg (a swing low). Each structure size
//   keeps its own leg.
// - Structure break: ta.crossover(close, pivot level) on an uncrossed pivot (the level's previous-bar value is used for
//   close[1], as ta.crossover does). BOS if the trend already pointed that way, CHoCH if it flips. Internal breaks also
//   need the internal pivot to differ from the swing pivot (the script's extra condition; its confluence filter is off).
// - Order block on a bullish break: the bar with the lowest "parsed" low from the broken swing high's bar up to the bar
//   before the break (a bar at least 2 x ATR(200) tall swaps its high and low, the script's volatility filter); bearish
//   mirrors. Mitigated (removed) when a later low falls below a bullish block's low / a high rises above a bearish
//   block's high, checked after new blocks are added on the same bar. The chart shows the newest 5 of each list.
// - Fair value gap: bar t's low above the high 2 bars back with the middle bar closing above it and the middle bar's
//   body % ((close-open)/(open*100)) above twice its running mean; bearish mirrors. Gaps are removed before new ones are
//   added each bar: a bullish gap when a low falls below its bottom; a bearish gap when a high rises above its LOWER edge
//   (the script stores the bearish gap's lower edge as `top`, so a bearish gap disappears on the first touch — kept as
//   the chart shows it).
// - The script removes items from its arrays while looping over them, which can skip an item for a bar; here every item
//   that qualifies is removed (it would go on a later bar anyway once price is still through it).

import type { Candle } from '@bot/marketdata';

export type Bias = 1 | -1;
export interface SmcEvent { t: number; scope: 'swing' | 'internal'; kind: 'BOS' | 'CHoCH'; dir: Bias; level: number }
/** A zone with the bar it appears on (`created`, known at that bar's close) and the bar it is removed on (Infinity = never). */
export interface SmcZone { kind: 'ob-internal' | 'ob-swing' | 'fvg'; bias: Bias; top: number; bottom: number; created: number; removed: number; from: number }
export interface SmcSeries {
  events: SmcEvent[];
  zones: SmcZone[];
  /** Trend after each bar (1 bullish, -1 bearish, 0 none yet). */
  swingTrend: Int8Array;
  internalTrend: Int8Array;
  /** Trailing swing range after each bar (for premium / discount); NaN until both sides exist. */
  trailTop: Float64Array;
  trailBottom: Float64Array;
  /** Equal highs / lows (liquidity) confirmed at bar t. */
  equal: { t: number; kind: 'EQH' | 'EQL'; level: number }[];
}

interface Pivot { level: number; last: number; crossed: boolean; bar: number }
const newPivot = (): Pivot => ({ level: NaN, last: NaN, crossed: false, bar: -1 });

/** ta.atr(len): RMA of the true range, seeded with the simple mean of the first `len` values. */
export function pineAtr(c: ReadonlyArray<Candle>, len: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  let sum = 0, prev = NaN;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1]!.close), Math.abs(b.low - c[i - 1]!.close));
    if (i < len) { sum += tr; if (i === len - 1) { prev = sum / len; out[i] = prev; } continue; }
    prev = (prev * (len - 1) + tr) / len;
    out[i] = prev;
  }
  return out;
}

export function smcLux(c: ReadonlyArray<Candle>, opts: { swingLen?: number; internalLen?: number; equalLen?: number; equalThreshold?: number } = {}): SmcSeries {
  const n = c.length, swingLen = opts.swingLen ?? 50, internalLen = opts.internalLen ?? 5, equalLen = opts.equalLen ?? 3, eqThr = opts.equalThreshold ?? 0.1;
  const atr = pineAtr(c, 200);
  const pHigh = new Float64Array(n), pLow = new Float64Array(n);
  const out: SmcSeries = { events: [], zones: [], swingTrend: new Int8Array(n), internalTrend: new Int8Array(n), trailTop: new Float64Array(n).fill(NaN), trailBottom: new Float64Array(n).fill(NaN), equal: [] };
  const swingHigh = newPivot(), swingLow = newPivot(), intHigh = newPivot(), intLow = newPivot(), eqHigh = newPivot(), eqLow = newPivot();
  const legs = { swing: 0, internal: 0, equal: 0 }, prevLegs = { swing: 0, internal: 0, equal: 0 }; // Pine: leg starts at 0
  let swingTrend = 0, internalTrend = 0, trailTop = NaN, trailBottom = NaN;
  const liveOb: { internal: SmcZone[]; swing: SmcZone[] } = { internal: [], swing: [] };
  let liveFvg: SmcZone[] = [];
  // ta.crossover / crossunder keep the level's previous-bar value per call site.
  const prevLvl = { intUp: NaN, intDn: NaN, swUp: NaN, swDn: NaN };
  let cumDelta = 0;

  const hiN = (t: number, size: number) => { let m = -Infinity; for (let k = t - size + 1; k <= t; k++) m = Math.max(m, c[k]!.high); return m; };
  const loN = (t: number, size: number) => { let m = Infinity; for (let k = t - size + 1; k <= t; k++) m = Math.min(m, c[k]!.low); return m; };

  const structure = (t: number, size: number, which: 'swing' | 'internal' | 'equal') => {
    if (t < size) return;
    if (c[t - size]!.high > hiN(t, size)) legs[which] = 0; // bearish leg
    else if (c[t - size]!.low < loN(t, size)) legs[which] = 1; // bullish leg
    const ch = legs[which] - prevLegs[which];
    prevLegs[which] = legs[which];
    if (!(ch === 1 || ch === -1)) return;
    const p = ch === 1 ? (which === 'equal' ? eqLow : which === 'internal' ? intLow : swingLow) : (which === 'equal' ? eqHigh : which === 'internal' ? intHigh : swingHigh);
    const lvl = ch === 1 ? c[t - size]!.low : c[t - size]!.high;
    if (which === 'equal' && Number.isFinite(p.level) && Number.isFinite(atr[t]!) && Math.abs(p.level - lvl) < eqThr * atr[t]!) out.equal.push({ t, kind: ch === 1 ? 'EQL' : 'EQH', level: lvl });
    p.last = p.level; p.level = lvl; p.crossed = false; p.bar = t - size;
    if (which === 'swing') { if (ch === 1) trailBottom = lvl; else trailTop = lvl; }
  };

  const storeOb = (t: number, p: Pivot, scope: 'internal' | 'swing', bias: Bias) => {
    if (p.bar < 0 || p.bar >= t) return;
    let idx = p.bar;
    for (let k = p.bar + 1; k < t; k++) if (bias === -1 ? pHigh[k]! > pHigh[idx]! : pLow[k]! < pLow[idx]!) idx = k;
    const z: SmcZone = { kind: scope === 'internal' ? 'ob-internal' : 'ob-swing', bias, top: pHigh[idx]!, bottom: pLow[idx]!, created: t, removed: Infinity, from: idx };
    out.zones.push(z);
    liveOb[scope].unshift(z);
    if (liveOb[scope].length > 100) liveOb[scope].pop();
  };

  const display = (t: number, internal: boolean) => {
    const b = c[t]!, prevClose = t > 0 ? c[t - 1]!.close : NaN;
    const ph = internal ? intHigh : swingHigh, pl = internal ? intLow : swingLow;
    const upKey = internal ? 'intUp' : 'swUp', dnKey = internal ? 'intDn' : 'swDn';
    const trend = internal ? internalTrend : swingTrend;
    let next = trend;
    // Bullish break.
    // Pine compares with na as false: no internal break before both pivots exist.
    const upExtra = internal ? Number.isFinite(intHigh.level) && Number.isFinite(swingHigh.level) && intHigh.level !== swingHigh.level : true;
    const crossUp = b.close > ph.level && prevClose <= prevLvl[upKey];
    prevLvl[upKey] = ph.level;
    if (crossUp && !ph.crossed && upExtra) {
      out.events.push({ t, scope: internal ? 'internal' : 'swing', kind: next === -1 ? 'CHoCH' : 'BOS', dir: 1, level: ph.level });
      ph.crossed = true; next = 1;
      storeOb(t, ph, internal ? 'internal' : 'swing', 1);
    }
    // Bearish break.
    const dnExtra = internal ? Number.isFinite(intLow.level) && Number.isFinite(swingLow.level) && intLow.level !== swingLow.level : true;
    const crossDn = b.close < pl.level && prevClose >= prevLvl[dnKey];
    prevLvl[dnKey] = pl.level;
    if (crossDn && !pl.crossed && dnExtra) {
      out.events.push({ t, scope: internal ? 'internal' : 'swing', kind: next === 1 ? 'CHoCH' : 'BOS', dir: -1, level: pl.level });
      pl.crossed = true; next = -1;
      storeOb(t, pl, internal ? 'internal' : 'swing', -1);
    }
    if (internal) internalTrend = next; else swingTrend = next;
  };

  for (let t = 0; t < n; t++) {
    const b = c[t]!;
    const vol = Number.isFinite(atr[t]!) && b.high - b.low >= 2 * atr[t]!;
    pHigh[t] = vol ? b.low : b.high;
    pLow[t] = vol ? b.high : b.low;
    // Trailing extremes (before structure, as the script).
    trailTop = Math.max(b.high, trailTop);
    trailBottom = Math.min(b.low, trailBottom);
    // FVG removal (before structure).
    liveFvg = liveFvg.filter((g) => {
      const gone = g.bias === 1 ? b.low < g.bottom : b.high > g.bottom; // bearish: the script's `top` is the gap's lower edge (= bottom here)
      if (gone) g.removed = t;
      return !gone;
    });
    structure(t, swingLen, 'swing');
    structure(t, internalLen, 'internal');
    structure(t, equalLen, 'equal');
    display(t, true);
    display(t, false);
    for (const scope of ['internal', 'swing'] as const) {
      liveOb[scope] = liveOb[scope].filter((z) => {
        const gone = z.bias === -1 ? b.high > z.top : b.low < z.bottom;
        if (gone) z.removed = t;
        return !gone;
      });
    }
    // FVG creation (chart timeframe; the middle bar is t-1).
    if (t >= 1) {
      const m = c[t - 1]!, delta = (m.close - m.open) / (m.open * 100);
      cumDelta += Math.abs(delta);
    }
    if (t >= 2) {
      const m = c[t - 1]!, l2 = c[t - 2]!, delta = (m.close - m.open) / (m.open * 100);
      const thr = (cumDelta / t) * 2;
      if (b.low > l2.high && m.close > l2.high && delta > thr) { const g: SmcZone = { kind: 'fvg', bias: 1, top: b.low, bottom: l2.high, created: t, removed: Infinity, from: t - 1 }; out.zones.push(g); liveFvg.unshift(g); }
      if (b.high < l2.low && m.close < l2.low && -delta > thr) { const g: SmcZone = { kind: 'fvg', bias: -1, top: l2.low, bottom: b.high, created: t, removed: Infinity, from: t - 1 }; out.zones.push(g); liveFvg.unshift(g); }
    }
    out.swingTrend[t] = swingTrend; out.internalTrend[t] = internalTrend;
    out.trailTop[t] = trailTop; out.trailBottom[t] = trailBottom;
  }
  return out;
}

/**
 * Zones alive entering bar t (created before t, not removed before t): what the chart showed at the previous close.
 * Order blocks are limited to the newest `show` of each list, as drawn.
 */
export function smcZonesBefore(s: SmcSeries, t: number, show = 5): SmcZone[] {
  const alive = s.zones.filter((z) => z.created < t && z.removed >= t);
  const newest = (k: SmcZone['kind']) => alive.filter((z) => z.kind === k).sort((a, b) => b.created - a.created).slice(0, show);
  return [...newest('ob-internal'), ...newest('ob-swing'), ...alive.filter((z) => z.kind === 'fvg')];
}

/**
 * Zones alive entering each bar, for a sweep with t increasing (the backtest): same result as smcZonesBefore, without
 * scanning every zone each bar.
 */
export function smcZoneCursor(s: SmcSeries, show = 5): (t: number) => SmcZone[] {
  const byCreated = [...s.zones].sort((a, b) => a.created - b.created);
  let k = 0, alive: SmcZone[] = [], last = -1;
  return (t: number) => {
    if (t < last) throw new Error('smcZoneCursor: t must not decrease');
    last = t;
    while (k < byCreated.length && byCreated[k]!.created < t) alive.push(byCreated[k++]!);
    alive = alive.filter((z) => z.removed >= t);
    const newest = (kind: SmcZone['kind']) => alive.filter((z) => z.kind === kind).sort((a, b) => b.created - a.created).slice(0, show);
    return [...newest('ob-internal'), ...newest('ob-swing'), ...alive.filter((z) => z.kind === 'fvg')];
  };
}
