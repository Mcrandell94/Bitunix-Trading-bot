// The ETH / BTC cards v2 (owner 2026-10-13: "re attempt the cards for eth and btc ... give a read from the indicators
// on weekly time frame daily and 4h ... an ai interpreted read"). One card per coin at each 4H close with weekly, daily
// and 4H reads; the AI read (Claude Sonnet 5.5 since the owner's 2026-10-13 switch, written by the worker from this
// card's own lines) goes at the top, then the POI ladder (owner: "give a better idea of where short and long poi's sit").
//
// Kept from the first cards (owner): the intro (price, 24h, funding), the coin's EMA stack (emastack.ts), the Chop Zone
// (chopzone.ts), RSI / MACD, range targets (rangetargets.ts, FEELS) and the strong FVGs (fvgob.ts). Gone: KAMA,
// DiNapoli (card and 1H alerts), Outlook, Shaakuni levels / order blocks, trend ribbon, AxeAlgo S/R zones.
// New scripts (each its own port, default inputs, run on each timeframe's own bars):
// - Trend: Heat Map Trend (VIDYA) [BigBeluga] (vidyaheat.ts), one value per timeframe.
// - Order blocks: MarketMaulers Order Blocks v1.8 (mmob.ts) and Dynamic Order Blocks [LuxAlgo] (luxdynob.ts).
// - Gaps: HTF FVG/IFVG (htffvg.ts), FVG Absorption [LuxAlgo] (fvgabsorb.ts) and the strong FVGs.
// - S/R: Dynamic S/R Zones [ChartPrime] (cpsr.ts), Optimus S/R Zones (optimussr.ts), Smart S/R Zones (smartsr.ts).
// - Liquidity: Dynamic Liquidity HeatMap Profile (liqheat.ts) and Liquidation HeatMap (liqmap.ts) [BigBeluga], on 4H
//   and daily; only above-average-volume bins / zones (the bright part of the heat maps).
// Second batch (owner 2026-10-13):
// - Volume: Heatmap Volume [xdecow] (volheatmap.ts) and Volume HeatMap Divergence [BigBeluga] (voldiv.ts).
// - Fib: Auto-Fibonacci Levels [ChartWhizzperer] (autofib.ts) and Fibonacci Confluence Toolkit [LuxAlgo]
//   (fibtoolkit.ts; its live retracement only).
// Confluence (owner: "some will offer 2 indicators for the same thing"): the card shows the nearest zone or level above
// and below the price (and one holding it) with the other scripts' and timeframes' pieces that overlap it (S/R and Fib
// levels within 0.4% of the price). Pieces are not chained: a zone is joined only by what overlaps it, and a zone keeps
// its own edges (levels show the span of the levels that agree).
// POIs (pois() below): every script's zone or level on every timeframe, short side over the price and long side under it,
// each zone with what overlaps it from the other families (order blocks, FVGs, S/R, Fib, liquidity). A POI needs 2+
// families (weak ones are never sent), within 4 daily ATR; the 3 with the most families per side, by distance. A POI's
// range is one script's zone no taller than 1 daily ATR (taller zones only count as confluence), so it stays usable.
// Display filter: an order block or gap taller than 3 ATR(14) of its own timeframe is left off the card (cluster
// origins and weekly gaps can span a third of the price; too wide to act on). Weekly bars are the closed Monday weeks
// built from the daily bars. Display only: nothing here trades. Pure.

import type { Candle } from '@bot/marketdata';
import { macdLines, rsi } from '../indicators';
import { chopZone, zoneEmoji, type ChopColor } from './chopzone';
import { cpSr } from './cpsr';
import { biasSide, stackAt, stackSeries, type StackAt, type StackCoin, type StackSeries } from './emastack';
import { absAt, fvgAbsorb, type AbsGap } from './fvgabsorb';
import { fvgActive, fvgOb, fvgStrong, type FvgObSeries } from './fvgob';
import { htfFvgFor, htfShown, type HtfGap } from './htffvg';
import { liqHeat, type LiqProfile } from './liqheat';
import { luxDynOb, luxShown, type LuxBlock } from './luxdynob';
import { mmLive, mmob, type MmZone } from './mmob';
import { taAtr } from './pine';
import { optimusSr } from './optimussr';
import { openTargets, rangeTargets, type RangeSeries } from './rangetargets';
import { smartSr, type OtherTf } from './smartsr';
import { vidyaHeat, type VidyaSeries } from './vidyaheat';
import { aggregate } from './wyckoffhtf';
import { AUTOFIB, autoFib, autoFibAt, autoFibPrice, fibPct, type AutoFibCross, type AutoFibSet } from './autofib';
import { fibToolkit, LUXFIB, luxFibLive, luxFibPrice, type LuxChoch, type LuxFibSet } from './fibtoolkit';
import { liqMap } from './liqmap';
import { volDivergence, type VolDiv } from './voldiv';
import { heatmapVolume, type HmvSeries, type VolLevel } from './volheatmap';

export type Tf3 = 'W' | 'D' | '4H';
export const TFS: Tf3[] = ['W', 'D', '4H'];
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, WEEK = 7 * DAY;
const MS: Record<Tf3, number> = { W: WEEK, D: DAY, '4H': H4 };
export const COIN_CARD = { label: '⚠️ manage your own risk', maxText: 4096, srTolPct: 0.4, zoneTolPct: 0.1, maxZoneAtr: 3, macdRecent: 6, divRecent: 20, aiModelName: 'Claude Sonnet 5.5', poiMaxAtrD: 4, poiSeedAtrD: 1, poiMinFams: 2, poiPerSide: 3 } as const;

