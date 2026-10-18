// Entry references (owner 2026-10-18: "Did you check combination of most of our indicators, I'm looking for best
// reference for entry primarily with average TP's ranges"): which card script, family or combination of them is the
// best place to enter BTC / ETH, and how far price runs from it. The ETH / BTC card (coincard.ts) is rebuilt at every
// 4H close of the research window and its references are tested as limit orders.
//
// Rules, fixed here before the run (nothing is tuned afterwards):
// - Closes: every 4H close from 2023-07-01 (a year of Bitunix history before it) to 7 days before the ETH research end
//   (ETH_PERIODS.holdoutFrom, 2026-04-12); the holdout months are not loaded. At each close the card gets the worker's
//   history (4H 1095 days, daily 1100, 1H 75, 15m 3). CryptoDataAPI, CoinLobster and LiqWall are live only (no
//   history), so they are left out.
// - A reference: one zone or level on one side of the price (long under it, short over it) within the card's 4 daily
//   ATR; a zone no taller than 1 daily ATR (the card's POI seed rule); order blocks and gaps only on their own side, as
//   on the card. At each close every group below takes its nearest reference a side.
// - Entry: a limit at the reference's near edge for the next 4H bar only (on 15m bars: the first that trades through
//   it; at its open if it opens past the edge). Stop: 0.5 4H ATR(14) beyond the far edge (a level is its own far edge).
//   One trade a group and side at a time: the next one from the first close after the stop or the 7 days.
// - Each trade, on 15m bars for 7 days at most (a bar reaching the stop and a target counts as the stop; on the fill
//   bar only the stop and its close count):
//   - held: 1 4H ATR in favour before the stop;
//   - run: the largest move in favour before the stop, in % of the entry (the TP range);
//   - R with the target at 1R, 2R or 3R, or at the next card POI on the other side (its near edge as the card showed
//     it at the close): the target +kR, the stop −1R, otherwise the close after the 7 days; less 0.22% of the price a
//     round trip.
// - Groups:
//   - the card's POIs: all; by scripts (10–12 / 13–15 / 16+), by families, by timeframes; with / without each family;
//     each pair of families; with each script;
//   - the card's POIs split by 9 trend / momentum reads at the close (agree with the trade or not);
//   - every merged cluster (the card's merge, 1 family and 1 script at least), by its number of scripts;
//   - each family, timeframe and script alone;
//   - the null lines: a plain level, and a plain zone 0.5 daily ATR tall, 0.1 / 0.25 / 0.5 daily ATR from the close
//     (the references that fill sit about that near).
// - Cells: BTC and ETH, each in two halves (2023-07-01 – 2024-11-16, 2024-11-16 – 2026-04-05). A group and target hold
//   up only with avg R over 0 in all four cells (5+ trades each, 30+ in all) and over every null line's. About 160
//   groups x 2 sides x 4 targets are tested, so a few will pass by luck alone.
// Round 2 (owner 2026-10-18: "Are we still using seeking deeper support or resistance or supply and demand for this
// strategy?"; the owner's rules of 2026-10-03: S/R channels only as deep support / resistance, zone entries 0–30% deep,
// and the deeper zones), fixed before its run; the same closes, fills, stops and targets:
// - Deeper POIs: the card's 2nd and 3rd POI a side (the order follows the card from close to close, as a resting order
//   would).
// - Deep S/R: the S/R Channels of 3+ pivots (the 2026-10-03 rule), alone and in a card POI.
// - 10 / 20 / 30% into the zone, the stop still beyond its far edge: the card's POIs, every order-block and supply /
//   demand zone (family OB), BigBeluga S/D, LuxAlgo S/D Visible Range and LuxAlgo OB Detector.
// - The next deeper zone: BigBeluga S/D's and family OB's 2nd zone a side (the first one past the nearest one's far
//   edge).
// - Deeper null lines: a plain level and a 0.5 daily ATR zone, 1 and 2 daily ATR from the close. A round 2 group holds up
//   only over all ten null lines (round 1 keeps its six).
// Round 3 (owner 2026-10-18, after round 2's BigBeluga supply zones lost on shorts: "If we used it for shorts I'd should
// be paired with rsi I think"; the owner's 2026-10-04 rule: "over sold for long and over bought for shorts ... rsi cool
// off then enter"), fixed before its run; the same closes, fills, stops, targets and the ten null lines:
// - Stretched: RSI 14 at 70 or over for a short, 30 or under for a long (mirrored, so the longs are tested too).
// - Four reads at the close: the 4H RSI stretched; the daily RSI stretched (its last close); the 4H RSI stretched at any
//   of the last 6 closes; cooling off (stretched at one of the last 6 closes, not at this one).
// - Paired with BigBeluga S/D at the edge and 10 / 20 / 30% in, and with the card's POIs (edge): a group takes its
//   nearest reference only at a close where its read holds.
// Round 4 (owner 2026-10-18: "And trend exhaustion, maybe turtle soup? And we could test our rsi14 system against a rsi
// 21 and rsi30 for most things we've built"), fixed before its run; the same closes, fills, stops, targets, ten nulls:
// - Turtle soup (Raschke / Connors): a bar trades past the 20 bars' extreme before it (that extreme set 4+ bars earlier)
//   and that bar or the next closes back inside. Its zone runs from the sweep's extreme to the reclaimed level.
//   - As an entry: the nearest such zone on 4H and on daily bars, known at one of the last 6 (4H) / 3 (daily) closes and
//     not closed through since. The limit sits at the reclaimed level, the stop 0.5 4H ATR past the sweep.
//   - As a read: such a turtle soup on the trade's side, 4H (last 6 closes) or daily (last 3).
// - Trend exhaustion: DeMark's 9-count (TD setup, no price flip): 9+ closes in a row under (longs) / over (shorts) the
//   close 4 bars back, at one of the last 6 4H / 3 daily closes.
// - The four reads are paired as in round 3 (BigBeluga S/D at the edge and 10 / 20 / 30% in, the card's POIs).
// - RSI 21 and RSI 30: round 3's four reads (70 / 30, unchanged) with the longer RSI, on the same five references.
// Display only: nothing here trades. Pure apart from the stats encoding (portfolio.ts builds the cards).

