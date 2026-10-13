// The ETH / BTC cards v2 (owner 2026-10-13: "re attempt the cards for eth and btc ... give a read from the indicators
// on weekly time frame daily and 4h ... an ai interpreted read"). One card per coin at each 4H close with weekly, daily
// and 4H reads; the AI read (Claude Haiku 5.5, written by the worker from this card's own lines) goes at the top.
//
// Kept from the first cards (owner): the intro (price, 24h, funding), the coin's EMA stack (emastack.ts), the Chop Zone
// (chopzone.ts), RSI / MACD, range targets (rangetargets.ts, FEELS) and the strong FVGs (fvgob.ts). Gone: KAMA,
// DiNapoli (card and 1H alerts), Outlook, Shaakuni levels / order blocks, trend ribbon, AxeAlgo S/R zones.
// New scripts (each its own port, default inputs, run on each timeframe's own bars):
// - Trend: Heat Map Trend (VIDYA) [BigBeluga] (vidyaheat.ts), one value per timeframe.
// - Order blocks: MarketMaulers Order Blocks v1.8 (mmob.ts) and Dynamic Order Blocks [LuxAlgo] (luxdynob.ts).
// - Gaps: HTF FVG/IFVG (htffvg.ts), FVG Absorption [LuxAlgo] (fvgabsorb.ts) and the strong FVGs.
// - S/R: Dynamic S/R Zones [ChartPrime] (cpsr.ts), Optimus S/R Zones (optimussr.ts), Smart S/R Zones (smartsr.ts).
// - Liquidity: Dynamic Liquidity HeatMap Profile [BigBeluga] (liqheat.ts), on 4H and daily.
// Confluence (owner: "some will offer 2 indicators for the same thing"): each family's zones from all scripts and
// timeframes are merged where they overlap (S/R levels within 0.4% of the price); the card shows the nearest merged
// zone above and below the price (and one holding it) with the scripts and timeframes that make it up.
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

export type Tf3 = 'W' | 'D' | '4H';
export const TFS: Tf3[] = ['W', 'D', '4H'];
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, WEEK = 7 * DAY;
const MS: Record<Tf3, number> = { W: WEEK, D: DAY, '4H': H4 };
export const COIN_CARD = { label: '⚠️ manage your own risk', maxText: 4096, srTolPct: 0.4, zoneTolPct: 0.1, maxZoneAtr: 3, macdRecent: 6, aiModelName: 'Claude Haiku 5.5' } as const;

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
}

function tfSet(tf: Tf3, c: Candle[]): TfSet {
  const close = c.map((b) => b.close), m = macdLines(close);
  return {
    tf, c, ms: MS[tf], last: c.length - 1, atr: taAtr(c, 14),
    vidya: vidyaHeat(c, tf === 'W'), cz: chopZone(c), rsi: rsi(close, 14), hist: m.line.map((x, i) => (x == null || m.sig[i] == null ? null : x - m.sig[i]!)),
    mm: mmob(c), lux: luxDynOb(c), htf: htfFvgFor(c, tf), abs: fvgAbsorb(c), fo: fvgOb(c), rt: tf === 'W' ? null : rangeTargets(c),
  };
}

/** A zone or level from one script on one timeframe. */
export interface Piece { lo: number; hi: number; tf: Tf3; src: string; note?: string; side?: 1 | -1 }
/** Merged pieces: the zone, and the scripts / timeframes in it. */
export interface Group { lo: number; hi: number; pieces: Piece[] }
export interface Family { above: Group | null; below: Group | null; inside: Group | null }

/** Merge the pieces nearest the price: the nearest above, below and holding it, each with what overlaps it (+ tol). */
export function nearestGroups(pieces: ReadonlyArray<Piece>, price: number, tol: number): Family {
  const grow = (start: Piece, rest: Piece[]): Group => {
    const g: Group = { lo: start.lo, hi: start.hi, pieces: [start] };
    for (let changed = true; changed;) {
      changed = false;
      for (const p of rest) if (!g.pieces.includes(p) && p.lo <= g.hi + tol && p.hi >= g.lo - tol) { g.pieces.push(p); g.lo = Math.min(g.lo, p.lo); g.hi = Math.max(g.hi, p.hi); changed = true; }
    }
    return g;
  };
  const inside = pieces.filter((p) => p.lo <= price && p.hi >= price), above = pieces.filter((p) => p.lo > price).sort((a, b) => a.lo - b.lo), below = pieces.filter((p) => p.hi < price).sort((a, b) => b.hi - a.hi);
  const gi = inside.length ? grow(inside[0]!, inside) : null;
  // Above / below: the nearest piece and what overlaps it on its own side (a zone holding the price is shown apart).
  return { above: above.length ? grow(above[0]!, above) : null, below: below.length ? grow(below[0]!, below) : null, inside: gi };
}