export const px = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '-' : Math.abs(x) >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Number(x.toPrecision(5)).toString());
const sg = (x: number, d = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const iso = (t: number) => new Date(t).toISOString();
const when = (t: number, tf: Tf3) => (tf === '4H' ? `${iso(t).slice(5, 10)} ${iso(t).slice(11, 16)}` : iso(t).slice(5, 10));
const utc = (t: number) => `${iso(t).slice(0, 10)} ${iso(t).slice(11, 16)} UTC`;

export interface CoinCardInput {
  symbol: StackCoin; m15: ReadonlyArray<Candle>; h1: ReadonlyArray<Candle>; h4: ReadonlyArray<Candle>; d1: ReadonlyArray<Candle>;
  funding: { rate: number; intervalHours: number } | null;
  /** The 4H close the card is for (bars after it are ignored). */
  now: number;
}

/** One timeframe's bars and every script's series on them. */
export interface TfSet {
  tf: Tf3; c: Candle[]; ms: number; last: number; atr: number[];
  vidya: VidyaSeries; cz: { angle: number[]; color: (ChopColor | null)[] }; rsi: (number | null)[]; hist: (number | null)[];
  mm: MmZone[]; lux: LuxBlock[]; htf: HtfGap[]; abs: AbsGap[]; fo: FvgObSeries; rt: RangeSeries | null;
  hmv: HmvSeries; vdiv: VolDiv[]; afib: { sets: AutoFibSet[]; crosses: AutoFibCross[] }; lfib: { sets: LuxFibSet[]; chochs: LuxChoch[] };
}

function tfSet(tf: Tf3, c: Candle[]): TfSet {
  const close = c.map((b) => b.close), m = macdLines(close);
  return {
    tf, c, ms: MS[tf], last: c.length - 1, atr: taAtr(c, 14),
    vidya: vidyaHeat(c, tf === 'W'), cz: chopZone(c), rsi: rsi(close, 14), hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    mm: mmob(c), lux: luxDynOb(c), htf: htfFvgFor(c, tf), abs: fvgAbsorb(c), fo: fvgOb(c), rt: tf === 'W' ? null : rangeTargets(c),
    hmv: heatmapVolume(c), vdiv: volDivergence(c).divs, afib: autoFib(c), lfib: fibToolkit(c),
  };
}

/** A zone or level from one script on one timeframe. */
export interface Piece { lo: number; hi: number; tf: Tf3; src: string; note?: string; side?: 1 | -1 }
/** Merged pieces: the zone, and the scripts / timeframes in it. */
export interface Group { lo: number; hi: number; pieces: Piece[] }
export interface Family { above: Group | null; below: Group | null; inside: Group | null }

/**
 * The pieces nearest the price: the nearest above, below and holding it (the narrowest), each joined by the pieces on
 * its side that overlap it (+ tol), not chained. `expand`: the group spans its pieces (levels); otherwise it keeps the
 * nearest piece's edges (zones, so one wide zone cannot stretch it).
 */
export function nearestGroups(pieces: ReadonlyArray<Piece>, price: number, tol: number, expand = true): Family {
  const grow = (seed: Piece, pool: Piece[]): Group => {
    const g: Group = { lo: seed.lo, hi: seed.hi, pieces: [seed] };
    for (const p of pool) if (p !== seed && p.lo <= seed.hi + tol && p.hi >= seed.lo - tol) { g.pieces.push(p); if (expand) { g.lo = Math.min(g.lo, p.lo); g.hi = Math.max(g.hi, p.hi); } }
    return g;
  };
  const inside = pieces.filter((p) => p.lo <= price && p.hi >= price).sort((a, b) => a.hi - a.lo - (b.hi - b.lo)), above = pieces.filter((p) => p.lo > price).sort((a, b) => a.lo - b.lo), below = pieces.filter((p) => p.hi < price).sort((a, b) => b.hi - a.hi);
  const gi = inside.length ? grow(inside[0]!, inside) : null;
  // Above / below: the nearest piece and what overlaps it on its own side (a zone holding the price is shown apart).
  return { above: above.length ? grow(above[0]!, above) : null, below: below.length ? grow(below[0]!, below) : null, inside: gi };
}

export type Fam = 'OB' | 'FVG' | 'S/R' | 'Fib' | 'Liq';
export const FAMS: Fam[] = ['OB', 'FVG', 'Liq', 'S/R', 'Fib'];
/** A POI: a zone (or level) from one script and what overlaps it; side 1 = short (over the price), -1 = long. */
export interface Poi { side: 1 | -1; lo: number; hi: number; parts: { fam: Fam; p: Piece }[]; fams: Fam[]; tfs: Tf3[]; /** Scripts x timeframes in it. */ sources: number }

/** The POI side an order block or gap belongs to (bullish = long -1, bearish = short 1; Piece.side is the direction,
 * 1 = bullish), or null for levels and liquidity (they take the side they sit on). */
const pieceSide = (fam: Fam, p: Piece): 1 | -1 | null => {
  if (fam !== 'OB' && fam !== 'FVG') return null;
  const dir = p.side ?? (p.note === 'bull' ? 1 : p.note === 'bear' ? -1 : 0);
  return dir > 0 ? -1 : dir < 0 ? 1 : null;
};

/**
 * The POI ladder: on each side of the price, the pieces within `maxDist` (OB / FVG only on their own side: a bull zone
 * is a long POI, a bear zone a short POI). Each piece seeds a POI joined by the overlapping pieces (levels within
 * `tolLevel`, zones within `tolZone`); seeds are no taller than `maxWidth`. The POIs with the most families (then the
 * most sources, i.e. scripts x timeframes, then an order block's or FVG's range before liquidity's and levels', then
 * nearer, then narrower) are taken, skipping one
 * whose zone is already in a taken POI or overlaps it; `minFams` families at least, `n` a side, nearest first. Pure.
 */
export function pois(all: ReadonlyArray<{ fam: Fam; p: Piece }>, price: number, opts: { tolLevel: number; tolZone: number; maxDist: number; maxWidth: number; minFams: number; n: number }): { short: Poi[]; long: Poi[] } {
  const out = { short: [] as Poi[], long: [] as Poi[] };
  for (const side of [1, -1] as const) {
    const dist = (x: { lo: number; hi: number }) => (side > 0 ? x.lo - price : price - x.hi);
    const cand = all.filter((x) => (side > 0 ? x.p.lo > price : x.p.hi < price) && dist(x.p) <= opts.maxDist && (pieceSide(x.fam, x.p) ?? side) === side);
    const near = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => { const t = a.lo === a.hi || b.lo === b.hi ? opts.tolLevel : opts.tolZone; return b.lo <= a.hi + t && b.hi >= a.lo - t; };
    const made = cand.filter((x) => x.p.hi - x.p.lo <= opts.maxWidth).map((seed) => {
      const parts = [seed, ...cand.filter((y) => y !== seed && near(seed.p, y.p))];
      const fams = FAMS.filter((f) => parts.some((x) => x.fam === f)), tfs = TFS.filter((tf) => parts.some((x) => x.p.tf === tf));
      const sources = new Set(parts.map((x) => `${x.p.src}|${x.p.tf}`)).size;
      return { side, lo: seed.p.lo, hi: seed.p.hi, parts, fams, tfs, sources } as Poi;
    }).filter((x) => x.fams.length >= opts.minFams);
    const rank = (z: Poi) => FAMS.indexOf(z.parts[0]!.fam);
    made.sort((a, b) => b.fams.length - a.fams.length || b.sources - a.sources || rank(a) - rank(b) || dist(a) - dist(b) || a.hi - a.lo - (b.hi - b.lo));
    const pick: Poi[] = [];
    for (const z of made) {
      if (pick.length >= opts.n) break;
      if (!pick.some((q) => q.parts.some((x) => x.p === z.parts[0]!.p) || near(q, z))) pick.push(z);
    }
    out[side > 0 ? 'short' : 'long'] = pick.sort((a, b) => dist(a) - dist(b));
  }
  return out;
}

export interface CoinCard {
  symbol: StackCoin; at: number; price: number; change24h: number | null; high24h: number; low24h: number; funding: CoinCardInput['funding'];
  stack: StackAt;
  tf: Record<Tf3, { vidya: number; vidyaUp: boolean | null; chop: ChopColor | null; rsi: number | null; macd: string; barAt: number; volZ: number; vol: VolLevel; volUp: boolean } | null>;
  weeklyDevLen: number;
  ob: Family; fvg: Family; sr: Family; srSources: number; fib: Family; liq: Family;
  poi: { short: Poi[]; long: Poi[]; maxDist: number };
  /** Volume divergences confirmed in the last COIN_CARD.divRecent bars of their timeframe, newest first. */
  divs: { tf: Tf3; dir: 1 | -1; t: number; price: number }[];
  range: Partial<Record<'4H' | 'D', { now: { lo: number; hi: number; forming: boolean } | null; up: number | null; dn: number | null }>>;
}
export interface CoinBuilt { card: CoinCard; sets: Partial<Record<Tf3, TfSet>>; stack: StackSeries; /** Every piece before merging (the chart check). */ pieces: { ob: Piece[]; fvg: Piece[]; sr: Piece[]; fib: Piece[]; liq: Piece[] } }

function macdWord(S: TfSet): string {
  const i = S.last, h = S.hist[i];
  if (h == null) return 'MACD -';
  const side = h >= 0 ? 'bull' : 'bear', p = S.hist[i - 1];
  let k = i;
  while (k > 0 && S.hist[k - 1] != null && Math.sign(S.hist[k - 1]!) === Math.sign(h)) k--;
  const since = i - k, recent = k > 0 && since <= COIN_CARD.macdRecent ? (since === 0 ? ', crossed this bar' : `, crossed ${since} bar${since === 1 ? '' : 's'} ago`) : '';
  return `MACD ${side}${recent}, ${p != null && Math.abs(h) < Math.abs(p) ? 'shrinking' : 'widening'}`;
}

export function coinCard(inp: CoinCardInput): CoinBuilt {
  const t = inp.now, closed = (c: ReadonlyArray<Candle>, ms: number) => c.filter((b) => b.openTime + ms <= t);
  const h4 = closed(inp.h4, H4), d1 = closed(inp.d1, DAY), h1 = closed(inp.h1, H), weeks = aggregate(d1, 'W'), months = aggregate(d1, 'M');
  const w1 = weeks.c.filter((_, k) => weeks.ends[k]! <= t);
  const raw: Record<Tf3, Candle[]> = { W: w1, D: d1, '4H': h4 };
  const sets: Partial<Record<Tf3, TfSet>> = {};
  for (const tf of TFS) if (raw[tf].length >= 30) sets[tf] = tfSet(tf, raw[tf]);
  const stack = stackSeries(inp.symbol, d1, h4);
  const m = inp.m15, last = m[m.length - 1]!, from = last.openTime + 15 * 60_000 - DAY;
  const day = m.filter((b) => b.openTime >= from), ago = [...m].reverse().find((b) => b.openTime + 15 * 60_000 <= from);
  const price = h4.at(-1)?.close ?? last.close;

  // Order blocks, gaps and S/R pieces from every script and timeframe.
  const ob: Piece[] = [], fvg: Piece[] = [], sr: Piece[] = [], fib: Piece[] = [], liqP: Piece[] = [];
  const other = (tf: '1H' | '4H' | 'D' | 'W' | 'M'): OtherTf => (tf === '1H' ? { c: h1, ms: H, label: '1H' } : tf === '4H' ? { c: h4, ms: H4, label: '4H' } : tf === 'D' ? { c: d1, ms: DAY, label: 'Daily' } : tf === 'W' ? { c: weeks.c, ms: WEEK, label: 'Weekly', ends: weeks.ends } : { c: months.c, ms: 31 * DAY, label: 'Monthly', ends: months.ends });
  for (const tf of TFS) {
    const S = sets[tf];
    if (!S) continue;
    const i = S.last, word = (d: number) => (d > 0 ? 'bull' : 'bear'), maxH = COIN_CARD.maxZoneAtr * S.atr[i]!;
    const ob0 = ob.length, fvg0 = fvg.length;
    for (const { z } of mmLive(S.mm, i)) ob.push({ lo: z.bot, hi: z.top, tf, src: 'MM', note: word(z.dir) });
    const lx = luxShown(S.lux, i);
    for (const k of [lx.bull, lx.bear]) if (k) ob.push({ lo: k.btm, hi: k.top, tf, src: 'Lux', note: word(k.dir) });
    for (const x of htfShown(S.htf, i)) fvg.push({ lo: x.z.lo, hi: x.z.hi, tf, src: x.ifvg ? 'IFVG' : 'FVG', note: word(x.side) });
    for (const g of S.fo.fvgs) if (fvgActive(g, i) && fvgStrong(g)) fvg.push({ lo: g.bottom, hi: g.top, tf, src: 'strong', note: word(g.side) });
    const a = absAt(S.abs, i);
    if (a) {
      const edge = a.g.dir > 0 ? a.g.top - a.absorbed * (a.g.top - a.g.bot) : a.g.bot + a.absorbed * (a.g.top - a.g.bot);
      fvg.push({ lo: a.g.dir > 0 ? a.g.bot : edge, hi: a.g.dir > 0 ? edge : a.g.top, tf, src: 'abs', note: `${Math.round(a.absorbed * 100)}% absorbed`, side: a.g.dir });
    }
    for (const arr of [[ob, ob0], [fvg, fvg0]] as const) for (let k = arr[0].length - 1; k >= arr[1]; k--) if (arr[0][k]!.hi - arr[0][k]!.lo > maxH) arr[0].splice(k, 1);
    const cp = cpSr(S.c, i), cs = cp.support.at(-1), cr = cp.resistance[0];
    if (cs != null) sr.push({ lo: cs, hi: cs, tf, src: 'CP' });
    if (cr != null) sr.push({ lo: cr, hi: cr, tf, src: 'CP' });
    const op = optimusSr(S.c, i, tf);
    for (const l of [...op.support, ...op.resistance]) sr.push({ lo: l.price - op.zone, hi: l.price + op.zone, tf, src: 'Opt', note: `${l.touches} touches` });
    const sm = smartSr(S.c, i, S.ms, other(tf === '4H' ? '1H' : tf === 'D' ? '4H' : 'D'), other(tf === '4H' ? 'D' : tf === 'D' ? 'W' : 'M'));
    for (const s of [sm.support[0], sm.resistance[0]]) if (s) sr.push({ lo: s.level, hi: s.level, tf, src: 'Smart', note: s.tag });
    const af = autoFibAt(S.afib.sets, i);
    if (af) for (const p of AUTOFIB.levels) { const v = autoFibPrice(af, p); fib.push({ lo: v, hi: v, tf, src: 'Auto', note: fibPct(p) }); }
    for (const fs of luxFibLive(S.lfib.sets, i)) for (const x of LUXFIB.levels) { const v = luxFibPrice(fs, x); fib.push({ lo: v, hi: v, tf, src: 'LuxFib', note: `${x}`, side: fs.dir }); }
  }
  const tolSr = (price * COIN_CARD.srTolPct) / 100, tolZ = (price * COIN_CARD.zoneTolPct) / 100;
  const range: CoinCard['range'] = {};
  for (const tf of ['4H', 'D'] as const) {
    const S = sets[tf];
    if (!S) continue;
    const p: LiqProfile = liqHeat(S.c, S.last), P = S.c[S.last]!.close;
    for (const b of p.bins) if (b.vol > p.avg) liqP.push({ lo: b.lo, hi: b.hi, tf, src: 'profile', note: p.max && b.lo === p.max.lo ? 'max' : undefined });
    for (const z of liqMap(S.c, S.last, tf).live) if (z.vol > z.avg) liqP.push({ lo: z.bot, hi: z.top, tf, src: 'heat map', side: z.side });
    if (S.rt) {
      const n = S.rt.now, k = S.last, open = openTargets(S.rt, k).filter((x) => !x.quiet);
      range[tf] = {
        now: Number.isNaN(n.hi[k]!) ? null : { lo: n.lo[k]!, hi: n.hi[k]!, forming: n.forming[k] === 1 },
        up: open.filter((x) => x.px > P).sort((a, b) => a.px - b.px)[0]?.px ?? null, dn: open.filter((x) => x.px < P).sort((a, b) => b.px - a.px)[0]?.px ?? null,
      };
    }
  }
  const tfv = {} as CoinCard['tf'];
  for (const tf of TFS) {
    const S = sets[tf];
    if (!S) { tfv[tf] = null; continue; }
    const v = S.vidya.value[S.last]!;
    tfv[tf] = { vidya: v, vidyaUp: Number.isNaN(v) ? null : v > 0, chop: S.cz.color[S.last] ?? null, rsi: S.rsi[S.last] ?? null, macd: macdWord(S), barAt: S.c[S.last]!.openTime + S.ms, volZ: S.hmv.z[S.last]!, vol: S.hmv.level[S.last]!, volUp: S.hmv.up[S.last]! };
  }
  const divs: CoinCard['divs'] = [];
  for (const tf of TFS) {
    const S = sets[tf];
    if (S) for (const d of S.vdiv) if (d.i <= S.last && S.last - d.i < COIN_CARD.divRecent) divs.push({ tf, dir: d.dir, t: S.c[d.at]!.openTime, price: d.price });
  }
  divs.sort((a, b) => b.t - a.t);
  const atrD = sets.D ? sets.D.atr[sets.D.last]! : NaN, maxDist = Number.isNaN(atrD) ? price * 0.1 : COIN_CARD.poiMaxAtrD * atrD;
  const fams: { fam: Fam; p: Piece }[] = [...ob.map((p) => ({ fam: 'OB' as Fam, p })), ...fvg.map((p) => ({ fam: 'FVG' as Fam, p })), ...sr.map((p) => ({ fam: 'S/R' as Fam, p })), ...fib.map((p) => ({ fam: 'Fib' as Fam, p })), ...liqP.map((p) => ({ fam: 'Liq' as Fam, p }))];
  const maxWidth = Number.isNaN(atrD) ? price * 0.03 : COIN_CARD.poiSeedAtrD * atrD;
  const poi = { ...pois(fams, price, { tolLevel: tolSr, tolZone: tolZ, maxDist, maxWidth, minFams: COIN_CARD.poiMinFams, n: COIN_CARD.poiPerSide }), maxDist };
  const card: CoinCard = {
    symbol: inp.symbol, at: t, price, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    stack: stackAt(stack, t), tf: tfv, weeklyDevLen: sets.W?.vidya.devLen ?? 0,
    ob: nearestGroups(ob, price, tolZ, false), fvg: nearestGroups(fvg, price, tolZ, false), sr: nearestGroups(sr, price, tolSr), srSources: 3,
    fib: nearestGroups(fib, price, tolSr), liq: nearestGroups(liqP, price, tolZ, false), divs, range, poi,
  };
  return { card, sets, stack, pieces: { ob, fvg, sr, fib, liq: liqP } };
}

// ---- text ----
const tfOrder = (a: Piece, b: Piece) => TFS.indexOf(a.tf) - TFS.indexOf(b.tf);
const pieceLabel = (p: Piece) =>
  p.src === 'Smart' && p.note ? `Smart ${p.note}` : p.src === 'abs' ? `absorption ${p.note!.replace(' absorbed', '')}` : p.src === 'Auto' ? `Auto ${p.note}` : p.src === 'LuxFib' ? `Lux ${p.note}` : p.src === 'profile' && p.note === 'max' ? 'profile max' : p.src;
/** "D MM + Lux · 4H heat map ×3": the pieces of a group by timeframe (×n: that many of the same). */
function groupTags(g: Group): string {
  const by = new Map<Tf3, Map<string, number>>();
  for (const p of [...g.pieces].sort(tfOrder)) { const l = by.get(p.tf) ?? new Map<string, number>(), s = pieceLabel(p); l.set(s, (l.get(s) ?? 0) + 1); by.set(p.tf, l); }
  return [...by].map(([tf, l]) => `${tf} ${[...l].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(' + ')}`).join(' · ');
}
const sideNote = (g: Group) => { const n = new Set(g.pieces.filter((p) => ['MM', 'Lux', 'FVG', 'IFVG', 'strong'].includes(p.src)).map((p) => p.note)); return n.size === 1 ? ` ${[...n][0]}` : ''; };
const zoneLine = (mark: string, g: Group | null, kind: string) => (g ? ` ${mark} ${px(g.lo)}–${px(g.hi)}${sideNote(g)}${kind} · ${esc(groupTags(g))}` : ` ${mark} none`);
const srLine = (mark: string, g: Group | null, of = 3) => {
  if (!g) return ` ${mark} none`;
  const n = new Set(g.pieces.map((p) => p.src)).size;
  return ` ${mark} ${g.lo === g.hi ? px(g.lo) : `${px(g.lo)}–${px(g.hi)}`} · ${n}/${of} · ${esc(groupTags(g))}`;
};
const volWord = (x: { volZ: number; vol: VolLevel }) => `${x.vol === 'high' || x.vol === 'extra high' ? '🔥 ' : ''}${x.vol} ${Number.isNaN(x.volZ) ? '-' : `${sg(x.volZ, 1)}σ`}`;

function emaLines(a: StackAt): string[] {
  const e = (x: { n: number; ema: number; over: boolean; pct: number } | null) => (x ? `${x.over ? 'over' : 'under'} EMA ${x.n} ${px(x.ema)} (${sg(x.pct, 1)}%)` : 'EMA -');
  const side = biasSide(a), out = ['', `<b>EMA</b> (${a.coin === 'ETHUSDT' ? 'ETH: 26 · 13/21 · W13/W21' : 'BTC: 26 · 144 · 9/89 · W5/W34'})`];
  out.push(` D ${e(a.bias)}${a.slow ? ` · ${e(a.slow)}` : ''}${a.pair ? ` · ${a.pair.fast} ${a.pair.over ? 'over' : 'under'} ${a.pair.slow}` : ''} → ${side > 0 ? 'longs allowed' : side < 0 ? 'shorts allowed' : 'no side'}`);
  if (a.weekly) out.push(` W ${a.weekly.lines.map((x) => `${x.over ? 'over' : 'under'} W${x.n} ${px(x.ema)}${a.coin === 'BTCUSDT' ? (x.n === 5 ? (x.over ? ' ✓' : ' ✗') : x.over ? '' : ' ⛔ veto') : ''}`).join(' · ')}${a.coin === 'ETHUSDT' ? ` · short confirmation ${a.shortConfirm == null ? '-' : a.bias?.over ? 'off' : a.shortConfirm ? '✓' : '✗'}` : a.shortCheck ? ` · short check ${a.shortCheck.count}/3` : ''}`);
  if (a.trigger) out.push(` 4H ${a.trigger.pairs.map((p) => `${p.fast}/${p.slow} ${p.over ? 'bull' : 'bear'}`).join(' · ')} · limits ${a.trigger.limits.map((l) => `EMA ${l.n} ${px(l.v)}`).join(' / ')}`);
  return out;
}

const famTags = (z: Poi) => z.fams.map((f) => `${f} ${TFS.filter((tf) => z.parts.some((x) => x.fam === f && x.p.tf === tf)).join('+')}`).join(' · ');
const pct = (x: number, price: number) => `${x >= price ? '+' : '−'}${Math.abs((x / price - 1) * 100).toFixed(1)}%`;
/** The POI ladder: short POIs over the price (farthest first), the price, long POIs under it (nearest first). */
export function poiLines(card: CoinCard): string[] {
  const row = (z: Poi) => ` ${z.side > 0 ? '🔴 short' : '🟢 long'} ${z.lo === z.hi ? px(z.lo) : `${px(z.lo)}–${px(z.hi)}`} (${pct(z.side > 0 ? z.lo : z.hi, card.price)}) · ${z.fams.length}/5 · ${z.sources} sources: ${famTags(z)}`;
  const none = (w: string) => ` ${w}: none with 2+ sources within ${pct(card.price + card.poi.maxDist, card.price).slice(1)}`;
  return [
    `<b>POIs</b> (all scripts · W / D / 4H · ${COIN_CARD.label})`,
    ...(card.poi.short.length ? [...card.poi.short].reverse().map(row) : [none('🔴 short')]),
    ` ── price ${px(card.price)}`,
    ...(card.poi.long.length ? card.poi.long.map(row) : [none('🟢 long')]),
  ];
}

/** The card's indicator lines (no intro, no AI read): the body the AI read is written from. */
export function cardBody(card: CoinCard): string[] {
  const T = card.tf, cell = (tf: Tf3, f: (x: NonNullable<CoinCard['tf'][Tf3]>) => string) => (T[tf] ? `${tf} ${f(T[tf]!)}` : `${tf} -`);
  const out: string[] = [...poiLines(card), ''];
  out.push('<b>Trend</b> (VIDYA heat map · BigBeluga)', ` ${TFS.map((tf) => cell(tf, (x) => (x.vidyaUp == null ? '-' : `${x.vidyaUp ? '🟢 up' : '🔴 down'} ${sg(x.vidya)}`))).join(' · ')}`);
  out.push(...emaLines(card.stack));
  const ch = T['4H']?.chop === 'yellow';
  out.push('', `<b>Chop Zone</b> ${TFS.map((tf) => cell(tf, (x) => `${zoneEmoji(x.chop)} ${x.chop ?? '-'}`)).join(' · ')}${ch ? ' · 4H chop: hold off on longs' : ''}`);
  out.push(`<b>RSI / MACD</b> ${TFS.map((tf) => cell(tf, (x) => `${x.rsi == null ? '-' : x.rsi.toFixed(0)} · ${x.macd.replace('MACD ', '')}`)).join(' | ')}`);
  out.push(`<b>Volume</b> (xdecow · BigBeluga) ${TFS.map((tf) => cell(tf, volWord)).join(' · ')}`);
  const dv = TFS.map((tf) => card.divs.find((d) => d.tf === tf)).filter((d): d is CoinCard['divs'][number] => !!d);
  if (dv.length) out.push(` divergence ${dv.map((d) => `${d.tf} ${d.dir > 0 ? `bull ${when(d.t, d.tf)} (low ${px(d.price)} on more volume)` : `bear ${when(d.t, d.tf)} (high ${px(d.price)} on less volume)`}`).join(' · ')}`);
  out.push('', '<b>Order blocks</b> (MarketMaulers · LuxAlgo)', zoneLine('▲', card.ob.above, ' OB'), ...(card.ob.inside ? [zoneLine('◆ in', card.ob.inside, ' OB')] : []), zoneLine('▼', card.ob.below, ' OB'));
  out.push('', '<b>FVG</b> (HTF FVG/IFVG · LuxAlgo absorption · strong)', zoneLine('▲', card.fvg.above, ''), ...(card.fvg.inside ? [zoneLine('◆ in', card.fvg.inside, '')] : []), zoneLine('▼', card.fvg.below, ''));
  out.push('', '<b>S/R</b> (ChartPrime · Optimus · Smart S/R)', srLine('R', card.sr.above), ...(card.sr.inside ? [srLine('◆ at', card.sr.inside)] : []), srLine('S', card.sr.below));
  out.push('', '<b>Fib</b> (Auto-Fib · ChartWhizzperer · Fib Confluence · LuxAlgo)', srLine('▲', card.fib.above, 2), ...(card.fib.inside ? [srLine('◆ at', card.fib.inside, 2)] : []), srLine('▼', card.fib.below, 2));
  out.push('', '<b>Liquidity</b> (BigBeluga profile · liquidation heat map)', zoneLine('▲', card.liq.above, ''), ...(card.liq.inside ? [zoneLine('◆ in', card.liq.inside, '')] : []), zoneLine('▼', card.liq.below, ''));
  const rg = (tf: '4H' | 'D') => { const x = card.range[tf]; if (!x) return `${tf} -`; const n = x.now, h = n ? n.hi - n.lo : 0; const tg = [x.up != null ? `▲ ${px(x.up)}` : '', x.dn != null ? `▼ ${px(x.dn)}` : ''].filter(Boolean).join(' · '); return `${tf} ${n ? `${n.forming ? 'forming' : 'range'} ${px(n.lo)}–${px(n.hi)} · if up ${px(n.hi + h)} · if down ${px(n.lo - h)}` : 'no range'}${tg ? ` · open targets ${tg}` : ''}`; };
  out.push('', '<b>Range targets</b> (FEELS)', ` ${rg('4H')}`, ` ${rg('D')}`);
  return out;
}

/** A section from outside the card's own scripts (the worker's Grok X / news line): a title and plain-text lines. */
export interface CardNote { title: string; lines: string[] }

/**
 * The card as Telegram HTML: one message (two if over 4,096 characters); `ai` is the AI read (plain text) if any, `note`
 * a plain-text section shown under it (escaped here).
 */
export function coinCardText(card: CoinCard, ai: string | null, note: CardNote | null = null): string[] {
  const f = card.funding;
  const head = [
    `📊 <b>${card.symbol}</b> · W / D / 4H card · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})${f ? ` · funding ${sg(f.rate * 100, 4)}% / ${f.intervalHours}h` : ''}`,
  ];
  if (ai) head.push('', `🤖 <b>AI read</b> (${COIN_CARD.aiModelName} · not advice)`, ` ${esc(ai)}`);
  if (note?.lines.length) head.push('', `🗞 <b>${esc(note.title)}</b>`, ...note.lines.map((l) => ` ${esc(l)}`));
  const body = cardBody(card), all = [...head, '', ...body].join('\n');
  if (all.length <= COIN_CARD.maxText) return [all];
  const cut = body.indexOf('<b>Order blocks</b> (MarketMaulers · LuxAlgo)') - 1;
  return [[...head, '', ...body.slice(0, cut)].join('\n'), [`📊 <b>${card.symbol}</b> · card (2/2) · ${utc(card.at)}`, ...body.slice(cut)].join('\n')];
}

/** What the AI read is written from: the card body as plain text, with the price line. */
export function aiInput(card: CoinCard, note: CardNote | null = null): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const ext = note?.lines.length ? [`${note.title} (unverified posts and pages from X and the web, not from the card's scripts):`, ...note.lines.map((l) => ` ${l}`)] : [];
  return [`${card.symbol} at the ${utc(card.at)} close. Price ${px(card.price)}, 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`}.`, ...cardBody(card).map(strip), ...ext].join('\n');
}

// ---- the preview's chart check ----
/** What each script shows at the card's close, per timeframe, to compare with TradingView (bar times = UTC opens). */
export function coinChartCheck(b: CoinBuilt): string[] {
  const out = [`===== CHART CHECK ${b.card.symbol} (default inputs; times are bar opens in UTC, as TradingView shows them; W = Monday weeks) =====`];
  for (const tf of TFS) {
    const S = b.sets[tf];
    if (!S) { out.push('', `--- ${tf}: not enough bars ---`); continue; }
    const i = S.last, P = S.c[i]!.close, atr = S.atr[i]!, maxH = COIN_CARD.maxZoneAtr * atr;
    const at = (k: number) => (k < 0 || k >= S.c.length ? '-' : tf === '4H' ? iso(S.c[k]!.openTime).slice(0, 16).replace('T', ' ') : iso(S.c[k]!.openTime).slice(0, 10));
    const wide = (lo: number, hi: number) => (hi - lo > maxH ? ' [over 3 ATR: off the card]' : '');
    const near = <T,>(xs: T[], mid: (x: T) => number, n = 6) => [...xs].sort((x, y) => Math.abs(mid(x) - P) - Math.abs(mid(y) - P)).slice(0, n);
    out.push('', `--- ${tf}: ${S.c.length} bars, ${at(0)} to ${at(i)} (last closed) · close ${px(P)} · ATR(14) ${px(atr)} ---`);
    const labs: string[] = [];
    for (let k = i; k >= 0 && labs.length < 3; k--) if (S.vidya.label[k]) labs.push(`${S.vidya.label[k]! > 0 ? 'UP' : 'DOWN'} ${at(k)}`);
    out.push(` VIDYA heat map: ${Number.isNaN(S.vidya.value[i]!) ? '-' : sg(S.vidya.value[i]!)} (deviation over ${S.vidya.devLen} bars) · last labels: ${labs.join(', ') || 'none'}`);
    let k0 = i;
    while (k0 > 0 && S.cz.color[k0 - 1] === S.cz.color[i]) k0--;
    out.push(` Chop Zone: ${S.cz.color[i] ?? '-'} (angle ${S.cz.angle[i]}) since ${at(k0)} · RSI 14 ${S.rsi[i]?.toFixed(1) ?? '-'} · ${macdWord(S)}`);
    const mm = near(mmLive(S.mm, i), (x) => (x.z.top + x.z.bot) / 2).map(({ z }) => `${z.dir > 0 ? 'bull' : 'bear'} ${px(z.bot)}–${px(z.top)} (OB candle ${at(z.left)}, drawn ${at(z.createdAt)})${wide(z.bot, z.top)}`);
    out.push(` MarketMaulers OBs live, nearest ${mm.length} of ${mmLive(S.mm, i).length}: ${mm.join(' · ') || 'none'}`);
    const lx = luxShown(S.lux, i);
    out.push(` LuxAlgo Dynamic OB: ${[lx.bull, lx.bear].filter((x): x is LuxBlock => !!x).map((x) => `${x.dir > 0 ? 'bull' : 'bear'} ${px(x.btm)}–${px(x.top)} (drawn ${at(x.createdAt)})${wide(x.btm, x.top)}`).join(' · ') || 'none'}`);
    const hAll = htfShown(S.htf, i), hs = near(hAll, (x) => (x.z.lo + x.z.hi) / 2, 8).map((x) => `${x.ifvg ? 'IFVG' : 'FVG'} ${x.side > 0 ? 'bull' : 'bear'} ${px(x.z.lo)}–${px(x.z.hi)} (candles ${at(x.z.firstAt)} to ${at(x.z.createdAt)}${x.ifvg ? `, inverted ${at(x.z.convertedAt)}` : ''})${wide(x.z.lo, x.z.hi)}`);
    out.push(` HTF FVG/IFVG (${tf === 'W' ? 'daily engine on weekly bars, 365-day lookback' : tf === 'D' ? 'daily engine' : '4H engine'}), nearest ${hs.length} of ${hAll.length}: ${hs.join(' · ') || 'none'}`);
    const a = absAt(S.abs, i);
    out.push(` LuxAlgo FVG Absorption: ${a ? `${a.g.dir > 0 ? 'bull' : 'bear'} ${px(a.g.bot)}–${px(a.g.top)} (gap ${at(a.g.createdAt)}), ${Math.round(a.absorbed * 100)}% absorbed${wide(a.g.bot, a.g.top)}` : 'no gap tracked'}`);
    const st = S.fo.fvgs.filter((g) => fvgActive(g, i) && fvgStrong(g)).map((g) => `${g.side > 0 ? 'bull' : 'bear'} ${px(g.bottom)}–${px(g.top)} (candles ${at(g.leftBar)} to ${at(g.createdAt)}, ${g.sizeAtr.toFixed(2)} ATR, volume ${g.volMult.toFixed(1)}x)${wide(g.bottom, g.top)}`);
    out.push(` Strong FVGs, unfilled: ${st.join(' · ') || 'none'}`);
    const cp = cpSr(S.c, i);
    out.push(` ChartPrime S/R: resistance ${cp.resistance.map(px).join(', ') || 'none'} · support ${[...cp.support].reverse().map(px).join(', ') || 'none'}`);
    const op = optimusSr(S.c, i, tf), ol = (l: { price: number; touches: number }) => `${px(l.price)} (${l.touches})`;
    out.push(` Optimus S/R (lookback ${op.lookback}, zone ±${px(op.zone)}): resistance ${op.resistance.map(ol).join(', ') || 'none'} · support ${op.support.map(ol).join(', ') || 'none'}`);
    const sm = b.pieces.sr.filter((x) => x.tf === tf && x.src === 'Smart');
    out.push(` Smart S/R, top-ranked: ${sm.map((x) => `${x.lo > P ? 'R' : 'S'} ${px(x.lo)} ${x.note}`).join(' · ') || 'none'}`);
    if (tf !== 'W') {
      const lq = liqHeat(S.c, i), top = [...lq.bins].sort((x, y) => y.vol - x.vol).slice(0, 4);
      out.push(` Liquidity HeatMap: heaviest bins ${top.map((x) => `${px(x.lo)}–${px(x.hi)}`).join(', ') || 'none'} (max ${lq.max ? `${px(lq.max.lo)}–${px(lq.max.hi)}` : '-'})`);
    }
    const hot: string[] = [];
    for (let k = i; k >= 0 && hot.length < 3; k--) if (S.hmv.level[k] === 'high' || S.hmv.level[k] === 'extra high') hot.push(`${at(k)} ${S.hmv.level[k]} ${sg(S.hmv.z[k]!, 1)}σ`);
    out.push(` Heatmap Volume (xdecow): last bar ${S.hmv.level[i]} ${Number.isNaN(S.hmv.z[i]!) ? '-' : `${sg(S.hmv.z[i]!, 2)}σ`} · last high bars: ${hot.join(', ') || 'none'}`);
    out.push(` Volume divergence (BigBeluga), last 3: ${S.vdiv.filter((d) => d.i <= i).slice(-3).reverse().map((d) => `${d.dir > 0 ? 'Bull' : 'Bear'} label at ${at(d.at)} (${d.dir > 0 ? 'low' : 'high'} ${px(d.price)}, vs ${at(d.prevAt)} ${px(d.prevPrice)})`).join(' · ') || 'none'}`);
    const af = autoFibAt(S.afib.sets, i);
    out.push(` Auto-Fib (ChartWhizzperer): ${af ? `drawn ${at(af.at)}, ${af.bull ? 'up from' : 'down from'} ${px(af.bull ? af.lo : af.hi)} to ${px(af.bull ? af.hi : af.lo)}: ${AUTOFIB.levels.map((p) => `${fibPct(p)} ${px(autoFibPrice(af, p))}`).join(', ')}` : 'no swings yet'}`);
    const chs = S.lfib.chochs.filter((x) => x.i <= i), lastCh = chs.at(-1), live = luxFibLive(S.lfib.sets, i), lastSet = S.lfib.sets.filter((x) => x.createdAt <= i).at(-1);
    const fset = (fs: LuxFibSet) => `${fs.dir > 0 ? 'bull' : 'bear'} ${px(fs.dir > 0 ? fs.lo : fs.hi)} (${at(fs.dir > 0 ? fs.loAt : fs.hiAt)}) to ${px(fs.dir > 0 ? fs.hi : fs.lo)} (${at(fs.dir > 0 ? fs.hiAt : fs.loAt)}), drawn ${at(fs.createdAt)}: ${LUXFIB.levels.map((x) => `${x} ${px(luxFibPrice(fs, x))}`).join(', ')}`;
    out.push(` Fib Confluence Toolkit (LuxAlgo): last CHoCH ${lastCh ? `${lastCh.dir > 0 ? 'bullish' : 'bearish'} ${at(lastCh.i)} through ${px(lastCh.level)}` : 'none'} · live retracement: ${live.map(fset).join(' | ') || `none${lastSet ? ` (last one ended ${at(lastSet.lastAt)}: ${fset(lastSet)})` : ''}`}`);
    if (tf !== 'W') {
      const lm = liqMap(S.c, i, tf), br = lm.live.filter((z) => z.vol > z.avg), P0 = S.c[i]!.close;
      const nz = (side: 1 | -1) => br.filter((z) => (side > 0 ? z.bot > P0 : z.top < P0)).sort((a, b) => (side > 0 ? a.bot - b.bot : b.top - a.top)).slice(0, 3).map((z) => `${px(z.bot)}–${px(z.top)} (${at(z.left)}, ${(z.vol / z.avg).toFixed(1)}x avg vol)`).join(', ');
      out.push(` Liquidation HeatMap (BigBeluga): ${lm.live.length} live zones, ${br.length} over average volume · above: ${nz(1) || 'none'} · below: ${nz(-1) || 'none'}`);
    }
    if (S.rt) {
      const n = S.rt.now, bx = Number.isNaN(n.hi[i]!) ? null : { lo: n.lo[i]!, hi: n.hi[i]!, left: n.left[i]! };
      const open = openTargets(S.rt, i).filter((x) => !x.quiet).map((x) => `${x.up ? '▲' : '▼'} ${px(x.px)} (box ${px(x.box.lo)}–${px(x.box.hi)}, broke ${at(x.from)})`);
      out.push(` Range targets (FEELS): ${bx ? `box ${px(bx.lo)}–${px(bx.hi)} from ${at(bx.left)}${n.forming[i] ? ' (forming)' : ''}` : 'no box'} · open targets ${open.join(' · ') || 'none'}`);
    }
  }
  return out;
}

// ---- change alerts ----
export interface CoinEvent { t: number; tf: Tf3; kind: string; key: string; text: string }

/** Every change alert of the bars of the three timeframes that closed after `since` (up to the card's close). */
export function coinEvents(b: CoinBuilt, since: number): CoinEvent[] {
  const out: CoinEvent[] = [], sym = b.card.symbol;
  for (const tf of TFS) {
    const S = b.sets[tf];
    if (!S) continue;
    for (let i = S.last; i >= 1 && S.c[i]!.openTime + S.ms > since; i--) {
      const t = S.c[i]!.openTime + S.ms, P = `${sym} · ${tf}`, bar = S.c[i]!;
      const ev = (kind: string, text: string, extra = '') => out.push({ t, tf, kind, key: `v2|${tf}|${kind}|${t}${extra ? `|${extra}` : ''}`, text });
      const lab = S.vidya.label[i];
      if (lab) ev('vidya', `${lab > 0 ? '📈' : '📉'} ${P} VIDYA trend ${lab > 0 ? 'UP' : 'DOWN'} (${sg(S.vidya.value[i]!)})`);
      const c1 = S.cz.color[i], c0 = S.cz.color[i - 1];
      if (c1 === 'yellow' && c0 != null && c0 !== 'yellow') ev('chop', `🟨 ${P} Chop Zone turned yellow (chop)${tf === '4H' ? ' · hold off on longs' : ''}`);
      if (c0 === 'yellow' && c1 != null && c1 !== 'yellow') ev('chop', `${zoneEmoji(c1)} ${P} Chop Zone left yellow → ${c1}`);
      const h0 = S.hist[i - 1], h1 = S.hist[i], r0 = S.rsi[i - 1], r1 = S.rsi[i];
      if (h0 != null && h1 != null && Math.sign(h0) !== Math.sign(h1) && h1 !== 0) ev('macd', `${h1 > 0 ? '📈' : '📉'} ${P} MACD ${h1 > 0 ? 'bullish' : 'bearish'} cross · RSI ${r1 == null ? '-' : r1.toFixed(1)}`);
      if (r0 != null && r1 != null) {
        if (r0 < 70 && r1 >= 70) ev('rsi', `🌡 ${P} RSI over 70 (${r1.toFixed(1)})`);
        if (r0 >= 70 && r1 < 70) ev('rsi', `🌡 ${P} RSI back under 70 (${r1.toFixed(1)})`);
        if (r0 > 30 && r1 <= 30) ev('rsi', `🌡 ${P} RSI under 30 (${r1.toFixed(1)})`);
        if (r0 <= 30 && r1 > 30) ev('rsi', `🌡 ${P} RSI back over 30 (${r1.toFixed(1)})`);
      }
      for (const z of S.mm) {
        if (z.createdAt === i) ev('mm-new', `${z.dir > 0 ? '🟦' : '🟧'} ${P} new ${z.dir > 0 ? 'bullish' : 'bearish'} order block ${px(z.bot)}–${px(z.top)} (MarketMaulers)`, `${z.left}`);
        if (z.removedAt === i && z.how === 'broken') ev('mm-broken', `⬜ ${P} ${z.dir > 0 ? 'bullish' : 'bearish'} order block ${px(z.bot)}–${px(z.top)} broken (close ${px(bar.close)})`, `${z.left}`);
      }
      for (const k of S.lux) if (k.createdAt === i && tf !== '4H') ev('lux-new', `${k.dir > 0 ? '🟦' : '🟧'} ${P} new ${k.dir > 0 ? 'bullish' : 'bearish'} order block ${px(k.btm)}–${px(k.top)} (LuxAlgo)`, `${k.createdAt}`);
      for (const z of S.htf) {
        if (z.createdAt === i && tf !== '4H') ev('fvg-new', `${z.dir > 0 ? '🟩' : '🟥'} ${P} new ${z.dir > 0 ? 'bullish' : 'bearish'} FVG ${px(z.lo)}–${px(z.hi)}`, `${z.createdAt}`);
        if (z.convertedAt === i && z.ifvgOrd === 1) ev('ifvg', `🔄 ${P} ${z.dir > 0 ? 'bullish' : 'bearish'} FVG ${px(z.lo)}–${px(z.hi)} → ${z.dir > 0 ? 'bearish' : 'bullish'} IFVG (2 closes through)`, `${z.createdAt}`);
      }
      for (const g of S.fo.fvgs) {
        if (!fvgStrong(g) || (g.droppedAt >= 0 && g.droppedAt <= i) || tf === 'W') continue;
        const name = `strong ${g.side > 0 ? 'bullish' : 'bearish'} FVG ${px(g.bottom)}–${px(g.top)}`;
        if (g.createdAt === i) ev('sfvg', `${g.side > 0 ? '🟩' : '🟥'} ${P} new ${name}`, `${g.createdAt}`);
        if (g.touchedAt === i && g.filledAt !== i) ev('sfvg-touch', `📍 ${P} ${name} first touch`, `${g.createdAt}`);
        if (g.filledAt === i) ev('sfvg-fill', `⬜ ${P} ${name} filled`, `${g.createdAt}`);
      }
      if (S.rt) for (const e of S.rt.events) {
        if (e.i !== i || !e.target) continue;
        const x = e.target;
        if (e.kind === 'break') ev('range-break', `📦 ${P} range ${px(x.box.lo)}–${px(x.box.hi)} broken ${x.up ? 'up' : 'down'} (close ${px(bar.close)}) · target ${px(x.px)}`, `${x.from}`);
        if (e.kind === 'reached') ev('range-target', `🎯 ${P} range target ${px(x.px)} reached (from the ${when(S.c[x.from]!.openTime, tf)} breakout)`, `${x.from}`);
        if (e.kind === 'failed') ev('range-fail', `✖️ ${P} range breakout failed: close back ${x.up ? 'under' : 'over'} ${px(x.far)}`, `${x.from}`);
      }
      const lv = S.hmv.level[i]!;
      if (lv === 'high' || lv === 'extra high') ev('vol', `🔥 ${P} ${lv} volume (${sg(S.hmv.z[i]!, 1)}σ over the mean, xdecow) on a ${S.hmv.up[i] ? 'green' : 'red'} candle · close ${px(bar.close)}`);
      for (const d of S.vdiv) if (d.i === i) ev('vol-div', `〽️ ${P} ${d.dir > 0 ? `bullish volume divergence: more volume into a lower low ${px(d.price)}` : `bearish volume divergence: less volume into a higher high ${px(d.price)}`} (${when(S.c[d.at]!.openTime, tf)}, BigBeluga)`, `${d.at}`);
      if (tf !== '4H') for (const x of S.afib.crosses) if (x.i === i) ev('autofib', `📐 ${P} close ${x.up ? 'over' : 'under'} Auto-Fib ${fibPct(x.level)} ${px(x.price)}`, `${x.level}`);
      for (const ch of S.lfib.chochs) if (ch.i === i) ev('choch', `🔁 ${P} ${ch.dir > 0 ? 'bullish' : 'bearish'} CHoCH: close ${ch.dir > 0 ? 'over' : 'under'} ${px(ch.level)} (LuxAlgo structure)`);
      for (const fs of S.lfib.sets) if (fs.createdAt === i) ev('luxfib', `📐 ${P} new ${fs.dir > 0 ? 'bullish' : 'bearish'} Fib retracement ${px(fs.lo)}–${px(fs.hi)} · 0.5 ${px(luxFibPrice(fs, 0.5))} · 0.618 ${px(luxFibPrice(fs, 0.618))} (LuxAlgo)`);
      if (tf === 'D' || tf === '4H') stackAlerts(b.stack, S, i, t, P, ev);
    }
  }
  const rank = { W: 0, D: 1, '4H': 2 } as const;
  return out.sort((a, c) => a.t - c.t || rank[a.tf] - rank[c.tf]);
}

/** The EMA stack alerts (the first cards' rules): daily lines, pair and weekly crosses; 4H trigger crosses with the bias. */
function stackAlerts(st: StackSeries, S: TfSet, i: number, t: number, P: string, ev: (kind: string, text: string, extra?: string) => void): void {
  const a1 = stackAt(st, t), a0 = stackAt(st, t - 1), sym = st.coin;
  if (S.tf === 'D') {
    const line = (x: StackAt['bias'], y: StackAt['bias'], kind: string) => { if (x && y && x.over !== y.over) ev(kind, `${x.over ? '⬆️' : '⬇️'} ${P} daily close ${x.over ? 'over' : 'under'} EMA ${x.n} ${px(x.ema)}${x.n === 26 ? (x.over ? ' · bias long' : sym === 'BTCUSDT' ? ' · flatten (short only with 2 of 3)' : ' · bias flat') : ''}`); };
    line(a1.bias, a0.bias, 'ema-26');
    line(a1.slow, a0.slow, 'ema-slow');
    if (a1.pair && a0.pair && a1.pair.over !== a0.pair.over) ev('ema-pair', `🔀 ${P} EMA ${a1.pair.fast} crossed ${a1.pair.over ? 'over' : 'under'} EMA ${a1.pair.slow}`);
    if (a1.weekly && a0.weekly && a1.weekly.weekOf !== a0.weekly.weekOf) for (const w of a1.weekly.lines) { const p = a0.weekly.lines.find((x) => x.n === w.n); if (p && p.over !== w.over) ev('ema-weekly', `📅 ${P} weekly close ${w.over ? 'over' : 'under'} W${w.n} ${px(w.ema)}`, `${w.n}`); }
    if (sym === 'ETHUSDT' && a1.shortConfirm && !a0.shortConfirm) ev('ema-short', `🔻 ${P} short confirmation on: under EMA 26 with EMA 12 under 26 · ${COIN_CARD.label}`);
    if (sym === 'BTCUSDT' && (a1.shortCheck?.count ?? 0) >= 2 && (a0.shortCheck?.count ?? 0) < 2) ev('ema-short', `🔻 ${P} short check ${a1.shortCheck!.count}/3 → short OK · ${COIN_CARD.label}`);
  } else if (a1.trigger && a0.trigger) {
    const side = biasSide(a1);
    a1.trigger.pairs.forEach((p, n) => {
      const q = a0.trigger!.pairs[n];
      if (!q || p.over === q.over || side === 0 || (p.over ? 1 : -1) !== side) return;
      ev('ema-trigger', `🎯 ${P} EMA ${p.fast}/${p.slow} ${p.over ? 'bull' : 'bear'} cross with the daily bias → arms a limit at ${a1.trigger!.limits.map((l) => `EMA ${l.n} ${px(l.v)}`).join(' / ')} · ${COIN_CARD.label}`, `${p.fast}-${p.slow}`);
    });
  }
  void i;
}
