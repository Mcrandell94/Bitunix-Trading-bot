// © LuxAlgo, "Support and Resistance Levels with Breaks" (Pine v4), licensed CC BY-NC-SA 4.0
// (https://creativecommons.org/licenses/by-nc-sa/4.0/): attribution, non-commercial use only, adaptations under the same
// licence. This file ports its calculations for research.
//
// Owner 2026-10-10: "I would like to explore if giving another script would help mark levels ... Just test it and give
// results, also test on other models please". The script, with its defaults (left and right bars 15, volume threshold 20):
// - resistance = the last pivot high (a high over the 15 bars before it and the 15 after; ties go to the left-most), from
//   the bar after the pivot is confirmed: fixnan(pivothigh(15, 15)[1]); support = the same with pivot lows;
// - volume oscillator = 100 x (EMA 5 - EMA 10) / EMA 10 of volume;
// - "B": the close crosses over resistance (under support) with the oscillator over 20, unless the bar is a wick;
// - Bull Wick: the close crosses over resistance with the lower wick (open - low) longer than the body (close - open);
//   Bear Wick: the close crosses under support with the part above the open (high - open) longer than the body
//   (open - close). Neither needs volume.
// Pine's crossover compares each bar with its own level (close[1] <= level[1], close > level). Bitunix gives quote volume;
// it is turned into coin units with each bar's typical price (TradingView shows crypto volume in coin units).
//
// Rules of the test, fixed before the runs (research and fresh $0.5M+ coins, BTC out of the fresh set):
// A. The script's own signals on 4H and daily bars: a resistance or support "B" and a Bull / Bear Wick, each traded with
//    the break and against it, and a bounce off a drawn level (the bar's low trades to support and it closes back above,
//    or its high to resistance and it closes back below; the level unchanged and the bar before on the same side).
//    Entry at the next open, stop 2 ATR(14), 2R or 3R target, no time limit, one trade per coin and line at a time,
//    costs 0.22%. Baselines (10 seeds each): the same entry in a random direction; the same side at a random bar in the
//    next 60 days with the same stop % and exit. A line works if avg R > 0 and both edges > 0 on research and fresh
//    coins (>= 30 trades each); confirmed if the timing edge has t >= 2 on both.
// B. The other models' trades, split by the script as of their signal bar: the live models (rule set option 1, each
//    on its one exit, no time limit) on their own frame's levels (daily for the daily and weekly models, 4H for the 4H
//    models), 15M-RSI10 on 4H levels, and the funding squeeze line (4H signal, 1H confirmation) on 4H levels:
//    - a "B" in the last 10 bars: with the trade / against it / both / none;
//    - the level on the trade's side (support for longs, resistance for shorts): the signal close within 1 ATR of it
//      ('at the level'), more than 1 ATR past it ('broken'), more than 1 ATR short of it ('away'), or none yet;
//    - the opposite level (resistance for longs, support for shorts) within 2R of the entry ('in the way') or not.
//    Each bucket is compared with what its trades' models make on that coin set (model-mix expected). A bucket is a
//    filter only if the difference is >= +0.10 R (take) or <= -0.10 R (skip) on both coin sets with >= 30 trades on each.
// C. Chart check: the levels and the latest labels on ETH and SOL, 4H and daily, to compare with TradingView.
// Nothing goes live from this test.

import type { Candle } from '@bot/marketdata';
import { atrWilder, ema } from '../indicators';
import type { FundingPoint } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { fvConfluenceTrades } from './fundvol';
import { frameworkSetups, RSI_MODELS, rowsFromSetups, rsiFrameworkSignals, SIGNAL_EXITS, type RsiModelId, type Setup } from './rsisignals';
import { rsi10LiveSetups } from './rsi10live';
import { STATS_HEAD } from './smcreport';
import { randomDirectionTwins, randomTimeTwins, timingLine, type TimedRow } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, H4 = 4 * H, DAY = 24 * H, SEEDS = 10, SPAN_DAYS = 60, STOP_ATR = 2, RECENT = 10;

