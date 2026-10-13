// TypeScript port of "Smart S/R Zones" (Pine v5; the copy given has no author or licence header) for the owner's ETH /
// BTC cards (owner 2026-10-13, cards v2). Calculations only (no lines, boxes, labels or table), default inputs: base
// lookback 50, extended 80, pivot strength 5, flip memory 50 bars, level spacing 1%, 50 / 200 SMAs on the chart, the
// shorter and the longer timeframe, scoring weights proximity 0.5 / bounces 0.3 / volume 0.2, ranked by score.
//
// Bar-for-bar notes (the candidates are rebuilt every bar; only the flip memory carries over):
// - Pivots use the series shifted by one bar (ta.pivotlow(low[1], 5, 5)): a swing low is the low 6 bars back with 5
//   bars on each side (pine.ts taPivot on the bar before).
// - Flip memory: on a bar whose close is over a newly confirmed pivot high, that CLOSE is stored as broken resistance
//   (under a pivot low: broken support); entries older than 50 bars go. The newest of each is a candidate (flipped
//   resistance as support, flipped support as resistance). The script computes a retest bonus but then adds the
//   candidate without it (addCandidate scores it again with no bonus); kept as written.
// - Candidates, in this order (supports under the close, resistances over it): the flips; the 50 and 200 SMA; the swing
//   low / high confirmed on this bar (if 1% from those already in); the 50-bar low / high before this bar (same);
//   the 50 / 200 SMA of the shorter timeframe (same); the 50 / 200 SMA of the longer timeframe (same; the longer 200
//   SMA only as support, as written). Shorter / longer: 4H chart -> 1H / daily, daily -> 4H / weekly, weekly -> daily /
//   monthly. The longer timeframe's value is the developing one at this bar's close (what the chart shows live).
// - Score = 0.5 x proximity (1 - distance / (10 ATR(14)), 0..1) + 0.3 x bounces (lows / highs within 0.2% over the
//   last 50 bars, / 5, 0..1) + 0.2 x volume (volume of those bars / the 50-bar average volume; not capped) + 0.05 when
//   the level was touched as both support and resistance in the last 50 bars. Highest score first.
// - With fewer than 2 supports, the 80-bar low (this bar included) is added as "Extended Low".
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taHighest, taLowest, taPivot, taSma } from './pine';

export const SMARTSR = { lookback: 50, maxLookback: 80, pivotLen: 5, flipLife: 50, spacingPct: 1.0, maShort: 50, maLong: 200, wProx: 0.5, wBounce: 0.3, wVol: 0.2, bounceTol: 0.2, volLookback: 50, bothSides: 0.05 } as const;

export interface SmartCand { level: number; tag: string; score: number }
/** Another timeframe's bars; `ends` gives each bar's end when bars differ in length (months). */
export interface OtherTf { c: ReadonlyArray<Candle>; ms: number; label: string; ends?: ReadonlyArray<number> }

/** The 50 / 200 SMA of another timeframe's closes as of time t (a developing bar takes `price` as its close). */
function otherSma(o: OtherTf, t: number, price: number, len: number): number {
  const closes: number[] = [];
  for (let k = 0; k < o.c.length; k++) {
    const b = o.c[k]!, end = o.ends ? o.ends[k]! : b.openTime + o.ms;
    if (end <= t) closes.push(b.close);
    else if (b.openTime < t) { closes.push(price); break; }
    else break;
  }
  if (closes.length < len) return NaN;
  return closes.slice(-len).reduce((a, x) => a + x, 0) / len;
}

