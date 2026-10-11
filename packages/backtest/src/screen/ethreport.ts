// The ETH card (owner 2026-10-11): indicator info and prices for ETHUSDT on 4H and 1D, built from the owner's templates
// (Shaakuni levels / order blocks, Wyckoff with its higher-timeframe override, Trend Target Ribbon, Trinity Reversal,
// the KAMA signal with the 4H chop filter, Swing Fibonacci Arcs as price alerts), RSI 14 / MACD 12/26/9 and the
// Choppiness Index, with weak zones filtered out (zonestrength.ts). Display only: nothing here places or changes
// orders. The card goes out at each 4H close and the change alerts at the close they happen on (the worker's
// ethReport.ts); everything is computed from closed bars, so each value only uses data known at its bar.
//
// Round 2 (owner 2026-10-11, after the chart check): the entry ideas left the card ("Kama giving entry and chop filters
// keeping out false signals"; entryideas.ts stays as a research record), the small print went, and the Fib arcs left
// the card for price alerts. The KAMA signal (kama.ts):
// - A cross while the 4H CHOP 14 reads chop (>= 61.8) is held off, buys and sells (fading / trending / neutral pass);
//   the 1D signal uses the 4H bar closed at the daily close. A held-off cross is never alerted as a signal; it still
//   ends the open one (exits are not filtered).
// - Notes, not gates: the 2 nearest supports (resistances for a sell) among the shown levels (the week before
//   included), the shown zones of both timeframes and the active strong Trinity levels, with the next level on the
//   other side; and a fixed confluence list: both ribbons, MACD histogram side, RSI side of 50, a zone / strong Trinity
//   level of the signal's side within 1 ATR, and Wyckoff's structure direction while its line is kept.
// - Record: each taken signal held to the next opposite cross, 0.22% round trip, from the 4H history's warm-up on.
//
// Round 4 (owner 2026-10-11): the chop filter is TradingView's Chop Zone (chopzone.ts) and holds off BUYS only ("for no
// longs but it doesn't stop shorts"): a KAMA buy while the 4H Chop Zone is yellow is held off, sells always go through.
// The card builds for any coin (CardInput.symbol: ETHUSDT or BTCUSDT); each coin shows its own EMA stack (emastack.ts).
// The ETH card's confluence list gains "BTC ribbon (on watch)" (found in-sample in round 3).
// Round 4 templates (owner: "card + alerts + test each"; strong items only, the owner's cutoffs): S/R Confluence Zones
// (srzones.ts, score 60+), the FVG / OB Detector (fvgob.ts, private use only; strong FVGs, and its strong order blocks
// merged into the order-block line, shown once when they double a Shaakuni block), Strong Fibo Clusters
// (fibclusters.ts, 4H, strength 4+) and Range Breakout Targets (rangetargets.ts). Their items join the KAMA notes'
// support / resistance list only; the confluence factor keeps its round 2 definition so the KAMA record stays
// comparable. Each event's record is in templateReport (information, nothing tuned).
// Owner, after the round 4 preview ("remove Trinity's reverse and fib cluster to declutter the card"): the Trinity
// reversal and Fib cluster sections leave the card with their alerts and their KAMA-note entries (ON_CARD). Strong
// Trinity levels so no longer count toward the "support / resistance zone" confluence factor (Shaakuni blocks only).
// trinity.ts and fibclusters.ts stay as research records.
// Owner, next ("form separate cards for each", by timeframe): one card per timeframe and coin, the 4H card at each 4H
// close and the 1D card at the daily close, each with its own timeframe's lines (ethCardText(card, tf)).
// Owner, next: DiNapoli Levels Confluence Targets [MarkitTick] (dinapoli.ts, "offering entries for 1 day 4hr and 1 hr"):
// the 4H card shows the latest 4H setup, the 1D card the latest 1D setup, each with its record; alerts for a new setup,
// COP / OP / XOP reached and the stop hit. Labelled "manage your own risk". 1H (owner: "only send the 1 hr out on
// freshly presented setups"): only the new-setup alert at the 1H close it appears on; no 1H card line, no 1H target or
// stop alerts.
// Pure.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi } from '../indicators';
import { chopIndex } from './chop';
import { chopZone, zoneEmoji, zoneGroup, type ChopColor } from './chopzone';
import { biasSide, stackAt, stackSeries, type StackAt, type StackCoin, type StackSeries } from './emastack';
import { fibArcHits, fibArcs, fibStates, type FibArcHit, type FibArcs, type FibSwingFlip } from './fibarcs';
import { KAMA, kama4h, kamaCrosses, kamaDaily, kamaRecord, kamaStats, type KamaCross, type KamaLine, type KamaStats, type KamaTrade } from './kama';
import { macdState } from './macdstate';
import { OUTLOOK, OUTLOOK_METRICS, outlookAgree, outlookAt, outlookSeries, pctRank, volSeries, type OutlookAt, type OutlookMetric, type OutlookSeries } from './outlook';
import { coinVolume } from './pine';
import { fibClusters, FIBCL, liveMagnets, stateWord, type FibSeries, type FibZone, type Magnet } from './fibclusters';
import { blockActive, fvgActive, fvgFirstTouch, fvgOb, fvgStrong, overlapShare, type DetBlock, type Fvg, type FvgObSeries } from './fvgob';
import { openTargets, rangeTargets, targetOutcome, type RangeSeries, type RangeTarget } from './rangetargets';
import { dinapoli, dnAt, dnTrades, type DnSeries, type DnSetup } from './dinapoli';
import { divergenceEvents, type WeeklyEvent } from './rsimap';
import { nearestStrong, SRZ, srTags, srTouches, srZones, type SrSeries, type SrSnap } from './srzones';
import { lastClosed } from './scalp2';
import { activeBlocks, dayStatus, levelsFrom, obTry, SHAAKUNI, shaakuniBlocks, shaakuniLevelSeries, type DayStatus, type LevelBar, type ObZone, type ShaakuniLevels } from './shaakuni';
import { trendRibbon, type RibbonPosition, type RibbonSeries } from './trendribbon';
import { trinity, type TrinitySignal } from './trinity';
import { BIT, DIR_ACCUM, PHASE_B, entryKindName, eventName, phaseName, typeName, wyckoff, type WyckoffResult } from './wyckoff';
import { htfSeries, wyckoffEffective, type HtfSeries, type WyEff, type WyTf } from './wyckoffhtf';
import { ZONE_RULE, confluence, firstTouchHolds, obStrength, pickZones, strongTrinity, zoneShown, type ObStrength } from './zonestrength';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
export const ETH_CARD = { symbol: 'ETHUSDT', label: '⚠️ manage your own risk', divRecentBars: 10, maxText: 4096, nearAtr: 1, supports: 2 } as const;
export type CardTf = '4H' | '1D';
/**
 * Wyckoff on the card per timeframe (round 2 rule: kept when it shows a Phase B+ structure on at least a third of the
 * closes). Preview run 38149562411 (Bitunix ETHUSDT, 2023-09-12 on): 4H 16.8% with the override (14.9% own), 1D 4.6%
 * -> dropped on both, with its alerts and its confluence factor. The engine and the override stay for the check.
 */
export const WYCKOFF_SHOWN: Record<CardTf, boolean> = { '4H': false, '1D': false };
export const WYCKOFF_KEEP_SHARE = 1 / 3;
/** Sections on the card (owner 2026-10-11, after the round 4 preview: Trinity reversal and Fib clusters removed). */
export const ON_CARD = { trinity: false, fibClusters: false } as const;

/** Every series of one timeframe, computed once over its closed bars. */
export interface TfData {
  tf: CardTf; ms: number; c: ReadonlyArray<Candle>; atr: (number | null)[]; rsi: (number | null)[]; line: (number | null)[]; sig: (number | null)[]; hist: (number | null)[];
  chop: number[]; rib: RibbonSeries; tri: TrinitySignal[]; obs: ObZone[]; obStr: Map<ObZone, ObStrength>; wy: WyckoffResult; fibFlips: FibSwingFlip[]; fib: FibArcs | null; fibHits: FibArcHit[]; divs: WeeklyEvent[];
  /** Bollinger bandwidth (% of the mid) and relative volume per bar (outlook.ts). */
  vol: { width: number[]; relVol: number[] };
  /** The Chop Zone angle and colour per bar (chopzone.ts) and the coin. */
  cz: { angle: number[]; color: (ChopColor | null)[] }; sym: StackCoin;
  /** Round 4 templates: S/R zones, the FVG / OB Detector, Fib clusters (4H only) and range targets. */
  sr: SrSeries; fo: FvgObSeries; fc: FibSeries | null; rt: RangeSeries;
  /** DiNapoli setups (dinapoli.ts). */
  dn: DnSeries;
}

/** `d1` (the daily history) feeds the S/R zones' higher-timeframe swings; on 1D it is the bars themselves. */
export function tfData(c: ReadonlyArray<Candle>, tf: CardTf, sym: StackCoin = 'ETHUSDT', d1: ReadonlyArray<Candle> = tf === '1D' ? c : []): TfData {
  const ms = tf === '4H' ? H4 : DAY, close = c.map((b) => b.close), m = macdLines(close), vol = coinVolume(c), r = rsi(close, 14);
  const obs = shaakuniBlocks(c, ms), fa = fibArcs(c);
  return {
    tf, ms, c, atr: atrWilder(c, 14), rsi: r, line: m.line, sig: m.sig, hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    chop: chopIndex(c), rib: trendRibbon(c), tri: trinity(c), obs, obStr: new Map(obs.map((z) => [z, obStrength(c, z, vol)])), wy: wyckoff(c, ms),
    fibFlips: fa.flips, fib: fa.last, fibHits: fibArcHits(c, fibStates(c).states), divs: divergenceEvents(c, r, 5, 3, 5, 40), vol: volSeries(c),
    cz: chopZone(c), sym, sr: srZones(c, tf, d1), fo: fvgOb(c), fc: ON_CARD.fibClusters && tf === '4H' ? fibClusters(c) : null, rt: rangeTargets(c), dn: dinapoli(c),
  };
}