export interface SrbSettings { left: number; right: number; volumeThresh: number }
export const SRB_DEFAULTS: SrbSettings = { left: 15, right: 15, volumeThresh: 20 };
/** What the script draws on a bar: 'B' (a break with volume) or a wick label, or nothing. */
export type SrbLabel = 'B' | 'wick' | null;
export interface SrbSeries {
  /** Resistance / support on each bar (Pine's highUsePivot / lowUsePivot); null before the first pivot. */
  res: (number | null)[];
  sup: (number | null)[];
  /** The pivot bar behind each level (for the chart check). */
  resAt: (number | null)[];
  supAt: (number | null)[];
  osc: (number | null)[];
  /** The close crossed over resistance ('B' or a Bull Wick) / under support ('B' or a Bear Wick) on this bar. */
  up: SrbLabel[];
  down: SrbLabel[];
}

/**
 * ta.pivothigh / ta.pivotlow (left, right): the value at bar i - right if it tops (bottoms) the `left` bars before it and
 * the `right` bars after it, confirmed at bar i. Ties go to the left-most bar, as pivotAt in srchannels.ts.
 */
export function pinePivot(src: ArrayLike<number>, i: number, left: number, right: number, high: boolean): number | null {
  const k = i - right;
  if (k - left < 0 || i >= src.length) return null;
  const v = src[k]!;
  for (let q = 1; q <= left; q++) if (high ? src[k - q]! > v : src[k - q]! < v) return null;
  for (let q = 1; q <= right; q++) if (high ? src[k + q]! >= v : src[k + q]! <= v) return null;
  return v;
}

/** The script on one series of bars (oldest first). */
export function srBreaks(c: ReadonlyArray<Candle>, s: SrbSettings = SRB_DEFAULTS): SrbSeries {
  const n = c.length, hi = c.map((b) => b.high), lo = c.map((b) => b.low);
  const vol = c.map((b) => { const tp = (b.high + b.low + b.close) / 3; return b.volume != null && tp > 0 ? b.volume / tp : 0; });
  const e5 = ema(vol, 5), e10 = ema(vol, 10);
  const out: SrbSeries = { res: [], sup: [], resAt: [], supAt: [], osc: [], up: [], down: [] };
  for (let i = 0; i < n; i++) {
    let res = i > 0 ? out.res[i - 1]! : null, sup = i > 0 ? out.sup[i - 1]! : null, resAt = i > 0 ? out.resAt[i - 1]! : null, supAt = i > 0 ? out.supAt[i - 1]! : null;
    // pivothigh(left, right)[1]: the pivot confirmed on the bar before (its centre is `right` bars before that).
    const ph = i > 0 ? pinePivot(hi, i - 1, s.left, s.right, true) : null, pl = i > 0 ? pinePivot(lo, i - 1, s.left, s.right, false) : null;
    if (ph != null) { res = ph; resAt = i - 1 - s.right; }
    if (pl != null) { sup = pl; supAt = i - 1 - s.right; }
    const osc = e5[i] != null && e10[i] != null && e10[i]! > 0 ? (100 * (e5[i]! - e10[i]!)) / e10[i]! : null;
    let up: SrbLabel = null, down: SrbLabel = null;
    if (i > 0) {
      const b = c[i]!, p = c[i - 1]!, pr = out.res[i - 1]!, ps = out.sup[i - 1]!, loud = osc != null && osc > s.volumeThresh;
      if (res != null && pr != null && b.close > res && p.close <= pr) up = b.open - b.low > b.close - b.open ? 'wick' : loud ? 'B' : null;
      if (sup != null && ps != null && b.close < sup && p.close >= ps) down = b.open - b.close < b.high - b.open ? 'wick' : loud ? 'B' : null;
    }
    out.res.push(res); out.sup.push(sup); out.resAt.push(resAt); out.supAt.push(supAt); out.osc.push(osc); out.up.push(up); out.down.push(down);
  }
  return out;
}

/** Part A's signal kinds: [key, label, which way "with" trades]. */
const KINDS = [
  ['res-B', 'resistance break "B"', 1],
  ['res-wick', 'resistance break, Bull Wick', 1],
  ['sup-B', 'support break "B"', -1],
  ['sup-wick', 'support break, Bear Wick', -1],
  ['bounce-sup', 'bounce off support', 1],
  ['bounce-res', 'bounce off resistance', -1],
] as const;
type Kind = (typeof KINDS)[number][0];
const EXITS: ReadonlyArray<ExitSpec> = [{ name: '2R target', target: 2 }, { name: '3R target', target: 3 }];
const FRAMES = [{ tf: '4h', label: '4H', ms: H4 }, { tf: '1d', label: 'Daily', ms: DAY }] as const;