export interface CoinCard {
  symbol: StackCoin; at: number; price: number; change24h: number | null; high24h: number; low24h: number; funding: CoinCardInput['funding'];
  stack: StackAt;
  tf: Record<Tf3, { vidya: number; vidyaUp: boolean | null; chop: ChopColor | null; rsi: number | null; macd: string; barAt: number } | null>;
  weeklyDevLen: number;
  ob: Family; fvg: Family; sr: Family; srSources: number;
  liq: Partial<Record<'4H' | 'D', { up: { lo: number; hi: number } | null; dn: { lo: number; hi: number } | null; max: { lo: number; hi: number } | null }>>;
  range: Partial<Record<'4H' | 'D', { now: { lo: number; hi: number; forming: boolean } | null; up: number | null; dn: number | null }>>;
}
export interface CoinBuilt { card: CoinCard; sets: Partial<Record<Tf3, TfSet>>; stack: StackSeries }

function macdWord(S: TfSet): string {
  const i = S.last, h = S.hist[i];
  if (h == null) return 'MACD -';
  const side = h >= 0 ? 'bull' : 'bear', p = S.hist[i - 1];
  let k = i;
  while (k > 0 && S.hist[k - 1] != null && Math.sign(S.hist[k - 1]!) === Math.sign(h)) k--;
  const since = i - k, recent = k > 0 && since <= COIN_CARD.macdRecent ? `, crossed ${since} bar${since === 1 ? '' : 's'} ago` : '';
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
  const ob: Piece[] = [], fvg: Piece[] = [], sr: Piece[] = [];
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
  }
  const tolSr = (price * COIN_CARD.srTolPct) / 100, tolZ = (price * COIN_CARD.zoneTolPct) / 100;
  const liq: CoinCard['liq'] = {}, range: CoinCard['range'] = {};
  for (const tf of ['4H', 'D'] as const) {
    const S = sets[tf];
    if (!S) continue;
    const p: LiqProfile = liqHeat(S.c, S.last), big = p.bins.filter((b) => b.vol > p.avg), P = S.c[S.last]!.close;
    const up = big.filter((b) => b.lo > P).sort((a, b) => a.lo - b.lo)[0], dn = big.filter((b) => b.hi < P).sort((a, b) => b.hi - a.hi)[0];
    liq[tf] = { up: up ? { lo: up.lo, hi: up.hi } : null, dn: dn ? { lo: dn.lo, hi: dn.hi } : null, max: p.max ? { lo: p.max.lo, hi: p.max.hi } : null };
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
    tfv[tf] = { vidya: v, vidyaUp: Number.isNaN(v) ? null : v > 0, chop: S.cz.color[S.last] ?? null, rsi: S.rsi[S.last] ?? null, macd: macdWord(S), barAt: S.c[S.last]!.openTime + S.ms };
  }
  const card: CoinCard = {
    symbol: inp.symbol, at: t, price, change24h: ago ? (last.close / ago.close - 1) * 100 : null, high24h: Math.max(...day.map((b) => b.high)), low24h: Math.min(...day.map((b) => b.low)), funding: inp.funding,
    stack: stackAt(stack, t), tf: tfv, weeklyDevLen: sets.W?.vidya.devLen ?? 0,
    ob: nearestGroups(ob, price, tolZ), fvg: nearestGroups(fvg, price, tolZ), sr: nearestGroups(sr, price, tolSr), srSources: 3, liq, range,
  };
  return { card, sets, stack };
}