import type { Candle } from '@bot/marketdata';
import { gunzipSync, gzipSync } from 'node:zlib';
import { rsi } from '../indicators';
import { adxDi } from './adxdi';
import { COIN_CARD, FAMS, pieceSide, pois, SCRIPT_OF, TFS, type CoinBuilt, type Fam, type Piece } from './coincard';
import { ETH_PERIODS } from './eth';
import { sqzMom } from './sqzmom';
import { vfi } from './vfi';

const H4 = 4 * 3_600_000, DAY = 86_400_000, Q = 900_000;

export const ER = {
  from: Date.UTC(2023, 6, 1), split: Date.UTC(2024, 10, 16), to: ETH_PERIODS.holdoutFrom - 7 * DAY,
  holdMs: 7 * DAY, stopAtr4h: 0.5, heldAtr4h: 1, tps: [1, 2, 3], costPct: 0.22, maxHeightAtrD: 1,
  poiScripts: [[10, 12], [13, 15], [16, Infinity]], clusterScripts: [[1, 3], [4, 6], [7, 9], [10, 12], [13, 15], [16, Infinity]],
  nulls: [{ d: 0.1, h: 0 }, { d: 0.25, h: 0 }, { d: 0.5, h: 0 }, { d: 0.1, h: 0.5 }, { d: 0.25, h: 0.5 }, { d: 0.5, h: 0.5 }], minN: 30, minCell: 5, runBin: 0.1, runBins: 300,
  /** Round 2: the deeper null lines, the zone depths, a deep S/R channel's pivots. */
  deepNulls: [{ d: 1, h: 0 }, { d: 2, h: 0 }, { d: 1, h: 0.5 }, { d: 2, h: 0.5 }], depths: [0.1, 0.2, 0.3], deepPivots: 3,
  /** Round 3: RSI 14 stretched at 70+ (shorts) / 30 or under (longs); "recent" = the last 6 4H closes. */
  rsiHi: 70, rsiLo: 30, rsiRecent: 6,
  /** Round 4: turtle soup's 20 bars and 4 older bars, the 9-count, the recent closes per timeframe, the longer RSIs. */
  turtleN: 20, turtleOlder: 4, tdCount: 9, recent4h: 6, recentD: 3, rsiLens: [21, 30],
  /** Live-only sources (no history). */
  live: ['CDA', 'LWW', 'LWL', 'OPT'],
} as const;

/** The trend / momentum reads at the close (each: up, down or neither). */
export const ER_CTX = ['EMA bias (daily close vs EMA 26)', 'D heat map trend', '4H heat map trend', 'D RSI 14 vs 50', 'D MACD histogram', 'D ADX / DI', 'D Squeeze Momentum', 'D VFI'] as const;
/** The card's scripts with a history (the live-only sources left out). */
export const ER_SCRIPTS = [...new Set(Object.entries(SCRIPT_OF).filter(([src]) => !(ER.live as ReadonlyArray<string>).includes(src)).map(([, s]) => s))];

