// The ETH / BTC cards (owner 2026-10-13, cards v2: weekly, daily and 4H reads with an AI read; 2026-10-16, cards v3: "lets
// focus on shifting the eth and btc cards to just give those poi, but lets seek more confluence from other indicators").
// One card per coin at each 4H close: the price, the AI read on the POIs (Claude Sonnet 5.5, written by the worker from
// this card's POI lines), the community traders' levels (worker, Grok) and the POI ladder. Nothing else is shown; the
// change alerts stopped with v3.
//
// POIs (pois() below): every zone or level of every script below, on W / D / 4H (each script on each timeframe's own
// bars, default inputs), short POIs over the price and long POIs under it. Each piece seeds a POI joined by what overlaps
// it (levels within 0.4% of the price, zones within 0.1%; not chained). A POI needs 2+ families and 10+ different
// scripts (owner 2026-10-17; weak ones are never sent), within 4 daily ATR; its range is one script's zone no taller
// than 1 daily ATR (taller zones only count as confluence). Ranked by how many different scripts agree, then scripts x
// timeframes, then families; 3 a side. Order blocks and gaps only on their own side (a bullish one is a long POI, a bearish one a short).
// Families and scripts:
// - OB (order blocks, supply / demand): MarketMaulers OB v1.8 (mmob.ts), Dynamic OB [LuxAlgo] (luxdynob.ts), Smart
//   Money Concepts [LuxAlgo] order blocks (smclux.ts), Order Block Detector [LuxAlgo] and Supply and Demand Zones
//   [BigBeluga] and Visible Range [LuxAlgo] (sdzones.ts), the FVG/OB Detector's strong blocks (fvgob.ts), Volumized
//   Order Blocks [Flux Charts] (fluxob.ts; the zones it shows, not the broken ones).
// - FVG: HTF FVG/IFVG (htffvg.ts), FVG Absorption [LuxAlgo] (fvgabsorb.ts), the FVG/OB Detector's strong FVGs, AlphaX
//   Dynamic Liquidity Matrix (alphaxdlm.ts; its 8 newest gaps not yet filled; its liquidity profile is BigBeluga's with
//   ATR 14, so it is in the chart check only, not counted twice).
// - Liq: Dynamic Liquidity HeatMap Profile, Liquidation HeatMap and Open Liquidity Heatmap [BigBeluga] (liqheat.ts,
//   liqmap.ts, openliq.ts; 4H and daily, the above-average part only), Liquidity Trend Heatmap [BigBeluga] (ltheat.ts;
//   4H and daily, the nodes it draws, 50% of its POC or more, as levels), Liquidity Zones [BigBeluga] (liqzones.ts; 4H
//   and daily, its live lines at the pivot ± ATR(200), as levels), Liquidity Structure & Order Flow [LuxAlgo] (lsof.ts;
//   4H and daily, its 300-bar profile's POC, VAH and VAL as levels), Buyside & Sellside Liquidity [LuxAlgo] (luxbsl.ts;
//   its kept levels not yet swept, W / D / 4H), Dynamic Volume Trace Profile [ChartPrime] (voltrace.ts; 4H and daily,
//   its traces at 50% of the max volume or more, as levels), the SMC script's equal highs / lows not yet taken out (last
//   100 bars).
// - S/R: Dynamic S/R Zones [ChartPrime] (cpsr.ts), Optimus S/R Zones, Smart S/R Zones, Support Resistance Confluence
//   Zones [AxeAlgo] (srzones.ts; strong only, score 60+, D and 4H), Support Resistance Channels [LonesomeTheBlue]
//   (srchannels.ts), Support and Resistance Levels with Breaks [LuxAlgo] (srbreaks.ts), Trend Lines v2
//   [LonesomeTheBlue] (trendlines.ts; each line's value at the close, as a level), Support and Resistance Signals MTF
//   [LuxAlgo] (luxsrsignals.ts; its newest and previous zone a side, not broken), Volume Delta Pivot Matrix [BigBeluga]
//   (vdpm.ts; the unbroken pivot levels it draws, 20%+ delta).
// - Fib: Auto-Fibonacci Levels [ChartWhizzperer], Fibonacci Confluence Toolkit [LuxAlgo] (its live retracement), Strong
//   Fibo Clusters (fibclusters.ts; 4H, strength 4+, the golden pocket and 50%), Fibonacci Entry Zone [OTE] [ath.snipr]
//   (ote.ts; its 50-61.8% zone of the swing since the last CHoCH, W / D / 4H).
// - Levels: Shaakuni's previous week / day high, low and 50% (shaakuni.ts), the coin's EMA stack lines (emastack.ts),
//   the Range Breakout Targets [FEELS] box edges (rangetargets.ts; 4H and daily), the Liquidity Trend Heatmap's trend
//   line (4H and daily), AlphaTrend [KivancOzbilgic] (alphatrend.ts; its line at the close, W / D / 4H), MZ DVAMA
//   [MightyZinger] (dvama.ts; its line, ±2.5 ATR(40) lines and outer zones 4.25..5 ATR(40), W / D / 4H), USDT/USDC
//   Signal v2.0 (usdtsig.ts; its VWAP, blue lines and EMA 80, W / D / 4H), Static + Dynamic Levels (statdyn.ts; the
//   day / week / month / year opens and the ones before, the previous day high / low, the 100 / 200 DMA and WMA), the
//   key levels of Depth of Market (DOM) [LuxAlgo] (luxdom.ts; previous week / day, and the 00:00 / 15:30 UTC period's
//   range, opening range, initial balance, VWAP bands and POC, from the 15m bars).
// Not POI scripts (no price levels), shown in the preview's chart check only: RedK Indicator Amplifier (iamp.ts, RSI 14
// preset), Squeeze Momentum Indicator [LazyBear] (sqzmom.ts), Volume Flow Indicator [LazyBear] (vfi.ts), ADX and DI
// [xdecow] (adxdi.ts), Momentum Ghost Machine [ChartPrime] (mgm.ts), Dynamic Volume RSI [QuantAlgo] (dvrsi.ts), the
// Nasan Momentum Oscillator (nasan.ts).
// Display filter: an order block, gap, S/R channel or LuxAlgo S/R signal zone taller than 3 ATR(14) of its own
// timeframe is left out. Weekly bars
// are the closed Monday weeks built from the daily bars. Display only: nothing here trades. Pure.

