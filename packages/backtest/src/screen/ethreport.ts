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
// Pure.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi } from '../indicators';
import { CHOP, chopIndex, chopState, type ChopState } from './chop';
import { fibArcHits, fibArcs, fibStates, type FibArcHit, type FibArcs, type FibSwingFlip } from './fibarcs';
import { KAMA, kama4h, kamaCrosses, kamaDaily, kamaRecord, kamaStats, type KamaCross, type KamaLine, type KamaStats, type KamaTrade } from './kama';
import { macdState } from './macdstate';
import { OUTLOOK, OUTLOOK_METRICS, outlookAgree, outlookAt, outlookSeries, pctRank, volSeries, type OutlookAt, type OutlookMetric, type OutlookSeries } from './outlook';
import { coinVolume } from './pine';
import { divergenceEvents, type WeeklyEvent } from './rsimap';
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

/** Every series of one timeframe, computed once over its closed bars. */
export interface TfData {
  tf: CardTf; ms: number; c: ReadonlyArray<Candle>; atr: (number | null)[]; rsi: (number | null)[]; line: (number | null)[]; sig: (number | null)[]; hist: (number | null)[];
  chop: number[]; rib: RibbonSeries; tri: TrinitySignal[]; obs: ObZone[]; obStr: Map<ObZone, ObStrength>; wy: WyckoffResult; fibFlips: FibSwingFlip[]; fib: FibArcs | null; fibHits: FibArcHit[]; divs: WeeklyEvent[];
  /** Bollinger bandwidth (% of the mid) and relative volume per bar (outlook.ts). */
  vol: { width: number[]; relVol: number[] };
}