type Side = 'long' | 'short';
const SIDES: Side[] = ['long', 'short'];
const range = (n: number, bs: ReadonlyArray<readonly [number, number]>) => { const b = bs.find(([lo, hi]) => n >= lo && n <= hi); return b ? (b[1] === Infinity ? `${b[0]}+` : `${b[0]}–${b[1]}`) : null; };
/** A null line: a plain level (h 0) or zone h daily ATR tall, its near edge d daily ATR from the close. */
export const nullName = (x: { d: number; h: number }) => `null · ${x.h ? `a ${x.h} daily ATR zone` : 'a level'} ${x.d} daily ATR from the close`;
const PAIRS = FAMS.flatMap((a, i) => FAMS.slice(i + 1).map((b) => [a, b] as const));
/** Round 2: the zones entered 10–30% deep (a script's name, or the card's POIs / every order-block and S/D zone). */
const DEEP_IN = ['card POI', 'family OB', 'BigBeluga S/D', 'LuxAlgo S/D Visible Range', 'LuxAlgo OB Detector'] as const;
const DEEP_SRC: Record<string, (typeof DEEP_IN)[number]> = { 'S/D': 'BigBeluga S/D', VR: 'LuxAlgo S/D Visible Range', OBD: 'LuxAlgo OB Detector' };
const pctIn = (base: string, p: number) => `deep · ${base} ${Math.round(p * 100)}% in`;
export const ER_DEEP = [
  'deep · card POI #2', 'deep · card POI #3', 'deep · S/R Channels, 3+ pivots', 'deep · card POI with a 3+ pivot S/R channel',
  ...DEEP_IN.flatMap((b) => ER.depths.map((p) => pctIn(b, p))), 'deep · BigBeluga S/D, next deeper zone', 'deep · family OB, next deeper zone',
];
/** Round 3: the RSI reads a zone is paired with (stretched = RSI 14 at 70+ for a short, 30 or under for a long). */
export const ER_RSI_CONDS = ['4H RSI stretched at the close', 'D RSI stretched', '4H RSI stretched in the last 6 closes', '4H RSI cooling off (stretched in the last 6 closes, not now)'] as const;
const sdIn = (p: number) => `BigBeluga S/D ${Math.round(p * 100)}% in`;
export const ER_RSI = ['card POI', ...[0, ...ER.depths].map(sdIn)].flatMap((b) => ER_RSI_CONDS.map((c) => `rsi · ${b} · ${c}`));
/** Which of ER_RSI_CONDS hold for a side, from the 4H RSI series (its last value the close) and the daily RSI. */
export function erRsiConds(rsi4h: ReadonlyArray<number | null>, rsiD: number | null | undefined, side: Side): boolean[] {
  const st = (x: number | null | undefined) => x != null && Number.isFinite(x) && (side === 'short' ? x >= ER.rsiHi : x <= ER.rsiLo);
  const now = st(rsi4h[rsi4h.length - 1]), recent = rsi4h.slice(-ER.rsiRecent).some(st);
  return [now, st(rsiD), recent, recent && !now];
}
/** Round 4: the trend-exhaustion reads, and the round 3 reads with RSI 21 / 30. */
export const ER_EXH_CONDS = ['4H turtle soup in the last 6 closes', 'D turtle soup in the last 3 closes', '4H 9-count exhaustion in the last 6 closes', 'D 9-count exhaustion in the last 3 closes'] as const;
const PAIR_BASES = ['card POI', ...[0, ...ER.depths].map(sdIn)];
export const ER_EXH = ['turtle · 4H turtle soup zone', 'turtle · D turtle soup zone', ...PAIR_BASES.flatMap((b) => ER_EXH_CONDS.map((c) => `exhaust · ${b} · ${c}`))];
export const ER_RSI2 = ER.rsiLens.flatMap((L) => PAIR_BASES.flatMap((b) => ER_RSI_CONDS.map((c) => `rsi${L} · ${b} · ${c}`)));
/**
 * Turtle soup (Raschke / Connors, Street Smarts) on closed bars: bar k trades under the lowest low of the 20 bars before
 * it (that low set 4+ bars before k) and k or k + 1 closes back above it; its zone runs from the sweep low up to the
 * reclaimed low (shorts mirrored). The ones known at one of the last `recent` closes and not closed through since.
 */
export function erTurtle(c: ReadonlyArray<Candle>, recent: number): { side: Side; lo: number; hi: number; j: number }[] {
  const out: { side: Side; lo: number; hi: number; j: number }[] = [], n = c.length;
  for (let k = Math.max(ER.turtleN, n - recent - 1); k < n; k++) for (const side of SIDES) {
    const L = side === 'long';
    let ext = L ? Infinity : -Infinity, at = -1;
    for (let q = k - ER.turtleN; q < k; q++) { const v = L ? c[q]!.low : c[q]!.high; if (L ? v <= ext : v >= ext) { ext = v; at = q; } }
    if (at > k - ER.turtleOlder || !(L ? c[k]!.low < ext : c[k]!.high > ext)) continue;
    for (const j of [k, k + 1]) {
      if (j >= n || !(L ? c[j]!.close > ext : c[j]!.close < ext)) continue;
      const sweep = L ? Math.min(c[k]!.low, c[j]!.low) : Math.max(c[k]!.high, c[j]!.high);
      let alive = j >= n - recent;
      for (let q = j + 1; q < n && alive; q++) alive = L ? c[q]!.close >= sweep : c[q]!.close <= sweep;
      if (alive) out.push({ side, lo: L ? sweep : ext, hi: L ? ext : sweep, j });
      break;
    }
  }
  return out;
}
/** DeMark's setup count (the TD Sequential 9, without the price flip): closes under (buy) / over (sell) the close 4 bars back in a row. */
export function erTdCounts(c: ReadonlyArray<Candle>): { buy: number[]; sell: number[] } {
  const buy: number[] = [], sell: number[] = [];
  c.forEach((b, i) => {
    const p = i >= 4 ? c[i - 4]!.close : NaN;
    buy.push(b.close < p ? (buy[i - 1] ?? 0) + 1 : 0);
    sell.push(b.close > p ? (sell[i - 1] ?? 0) + 1 : 0);
  });
  return { buy, sell };
}
/** Which of ER_EXH_CONDS hold for a side at the close (the 4H and daily bars up to it). */
export function erExhConds(h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, side: Side): boolean[] {
  const nine = (c: ReadonlyArray<Candle>, recent: number) => { const t = erTdCounts(c)[side === 'long' ? 'buy' : 'sell']; return t.slice(-recent).some((x) => x >= ER.tdCount); };
  return [erTurtle(h4, ER.recent4h).some((e) => e.side === side), erTurtle(d1, ER.recentD).some((e) => e.side === side), nine(h4, ER.recent4h), nine(d1, ER.recentD)];
}
/** An S/R channel of 3+ pivots (the owner's deep support / resistance). */
export const erDeepChan = (p: Piece) => p.src === 'Chan' && Number(/^(\d+) pivots$/.exec(p.note ?? '')?.[1] ?? 0) >= ER.deepPivots;
/** The zone p of its height deep from the near edge (the stop stays beyond the far edge). */
const into = (r: ErRef, side: Side, p: number): ErRef => ({ lo: r.lo, hi: r.hi, entry: side === 'long' ? r.hi - p * (r.hi - r.lo) : r.lo + p * (r.hi - r.lo) });
/** The next deeper zone a side: the nearest one whose near edge is past the nearest zone's far edge. */
export function erNextZone(xs: ReadonlyArray<ErRef>, side: Side): ErRef | null {
  const s = [...xs].sort((a, b) => (side === 'long' ? b.hi - a.hi : a.lo - b.lo)), z1 = s[0];
  return z1 ? s.find((z) => (side === 'long' ? z.hi < z1.lo : z.lo > z1.hi)) ?? null : null;
}

