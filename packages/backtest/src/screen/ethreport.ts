// The ETH card (owner 2026-10-11): indicator info and prices for ETHUSDT on 4H and 1D, built from the owner's templates
// (Shaakuni levels / order blocks, Wyckoff, Trend Target Ribbon, Trinity Reversal, Swing Fibonacci Arcs), RSI 14 / MACD
// 12/26/9 and the Choppiness Index, with weak zones filtered out (zonestrength.ts) and entry ideas (entryideas.ts). Display
// only: nothing here places or changes orders. The card goes out at each 4H close and the change alerts at the close they
// happen on (the worker's ethReport.ts); everything is computed from closed bars, so each value only uses data known at
// its bar. Pure.

import type { Candle } from '@bot/marketdata';
import { atrWilder, macdLines, rsi } from '../indicators';
import { CHOP, chopIndex, chopState, type ChopState } from './chop';
import { IDEA_RULE, buildIdea, ideaDiagnostic, replayIdeas, type Idea, type IdeaCandidate, type IdeaSource } from './entryideas';
import { fibArcs, type FibArcs, type FibSwingFlip } from './fibarcs';
import { macdState } from './macdstate';
import { coinVolume } from './pine';
import { divergenceEvents, type WeeklyEvent } from './rsimap';
import { lastClosed } from './scalp2';
import { activeBlocks, dayStatus, obTry, SHAAKUNI, shaakuniBlocks, shaakuniLevels, shaakuniLevelSeries, type DayStatus, type LevelBar, type ObZone, type ShaakuniLevels } from './shaakuni';
import { trendRibbon, type RibbonPosition, type RibbonSeries } from './trendribbon';
import { trinity, type TrinitySignal } from './trinity';
import { BIT, DIR_ACCUM, PHASE_C, PHASE_D, entryKindName, eventName, phaseName, typeName, wyckoff, type WyckoffResult } from './wyckoff';
import { ZONE_RULE, confluence, firstTouchHolds, obStrength, pickZones, strongTrinity, zoneShown, type ObStrength } from './zonestrength';

const H = 3_600_000, H4 = 4 * H, DAY = 24 * H;
export const ETH_CARD = { symbol: 'ETHUSDT', label: '⚠️ idea only, not a signal · manage your own risk', divRecentBars: 10, maxText: 4096 } as const;
export type CardTf = '4H' | '1D';

/** Every series of one timeframe, computed once over its closed bars. */
export interface TfData {
  tf: CardTf; ms: number; c: ReadonlyArray<Candle>; atr: (number | null)[]; rsi: (number | null)[]; line: (number | null)[]; sig: (number | null)[]; hist: (number | null)[];
  chop: number[]; rib: RibbonSeries; tri: TrinitySignal[]; obs: ObZone[]; obStr: Map<ObZone, ObStrength>; wy: WyckoffResult; fibFlips: FibSwingFlip[]; fib: FibArcs | null; divs: WeeklyEvent[];
}

export function tfData(c: ReadonlyArray<Candle>, tf: CardTf): TfData {
  const ms = tf === '4H' ? H4 : DAY, close = c.map((b) => b.close), m = macdLines(close), vol = coinVolume(c), r = rsi(close, 14);
  const obs = shaakuniBlocks(c, ms), fa = fibArcs(c);
  return {
    tf, ms, c, atr: atrWilder(c, 14), rsi: r, line: m.line, sig: m.sig, hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    chop: chopIndex(c), rib: trendRibbon(c), tri: trinity(c), obs, obStr: new Map(obs.map((z) => [z, obStrength(c, z, vol)])), wy: wyckoff(c, ms),
    fibFlips: fa.flips, fib: fa.last, divs: divergenceEvents(c, r, 5, 3, 5, 40),
  };
}

// ---- per-bar state ----
const isStrong = (S: TfData, z: ObZone) => S.obStr.get(z)?.strong === true;
/** Sent at all (4H: strong only; 1D: strong or weak, owner 2026-10-11). */
const shown = (S: TfData, z: ObZone) => zoneShown(S.tf, S.obStr.get(z));
const zoneWord = (S: TfData, z: ObZone) => (isStrong(S, z) ? 'strong' : 'weak');
/** The 4H level bar for time t (the last 4H bar closed by t). */
const levelAt = (h4: ReadonlyArray<Candle>, lv: ReadonlyArray<LevelBar>, t: number) => { const k = lastClosed(h4, H4, t); return k >= 0 ? lv[k]! : null; };
export function keyLevels(lv: LevelBar | null): { price: number; label: string }[] {
  if (!lv) return [];
  const weq = (lv.pwh + lv.pwl) / 2, deq = (lv.pdh + lv.pdl) / 2;
  return [{ price: lv.pwh, label: 'PWH' }, { price: lv.pwl, label: 'PWL' }, { price: weq, label: 'W-EQ' }, { price: lv.pdh, label: 'PDH' }, { price: lv.pdl, label: 'PDL' }, { price: deq, label: 'D-EQ' }].filter((x) => Number.isFinite(x.price));
}
/** The levels as the card shows them (weekend roll included) plus the week before, for the display tags only. */
export function displayLevels(L: ShaakuniLevels): { price: number; label: string }[] {
  return [{ price: L.pwh, label: 'PWH' }, { price: L.pwl, label: 'PWL' }, { price: L.weq, label: 'W-EQ' }, { price: L.pdh, label: 'PDH' }, { price: L.pdl, label: 'PDL' }, { price: L.deq, label: 'D-EQ' }, { price: L.pwh2, label: 'week-before high' }, { price: L.pwl2, label: 'week-before low' }].filter((x) => Number.isFinite(x.price));
}
const activePosition = (S: TfData, i: number): RibbonPosition | null => { const p = [...S.rib.positions].reverse().find((x) => x.i <= i); return p && (p.endAt < 0 || p.endAt > i) ? p : null; };
const activeTrinity = (S: TfData, i: number) => S.tri.filter((s) => s.i <= i && (s.touchedAt < 0 || s.touchedAt > i) && (s.expiredAt < 0 || s.expiredAt > i));
const sideWord = (d: number) => (d > 0 ? 'bull' : 'bear');