// ---- per-bar state ----
const isStrong = (S: TfData, z: ObZone) => S.obStr.get(z)?.strong === true;
/** Sent at all (4H: strong only; 1D: strong or weak, owner 2026-10-11). */
const shown = (S: TfData, z: ObZone) => zoneShown(S.tf, S.obStr.get(z));
const zoneWord = (S: TfData, z: ObZone) => (isStrong(S, z) ? 'strong' : 'weak');
/** The levels as the card shows them (weekend roll included) plus the week before. */
export function displayLevels(L: ShaakuniLevels): { price: number; label: string }[] {
  return [{ price: L.pwh, label: 'PWH' }, { price: L.pwl, label: 'PWL' }, { price: L.weq, label: 'W-EQ' }, { price: L.pdh, label: 'PDH' }, { price: L.pdl, label: 'PDL' }, { price: L.deq, label: 'D-EQ' }, { price: L.pwh2, label: 'week-before high' }, { price: L.pwl2, label: 'week-before low' }].filter((x) => Number.isFinite(x.price));
}
const activePosition = (S: TfData, i: number): RibbonPosition | null => { const p = [...S.rib.positions].reverse().find((x) => x.i <= i); return p && (p.endAt < 0 || p.endAt > i) ? p : null; };
const activeTrinity = (S: TfData, i: number) => S.tri.filter((s) => s.i <= i && (s.touchedAt < 0 || s.touchedAt > i) && (s.expiredAt < 0 || s.expiredAt > i));
const sideWord = (d: number) => (d > 0 ? 'bull' : 'bear');
const roleWord = (dir: number) => (dir === 1 ? 'resistance' : 'support');
/** Strong FVGs live at bar i (unfilled, not dropped). */
const strongGaps = (S: TfData, i: number) => S.fo.fvgs.filter((g) => fvgStrong(g) && fvgActive(g, i));
/** Strong detector blocks live at i; `both` = the shown Shaakuni block it doubles (> 70% overlap either way), if any. */
function detBlocks(S: TfData, i: number): { k: DetBlock; both: ObZone | null }[] {
  const shaakuni = activeBlocks(S.obs, i).filter((z) => shown(S, z));
  const lookback = S.tf === '4H' ? 250 : 150; // the Shaakuni zone lookback, so old blocks age off the card the same way
  return S.fo.blocks.filter((k) => k.str.strong && blockActive(k, i) && i - k.obBar <= lookback).map((k) => ({ k, both: shaakuni.find((z) => z.side === k.side && Math.max(overlapShare(k, z), overlapShare(z, k)) > 0.7) ?? null }));
}
/** The Fib week live at 4H bar i: strong clusters, golden pocket, 50%, prior high / low states, nearest magnets. */
function fibAt(S: TfData, i: number, price: number) {
  const F = S.fc, w = F ? F.weekAt[i]! : -1;
  if (!F || w < 0) return null;
  const wk = F.weeks[w]!, mags = liveMagnets(F, i);
  const up = mags.filter((m) => m.price > price).sort((a, b) => a.price - b.price)[0] ?? null, dn = mags.filter((m) => m.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
  return { wk, strong: wk.zones.filter((z) => z.kind === 'cluster' && z.strength >= FIBCL.strong), gp: wk.zones.find((z) => z.kind === 'gp')!, eq: wk.zones.find((z) => z.kind === 'eq')!, stHigh: F.stHigh[i]!, stLow: F.stLow[i]!, magUp: up as Magnet | null, magDn: dn as Magnet | null };
}
/** The range price is in at i (box waiting or forming) and the nearest open targets above / below. */
function rangeAt(S: TfData, i: number, price: number) {
  const n = S.rt.now, open = openTargets(S.rt, i).filter((t) => !t.quiet);
  const hi = n.hi[i]!, lo = n.lo[i]!;
  return {
    now: Number.isNaN(hi) ? null : { hi, lo, left: n.left[i]!, forming: n.forming[i] === 1 },
    up: open.filter((t) => t.px > price).sort((a, b) => a.px - b.px)[0] ?? null, dn: open.filter((t) => t.px < price).sort((a, b) => b.px - a.px)[0] ?? null,
  };
}

/** Both timeframes' data, the 4H level series and Wyckoff as shown (with the override) per bar. */
export interface Ctx { sym: StackCoin; d4: TfData; dd: TfData; lv: LevelBar[]; wy: Record<CardTf, WyEff[]>; outlook: OutlookSeries; stack: StackSeries }
/** The 1H bars and their DiNapoli setups (shown on the 4H card, alerted at 1H closes). */
export interface H1Data { c: ReadonlyArray<Candle>; dn: DnSeries }

/** What the card shows at time t (a bar close): the levels, both timeframes' shown zones and active strong Trinity levels. */
function shownAt(x: Ctx, t: number) {
  const k4 = lastClosed(x.d4.c, H4, t), kd = lastClosed(x.dd.c, DAY, t);
  const L = levelsFrom(k4 >= 0 ? x.lv[k4] : undefined, k4 >= 0 ? x.d4.c[k4] : undefined, t);
  const zones = [...(k4 >= 0 ? activeBlocks(x.d4.obs, k4).filter((z) => shown(x.d4, z)).map((z) => ({ z, S: x.d4 })) : []), ...(kd >= 0 ? activeBlocks(x.dd.obs, kd).filter((z) => shown(x.dd, z)).map((z) => ({ z, S: x.dd })) : [])];
  const tri = !ON_CARD.trinity ? [] : [...(k4 >= 0 ? activeTrinity(x.d4, k4).filter(strongTrinity).map((s) => ({ s, tf: '4H' as CardTf })) : []), ...(kd >= 0 ? activeTrinity(x.dd, kd).filter(strongTrinity).map((s) => ({ s, tf: '1D' as CardTf })) : [])];
  // Round 4 (list only): strong S/R zones, strong FVGs, strong detector blocks not doubling a Shaakuni block, and the
  // week's strong Fib clusters and golden pocket.
  const extra: { label: string; top: number; bottom: number }[] = [];
  for (const [S, k] of [[x.d4, k4], [x.dd, kd]] as const) {
    if (k < 0) continue;
    for (const z of S.sr.snaps[k] ?? []) if (z.score >= SRZ.strongScore) extra.push({ label: `${S.tf} S/R ${roleWord(z.dir)} (${z.score})`, top: z.top, bottom: z.bot });
    for (const g of strongGaps(S, k)) extra.push({ label: `${S.tf} ${sideWord(g.side)} FVG`, top: g.top, bottom: g.bottom });
    for (const { k: b, both } of detBlocks(S, k)) if (!both) extra.push({ label: `${S.tf} ${sideWord(b.side)} IOB`, top: b.top, bottom: b.bottom });
  }
  const fb = k4 >= 0 ? fibAt(x.d4, k4, x.d4.c[k4]!.close) : null;
  if (fb) { for (const z of fb.strong) extra.push({ label: `Fib cluster (${z.strength})`, top: z.top, bottom: z.bot }); extra.push({ label: 'golden pocket', top: fb.gp.top, bottom: fb.gp.bot }); }
  return { k4, kd, levels: displayLevels(L), zones, tri, extra };
}

/** Bandwidth, its percentile over the last 180 days, ATR % and relative volume of S at bar i. */
export function volAt(S: TfData, i: number): { width: number; pct: number | null; atrPct: number | null; relVol: number } {
  const n = Math.round((OUTLOOK.pctDays * DAY) / S.ms), a = S.atr[i];
  return { width: S.vol.width[i]!, pct: pctRank(S.vol.width, i, n), atrPct: a == null ? null : (a / S.c[i]!.close) * 100, relVol: S.vol.relVol[i]! };
}

// ---- formatting ----
export const px = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '-' : Math.abs(x) >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Number(x.toPrecision(5)).toString());
const sg = (x: number, d = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const iso = (t: number) => new Date(t).toISOString();
const when = (t: number, tf: CardTf | WyTf) => (tf === '4H' ? `${iso(t).slice(5, 10)} ${iso(t).slice(11, 16)}` : iso(t).slice(5, 10));
const utc = (t: number) => `${iso(t).slice(0, 10)} ${iso(t).slice(11, 16)} UTC`;
const pct = (r: number) => `${(r * 100).toFixed(1).replace('.0', '')}%`;
const coinName = (sym: string) => sym.replace(/USDT$/, '');

// ---- the KAMA signal ----
/** A level (price) or a zone (range; price = its edge nearest the signal, or the signal price when inside it). */
export interface NoteLevel { label: string; price: number; atr: number; range?: [number, number] }
export interface KamaNote { factors: { name: string; ok: boolean }[]; support: NoteLevel[]; next: NoteLevel | null }
/** The notes printed with a KAMA cross of S at bar i (see the header). */
export function kamaNotes(x: Ctx, S: TfData, i: number, dir: 1 | -1): KamaNote {
  const t = S.c[i]!.openTime + S.ms, price = S.c[i]!.close, a = S.atr[i] ?? NaN, sh = shownAt(x, t);
  const edge = (z: { top: number; bottom: number }) => (price > z.top ? z.top : price < z.bottom ? z.bottom : price);
  const items: { label: string; edge: number; side: number; zone: boolean; range?: [number, number] }[] = [
    ...sh.levels.map((l) => ({ label: l.label, edge: l.price, side: 0, zone: false })),
    ...sh.zones.map(({ z, S: T }) => ({ label: `${T.tf} ${sideWord(z.side)} POI`, edge: edge(z), side: z.side, zone: true, range: [z.bottom, z.top] as [number, number] })),
    ...sh.tri.map(({ s, tf }) => ({ label: `${tf} Trinity ${s.dir > 0 ? '▲' : '▼'}`, edge: s.level, side: s.dir, zone: true })),
    ...sh.extra.map((z) => ({ label: z.label, edge: edge(z), side: 0, zone: false, range: [z.bottom, z.top] as [number, number] })),
  ];
  const dist = (e: number) => Math.abs(price - e), near = (p: { edge: number }, q: { edge: number }) => dist(p.edge) - dist(q.edge);
  const below = items.filter((v) => v.edge <= price).sort(near), above = items.filter((v) => v.edge >= price).sort(near);
  const [mine, others] = dir > 0 ? [below, above] : [above, below], other = others.filter((v) => dist(v.edge) > 0); // a zone around the price is not "next"
  const note = (v: { label: string; edge: number; range?: [number, number] }): NoteLevel => ({ label: v.label, price: v.edge, atr: a > 0 ? dist(v.edge) / a : NaN, ...(v.range ? { range: v.range } : {}) });
  const otherTf = S.tf === '4H' ? x.dd : x.d4, ko = S.tf === '4H' ? sh.kd : sh.k4, h = S.hist[i], r = S.rsi[i];
  const factors = [
    { name: `ribbon ${S.tf}`, ok: S.rib.trend[i] === dir },
    { name: `ribbon ${otherTf.tf}`, ok: ko >= 0 && otherTf.rib.trend[ko] === dir },
    { name: 'MACD', ok: h != null && Math.sign(h) === dir },
    { name: 'RSI', ok: r != null && (dir > 0 ? r > 50 : r < 50) },
    { name: dir > 0 ? 'support zone' : 'resistance zone', ok: mine.some((v) => v.zone && v.side === dir && dist(v.edge) <= ETH_CARD.nearAtr * a) },
  ];
  if (WYCKOFF_SHOWN[S.tf]) { const w = x.wy[S.tf][i]!.bar; factors.push({ name: 'Wyckoff', ok: w.phase >= PHASE_B && w.wdir === dir }); }
  // Round 4 (owner): BTC's 1D ribbon on the signal's side, on the ETH card only; "on watch" because round 3 found it
  // in-sample.
  if (x.sym === 'ETHUSDT') { const o = outlookAt(x.outlook, t).other; if (o) factors.push({ name: 'BTC ribbon (on watch)', ok: o.trend === dir }); }
  return { factors, support: mine.slice(0, ETH_CARD.supports).map(note), next: other[0] ? note(other[0]) : null };
}

export interface KamaSig extends KamaCross { tf: CardTf; time: number; price: number; chop: ChopColor | null; heldOff: boolean; note: KamaNote }
export interface KamaTf { line: KamaLine; sigs: KamaSig[]; record: KamaTrade[]; unfiltered: KamaTrade[]; from: number }
/** Both timeframes' KAMA lines, crosses (with the chop filter and notes) and records, from the 4H history's warm-up on. */
export function kamaState(x: Ctx): Record<CardTf, KamaTf> {
  const h4 = x.d4.c, d1 = x.dd.c, start = h4[Math.min(KAMA.warmup, h4.length - 1)]?.openTime ?? Infinity;
  const one = (S: TfData, line: KamaLine): KamaTf => {
    let from = KAMA.warmup;
    while (from < S.c.length && S.c[from]!.openTime < start) from++;
    const sigs = kamaCrosses(line, from).map((cr): KamaSig => {
      const t = S.c[cr.i]!.openTime + S.ms, k4 = lastClosed(h4, H4, t), ch = k4 >= 0 ? x.d4.cz.color[k4] ?? null : null;
      return { ...cr, tf: S.tf, time: S.c[cr.i]!.openTime, price: S.c[cr.i]!.close, chop: ch, heldOff: cr.dir > 0 && ch === 'yellow', note: kamaNotes(x, S, cr.i, cr.dir) };
    });
    const held = new Set(sigs.filter((s) => s.heldOff).map((s) => s.i));
    return { line, sigs, record: kamaRecord(S.c, sigs, (s) => !held.has(s.i)), unfiltered: kamaRecord(S.c, sigs, () => true), from: S.c[from]?.openTime ?? NaN };
  };
  return { '4H': one(x.d4, kama4h(h4, d1)), '1D': one(x.dd, kamaDaily(d1)) };
}
const sigWord = (d: number) => (d > 0 ? 'BUY' : 'SELL');
const noteLevel = (l: NoteLevel) => (l.range ? `${esc(l.label)} ${px(l.range[0])}–${px(l.range[1])} (${l.atr === 0 ? 'inside' : `${l.atr.toFixed(1)} ATR`})` : `${esc(l.label)} ${px(l.price)} (${l.atr.toFixed(1)} ATR)`);
const noteLines = (n: KamaNote, dir: number, pad: string) => [
  `${pad}confluence ${n.factors.filter((f) => f.ok).length}/${n.factors.length}: ${n.factors.map((f) => `${f.name} ${f.ok ? '✓' : '✗'}`).join(' · ')}`,
  `${pad}${dir > 0 ? 'support' : 'resistance'} ${n.support.length ? n.support.map(noteLevel).join(' · ') : 'none shown'}${n.next ? ` · next ${dir > 0 ? 'resistance' : 'support'} ${noteLevel(n.next)}` : ''}`,
];

export interface CardInput {
  m15: ReadonlyArray<Candle>; h4: ReadonlyArray<Candle>; d1: ReadonlyArray<Candle>; funding: { rate: number; intervalHours: number } | null; now: number;
  /** The card's coin (default ETHUSDT). */
  symbol?: StackCoin;
  /** For the Outlook section: the other coin's daily bars (BTC on the ETH card, ETH on the BTC card) and this coin's settled funding history (empty = those lines say "no data"). */
  otherD1?: ReadonlyArray<Candle>; fundingHistory?: ReadonlyArray<{ time: number; rate: number }>;
  /** 1H bars for the 1H DiNapoli line on the 4H card (empty = the line says "no data"). */
  h1?: ReadonlyArray<Candle>;
}
export type DnTf = '4H' | '1D' | '1H';
/** A timeframe's latest DiNapoli setup with its levels' state at the card time, and the record of its setups as trades. */
export interface DnView { tf: DnTf; at: ReturnType<typeof dnAt>; time: number; record: { n: number; wins: number; avg: number | null; avgR: number | null } }
export interface KamaView { tf: CardTf; last: KamaSig | null; fast: number; slow: number; stats: KamaStats; from: number }
export interface EthCard {
  symbol: StackCoin; stack: StackAt; at: number; price: number; change24h: number | null; high24h: number; low24h: number; funding: CardInput['funding'];
  levels: ShaakuniLevels; tf: Record<CardTf, TfView>; kama: Record<CardTf, KamaView>;
  outlook: { at: OutlookAt; price: number; vol: Record<CardTf, ReturnType<typeof volAt>> };
  dn: Record<DnTf, DnView | null>;
}
export interface TfView {
  tf: CardTf; barAt: number; zone: { color: ChopColor | null; angle: number }; rsi: number | null; macd: string; rsiDiv: string | null;
  zones: { z: ObZone; s: ObStrength; tags: string[]; time: number; iob: boolean }[];
  /** Round 4: strong detector blocks not doubling a shown Shaakuni block (nearest 2 per side). */
  iob: { k: DetBlock; time: number }[];
  sr: { above: SrSnap | null; below: SrSnap | null };
  fvg: { above: Fvg | null; below: Fvg | null; times: Map<Fvg, number> };
  fib: ReturnType<typeof fibAt>;
  range: ReturnType<typeof rangeAt>;
  wyckoff: { from: WyTf; type: string; phase: number; phaseName: string; event: string; eventPrice: number; rangeHigh: number; rangeLow: number; conf: number; val: number; next: string | null; lastEntry: { time: number; price: number; dir: number; kind: number } | null };
  ribbon: { trend: number; flipAt: number | null; bars: number; conviction: number; pos: RibbonPosition | null };
  trinity: { last: TrinitySignal | null; lastTime: number; levels: { s: TrinitySignal; tags: string[] }[] };
}

function macdText(S: TfData, i: number): string {
  const h = S.hist[i];
  if (h == null) return 'MACD -';
  const st = macdState(S.hist, i, h >= 0 ? 1 : -1), side = h >= 0 ? 'bullish' : 'bearish';
  if (!st) return `MACD ${side}`;
  const shrinking = i > 0 && S.hist[i - 1] != null && Math.abs(h) < Math.abs(S.hist[i - 1]!);
  const cross = st.sinceCross != null ? `crossed ${st.sinceCross} bar${st.sinceCross === 1 ? '' : 's'} ago` : 'crossed 30+ bars ago';
  return `MACD ${side}, ${cross}, ${shrinking ? 'histogram shrinking (pre-cross)' : 'widening'}`;
}

function tfView(S: TfData, levels: ReadonlyArray<{ price: number; label: string }>, d1Zones: ReadonlyArray<ObZone>, wy: WyEff): TfView {
  const i = S.c.length - 1, a = S.atr[i] ?? 0, price = S.c[i]!.close;
  const div = [...S.divs].reverse().find((e) => e.i <= i && i - e.i < ETH_CARD.divRecentBars);
  const act = activeBlocks(S.obs, i), picked = pickZones(act, (z) => shown(S, z), price);
  const otherZones = S.tf === '4H' ? d1Zones.map((z) => ({ price: (z.top + z.bottom) / 2, label: `1D ${sideWord(z.side)} POI` })) : [];
  const tagWith = [...levels, ...otherZones];
  const det = detBlocks(S, i), doubled = new Set(det.map((d) => d.both).filter((z): z is ObZone => z != null));
  const zones = picked.shown.map((z) => ({ z, s: S.obStr.get(z)!, tags: confluence(z, a, tagWith), time: S.c[z.obBar]!.openTime, iob: doubled.has(z) }));
  const iob = pickZones(det.filter((d) => !d.both || !picked.shown.includes(d.both)).map((d) => d.k), () => true, price).shown.map((k) => ({ k, time: S.c[k.obBar]!.openTime }));
  const sr = nearestStrong(S.sr, i, price), gaps = strongGaps(S, i), gd = (g: Fvg) => (price > g.top ? price - g.top : price < g.bottom ? g.bottom - price : 0);
  const gUp = gaps.filter((g) => g.mid >= price).sort((x, y) => gd(x) - gd(y))[0] ?? null, gDn = gaps.filter((g) => g.mid < price).sort((x, y) => gd(x) - gd(y))[0] ?? null;
  const own = wy.tf === S.tf, wb = wy.bar;
  const pos = activePosition(S, i) ?? S.rib.positions.at(-1) ?? null, trend = S.rib.trend[i]!;
  const strongTri = S.tri.filter((s) => s.i <= i && i - s.i < 100 && strongTrinity(s));
  return {
    tf: S.tf, barAt: S.c[i]!.openTime + S.ms, zone: { color: S.cz.color[i] ?? null, angle: S.cz.angle[i]! }, rsi: S.rsi[i] ?? null, macd: macdText(S, i),
    rsiDiv: div ? `RSI ${div.d > 0 ? 'bullish' : 'bearish'} divergence (${div.d > 0 ? 'low' : 'high'} ${when(S.c[div.i - 3]!.openTime, S.tf)})` : null,
    zones, iob, sr: { above: sr.above[0] ?? null, below: sr.below[0] ?? null },
    fvg: { above: gUp, below: gDn, times: new Map([gUp, gDn].filter((g): g is Fvg => g != null).map((g) => [g, S.c[g.leftBar + 1]!.openTime])) },
    fib: fibAt(S, i, price), range: rangeAt(S, i, price),
    wyckoff: {
      from: wy.tf, type: typeName(wb.type), phase: wb.phase, phaseName: phaseName(wb.phase), event: eventName(wb.ev), eventPrice: wb.lastEventPrice, rangeHigh: wb.rangeHigh, rangeLow: wb.rangeLow,
      conf: wb.conf, val: wb.val, next: own ? S.wy.next : null, lastEntry: own ? (S.wy.entries.at(-1) ?? null) : null,
    },
    ribbon: { trend, flipAt: pos ? S.c[pos.i]!.openTime : null, bars: pos ? i - pos.i : 0, conviction: S.rib.conviction[i]!, pos },
    trinity: { last: strongTri.at(-1) ?? null, lastTime: strongTri.length ? S.c[strongTri.at(-1)!.i]!.openTime : 0, levels: activeTrinity(S, i).filter(strongTrinity).map((s) => ({ s, tags: confluence({ top: s.level, bottom: s.level }, a, tagWith) })) },
  };
}

const kamaView = (S: TfData, k: KamaTf): KamaView => ({ tf: S.tf, last: k.sigs.at(-1) ?? null, fast: k.line.fast[S.c.length - 1]!, slow: k.line.slow[S.c.length - 1]!, stats: kamaStats(k.record), from: k.from });

export interface EthBuilt { card: EthCard; d4: TfData; dd: TfData; ctx: Ctx; kama: Record<CardTf, KamaTf>; outlook: OutlookSeries; stack: StackSeries; h1: H1Data }
function dnView(tf: DnTf, c: ReadonlyArray<Candle>, S: DnSeries): DnView | null {
  if (!c.length) return null;
  const at = dnAt(S, c.length - 1), tr = dnTrades(c, S), w = tr.filter((t) => t.ret > 0).length, rs = tr.filter((t) => Number.isFinite(t.r));
  return { tf, at, time: at ? c[at.s.i]!.openTime : NaN, record: { n: tr.length, wins: w, avg: tr.length ? (tr.reduce((a, t) => a + t.ret, 0) / tr.length) * 100 : null, avgR: rs.length ? rs.reduce((a, t) => a + t.r, 0) / rs.length : null } };
}
/**
 * Everything the card shows at the last closed bars. `d1` can reach further back than `h4`: the 1D engines and the
 * weekly / monthly Wyckoff of the override use all of it.
 */
export function ethCard(inp: CardInput): EthBuilt {
  const sym = inp.symbol ?? 'ETHUSDT', d4 = tfData(inp.h4, '4H', sym, inp.d1), dd = tfData(inp.d1, '1D', sym), lv = shaakuniLevelSeries(inp.h4);
  const wm = htfSeries(inp.d1, ['W', 'M']), dSeries: HtfSeries = { tf: 'D', c: [...inp.d1], ends: inp.d1.map((b) => b.openTime + DAY), wy: dd.wy };
  const wy = { '4H': wyckoffEffective(inp.h4, d4.wy, '4H', [dSeries, ...wm]), '1D': wyckoffEffective(inp.d1, dd.wy, '1D', wm) };
  const outlook = outlookSeries(inp.d1, inp.otherD1 ?? [], inp.fundingHistory ?? [], sym === 'ETHUSDT'), stack = stackSeries(sym, inp.d1, inp.h4);
  const ctx: Ctx = { sym, d4, dd, lv, wy, outlook, stack }, kama = kamaState(ctx), h1c = inp.h1 ?? [], h1: H1Data = { c: h1c, dn: dinapoli(h1c) };
  const m = inp.m15, last = m[m.length - 1]!, from = last.openTime + 15 * 60_000 - DAY;
  const day = m.filter((b) => b.openTime >= from), ago = [...m].reverse().find((b) => b.openTime + 15 * 60_000 <= from);
  const levels = levelsFrom(lv.at(-1), inp.h4.at(-1), inp.now), shownLevels = displayLevels(levels);
  const ddAct = activeBlocks(dd.obs, dd.c.length - 1).filter((z) => shown(dd, z));
  const card: EthCard = {
    symbol: sym, stack: stackAt(stack, inp.now), at: inp.now, price: last.close, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    levels, tf: { '4H': tfView(d4, shownLevels, ddAct, wy['4H'].at(-1)!), '1D': tfView(dd, shownLevels, [], wy['1D'].at(-1)!) },
    kama: { '4H': kamaView(d4, kama['4H']), '1D': kamaView(dd, kama['1D']) },
    outlook: { at: outlookAt(outlook, inp.now), price: inp.h4.at(-1)?.close ?? NaN, vol: { '4H': volAt(d4, d4.c.length - 1), '1D': volAt(dd, dd.c.length - 1) } },
    dn: { '4H': dnView('4H', d4.c, d4.dn), '1D': dnView('1D', dd.c, dd.dn), '1H': dnView('1H', h1.c, h1.dn) },
  };
  return { card, d4, dd, ctx, kama, outlook, stack, h1 };
}

function kamaLines(v: KamaView): string[] {
  const now = `now fast ${px(v.fast)} ${v.fast >= v.slow ? 'over' : 'under'} slow ${px(v.slow)}`, s = v.last;
  if (!s) return [` no cross yet · ${now}`];
  const at = `${sigWord(s.dir)} ${when(s.time, v.tf)}`;
  if (s.heldOff) return [` no live signal: last cross ${at} at ${px(s.price)} held off (4H Chop Zone yellow) · ${now}`];
  return [` ${s.dir > 0 ? '🟢' : '🔴'} ${at} at ${px(s.price)} · ${now}`, ...noteLines(s.note, s.dir, '    ')];
}
const ord = (p: number) => `${Math.round(p)}${[11, 12, 13].includes(Math.round(p) % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][Math.round(p) % 10] ?? 'th'} pct`;
/**
 * The Outlook lines of one card (owner 2026-10-11, one card per timeframe): the 4H card has the 4H volatility and
 * volume and the funding trend; the 1D card has the other coin, ETH/BTC, the weekly bias and the 1D volatility and volume.
 */
function outlookLines(o: EthCard['outlook'], sym: StackCoin, tf: CardTf): string[] {
  const { other: ot, weekly: w, funding: f } = o.at, out = ['', '<b>Outlook</b>'], on = sym === 'ETHUSDT' ? 'BTC' : 'ETH', x = o.vol[tf];
  const vol = ` Volatility BB width ${Number.isNaN(x.width) ? '-' : `${x.width.toFixed(1)}%`}${x.pct == null ? '' : ` (${ord(x.pct)}, 180d)${x.pct <= OUTLOOK.squeezePct ? ' squeeze' : x.pct >= OUTLOOK.expandPct ? ' expanding' : ''}`} · ATR ${x.atrPct == null ? '-' : `${x.atrPct.toFixed(1)}%`} · volume ${Number.isNaN(x.relVol) ? '-' : `${x.relVol.toFixed(1)}x`} the 20-bar avg`;
  if (tf === '1D') {
    out.push(ot ? ` ${on} 1D ${ot.trend > 0 ? '🟢 ribbon bull' : ot.trend < 0 ? '🔴 ribbon bear' : 'ribbon -'} · KAMA ${ot.kamaOver == null ? '-' : ot.kamaOver ? 'over' : 'under'} · ETH/BTC ${ot.ratio.toPrecision(4)}${ot.ratioChg7 == null ? '' : ` (7d ${sg(ot.ratioChg7, 1)}%)`}${ot.ratioOverEma == null ? '' : `, ${ot.ratioOverEma ? 'over' : 'under'} its 20-day EMA: ETH ${ot.ratioOverEma ? 'leading' : 'lagging'}`}` : ` ${on} no data`);
    out.push(w ? ` Weekly (week of ${iso(w.weekOf).slice(5, 10)}) RSI ${w.rsi == null ? '-' : w.rsi.toFixed(1)} · ${w.ema == null ? '50-week EMA -' : `${o.price >= w.ema ? 'over' : 'under'} the 50-week EMA ${px(w.ema)} (${sg((o.price / w.ema - 1) * 100, 1)}%)`}` : ' Weekly no closed week yet');
    out.push(vol);
  } else {
    const fp = (r: number) => `${sg(r * 100, 4)}%`;
    out.push(vol, ` ${f ? `Funding 7d avg ${fp(f.avg7)}, ${f.recent > f.prior ? 'rising' : f.recent < f.prior ? 'falling' : 'flat'} (90d median ${fp(f.median90)})` : 'Funding history: no data'}`);
  }
  return out;
}
const recordLine = (v: KamaView) => {
  const st = v.stats;
  return ` Record (since ${Number.isFinite(v.from) ? iso(v.from).slice(0, 10) : '-'}, buys held off in 4H Chop Zone yellow, held to the opposite cross): ${st.closed} closed, win ${st.closed ? Math.round((100 * st.wins) / st.closed) : 0}% (${st.wins}/${st.closed}), avg ${st.avg == null ? '-' : `${sg(st.avg)}%`}`;
};

const sinceTxt = (t: number) => (Number.isFinite(t) ? ` since ${iso(t).slice(5, 10)}` : '');
const emaLine = (x: { n: number; ema: number; over: boolean; pct: number; since: number } | null) => (x ? `${x.over ? 'over' : 'under'} EMA ${x.n} ${px(x.ema)} (${sg(x.pct, 1)}%)${sinceTxt(x.since)}` : 'EMA -');
/**
 * The EMA stack (emastack.ts). 1D card: the coin's bias, pair, weekly lines and short check. 4H card: the 4H trigger
 * with the daily bias it works under.
 */
function stackLines(a: StackAt, tf: CardTf): string[] {
  if (tf === '4H') {
    const side = biasSide(a), out = ['', '<b>EMA trigger</b> (4H, under the daily bias)'];
    out.push(` Daily bias: ${emaLine(a.bias)}${a.slow ? ` · ${emaLine(a.slow)}` : ''} → ${side > 0 ? 'longs allowed' : side < 0 ? 'shorts allowed' : 'no side allowed'}`);
    if (a.trigger) out.push(` ${a.trigger.pairs.map((p) => `${p.fast}/${p.slow} ${p.over ? 'bull' : 'bear'}${Number.isFinite(p.since) ? ` since ${iso(p.since).slice(5, 10)} ${iso(p.since).slice(11, 16)}` : ''}`).join(' · ')} · limits ${a.trigger.limits.map((l) => `EMA ${l.n} ${px(l.v)}`).join(' / ')}`);
    return out;
  }
  const out = ['', '<b>EMA stack</b> (daily close)'];
  const pr = a.pair ? `pair ${a.pair.fast}/${a.pair.slow}: ${a.pair.fast} ${a.pair.over ? 'over' : 'under'} ${a.pair.slow}${sinceTxt(a.pair.since)}` : 'pair -';
  out.push(` Bias: ${emaLine(a.bias)}${a.slow ? ` · slow: ${emaLine(a.slow)}` : ''} · ${pr}`);
  if (a.weekly) {
    const W = a.weekly.lines, lbl = (n: number) => (a.coin === 'BTCUSDT' ? (n === 5 ? 'permission ' : 'veto ') : '');
    out.push(` Weekly (week of ${iso(a.weekly.weekOf).slice(5, 10)}): ${W.map((x) => `${lbl(x.n)}${x.over ? 'over' : 'under'} W${x.n} ${px(x.ema)}${a.coin === 'BTCUSDT' ? (x.n === 5 ? (x.over ? ' ✓' : ' ✗') : x.over ? ' (no veto)' : ' ⛔ veto') : ''}`).join(' · ')}`);
  }
  if (a.coin === 'ETHUSDT') out.push(` Short confirmation: ${a.shortConfirm == null ? '-' : a.bias?.over ? 'off (close over 26)' : a.shortConfirm ? '✓ on (under 26, EMA 12 under 26)' : '✗ under 26 but EMA 12 over 26'}`);
  else if (!a.shortCheck) out.push(' Short check: n/a (close over 26: flatten / short rules only apply under it)');
  else { const [i1, i2, i3] = a.shortCheck.items; out.push(` Short check ${a.shortCheck.count}/3${a.shortCheck.count >= 2 ? ' → short OK' : ' → flatten, no short'}: 9 under 89 or 12 under 26 ${i1 ? '✓' : '✗'} · 3 closes under 26 or failed retest ${i2 ? '✓' : '✗'} · not the first tag after a run ${i3 ? '✓' : '✗'}`); }
  return out;
}

/**
 * One timeframe's card as Telegram HTML (owner 2026-10-11: "form separate cards for each", by timeframe): the 4H card
 * goes out at each 4H close, the 1D card at the daily close, each with its own timeframe's lines. One message, or two
 * when it passes 4,096 characters.
 */
export function ethCardText(card: EthCard, tf: CardTf): string[] {
  const v = card.tf[tf], L = card.levels, f = card.funding, z = v.zone;
  const head = [
    `📊 <b>${card.symbol}</b> · ${tf} card · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})${f ? ` · funding ${sg(f.rate * 100, 4)}% / ${f.intervalHours}h` : ''}`,
    '',
    `<b>KAMA signal ${tf}</b> (daily HA vs EMA 20 of KAMA) · ${ETH_CARD.label}`,
    ...kamaLines(card.kama[tf]), recordLine(card.kama[tf]),
    ...dnLines(card, tf),
    ...outlookLines(card.outlook, card.symbol, tf),
    ...stackLines(card.stack, tf),
  ];
  const a = [
    '', tf === '4H' ? '<b>Chop Zone</b> (yellow = chop: no new KAMA buys)' : '<b>Chop Zone</b> (KAMA buys are held off by the 4H one)',
    ` ${zoneEmoji(z.color)} ${z.color ?? '-'} (angle ${Number.isNaN(z.angle) ? '-' : z.angle})${tf === '4H' && z.color === 'yellow' ? ' · KAMA buys held off' : ''}`,
    '', '<b>RSI 14 / MACD 12/26/9</b>', ` RSI ${v.rsi == null ? '-' : v.rsi.toFixed(1)} · ${v.macd}${v.rsiDiv ? ` · ${v.rsiDiv}` : ''}`,
  ];
  const poi = v.zones.map((x) => `${x.z.side > 0 ? '🟦 bull' : '🟧 bear'} POI${x.s.strong ? '' : ' (weak)'} ${px(x.z.bottom)} – ${px(x.z.top)} (${when(x.time, tf)}) · impulse ${x.s.impulseAtr.toFixed(1)} ATR, volume ${x.s.volumeMult.toFixed(1)}x${x.tags.length ? `, at ${esc(x.tags.join(' / '))}` : ''}${x.iob ? ', also IOB' : ''}`);
  const iob = v.iob.map(({ k, time }) => `${k.side > 0 ? '🟦 bull' : '🟧 bear'} IOB ${px(k.bottom)} – ${px(k.top)} (${when(time, tf)}) · impulse ${k.str.impulseAtr.toFixed(1)} ATR, volume ${k.str.volumeMult.toFixed(1)}x`);
  const b: string[] = [
    '', '<b>Levels</b> (Shaakuni)',
    ` PWH ${px(L.pwh)} · W-EQ ${px(L.weq)} · PWL ${px(L.pwl)} · week before: high ${px(L.pwh2)} · low ${px(L.pwl2)}`,
    ...(tf === '4H' ? [` PDH ${px(L.pdh)} ${statusWord(L.pdhStatus)} · D-EQ ${px(L.deq)} · PDL ${px(L.pdl)} ${statusWord(L.pdlStatus)} · Session: ${L.session === '-' ? 'none' : L.session}`] : []),
    ` Order blocks, unmitigated (${tf === '4H' ? 'strong only' : 'strong or weak'}; IOB = FVG/OB Detector, strong only):`,
    `  ${[...poi, ...iob].join(' · ') || (tf === '4H' ? 'none strong' : 'none')}`,
    ...templateLines(card, tf),
  ];
  if (WYCKOFF_SHOWN[tf]) {
    const w = v.wyckoff, src = w.from === tf ? '' : ` (from ${w.from})`;
    b.push('', '<b>Wyckoff</b>');
    if (w.phase === 0) b.push(' Searching for SC / BC');
    else {
      b.push(`${src} ${w.type} · Phase ${w.phaseName.slice(0, 1)} (${esc(w.event)} ${px(w.eventPrice)})${Number.isNaN(w.rangeHigh) ? '' : ` · range ${px(w.rangeLow)} – ${px(w.rangeHigh)}`}`);
      b.push(`    maturity ${w.conf} · validation ${w.val}${w.next ? ` · next: ${esc(w.next)}` : ''}${w.lastEntry ? ` · last label: ${w.lastEntry.dir === DIR_ACCUM ? 'LONG' : 'SHORT'} (${entryKindName(w.lastEntry.kind)}) ${px(w.lastEntry.price)}, ${when(w.lastEntry.time, tf)}` : ''}`);
    }
  }
  b.push('', '<b>Trend ribbon</b> (BOSWaves)');
  const r = v.ribbon, p = r.pos;
  if (!p || r.trend === 0) b.push(' no trend yet');
  else {
    b.push(` ${r.trend > 0 ? '🟢 Bull' : '🔴 Bear'} since ${when(r.flipAt!, tf)} (${r.bars} bars) · conviction ${Math.round(r.conviction * 100)}%${p.how === 'stop' ? ` · SL hit` : ''}`);
    b.push(`    Entry ${px(p.entry)} · SL ${px(p.stop)} · ${p.targets.map((x, k) => `T${k + 1} ${px(x.price)}${x.hitAt >= 0 ? ' ✓' : ''}`).join(' · ')}`);
  }
  if (ON_CARD.trinity) {
    const x = v.trinity, lv = x.levels.map(({ s, tags }) => `${s.dir > 0 ? '▲' : '▼'} ${px(s.level)}${tags.length ? ` at ${esc(tags.join(' / '))}` : ''}`).join(' · ');
    b.push('', '<b>Trinity reversal</b> (AlgoAlpha)', ` ${x.last ? `last strong ${x.last.dir > 0 ? '▲ bull' : '▼ bear'} ${when(x.lastTime, tf)}, strength ${x.last.strength.toFixed(0)}%` : 'no strong signal in the last 100 bars'}${lv ? ` · active strong levels ${lv}` : ''}`);
  }
  const all = [...head, ...a, ...b].join('\n');
  if (all.length <= ETH_CARD.maxText) return [all];
  return [[...head, ...a].join('\n'), [`📊 <b>${card.symbol}</b> · ${tf} card (2/2) · ${utc(card.at)}`, ...b].join('\n')];
}

/** The DiNapoli section: the 4H card shows the 4H setup, the 1D card the 1D setup (1H goes out as new-setup alerts only). */
function dnLines(card: EthCard, tf: CardTf): string[] {
  const out = ['', `<b>DiNapoli</b> (MarkitTick; entry node, stop, COP / OP / XOP) · ${ETH_CARD.label}`];
  for (const t of [tf] as const) {
    const v = card.dn[t];
    if (!v) { out.push(` ${t} no data`); continue; }
    if (!v.at) { out.push(` ${t} no setup yet`); continue; }
    const { s } = v.at, hit = (on: boolean) => (on ? ' ✓' : '');
    const state = v.at.stop ? ' · stop hit (closed)' : v.at.xop ? ' · XOP hit (closed)' : '';
    out.push(` ${t} ${s.dir > 0 ? '🟢 BULL' : '🔴 BEAR'} ${when(v.time, t === '1D' ? '1D' : '4H')} · entry F${s.node === 618 ? '61.8' : '38.2'} ${px(s.entry)} · SL ${px(s.stop)} · COP ${px(s.cop)}${hit(v.at.cop)} · OP ${px(s.op)}${hit(v.at.op)} · XOP ${px(s.xop)}${hit(v.at.xop)} · retrace ${Math.round(s.retr * 100)}%${Number.isNaN(s.conf) ? '' : ` · confluence ${px(s.conf)}`}${state}`);
  }
  const rl = (t: DnTf) => { const r = card.dn[t]?.record; return r && r.n ? `${t} ${r.n} setups, win ${Math.round((100 * r.wins) / r.n)}%, avg ${sg(r.avg!)}% (${r.avgR == null ? '-' : `${r.avgR >= 0 ? '+' : '−'}${Math.abs(r.avgR).toFixed(2)}R`})` : `${t} -`; };
  out.push(` Record (from the signal close to the stop or OP, 0.22% costs): ${rl(tf)}`);
  return out;
}

/** The round 4 template sections of one card (strong items only). */
function templateLines(card: EthCard, tf: CardTf): string[] {
  const v = card.tf[tf], out: string[] = [];
  const zr = (z: SrSnap | null, up: boolean) => (z ? `${up ? '▲' : '▼'} ${z.dir === 1 ? 'R' : 'S'} ${px(z.bot)}–${px(z.top)} · ${z.score} · ${srTouches(z)}${srTags(z)}` : `${up ? '▲' : '▼'} none`);
  out.push('', `<b>S/R zones</b> (AxeAlgo, score ${SRZ.strongScore}+; ◈ HTF ◎ round Ⓥ volume)`, ` ${zr(v.sr.above, true)} · ${zr(v.sr.below, false)}`);
  const gl = (g: Fvg | null, up: boolean) => (g ? `${up ? '▲' : '▼'} ${sideWord(g.side)} ${px(g.bottom)}–${px(g.top)} (${when(v.fvg.times.get(g)!, tf)}, ${g.sizeAtr.toFixed(1)} ATR, ${g.volMult.toFixed(1)}x)` : `${up ? '▲' : '▼'} none`);
  out.push('', '<b>FVG</b> (strong: 0.5 ATR+, middle-candle volume 1.5x+, unfilled)', ` ${gl(v.fvg.above, true)} · ${gl(v.fvg.below, false)}`);
  const f = v.fib;
  if (f) {
    out.push('', `<b>Fib clusters</b> (from the week of ${iso(f.wk.weekOf - 7 * DAY).slice(5, 10)}; strength ${FIBCL.strong}+)`);
    out.push(` ${f.strong.length ? f.strong.map((q) => `${px(q.center)} (${q.strength})${q.touchedAt >= 0 ? ' touched' : ''}`).join(' · ') : 'no strong cluster'} · golden pocket ${px(f.gp.bot)}–${px(f.gp.top)} · 50% ${px(f.eq.center)}`);
    out.push(` prior week high ${px(f.wk.high)} ${stateWord(f.stHigh)} · low ${px(f.wk.low)} ${stateWord(f.stLow)} · virgin magnets ▲ ${f.magUp ? px(f.magUp.price) : 'none'} · ▼ ${f.magDn ? px(f.magDn.price) : 'none'}`);
  }
  const rg = v.range, n = rg.now, h = n ? n.hi - n.lo : 0;
  out.push('', '<b>Range targets</b> (FEELS)', ` ${n ? `${n.forming ? 'forming range' : 'in range'} ${px(n.lo)}–${px(n.hi)} · IF UP ${px(n.hi + h)} · IF DOWN ${px(n.lo - h)}` : 'no range'} · open targets ▲ ${rg.up ? px(rg.up.px) : 'none'} · ▼ ${rg.dn ? px(rg.dn.px) : 'none'}`);
  return out;
}
const statusWord = (s: DayStatus) => (s === 'Sweep' ? '⚡ Sweep' : s === 'Break' ? '💥 Break' : 'Active');

// ---- change alerts ----
export interface EthEvent { t: number; tf: DnTf; kind: string; key: string; text: string }

/** The change alerts of bar i of one timeframe (its close = t). `lv` = the 4H level series (4H only). */
export function eventsAt(S: TfData, i: number, k: KamaTf, lv: ReadonlyArray<LevelBar> | null, st?: StackSeries): EthEvent[] {
  if (i < 1) return [];
  const c = S.c, b = c[i]!, t = b.openTime + S.ms, tf = S.tf, out: EthEvent[] = [];
  const ev = (kind: string, text: string, extra = '') => out.push({ t, tf, kind, key: `${tf}|${kind}|${t}${extra ? `|${extra}` : ''}`, text: `${text}` });
  const SYM = S.sym, P = `${SYM} · ${tf}`;
  // The KAMA signal first: a taken cross is a signal; a held-off one only ends the open signal.
  k.sigs.forEach((s, n) => {
    if (s.i !== i) return;
    if (!s.heldOff) {
      ev('kama', [`${s.dir > 0 ? '🟢' : '🔴'} ${P} KAMA ${sigWord(s.dir)} ${px(s.price)} · 4H Chop Zone ${s.chop ?? '-'}${s.dir > 0 ? ' ✓' : ''}`, ...noteLines(s.note, s.dir, '   '), `   ${ETH_CARD.label}`].join('\n'), sigWord(s.dir));
      return;
    }
    const prev = n > 0 ? k.sigs[n - 1]! : null;
    if (prev && !prev.heldOff && prev.dir !== s.dir) ev('kama-end', `⏹ ${P} KAMA ${sigWord(prev.dir)} from ${when(prev.time, tf)} ended: ${sigWord(s.dir)} cross ${px(s.price)} (not a new buy: 4H Chop Zone yellow)`);
  });
  if (tf === '4H') {
    const c0 = S.cz.color[i - 1] ?? null, c1 = S.cz.color[i] ?? null;
    if (c1 === 'yellow' && c0 !== 'yellow' && c0 != null) ev('chop', `🟨 ${P} Chop Zone turned yellow (chop) · KAMA buys held off`);
    if (c0 === 'yellow' && c1 != null && c1 !== 'yellow') ev('chop', `${zoneEmoji(c1)} ${P} Chop Zone left yellow → ${c1} (angle ${S.cz.angle[i]})`);
    if (lv) {
      const sameDay = Math.floor(c[i - 1]!.openTime / DAY) === Math.floor(b.openTime / DAY);
      const st0 = sameDay ? dayStatus(lv[i - 1]!, c[i - 1]!.close) : { pdh: 'Active' as DayStatus, pdl: 'Active' as DayStatus }, st1 = dayStatus(lv[i]!, b.close);
      if (st1.pdh !== st0.pdh && st1.pdh !== 'Active') ev('pdh', st1.pdh === 'Sweep' ? `⚡ ${SYM} · PDH ${px(lv[i]!.pdh)} swept (high ${px(lv[i]!.dHi)}, back under)` : `💥 ${SYM} · PDH ${px(lv[i]!.pdh)} broken (close ${px(b.close)})`, st1.pdh);
      if (st1.pdl !== st0.pdl && st1.pdl !== 'Active') ev('pdl', st1.pdl === 'Sweep' ? `⚡ ${SYM} · PDL ${px(lv[i]!.pdl)} swept (low ${px(lv[i]!.dLo)}, back over)` : `💥 ${SYM} · PDL ${px(lv[i]!.pdl)} broken (close ${px(b.close)})`, st1.pdl);
    }
  }
  for (const z of S.obs) {
    if (!shown(S, z)) continue;
    const s = S.obStr.get(z)!;
    if (z.createdAt === i) ev('ob', `${z.side > 0 ? '🟦' : '🟧'} ${P} new ${zoneWord(S, z)} ${sideWord(z.side)} POI ${px(z.bottom)} – ${px(z.top)} (impulse ${s.impulseAtr.toFixed(1)} ATR, volume ${s.volumeMult.toFixed(1)}x)`, `${z.createdAt}`);
    if (z.mitigatedAt === i && (z.droppedAt < 0 || z.droppedAt > i)) ev('ob-mitigated', `⬜ ${P} ${zoneWord(S, z)} ${sideWord(z.side)} POI ${px(z.bottom)} – ${px(z.top)} mitigated`, `${z.createdAt}`);
  }
  if (WYCKOFF_SHOWN[tf]) {
    const wb = S.wy.bars[i]!, sig = wb.sig, has = (bit: number) => Math.floor(sig / bit) % 2 === 1, acc = wb.wdir === DIR_ACCUM;
    const wy = (txt: string, kk: string) => ev(`wyckoff-${kk}`, `🧭 ${P} Wyckoff: ${txt}`);
    if (has(BIT.SC)) wy(`selling climax confirmed (${px(c[i]!.low)}) → Phase A`, 'sc');
    if (has(BIT.BC)) wy(`buying climax confirmed (${px(c[i]!.high)}) → Phase A`, 'bc');
    if (has(BIT.AR) && has(BIT.ST)) wy(`AR and ST confirmed → Phase B (range ${px(wb.rangeLow)} – ${px(wb.rangeHigh)})`, 'b');
    if (has(BIT.SPRING)) wy(`Spring ${px(wb.exc)} → Phase C (accumulation)`, 'spring');
    if (has(BIT.UTAD)) wy(`UTAD ${px(wb.exc)} → Phase C (distribution)`, 'utad');
    if (has(BIT.TEST) || has(BIT.CTEST)) wy(`Phase C test ${px(wb.lastEventPrice)}`, 'test');
    if (has(BIT.SOS)) wy(`SOS ${px(c[i]!.high)} → Phase D (${acc ? 'accumulation' : 'distribution'})`, 'sos');
    if (has(BIT.SOW)) wy(`SOW ${px(c[i]!.low)} → Phase D (${acc ? 'accumulation' : 'distribution'})`, 'sow');
    if (has(BIT.LPS)) wy(`LPS ${px(wb.lastEventPrice)}`, 'lps');
    if (has(BIT.LPSY)) wy(`LPSY ${px(wb.lastEventPrice)}`, 'lpsy');
    if (has(BIT.E)) wy(acc ? 'Phase E: markup underway (range should act as support)' : 'Phase E: markdown underway (range should act as resistance)', 'e');
    for (const e of S.wy.entries) if (e.time === b.openTime) ev('wyckoff-entry', `${e.dir === DIR_ACCUM ? '🟢' : '🔴'} ${P} Wyckoff ${e.dir === DIR_ACCUM ? 'LONG' : 'SHORT'} ENTRY label (${entryKindName(e.kind)}) ${px(e.price)} · ${ETH_CARD.label}`);
  }
  for (const p of S.rib.positions) {
    if (p.i === i) ev('ribbon-flip', `🔁 ${P} trend ribbon flipped ${p.dir > 0 ? 'BULL' : 'BEAR'} · entry ${px(p.entry)} · SL ${px(p.stop)} · ${p.targets.slice(0, 2).map((x, kk) => `T${kk + 1} ${px(x.price)}`).join(' · ')}`);
    p.targets.forEach((x, kk) => { if (x.hitAt === i) ev('ribbon-target', `🎯 ${P} trend ribbon T${kk + 1} hit ${px(x.price)}`, `${p.i}|${kk}`); });
    if (p.endAt === i && p.how === 'stop') ev('ribbon-stop', `🛑 ${P} trend ribbon stop hit ${px(p.stop)}`, `${p.i}`);
  }
  for (const s of S.tri) {
    if (!ON_CARD.trinity || !strongTrinity(s)) continue;
    if (s.i === i) ev('trinity', `${s.dir > 0 ? '▲' : '▼'} ${P} strong ${s.dir > 0 ? 'bullish' : 'bearish'} Trinity reversal · strength ${s.strength.toFixed(0)}% · level ${px(s.level)}`);
    if (s.touchedAt === i) ev('trinity-touch', `📍 ${P} Trinity level ${px(s.level)} touched`, `${s.i}`);
  }
  for (const f of S.fibFlips) if (f.i === i) ev('swing', `↪️ ${P} new swing: ${f.dir > 0 ? 'up' : 'down'} from ${px(f.anchor)} (Fib arcs reset)`);
  for (const h of S.fibHits) {
    if (h.i !== i) continue;
    const how = h.kind === 'swept' ? `swept (${h.up ? `high ${px(b.high)}, back under` : `low ${px(b.low)}, back over`})` : `broken (close ${px(b.close)})`;
    ev('fib', `📐 ${P} Fib arc ${pct(h.ratio)} ${px(h.price)} ${how}`, `${h.anchorBar}|${h.ratio}|${h.kind}`);
  }
  const h0 = S.hist[i - 1], h1 = S.hist[i], r1 = S.rsi[i], r0 = S.rsi[i - 1];
  if (h0 != null && h1 != null && Math.sign(h0) !== Math.sign(h1) && h1 !== 0) ev('macd', `${h1 > 0 ? '📈' : '📉'} ${P} MACD ${h1 > 0 ? 'bullish' : 'bearish'} cross · RSI ${r1 == null ? '-' : r1.toFixed(1)}`);
  if (r0 != null && r1 != null) {
    if (r0 < 70 && r1 >= 70) ev('rsi', `🌡 ${P} RSI over 70 (${r1.toFixed(1)})`);
    if (r0 >= 70 && r1 < 70) ev('rsi', `🌡 ${P} RSI back under 70 (${r1.toFixed(1)})`);
    if (r0 > 30 && r1 <= 30) ev('rsi', `🌡 ${P} RSI under 30 (${r1.toFixed(1)})`);
    if (r0 <= 30 && r1 > 30) ev('rsi', `🌡 ${P} RSI back over 30 (${r1.toFixed(1)})`);
  }
  if (st) out.push(...stackEvents(st, S, i, ev));
  templateEvents(S, i, ev);
  dnEvents(S.c, S.dn, i, tf, SYM, ev);
  for (const d of S.divs) if (d.i === i) ev('rsi-div', `${d.d > 0 ? '↗️' : '↘️'} ${P} RSI ${d.d > 0 ? 'bullish' : 'bearish'} divergence (${d.d > 0 ? 'low' : 'high'} ${when(c[i - 3]!.openTime, tf)})`);
  return out;
}

/**
 * The EMA stack alerts of bar i (emastack.ts): on daily bars the close crossing EMA 26 (and BTC's 144, the 9 / 89 pair,
 * weekly W5 / W34 at the week's close, the short check reaching 2 of 3; ETH's 13 / 21 pair and short confirmation); on
 * 4H bars a trigger cross in the allowed direction, with the limit levels.
 */
function stackEvents(st: StackSeries, S: TfData, i: number, ev: (kind: string, text: string, extra?: string) => void): EthEvent[] {
  const b = S.c[i]!, t = b.openTime + S.ms, a1 = stackAt(st, t), a0 = stackAt(st, t - 1), P = `${S.sym} · ${S.tf}`;
  if (S.tf === '1D') {
    const line = (x: StackAt['bias'], y: StackAt['bias'], kind: string) => { if (x && y && x.over !== y.over) ev(kind, `${x.over ? '⬆️' : '⬇️'} ${P} daily close ${x.over ? 'over' : 'under'} EMA ${x.n} ${px(x.ema)}${x.n === 26 ? (x.over ? ' · bias long' : S.sym === 'BTCUSDT' ? ' · flatten (short only with 2 of 3)' : ' · bias flat') : ''}`); };
    line(a1.bias, a0.bias, 'ema-26');
    line(a1.slow, a0.slow, 'ema-slow');
    if (a1.pair && a0.pair && a1.pair.over !== a0.pair.over) ev('ema-pair', `🔀 ${P} EMA ${a1.pair.fast} crossed ${a1.pair.over ? 'over' : 'under'} EMA ${a1.pair.slow}`);
    if (a1.weekly && a0.weekly && a1.weekly.weekOf !== a0.weekly.weekOf) for (const w of a1.weekly.lines) { const p = a0.weekly.lines.find((x) => x.n === w.n); if (p && p.over !== w.over) ev('ema-weekly', `📅 ${P} weekly close ${w.over ? 'over' : 'under'} W${w.n} ${px(w.ema)}`, `${w.n}`); }
    if (S.sym === 'ETHUSDT' && a1.shortConfirm && !a0.shortConfirm) ev('ema-short', `🔻 ${P} short confirmation on: under EMA 26 with EMA 12 under 26 · ${ETH_CARD.label}`);
    if (S.sym === 'BTCUSDT' && (a1.shortCheck?.count ?? 0) >= 2 && (a0.shortCheck?.count ?? 0) < 2) ev('ema-short', `🔻 ${P} short check ${a1.shortCheck!.count}/3 → short OK · ${ETH_CARD.label}`);
  } else if (a1.trigger && a0.trigger) {
    const side = biasSide(a1);
    a1.trigger.pairs.forEach((p, n) => {
      const q = a0.trigger!.pairs[n];
      if (!q || p.over === q.over || side === 0 || (p.over ? 1 : -1) !== side) return;
      ev('ema-trigger', `🎯 ${P} EMA ${p.fast}/${p.slow} ${p.over ? 'bull' : 'bear'} cross with the daily bias → arms a limit at ${a1.trigger!.limits.map((l) => `EMA ${l.n} ${px(l.v)}`).join(' / ')} · ${ETH_CARD.label}`, `${p.fast}-${p.slow}`);
    });
  }
  return [];
}

/**
 * The round 4 template alerts of bar i (strong items only): S/R zones (a zone first scoring 60+, a 60+ zone broken and
 * flipped, a rejection off a 60+ zone), strong FVGs (new, first touch, filled), the 4H Fib week (prior high / low
 * swept, accepted, failed break; a strong cluster's first touch; a virgin magnet tagged) and range targets (breakout
 * with its target, target reached, retest, failed breakout).
 */
function templateEvents(S: TfData, i: number, ev: (kind: string, text: string, extra?: string) => void): void {
  const b = S.c[i]!, P = `${S.sym} · ${S.tf}`, zs = (z: SrSnap) => `${px(z.bot)}–${px(z.top)}`;
  for (const e of S.sr.events) {
    if (e.i !== i) continue;
    const z = e.zone;
    if (e.kind === 'strong') ev('sr-strong', `🧱 ${P} new strong ${roleWord(z.dir)} zone ${zs(z)} (score ${z.score}, ${srTouches(z)}${srTags(z)})`, `${z.id}`);
    if (e.kind === 'flip' && (e.prevScore ?? 0) >= SRZ.strongScore) ev('sr-flip', `🔄 ${P} strong ${roleWord(-z.dir)} zone ${zs(z)} broken (close ${px(b.close)}) → now ${roleWord(z.dir)} (score ${e.prevScore})`, `${z.id}`);
    if (e.kind === 'reject') ev('sr-reject', `${z.dir === 1 ? '🔻' : '🔺'} ${P} rejection off strong ${roleWord(z.dir)} zone ${zs(z)} (score ${z.score}), close ${px(b.close)}`, `${z.id}`);
  }
  for (const g of S.fo.fvgs) {
    if (!fvgStrong(g) || (g.droppedAt >= 0 && g.droppedAt <= i)) continue;
    const name = `strong ${sideWord(g.side)} FVG ${px(g.bottom)}–${px(g.top)}`;
    if (g.createdAt === i) ev('fvg', `${g.side > 0 ? '🟩' : '🟥'} ${P} new ${name} (${g.sizeAtr.toFixed(1)} ATR, volume ${g.volMult.toFixed(1)}x)`, `${g.createdAt}`);
    if (g.touchedAt === i && g.filledAt !== i) ev('fvg-touch', `📍 ${P} ${name} first touch`, `${g.createdAt}`);
    if (g.filledAt === i) ev('fvg-fill', `⬜ ${P} ${name} filled`, `${g.createdAt}`);
  }
  if (S.fc) {
    const names: Record<string, string> = { 'sweep-high': 'prior week high {p} swept (high {h}, back under)', 'sweep-low': 'prior week low {p} swept (low {l}, back over)', 'accept-high': 'close accepted over the prior week high {p}', 'accept-low': 'close accepted under the prior week low {p}', 'fail-high': 'failed break of the prior week high {p} (close back under)', 'fail-low': 'failed break of the prior week low {p} (close back over)' };
    for (const e of S.fc.events) {
      if (e.i !== i) continue;
      const nm = names[e.kind];
      if (nm) ev('fib-week', `${e.kind.startsWith('sweep') ? '⚡' : e.kind.startsWith('accept') ? '✅' : '↩️'} ${P} ${nm.replace('{p}', px(e.price)).replace('{h}', px(b.high)).replace('{l}', px(b.low))}`, e.kind);
      if (e.kind === 'touch' && e.zone!.kind === 'cluster' && e.zone!.strength >= FIBCL.strong) ev('fib-cluster', `📍 ${P} strong Fib cluster ${px(e.zone!.center)} (strength ${e.zone!.strength}) first touch`, `${e.zone!.center.toFixed(2)}`);
      if (e.kind === 'magnet') ev('fib-magnet', `🧲 ${P} ${e.magnet!.tag} ${px(e.price)} tagged`, `${e.price.toFixed(2)}`);
    }
  }
  for (const e of S.rt.events) {
    if (e.i !== i || !e.target) continue;
    const t = e.target, x = t.box;
    if (e.kind === 'break') ev('range-break', `📦 ${P} range ${px(x.lo)}–${px(x.hi)} broken ${t.up ? 'up' : 'down'} (close ${px(b.close)}) · target ${px(t.px)}${t.quiet ? ' (near an open target)' : ''}`, `${t.from}`);
    if (t.quiet) continue;
    if (e.kind === 'reached') ev('range-target', `🎯 ${P} range target ${px(t.px)} reached (from the ${when(S.c[t.from]!.openTime, S.tf)} breakout)`, `${t.from}`);
    if (e.kind === 'retest') ev('range-retest', `↩️ ${P} retest of the broken range edge ${px(t.edge)}`, `${t.from}`);
    if (e.kind === 'failed') ev('range-fail', `✖️ ${P} range breakout failed: close back ${t.up ? 'under' : 'over'} ${px(t.far)} · target ${px(t.px)} dropped`, `${t.from}`);
  }
}

/** The DiNapoli alerts of bar i: a new setup with its levels, COP / OP / XOP reached, the stop hit. */
function dnEvents(c: ReadonlyArray<Candle>, S: DnSeries, i: number, tf: DnTf, sym: string, ev: (kind: string, text: string, extra?: string) => void, setupsOnly = false): void {
  const P = `${sym} · ${tf}`, side = (s: DnSetup) => (s.dir > 0 ? 'BULL' : 'BEAR'), w = (s: DnSetup) => when(c[s.i]!.openTime, tf === '1D' ? '1D' : '4H');
  for (const s of S.setups) {
    if (s.i === i) ev('dn-setup', [`${s.dir > 0 ? '🟢' : '🔴'} ${P} DiNapoli ${side(s)} setup · entry F${s.node === 618 ? '61.8' : '38.2'} ${px(s.entry)} · SL ${px(s.stop)} · COP ${px(s.cop)} · OP ${px(s.op)} · XOP ${px(s.xop)} · retrace ${Math.round(s.retr * 100)}%${Number.isNaN(s.conf) ? '' : ` · confluence ${px(s.conf)}`}`, `   ${ETH_CARD.label}`].join('\n'), `${s.i}`);
    if (setupsOnly) continue;
    for (const [k, at, lvl] of [['COP', s.copAt, s.cop], ['OP', s.opAt, s.op], ['XOP', s.xopAt, s.xop]] as const) if (at === i) ev('dn-target', `🎯 ${P} DiNapoli ${k} ${px(lvl)} reached (${side(s)} from ${w(s)})`, `${s.i}|${k}`);
    if (s.stopAt === i) ev('dn-stop', `🛑 ${P} DiNapoli stop ${px(s.stop)} hit (${side(s)} from ${w(s)})`, `${s.i}`);
  }
}

/** Every alert of the last closed bars of both timeframes from `since` (4H events at 4H closes, 1D at the daily close). */
export function ethEvents(x: EthBuilt, since: number): EthEvent[] {
  const out: EthEvent[] = [];
  for (const [S, lv] of [[x.d4, x.ctx.lv], [x.dd, null]] as const) {
    for (let i = S.c.length - 1; i >= 1 && S.c[i]!.openTime + S.ms > since; i--) out.push(...eventsAt(S, i, x.kama[S.tf], lv, x.stack));
  }
  // 1H: DiNapoli new setups only, at the 1H close they appear on (owner).
  const h = x.h1.c;
  for (let i = h.length - 1; i >= 1 && h[i]!.openTime + H > since; i--) {
    const t = h[i]!.openTime + H;
    dnEvents(h, x.h1.dn, i, '1H', x.ctx.sym, (kind, text, extra = '') => out.push({ t, tf: '1H', kind, key: `1H|${kind}|${t}${extra ? `|${extra}` : ''}`, text }), true);
  }
  const rank = { '1D': 0, '4H': 1, '1H': 2 } as const;
  return out.sort((a, b) => a.t - b.t || rank[a.tf] - rank[b.tf]);
}

// ---- preview extras ----
/** First-touch hold rates of strong and weak blocks over the history of one timeframe. */
export function zoneCheck(S: TfData): { strong: { n: number; held: number }; weak: { n: number; held: number } } {
  const r = firstTouchHolds(S.c, S.obs), g = (strong: boolean) => { const xs = r.filter((x) => isStrong(S, x.zone) === strong); return { n: xs.length, held: xs.filter((x) => x.held).length }; };
  return { strong: g(true), weak: g(false) };
}

/** Wyckoff coverage (round 2 rule): closes from `from` with a Phase B+ structure, the chart's own and with the override. */
export function wyckoffCoverage(S: TfData, eff: ReadonlyArray<WyEff>, from: number): { closes: number; own: number; withOverride: number; byTf: Record<string, number>; keep: boolean } {
  let closes = 0, own = 0, ov = 0;
  const byTf: Record<string, number> = {};
  for (let i = 0; i < S.c.length; i++) {
    if (S.c[i]!.openTime < from) continue;
    closes++;
    if (S.wy.bars[i]!.phase >= PHASE_B) own++;
    if (eff[i]!.bar.phase >= PHASE_B) { ov++; byTf[eff[i]!.tf] = (byTf[eff[i]!.tf] ?? 0) + 1; }
  }
  return { closes, own, withOverride: ov, byTf, keep: closes > 0 && ov / closes >= WYCKOFF_KEEP_SHARE };
}

/** The KAMA records for the preview: filtered vs every cross, and by confluence count (in-sample, information only). */
export function kamaReport(x: EthBuilt): string[] {
  const out: string[] = [];
  const row = (name: string, t: ReadonlyArray<KamaTrade>) => {
    const s = kamaStats(t);
    return `  ${name}: ${s.signals} signals, ${s.closed} closed, win ${s.closed ? Math.round((100 * s.wins) / s.closed) : 0}% (${s.wins}/${s.closed}), avg ${s.avg == null ? '-' : `${sg(s.avg)}%`} after costs, median ${s.medianBars ?? '-'} bars held, worst run against ${s.worstMae == null ? '-' : `${s.worstMae.toFixed(1)}%`}`;
  };
  for (const tf of ['4H', '1D'] as const) {
    const k = x.kama[tf], S = tf === '4H' ? x.d4 : x.dd, byI = new Map(k.sigs.map((s) => [s.i, s])), n = (t: KamaTrade) => byI.get(t.i)!.note.factors.filter((f) => f.ok).length;
    out.push(`${tf} (since ${Number.isFinite(k.from) ? iso(k.from).slice(0, 10) : '-'}; ${k.sigs.length} crosses, ${k.sigs.filter((s) => s.heldOff).length} buys held off by the 4H Chop Zone):`);
    out.push(row('the card (buys held off in yellow)', k.record), row('every cross (no filter)', k.unfiltered));
    out.push(row('held-off buys (as if taken)', kamaRecord(S.c, k.sigs, (s) => byI.get(s.i)!.heldOff)));
    // Round 4 information (not rules): every cross as if taken, by side and 4H Chop Zone group at the signal.
    for (const side of [1, -1] as const) for (const g of ['up', 'chop', 'down'] as const) out.push(row(`every ${side > 0 ? 'buy' : 'sell'}, 4H Chop Zone ${g === 'up' ? 'green shades' : g === 'chop' ? 'yellow' : 'red shades'}`, k.unfiltered.filter((t) => t.dir === side && zoneGroup(byI.get(t.i)!.chop) === g)));
    // The daily EMA stack at the signal (information): the close on the signal's side of EMA 26; BTC also 144 and 9 / 89.
    const side = (t: KamaTrade, f: (a: StackAt) => boolean | null) => { const v = f(stackAt(x.stack, S.c[t.i]!.openTime + S.ms)); return v == null ? null : v === (t.dir > 0); };
    const ema = [['daily close over EMA 26', (a: StackAt) => a.bias?.over ?? null], ...(x.ctx.sym === 'BTCUSDT' ? [['daily close over EMA 144', (a: StackAt) => a.slow?.over ?? null], ['EMA 9 over 89', (a: StackAt) => a.pair?.over ?? null]] : [])] as [string, (a: StackAt) => boolean | null][];
    for (const [name, f] of ema) out.push(row(`card record, signal on the side of "${name}"`, k.record.filter((t) => side(t, f) === true)), row(`card record, against "${name}"`, k.record.filter((t) => side(t, f) === false)));
    out.push(row('card record, confluence >= 3 (in-sample)', k.record.filter((t) => n(t) >= 3)), row('card record, confluence < 3 (in-sample)', k.record.filter((t) => n(t) < 3)));
  }
  return out;
}

/** Each Outlook metric's agreement with the KAMA signals (round 3, rules in outlook.ts), split over the filtered record. */
export function outlookSplits(x: EthBuilt): Record<CardTf, Record<OutlookMetric, { agree: KamaTrade[]; disagree: KamaTrade[]; na: number }>> {
  const out = {} as Record<CardTf, Record<OutlookMetric, { agree: KamaTrade[]; disagree: KamaTrade[]; na: number }>>;
  for (const tf of ['4H', '1D'] as const) {
    const S = tf === '4H' ? x.d4 : x.dd, k = x.kama[tf], m = {} as Record<OutlookMetric, { agree: KamaTrade[]; disagree: KamaTrade[]; na: number }>;
    for (const name of OUTLOOK_METRICS) m[name] = { agree: [], disagree: [], na: 0 };
    for (const t of k.record) {
      const v = volAt(S, t.i), a = outlookAgree(outlookAt(x.outlook, S.c[t.i]!.openTime + S.ms), t.dir, S.c[t.i]!.close, v.pct, v.relVol, x.ctx.sym === 'ETHUSDT');
      for (const name of OUTLOOK_METRICS) { const g = a[name]; if (g == null) m[name].na++; else m[name][g ? 'agree' : 'disagree'].push(t); }
    }
    out[tf] = m;
  }
  return out;
}
export function outlookReport(x: EthBuilt): string[] {
  const out: string[] = [], sp = outlookSplits(x);
  const cell = (t: ReadonlyArray<KamaTrade>) => { const s = kamaStats(t); return `${s.closed} closed, win ${s.closed ? Math.round((100 * s.wins) / s.closed) : 0}%, avg ${s.avg == null ? '-' : `${sg(s.avg)}%`}`; };
  for (const tf of ['4H', '1D'] as const) {
    out.push(`${tf} (the card's chop-filtered KAMA signals):`);
    for (const name of OUTLOOK_METRICS) { const g = sp[tf][name], lbl = name === 'other ribbon' ? `${x.ctx.sym === 'ETHUSDT' ? 'BTC' : 'ETH'} ribbon` : name; out.push(`  ${lbl.padEnd(16)} agrees: ${cell(g.agree)} | disagrees: ${cell(g.disagree)}${g.na ? ` | n/a ${g.na}` : ''}`); }
  }
  return out;
}

/**
 * Round 4 records of each template event (rules fixed before the run, information only): the uniform score is the
 * close-to-close return in the event's direction 6 bars (4H) / 5 bars (1D) later, less 0.22%. Directions: S/R
 * rejection = the rejection's side; zone flip = the break's side; strong FVG first touch = the gap's side; prior-week
 * sweep or failed break = the fade; acceptance = continuation; strong cluster first touch = against the side price came
 * from; range breakout = the break's side. Plus each script's own outcome: range targets reached / failed / expired and
 * the trade from the breakout close; strong FVGs' first touch held (1 ATR away before a close through).
 */
export const TEMPLATE_RULE = { horizon: { '4H': 6, '1D': 5 } as Record<CardTf, number>, cost: 0.0022 } as const;
export function templateReport(x: EthBuilt): string[] {
  const out: string[] = [];
  for (const S of [x.d4, x.dd]) {
    const h = TEMPLATE_RULE.horizon[S.tf], n = S.c.length, c = S.c;
    const row = (name: string, evs: { i: number; dir: number }[]) => {
      const r = evs.filter((e) => e.dir !== 0 && e.i + h < n).map((e) => e.dir * (c[e.i + h]!.close / c[e.i]!.close - 1) - TEMPLATE_RULE.cost);
      const w = r.filter((v) => v > 0).length, avg = r.length ? (r.reduce((a, v) => a + v, 0) / r.length) * 100 : null;
      return `  ${name.padEnd(58)} ${String(r.length).padStart(4)} events, win ${r.length ? Math.round((100 * w) / r.length) : 0}%, avg ${avg == null ? '-' : `${sg(avg)}%`}`;
    };
    out.push(`${S.tf} (${n} bars from ${iso(c[0]!.openTime).slice(0, 10)}; score after ${h} bars):`);
    const sr = S.sr.events;
    out.push(row('S/R rejection off a strong zone (rejection side)', sr.filter((e) => e.kind === 'reject').map((e) => ({ i: e.i, dir: -e.zone.dir }))));
    out.push(row('S/R flip of a strong zone (break side)', sr.filter((e) => e.kind === 'flip' && (e.prevScore ?? 0) >= SRZ.strongScore).map((e) => ({ i: e.i, dir: -e.zone.dir }))));
    out.push(row('S/R flip, any zone (break side)', sr.filter((e) => e.kind === 'flip').map((e) => ({ i: e.i, dir: -e.zone.dir }))));
    const touched = (g: Fvg) => g.touchedAt >= 0 && (g.droppedAt < 0 || g.droppedAt > g.touchedAt);
    out.push(row('strong FVG first touch (gap side)', S.fo.fvgs.filter((g) => fvgStrong(g) && touched(g)).map((g) => ({ i: g.touchedAt, dir: g.side }))));
    out.push(row('FVG first touch, any (gap side)', S.fo.fvgs.filter(touched).map((g) => ({ i: g.touchedAt, dir: g.side }))));
    if (S.fc) {
      const fe = S.fc.events, of = (k: string, dir: number) => fe.filter((e) => e.kind === k).map((e) => ({ i: e.i, dir }));
      out.push(row('prior-week high / low swept (fade)', [...of('sweep-high', -1), ...of('sweep-low', 1)]));
      out.push(row('prior-week failed break (fade)', [...of('fail-high', -1), ...of('fail-low', 1)]));
      out.push(row('prior-week acceptance (continuation)', [...of('accept-high', 1), ...of('accept-low', -1)]));
      const cl = (strong: boolean) => fe.filter((e) => e.kind === 'touch' && e.zone!.kind === 'cluster' && (e.zone!.strength >= FIBCL.strong) === strong).map((e) => ({ i: e.i, dir: e.zone!.fromSide }));
      out.push(row(`strong Fib cluster (${FIBCL.strong}+) first touch (against the approach)`, cl(true)));
      out.push(row(`Fib cluster ${FIBCL.minStr}-${FIBCL.strong - 1} first touch (against the approach)`, cl(false)));
    }
    out.push(row('range breakout (break side)', S.rt.events.filter((e) => e.kind === 'break').map((e) => ({ i: e.i, dir: e.target!.up ? 1 : -1 }))));
    const oc = S.rt.targets.map((t) => targetOutcome(c, t)), done = oc.filter((o) => o.end !== 'open'), sh = (k: string) => (done.length ? Math.round((100 * done.filter((o) => o.end === k).length) / done.length) : 0);
    const tr = done.map((o) => o.ret - TEMPLATE_RULE.cost);
    out.push(`  range targets (the script's own outcome): ${done.length} resolved, ${oc.length - done.length} open; reached ${sh('reached')}% · failed ${sh('failed')}% · expired ${sh('expired')}%; as a trade from the breakout close to the target / failure close / expiry close: avg ${tr.length ? `${sg((tr.reduce((a, v) => a + v, 0) / tr.length) * 100)}%` : '-'} after costs`);
    const ft = fvgFirstTouch(c, S.fo.fvgs), held = (xs: typeof ft) => `${xs.filter((q) => q.held).length}/${xs.length} held (${xs.length ? Math.round((100 * xs.filter((q) => q.held).length) / xs.length) : 0}%)`;
    out.push(`  FVG first touch held (1 ATR away before a close through): strong ${held(ft.filter((q) => fvgStrong(q.gap)))} · any ${held(ft)}`);
  }
  out.push('  (in-sample, nothing tuned; many event types x 2 timeframes x 2 coins, so some rows will look good by chance)');
  return out;
}

/**
 * DiNapoli records per timeframe (rules fixed before the preview run, information only): the script's own outcome
 * (COP / OP / XOP reached before the stop, among setups whose life ended), each setup as a trade from its signal close
 * (dinapoli.ts dnTrades: out at the stop or OP, else at the next setup's bar close; 0.22% costs), the uniform score
 * (6 bars on 4H / 1H, 5 on 1D) and splits by entry node and confluence.
 */
export function dinapoliReport(x: EthBuilt): string[] {
  const out: string[] = [];
  for (const [tf, c, S] of [['4H', x.d4.c, x.d4.dn], ['1D', x.dd.c, x.dd.dn], ['1H', x.h1.c, x.h1.dn]] as const) {
    if (!c.length) { out.push(`${tf}: no data`); continue; }
    const st = S.setups, ended = st.filter((s) => s.replacedAt >= 0 || s.stopAt >= 0 || s.xopAt >= 0), sh = (f: (s: DnSetup) => boolean) => (ended.length ? `${Math.round((100 * ended.filter(f).length) / ended.length)}%` : '-');
    const before = (at: number, s: DnSetup) => at >= 0 && (s.stopAt < 0 || at < s.stopAt);
    out.push(`${tf} (${c.length} bars from ${iso(c[0]!.openTime).slice(0, 10)}): ${st.length} setups (${st.filter((s) => s.dir > 0).length} bull / ${st.filter((s) => s.dir < 0).length} bear)`);
    out.push(`  script outcome (${ended.length} ended): COP before the stop ${sh((s) => before(s.copAt, s))} · OP ${sh((s) => before(s.opAt, s))} · XOP ${sh((s) => before(s.xopAt, s))} · stop first ${sh((s) => s.stopAt >= 0 && !before(s.copAt, s))} · replaced before either ${sh((s) => s.stopAt < 0 && s.copAt < 0)}`);
    const tr = dnTrades(c, S), row = (name: string, t: typeof tr) => {
      const w = t.filter((q) => q.ret > 0).length, rs = t.filter((q) => Number.isFinite(q.r));
      return `  ${name.padEnd(46)} ${String(t.length).padStart(4)} trades, win ${t.length ? Math.round((100 * w) / t.length) : 0}%, avg ${t.length ? `${sg((t.reduce((a, q) => a + q.ret, 0) / t.length) * 100)}%` : '-'}, avg ${rs.length ? `${sg(rs.reduce((a, q) => a + q.r, 0) / rs.length)}R` : '-'}`;
    };
    out.push(row('as a trade (signal close -> stop / OP / next setup)', tr) + ` · out at OP ${tr.filter((q) => q.how === 'op').length}, stop ${tr.filter((q) => q.how === 'stop').length}, next setup ${tr.filter((q) => q.how === 'replaced').length}`);
    for (const [nm, f] of [['  entry node F38.2', (q: (typeof tr)[number]) => q.s.node === 382], ['  entry node F61.8', (q: (typeof tr)[number]) => q.s.node === 618], ['  with confluence', (q: (typeof tr)[number]) => !Number.isNaN(q.s.conf)], ['  without confluence', (q: (typeof tr)[number]) => Number.isNaN(q.s.conf)], ['  bull', (q: (typeof tr)[number]) => q.s.dir > 0], ['  bear', (q: (typeof tr)[number]) => q.s.dir < 0]] as const) out.push(row(nm, tr.filter(f)));
    const h = tf === '1D' ? 5 : 6, sc = st.filter((s) => s.i + h < c.length).map((s) => s.dir * (c[s.i + h]!.close / c[s.i]!.close - 1) - 0.0022);
    out.push(`  uniform score after ${h} bars: ${sc.length} setups, win ${sc.length ? Math.round((100 * sc.filter((v) => v > 0).length) / sc.length) : 0}%, avg ${sc.length ? `${sg((sc.reduce((a, v) => a + v, 0) / sc.length) * 100)}%` : '-'}`);
  }
  out.push('  (in-sample, nothing tuned; 3 timeframes x 2 coins and several splits, so some rows will look good by chance)');
  return out;
}

/** The chart-check list: what the scripts show now, with UTC bar times, to compare with TradingView. */
const dnCheck = (c: ReadonlyArray<Candle>, S: DnSeries) => {
  const t = (k: number) => (k >= 0 ? iso(c[k]!.openTime).slice(0, 16).replace('T', ' ') : '-');
  return S.setups.slice(-3).map((s) => `${s.dir > 0 ? 'BULL' : 'BEAR'} @${t(s.i)} A ${px(s.a)} B ${px(s.b)} C ${px(s.c)} @${t(s.cBar)} retrace ${(s.retr * 100).toFixed(1)}% entry ${px(s.entry)} SL ${px(s.stop)} COP ${px(s.cop)}${s.copAt >= 0 ? ` ✓@${t(s.copAt)}` : ''} OP ${px(s.op)}${s.opAt >= 0 ? ` ✓@${t(s.opAt)}` : ''} XOP ${px(s.xop)}${s.xopAt >= 0 ? ` ✓@${t(s.xopAt)}` : ''}${s.stopAt >= 0 ? ` stop @${t(s.stopAt)}` : ''}${Number.isNaN(s.conf) ? '' : ` conf ${px(s.conf)}`}`).join('; ') || 'none';
};
export function chartCheck(x: EthBuilt): string[] {
  const { card, d4, dd } = x, out: string[] = [`CHART CHECK (${card.symbol}, default settings; bar open times UTC):`];
  const L = card.levels;
  out.push(`  Shaakuni levels: PWH ${px(L.pwh)} PWL ${px(L.pwl)} W-EQ ${px(L.weq)} | PDH ${px(L.pdh)} (${L.pdhStatus}) PDL ${px(L.pdl)} (${L.pdlStatus}) D-EQ ${px(L.deq)} | week before ${px(L.pwh2)} / ${px(L.pwl2)}`);
  for (const S of [d4, dd]) {
    const i = S.c.length - 1, t = (k: number) => iso(S.c[k]!.openTime).slice(0, 16).replace('T', ' ');
    out.push(`  ${S.tf}:`);
    const k = x.kama[S.tf];
    out.push(`    KAMA crosses (last 5): ${k.sigs.slice(-5).map((s) => `${sigWord(s.dir)} @${t(s.i)} close ${px(s.price)} fast ${px(k.line.fast[s.i])} slow ${px(k.line.slow[s.i])}${s.heldOff ? ' (held off: 4H chop)' : ''}`).join('; ') || 'none'}; now fast ${px(k.line.fast[i])} slow ${px(k.line.slow[i])}`);
    if (S.tf === '4H') {
      const from = Math.max(SHAAKUNI.swingLen + 3, i - 29), tries: string[] = [];
      for (let q = from; q <= i; q++) for (const d of [1, -1] as const) {
        const r = obTry(S.c, q, S.atr[q]!, d);
        if ('why' in r && r.why === 'no break') continue;
        tries.push(`${t(q)} ${sideWord(d)}: ${'why' in r ? r.why : `block ${px(S.c[q - r.obOff]!.low)}-${px(S.c[q - r.obOff]!.high)} @${t(q - r.obOff)}`}`);
      }
      out.push(`    order-block test on the last 30 bars (bars that broke a 10-bar high / low): ${tries.join('; ') || 'none'}`);
    }
    const act = activeBlocks(S.obs, i);
    out.push(`    order blocks shown (unmitigated): ${act.length ? act.map((z) => `${sideWord(z.side)} ${px(z.bottom)}-${px(z.top)} @${t(z.obBar)} (${S.obStr.get(z)!.strong ? 'strong' : 'weak'}: ${S.obStr.get(z)!.impulseAtr.toFixed(2)} ATR, ${S.obStr.get(z)!.volumeMult.toFixed(2)}x)`).join('; ') : 'none'}`);
    const e = x.ctx.wy[S.tf][i]!;
    out.push(`    Wyckoff shown: ${e.tf}${e.tf === S.tf ? ' (own)' : ' (override)'} ${typeName(e.bar.type)} ${phaseName(e.bar.phase)}${Number.isNaN(e.bar.rangeHigh) ? '' : ` range ${px(e.bar.rangeLow)}-${px(e.bar.rangeHigh)}`}; own ${typeName(S.wy.bars[i]!.type)} ${phaseName(S.wy.state.phase)}; resets ${JSON.stringify(S.wy.resets)}`);
    out.push(`    Wyckoff entry labels (last 5): ${S.wy.entries.slice(-5).map((en) => `${en.dir > 0 ? 'LONG' : 'SHORT'} ${entryKindName(en.kind)} ${px(en.price)} @${iso(en.time).slice(0, 16).replace('T', ' ')}`).join('; ') || 'none'}`);
    out.push(`    trend ribbon (last 3): ${S.rib.positions.slice(-3).map((p) => `${p.dir > 0 ? 'BULL' : 'BEAR'} @${t(p.i)} entry ${px(p.entry)} SL ${px(p.stop)} targets ${p.targets.map((y) => `${px(y.price)}${y.hitAt >= 0 ? '✓' : ''}`).join('/')}${p.how ? ` ended ${p.how} @${t(p.endAt)}` : ''}`).join('; ')}`);
    if (ON_CARD.trinity) out.push(`    Trinity (last 5): ${S.tri.slice(-5).map((s) => `${s.dir > 0 ? '▲' : '▼'} @${t(s.i)} ${s.strength.toFixed(1)}% level ${px(s.level)}${s.touchedAt >= 0 ? ` touched @${t(s.touchedAt)}` : s.expiredAt >= 0 ? ' expired' : ''}`).join('; ')}`);
    const g = S.fib;
    out.push(`    Fib swing: ${g ? `${g.dir > 0 ? 'up' : 'down'} from ${px(g.anchor)} @${t(g.anchorBar)} to ${px(g.extreme)} @${t(g.extremeBar)}; arcs now ${g.arcs.map((a) => `${pct(a.ratio)} ${px(a.price)}`).join(' ')}; last arc alerts ${S.fibHits.slice(-3).map((h) => `${pct(h.ratio)} ${px(h.price)} ${h.kind} @${t(h.i)}`).join('; ') || 'none'}` : 'none'}`);
    out.push(`    RSI ${S.rsi[i]?.toFixed(2)} MACD ${S.line[i]?.toFixed(2)} / ${S.sig[i]?.toFixed(2)} Chop Zone ${S.cz.color[i] ?? '-'} (angle ${S.cz.angle[i]}) ATR ${S.atr[i]?.toFixed(2)}`);
    const zs = S.sr.snaps[i] ?? [];
    out.push(`    S/R zones now (all, with score; strong = ${SRZ.strongScore}+): ${zs.map((z) => `${z.dir === 1 ? 'R' : 'S'} ${px(z.bot)}-${px(z.top)} ${z.score} ${srTouches(z)}${srTags(z)}`).join('; ') || 'none'}`);
    out.push(`    FVGs on the chart, unfilled: ${S.fo.fvgs.filter((q) => fvgActive(q, i)).map((q) => `${sideWord(q.side)} ${px(q.bottom)}-${px(q.top)} @${t(q.leftBar + 1)} ${q.sizeAtr.toFixed(2)} ATR ${q.volMult.toFixed(2)}x${fvgStrong(q) ? ' strong' : ''}`).join('; ') || 'none'}`);
    out.push(`    IOB blocks, unmitigated: ${S.fo.blocks.filter((q) => blockActive(q, i)).map((q) => `${sideWord(q.side)} ${px(q.bottom)}-${px(q.top)} @${t(q.obBar)} (break @${t(q.createdAt)}, ${q.str.strong ? 'strong' : 'weak'}: ${q.str.impulseAtr.toFixed(2)} ATR, ${q.str.volumeMult.toFixed(2)}x)`).join('; ') || 'none'}`);
    if (S.fc && S.fc.weekAt[i]! >= 0) {
      const wk = S.fc.weeks[S.fc.weekAt[i]!]!;
      out.push(`    Fib week (built @${t(wk.i)} from H ${px(wk.high)} / L ${px(wk.low)}, ATR ${wk.atr.toFixed(2)}): ${wk.zones.map((z) => `${z.tag} ${px(z.center)}${z.touchedAt >= 0 ? ` touched @${t(z.touchedAt)}` : ''}`).join('; ')}; high ${stateWord(S.fc.stHigh[i]!)}, low ${stateWord(S.fc.stLow[i]!)}; magnets ${liveMagnets(S.fc, i).map((m) => `${m.tag} ${px(m.price)}`).join('; ') || 'none'}`);
    }
    out.push(`    DiNapoli setups (last 3): ${dnCheck(S.c, S.dn)}`);
    const rn = rangeAt(S, i, S.c[i]!.close);
    out.push(`    range now: ${rn.now ? `${rn.now.forming ? 'forming' : 'waiting'} ${px(rn.now.lo)}-${px(rn.now.hi)} from @${t(rn.now.left)}` : 'none'}; open targets ${openTargets(S.rt, i).map((q) => `${q.up ? '▲' : '▼'} ${px(q.px)} (break @${t(q.from)}${q.quiet ? ', quiet' : ''})`).join('; ') || 'none'}; last 3 breakouts ${S.rt.targets.slice(-3).map((q) => `${q.up ? 'up' : 'down'} @${t(q.from)} box ${px(q.box.lo)}-${px(q.box.hi)} target ${px(q.px)} ${targetOutcome(S.c, q).end}`).join('; ') || 'none'}`);
    if (S.tf === '1D') { const st = x.stack, k = S.c.length - 1, e = (n: number) => st.dEma.get(n)?.[k]; out.push(`    daily EMAs at the last close ${px(S.c[k]!.close)}: ${[8, 9, 12, 13, 21, 26, 50, 89, 144].map((n) => { const v = e(n) ?? NaN; return Number.isNaN(v) ? null : `${n} ${px(v)}`; }).filter(Boolean).join(' · ') || '-'}`); }
  }
  out.push(`  1H:`, `    DiNapoli setups (last 3): ${x.h1.c.length ? dnCheck(x.h1.c, x.h1.dn) : 'no 1H data'}`);
  return out;
}

export { ZONE_RULE };