// ---- text ----
const tfOrder = (a: Piece, b: Piece) => TFS.indexOf(a.tf) - TFS.indexOf(b.tf);
/** "D MM+Lux bear · 4H MM bull": the pieces of a group by timeframe. */
function groupTags(g: Group): string {
  const by = new Map<Tf3, string[]>();
  for (const p of [...g.pieces].sort(tfOrder)) { const l = by.get(p.tf) ?? []; const s = p.src === 'Smart' && p.note ? `Smart ${p.note}` : p.src === 'abs' ? `absorption ${p.note!.replace(' absorbed', '')}` : p.src; if (!l.includes(s)) l.push(s); by.set(p.tf, l); }
  return [...by].map(([tf, l]) => `${tf} ${l.join(' + ')}`).join(' · ');
}
const sideNote = (g: Group) => { const n = new Set(g.pieces.filter((p) => ['MM', 'Lux', 'FVG', 'IFVG', 'strong'].includes(p.src)).map((p) => p.note)); return n.size === 1 ? ` ${[...n][0]}` : ''; };
const zoneLine = (mark: string, g: Group | null, kind: string) => (g ? ` ${mark} ${px(g.lo)}–${px(g.hi)}${sideNote(g)}${kind} · ${esc(groupTags(g))}` : ` ${mark} none`);
const srLine = (mark: 'R' | 'S', g: Group | null) => {
  if (!g) return ` ${mark} none`;
  const n = new Set(g.pieces.map((p) => p.src)).size;
  return ` ${mark} ${g.lo === g.hi ? px(g.lo) : `${px(g.lo)}–${px(g.hi)}`} · ${n}/3 · ${esc(groupTags(g))}`;
};

function emaLines(a: StackAt): string[] {
  const e = (x: { n: number; ema: number; over: boolean; pct: number } | null) => (x ? `${x.over ? 'over' : 'under'} EMA ${x.n} ${px(x.ema)} (${sg(x.pct, 1)}%)` : 'EMA -');
  const side = biasSide(a), out = ['', `<b>EMA</b> (${a.coin === 'ETHUSDT' ? 'ETH: 26 · 13/21 · W13/W21' : 'BTC: 26 · 144 · 9/89 · W5/W34'})`];
  out.push(` D ${e(a.bias)}${a.slow ? ` · ${e(a.slow)}` : ''}${a.pair ? ` · ${a.pair.fast} ${a.pair.over ? 'over' : 'under'} ${a.pair.slow}` : ''} → ${side > 0 ? 'longs allowed' : side < 0 ? 'shorts allowed' : 'no side'}`);
  if (a.weekly) out.push(` W ${a.weekly.lines.map((x) => `${x.over ? 'over' : 'under'} W${x.n} ${px(x.ema)}${a.coin === 'BTCUSDT' ? (x.n === 5 ? (x.over ? ' ✓' : ' ✗') : x.over ? '' : ' ⛔ veto') : ''}`).join(' · ')}${a.coin === 'ETHUSDT' ? ` · short confirmation ${a.shortConfirm == null ? '-' : a.bias?.over ? 'off' : a.shortConfirm ? '✓' : '✗'}` : a.shortCheck ? ` · short check ${a.shortCheck.count}/3` : ''}`);
  if (a.trigger) out.push(` 4H ${a.trigger.pairs.map((p) => `${p.fast}/${p.slow} ${p.over ? 'bull' : 'bear'}`).join(' · ')} · limits ${a.trigger.limits.map((l) => `EMA ${l.n} ${px(l.v)}`).join(' / ')}`);
  return out;
}