/** The groups in report order, by section. */
export function erSections(): { title: string; groups: string[] }[] {
  return [
    { title: 'Null lines (a plain level or zone, no script; the 1 and 2 daily ATR ones for round 2)', groups: [...ER.nulls, ...ER.deepNulls].map(nullName) },
    {
      title: `Card POIs (${COIN_CARD.poiMinScripts}+ scripts, ${COIN_CARD.poiMinFams}+ families, ${COIN_CARD.poiPerSide} a side)`,
      groups: [
        'card POI', ...ER.poiScripts.map((b) => `card POI · ${range(b[0], ER.poiScripts)} scripts`), ...['2', '3', '4', '5+'].map((n) => `card POI · ${n} families`),
        'card POI · with W', 'card POI · D, no W', 'card POI · 4H only', ...FAMS.flatMap((f) => [`card POI · with ${f}`, `card POI · without ${f}`]), ...PAIRS.map(([a, b]) => `card POI · ${a}+${b}`),
      ],
    },
    { title: 'Card POIs by the trend / momentum reads at the close', groups: [...ER_CTX.flatMap((c) => [`card POI · ${c} agrees`, `card POI · ${c} against`]), 'card POI · 4H Chop Zone trending', 'card POI · 4H Chop Zone yellow (chop)'] },
    { title: 'Card POIs with each script', groups: ER_SCRIPTS.map((s) => `card POI · with ${s}`) },
    { title: 'Every merged cluster, by its number of scripts', groups: ER.clusterScripts.map((b) => `cluster · ${range(b[0], ER.clusterScripts)} scripts`) },
    { title: 'Each family and timeframe alone', groups: [...FAMS.map((f) => `family · ${f}`), ...TFS.map((tf) => `timeframe · ${tf}`)] },
    { title: 'Each script alone', groups: ER_SCRIPTS.map((s) => `script · ${s}`) },
    { title: 'Deeper references (round 2: deeper POIs, deep S/R, 10–30% into zones, the next deeper zone)', groups: ER_DEEP },
    { title: 'RSI-paired references (round 3: BigBeluga S/D and the card POIs, only with the RSI read)', groups: ER_RSI },
    { title: 'Turtle soup and trend exhaustion (round 4: as entries, and paired as in round 3)', groups: ER_EXH },
    { title: 'RSI 21 and 30 (round 4: the round 3 reads with a longer RSI)', groups: ER_RSI2 },
  ];
}

export interface ErRef { lo: number; hi: number; /** The order's price when it is not the near edge (round 2's 10–30% in). */ entry?: number }
export interface ErSnap {
  t: number; price: number; atr4h: number; atrD: number;
  /** Each group's nearest reference a side. */
  refs: Map<string, { long?: ErRef; short?: ErRef }>;
  /** The near edge of the nearest card POI on the other side: a long's target (the nearest short POI's low) and a short's. */
  next: { long: number | null; short: number | null };
}

/** Every piece of the card with its family, in the card's own order (coinCard's POI input). */
export const erPieces = (b: CoinBuilt): { fam: Fam; p: Piece }[] => {
  const P = b.pieces, of = (fam: Fam, xs: Piece[]) => xs.map((p) => ({ fam, p }));
  return [...of('OB', P.ob), ...of('FVG', P.fvg), ...of('S/R', P.sr), ...of('Fib', P.fib), ...of('Liq', P.liq), ...of('Lvl', P.lvl)];
};

/** The trend / momentum reads (ER_CTX order) at the card's close: 1 up, −1 down, 0 neither or not known; and the 4H Chop
 * Zone: 1 trending, −1 yellow. */