/** The idea candidates of one side at bar i. */
export function ideaCandidates(S: TfData, i: number, side: 1 | -1, levels: ReadonlyArray<{ price: number; label: string }>): IdeaCandidate[] {
  const R = IDEA_RULE, a = S.atr[i], price = S.c[i]!.close, out: IdeaCandidate[] = [];
  if (a == null) return out;
  for (const z of activeBlocks(S.obs, i)) {
    if (z.side !== side || !shown(S, z)) continue;
    const near = side > 0 ? z.top : z.bottom, far = side > 0 ? z.bottom : z.top;
    if (Math.abs(price - near) > R.zoneAtr * a) continue;
    const tags = confluence(z, a, levels);
    out.push({ src: 'order block', id: `ob:${S.tf}:${z.createdAt}`, entry: near, stop: far - side * R.stopPadAtr * a, label: `${zoneWord(S, z)} ${S.tf} ${sideWord(side)} POI${tags.length ? ` at ${tags.join(' / ')}` : ''}` });
  }
  const pos = activePosition(S, i);
  if (pos && pos.dir === side) out.push({ src: 'ribbon', id: `rib:${S.tf}:${pos.i}`, entry: pos.entry, stop: pos.stop, label: `ribbon ${sideWord(side)}` });
  const wb = S.wy.bars[i]!, since = S.c[Math.max(0, i - R.wyckoffBars + 1)]!.openTime;
  if ((wb.phase === PHASE_C || wb.phase === PHASE_D) && wb.outcome === side) {
    for (const e of S.wy.entries) {
      if (e.dir !== side || e.time < since || e.time > S.c[i]!.openTime) continue;
      const edge = !Number.isNaN(wb.exc) ? wb.exc : side > 0 ? wb.rangeLow : wb.rangeHigh;
      if (Number.isNaN(edge)) continue;
      out.push({ src: 'wyckoff', id: `wy:${S.tf}:${e.time}`, entry: e.price, stop: edge - side * R.stopPadAtr * a, label: `Wyckoff ${entryKindName(e.kind)}` });
    }
  }
  for (const s of activeTrinity(S, i)) {
    if (s.dir !== side || !strongTrinity(s)) continue;
    out.push({ src: 'trinity', id: `tri:${S.tf}:${s.i}`, entry: S.c[s.i]!.close, stop: s.level - side * R.stopPadAtr * a, label: `Trinity ${side > 0 ? '▲' : '▼'} ${s.strength.toFixed(0)}%` });
  }
  return out;
}

/** The candidates and the target levels of one side at bar i (targets: key levels, opposite zones that are sent, the ribbon's targets, the Wyckoff range edge). */
function ideaInputs(S: TfData, i: number, side: 1 | -1, levels: ReadonlyArray<{ price: number; label: string }>) {
  const targets = [...levels];
  for (const z of activeBlocks(S.obs, i)) if (z.side === -side && shown(S, z)) targets.push({ price: side > 0 ? z.bottom : z.top, label: `${S.tf} ${sideWord(-side)} POI` });
  const pos = activePosition(S, i);
  if (pos && pos.dir === side) pos.targets.forEach((t, k) => targets.push({ price: t.price, label: `ribbon T${k + 1}` }));
  const wb = S.wy.bars[i]!;
  if ((wb.phase === PHASE_C || wb.phase === PHASE_D) && wb.outcome === side) targets.push({ price: side > 0 ? wb.rangeHigh : wb.rangeLow, label: side > 0 ? 'range high' : 'range low' });
  return { cands: ideaCandidates(S, i, side, levels), targets };
}

/** The idea of one side at bar i. */
export function ideaAt(S: TfData, i: number, side: 1 | -1, levels: ReadonlyArray<{ price: number; label: string }>, chop4h: ChopState): Idea | null {
  const a = S.atr[i];
  if (a == null) return null;
  const { cands, targets } = ideaInputs(S, i, side, levels);
  return buildIdea(side, S.c[i]!.close, a, cands, targets, side > 0 && chop4h === 'chop');
}