/** Part A's events on bar i of one series (the kinds whose signal closes on that bar). */
export function srbEvents(c: ReadonlyArray<Candle>, sr: SrbSeries, i: number): Kind[] {
  const out: Kind[] = [], b = c[i]!, p = c[i - 1];
  if (sr.up[i] === 'B') out.push('res-B');
  if (sr.up[i] === 'wick') out.push('res-wick');
  if (sr.down[i] === 'B') out.push('sup-B');
  if (sr.down[i] === 'wick') out.push('sup-wick');
  const s = sr.sup[i], r = sr.res[i];
  if (p && s != null && sr.sup[i - 1] === s && b.low <= s && b.close > s && p.close > s) out.push('bounce-sup');
  if (p && r != null && sr.res[i - 1] === r && b.high >= r && b.close < r && p.close < r) out.push('bounce-res');
  return out;
}

/** Part B's buckets for a trade on side d, as of bar k of a frame (close, ATR and the script there). */
export interface SrbContext { brk: 'with' | 'against' | 'both' | 'none'; own: 'at the level' | 'broken' | 'away' | 'none'; room: 'in the way' | 'clear' }
export function srbContext(c: ReadonlyArray<Candle>, sr: SrbSeries, atr: ReadonlyArray<number | null>, k: number, d: 1 | -1, entry: number, risk: number): SrbContext {
  let w = false, a = false;
  for (let q = Math.max(1, k - RECENT + 1); q <= k; q++) {
    if ((d > 0 ? sr.up[q] : sr.down[q]) === 'B') w = true;
    if ((d > 0 ? sr.down[q] : sr.up[q]) === 'B') a = true;
  }
  const brk = w && a ? 'both' : w ? 'with' : a ? 'against' : 'none';
  const lvl = d > 0 ? sr.sup[k] : sr.res[k], at = atr[k], close = c[k]!.close;
  let own: SrbContext['own'] = 'none';
  if (lvl != null && at != null && at > 0) { const x = (d * (close - lvl)) / at; own = x < -1 ? 'broken' : x <= 1 ? 'at the level' : 'away'; }
  const opp = d > 0 ? sr.res[k] : sr.sup[k], y = opp == null ? null : (d * (opp - entry)) / risk;
  return { brk, own, room: y != null && y > 0 && y <= 2 ? 'in the way' : 'clear' };
}
const FAMILIES = [
  ['brk', 'a "B" in the last 10 bars', ['with', 'against', 'both', 'none']],
  ['own', 'the level on the trade\'s side (support for longs, resistance for shorts)', ['at the level', 'away', 'broken', 'none']],
  ['room', 'the opposite level within 2R of the entry', ['in the way', 'clear']],
] as const;

type BModel = RsiModelId | 'fv-confluence';
interface Frame { c: ReadonlyArray<Candle>; sr: SrbSeries; atr: ReadonlyArray<number | null> }
interface BRow { model: BModel; sym: string; t: number; r: number; ctx: SrbContext }
const bLabel = (m: BModel) => (m === 'fv-confluence' ? 'Funding squeeze, 4H signal + 1H confirmation' : RSI_MODELS[m].label);