export function erReads(b: CoinBuilt): { reads: (1 | -1 | 0)[]; chop: 1 | -1 | 0 } {
  const c = b.card, D = b.sets.D, d = D?.c ?? [], k = d.length - 1;
  const sg = (x: number | null | undefined): 1 | -1 | 0 => (x == null || !Number.isFinite(x) || x === 0 ? 0 : x > 0 ? 1 : -1);
  const yes = (x: boolean | null | undefined): 1 | -1 | 0 => (x == null ? 0 : x ? 1 : -1);
  const adx = d.length ? adxDi(d) : null, sq = d.length ? sqzMom(d) : null, vf = d.length ? vfi(d) : null, chop = c.tf['4H']?.chop;
  return {
    reads: [
      yes(c.stack.bias?.over), yes(c.tf.D?.vidyaUp), yes(c.tf['4H']?.vidyaUp), sg(c.tf.D?.rsi == null ? null : c.tf.D.rsi - 50),
      sg(D ? D.hist[D.last] : null), sg(adx ? adx.plus[k]! - adx.minus[k]! : null), sg(sq ? sq.val[k] : null), sg(vf ? vf.vfi[k] : null),
    ],
    chop: chop == null ? 0 : chop === 'yellow' ? -1 : 1,
  };
}

/** Every group's nearest reference a side at the card's close, or null without daily and 4H bars. */
export function erSnap(b: CoinBuilt): ErSnap | null {
  const c = b.card, D = b.sets.D, F = b.sets['4H'];
  if (!D || !F) return null;
  const atrD = D.atr[D.last]!, atr4h = F.atr[F.last]!, price = c.price;
  if (!(atrD > 0) || !(atr4h > 0)) return null;
  const refs = new Map<string, { long?: ErRef; short?: ErRef }>();
  const put = (key: string, side: Side, r: ErRef) => {
    let e = refs.get(key);
    if (!e) refs.set(key, (e = {}));
    const cur = e[side];
    if (!cur || (side === 'long' ? r.hi > cur.hi : r.lo < cur.lo)) e[side] = r;
  };
  for (const x of [...ER.nulls, ...ER.deepNulls]) {
    put(nullName(x), 'long', { lo: price - (x.d + x.h) * atrD, hi: price - x.d * atrD });
    put(nullName(x), 'short', { lo: price + x.d * atrD, hi: price + (x.d + x.h) * atrD });
  }
  // The card's POIs, with what each one is made of and the reads at the close.
  const { reads, chop } = erReads(b), rc = { long: erRsiConds(F.rsi, D.rsi[D.last], 'long'), short: erRsiConds(F.rsi, D.rsi[D.last], 'short') };
  // Round 4: the exhaustion reads, and round 3's reads with RSI 21 / 30 (each side).
  const ex = { long: erExhConds(F.c, D.c, 'long'), short: erExhConds(F.c, D.c, 'short') };
  const rl = ER.rsiLens.map((L) => { const r4 = rsi(F.c.map((x) => x.close), L), rd = rsi(D.c.map((x) => x.close), L).at(-1); return { L, long: erRsiConds(r4, rd, 'long'), short: erRsiConds(r4, rd, 'short') }; });
  const paired = (base: string, side: Side, r: ErRef) => {
    ER_EXH_CONDS.forEach((cn, i) => { if (ex[side][i]) put(`exhaust · ${base} · ${cn}`, side, r); });
    for (const x of rl) ER_RSI_CONDS.forEach((cn, i) => { if (x[side][i]) put(`rsi${x.L} · ${base} · ${cn}`, side, r); });
  };
  for (const side of SIDES) {
    const dir = side === 'long' ? 1 : -1;
    c.poi[side].forEach((z, k) => {
      const r = { lo: z.lo, hi: z.hi };
      if (k === 1) put('deep · card POI #2', side, r);
      if (k === 2) put('deep · card POI #3', side, r);
      for (const p of ER.depths) put(pctIn('card POI', p), side, into(r, side, p));
      ER_RSI_CONDS.forEach((cn, i) => { if (rc[side][i]) put(`rsi · card POI · ${cn}`, side, r); });
      paired('card POI', side, r);
      const keys = ['card POI', `card POI · ${z.fams.length >= 5 ? '5+' : z.fams.length} families`, z.tfs.includes('W') ? 'card POI · with W' : z.tfs.includes('D') ? 'card POI · D, no W' : 'card POI · 4H only'];
      const sb = range(z.scripts, ER.poiScripts);
      if (sb) keys.push(`card POI · ${sb} scripts`);
      for (const f of FAMS) keys.push(`card POI · ${z.fams.includes(f) ? 'with' : 'without'} ${f}`);
      for (const [a, bb] of PAIRS) if (z.fams.includes(a) && z.fams.includes(bb)) keys.push(`card POI · ${a}+${bb}`);
      ER_CTX.forEach((name, i) => { if (reads[i]) keys.push(`card POI · ${name} ${reads[i] === dir ? 'agrees' : 'against'}`); });
      if (chop) keys.push(chop > 0 ? 'card POI · 4H Chop Zone trending' : 'card POI · 4H Chop Zone yellow (chop)');
      for (const s of new Set(z.parts.map((x) => SCRIPT_OF[x.p.src] ?? x.p.src))) keys.push(`card POI · with ${s}`);
      if (z.parts.some((x) => erDeepChan(x.p))) keys.push('deep · card POI with a 3+ pivot S/R channel');
      for (const key of keys) put(key, side, r);
    });
  }
  // Every merged cluster (the card's merge, 1 family and 1 script at least), by its number of scripts.
  const all = erPieces(b), maxDist = c.poi.maxDist, maxWidth = ER.maxHeightAtrD * atrD;
  const cl = pois(all, price, { tolLevel: (price * COIN_CARD.srTolPct) / 100, tolZone: (price * COIN_CARD.zoneTolPct) / 100, maxDist, maxWidth, minFams: 1, minScripts: 1, n: 1000 });
  for (const side of SIDES) for (const z of cl[side]) { const sb = range(z.scripts, ER.clusterScripts); if (sb) put(`cluster · ${sb} scripts`, side, { lo: z.lo, hi: z.hi }); }
  // Each script, family and timeframe alone.
  const sdZones: Record<Side, ErRef[]> = { long: [], short: [] }, obZones: Record<Side, ErRef[]> = { long: [], short: [] };
  for (const { fam, p } of all) {
    const side: Side | null = p.lo > price ? 'short' : p.hi < price ? 'long' : null;
    if (!side || p.hi - p.lo > maxWidth || (side === 'short' ? p.lo - price : price - p.hi) > maxDist) continue;
    const own = pieceSide(fam, p);
    if (own != null && own !== (side === 'short' ? 1 : -1)) continue;
    const r = { lo: p.lo, hi: p.hi };
    put(`script · ${SCRIPT_OF[p.src] ?? p.src}`, side, r);
    put(`family · ${fam}`, side, r);
    put(`timeframe · ${p.tf}`, side, r);
    // Round 2: deep S/R channels, 10–30% into the order-block and supply / demand zones, their deeper zones.
    if (erDeepChan(p)) put('deep · S/R Channels, 3+ pivots', side, r);
    if (fam === 'OB') { for (const x of ER.depths) put(pctIn('family OB', x), side, into(r, side, x)); obZones[side].push(r); }
    const named = DEEP_SRC[p.src];
    if (named) for (const x of ER.depths) put(pctIn(named, x), side, into(r, side, x));
    if (p.src === 'S/D') {
      sdZones[side].push(r);
      for (const x of [0, ...ER.depths]) {
        ER_RSI_CONDS.forEach((cn, i) => { if (rc[side][i]) put(`rsi · ${sdIn(x)} · ${cn}`, side, x ? into(r, side, x) : r); });
        paired(sdIn(x), side, x ? into(r, side, x) : r);
      }
    }
  }
  // Round 4: the turtle soup zones as entries (the card's distance and height rules).
  for (const [tf, c, recent] of [['4H', F.c, ER.recent4h], ['D', D.c, ER.recentD]] as const) for (const e of erTurtle(c, recent)) {
    if (e.hi - e.lo > maxWidth || (e.side === 'long' ? !(e.hi < price) || price - e.hi > maxDist : !(e.lo > price) || e.lo - price > maxDist)) continue;
    put(`turtle · ${tf} turtle soup zone`, e.side, { lo: e.lo, hi: e.hi });
  }
  for (const side of SIDES) {
    const sd = erNextZone(sdZones[side], side), ob = erNextZone(obZones[side], side);
    if (sd) put('deep · BigBeluga S/D, next deeper zone', side, sd);
    if (ob) put('deep · family OB, next deeper zone', side, ob);
  }
  const ns = c.poi.short[0], nl = c.poi.long[0];
  return { t: c.at, price, atr4h, atrD, refs, next: { long: ns ? ns.lo : null, short: nl ? nl.hi : null } };
}