export function tfData(c: ReadonlyArray<Candle>, tf: CardTf): TfData {
  const ms = tf === '4H' ? H4 : DAY, close = c.map((b) => b.close), m = macdLines(close), vol = coinVolume(c), r = rsi(close, 14);
  const obs = shaakuniBlocks(c, ms), fa = fibArcs(c);
  return {
    tf, ms, c, atr: atrWilder(c, 14), rsi: r, line: m.line, sig: m.sig, hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    chop: chopIndex(c), rib: trendRibbon(c), tri: trinity(c), obs, obStr: new Map(obs.map((z) => [z, obStrength(c, z, vol)])), wy: wyckoff(c, ms),
    fibFlips: fa.flips, fib: fa.last, fibHits: fibArcHits(c, fibStates(c).states), divs: divergenceEvents(c, r, 5, 3, 5, 40), vol: volSeries(c),
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

/** Both timeframes' data, the 4H level series and Wyckoff as shown (with the override) per bar. */
export interface Ctx { d4: TfData; dd: TfData; lv: LevelBar[]; wy: Record<CardTf, WyEff[]> }

/** What the card shows at time t (a bar close): the levels, both timeframes' shown zones and active strong Trinity levels. */
function shownAt(x: Ctx, t: number) {
  const k4 = lastClosed(x.d4.c, H4, t), kd = lastClosed(x.dd.c, DAY, t);
  const L = levelsFrom(k4 >= 0 ? x.lv[k4] : undefined, k4 >= 0 ? x.d4.c[k4] : undefined, t);
  const zones = [...(k4 >= 0 ? activeBlocks(x.d4.obs, k4).filter((z) => shown(x.d4, z)).map((z) => ({ z, S: x.d4 })) : []), ...(kd >= 0 ? activeBlocks(x.dd.obs, kd).filter((z) => shown(x.dd, z)).map((z) => ({ z, S: x.dd })) : [])];
  const tri = [...(k4 >= 0 ? activeTrinity(x.d4, k4).filter(strongTrinity).map((s) => ({ s, tf: '4H' as CardTf })) : []), ...(kd >= 0 ? activeTrinity(x.dd, kd).filter(strongTrinity).map((s) => ({ s, tf: '1D' as CardTf })) : [])];
  return { k4, kd, levels: displayLevels(L), zones, tri };
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
const SYM = ETH_CARD.symbol;

// ---- the KAMA signal ----
export interface NoteLevel { label: string; price: number; atr: number }
export interface KamaNote { factors: { name: string; ok: boolean }[]; support: NoteLevel[]; next: NoteLevel | null }
/** The notes printed with a KAMA cross of S at bar i (see the header). */
export function kamaNotes(x: Ctx, S: TfData, i: number, dir: 1 | -1): KamaNote {
  const t = S.c[i]!.openTime + S.ms, price = S.c[i]!.close, a = S.atr[i] ?? NaN, sh = shownAt(x, t);
  const items: { label: string; edge: number; side: number; zone: boolean }[] = [
    ...sh.levels.map((l) => ({ label: l.label, edge: l.price, side: 0, zone: false })),
    ...sh.zones.map(({ z, S: T }) => ({ label: `${T.tf} ${sideWord(z.side)} POI ${px(z.bottom)}–${px(z.top)}`, edge: price > z.top ? z.top : price < z.bottom ? z.bottom : price, side: z.side, zone: true })),
    ...sh.tri.map(({ s, tf }) => ({ label: `${tf} Trinity ${s.dir > 0 ? '▲' : '▼'}`, edge: s.level, side: s.dir, zone: true })),
  ];
  const dist = (e: number) => Math.abs(price - e), near = (p: { edge: number }, q: { edge: number }) => dist(p.edge) - dist(q.edge);
  const below = items.filter((v) => v.edge <= price).sort(near), above = items.filter((v) => v.edge >= price).sort(near);
  const [mine, other] = dir > 0 ? [below, above] : [above, below];
  const note = (v: { label: string; edge: number }): NoteLevel => ({ label: v.label, price: v.edge, atr: a > 0 ? dist(v.edge) / a : NaN });
  const otherTf = S.tf === '4H' ? x.dd : x.d4, ko = S.tf === '4H' ? sh.kd : sh.k4, h = S.hist[i], r = S.rsi[i];
  const factors = [
    { name: `ribbon ${S.tf}`, ok: S.rib.trend[i] === dir },
    { name: `ribbon ${otherTf.tf}`, ok: ko >= 0 && otherTf.rib.trend[ko] === dir },
    { name: 'MACD', ok: h != null && Math.sign(h) === dir },
    { name: 'RSI', ok: r != null && (dir > 0 ? r > 50 : r < 50) },
    { name: dir > 0 ? 'support zone' : 'resistance zone', ok: mine.some((v) => v.zone && v.side === dir && dist(v.edge) <= ETH_CARD.nearAtr * a) },
  ];
  if (WYCKOFF_SHOWN[S.tf]) { const w = x.wy[S.tf][i]!.bar; factors.push({ name: 'Wyckoff', ok: w.phase >= PHASE_B && w.wdir === dir }); }
  return { factors, support: mine.slice(0, ETH_CARD.supports).map(note), next: other[0] ? note(other[0]) : null };
}

export interface KamaSig extends KamaCross { tf: CardTf; time: number; price: number; chop: ChopState; heldOff: boolean; note: KamaNote }
export interface KamaTf { line: KamaLine; sigs: KamaSig[]; record: KamaTrade[]; unfiltered: KamaTrade[]; from: number }
/** Both timeframes' KAMA lines, crosses (with the chop filter and notes) and records, from the 4H history's warm-up on. */
export function kamaState(x: Ctx): Record<CardTf, KamaTf> {
  const h4 = x.d4.c, d1 = x.dd.c, start = h4[Math.min(KAMA.warmup, h4.length - 1)]?.openTime ?? Infinity;
  const one = (S: TfData, line: KamaLine): KamaTf => {
    let from = KAMA.warmup;
    while (from < S.c.length && S.c[from]!.openTime < start) from++;
    const sigs = kamaCrosses(line, from).map((cr): KamaSig => {
      const t = S.c[cr.i]!.openTime + S.ms, k4 = lastClosed(h4, H4, t), ch = k4 >= 0 ? chopState(x.d4.chop, k4) : 'neutral';
      return { ...cr, tf: S.tf, time: S.c[cr.i]!.openTime, price: S.c[cr.i]!.close, chop: ch, heldOff: ch === 'chop', note: kamaNotes(x, S, cr.i, cr.dir) };
    });
    const held = new Set(sigs.filter((s) => s.heldOff).map((s) => s.i));
    return { line, sigs, record: kamaRecord(S.c, sigs, (s) => !held.has(s.i)), unfiltered: kamaRecord(S.c, sigs, () => true), from: S.c[from]?.openTime ?? NaN };
  };
  return { '4H': one(x.d4, kama4h(h4, d1)), '1D': one(x.dd, kamaDaily(d1)) };
}
const sigWord = (d: number) => (d > 0 ? 'BUY' : 'SELL');
const noteLines = (n: KamaNote, dir: number, pad: string) => [
  `${pad}confluence ${n.factors.filter((f) => f.ok).length}/${n.factors.length}: ${n.factors.map((f) => `${f.name} ${f.ok ? '✓' : '✗'}`).join(' · ')}`,
  `${pad}${dir > 0 ? 'support' : 'resistance'} ${n.support.length ? n.support.map((l) => `${esc(l.label)} ${px(l.price)} (${l.atr.toFixed(1)} ATR)`).join(' · ') : 'none shown'}${n.next ? ` · next ${dir > 0 ? 'resistance' : 'support'} ${esc(n.next.label)} ${px(n.next.price)} (${n.next.atr.toFixed(1)} ATR)` : ''}`,
];

export interface CardInput {
  m15: ReadonlyArray<Candle>; h4: ReadonlyArray<Candle>; d1: ReadonlyArray<Candle>; funding: { rate: number; intervalHours: number } | null; now: number;
  /** For the Outlook section: BTCUSDT daily bars and ETH's settled funding history (empty = those lines say "no data"). */
  btcD1?: ReadonlyArray<Candle>; fundingHistory?: ReadonlyArray<{ time: number; rate: number }>;
}
export interface KamaView { tf: CardTf; last: KamaSig | null; fast: number; slow: number; stats: KamaStats; from: number }
export interface EthCard {
  at: number; price: number; change24h: number | null; high24h: number; low24h: number; funding: CardInput['funding'];
  levels: ShaakuniLevels; tf: Record<CardTf, TfView>; kama: Record<CardTf, KamaView>;
  outlook: { at: OutlookAt; price: number; vol: Record<CardTf, ReturnType<typeof volAt>> };
}
export interface TfView {
  tf: CardTf; barAt: number; chop: number; chopState: ChopState; rsi: number | null; macd: string; rsiDiv: string | null;
  zones: { z: ObZone; s: ObStrength; tags: string[]; time: number }[];
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
  const zones = picked.shown.map((z) => ({ z, s: S.obStr.get(z)!, tags: confluence(z, a, tagWith), time: S.c[z.obBar]!.openTime }));
  const own = wy.tf === S.tf, wb = wy.bar;
  const pos = activePosition(S, i) ?? S.rib.positions.at(-1) ?? null, trend = S.rib.trend[i]!;
  const strongTri = S.tri.filter((s) => s.i <= i && i - s.i < 100 && strongTrinity(s));
  return {
    tf: S.tf, barAt: S.c[i]!.openTime + S.ms, chop: S.chop[i]!, chopState: chopState(S.chop, i), rsi: S.rsi[i] ?? null, macd: macdText(S, i),
    rsiDiv: div ? `RSI ${div.d > 0 ? 'bullish' : 'bearish'} divergence (${div.d > 0 ? 'low' : 'high'} ${when(S.c[div.i - 3]!.openTime, S.tf)})` : null,
    zones,
    wyckoff: {
      from: wy.tf, type: typeName(wb.type), phase: wb.phase, phaseName: phaseName(wb.phase), event: eventName(wb.ev), eventPrice: wb.lastEventPrice, rangeHigh: wb.rangeHigh, rangeLow: wb.rangeLow,
      conf: wb.conf, val: wb.val, next: own ? S.wy.next : null, lastEntry: own ? (S.wy.entries.at(-1) ?? null) : null,
    },
    ribbon: { trend, flipAt: pos ? S.c[pos.i]!.openTime : null, bars: pos ? i - pos.i : 0, conviction: S.rib.conviction[i]!, pos },
    trinity: { last: strongTri.at(-1) ?? null, lastTime: strongTri.length ? S.c[strongTri.at(-1)!.i]!.openTime : 0, levels: activeTrinity(S, i).filter(strongTrinity).map((s) => ({ s, tags: confluence({ top: s.level, bottom: s.level }, a, tagWith) })) },
  };
}

const kamaView = (S: TfData, k: KamaTf): KamaView => ({ tf: S.tf, last: k.sigs.at(-1) ?? null, fast: k.line.fast[S.c.length - 1]!, slow: k.line.slow[S.c.length - 1]!, stats: kamaStats(k.record), from: k.from });

export interface EthBuilt { card: EthCard; d4: TfData; dd: TfData; ctx: Ctx; kama: Record<CardTf, KamaTf>; outlook: OutlookSeries }
/**
 * Everything the card shows at the last closed bars. `d1` can reach further back than `h4`: the 1D engines and the
 * weekly / monthly Wyckoff of the override use all of it.
 */
export function ethCard(inp: CardInput): EthBuilt {
  const d4 = tfData(inp.h4, '4H'), dd = tfData(inp.d1, '1D'), lv = shaakuniLevelSeries(inp.h4);
  const wm = htfSeries(inp.d1, ['W', 'M']), dSeries: HtfSeries = { tf: 'D', c: [...inp.d1], ends: inp.d1.map((b) => b.openTime + DAY), wy: dd.wy };
  const wy = { '4H': wyckoffEffective(inp.h4, d4.wy, '4H', [dSeries, ...wm]), '1D': wyckoffEffective(inp.d1, dd.wy, '1D', wm) };
  const ctx: Ctx = { d4, dd, lv, wy }, kama = kamaState(ctx), outlook = outlookSeries(inp.d1, inp.btcD1 ?? [], inp.fundingHistory ?? []);
  const m = inp.m15, last = m[m.length - 1]!, from = last.openTime + 15 * 60_000 - DAY;
  const day = m.filter((b) => b.openTime >= from), ago = [...m].reverse().find((b) => b.openTime + 15 * 60_000 <= from);
  const levels = levelsFrom(lv.at(-1), inp.h4.at(-1), inp.now), shownLevels = displayLevels(levels);
  const ddAct = activeBlocks(dd.obs, dd.c.length - 1).filter((z) => shown(dd, z));
  const card: EthCard = {
    at: inp.now, price: last.close, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    levels, tf: { '4H': tfView(d4, shownLevels, ddAct, wy['4H'].at(-1)!), '1D': tfView(dd, shownLevels, [], wy['1D'].at(-1)!) },
    kama: { '4H': kamaView(d4, kama['4H']), '1D': kamaView(dd, kama['1D']) },
    outlook: { at: outlookAt(outlook, inp.now), price: inp.h4.at(-1)?.close ?? NaN, vol: { '4H': volAt(d4, d4.c.length - 1), '1D': volAt(dd, dd.c.length - 1) } },
  };
  return { card, d4, dd, ctx, kama, outlook };
}

function kamaLines(v: KamaView): string[] {
  const now = `now fast ${px(v.fast)} ${v.fast >= v.slow ? 'over' : 'under'} slow ${px(v.slow)}`, s = v.last;
  if (!s) return [` ${v.tf} no cross yet · ${now}`];
  const at = `${sigWord(s.dir)} ${when(s.time, v.tf)}`;
  if (s.heldOff) return [` ${v.tf} no live signal: last cross ${at} at ${px(s.price)} held off (4H chop) · ${now}`];
  return [` ${v.tf} ${s.dir > 0 ? '🟢' : '🔴'} ${at} at ${px(s.price)} · ${now}`, ...noteLines(s.note, s.dir, '    ')];
}
const ord = (p: number) => `${Math.round(p)}${[11, 12, 13].includes(Math.round(p) % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][Math.round(p) % 10] ?? 'th'} pct`;
function outlookLines(o: EthCard['outlook']): string[] {
  const { btc, weekly: w, funding: f } = o.at, out = ['', '<b>Outlook</b>'];
  out.push(btc ? ` BTC 1D ${btc.trend > 0 ? '🟢 ribbon bull' : btc.trend < 0 ? '🔴 ribbon bear' : 'ribbon -'} · KAMA ${btc.kamaOver == null ? '-' : btc.kamaOver ? 'over' : 'under'} · ETH/BTC ${btc.ratio.toPrecision(4)}${btc.ratioChg7 == null ? '' : ` (7d ${sg(btc.ratioChg7, 1)}%)`}${btc.ratioOverEma == null ? '' : `, ${btc.ratioOverEma ? 'over' : 'under'} its 20-day EMA: ETH ${btc.ratioOverEma ? 'leading' : 'lagging'}`}` : ' BTC no data');
  out.push(w ? ` Weekly (week of ${iso(w.weekOf).slice(5, 10)}) RSI ${w.rsi == null ? '-' : w.rsi.toFixed(1)} · ${w.ema == null ? '50-week EMA -' : `${o.price >= w.ema ? 'over' : 'under'} the 50-week EMA ${px(w.ema)} (${sg((o.price / w.ema - 1) * 100, 1)}%)`}` : ' Weekly no closed week yet');
  const v = (t: CardTf) => { const x = o.vol[t]; return `${t} BB width ${Number.isNaN(x.width) ? '-' : `${x.width.toFixed(1)}%`}${x.pct == null ? '' : ` (${ord(x.pct)}, 180d)${x.pct <= OUTLOOK.squeezePct ? ' squeeze' : x.pct >= OUTLOOK.expandPct ? ' expanding' : ''}`}`; };
  const atr = (t: CardTf) => (o.vol[t].atrPct == null ? '-' : `${o.vol[t].atrPct!.toFixed(1)}%`);
  out.push(` Volatility ${v('4H')} · ${v('1D')} · ATR 4H ${atr('4H')} / 1D ${atr('1D')}`);
  const rv = (t: CardTf) => (Number.isNaN(o.vol[t].relVol) ? '-' : `${o.vol[t].relVol.toFixed(1)}x`);
  const fp = (r: number) => `${sg(r * 100, 4)}%`;
  out.push(` Volume 4H ${rv('4H')} the 20-bar avg · 1D ${rv('1D')} · ${f ? `funding 7d avg ${fp(f.avg7)}, ${f.recent > f.prior ? 'rising' : f.recent < f.prior ? 'falling' : 'flat'} (90d median ${fp(f.median90)})` : 'funding history: no data'}`);
  return out;
}
const recordLine = (v: KamaView) => {
  const st = v.stats;
  return ` Record ${v.tf} (since ${Number.isFinite(v.from) ? iso(v.from).slice(0, 10) : '-'}, 4H chop filter, held to the opposite cross): ${st.closed} closed, win ${st.closed ? Math.round((100 * st.wins) / st.closed) : 0}% (${st.wins}/${st.closed}), avg ${st.avg == null ? '-' : `${sg(st.avg)}%`}`;
};

/** The card as Telegram HTML; one message, or two when it passes 4,096 characters. */
export function ethCardText(card: EthCard): string[] {
  const { tf, levels: L } = card, f = card.funding;
  const head = [
    `📊 <b>${SYM}</b> · 4H card · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})${f ? ` · funding ${sg(f.rate * 100, 4)}% / ${f.intervalHours}h` : ''}`,
    '',
    `<b>KAMA signal</b> (daily HA vs EMA 20 of KAMA) · ${ETH_CARD.label}`,
    ...kamaLines(card.kama['4H']), ...kamaLines(card.kama['1D']), recordLine(card.kama['4H']), recordLine(card.kama['1D']),
    ...outlookLines(card.outlook),
  ];
  const chopWord = (v: TfView) => (v.chopState === 'chop' ? '⛔ chop: KAMA signals held off' : v.chopState === 'fading' ? '🌤 chop fading' : v.chopState === 'trending' ? 'trending' : 'neutral');
  const a = [
    '', `<b>Chop</b> (CHOP ${CHOP.len})`, ...(['4H', '1D'] as const).map((t) => ` ${t} ${tf[t].chop.toFixed(1)} ${t === '4H' ? chopWord(tf[t]) : tf[t].chopState}`),
    '', '<b>RSI 14 / MACD 12/26/9</b>', ...(['4H', '1D'] as const).map((t) => ` ${t} RSI ${tf[t].rsi == null ? '-' : tf[t].rsi!.toFixed(1)} · ${tf[t].macd}${tf[t].rsiDiv ? ` · ${tf[t].rsiDiv}` : ''}`),
    '', '<b>Levels</b> (Shaakuni)',
    ` PWH ${px(L.pwh)} · W-EQ ${px(L.weq)} · PWL ${px(L.pwl)} · week before: high ${px(L.pwh2)} · low ${px(L.pwl2)}`,
    ` PDH ${px(L.pdh)} ${statusWord(L.pdhStatus)} · D-EQ ${px(L.deq)} · PDL ${px(L.pdl)} ${statusWord(L.pdlStatus)} · Session: ${L.session === '-' ? 'none' : L.session}`,
    ' Order blocks, unmitigated (4H strong only; 1D strong or weak):',
    ...(['4H', '1D'] as const).map((t) => `  ${t} ${tf[t].zones.length ? tf[t].zones.map((x) => `${x.z.side > 0 ? '🟦 bull' : '🟧 bear'} POI${x.s.strong ? '' : ' (weak)'} ${px(x.z.bottom)} – ${px(x.z.top)} (${when(x.time, t)}) · impulse ${x.s.impulseAtr.toFixed(1)} ATR, volume ${x.s.volumeMult.toFixed(1)}x${x.tags.length ? `, at ${esc(x.tags.join(' / '))}` : ''}`).join(' · ') : t === '4H' ? 'none strong' : 'none'}`),
  ];
  const b: string[] = [];
  const wyTfs = (['4H', '1D'] as const).filter((t) => WYCKOFF_SHOWN[t]);
  if (wyTfs.length) b.push('', '<b>Wyckoff</b>');
  for (const t of wyTfs) {
    const w = tf[t].wyckoff, src = w.from === t ? '' : ` (from ${w.from})`;
    if (w.phase === 0) { b.push(` ${t} Searching for SC / BC`); continue; }
    b.push(` ${t}${src} ${w.type} · Phase ${w.phaseName.slice(0, 1)} (${esc(w.event)} ${px(w.eventPrice)})${Number.isNaN(w.rangeHigh) ? '' : ` · range ${px(w.rangeLow)} – ${px(w.rangeHigh)}`}`);
    b.push(`    maturity ${w.conf} · validation ${w.val}${w.next ? ` · next: ${esc(w.next)}` : ''}${w.lastEntry ? ` · last label: ${w.lastEntry.dir === DIR_ACCUM ? 'LONG' : 'SHORT'} (${entryKindName(w.lastEntry.kind)}) ${px(w.lastEntry.price)}, ${when(w.lastEntry.time, t)}` : ''}`);
  }
  b.push('', '<b>Trend ribbon</b> (BOSWaves)');
  for (const t of ['4H', '1D'] as const) {
    const r = tf[t].ribbon, p = r.pos;
    if (!p || r.trend === 0) { b.push(` ${t} no trend yet`); continue; }
    b.push(` ${t} ${r.trend > 0 ? '🟢 Bull' : '🔴 Bear'} since ${when(r.flipAt!, t)} (${r.bars} bars) · conviction ${Math.round(r.conviction * 100)}%${p.how === 'stop' ? ` · SL hit` : ''}`);
    b.push(`    Entry ${px(p.entry)} · SL ${px(p.stop)} · ${p.targets.map((x, k) => `T${k + 1} ${px(x.price)}${x.hitAt >= 0 ? ' ✓' : ''}`).join(' · ')}`);
  }
  b.push('', '<b>Trinity reversal</b> (AlgoAlpha)');
  for (const t of ['4H', '1D'] as const) {
    const x = tf[t].trinity, lv = x.levels.map(({ s, tags }) => `${s.dir > 0 ? '▲' : '▼'} ${px(s.level)}${tags.length ? ` at ${esc(tags.join(' / '))}` : ''}`).join(' · ');
    b.push(` ${t} ${x.last ? `last strong ${x.last.dir > 0 ? '▲ bull' : '▼ bear'} ${when(x.lastTime, t)}, strength ${x.last.strength.toFixed(0)}%` : 'no strong signal in the last 100 bars'}${lv ? ` · active strong levels ${lv}` : ''}`);
  }
  const all = [...head, ...a, ...b].join('\n');
  if (all.length <= ETH_CARD.maxText) return [all];
  return [[...head, ...a].join('\n'), [`📊 <b>${SYM}</b> · 4H card (2/2) · ${utc(card.at)}`, ...b].join('\n')];
}
const statusWord = (s: DayStatus) => (s === 'Sweep' ? '⚡ Sweep' : s === 'Break' ? '💥 Break' : 'Active');

// ---- change alerts ----
export interface EthEvent { t: number; tf: CardTf; kind: string; key: string; text: string }

/** The change alerts of bar i of one timeframe (its close = t). `lv` = the 4H level series (4H only). */
export function eventsAt(S: TfData, i: number, k: KamaTf, lv: ReadonlyArray<LevelBar> | null): EthEvent[] {
  if (i < 1) return [];
  const c = S.c, b = c[i]!, t = b.openTime + S.ms, tf = S.tf, out: EthEvent[] = [];
  const ev = (kind: string, text: string, extra = '') => out.push({ t, tf, kind, key: `${tf}|${kind}|${t}${extra ? `|${extra}` : ''}`, text: `${text}` });
  const P = `${SYM} · ${tf}`;
  // The KAMA signal first: a taken cross is a signal; a held-off one only ends the open signal.
  k.sigs.forEach((s, n) => {
    if (s.i !== i) return;
    if (!s.heldOff) {
      ev('kama', [`${s.dir > 0 ? '🟢' : '🔴'} ${P} KAMA ${sigWord(s.dir)} ${px(s.price)} · 4H chop: ${s.chop} ✓`, ...noteLines(s.note, s.dir, '   '), `   ${ETH_CARD.label}`].join('\n'), sigWord(s.dir));
      return;
    }
    const prev = n > 0 ? k.sigs[n - 1]! : null;
    if (prev && !prev.heldOff && prev.dir !== s.dir) ev('kama-end', `⏹ ${P} KAMA ${sigWord(prev.dir)} from ${when(prev.time, tf)} ended: ${sigWord(s.dir)} cross ${px(s.price)} (not a new signal: 4H chop)`);
  });
  if (tf === '4H') {
    const s0 = chopState(S.chop, i - 1), s1 = chopState(S.chop, i), v = S.chop[i]!;
    if (s1 === 'chop' && s0 !== 'chop') ev('chop', `⛔ ${P} chop started (CHOP ${v.toFixed(1)}) · KAMA signals held off`);
    if (s1 === 'fading' && s0 === 'chop') ev('chop', `🌤 ${P} chop fading (CHOP ${v.toFixed(1)}, down from ${Math.max(...S.chop.slice(Math.max(0, i - CHOP.fadeBars), i)).toFixed(1)})`);
    if (s1 === 'trending' && (s0 === 'chop' || s0 === 'fading')) ev('chop', `✅ ${P} chop gone · trending (CHOP ${v.toFixed(1)})`);
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
    if (!strongTrinity(s)) continue;
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
  for (const d of S.divs) if (d.i === i) ev('rsi-div', `${d.d > 0 ? '↗️' : '↘️'} ${P} RSI ${d.d > 0 ? 'bullish' : 'bearish'} divergence (${d.d > 0 ? 'low' : 'high'} ${when(c[i - 3]!.openTime, tf)})`);
  return out;
}

/** Every alert of the last closed bars of both timeframes from `since` (4H events at 4H closes, 1D at the daily close). */
export function ethEvents(x: EthBuilt, since: number): EthEvent[] {
  const out: EthEvent[] = [];
  for (const [S, lv] of [[x.d4, x.ctx.lv], [x.dd, null]] as const) {
    for (let i = S.c.length - 1; i >= 1 && S.c[i]!.openTime + S.ms > since; i--) out.push(...eventsAt(S, i, x.kama[S.tf], lv));
  }
  return out.sort((a, b) => a.t - b.t || (a.tf === b.tf ? 0 : a.tf === '1D' ? -1 : 1));
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
    out.push(`${tf} (since ${Number.isFinite(k.from) ? iso(k.from).slice(0, 10) : '-'}; ${k.sigs.length} crosses, ${k.sigs.filter((s) => s.heldOff).length} held off by 4H chop):`);
    out.push(row('with the 4H chop filter (the card)', k.record), row('every cross (no filter)', k.unfiltered));
    out.push(row('held off by chop (as if taken)', kamaRecord(S.c, k.sigs, (s) => byI.get(s.i)!.heldOff)));
    out.push(row('filtered, confluence >= 3 (in-sample)', k.record.filter((t) => n(t) >= 3)), row('filtered, confluence < 3 (in-sample)', k.record.filter((t) => n(t) < 3)));
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
      const v = volAt(S, t.i), a = outlookAgree(outlookAt(x.outlook, S.c[t.i]!.openTime + S.ms), t.dir, S.c[t.i]!.close, v.pct, v.relVol);
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
    for (const name of OUTLOOK_METRICS) { const g = sp[tf][name]; out.push(`  ${name.padEnd(16)} agrees: ${cell(g.agree)} | disagrees: ${cell(g.disagree)}${g.na ? ` | n/a ${g.na}` : ''}`); }
  }
  return out;
}

/** The chart-check list: what the scripts show now, with UTC bar times, to compare with TradingView. */
export function chartCheck(x: EthBuilt): string[] {
  const { card, d4, dd } = x, out: string[] = ['CHART CHECK (ETHUSDT, default settings; bar open times UTC):'];
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
    out.push(`    Trinity (last 5): ${S.tri.slice(-5).map((s) => `${s.dir > 0 ? '▲' : '▼'} @${t(s.i)} ${s.strength.toFixed(1)}% level ${px(s.level)}${s.touchedAt >= 0 ? ` touched @${t(s.touchedAt)}` : s.expiredAt >= 0 ? ' expired' : ''}`).join('; ')}`);
    const g = S.fib;
    out.push(`    Fib swing: ${g ? `${g.dir > 0 ? 'up' : 'down'} from ${px(g.anchor)} @${t(g.anchorBar)} to ${px(g.extreme)} @${t(g.extremeBar)}; arcs now ${g.arcs.map((a) => `${pct(a.ratio)} ${px(a.price)}`).join(' ')}; last arc alerts ${S.fibHits.slice(-3).map((h) => `${pct(h.ratio)} ${px(h.price)} ${h.kind} @${t(h.i)}`).join('; ') || 'none'}` : 'none'}`);
    out.push(`    RSI ${S.rsi[i]?.toFixed(2)} MACD ${S.line[i]?.toFixed(2)} / ${S.sig[i]?.toFixed(2)} CHOP ${S.chop[i]!.toFixed(2)} ATR ${S.atr[i]?.toFixed(2)}`);
  }
  return out;
}

export { ZONE_RULE };