/** The card's indicator lines (no intro, no AI read): the body the AI read is written from. */
export function cardBody(card: CoinCard): string[] {
  const T = card.tf, cell = (tf: Tf3, f: (x: NonNullable<CoinCard['tf'][Tf3]>) => string) => (T[tf] ? `${tf} ${f(T[tf]!)}` : `${tf} -`);
  const out: string[] = [];
  out.push('<b>Trend</b> (VIDYA heat map · BigBeluga)', ` ${TFS.map((tf) => cell(tf, (x) => (x.vidyaUp == null ? '-' : `${x.vidyaUp ? '🟢 up' : '🔴 down'} ${sg(x.vidya)}`))).join(' · ')}`);
  out.push(...emaLines(card.stack));
  const ch = T['4H']?.chop === 'yellow';
  out.push('', `<b>Chop Zone</b> ${TFS.map((tf) => cell(tf, (x) => `${zoneEmoji(x.chop)} ${x.chop ?? '-'}`)).join(' · ')}${ch ? ' · 4H chop: hold off on longs' : ''}`);
  out.push(`<b>RSI / MACD</b> ${TFS.map((tf) => cell(tf, (x) => `${x.rsi == null ? '-' : x.rsi.toFixed(0)} · ${x.macd.replace('MACD ', '')}`)).join(' | ')}`);
  out.push('', '<b>Order blocks</b> (MarketMaulers · LuxAlgo)', zoneLine('▲', card.ob.above, ' OB'), ...(card.ob.inside ? [zoneLine('◆ in', card.ob.inside, ' OB')] : []), zoneLine('▼', card.ob.below, ' OB'));
  out.push('', '<b>FVG</b> (HTF FVG/IFVG · LuxAlgo absorption · strong)', zoneLine('▲', card.fvg.above, ''), ...(card.fvg.inside ? [zoneLine('◆ in', card.fvg.inside, '')] : []), zoneLine('▼', card.fvg.below, ''));
  out.push('', '<b>S/R</b> (ChartPrime · Optimus · Smart S/R)', srLine('R', card.sr.above), ...(card.sr.inside ? [srLine('R', card.sr.inside).replace(' R ', ' ◆ at ')] : []), srLine('S', card.sr.below));
  const lq = (tf: '4H' | 'D') => { const x = card.liq[tf]; if (!x) return `${tf} -`; const r = (z: { lo: number; hi: number } | null) => (z ? `${px(z.lo)}–${px(z.hi)}${x.max && z.lo === x.max.lo ? ' (max)' : ''}` : 'none'); return `${tf} ▲ ${r(x.up)} · ▼ ${r(x.dn)}`; };
  out.push('', '<b>Liquidity</b> (BigBeluga)', ` ${lq('4H')}`, ` ${lq('D')}`);
  const rg = (tf: '4H' | 'D') => { const x = card.range[tf]; if (!x) return `${tf} -`; const n = x.now, h = n ? n.hi - n.lo : 0; const tg = [x.up != null ? `▲ ${px(x.up)}` : '', x.dn != null ? `▼ ${px(x.dn)}` : ''].filter(Boolean).join(' · '); return `${tf} ${n ? `${n.forming ? 'forming' : 'range'} ${px(n.lo)}–${px(n.hi)} · if up ${px(n.hi + h)} · if down ${px(n.lo - h)}` : 'no range'}${tg ? ` · open targets ${tg}` : ''}`; };
  out.push('', '<b>Range targets</b> (FEELS)', ` ${rg('4H')}`, ` ${rg('D')}`);
  return out;
}

/** The card as Telegram HTML: one message (two if over 4,096 characters); `ai` is the AI read (plain text) if any. */
export function coinCardText(card: CoinCard, ai: string | null): string[] {
  const f = card.funding;
  const head = [
    `📊 <b>${card.symbol}</b> · W / D / 4H card · ${utc(card.at)}`,
    `Price ${px(card.price)} · 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`} (${px(card.low24h)} – ${px(card.high24h)})${f ? ` · funding ${sg(f.rate * 100, 4)}% / ${f.intervalHours}h` : ''}`,
  ];
  if (ai) head.push('', `🤖 <b>AI read</b> (${COIN_CARD.aiModelName} · not advice)`, ` ${esc(ai)}`);
  const body = cardBody(card), all = [...head, '', ...body].join('\n');
  if (all.length <= COIN_CARD.maxText) return [all];
  const cut = body.indexOf('<b>Order blocks</b> (MarketMaulers · LuxAlgo)') - 1;
  return [[...head, '', ...body.slice(0, cut)].join('\n'), [`📊 <b>${card.symbol}</b> · card (2/2) · ${utc(card.at)}`, ...body.slice(cut)].join('\n')];
}

/** What the AI read is written from: the card body as plain text, with the price line. */
export function aiInput(card: CoinCard): string {
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return [`${card.symbol} at the ${utc(card.at)} close. Price ${px(card.price)}, 24h ${card.change24h == null ? '-' : `${sg(card.change24h, 1)}%`}.`, ...cardBody(card).map(strip)].join('\n');
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