export interface IdeaDiag { barSides: number; withCand: number; bySource: Record<IdeaSource, number>; multiSource: number; clustered: number; clusterKeys: number; t1R: number[] }
/** Why the rule fires or not, over every bar and side after the warm-up (preview only). */
export function ideaDiagnostics(S: TfData, h4: ReadonlyArray<Candle>, lv: ReadonlyArray<LevelBar>, warmup = 250): IdeaDiag {
  const d: IdeaDiag = { barSides: 0, withCand: 0, bySource: { 'order block': 0, ribbon: 0, wyckoff: 0, trinity: 0 }, multiSource: 0, clustered: 0, clusterKeys: 0, t1R: [] };
  const keys = new Set<string>();
  for (let i = warmup; i < S.c.length; i++) {
    const a = S.atr[i];
    if (a == null) continue;
    const levels = keyLevels(levelAt(h4, lv, S.c[i]!.openTime + S.ms));
    for (const side of [1, -1] as const) {
      d.barSides++;
      const { cands, targets } = ideaInputs(S, i, side, levels), g = ideaDiagnostic(side, S.c[i]!.close, a, cands, targets);
      if (cands.length) d.withCand++;
      for (const src of g.sources) d.bySource[src]++;
      if (g.sources.size >= 2) d.multiSource++;
      if (g.cluster) {
        d.clustered++; keys.add(g.cluster.key);
        d.t1R.push(g.cluster.targets[0]!.r);
      }
    }
  }
  d.clusterKeys = keys.size;
  return d;
}

export interface IdeaHistory { ideas: number; filled: number; t1: number; stopped: number; avgR: number | null; from: number }
/** Every bar's ideas (both sides) and the replay of the rule over the history. */
export function ideaSeries(S: TfData, h4: ReadonlyArray<Candle>, lv: ReadonlyArray<LevelBar>, chop4: ReadonlyArray<number>, warmup = 250): { long: (Idea | null)[]; short: (Idea | null)[]; history: IdeaHistory } {
  const long: (Idea | null)[] = [], short: (Idea | null)[] = [];
  for (let i = 0; i < S.c.length; i++) {
    if (i < warmup) { long.push(null); short.push(null); continue; }
    const t = S.c[i]!.openTime + S.ms, levels = keyLevels(levelAt(h4, lv, t)), k4 = lastClosed(h4, H4, t), ch = k4 >= 0 ? chopState(chop4, k4) : 'neutral';
    long.push(ideaAt(S, i, 1, levels, ch));
    short.push(ideaAt(S, i, -1, levels, ch));
  }
  const outs = [...replayIdeas(S.c, long, warmup), ...replayIdeas(S.c, short, warmup)];
  const filled = outs.filter((o) => o.filled), dec = filled.filter((o) => o.how !== 'open');
  return {
    long, short,
    history: { ideas: outs.length, filled: filled.length, t1: dec.filter((o) => o.how === 'target').length, stopped: dec.filter((o) => o.how === 'stop').length, avgR: filled.length ? filled.reduce((p, o) => p + o.r!, 0) / filled.length : null, from: S.c[Math.min(warmup, S.c.length - 1)]?.openTime ?? 0 },
  };
}

// ---- formatting ----
export const px = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '-' : Math.abs(x) >= 100 ? x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Number(x.toPrecision(5)).toString());
const sg = (x: number, d = 2) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const iso = (t: number) => new Date(t).toISOString();
const when = (t: number, tf: CardTf) => (tf === '4H' ? `${iso(t).slice(5, 10)} ${iso(t).slice(11, 16)}` : iso(t).slice(5, 10));
const utc = (t: number) => `${iso(t).slice(0, 10)} ${iso(t).slice(11, 16)} UTC`;
const SYM = ETH_CARD.symbol;