import type { Candle } from '@bot/marketdata';
import { macdLines, rsi } from '../indicators';
import { chopZone, zoneEmoji, type ChopColor } from './chopzone';
import { cpSr } from './cpsr';
import { biasSide, stackAt, stackSeries, type StackAt, type StackCoin, type StackSeries } from './emastack';
import { absAt, fvgAbsorb, type AbsGap } from './fvgabsorb';
import { blockActive, fvgActive, fvgOb, fvgStrong, type FvgObSeries } from './fvgob';
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
import { openLiq } from './openliq';
import { ltHeat } from './ltheat';
import { iAmp } from './iamp';
import { liqZones, liqZonesAt } from './liqzones';
import { lsofProfile } from './lsof';
import { sqzMom } from './sqzmom';
import { trendLines } from './trendlines';
import { alphaTrend } from './alphatrend';
import { vfi } from './vfi';
import { fluxObs } from './fluxob';
import { luxSrActive, luxSrSignals } from './luxsrsignals';
import { dvama, dvamaBands } from './dvama';
import { adxDi } from './adxdi';
import { mgm } from './mgm';
import { vdpm } from './vdpm';
import { luxBsl } from './luxbsl';
import { usdtSig } from './usdtsig';
import { staticDynamicLevels } from './statdyn';
import { dlmGaps, dlmProfile } from './alphaxdlm';
import { ote } from './ote';
import { dvrsi } from './dvrsi';
import { nasan } from './nasan';
import { VOLTRACE, volTrace } from './voltrace';
import { domKeyLevels } from './luxdom';
import { volDivergence, type VolDiv } from './voldiv';
import { heatmapVolume, type HmvSeries, type VolLevel } from './volheatmap';
import { fibClusters, FIBCL, type FibSeries } from './fibclusters';
import { orderBlocks, orderBlocksAt, sdVisibleRange, sdZones, zonesAt, type SdZone } from './sdzones';
import { levelsFrom, shaakuniLevelSeries } from './shaakuni';
import { smcLux, smcZonesBefore, type SmcSeries } from './smclux';
import { srBreaks, type SrbSeries } from './srbreaks';
import { srChannels, type SrSeries as ChanSeries } from './srchannels';
import { SRZ, srZones, type SrSeries as AxeSeries } from './srzones';

export type Tf3 = 'W' | 'D' | '4H';
export const TFS: Tf3[] = ['W', 'D', '4H'];
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, WEEK = 7 * DAY;
const MS: Record<Tf3, number> = { W: WEEK, D: DAY, '4H': H4 };
export const COIN_CARD = { label: '⚠️ manage your own risk', maxText: 4096, srTolPct: 0.4, zoneTolPct: 0.1, maxZoneAtr: 3, macdRecent: 6, divRecent: 20, aiModelName: 'Claude Sonnet 5.5', poiMaxAtrD: 4, poiSeedAtrD: 1, poiMinFams: 2, poiMinScripts: 10, poiPerSide: 3, eqBars: 100 } as const;

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
  /** Cards v3: SMC (order blocks, equal highs / lows), BigBeluga S/D, LuxAlgo OB Detector, S/R channels and breaks, AxeAlgo (D / 4H), Fib clusters (4H). */
  smc: SmcSeries; sdz: SdZone[]; lob: SdZone[]; ch: ChanSeries; srb: SrbSeries; axe: AxeSeries | null; fc: FibSeries | null;
}