export interface ErTrade {
  group: string; side: Side; t: number; fillAt: number; endAt: number; entry: number; stop: number;
  /** The near edge's distance from the close, in daily ATR. */
  dist: number;
  stopPct: number; held: boolean; runPct: number;
  /** R after costs with the target at 1R / 2R / 3R, and at the next card POI (null without one). */
  r: number[]; rPoi: number | null;
}

/** The first index whose bar opens at or after `t` (bars in time order). */
export function lowerBound(c: ReadonlyArray<{ openTime: number }>, t: number): number {
  let lo = 0, hi = c.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime < t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * One limit order at the reference's near edge for the 4H bar after the close `o.t` (15m bars `m`; `k0` the first
 * index at or after `o.t`), and its trade if it fills; null when it does not.
 */
export function erTrade(m: ReadonlyArray<Candle>, k0: number, o: { t: number; side: Side; ref: ErRef; atr4h: number; next: number | null }): Omit<ErTrade, 'group' | 'dist'> | null {
  const L = o.side === 'long', g = L ? 1 : -1, near = o.ref.entry ?? (L ? o.ref.hi : o.ref.lo), stop = L ? o.ref.lo - ER.stopAtr4h * o.atr4h : o.ref.hi + ER.stopAtr4h * o.atr4h;
  let k = k0;
  while (k < m.length && m[k]!.openTime < o.t + H4 && !(L ? m[k]!.low <= near : m[k]!.high >= near)) k++;
  if (k >= m.length || m[k]!.openTime >= o.t + H4) return null;
  const f = m[k]!, entry = L ? Math.min(near, f.open) : Math.max(near, f.open), risk = (entry - stop) * g;
  const base = { side: o.side, t: o.t, fillAt: f.openTime, entry, stop };
  // It opened past the stop as well: stopped at once.
  if (!(risk > 0)) return { ...base, endAt: f.openTime + Q, stopPct: 0, held: false, runPct: 0, r: ER.tps.map(() => -1), rPoi: o.next == null ? null : -1 };
  const fav = (x: number) => (x - entry) * g, cost = (ER.costPct / 100) * entry, R = (move: number) => (move - cost) / risk;
  const poiMove = o.next == null ? NaN : fav(o.next);
  const hit: (number | null)[] = ER.tps.map(() => null);
  let poi: number | null = null, mfe = 0, stopped = false, endAt = f.openTime + ER.holdMs, last = f;
  if (L ? f.low <= stop : f.high >= stop) { stopped = true; endAt = f.openTime + Q; }
  else {
    mfe = Math.max(0, fav(f.close));
    for (let j = k + 1; j < m.length && m[j]!.openTime < f.openTime + ER.holdMs; j++) {
      const b = m[j]!;
      if (L ? b.low <= stop : b.high >= stop) { stopped = true; endAt = b.openTime + Q; break; }
      last = b;
      const ext = fav(L ? b.high : b.low);
      if (ext > mfe) mfe = ext;
      ER.tps.forEach((x, i) => { if (hit[i] == null && ext >= x * risk) hit[i] = R(x * risk); });
      if (poi == null && poiMove > 0 && ext >= poiMove) poi = R(poiMove);
    }
  }
  const out = (x: number | null) => x ?? (stopped ? R(-risk) : R(fav(last.close)));
  return { ...base, endAt, stopPct: (risk / entry) * 100, held: mfe >= ER.heldAtr4h * o.atr4h, runPct: (mfe / entry) * 100, r: hit.map(out), rPoi: poiMove > 0 ? out(poi) : null };
}