/** The index of the last bar of `c` (bars `ms` long) closed by time t, or -1. */
function closedBy(c: ReadonlyArray<Candle>, t: number, ms: number): number {
  let k = -1;
  for (let lo = 0, hi = c.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (c[m]!.openTime + ms <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

/**
 * The report (header). Needs 1d and 4h; 15m and 1h for 15M-RSI10 and 1h with funding for the funding squeeze line (both
 * left out where missing). `skip` = reference coins (BTC on fresh sets): loaded, not counted. `dump` prints the per-line
 * sums (SUM lines) for merging sliced runs.
 */
export function srBreaksReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set(), dump = false): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const A = new Map<string, TimedRow[]>(), B: BRow[] = [], chart: string[] = [], labels = new Map<string, number>();
  const btc = data['BTCUSDT']?.candles['1d'] ?? [];
  let used = 0, rsi10Coins = 0, fvCoins = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 100 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = (data[sym]?.candles['4h'] ?? []).filter((b) => b.openTime + H4 <= now);
    const F: Record<'4h' | '1d', Frame> = { '4h': { c: h4, sr: srBreaks(h4), atr: atrWilder(h4, 14) }, '1d': { c: d1, sr: srBreaks(d1), atr: atrWilder(d1, 14) } };

    // A. The script's own signals.
    for (const { tf, ms } of FRAMES) {
      const { c, sr, atr } = F[tf], busy = new Map<string, number>(), span = Math.round((SPAN_DAYS * DAY) / ms);
      for (let i = 1; i + 1 < c.length; i++) {
        const kinds = srbEvents(c, sr, i), a = atr[i];
        if (!kinds.length || a == null || !(a > 0)) continue;
        const j = i + 1, entry = c[j]!.open;
        for (const kind of kinds) {
          if (c[j]!.openTime >= from) labels.set(`${tf}|${kind}`, (labels.get(`${tf}|${kind}`) ?? 0) + 1);
          const w = KINDS.find((x) => x[0] === kind)![2];
          for (const [dir, d] of [['with', w], ['against', -w]] as const) {
            if (dir === 'against' && kind.startsWith('bounce')) continue;
            const stop = entry - d * STOP_ATR * a;
            for (const ex of EXITS) {
              const key = `${tf}|${kind}|${dir}|${ex.name}`;
              if (i < (busy.get(key) ?? -1)) continue;
              const t = specTrade(c, atr, {}, j, stop, d as 1 | -1, ex);
              if (!t) continue;
              busy.set(key, t.open ? Infinity : t.end);
              if (c[j]!.openTime < from) continue;
              const list = A.get(key) ?? [];
              list.push({
                sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: (c[t.end]!.openTime - c[j]!.openTime) / DAY,
                rand: randomDirectionTwins(c, atr, sym, j, stop, d as 1 | -1, ex, SEEDS), rtime: randomTimeTwins(c, atr, sym, j, stop, d as 1 | -1, ex, span, SEEDS),
              });
              A.set(key, list);
            }
          }
        }
      }
    }

    // B1. The live models: rule set option 1, each on its one exit, no time limit (the bot's signals since 2026-10-09).
    const byKey = new Map(frameworkSetups(d1, h4).map((s) => [`${s.model}|${s.known}`, s]));
    const fromRows = (rows: ReturnType<typeof rsiFrameworkSignals>, setups: ReadonlyMap<string, Setup>, frame: (s: Setup) => { k: number; f: Frame } | null) => {
      for (const r of rows) {
        if (!r.plans.includes('option 1') || r.enteredAt == null || r.enteredAt < from || r.r == null) continue;
        const s = setups.get(`${r.model}|${r.signalAt}`), lx = SIGNAL_EXITS[r.model]?.exit;
        if (!s || !lx || s.j == null || s.stop == null || s.j >= s.c.length) continue;
        const fk = frame(s);
        if (!fk || fk.k < 1) continue;
        const entry = s.c[s.j]!.open, risk = lx.stopMult * s.d * (entry - s.stop);
        if (!(risk > 0)) continue;
        B.push({ model: r.model, sym, t: r.enteredAt, r: r.r, ctx: srbContext(fk.f.c, fk.f.sr, fk.f.atr, fk.k, s.d, entry, risk) });
      }
    };
    fromRows(rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc, { live: true }), byKey, (s) => ({ k: s.j! - 1, f: s.bar === H4 ? F['4h'] : F['1d'] }));

    // B2. 15M-RSI10 on its live rules and exit, 4H levels as of its signal.
    const m15 = (data[sym]?.candles['15m'] ?? []).filter((b) => b.openTime + 15 * 60_000 <= now), h1 = (data[sym]?.candles['1h'] ?? []).filter((b) => b.openTime + H <= now);
    if (m15.length >= 2000 && h1.length >= 200) {
      rsi10Coins++;
      const setups = rsi10LiveSetups(m15, h1, h4, d1, Math.max(from, m15[0]!.openTime + 30 * DAY));
      fromRows(rowsFromSetups(sym, setups, d1, now, 100_000, btc, { live: true }), new Map(setups.map((s) => [`${s.model}|${s.known}`, s])), (s) => ({ k: closedBy(h4, s.known, H4), f: F['4h'] }));
    }

    // B3. The funding squeeze line (4H signal, 1H confirmation), 4H levels as of the signal bar.
    const fs = data[sym]?.funding ?? [];
    if (fs.length >= 10 && h1.length >= 200 && h4.length >= 100) {
      fvCoins++;
      for (const x of fvConfluenceTrades(h4, h1, fs, H, from).trades) {
        if (x.i < 1) continue;
        B.push({ model: 'fv-confluence', sym, t: h1[x.j]!.openTime, r: x.t.r, ctx: srbContext(h4, F['4h'].sr, F['4h'].atr, x.i, x.d, h1[x.j]!.open, x.risk) });
      }
    }

    // C. Chart check.
    if (sym === 'ETHUSDT' || sym === 'SOLUSDT') for (const { tf, label } of FRAMES) {
      const { c, sr } = F[tf], last = c.length - 1, ts = (i: number) => new Date(c[i]!.openTime).toISOString().slice(0, 16).replace('T', ' ');
      const px = (x: number | null) => (x == null ? '-' : String(Number(x.toPrecision(6))));
      chart.push('', `${sym} ${label}: resistance ${px(sr.res[last]!)} (pivot bar ${sr.resAt[last] != null ? ts(sr.resAt[last]!) : '-'}), support ${px(sr.sup[last]!)} (pivot bar ${sr.supAt[last] != null ? ts(sr.supAt[last]!) : '-'}); latest labels (bar open, UTC):`);
      const marks: string[] = [];
      for (let i = last; i > 0 && marks.length < 8; i--) {
        const osc = sr.osc[i] == null ? '-' : sr.osc[i]!.toFixed(0);
        if (sr.up[i]) marks.push(`  ${ts(i)}  ${sr.up[i] === 'B' ? 'B (resistance broken)' : 'Bull Wick'}  close ${px(c[i]!.close)} over ${px(sr.res[i]!)}, volume osc ${osc}`);
        if (sr.down[i]) marks.push(`  ${ts(i)}  ${sr.down[i] === 'B' ? 'B (support broken)' : 'Bear Wick'}  close ${px(c[i]!.close)} under ${px(sr.sup[i]!)}, volume osc ${osc}`);
      }
      chart.push(...marks);
    }
  }

  const out = [
    `SUPPORT AND RESISTANCE LEVELS WITH BREAKS (LuxAlgo port, rules fixed before the run): ${day(from)} to now, ${used} coins (15M-RSI10 on ${rsi10Coins} with 15m history, the funding squeeze on ${fvCoins} with funding). Older / newer = before / after ${day(cut)}.`,
    'Levels: the last pivot high / low (15 bars each side), from the bar after it is confirmed. "B" = the close crosses the level with the volume oscillator (EMA 5 vs 10) over 20 and no wick; Bull / Bear Wick = the close crosses with a wick longer than the body (no volume test).',
    '',
    `A. THE SCRIPT'S OWN SIGNALS: entry at the next open, stop ${STOP_ATR} ATR(14), no time limit, costs 0.22%, one trade per coin and line at a time. Baselines (${SEEDS} seeds each): random direction; the same side at a random bar in the next ${SPAN_DAYS} days (timing edge, t).`,
  ];
  for (const { tf, label } of FRAMES) {
    const counts = KINDS.map(([k, l]) => `${l} ${labels.get(`${tf}|${k}`) ?? 0}`).join(', ');
    out.push('', `${label} bars. Signals in the window: ${counts}.`, STATS_HEAD);
    for (const [kind, kl, w] of KINDS) for (const dir of ['with', 'against'] as const) for (const ex of EXITS) {
      if (dir === 'against' && kind.startsWith('bounce')) continue;
      const xs = A.get(`${tf}|${kind}|${dir}|${ex.name}`) ?? [], side = (dir === 'with' ? w : -w) > 0 ? 'long' : 'short';
      const name = `  ${kl}, ${kind.startsWith('bounce') ? '' : `trade ${dir} it, `}${side}, ${ex.name}`;
      out.push(xs.length ? timingLine(name.slice(0, 84).padEnd(84), xs, cut) : `${name}: no trades`);
    }
  }

  // B. Each bucket against its trades' model mix (each trade counted at its model's avg R on this coin set).
  const avg = (xs: ReadonlyArray<number>) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : NaN);
  const f2 = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}` : '-');
  const modelAvg = new Map<BModel, number>();
  for (const m of new Set(B.map((x) => x.model))) modelAvg.set(m, avg(B.filter((x) => x.model === m).map((x) => x.r)));
  const groups: [string, BRow[]][] = [
    ['LIVE MODELS (option 1, one exit each, no time limit), pooled', B.filter((x) => x.model !== 'fv-confluence' && x.model !== '15m-rsi10')],
    ['15M-RSI10 (live rules, 10R target)', B.filter((x) => x.model === '15m-rsi10')],
    ['FUNDING SQUEEZE (4H signal + 1H confirmation, 2R target)', B.filter((x) => x.model === 'fv-confluence')],
  ];
  out.push('', 'B. THE OTHER MODELS\' TRADES BY THE SCRIPT AT THEIR SIGNAL BAR: n, avg R, expected from the model mix, difference (avg R older / newer).');
  for (const [name, xs] of groups) {
    out.push('', `  ${name}: ${xs.length} trades, avg R ${f2(avg(xs.map((x) => x.r)))}`);
    if (!xs.length) continue;
    for (const [fam, title, buckets] of FAMILIES) {
      out.push(`    ${title}:`);
      for (const b of buckets) {
        const g = xs.filter((x) => x.ctx[fam] === b);
        if (!g.length) continue;
        const real = avg(g.map((x) => x.r)), exp = avg(g.map((x) => modelAvg.get(x.model)!));
        out.push(`      ${b.padEnd(14)} n ${String(g.length).padStart(5)}  avg R ${f2(real).padStart(6)}  expected ${f2(exp).padStart(6)}  difference ${f2(real - exp).padStart(6)}  (${f2(avg(g.filter((x) => x.t < cut).map((x) => x.r)))} / ${f2(avg(g.filter((x) => x.t >= cut).map((x) => x.r)))})`);
      }
    }
  }
  const models = [...new Set(B.map((x) => x.model))];
  out.push('', '  By model (n, avg R; "B" with / against / none; at the level / away / broken; opposite level in the way / clear):');
  for (const m of models) {
    const xs = B.filter((x) => x.model === m), cell = (fam: keyof SrbContext, b: string) => { const g = xs.filter((x) => x.ctx[fam] === b); return `${f2(avg(g.map((x) => x.r)))} (${g.length})`; };
    out.push(`    ${bLabel(m).padEnd(46)} ${String(xs.length).padStart(5)} ${f2(modelAvg.get(m)!).padStart(6)}   ${cell('brk', 'with')} / ${cell('brk', 'against')} / ${cell('brk', 'none')};  ${cell('own', 'at the level')} / ${cell('own', 'away')} / ${cell('own', 'broken')};  ${cell('room', 'in the way')} / ${cell('room', 'clear')}`);
  }

  out.push('', 'C. CHART CHECK (compare with the script on TradingView, default settings, Bitunix perp; TradingView draws each level 16 bars to the left)', ...chart);

  if (dump) {
    const r4 = (x: number) => +x.toFixed(4);
    for (const [key, xs] of A) {
      const diffs = xs.filter((x) => x.rtime.length).map((x) => x.r - avg(x.rtime)), old = xs.filter((x) => x.t < cut), neu = xs.filter((x) => x.t >= cut);
      const sum = (a: ReadonlyArray<number>) => r4(a.reduce((p, q) => p + q, 0));
      out.push(`SUM ${JSON.stringify({ k: `A|${key}`, n: xs.length, w: xs.filter((x) => x.r > 0).length, r: sum(xs.map((x) => x.r)), rd: sum(xs.map((x) => avg(x.rand))), m: diffs.length, d1: sum(diffs), d2: sum(diffs.map((x) => x * x)), no: old.length, ro: sum(old.map((x) => x.r)), nn: neu.length, rn: sum(neu.map((x) => x.r)), p: sum(xs.map((x) => x.stopPct)), b: sum(xs.map((x) => x.bars)) })}`);
    }
    for (const m of models) for (const [fam, , buckets] of FAMILIES) for (const b of buckets) {
      const g = B.filter((x) => x.model === m && x.ctx[fam] === b);
      if (!g.length) continue;
      const old = g.filter((x) => x.t < cut), neu = g.filter((x) => x.t >= cut), sum = (a: ReadonlyArray<BRow>) => r4(a.reduce((p, x) => p + x.r, 0));
      out.push(`SUM ${JSON.stringify({ k: `B|${m}|${fam}|${b}`, n: g.length, w: g.filter((x) => x.r > 0).length, r: sum(g), no: old.length, ro: sum(old), nn: neu.length, rn: sum(neu) })}`);
    }
  }
  return out;
}