/** The script's ranked supports and resistances at bar `at` of the chart's bars (`ms` = the chart bar length). */
export function smartSr(c: ReadonlyArray<Candle>, at: number, ms: number, shorter: OtherTf, longer: OtherTf): { support: SmartCand[]; resistance: SmartCand[] } {
  const S = SMARTSR, hi = c.map((b) => b.high), lo = c.map((b) => b.low), cl = c.map((b) => b.close), vol = coinVolume(c);
  const pvH = (i: number) => (i >= 1 ? taPivot(hi, i - 1, S.pivotLen, true) : NaN), pvL = (i: number) => (i >= 1 ? taPivot(lo, i - 1, S.pivotLen, false) : NaN);
  const brokenS: { lvl: number; bar: number }[] = [], brokenR: { lvl: number; bar: number }[] = [];
  for (let i = 0; i <= at; i++) {
    if (cl[i]! > pvH(i)) brokenR.push({ lvl: cl[i]!, bar: i });
    if (cl[i]! < pvL(i)) brokenS.push({ lvl: cl[i]!, bar: i });
    for (const arr of [brokenS, brokenR]) for (let k = arr.length - 1; k >= 0; k--) if (i - arr[k]!.bar > S.flipLife) arr.splice(k, 1);
  }
  const price = cl[at]!, atr = taAtr(c, 14)[at]!, avgVol = taSma(vol, S.volLookback)[at]!, t = c[at]!.openTime + ms;
  const near = (l: number, i: number, sup: boolean) => Math.abs((sup ? lo[at - i]! : hi[at - i]!) - l) <= (l * S.bounceTol) / 100;
  const norm = (v: number, a: number, b: number) => (b === a ? 0 : Math.max(0, Math.min(1, (v - a) / (b - a))));
  const score = (l: number, sup: boolean) => {
    let bounces = 0, v = 0, asS = false, asR = false;
    for (let i = 1; i <= S.lookback && at - i >= 0; i++) {
      if (near(l, i, sup)) bounces++;
      if (Math.abs(lo[at - i]! - l) <= (l * S.bounceTol) / 100) asS = true;
      if (Math.abs(hi[at - i]! - l) <= (l * S.bounceTol) / 100) asR = true;
    }
    for (let i = 1; i <= S.volLookback && at - i >= 0; i++) if (near(l, i, sup)) v += vol[at - i]! || 0;
    const wt = S.wProx + S.wBounce + S.wVol;
    return (S.wProx / wt) * (1 - norm(Math.abs(price - l), 0, atr * 10)) + (S.wBounce / wt) * norm(bounces, 0, 5) + (S.wVol / wt) * (v / Math.max(avgVol, 1)) + (asS && asR ? S.bothSides : 0);
  };
  const sup: SmartCand[] = [], res: SmartCand[] = [];
  const add = (arr: SmartCand[], l: number, tag: string, isSup: boolean) => { if (isSup ? l < price : l > price) arr.push({ level: l, tag, score: score(l, isSup) }); };
  const far = (l: number, arr: SmartCand[]) => !arr.some((e) => (Math.abs(l - e.level) / ((l + e.level) / 2)) * 100 < S.spacingPct);
  if (brokenR.length) add(sup, brokenR.at(-1)!.lvl, 'Flipped Resistance', true);
  if (brokenS.length) add(res, brokenS.at(-1)!.lvl, 'Flipped Support', false);
  const maS = taSma(cl, S.maShort)[at]!, maL = taSma(cl, S.maLong)[at]!;
  if (maS < price) add(sup, maS, '50 SMA', true);
  if (maS > price) add(res, maS, '50 SMA', false);
  if (maL < price) add(sup, maL, '200 SMA', true);
  if (maL > price) add(res, maL, '200 SMA', false);
  const pl = pvL(at), ph = pvH(at);
  if (pl < price && far(pl, sup)) add(sup, pl, 'Swing Low', true);
  if (ph > price && far(ph, res)) add(res, ph, 'Swing High', false);
  const ll = at >= 1 ? taLowest(lo, S.lookback)[at - 1]! : NaN, hh = at >= 1 ? taHighest(hi, S.lookback)[at - 1]! : NaN;
  if (ll < price && far(ll, sup)) add(sup, ll, 'Period Low', true);
  if (hh > price && far(hh, res)) add(res, hh, 'Period High', false);
  for (const [o, longSupOnly] of [[shorter, false], [longer, true]] as const) {
    for (const [len, name] of [[S.maShort, '50 SMA'], [S.maLong, '200 SMA']] as const) {
      const m = otherSma(o, t, price, len), tag = `${name} (${o.label})`;
      if (m < price && far(m, sup)) add(sup, m, tag, true);
      if (m > price && far(m, res) && !(longSupOnly && len === S.maLong)) add(res, m, tag, false);
    }
  }
  const rank = (arr: SmartCand[]) => {
    const d: SmartCand[] = [];
    for (const x of arr) if (!d.some((e) => Math.abs(e.level - x.level) < price * 1e-7)) d.push(x);
    for (let i = 0; i < d.length - 1; i++) for (let j = i + 1; j < d.length; j++) if (d[i]!.score < d[j]!.score) { const a = d[i]!; d[i] = d[j]!; d[j] = a; }
    return d;
  };
  let support = rank(sup);
  if (support.length < 2) {
    const ext = taLowest(lo, S.maxLookback)[at]!;
    if (ext < price) { add(sup, ext, 'Extended Low', true); support = rank(sup); }
  }
  return { support, resistance: rank(res) };
}