/** Every group's trades from the closes in time order (one coin's 15m bars). */
export function erRunner(m: ReadonlyArray<Candle>) {
  const busy = new Map<string, number>(), trades: ErTrade[] = [];
  let k = 0;
  return {
    trades,
    step(s: ErSnap) {
      while (k < m.length && m[k]!.openTime < s.t) k++;
      for (const [group, e] of s.refs) for (const side of SIDES) {
        const ref = e[side], key = `${group}|${side}`;
        if (!ref || (busy.get(key) ?? -Infinity) > s.t) continue;
        const tr = erTrade(m, k, { t: s.t, side, ref, atr4h: s.atr4h, next: s.next[side] });
        if (!tr) continue;
        busy.set(key, tr.endAt);
        trades.push({ ...tr, group, dist: Math.abs((ref.entry ?? (side === 'long' ? ref.hi : ref.lo)) - s.price) / s.atrD });
      }
    },
  };
}

/** One group and side's sums (they add up across cells): the run as a histogram of 0.1% bins (the last one 30%+). */
export interface ErStat { n: number; held: number; run: Record<number, number>; stop: number; dist: number; r: { n: number; sum: number; win: number }[] }
/** By `${group}|${side}`. */
export type ErStats = Record<string, ErStat>;
const blank = (): ErStat => ({ n: 0, held: 0, run: {}, stop: 0, dist: 0, r: [...ER.tps, 'poi'].map(() => ({ n: 0, sum: 0, win: 0 })) });

export function erStats(trades: ReadonlyArray<ErTrade>): ErStats {
  const out: ErStats = {};
  for (const x of trades) {
    const s = (out[`${x.group}|${x.side}`] ??= blank()), bin = Math.min(ER.runBins, Math.floor(x.runPct / ER.runBin + 1e-9));
    s.n++;
    if (x.held) s.held++;
    s.stop += x.stopPct;
    s.dist += x.dist;
    s.run[bin] = (s.run[bin] ?? 0) + 1;
    [...x.r, x.rPoi].forEach((v, i) => { if (v == null) return; const t = s.r[i]!; t.n++; t.sum += v; if (v > 0) t.win++; });
  }
  return out;
}

export function erMerge(xs: ReadonlyArray<ErStats>): ErStats {
  const out: ErStats = {};
  for (const x of xs) for (const [k, s] of Object.entries(x)) {
    const o = (out[k] ??= blank());
    o.n += s.n; o.held += s.held; o.stop += s.stop; o.dist += s.dist;
    for (const [b, n] of Object.entries(s.run)) o.run[Number(b)] = (o.run[Number(b)] ?? 0) + n;
    s.r.forEach((t, i) => { o.r[i]!.n += t.n; o.r[i]!.sum += t.sum; o.r[i]!.win += t.win; });
  }
  return out;
}

/** The run's q-quantile in % (the middle of its bin; Infinity in the 30%+ bin). */
export function runQ(s: ErStat, q: number): number {
  let acc = 0;
  for (const b of Object.keys(s.run).map(Number).sort((a, c) => a - c)) { acc += s.run[b]!; if (acc >= q * s.n) return b >= ER.runBins ? Infinity : (b + 0.5) * ER.runBin; }
  return NaN;
}

/** The stats as log lines (gzip, base64, in parts), read back by erDecode. */
export function erEncode(cell: string, s: ErStats, size = 3500): string[] {
  const b = gzipSync(Buffer.from(JSON.stringify(s))).toString('base64'), n = Math.ceil(b.length / size);
  return Array.from({ length: n }, (_, i) => `ERSTATS ${cell} ${i + 1}/${n} ${b.slice(i * size, (i + 1) * size)}`);
}