function tfSet(tf: Tf3, c: Candle[], d1: ReadonlyArray<Candle>): TfSet {
  const close = c.map((b) => b.close), m = macdLines(close);
  return {
    tf, c, ms: MS[tf], last: c.length - 1, atr: taAtr(c, 14),
    vidya: vidyaHeat(c, tf === 'W'), cz: chopZone(c), rsi: rsi(close, 14), hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    mm: mmob(c), lux: luxDynOb(c), htf: htfFvgFor(c, tf), abs: fvgAbsorb(c), fo: fvgOb(c), rt: tf === 'W' ? null : rangeTargets(c),
    hmv: heatmapVolume(c), vdiv: volDivergence(c).divs, afib: autoFib(c), lfib: fibToolkit(c),
    smc: smcLux(c), sdz: sdZones(c), lob: orderBlocks(c), ch: srChannels(c), srb: srBreaks(c),
    axe: tf === 'W' ? null : srZones(c, tf === 'D' ? '1D' : '4H', d1), fc: tf === '4H' ? fibClusters(c) : null,
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

export type Fam = 'OB' | 'FVG' | 'S/R' | 'Fib' | 'Liq' | 'Lvl';
export const FAMS: Fam[] = ['OB', 'FVG', 'Liq', 'S/R', 'Fib', 'Lvl'];
/** The script behind each piece source (one script can give several sources: a POI counts it once). */
export const SCRIPT_OF: Record<string, string> = {
  MM: 'MarketMaulers OB', Lux: 'LuxAlgo Dynamic OB', SMC: 'LuxAlgo SMC', EQ: 'LuxAlgo SMC', OBD: 'LuxAlgo OB Detector', 'S/D': 'BigBeluga S/D', VR: 'LuxAlgo S/D Visible Range',
  IOB: 'FVG/OB Detector', strong: 'FVG/OB Detector', VOB: 'Flux Charts Volumized OB', FVG: 'HTF FVG/IFVG', IFVG: 'HTF FVG/IFVG', abs: 'LuxAlgo FVG Absorption', DLM: 'AlphaX Liquidity Matrix',
  profile: 'BigBeluga Liquidity Profile', 'heat map': 'BigBeluga Liquidation HeatMap', OLH: 'BigBeluga Open Liquidity Heatmap', LTH: 'BigBeluga Liquidity Trend Heatmap', LTT: 'BigBeluga Liquidity Trend Heatmap', LZ: 'BigBeluga Liquidity Zones', LSOF: 'LuxAlgo Liquidity Structure', BSL: 'LuxAlgo Buyside & Sellside Liquidity', VTP: 'ChartPrime Volume Trace Profile',
  CP: 'ChartPrime S/R', Opt: 'Optimus S/R', Smart: 'Smart S/R', Axe: 'AxeAlgo S/R Zones', Chan: 'S/R Channels', Breaks: 'LuxAlgo S/R Breaks', TL: 'LonesomeTheBlue Trend Lines', LSRS: 'LuxAlgo S/R Signals', VDPM: 'BigBeluga Volume Delta Pivots',
  Auto: 'Auto-Fib', LuxFib: 'LuxAlgo Fib Toolkit', Clusters: 'Strong Fibo Clusters', OTE: 'ath.snipr Fibonacci Entry Zone',
  Shaakuni: 'Shaakuni levels', EMA: 'EMA stack', Range: 'FEELS range', AT: 'KivancOzbilgic AlphaTrend', DVAMA: 'MZ DVAMA', USIG: 'USDT/USDC Signal', SDL: 'Static + Dynamic Levels', DOM: 'LuxAlgo DOM key levels',
};
export const SCRIPT_COUNT = new Set(Object.values(SCRIPT_OF)).size;
const scriptOf = (src: string) => SCRIPT_OF[src] ?? src;
/** A POI: a zone (or level) from one script and what overlaps it; side 1 = short (over the price), -1 = long. */
export interface Poi { side: 1 | -1; lo: number; hi: number; parts: { fam: Fam; p: Piece }[]; fams: Fam[]; tfs: Tf3[]; /** Different scripts in it. */ scripts: number; /** Scripts x timeframes in it. */ sources: number }

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
 * `tolLevel`, zones within `tolZone`); seeds are no taller than `maxWidth`. The POIs with the most different scripts
 * (then the most sources, i.e. scripts x timeframes, then the most families, then an order block's or FVG's range before
 * liquidity's and levels', then nearer, then narrower) are taken, skipping one whose zone is already in a taken POI or
 * overlaps it; `minFams` families and `minScripts` scripts at least, `n` a side, nearest first. Pure.
 */
export function pois(all: ReadonlyArray<{ fam: Fam; p: Piece }>, price: number, opts: { tolLevel: number; tolZone: number; maxDist: number; maxWidth: number; minFams: number; minScripts?: number; n: number }): { short: Poi[]; long: Poi[] } {
  const out = { short: [] as Poi[], long: [] as Poi[] };
  for (const side of [1, -1] as const) {
    const dist = (x: { lo: number; hi: number }) => (side > 0 ? x.lo - price : price - x.hi);
    const cand = all.filter((x) => (side > 0 ? x.p.lo > price : x.p.hi < price) && dist(x.p) <= opts.maxDist && (pieceSide(x.fam, x.p) ?? side) === side);
    const near = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => { const t = a.lo === a.hi || b.lo === b.hi ? opts.tolLevel : opts.tolZone; return b.lo <= a.hi + t && b.hi >= a.lo - t; };
    const made = cand.filter((x) => x.p.hi - x.p.lo <= opts.maxWidth).map((seed) => {
      const parts = [seed, ...cand.filter((y) => y !== seed && near(seed.p, y.p))];
      const fams = FAMS.filter((f) => parts.some((x) => x.fam === f)), tfs = TFS.filter((tf) => parts.some((x) => x.p.tf === tf));
      const sources = new Set(parts.map((x) => `${scriptOf(x.p.src)}|${x.p.tf}`)).size, scripts = new Set(parts.map((x) => scriptOf(x.p.src))).size;
      return { side, lo: seed.p.lo, hi: seed.p.hi, parts, fams, tfs, scripts, sources } as Poi;
    }).filter((x) => x.fams.length >= opts.minFams && x.scripts >= (opts.minScripts ?? 0));
    const rank = (z: Poi) => FAMS.indexOf(z.parts[0]!.fam);
    made.sort((a, b) => b.scripts - a.scripts || b.sources - a.sources || b.fams.length - a.fams.length || rank(a) - rank(b) || dist(a) - dist(b) || a.hi - a.lo - (b.hi - b.lo));
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
export interface CoinBuilt { card: CoinCard; sets: Partial<Record<Tf3, TfSet>>; stack: StackSeries; /** Every piece before merging (the chart check). */ pieces: { ob: Piece[]; fvg: Piece[]; sr: Piece[]; fib: Piece[]; liq: Piece[]; lvl: Piece[] } }

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
  for (const tf of TFS) if (raw[tf].length >= 30) sets[tf] = tfSet(tf, raw[tf], d1);
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
    for (const g of dlmGaps(S.c, i).fvgs) fvg.push({ lo: g.bot, hi: g.top, tf, src: 'DLM', note: g.bull ? 'bull' : 'bear' });
    const a = absAt(S.abs, i);
    if (a) {
      const edge = a.g.dir > 0 ? a.g.top - a.absorbed * (a.g.top - a.g.bot) : a.g.bot + a.absorbed * (a.g.top - a.g.bot);
      fvg.push({ lo: a.g.dir > 0 ? a.g.bot : edge, hi: a.g.dir > 0 ? edge : a.g.top, tf, src: 'abs', note: `${Math.round(a.absorbed * 100)}% absorbed`, side: a.g.dir });
    }
    // Cards v3: the other order block and supply / demand scripts.
    for (const z of smcZonesBefore(S.smc, i + 1)) if (z.kind !== 'fvg') ob.push({ lo: z.bottom, hi: z.top, tf, src: 'SMC', note: word(z.bias) });
    for (const z of orderBlocksAt(S.lob, i)) ob.push({ lo: z.bottom, hi: z.top, tf, src: 'OBD', note: z.kind === 'demand' ? 'bull' : 'bear' });
    for (const z of zonesAt(S.sdz, i)) ob.push({ lo: z.bottom, hi: z.top, tf, src: 'S/D', note: z.kind === 'demand' ? 'bull' : 'bear' });
    const vr = sdVisibleRange(S.c, i);
    if (vr.demand) ob.push({ lo: vr.demand.bottom, hi: vr.demand.top, tf, src: 'VR', note: 'bull' });
    if (vr.supply) ob.push({ lo: vr.supply.bottom, hi: vr.supply.top, tf, src: 'VR', note: 'bear' });
    const age = tf === '4H' ? 250 : 150; // the Shaakuni zone lookback, as the first cards aged the detector's blocks
    for (const k of S.fo.blocks) if (k.str.strong && blockActive(k, i) && i - k.obBar <= age) ob.push({ lo: k.bottom, hi: k.top, tf, src: 'IOB', note: word(k.side) });
    for (const z of fluxObs(S.c, i).shown) if (!z.breaker) ob.push({ lo: z.bottom, hi: z.top, tf, src: 'VOB', note: word(z.side) });
    for (const arr of [[ob, ob0], [fvg, fvg0]] as const) for (let k = arr[0].length - 1; k >= arr[1]; k--) if (arr[0][k]!.hi - arr[0][k]!.lo > maxH) arr[0].splice(k, 1);
    const cp = cpSr(S.c, i), cs = cp.support.at(-1), cr = cp.resistance[0];
    if (cs != null) sr.push({ lo: cs, hi: cs, tf, src: 'CP' });
    if (cr != null) sr.push({ lo: cr, hi: cr, tf, src: 'CP' });
    const op = optimusSr(S.c, i, tf);
    for (const l of [...op.support, ...op.resistance]) sr.push({ lo: l.price - op.zone, hi: l.price + op.zone, tf, src: 'Opt', note: `${l.touches} touches` });
    const sm = smartSr(S.c, i, S.ms, other(tf === '4H' ? '1H' : tf === 'D' ? '4H' : 'D'), other(tf === '4H' ? 'D' : tf === 'D' ? 'W' : 'M'));
    for (const s of [sm.support[0], sm.resistance[0]]) if (s) sr.push({ lo: s.level, hi: s.level, tf, src: 'Smart', note: s.tag });
    if (S.axe) for (const z of S.axe.snaps[i] ?? []) if (z.score >= SRZ.strongScore) sr.push({ lo: z.bot, hi: z.top, tf, src: 'Axe', note: `score ${Math.round(z.score)}` });
    for (const x of S.ch.channels[i] ?? []) if (x.hi - x.lo <= maxH) sr.push({ lo: x.lo, hi: x.hi, tf, src: 'Chan', note: `${x.pivots} pivots` });
    for (const v of [S.srb.res[i], S.srb.sup[i]]) if (v != null) sr.push({ lo: v, hi: v, tf, src: 'Breaks' });
    for (const x of vdpm(S.c, i).shown) sr.push({ lo: x.level, hi: x.level, tf, src: 'VDPM', note: `${x.support ? 'support' : 'resistance'} ${Math.round(x.pct)}%` });
    for (const z of luxSrActive(luxSrSignals(S.c, i))) if (z.top - z.bottom <= maxH) sr.push({ lo: z.bottom, hi: z.top, tf, src: 'LSRS', note: z.kind === 'R' ? 'resistance' : 'support' });
    const tl = trendLines(S.c, i);
    for (const l of [...tl.up, ...tl.down]) sr.push({ lo: l.now, hi: l.now, tf, src: 'TL', note: l.side > 0 ? 'up trend line' : 'down trend line' });
    const bsl = luxBsl(S.c, i);
    for (const z of [...bsl.buy, ...bsl.sell]) if (!z.swept) liqP.push({ lo: z.level, hi: z.level, tf, src: 'BSL', note: z.side > 0 ? 'buyside' : 'sellside' });
    // Equal highs / lows (SMC) of the last bars that price has not taken out since: resting liquidity.
    for (const e of S.smc.equal) {
      if (e.t > i || i - e.t > COIN_CARD.eqBars) continue;
      let taken = false;
      for (let k = e.t + 1; k <= i && !taken; k++) taken = e.kind === 'EQH' ? S.c[k]!.high > e.level : S.c[k]!.low < e.level;
      if (!taken) liqP.push({ lo: e.level, hi: e.level, tf, src: 'EQ', note: e.kind });
    }
    const af = autoFibAt(S.afib.sets, i);
    if (af) for (const p of AUTOFIB.levels) { const v = autoFibPrice(af, p); fib.push({ lo: v, hi: v, tf, src: 'Auto', note: fibPct(p) }); }
    for (const fs of luxFibLive(S.lfib.sets, i)) for (const x of LUXFIB.levels) { const v = luxFibPrice(fs, x); fib.push({ lo: v, hi: v, tf, src: 'LuxFib', note: `${x}`, side: fs.dir }); }
    const ot = ote(S.c)[i];
    if (ot && ot.dir !== 0 && Number.isFinite(ot.l50) && Number.isFinite(ot.l618)) fib.push({ lo: Math.min(ot.l50, ot.l618), hi: Math.max(ot.l50, ot.l618), tf, src: 'OTE', note: 'OTE 50–61.8%', side: ot.dir });
    const w = S.fc ? S.fc.weekAt[i]! : -1;
    if (S.fc && w >= 0) for (const z of S.fc.weeks[w]!.zones) if ((z.kind === 'cluster' && z.strength >= FIBCL.strong) || z.kind === 'gp' || z.kind === 'eq') fib.push({ lo: z.bot, hi: z.top, tf, src: 'Clusters', note: z.kind === 'cluster' ? 'Fib cluster' : z.kind === 'gp' ? 'golden pocket' : 'week 50%' });
  }
  // Levels: Shaakuni's previous week / day (from the 4H bars, as the panel shows them at the close), the EMA stack lines
  // and the FEELS range box edges.
  const lvl: Piece[] = [], st = stackAt(stack, t), L = levelsFrom(shaakuniLevelSeries(h4).at(-1), h4.at(-1), t);
  for (const [v, tf, note] of [[L.pwh, 'W', 'PWH'], [L.pwl, 'W', 'PWL'], [L.weq, 'W', 'W-EQ'], [L.pwh2, 'W', 'week-before high'], [L.pwl2, 'W', 'week-before low'], [L.pdh, 'D', 'PDH'], [L.pdl, 'D', 'PDL'], [L.deq, 'D', 'D-EQ']] as const) if (Number.isFinite(v)) lvl.push({ lo: v, hi: v, tf, src: 'Shaakuni', note });
  const ema = (v: number | undefined, tf: Tf3, note: string) => { if (v != null && Number.isFinite(v) && !lvl.some((x) => x.src === 'EMA' && x.tf === tf && x.note === note)) lvl.push({ lo: v, hi: v, tf, src: 'EMA', note }); };
  for (const x of [st.bias, st.slow]) if (x) ema(x.ema, 'D', `EMA ${x.n}`);
  if (st.pair) { ema(st.pair.fastV, 'D', `EMA ${st.pair.fast}`); ema(st.pair.slowV, 'D', `EMA ${st.pair.slow}`); }
  for (const x of st.weekly?.lines ?? []) ema(x.ema, 'W', `W${x.n}`);
  for (const x of st.trigger?.limits ?? []) ema(x.v, '4H', `4H EMA ${x.n}`);
  for (const tf of ['4H', 'D'] as const) {
    const S = sets[tf];
    if (!S?.rt) continue;
    const hi = S.rt.now.hi[S.last]!, lo = S.rt.now.lo[S.last]!;
    if (!Number.isNaN(hi)) { lvl.push({ lo: hi, hi, tf, src: 'Range', note: 'range high' }); lvl.push({ lo, hi: lo, tf, src: 'Range', note: 'range low' }); }
  }
  for (const tf of TFS) {
    const S = sets[tf];
    if (!S) continue;
    const a = alphaTrend(S.c), v = a.at[S.last]!; // 0 = the script's start-up value, not a level
    if (Number.isFinite(v) && v > 0) lvl.push({ lo: v, hi: v, tf, src: 'AT', note: `AlphaTrend (${a.green[S.last] ? 'green' : 'red'})` });
    const us = usdtSig(S.c), k = S.last;
    for (const [v, note] of [[us.vwap[k]!, 'VWAP'], [us.upper[k]!, 'VWAP blue line up'], [us.lower[k]!, 'VWAP blue line down'], [us.ema80[k]!, 'EMA 80']] as const) if (Number.isFinite(v)) lvl.push({ lo: v, hi: v, tf, src: 'USIG', note });
    const dv = dvama(S.c), db = dvamaBands(dv, S.last);
    if (Number.isFinite(db.line) && Number.isFinite(db.upper)) {
      lvl.push({ lo: db.line, hi: db.line, tf, src: 'DVAMA', note: `DVAMA (${dv.color[S.last]})` });
      lvl.push({ lo: db.upper, hi: db.upper, tf, src: 'DVAMA', note: 'DVAMA +2.5 ATR' }, { lo: db.lower, hi: db.lower, tf, src: 'DVAMA', note: 'DVAMA −2.5 ATR' });
      lvl.push({ lo: db.outerTop[0], hi: db.outerTop[1], tf, src: 'DVAMA', note: 'DVAMA outer zone' }, { lo: db.outerBot[0], hi: db.outerBot[1], tf, src: 'DVAMA', note: 'DVAMA outer zone' });
    }
  }
  for (const x of staticDynamicLevels(h4, d1, t).levels) lvl.push({ lo: x.v, hi: x.v, tf: x.tf, src: 'SDL', note: x.note });
  for (const x of domKeyLevels(m, d1, t).levels) lvl.push({ lo: x.v, hi: x.v, tf: x.tf, src: 'DOM', note: x.note });
  const tolSr = (price * COIN_CARD.srTolPct) / 100, tolZ = (price * COIN_CARD.zoneTolPct) / 100;
  const range: CoinCard['range'] = {};
  for (const tf of ['4H', 'D'] as const) {
    const S = sets[tf];
    if (!S) continue;
    const p: LiqProfile = liqHeat(S.c, S.last), P = S.c[S.last]!.close;
    for (const b of p.bins) if (b.vol > p.avg) liqP.push({ lo: b.lo, hi: b.hi, tf, src: 'profile', note: p.max && b.lo === p.max.lo ? 'max' : undefined });
    for (const z of liqMap(S.c, S.last, tf).live) if (z.vol > z.avg) liqP.push({ lo: z.bot, hi: z.top, tf, src: 'heat map', side: z.side });
    for (const z of openLiq(S.c, S.last).zones) liqP.push({ lo: z.lo, hi: z.hi, tf, src: 'OLH', note: z.poc ? 'POC' : undefined });
    const lt = ltHeat(S.c, S.last);
    if (lt) {
      for (const x of lt.shown) liqP.push({ lo: x.level, hi: x.level, tf, src: 'LTH', note: x.poc ? 'POC' : undefined });
      if (Number.isFinite(lt.middle)) lvl.push({ lo: lt.middle, hi: lt.middle, tf, src: 'LTT', note: 'LT trend line' });
    }
    for (const z of liqZonesAt(liqZones(S.c), S.c, S.last)) if (z.grabbedAt == null) liqP.push({ lo: z.level, hi: z.level, tf, src: 'LZ', note: z.side > 0 ? 'over highs' : 'under lows' });
    const vp = lsofProfile(S.c, S.last);
    if (vp) for (const [v, note] of [[vp.poc, 'Lux VP POC'], [vp.vah, 'Lux VAH'], [vp.val, 'Lux VAL']] as const) liqP.push({ lo: v, hi: v, tf, src: 'LSOF', note });
    for (const x of volTrace(S.c, S.last).traces) if (x.pct >= VOLTRACE.cardPct) liqP.push({ lo: x.price, hi: x.price, tf, src: 'VTP', note: x.poc ? 'trace POC' : 'volume trace' });
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
  const fams: { fam: Fam; p: Piece }[] = [...ob.map((p) => ({ fam: 'OB' as Fam, p })), ...fvg.map((p) => ({ fam: 'FVG' as Fam, p })), ...sr.map((p) => ({ fam: 'S/R' as Fam, p })), ...fib.map((p) => ({ fam: 'Fib' as Fam, p })), ...liqP.map((p) => ({ fam: 'Liq' as Fam, p })), ...lvl.map((p) => ({ fam: 'Lvl' as Fam, p }))];
  const maxWidth = Number.isNaN(atrD) ? price * 0.03 : COIN_CARD.poiSeedAtrD * atrD;
  const poi = { ...pois(fams, price, { tolLevel: tolSr, tolZone: tolZ, maxDist, maxWidth, minFams: COIN_CARD.poiMinFams, minScripts: COIN_CARD.poiMinScripts, n: COIN_CARD.poiPerSide }), maxDist };
  const card: CoinCard = {
    symbol: inp.symbol, at: t, price, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    stack: st, tf: tfv, weeklyDevLen: sets.W?.vidya.devLen ?? 0,
    ob: nearestGroups(ob, price, tolZ, false), fvg: nearestGroups(fvg, price, tolZ, false), sr: nearestGroups(sr, price, tolSr), srSources: 3,
    fib: nearestGroups(fib, price, tolSr), liq: nearestGroups(liqP, price, tolZ, false), divs, range, poi,
  };
  return { card, sets, stack, pieces: { ob, fvg, sr, fib, liq: liqP, lvl } };
}

// ---- text ----
const pct = (x: number, price: number) => `${x >= price ? '+' : '−'}${Math.abs((x / price - 1) * 100).toFixed(1)}%`;
const FAM_LABEL: Record<Fam, string> = { OB: 'OB', FVG: 'FVG', Liq: 'Liq', 'S/R': 'S/R', Fib: 'Fib', Lvl: 'Levels' };
/** A piece's name on the card: the script's short name, or the level itself for the level scripts. */
const SHORT: Record<string, string> = {
  MM: 'MarketMaulers', Lux: 'Lux OB', SMC: 'SMC OB', OBD: 'Lux OB detector', 'S/D': 'BigBeluga S/D', VR: 'Lux S/D', IOB: 'IOB block', VOB: 'Flux OB',
  FVG: 'HTF FVG/IFVG', IFVG: 'HTF FVG/IFVG', strong: 'strong FVG', abs: 'Lux absorption', DLM: 'AlphaX FVG', profile: 'liq profile', 'heat map': 'liq heat map', OLH: 'open liq heat map', LTH: 'LT heatmap', LZ: 'liquidity zone', BSL: 'Lux buy/sell-side liq', VTP: 'volume trace',
  CP: 'ChartPrime', Opt: 'Optimus', Smart: 'Smart S/R', Axe: 'AxeAlgo', Chan: 'S/R channel', Breaks: 'S/R breaks', LSRS: 'Lux S/R signals', VDPM: 'delta pivot', Auto: 'Auto-Fib', LuxFib: 'Lux Fib', OTE: 'OTE zone',
};
const nameOf = (p: Piece) => SHORT[p.src] ?? p.note ?? p.src;
/** "OB D+4H: MarketMaulers, SMC OB · Levels W: PWH": the POI's pieces by family, with their timeframes and names. */
const poiParts = (z: Poi) => z.fams.map((f) => {
  const xs = z.parts.filter((x) => x.fam === f).map((x) => x.p);
  return `${FAM_LABEL[f]} ${TFS.filter((tf) => xs.some((p) => p.tf === tf)).join('+')}: ${[...new Set(xs.map(nameOf))].join(', ')}`;
}).join(' · ');
/** Levels from outside the scripts (the worker's followed X traders): a short tag such as "CT#1" and its prices. */
export interface LevelMark { tag: string; levels: number[] }
/** The POI ladder: short POIs over the price (farthest first), the price, long POIs under it (nearest first). Each POI
 * has its range, distance and number of scripts, then the scripts by family; a mark's level in it (or within the S/R
 * tolerance) tags it. */
export function poiLines(card: CoinCard, marks: ReadonlyArray<LevelMark> = []): string[] {
  const tol = (card.price * COIN_CARD.srTolPct) / 100;
  const tags = (z: Poi) => marks.filter((m) => m.levels.some((l) => l >= z.lo - tol && l <= z.hi + tol)).map((m) => ` · 👤 ${m.tag}`).join('');
  const row = (z: Poi) => [
    ` ${z.side > 0 ? '🔴 short' : '🟢 long'} <b>${z.lo === z.hi ? px(z.lo) : `${px(z.lo)}–${px(z.hi)}`}</b> (${pct(z.side > 0 ? z.lo : z.hi, card.price)}) · ${z.scripts} scripts · ${z.tfs.join('+')}${tags(z)}`,
    `    ${esc(poiParts(z))}`,
  ];
  const none = (w: string) => [` ${w}: none with ${COIN_CARD.poiMinScripts}+ scripts within ${pct(card.price + card.poi.maxDist, card.price).slice(1)}`];
  return [
    `<b>POIs</b> (${SCRIPT_COUNT} scripts · W / D / 4H · ${COIN_CARD.label})`,
    ...(card.poi.short.length ? [...card.poi.short].reverse().flatMap(row) : none('🔴 short')),
    ` ── price ${px(card.price)}`,
    ...(card.poi.long.length ? card.poi.long.flatMap(row) : none('🟢 long')),
  ];
}

/** The card's body (no intro, no AI read): the POI ladder, which the AI read is written from. */
export const cardBody = poiLines;

/** A section from outside the card's own scripts (the worker's community traders, via Grok): a title and plain-text lines. */
export interface CardNote { title: string; lines: string[] }

/**
 * The card as Telegram HTML: the price, the AI read (plain text) if any, `note` (escaped here) and the POI ladder; one
 * message (two if over 4,096 characters).
 */
export function coinCardText(card: CoinCard, ai: string | null, note: CardNote | null = null, marks: ReadonlyArray<LevelMark> = []): string[] {
  const head = [
    `📊 <b>${card.symbol}</b> · POIs · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})`,
  ];
  if (ai) head.push('', `🤖 <b>AI read</b> (${COIN_CARD.aiModelName} · not advice)`, ` ${esc(ai)}`);
  if (note?.lines.length) head.push('', `🗞 <b>${esc(note.title)}</b>`, ...note.lines.map((l) => ` ${esc(l)}`));
  const body = poiLines(card, marks), all = [...head, '', ...body].join('\n');
  if (all.length <= COIN_CARD.maxText) return [all];
  return [head.join('\n'), [`📊 <b>${card.symbol}</b> · POIs (2/2) · ${utc(card.at)}`, ...body].join('\n')];
}

/** What the AI read is written from: the price line and the POI ladder as plain text, then the note. */
export function aiInput(card: CoinCard, note: CardNote | null = null, marks: ReadonlyArray<LevelMark> = []): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const ext = note?.lines.length ? [`${note.title} (unverified, from X posts, not from the card's scripts):`, ...note.lines.map((l) => ` ${l}`)] : [];
  return [`${card.symbol} at the ${utc(card.at)} close. Price ${px(card.price)}, 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`}.`, ...poiLines(card, marks).map(strip), ...ext].join('\n');
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
    const amp = iAmp(S.c), lastOf = (xs: boolean[]) => { let k = i; while (k >= 0 && !xs[k]) k--; return at(k); };
    const lit = amp.up[i]! > 0 ? `▲ ${amp.up[i]}` : amp.dn[i]! > 0 ? `▼ ${amp.dn[i]}` : '0', peaks = [amp.upPeak[i]! > amp.up[i]! ? `up ${amp.upPeak[i]}` : '', amp.dnPeak[i]! > amp.dn[i]! ? `down ${amp.dnPeak[i]}` : ''].filter(Boolean);
    const sq = sqzMom(S.c), sv = sq.val[i]!, sinceOf = (ok: (k: number) => boolean) => { let k = i; while (k >= 0 && !ok(k)) k--; return at(k); };
    let s0 = i;
    while (s0 > 0 && sq.state[s0 - 1] === sq.state[i]) s0--;
    out.push(` Squeeze Momentum (LazyBear): momentum ${Number.isNaN(sv) ? '-' : `${sv > 0 ? '+' : ''}${px(sv)} ${sq.color[i]}`} · squeeze ${sq.state[i] === 'on' ? 'on (black cross)' : sq.state[i] === 'off' ? 'off (gray cross)' : 'none (blue cross)'} since ${at(s0)} · last squeeze release ${sinceOf((k) => k > 0 && sq.state[k - 1] === 'on' && sq.state[k] !== 'on')} · last zero cross up ${sinceOf((k) => k > 0 && sq.val[k]! > 0 && sq.val[k - 1]! <= 0)}, down ${sinceOf((k) => k > 0 && sq.val[k]! < 0 && sq.val[k - 1]! >= 0)}`);
    const vf = vfi(S.c), crossAt = (a: number[], b: (k: number) => number, upward: boolean) => sinceOf((k) => k > 0 && (upward ? a[k]! > b(k) && a[k - 1]! <= b(k - 1) : a[k]! < b(k) && a[k - 1]! >= b(k - 1)));
    out.push(` Volume Flow (LazyBear VFI 130): ${Number.isNaN(vf.vfi[i]!) ? 'not enough bars' : `VFI ${vf.vfi[i]!.toFixed(2)} · signal EMA 5 ${vf.signal[i]!.toFixed(2)} (VFI ${vf.vfi[i]! >= vf.signal[i]! ? 'over' : 'under'} it) · last zero cross up ${crossAt(vf.vfi, () => 0, true)}, down ${crossAt(vf.vfi, () => 0, false)} · last cross over the signal ${crossAt(vf.vfi, (k) => vf.signal[k]!, true)}, under ${crossAt(vf.vfi, (k) => vf.signal[k]!, false)}`}`);
    const ad = adxDi(S.c);
    let a0 = i;
    while (a0 > 0 && ad.trend[a0 - 1] === ad.trend[i]) a0--;
    out.push(` ADX and DI (xdecow 8 / 8): ADX ${ad.adx[i]!.toFixed(1)} ${ad.rising[i] ? 'rising' : 'not rising'} · +DI ${ad.plus[i]!.toFixed(1)} · −DI ${ad.minus[i]!.toFixed(1)} · ${ad.trend[i] === 1 ? 'uptrend' : ad.trend[i] === -1 ? 'downtrend' : 'no trend (ADX 25 or under)'} since ${at(a0)}`);
    const mg = mgm(S.c), mgX = (up: boolean) => sinceOf((k) => k > 0 && (up ? mg.momo[k]! > 0 && mg.momo[k - 1]! <= 0 : mg.momo[k]! < 0 && mg.momo[k - 1]! >= 0)), f3 = (x: number) => (Number.isNaN(x) ? '-' : x.toPrecision(4));
    out.push(` Momentum Ghost Machine (ChartPrime): momentum ${f3(mg.delta[i]!)} · MA ${f3(mg.ma[i]!)} · histogram ${f3(mg.momo[i]!)} ${mg.color[i]} · ghost next bars ${f3(mg.ghost1[i]!)}, ${f3(mg.ghost2[i]!)} · last histogram cross up ${mgX(true)}, down ${mgX(false)}`);
    const dv2 = dvrsi(S.c);
    let kd = i;
    while (kd > 0 && dv2.trend[kd - 1] === dv2.trend[i]) kd--;
    out.push(` Dynamic Volume RSI (QuantAlgo DVRSI 14): ${Number.isNaN(dv2.value[i]!) ? '-' : dv2.value[i]!.toFixed(2)}${dv2.trend[i] ? `, ${dv2.trend[i]! > 0 ? 'bullish (over 50)' : 'bearish (under 50)'} since ${at(kd)}` : ''} · last over 50 ${lastOf(dv2.bullShift)}, under 50 ${lastOf(dv2.bearShift)} · last under 60 (potential overbought) ${lastOf(dv2.overbought)} · last over 40 (potential oversold) ${lastOf(dv2.oversold)}`);
    const nm = nasan(S.c), zf = (x: number) => (Number.isNaN(x) ? '-' : sg(x)), zi = nm.z[i]!;
    out.push(` Nasan Momentum Oscillator (z-score over 500 bars): ${Number.isNaN(zi) ? 'needs 500+ bars of its average (not on this timeframe here)' : `z ${zf(zi)} (${zi > 1.5 ? 'overbought zone, over 1.5' : zi < -1.5 ? 'oversold zone, under −1.5' : zi > 0 ? 'green, over 0' : zi < 0 ? 'red, under 0' : 'at 0'}) · smoothed (HMA 5) ${zf(nm.smooth[i]!)} · dynamic length ${nm.dl[i]} · last 0 cross up ${lastOf(nm.up0)}, down ${lastOf(nm.down0)} · last into over 1.5 ${lastOf(nm.intoOb)}, under −1.5 ${lastOf(nm.intoOs)}`}`);
    out.push(` RedK i-Amp (RSI 14 preset): ${lit} of ${amp.bands} blocks${peaks.length ? ` (peak hold ${peaks.join(', ')})` : ''}, RSI ${Number.isNaN(amp.osc[i]!) ? '-' : amp.osc[i]!.toFixed(2)} · last flip up ${lastOf(amp.flipUp)}, down ${lastOf(amp.flipDn)} · last cross over ${amp.maxHi} ${lastOf(amp.hiCross)}, under ${amp.maxLo} ${lastOf(amp.loCross)}`);
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
    const ot = ote(S.c)[i]!;
    out.push(` Fibonacci Entry Zone [OTE] (ath.snipr; structure 10): ${ot.dir === 0 ? 'no CHoCH yet' : `${ot.dir > 0 ? 'bullish' : 'bearish'} CHoCH ${at(ot.chochAt)} through ${px(ot.chochLevel)} · swing low ${px(ot.lo)} (${at(ot.loAt)}) / high ${px(ot.hi)} (${at(ot.hiAt)}) · 50% ${px(ot.l50)} · 61.8% ${px(ot.l618)} · structure count ${ot.pos}`}`);
    out.push(` Fib Confluence Toolkit (LuxAlgo): last CHoCH ${lastCh ? `${lastCh.dir > 0 ? 'bullish' : 'bearish'} ${at(lastCh.i)} through ${px(lastCh.level)}` : 'none'} · live retracement: ${live.map(fset).join(' | ') || `none${lastSet ? ` (last one ended ${at(lastSet.lastAt)}: ${fset(lastSet)})` : ''}`}`);
    if (tf !== 'W') {
      const lm = liqMap(S.c, i, tf), br = lm.live.filter((z) => z.vol > z.avg), P0 = S.c[i]!.close;
      const nz = (side: 1 | -1) => br.filter((z) => (side > 0 ? z.bot > P0 : z.top < P0)).sort((a, b) => (side > 0 ? a.bot - b.bot : b.top - a.top)).slice(0, 3).map((z) => `${px(z.bot)}–${px(z.top)} (${at(z.left)}, ${(z.vol / z.avg).toFixed(1)}x avg vol)`).join(', ');
      out.push(` Liquidation HeatMap (BigBeluga): ${lm.live.length} live zones, ${br.length} over average volume · above: ${nz(1) || 'none'} · below: ${nz(-1) || 'none'}`);
    }
    const tl = trendLines(S.c, i), tline = (l: (typeof tl.up)[number]) => `${l.side > 0 ? 'up' : 'down'} from ${at(l.from.at)} ${px(l.from.v)} through ${at(l.through.at)} ${px(l.through.v)}, now ${px(l.now)} (${l.slope > 0 ? '+' : '−'}${px(Math.abs(l.slope))} a bar)`;
    out.push(` Trend Lines v2 (LonesomeTheBlue): ${[...tl.up, ...tl.down].map(tline).join(' · ') || 'none'}`);
    const vfmt = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(2)}K` : x.toFixed(2));
    const fx = fluxObs(S.c, i).shown.sort((a, b) => b.top - a.top).map((z) => `${z.side > 0 ? 'bull' : 'bear'} ${px(z.bottom)}–${px(z.top)} from ${at(z.startAt)} · ${vfmt(z.vol)} (${Math.trunc((Math.min(z.highVol, z.lowVol) / Math.max(z.highVol, z.lowVol)) * 100)}%)${z.combined ? ' combined' : ''}${z.breaker ? ` · broken ${when(z.breakTime!, tf)} (historic, off the card)` : ''}${wide(z.bottom, z.top)}`);
    out.push(` Volumized Order Blocks (Flux Charts; 3 a side, last 1750 bars): ${fx.join(' · ') || 'none'}`);
    const ls = luxSrSignals(S.c, i), lzone = (z: (typeof ls.R)[number], k: number) => `${z.kind === 'R' ? 'resistance' : 'support'} ${k + 1} ${px(z.bottom)}–${px(z.top)} from ${at(z.left)}${z.from === 'flip' ? ' (flipped)' : ''}${z.b ? ' broken' : z.r ? ' retested' : z.t ? ' tested' : ''}${wide(z.bottom, z.top)}`;
    const lev = ls.events.slice(-4).reverse().map((e) => `${e.kind === 'breakout' ? (e.dir > 0 ? '▲B' : 'B▼') : e.kind === 'test' ? 'T' : e.kind === 'retest' ? 'R' : 'rejection'} ${e.dir > 0 ? 'bull' : 'bear'} ${at(e.i)}`);
    const vd = vdpm(S.c, i), vfm = (x: number) => { const a = Math.abs(x), sgn = x < 0 ? '−' : '+'; return a >= 1e6 ? `${sgn}${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${sgn}${(a / 1e3).toFixed(2)}K` : `${sgn}${a.toFixed(2)}`; };
    const bl = luxBsl(S.c, i), blt = (z: (typeof bl.buy)[number]) => `${z.side > 0 ? 'buyside' : 'sellside'} ${px(z.level)} (from ${at(z.left)}, box ${px(z.bottom)}–${px(z.top)})${z.swept ? ` swept ${at(z.sweptAt!)}${z.zone ? `, zone ${px(z.zone.lo)}–${px(z.zone.hi)}` : ''}` : ' live'}`;
    out.push(` Buyside & Sellside Liquidity (LuxAlgo; 3 a side): ${[...bl.buy, ...bl.sell].map(blt).join(' · ') || 'none'}`);
    out.push(` Volume Delta Pivot Matrix (BigBeluga; 10 newest, 20%+): ${vd.shown.map((x) => `${x.support ? 'S' : 'R'} ${px(x.level)} (pivot ${at(x.at)}, ∆ ${vfm(x.delta)}, ${x.pct.toFixed(0)}%)`).join(' · ') || 'none'}`);
    out.push(` LuxAlgo S/R Signals (length 15): ${[...ls.R.slice(0, 2).map((z, k) => [z, k] as const), ...ls.S.slice(0, 2).map((z, k) => [z, k] as const)].filter(([z]) => !z.empty).map(([z, k]) => lzone(z, k)).join(' · ') || 'none'} · last signals: ${lev.join(', ') || 'none'}`);
    const al = alphaTrend(S.c), lastLab = (xs: boolean[]) => { let k = i; while (k >= 0 && !xs[k]) k--; return k < 0 ? '-' : `${at(k)} (at ${px(al.at[k - 2]! * (xs === al.buyLabel ? 0.9999 : 1.0001))})`; };
    const dv = dvama(S.c), db = dvamaBands(dv, i), dLast = (xs: boolean[]) => { let k = i; while (k >= 0 && !xs[k]) k--; return at(k); };
    const ug = usdtSig(S.c);
    out.push(` USDT/USDC Signal v2.0 (VWAP part): VWAP ${px(ug.vwap[i]!)} · blue lines ${px(ug.lower[i]!)} / ${px(ug.upper[i]!)} · EMA 80 ${px(ug.ema80[i]!)}`);
    out.push(` MZ DVAMA (MightyZinger): line ${px(db.line)} ${dv.color[i]} (slope ${dv.slope[i]}°, slow length ${Math.trunc(dv.slow[i]!)}, RVSI ${dv.rvsi[i]!.toFixed(1)}) · ±2.5 ATR ${px(db.lower)} / ${px(db.upper)} · outer zones ${px(db.outerBot[0])}–${px(db.outerBot[1])} / ${px(db.outerTop[0])}–${px(db.outerTop[1])} · last Long ${dLast(dv.long)}, last Short ${dLast(dv.short)}`);
    const dg = dlmGaps(S.c, i);
    out.push(` AlphaX Dynamic Liquidity Matrix FVGs (8 newest unfilled, 0.1 ATR(14)+): ${[...dg.fvgs].reverse().map((g) => `${g.bull ? '▲' : '▼'} ${px(g.bot)}–${px(g.top)} (box from ${at(g.start - 1)})${wide(g.bot, g.top)}`).join(' · ') || 'none'} · last sweeps: low ${dLast(dg.bullSweep)}, high ${dLast(dg.bearSweep)}`);
    out.push(` AlphaTrend (KivancOzbilgic): line ${px(al.at[i]!)} (2 bars back ${px(al.at[i - 2]!)}), ${al.green[i] ? 'green' : 'red'} · last BUY label ${lastLab(al.buyLabel)} · last SELL label ${lastLab(al.sellLabel)}`);
    if (tf !== 'W') {
      const lz = liqZonesAt(liqZones(S.c), S.c, i).reverse().map((z) => `${z.side > 0 ? '▲' : '▼'} line ${px(z.level)} (pivot ${z.side > 0 ? 'high' : 'low'} ${px(z.edge)} at ${at(z.pivotAt)}) ${z.grabbedAt == null ? 'live' : `grabbed ${at(z.grabbedAt)}`}`);
      const dp = dlmProfile(S.c, i), bb = liqHeat(S.c, i), rng = (b: { lo: number; hi: number } | null) => (b ? `${px(b.lo)}–${px(b.hi)}` : '-');
      const nv = dp.nVol > 80 ? 'very high' : dp.nVol > 60 ? 'high' : dp.nVol > 40 ? 'normal' : dp.nVol > 20 ? 'low' : 'very low', pos = dp.pricePos > 70 ? 'upper zone' : dp.pricePos < 30 ? 'lower zone' : 'mid-range';
      out.push(` AlphaX Dynamic Liquidity Matrix profile (300 bars, 50 bins; not on the card): POC ${rng(dp.poc)} (BigBeluga profile max ${rng(bb.max)}) · biggest bins ${[...dp.bins].sort((x, y) => y.vol - x.vol).slice(0, 4).map((b) => `${rng(b)} ${b.pct.toFixed(0)}%`).join(', ') || 'none'} · live levels buy ${dp.buyPivots} / sell ${dp.sellPivots} (${dp.bias}) · norm. volume ${dp.nVol.toFixed(0)}% (${nv}) · price in range ${dp.pricePos.toFixed(0)}% (${pos})`);
      const vt = volTrace(S.c, i), vtx = (x: (typeof vt.traces)[number]) => `${px(x.price)} ${x.pct.toFixed(0)}%`;
      out.push(` ChartPrime Dynamic Volume Trace Profile (200 bars; traces over the 100-bar range ${px(vt.lo)}–${px(vt.hi)}, step ${px(vt.step)}): POC ${vt.traces.filter((x) => x.poc).map((x) => px(x.price)).join(', ') || '-'} · traces at 50%+ (on the card): ${vt.traces.filter((x) => x.pct >= VOLTRACE.cardPct).map(vtx).join(' · ') || 'none'}`);
      out.push(` BigBeluga Liquidity Zones (the ${lz.length} on the chart, newest first): ${lz.join(' · ') || 'none'}`);
      const vp = lsofProfile(S.c, i), vf = (x: number) => { const a = Math.abs(x), sgn = x < 0 ? '−' : ''; return a >= 1e9 ? `${sgn}${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${sgn}${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${sgn}${(a / 1e3).toFixed(2)}K` : `${sgn}${a.toFixed(2)}`; };
      out.push(` LuxAlgo Liquidity Structure & Order Flow (${vp ? `300 bars, range ${px(vp.lows)}–${px(vp.highs)}): POC ${px(vp.poc)} (${vp.distToPoc.toFixed(2)}% away) · VA ${px(vp.val)}–${px(vp.vah)} · mid ${px(vp.mid)} · widest void ${px(vp.void.lo)}–${px(vp.void.hi)} · upper mass ${vp.upperPct.toFixed(2)}% / lower ${vp.lowerPct.toFixed(2)}% (skew ${vp.skew.toFixed(2)}x) · agg. delta ${vf(vp.delta)} · range loc. ${vp.rangeLoc.toFixed(2)}% · unusual volume bars, last 3: ${vp.bubbles.slice(-3).reverse().map((x) => `${at(x.i)} (z ${x.z.toFixed(1)}, ${x.bull ? 'up' : 'down'} close)`).join(', ') || 'none'}` : 'under 300 bars): none'}`);
    }
    if (S.rt) {
      const n = S.rt.now, bx = Number.isNaN(n.hi[i]!) ? null : { lo: n.lo[i]!, hi: n.hi[i]!, left: n.left[i]! };
      const open = openTargets(S.rt, i).filter((x) => !x.quiet).map((x) => `${x.up ? '▲' : '▼'} ${px(x.px)} (box ${px(x.box.lo)}–${px(x.box.hi)}, broke ${at(x.from)})`);
      out.push(` Range targets (FEELS): ${bx ? `box ${px(bx.lo)}–${px(bx.hi)} from ${at(bx.left)}${n.forming[i] ? ' (forming)' : ''}` : 'no box'} · open targets ${open.join(' · ') || 'none'}`);
    }
    // Cards v3 scripts: what each gives the POIs on this timeframe (nearest the close first; tall zones already left out).
    const all = [...b.pieces.ob, ...b.pieces.sr, ...b.pieces.fib, ...b.pieces.liq];
    for (const [src, label] of [['SMC', 'LuxAlgo SMC order blocks'], ['EQ', 'LuxAlgo SMC equal highs / lows (not taken out)'], ['OBD', 'LuxAlgo Order Block Detector'], ['S/D', 'BigBeluga Supply and Demand'], ['VR', 'LuxAlgo S/D Visible Range (150 bars)'], ['IOB', 'FVG/OB Detector strong blocks'], ['Axe', 'AxeAlgo S/R Confluence Zones (score 60+)'], ['Chan', 'S/R Channels (LonesomeTheBlue)'], ['Breaks', 'LuxAlgo S/R Levels with Breaks'], ['Clusters', 'Strong Fibo Clusters (this week)'], ['OLH', 'BigBeluga Open Liquidity Heatmap (bright bands)'], ['LTH', 'BigBeluga Liquidity Trend Heatmap (nodes from 50% of the POC)']] as const) {
      if ((src === 'Axe' && tf === 'W') || (src === 'Clusters' && tf !== '4H') || ((src === 'OLH' || src === 'LTH') && tf === 'W')) continue;
      const xs = near(all.filter((x) => x.tf === tf && x.src === src), (x) => (x.lo + x.hi) / 2);
      out.push(` ${label}: ${xs.map((x) => `${x.note ? `${x.note} ` : ''}${x.lo === x.hi ? px(x.lo) : `${px(x.lo)}–${px(x.hi)}`}`).join(' · ') || 'none'}`);
    }
  }
  const lv = b.pieces.lvl;
  out.push('', `--- Levels (at the card's close) ---`, ...['Shaakuni', 'EMA', 'Range', 'LTT', 'SDL', 'DOM'].map((src) => ` ${src === 'Shaakuni' ? 'Shaakuni (previous week / day)' : src === 'EMA' ? 'EMA stack' : src === 'Range' ? 'FEELS range box' : src === 'SDL' ? 'Static + Dynamic Levels (opens, PDH / PDL, MAs live)' : src === 'DOM' ? 'LuxAlgo DOM key levels (15m; the period since 00:00 / 15:30 UTC)' : 'Liquidity Trend Heatmap trend line'}: ${lv.filter((x) => x.src === src).map((x) => `${x.tf} ${x.note} ${px(x.lo)}`).join(' · ') || 'none'}`));
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