// ---- the card ----
export interface CardInput { m15: ReadonlyArray<Candle>; h4: ReadonlyArray<Candle>; d1: ReadonlyArray<Candle>; funding: { rate: number; intervalHours: number } | null; now: number }
export interface EthCard {
  at: number; price: number; change24h: number | null; high24h: number; low24h: number; funding: CardInput['funding'];
  levels: ShaakuniLevels; tf: Record<CardTf, TfView>; ideas: Record<CardTf, { long: Idea | null; short: Idea | null; history: IdeaHistory }>;
}
export interface TfView {
  tf: CardTf; barAt: number; chop: number; chopState: ChopState; rsi: number | null; macd: string; rsiDiv: string | null;
  zones: { z: ObZone; s: ObStrength; tags: string[]; time: number }[]; zonesHidden: number;
  wyckoff: { type: string; phase: number; phaseName: string; event: string; eventPrice: number; rangeHigh: number; rangeLow: number; conf: number; val: number; next: string; lastEntry: { time: number; price: number; dir: number; kind: number } | null; exc: number; excTime: number };
  ribbon: { trend: number; flipAt: number | null; bars: number; conviction: number; pos: RibbonPosition | null };
  trinity: { last: TrinitySignal | null; lastTime: number; levels: { s: TrinitySignal; tags: string[] }[]; hidden: number };
  fib: (FibArcs & { anchorTime: number; extremeTime: number }) | null;
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

function tfView(S: TfData, levels: ReadonlyArray<{ price: number; label: string }>, d1Zones: ReadonlyArray<ObZone>): TfView {
  const i = S.c.length - 1, a = S.atr[i] ?? 0, price = S.c[i]!.close;
  const div = [...S.divs].reverse().find((e) => e.i <= i && i - e.i < ETH_CARD.divRecentBars);
  const act = activeBlocks(S.obs, i), picked = pickZones(act, (z) => shown(S, z), price);
  const otherZones = S.tf === '4H' ? d1Zones.map((z) => ({ price: (z.top + z.bottom) / 2, label: `1D ${sideWord(z.side)} POI` })) : [];
  const tagWith = [...levels, ...otherZones];
  const zones = picked.shown.map((z) => ({ z, s: S.obStr.get(z)!, tags: confluence(z, a, tagWith), time: S.c[z.obBar]!.openTime }));
  const w = S.wy, st = w.state, wb = w.bars[i]!, lastEntry = w.entries.at(-1) ?? null;
  const pos = activePosition(S, i) ?? S.rib.positions.at(-1) ?? null, trend = S.rib.trend[i]!;
  const strongTri = S.tri.filter((s) => s.i <= i && i - s.i < 100 && strongTrinity(s));
  const actTri = activeTrinity(S, i);
  return {
    tf: S.tf, barAt: S.c[i]!.openTime + S.ms, chop: S.chop[i]!, chopState: chopState(S.chop, i), rsi: S.rsi[i] ?? null, macd: macdText(S, i),
    rsiDiv: div ? `RSI ${div.d > 0 ? 'bullish' : 'bearish'} divergence (${div.d > 0 ? 'low' : 'high'} ${when(S.c[div.i - 3]!.openTime, S.tf)})` : null,
    zones, zonesHidden: picked.hidden,
    wyckoff: {
      type: typeName(wb.type), phase: wb.phase, phaseName: phaseName(wb.phase), event: eventName(wb.ev), eventPrice: wb.lastEventPrice, rangeHigh: wb.rangeHigh, rangeLow: wb.rangeLow,
      conf: wb.conf, val: wb.val, next: w.next, lastEntry, exc: st.exc ? st.excPrice : NaN, excTime: st.exc ? st.excTime : NaN,
    },
    ribbon: { trend, flipAt: pos ? S.c[pos.i]!.openTime : null, bars: pos ? i - pos.i : 0, conviction: S.rib.conviction[i]!, pos },
    trinity: { last: strongTri.at(-1) ?? null, lastTime: strongTri.length ? S.c[strongTri.at(-1)!.i]!.openTime : 0, levels: actTri.filter(strongTrinity).map((s) => ({ s, tags: confluence({ top: s.level, bottom: s.level }, a, tagWith) })), hidden: S.tri.filter((s) => s.i <= i && i - s.i < 100 && !strongTrinity(s)).length },
    fib: S.fib ? { ...S.fib, anchorTime: S.c[S.fib.anchorBar]!.openTime, extremeTime: S.c[S.fib.extremeBar]!.openTime } : null,
  };
}

/** Everything the card shows at the last closed bars. */
export function ethCard(inp: CardInput, pre?: { d4: TfData; dd: TfData; lv: LevelBar[] }): { card: EthCard; d4: TfData; dd: TfData; series: Record<CardTf, ReturnType<typeof ideaSeries>> } {
  const d4 = pre?.d4 ?? tfData(inp.h4, '4H'), dd = pre?.dd ?? tfData(inp.d1, '1D'), lv = pre?.lv ?? shaakuniLevelSeries(inp.h4);
  const m = inp.m15, last = m[m.length - 1]!, from = last.openTime + 15 * 60_000 - DAY;
  const day = m.filter((b) => b.openTime >= from), ago = [...m].reverse().find((b) => b.openTime + 15 * 60_000 <= from);
  const levels = shaakuniLevels(inp.h4, inp.now), shownLevels = displayLevels(levels);
  const series = { '4H': ideaSeries(d4, inp.h4, lv, d4.chop), '1D': ideaSeries(dd, inp.h4, lv, d4.chop) };
  const ddAct = activeBlocks(dd.obs, dd.c.length - 1).filter((z) => shown(dd, z));
  const card: EthCard = {
    at: inp.now, price: last.close, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    levels, tf: { '4H': tfView(d4, shownLevels, ddAct), '1D': tfView(dd, shownLevels, []) },
    ideas: { '4H': { long: series['4H'].long.at(-1) ?? null, short: series['4H'].short.at(-1) ?? null, history: series['4H'].history }, '1D': { long: series['1D'].long.at(-1) ?? null, short: series['1D'].short.at(-1) ?? null, history: series['1D'].history } },
  };
  return { card, d4, dd, series };
}

function ideaLine(tf: CardTf, side: 1 | -1, idea: Idea | null): string[] {
  const name = side > 0 ? '🟢 Long' : '🔴 Short';
  if (!idea) return [` ${name} (${tf}): none with 2+ sources agreeing`];
  const zone = idea.zoneLo === idea.zoneHi ? px(idea.zoneLo) : `${px(idea.zoneLo)} – ${px(idea.zoneHi)}`;
  const tg = idea.targets.map((t, k) => `T${k + 1} ${px(t.price)} (${esc(t.label)}, ${t.r.toFixed(1)}R)`).join(' · ');
  return [
    ` ${name} (${tf})${idea.paused ? ' paused: 4H chop. Waiting' : ''} zone ${zone} · stop ${px(idea.stop)} · ${tg}`,
    ...(idea.inTheWay.length ? [`    in the way: ${idea.inTheWay.map((t) => `${esc(t.label)} ${px(t.price)} (${t.r.toFixed(1)}R)`).join(' · ')}`] : []),
    `    from ${idea.sources.length} sources: ${idea.sources.map((s) => esc(s.label)).join(' · ')}`,
  ];
}
const historyLine = (tf: CardTf, h: IdeaHistory) =>
 ` History of this rule (${tf}, since ${iso(h.from).slice(0, 10)}; rule set after seeing it): ${h.ideas} ideas, ${h.filled} filled, T1 before stop ${h.t1 + h.stopped ? Math.round((100 * h.t1) / (h.t1 + h.stopped)) : 0}% (${h.t1}/${h.t1 + h.stopped}), avg ${h.avgR == null ? '-' : `${sg(h.avgR)}R`}`;

/** The card as Telegram HTML; one message, or two when it passes 4,096 characters. */
export function ethCardText(card: EthCard): string[] {
  const { tf, levels: L } = card, f = card.funding;
  const head = [
    `📊 <b>${SYM}</b> · 4H card · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})${f ? ` · funding ${sg(f.rate * 100, 4)}% / ${f.intervalHours}h` : ''}`,
    '',
    `<b>Entry ideas</b> · ${ETH_CARD.label}`,
  ];
  for (const t of ['4H', '1D'] as const) head.push(...ideaLine(t, 1, card.ideas[t].long), ...ideaLine(t, -1, card.ideas[t].short));
  for (const t of ['4H', '1D'] as const) head.push(historyLine(t, card.ideas[t].history));
  const chopWord = (v: TfView) => (v.chopState === 'chop' ? '⛔ chop: hold off on longs' : v.chopState === 'fading' ? '🌤 chop fading: can look for longs' : v.chopState === 'trending' ? 'trending' : 'neutral');
  const a = [
    '', `<b>Chop</b> (CHOP ${CHOP.len})`, ...(['4H', '1D'] as const).map((t) => ` ${t} ${tf[t].chop.toFixed(1)} ${t === '4H' ? chopWord(tf[t]) : tf[t].chopState}`),
    '', '<b>RSI 14 / MACD 12/26/9</b>', ...(['4H', '1D'] as const).map((t) => ` ${t} RSI ${tf[t].rsi == null ? '-' : tf[t].rsi!.toFixed(1)} · ${tf[t].macd}${tf[t].rsiDiv ? ` · ${tf[t].rsiDiv}` : ''}`),
    '', '<b>Levels</b> (Shaakuni)',
    ` PWH ${px(L.pwh)} · W-EQ ${px(L.weq)} · PWL ${px(L.pwl)} · week before: high ${px(L.pwh2)} · low ${px(L.pwl2)}`,
    ` PDH ${px(L.pdh)} ${statusWord(L.pdhStatus)} · D-EQ ${px(L.deq)} · PDL ${px(L.pdl)} ${statusWord(L.pdlStatus)} · Session: ${L.session === '-' ? 'none' : L.session}${L.weekendRoll ? ' · (weekend: the current week / day, as the script shows)' : ''}`,
    ` Order blocks, unmitigated (4H strong only, ${tf['4H'].zonesHidden} weaker not shown; 1D strong or weak):`,
    ...(['4H', '1D'] as const).map((t) => `  ${t} ${tf[t].zones.length ? tf[t].zones.map((x) => `${x.z.side > 0 ? '🟦 bull' : '🟧 bear'} POI${x.s.strong ? '' : ' (weak)'} ${px(x.z.bottom)} – ${px(x.z.top)} (${when(x.time, t)}) · impulse ${x.s.impulseAtr.toFixed(1)} ATR, volume ${x.s.volumeMult.toFixed(1)}x${x.tags.length ? `, at ${esc(x.tags.join(' / '))}` : ''}`).join(' · ') : t === '4H' ? 'none strong' : 'none'}`),
  ];
  const b = ['', '<b>Wyckoff</b>'];
  for (const t of ['4H', '1D'] as const) {
    const w = tf[t].wyckoff;
    if (w.phase === 0) { b.push(` ${t} Searching for SC / BC`); continue; }
    b.push(` ${t} ${w.type} · Phase ${w.phaseName.slice(0, 1)} (${esc(w.event)} ${px(w.eventPrice)})${Number.isNaN(w.rangeHigh) ? '' : ` · range ${px(w.rangeLow)} – ${px(w.rangeHigh)}`}`);
    b.push(`    maturity ${w.conf} · validation ${w.val} · next: ${esc(w.next)}${w.lastEntry ? ` · last label: ${w.lastEntry.dir === DIR_ACCUM ? 'LONG' : 'SHORT'} (${entryKindName(w.lastEntry.kind)}) ${px(w.lastEntry.price)}, ${when(w.lastEntry.time, t)}` : ''}`);
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
    b.push(` ${t} ${x.last ? `last strong ${x.last.dir > 0 ? '▲ bull' : '▼ bear'} ${when(x.lastTime, t)}, strength ${x.last.strength.toFixed(0)}%` : 'no strong signal in the last 100 bars'}${lv ? ` · active strong levels ${lv}` : ''}${x.hidden ? ` (${x.hidden} weaker not shown)` : ''}`);
  }
  b.push('', '<b>Swing Fib arcs</b> (BigBeluga)');
  for (const t of ['4H', '1D'] as const) {
    const g = tf[t].fib;
    if (!g) { b.push(` ${t} no swing yet`); continue; }
    const arcs = g.arcs.filter((x) => x.price != null).map((x) => `${(x.ratio * 100).toFixed(1).replace('.0', '')}% ${px(x.price)}`).join(' · ');
    b.push(` ${t} swing ${g.dir > 0 ? 'up' : 'down'} from ${px(g.anchor)} (${when(g.anchorTime, t)}) to ${px(g.extreme)} (${when(g.extremeTime, t)}) · arcs now: ${arcs || 'none at this bar'} · volume POC ${px(g.poc)}`);
  }
  const all = [...head, ...a, ...b].join('\n');
  if (all.length <= ETH_CARD.maxText) return [all];
  return [[...head, ...a].join('\n'), [`📊 <b>${SYM}</b> · 4H card (2/2) · ${utc(card.at)}`, ...b].join('\n')];
}
const statusWord = (s: DayStatus) => (s === 'Sweep' ? '⚡ Sweep' : s === 'Break' ? '💥 Break' : 'Active');
// ---- change alerts ----
export interface EthEvent { t: number; tf: CardTf; kind: string; key: string; text: string }

/** The change alerts of bar i of one timeframe (its close = t). `ideas` = that timeframe's idea series. */
export function eventsAt(S: TfData, i: number, ideas: { long: (Idea | null)[]; short: (Idea | null)[] }, lv: ReadonlyArray<LevelBar> | null): EthEvent[] {
  if (i < 1) return [];
  const c = S.c, b = c[i]!, t = b.openTime + S.ms, tf = S.tf, out: EthEvent[] = [];
  const ev = (kind: string, text: string, extra = '') => out.push({ t, tf, kind, key: `${tf}|${kind}|${t}${extra ? `|${extra}` : ''}`, text: `${text}` });
  const P = `${SYM} · ${tf}`;
  if (tf === '4H') {
    const s0 = chopState(S.chop, i - 1), s1 = chopState(S.chop, i), v = S.chop[i]!;
    if (s1 === 'chop' && s0 !== 'chop') ev('chop', `⛔ ${P} chop started (CHOP ${v.toFixed(1)}) · hold off on longs`);
    if (s1 === 'fading' && s0 === 'chop') ev('chop', `🌤 ${P} chop fading (CHOP ${v.toFixed(1)}, down from ${Math.max(...S.chop.slice(Math.max(0, i - CHOP.fadeBars), i)).toFixed(1)}) · can look for longs`);
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
  const wb = S.wy.bars[i]!, sig = wb.sig, has = (bit: number) => Math.floor(sig / bit) % 2 === 1, acc = wb.wdir === DIR_ACCUM;
  const wy = (txt: string, k: string) => ev(`wyckoff-${k}`, `🧭 ${P} Wyckoff: ${txt}`);
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
  for (const p of S.rib.positions) {
    if (p.i === i) ev('ribbon-flip', `🔁 ${P} trend ribbon flipped ${p.dir > 0 ? 'BULL' : 'BEAR'} · entry ${px(p.entry)} · SL ${px(p.stop)} · ${p.targets.slice(0, 2).map((x, k) => `T${k + 1} ${px(x.price)}`).join(' · ')}`);
    p.targets.forEach((x, k) => { if (x.hitAt === i) ev('ribbon-target', `🎯 ${P} trend ribbon T${k + 1} hit ${px(x.price)}`, `${p.i}|${k}`); });
    if (p.endAt === i && p.how === 'stop') ev('ribbon-stop', `🛑 ${P} trend ribbon stop hit ${px(p.stop)}`, `${p.i}`);
  }
  for (const s of S.tri) {
    if (!strongTrinity(s)) continue;
    if (s.i === i) ev('trinity', `${s.dir > 0 ? '▲' : '▼'} ${P} strong ${s.dir > 0 ? 'bullish' : 'bearish'} Trinity reversal · strength ${s.strength.toFixed(0)}% · level ${px(s.level)}`);
    if (s.touchedAt === i) ev('trinity-touch', `📍 ${P} Trinity level ${px(s.level)} touched`, `${s.i}`);
  }
  for (const f of S.fibFlips) if (f.i === i) ev('swing', `↪️ ${P} new swing: ${f.dir > 0 ? 'up' : 'down'} from ${px(f.anchor)} (Fib arcs reset)`);
  const h0 = S.hist[i - 1], h1 = S.hist[i], r1 = S.rsi[i], r0 = S.rsi[i - 1];
  if (h0 != null && h1 != null && Math.sign(h0) !== Math.sign(h1) && h1 !== 0) ev('macd', `${h1 > 0 ? '📈' : '📉'} ${P} MACD ${h1 > 0 ? 'bullish' : 'bearish'} cross · RSI ${r1 == null ? '-' : r1.toFixed(1)}`);
  if (r0 != null && r1 != null) {
    if (r0 < 70 && r1 >= 70) ev('rsi', `🌡 ${P} RSI over 70 (${r1.toFixed(1)})`);
    if (r0 >= 70 && r1 < 70) ev('rsi', `🌡 ${P} RSI back under 70 (${r1.toFixed(1)})`);
    if (r0 > 30 && r1 <= 30) ev('rsi', `🌡 ${P} RSI under 30 (${r1.toFixed(1)})`);
    if (r0 <= 30 && r1 > 30) ev('rsi', `🌡 ${P} RSI back over 30 (${r1.toFixed(1)})`);
  }
  for (const d of S.divs) if (d.i === i) ev('rsi-div', `${d.d > 0 ? '↗️' : '↘️'} ${P} RSI ${d.d > 0 ? 'bullish' : 'bearish'} divergence (${d.d > 0 ? 'low' : 'high'} ${when(c[i - 3]!.openTime, tf)})`);
  for (const side of [1, -1] as const) {
    const arr = side > 0 ? ideas.long : ideas.short, cur = arr[i], name = side > 0 ? 'long' : 'short';
    if (cur && !cur.paused && !(arr[i - 1] && !arr[i - 1]!.paused && arr[i - 1]!.key === cur.key)) {
      const zone = cur.zoneLo === cur.zoneHi ? px(cur.zoneLo) : `${px(cur.zoneLo)} – ${px(cur.zoneHi)}`;
      ev(`idea-${name}`, [`💡 ${P} ${name} idea · zone ${zone} · stop ${px(cur.stop)} · ${cur.targets.map((x, k) => `T${k + 1} ${px(x.price)} (${x.r.toFixed(1)}R)`).join(' · ')}`,
        ...(cur.inTheWay.length ? [`   in the way: ${cur.inTheWay.map((x) => `${x.label} ${px(x.price)} (${x.r.toFixed(1)}R)`).join(' · ')}`] : []),
        `   ${cur.sources.length} sources: ${cur.sources.map((s) => s.label).join(' · ')}`, `   ${ETH_CARD.label}`].join('\n'), cur.key);
    }
    // Zone reached / invalidated: the latest unpaused idea of this side shown in the last 30 bars.
    let k = i - 1;
    while (k >= Math.max(0, i - IDEA_RULE.fillBars) && !(arr[k] && !arr[k]!.paused)) k--;
    const prev = k >= 0 ? arr[k] : null;
    if (prev && !prev.paused && i - k <= IDEA_RULE.fillBars) {
      let reached = false, dead = false;
      for (let q = k + 1; q < i; q++) { const x = c[q]!; if (side > 0 ? x.low <= prev.entry : x.high >= prev.entry) reached = true; if (side > 0 ? x.close < prev.stop : x.close > prev.stop) dead = true; }
      if (!dead && !reached && (side > 0 ? b.low <= prev.entry : b.high >= prev.entry)) ev(`idea-${name}-zone`, `📍 ${P} ${name} idea zone reached (${px(prev.entry)}) · ⚠️ manage your own risk`, prev.key);
      if (!dead && (side > 0 ? b.close < prev.stop : b.close > prev.stop)) ev(`idea-${name}-dead`, `✖️ ${P} ${name} idea invalidated (${tf} close ${px(b.close)} ${side > 0 ? 'under' : 'over'} the stop)`, prev.key);
    }
  }
  return out;
}

/** Every alert of the last closed bars of both timeframes from `since` (4H events at 4H closes, 1D at the daily close). */
export function ethEvents(d4: TfData, dd: TfData, series: Record<CardTf, ReturnType<typeof ideaSeries>>, lv: ReadonlyArray<LevelBar>, since: number): EthEvent[] {
  const out: EthEvent[] = [];
  for (const [S, ideas, levels] of [[d4, series['4H'], lv], [dd, series['1D'], null]] as const) {
    for (let i = S.c.length - 1; i >= 1 && S.c[i]!.openTime + S.ms > since; i--) out.push(...eventsAt(S, i, ideas, levels));
  }
  return out.sort((a, b) => a.t - b.t || (a.tf === b.tf ? 0 : a.tf === '1D' ? -1 : 1));
}

// ---- preview extras ----
/** First-touch hold rates of strong and weak blocks over the history of one timeframe. */
export function zoneCheck(S: TfData): { strong: { n: number; held: number }; weak: { n: number; held: number } } {
  const r = firstTouchHolds(S.c, S.obs), g = (strong: boolean) => { const xs = r.filter((x) => isStrong(S, x.zone) === strong); return { n: xs.length, held: xs.filter((x) => x.held).length }; };
  return { strong: g(true), weak: g(false) };
}

/** The chart-check list: what the scripts show now, with UTC bar times, to compare with TradingView. */
export function chartCheck(card: EthCard, d4: TfData, dd: TfData): string[] {
  const out: string[] = ['CHART CHECK (ETHUSDT, default settings; bar open times UTC):'];
  const L = card.levels;
  out.push(`  Shaakuni levels: PWH ${px(L.pwh)} PWL ${px(L.pwl)} W-EQ ${px(L.weq)} | PDH ${px(L.pdh)} (${L.pdhStatus}) PDL ${px(L.pdl)} (${L.pdlStatus}) D-EQ ${px(L.deq)} | week before ${px(L.pwh2)} / ${px(L.pwl2)}`);
  for (const S of [d4, dd]) {
    const i = S.c.length - 1, t = (k: number) => iso(S.c[k]!.openTime).slice(0, 16).replace('T', ' ');
    out.push(`  ${S.tf}:`);
    const act = activeBlocks(S.obs, i);
    if (S.tf === '4H') {
      const from = Math.max(SHAAKUNI.swingLen + 3, i - 29), tries: string[] = [];
      for (let k = from; k <= i; k++) for (const d of [1, -1] as const) {
        const a = S.atr[k]!, r = obTry(S.c, k, a, d);
        if ('why' in r && r.why === 'no break') continue;
        tries.push(`${t(k)} ${sideWord(d)}: ${'why' in r ? r.why : `block ${px(S.c[k - r.obOff]!.low)}-${px(S.c[k - r.obOff]!.high)} @${t(k - r.obOff)}`}`);
      }
      out.push(`    order-block test on the last 30 bars (bars that broke a 10-bar high / low): ${tries.join('; ') || 'none'}`);
      out.push(`    blocks made in the last 30 bars: ${S.obs.filter((z) => z.createdAt >= from).map((z) => `${sideWord(z.side)} ${px(z.bottom)}-${px(z.top)} @${t(z.obBar)}${z.mitigatedAt >= 0 ? ` mitigated @${t(z.mitigatedAt)}` : ''}`).join('; ') || 'none'}`);
      out.push(`    bars (open high low close): ${S.c.slice(from, i + 1).map((b, k) => `${t(from + k).slice(5)} ${px(b.open)} ${px(b.high)} ${px(b.low)} ${px(b.close)}`).join(' | ')}`);
    }
    out.push(`    order blocks shown (unmitigated): ${act.length ? act.map((z) => `${sideWord(z.side)} ${px(z.bottom)}-${px(z.top)} @${t(z.obBar)} (${S.obStr.get(z)!.strong ? 'strong' : 'weak'}: ${S.obStr.get(z)!.impulseAtr.toFixed(2)} ATR, ${S.obStr.get(z)!.volumeMult.toFixed(2)}x)`).join('; ') : 'none'}`);
    const w = S.wy.state;
    const evs: [string, number, number][] = [['PS', w.psTime, w.psPrice], [w.stopSide > 0 ? 'SC' : 'BC', w.climaxTime, w.climaxPrice], ['AR', w.arTime, w.arPrice], ['ST', w.stTime, w.stPrice], [w.outcome > 0 ? 'Spring' : 'UTAD', w.excTime, w.excPrice], ['Test', w.testTime, w.testPrice], [w.outcome > 0 ? 'SOS' : 'SOW', w.strTime, w.strPrice], [w.outcome > 0 ? 'LPS' : 'LPSY', w.lpsTime, w.lpsPrice], ['Phase E', w.eStartTime, NaN]];
    out.push(`    Wyckoff: ${typeName(S.wy.bars[i]!.type)}, ${phaseName(w.phase)}; events ${evs.filter(([, tt]) => !Number.isNaN(tt)).map(([n, tt, p]) => `${n} ${Number.isNaN(p) ? '' : px(p)} @${iso(tt).slice(0, 16).replace('T', ' ')}`).join(', ') || 'none'}; resets ${JSON.stringify(S.wy.resets)}`);
    out.push(`    Wyckoff entry labels (last 5): ${S.wy.entries.slice(-5).map((e) => `${e.dir > 0 ? 'LONG' : 'SHORT'} ${entryKindName(e.kind)} ${px(e.price)} @${iso(e.time).slice(0, 16).replace('T', ' ')}`).join('; ') || 'none'}`);
    out.push(`    trend ribbon (last 3): ${S.rib.positions.slice(-3).map((p) => `${p.dir > 0 ? 'BULL' : 'BEAR'} @${t(p.i)} entry ${px(p.entry)} SL ${px(p.stop)} targets ${p.targets.map((x) => `${px(x.price)}${x.hitAt >= 0 ? '✓' : ''}`).join('/')}${p.how ? ` ended ${p.how} @${t(p.endAt)}` : ''}`).join('; ')}`);
    out.push(`    Trinity (last 5): ${S.tri.slice(-5).map((s) => `${s.dir > 0 ? '▲' : '▼'} @${t(s.i)} ${s.strength.toFixed(1)}% level ${px(s.level)}${s.touchedAt >= 0 ? ` touched @${t(s.touchedAt)}` : s.expiredAt >= 0 ? ' expired' : ''}`).join('; ')}`);
    const g = S.fib;
    out.push(`    Fib swing: ${g ? `${g.dir > 0 ? 'up' : 'down'} from ${px(g.anchor)} @${t(g.anchorBar)} to ${px(g.extreme)} @${t(g.extremeBar)}; POC ${px(g.poc)}; arcs ${g.arcs.map((a) => `${a.ratio}:${px(a.price)}`).join(' ')}` : 'none'}`);
    out.push(`    RSI ${S.rsi[i]?.toFixed(2)} MACD ${S.line[i]?.toFixed(2)} / ${S.sig[i]?.toFixed(2)} CHOP ${S.chop[i]!.toFixed(2)} ATR ${S.atr[i]?.toFixed(2)}`);
  }
  return out;
}

export { ZONE_RULE };