/** The cells found in a text (e.g. the runs' logs), complete ones only, by name. */
export function erDecode(text: string): { name: string; stats: ErStats }[] {
  const got = new Map<string, { n: number; parts: Map<number, string> }>();
  for (const x of text.matchAll(/ERSTATS (\S+) (\d+)\/(\d+) ([A-Za-z0-9+/=]+)/g)) {
    const e = got.get(x[1]!) ?? { n: Number(x[3]), parts: new Map<number, string>() };
    e.parts.set(Number(x[2]), x[4]!);
    got.set(x[1]!, e);
  }
  return [...got].filter(([, e]) => e.parts.size === e.n).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => ({ name, stats: JSON.parse(gunzipSync(Buffer.from(Array.from({ length: e.n }, (_, i) => e.parts.get(i + 1)!).join(''), 'base64')).toString()) as ErStats }));
}

const sgn = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}` : '-');
const p1 = (x: number) => (x === Infinity ? `${ER.runBins * ER.runBin}+` : Number.isFinite(x) ? x.toFixed(1) : '-');
const TARGETS = [...ER.tps.map((x) => `${x}R`), 'next POI'];
const avg = (t: { n: number; sum: number }) => (t.n ? t.sum / t.n : NaN);

/** The report: every group pooled over the cells, then the ones that hold up under the rule above. */
export function erReport(cells: ReadonlyArray<{ name: string; stats: ErStats }>): string[] {
  const all = erMerge(cells.map((c) => c.stats)), sections = erSections();
  const out = [
    `===== ENTRY REFERENCES: the card's scripts and their combinations as entries (rules in screen/entryref.ts, fixed before the run) =====`,
    `Cells: ${cells.map((c) => c.name).join(', ') || '-'}. Entry: a limit at the reference's near edge for the next 4H bar; stop ${ER.stopAtr4h} 4H ATR beyond its far edge; ${ER.holdMs / DAY} days at most; costs ${ER.costPct}% a round trip.`,
    `Per group: trades · held (${ER.heldAtr4h} 4H ATR in favour before the stop) · run = the largest move in favour before the stop, median (P25–P75): the TP range · stop distance and entry distance from the close (averages) · avg R after costs (win %) with the target at ${TARGETS.join(' / ')} · avg R at 2R in each cell.`,
  ];
  const row = (g: string, side: Side) => {
    const s = all[`${g}|${side}`];
    if (!s?.n) return ` ${g}: no trades`;
    const r = s.r.map((t, i) => `${TARGETS[i]} ${sgn(avg(t))} (${t.n ? Math.round((t.win / t.n) * 100) : 0}%${i === ER.tps.length && t.n !== s.n ? `, n ${t.n}` : ''})`).join(' · ');
    const cell = cells.map((c) => { const x = c.stats[`${g}|${side}`]?.r[1]; return x?.n ? sgn(avg(x)) : '-'; }).join(' / ');
    return ` ${g}: n ${s.n} · held ${Math.round((s.held / s.n) * 100)}% · run ${p1(runQ(s, 0.5))}% (${p1(runQ(s, 0.25))}–${p1(runQ(s, 0.75))}%) · stop ${(s.stop / s.n).toFixed(1)}% · ${(s.dist / s.n).toFixed(1)} daily ATR away · R ${r}${cells.length > 1 ? ` | 2R by cell ${cell}` : ''}`;
  };
  for (const side of SIDES) {
    out.push('', `--- ${side === 'long' ? 'LONGS (references under the price)' : 'SHORTS (references over the price)'} ---`);
    for (const sec of sections) out.push(` [${sec.title}]`, ...sec.groups.map((g) => row(g, side)));
  }
  // The rule: avg R over 0 in every cell (minCell trades each, minN in all) and over every null line's (round 2's and 3's
  // groups: the deeper null lines too).
  const holds: string[] = [], deep = new Set([...ER_DEEP, ...ER_RSI, ...ER_EXH, ...ER_RSI2]);
  for (const side of SIDES) for (const g of sections.slice(1).flatMap((s) => s.groups)) {
    const s = all[`${g}|${side}`];
    if (!s) continue;
    TARGETS.forEach((name, i) => {
      const t = s.r[i]!, per = cells.map((c) => c.stats[`${g}|${side}`]?.r[i]);
      const best = Math.max(...(deep.has(g) ? [...ER.nulls, ...ER.deepNulls] : ER.nulls).map((x) => avg(all[`${nullName(x)}|${side}`]?.r[i] ?? { n: 0, sum: 0 })).filter(Number.isFinite));
      if (t.n < ER.minN || per.some((x) => !x || x.n < ER.minCell || !(avg(x) > 0)) || !(avg(t) > (Number.isFinite(best) ? best : 0))) return;
      holds.push(` ${side} · ${g} · target ${name}: avg R ${sgn(avg(t))} (n ${t.n}, win ${Math.round((t.win / t.n) * 100)}%) · cells ${per.map((x) => sgn(avg(x!))).join(' / ')} · run ${p1(runQ(s, 0.5))}% (${p1(runQ(s, 0.25))}–${p1(runQ(s, 0.75))}%) · stop ${(s.stop / s.n).toFixed(1)}%`);
    });
  }
  out.push('', `===== HOLD UP: avg R over 0 in every cell (${ER.minCell}+ trades each, ${ER.minN}+ in all) and over every null line's, same side and target =====`, ...(holds.length ? holds : [' none']));
  return out;
}
