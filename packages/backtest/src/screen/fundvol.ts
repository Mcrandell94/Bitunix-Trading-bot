// Owner 2026-10-10: "I want to consider a model total separate of the others again. Using extreme funding and volume,
// could we experiment with this?" A standalone model: nothing from the RSI models. Funding by itself failed before (the
// funding contrarian signal in the 2026-09-27 screen, the funding carry test of 2026-10-05), so the new part is the
// volume spike. Rules fixed before the runs:
// - Signal: a closed 4H or daily bar with volume >= 3x the mean of the 20 bars before it, while funding is extreme: the
//   settlements of the 24 hours to the bar's close, as a per-8h rate (their sum / 3), >= +0.05% (longs crowded; the
//   usual rate is +0.01%) or <= -0.05% (shorts crowded). Settled rates only, so a signal is known at the close.
// - The bar either moves against the crowd (an up bar while shorts are crowded, a down bar while longs are: a squeeze)
//   or with it (a blow-off). Each is traded both ways: with the bar and against it.
// - Entry at the next bar's open; stop 2 ATR(14) of the signal frame; exits a 2R target, or a 5R target with the stop to
//   breakeven at +2R; no time limit; one trade per coin and line at a time. Costs 0.22% a round trip. The funding paid
//   or received while a trade is open (the coin's settlements) is shown apart and added in "with funding".
// - Baselines, 20 seeds a trade: the same entry in a random direction; the same side at a random bar in the 60 days
//   after the entry with the same stop % and exit (timing edge, t).
// - Dose check: funding beyond 0.10%, or volume >= 5x. A real effect should not fade as the extremes get stronger.
// Read, fixed before the runs: a line works if avg R with funding > 0, the random-direction edge > 0 and the timing edge
// > 0 on research and fresh coins alike, with >= 30 trades on each; confirmed if the timing edge has t >= 2 on both.
// Nothing goes live from this test.
// Second run (owner, the same day: "feel free to access CVD and O/I if data there can give an edge to this separate
// strategy"), rules fixed before it: the same signal and trades with Binance funding (binancevision.ts; history from
// 2019-2020 instead of March 2024, coins listed on Binance USDT-M only), and each main line split by two Binance
// readings at the signal bar:
// - taker flow (CVD): (taker buys - taker sells) / volume of the signal bar, signed the bar's way: with the bar >= +5%,
//   against it <= -5%, else mixed;
// - open interest (base units) over the 24 hours to the bar's close: rising >= +10%, falling <= -10%, else flat.
// A split adds an edge only if it passes the same read as a whole line, on research and fresh coins.
// Third round (owner 2026-10-10, after the examples: "Could we test skip first entry variant? Also 1hr and 15m variants
// or confluence"), rules fixed before the runs, on the best line (squeeze bar traded back the crowd's way, 2R target),
// Bitunix funding, research and fresh $0.5M+ coins (fundVolLtfReport):
// - skip the first entry: a signal is taken only if the coin had a signal of the same line and side in the 12 bars
//   before it (the squeeze is still running; its first fade is skipped);
// - after a stop: a signal is taken only if the line's previous trade on that coin hit its stop in the 12 bars before;
// - the same model on 1H and 15m bars (the volume mean, ATR and 12-bar window on that frame; the funding rule as is);
// - confluence: the 4H signal entered only after the first 1H (or 15m) bar in the next 4 hours that closes the crowd's
//   way; entry at that frame's next open, stop 2 ATR(4H) from it, 2R target; no such bar, no trade.
// Read as before (a line works if avg R with funding > 0 and both edges > 0 on research and fresh coins, >= 30 trades).
// Fourth round (owner 2026-10-10, before the display-only signal is deployed: "Could we also look at what we consider
// ideal for squeeze requirements? I.E. 4h candle volume, 3x size, funding 5x normal ... could we play with these before
// committing to anything"), rules fixed before the runs, on the live line (4H signal, 1H confirmation, stop 2 ATR(4H),
// 2R target, longs and shorts, Bitunix funding), research and fresh $0.5M+ coins (fvGridReport):
// - Grid: the squeeze candle's volume at least 2, 3, 4, 5 or 7x its 20-candle mean, crossed with the 24h funding (per
//   8h) beyond 0.03%, 0.05%, 0.075%, 0.10% or 0.15% (3x to 15x the usual 0.01%): 25 cells. Now: 3x and 0.05%.
// - Candle size, at 3x / 0.05%: the squeeze candle's body at least 0.5, 1 or 2 ATR(14), against no floor.
// - Per cell: trades (and a month), win %, avg R, with funding, random-direction edge, timing edge (t), max drawdown (R,
//   with funding, trades in entry order), longs / shorts with funding.
// - Read: the setting stays 3x / 0.05% unless another cell (a) passes on both coin sets (avg R with funding > 0, both
//   edges > 0, >= 30 trades each), (b) beats 3x / 0.05% on avg R with funding on both sets, and (c) has at least two
//   grid neighbours (one step in volume or in funding) that also beat 3x / 0.05% on both sets. If several qualify: the
//   one whose worse coin set is best. A body floor is added only on the same terms against no floor (its neighbours:
//   the next floor up or down; one is enough).
// Fifth round (owner 2026-10-10, on KAIA: "I would see the .236 and .382 between 0 as the short poi ... And the 1.272
// and 1.618 or the fvg and pocket or .786 below as take profits. Closes above 0 would invalidate short set up"; "Test
// both"), rules fixed before the runs, on the same squeeze signals (3x / 0.05%, 4H), research and fresh $0.5M+ coins,
// Bitunix funding, 1H candles for the trade (fvFibReport). Short after a squeeze up; longs mirrored:
// - 0 = the squeeze high: the highest high from the squeeze candle on, until the setup arms. The leg starts at the
//   lowest low of the squeeze candle and the 12 4H candles before it. The setup arms once price has dropped through the
//   leg's 0.382 level; from then on 0 stays fixed. The first drop's low = the lowest low since 0, until the entry.
// - Short zone, two readings: (a) first drop: 0.236-0.382 of the move from 0 down to the first drop's low; (b) whole
//   leg: 0.236-0.382 of the squeeze leg. Entry: a sell limit at the zone's 0.382 edge (the first level a bounce
//   reaches), filled when a 1H high trades to it.
// - Invalidation: a 4H close above 0, before the entry (no trade) or after it (exit at that close). 1R = 0 - entry.
// - Take profits, each tested as its own exit: 1.272 and 1.618 extensions of the first drop; the leg's golden pocket
//   (its 0.618 edge); the leg's 0.786; the squeeze candle's FVG (the gap between the candles before and after it; its
//   far edge; only once the candle after has closed, and only if it left a gap).
// - No entry within 7 days of the squeeze candle's close: no trade. One setup or trade per coin at a time. Costs 0.22%,
//   the funding paid or received while in the trade added.
// - Read: the plan beats the current line (1H confirmation, 2 ATR stop, 2R) if one reading and target has a higher avg
//   R with funding AND a higher total R with funding than the current line on both coin sets, with >= 30 trades each.
//   If none does, the Fibonacci plan does not improve the signal.

import type { Candle } from '@bot/marketdata';
import type { OiPoint, TakerBar } from '../binancevision';
import { atrWilder } from '../indicators';
import type { FundingPoint } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { STATS_HEAD } from './smcreport';
import { pick, randomDirectionTwins, randomTimeTwins, timingEdge, timingLine, type TimedRow } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>>; funding?: ReadonlyArray<FundingPoint> }>>;
const H = 3_600_000, DAY = 24 * H, SEEDS = 20, SPAN_DAYS = 60, VOL_BARS = 20, STOP_ATR = 2, HORIZONS = [1, 3, 7];
const TFS = [{ tf: '4h', label: '4H', ms: 4 * H }, { tf: '1d', label: 'Daily', ms: DAY }] as const;
/** The main levels first, then the dose check. */
const LEVELS = [{ rate: 0.0005, vol: 3 }, { rate: 0.001, vol: 3 }, { rate: 0.0005, vol: 5 }] as const;
const EXITS: ReadonlyArray<ExitSpec> = [{ name: '2R target', target: 2 }, { name: '5R target, breakeven at +2R', target: 5, be: 2 }];
type Kind = 'squeeze' | 'blow-off';
const SETUPS: ReadonlyArray<{ kind: Kind; withBar: boolean; label: string }> = [
  { kind: 'squeeze', withBar: true, label: 'squeeze bar, trade with it (against the crowd)' },
  { kind: 'squeeze', withBar: false, label: 'squeeze bar, trade against it (with the crowd)' },
  { kind: 'blow-off', withBar: false, label: 'blow-off bar, trade against it (against the crowd)' },
  { kind: 'blow-off', withBar: true, label: 'blow-off bar, trade with it (with the crowd)' },
];

/** Index of the first settlement after `t` (`fs` oldest first). */
const after = (fs: ReadonlyArray<FundingPoint>, t: number) => {
  let lo = 0, hi = fs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (fs[m]!.time <= t) lo = m + 1; else hi = m; }
  return lo;
};

/**
 * Funding over the 24 hours to `t` (settlements in (t - 24h, t]) as a per-8h rate: their sum / 3, whatever the coin's
 * interval. Null when the history does not cover the whole window. `fs` oldest first. Pure.
 */
export function funding8h(fs: ReadonlyArray<FundingPoint>, t: number): number | null {
  const end = after(fs, t);
  let s = 0, k = end - 1;
  for (; k >= 0 && fs[k]!.time > t - DAY; k--) s += fs[k]!.rate;
  return k >= 0 && k < end - 1 ? s / 3 : null;
}

/** Volume of bar `i` over the mean of the `n` bars before it. Null without the history or a volume. Pure. */
export function relVolume(c: ReadonlyArray<Candle>, i: number, n = VOL_BARS): number | null {
  if (i < n) return null;
  let s = 0;
  for (let k = i - n; k < i; k++) { const v = c[k]!.volume; if (v == null) return null; s += v; }
  const v = c[i]!.volume;
  return v == null || !(s > 0) ? null : (v * n) / s;
}

/** A signal bar: crowd = the side funding says is crowded (1 longs, -1 shorts), bar = its direction. */
export interface FvEvent { i: number; crowd: 1 | -1; bar: 1 | -1; rate8: number; rvol: number }

/** Bars with volume >= `minVol` x their 20-bar mean while the 24h funding (per 8h) is at or beyond +/- `minRate`. Pure. */
export function fvEvents(c: ReadonlyArray<Candle>, fs: ReadonlyArray<FundingPoint>, barMs: number, minRate: number, minVol: number): FvEvent[] {
  const out: FvEvent[] = [];
  for (let i = VOL_BARS; i < c.length; i++) {
    const b = c[i]!;
    if (b.close === b.open) continue;
    const rvol = relVolume(c, i);
    if (rvol == null || rvol < minVol) continue;
    const rate8 = funding8h(fs, b.openTime + barMs);
    if (rate8 == null || Math.abs(rate8) < minRate - 1e-12) continue;
    out.push({ i, crowd: rate8 > 0 ? 1 : -1, bar: b.close > b.open ? 1 : -1, rate8, rvol });
  }
  return out;
}

/** Funding received (+) or paid (-) in R by side `d` for the settlements in [from, to). Pure. */
export function fundingR(fs: ReadonlyArray<FundingPoint>, d: 1 | -1, from: number, to: number, entry: number, risk: number): number {
  let s = 0;
  for (let k = after(fs, from - 1); k < fs.length && fs[k]!.time < to; k++) s += -d * fs[k]!.rate;
  return (s * entry) / risk;
}

/** The move from bar j's open to the close `n` bars on, % of price in direction `d`; null past the data. Pure. */
export const moveAt = (c: ReadonlyArray<Candle>, j: number, n: number, d: 1 | -1): number | null =>
  j + n - 1 < c.length ? 100 * d * (c[j + n - 1]!.close / c[j]!.open - 1) : null;

/** The same move from random bars in (j, j + span], one per seed. */
function moveTwins(c: ReadonlyArray<Candle>, sym: string, j: number, n: number, d: 1 | -1, span: number): number[] {
  const lo = j + 1, hi = Math.min(c.length - n, j + span), out: number[] = [];
  for (let k = 1; k <= SEEDS && hi >= lo; k++) { const m = moveAt(c, lo + pick(k, sym, j, hi - lo + 1), n, d); if (m != null) out.push(m); }
  return out;
}

/** The last open interest reading at or before `t`, within 30 minutes. Pure. */
export function oiAt(oi: ReadonlyArray<OiPoint>, t: number): number | null {
  let lo = 0, hi = oi.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (oi[m]!.t <= t) lo = m + 1; else hi = m; }
  const p = oi[lo - 1];
  return p && t - p.t <= 30 * 60_000 ? p.oi : null;
}

/** % change of open interest over the 24 hours to `t`. Pure. */
export function oiChange(oi: ReadonlyArray<OiPoint>, t: number): number | null {
  const a = oiAt(oi, t - DAY), b = oiAt(oi, t);
  return a != null && b != null ? 100 * (b / a - 1) : null;
}

/** Net taker flow of a bar: (buys - sells) / volume, in [-1, 1]. Pure. */
export const takerFlow = (b: TakerBar) => (2 * b.buy - b.vol) / b.vol;

/** Binance readings per coin: 5-minute open interest and the taker volume of signal bars. */
export type Flow = Readonly<Record<string, { oi: ReadonlyArray<OiPoint>; taker: Partial<Record<string, ReadonlyMap<number, TakerBar>>> }>>;

/** Open times of the main-level signal bars per coin and frame (what the Binance readings are fetched for). */
export function fvSignalTimes(data: Data, symbols: ReadonlyArray<string>, from: number): Record<string, Record<string, number[]>> {
  const out: Record<string, Record<string, number[]>> = {};
  for (const sym of symbols) {
    const fs = data[sym]?.funding ?? [];
    if (fs.length < 10) continue;
    for (const { tf, ms } of TFS) {
      const c = data[sym]?.candles[tf] ?? [];
      const ts = fvEvents(c, fs, ms, LEVELS[0].rate, LEVELS[0].vol).map((e) => c[e.i]!.openTime).filter((t) => t + ms >= from);
      if (ts.length) (out[sym] ??= {})[tf] = ts;
    }
  }
  return out;
}

const FLOW_SPLIT = 0.05, OI_SPLIT = 10;
const FLOW_GROUPS = ['flow with the bar', 'mixed flow', 'flow against the bar'] as const;
const OI_GROUPS = ['open interest rising', 'open interest flat', 'open interest falling'] as const;
const flowGroup = (x: number | null) => (x == null ? null : x >= FLOW_SPLIT ? FLOW_GROUPS[0] : x <= -FLOW_SPLIT ? FLOW_GROUPS[2] : FLOW_GROUPS[1]);
const oiGroup = (x: number | null) => (x == null ? null : x >= OI_SPLIT ? OI_GROUPS[0] : x <= -OI_SPLIT ? OI_GROUPS[2] : OI_GROUPS[1]);

/** One trade of the main level, as an example: the signal bar and the trade (bars: OHLC around it, the best line only). */
interface Example { at: number; rate8: number; rvol: number; move: number; entry: number; stop: number; target: number | null; how: string; exitAt: number; bars?: number[][] }
type Row = TimedRow & { fund: number; d: 1 | -1; tflow: number | null; doi: number | null; ex?: Example };
/** The best line in the 2026-10-10 runs: 4H, squeeze bar traded against it (the crowd's way), 2R target. */
const BEST = { tf: '4h', setup: 1, exit: 0, shown: 12, charts: 3 } as const;
const avg = (xs: ReadonlyArray<number>) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sg = (x: number, n = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(n)}` : '-');

/**
 * The report for one coin set (`symbols` without reference-only coins). `flow`: Binance taker flow and open interest
 * for the splits of the second run; `source` names where the funding came from.
 */
export function fundVolReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, flow?: Flow, source = 'Bitunix'): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const rows = new Map<string, Row[]>(); // tf|level|setup|exit
  const moves = new Map<string, { real: number[][]; rnd: number[][] }>(); // tf|setup, per horizon
  const evCount = new Map<string, { n: number; longs: number; squeeze: number; tflow: number; doi: number }>(); // tf|level
  const share = new Map<string, { bars: number; p5: number; n5: number; p10: number; n10: number }>(); // tf
  const firsts: number[] = [];
  for (const sym of symbols) {
    const fs = data[sym]?.funding ?? [];
    if (fs.length < 10) continue;
    firsts.push(fs[0]!.time);
    for (const { tf, ms } of TFS) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 100) continue;
      const atr = atrWilder(c, 14), span = Math.round((SPAN_DAYS * DAY) / ms);
      const sh = share.get(tf) ?? { bars: 0, p5: 0, n5: 0, p10: 0, n10: 0 };
      for (const b of c) {
        if (b.openTime < from || b.openTime >= to) continue;
        const f = funding8h(fs, b.openTime + ms);
        if (f == null) continue;
        sh.bars++;
        if (f >= 0.0005) sh.p5++;
        if (f <= -0.0005) sh.n5++;
        if (f >= 0.001) sh.p10++;
        if (f <= -0.001) sh.n10++;
      }
      share.set(tf, sh);
      const fl = flow?.[sym], taker = fl?.taker[tf];
      /** The Binance readings of a signal bar: taker flow signed the bar's way, and the 24h open interest change. */
      const readings = (e: FvEvent) => {
        const tb = taker?.get(c[e.i]!.openTime);
        return { tflow: tb ? e.bar * takerFlow(tb) : null, doi: fl ? oiChange(fl.oi, c[e.i]!.openTime + ms) : null };
      };
      LEVELS.forEach((lv, li) => {
        const evs = fvEvents(c, fs, ms, lv.rate, lv.vol).filter((e) => e.i + 1 < c.length);
        const inWin = evs.filter((e) => c[e.i + 1]!.openTime >= from);
        const ec = evCount.get(`${tf}|${li}`) ?? { n: 0, longs: 0, squeeze: 0, tflow: 0, doi: 0 };
        ec.n += inWin.length; ec.longs += inWin.filter((e) => e.crowd > 0).length; ec.squeeze += inWin.filter((e) => e.bar === -e.crowd).length;
        if (flow) for (const e of inWin) { const r = readings(e); if (r.tflow != null) ec.tflow++; if (r.doi != null) ec.doi++; }
        evCount.set(`${tf}|${li}`, ec);
        SETUPS.forEach((st, si) => EXITS.forEach((ex, xi) => {
          let busy = -Infinity;
          for (const e of evs) {
            if ((e.bar === -e.crowd ? 'squeeze' : 'blow-off') !== st.kind) continue;
            const j = e.i + 1, a = atr[e.i];
            if (a == null || !(a > 0) || c[j]!.openTime < busy) continue;
            const d = (st.withBar ? e.bar : -e.bar) as 1 | -1, entry = c[j]!.open, stop = entry - d * STOP_ATR * a;
            const t = specTrade(c, atr, {}, j, stop, d, ex);
            if (!t) continue;
            busy = t.open ? Infinity : c[t.end]!.openTime + ms;
            if (c[j]!.openTime < from) continue;
            const key = `${tf}|${li}|${si}|${xi}`, list = rows.get(key) ?? [];
            list.push({
              sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: (c[t.end]!.openTime - c[j]!.openTime) / DAY, d,
              rand: randomDirectionTwins(c, atr, sym, j, stop, d, ex, SEEDS),
              rtime: randomTimeTwins(c, atr, sym, j, stop, d, ex, span, SEEDS),
              fund: fundingR(fs, d, c[j]!.openTime, c[t.end]!.openTime, entry, STOP_ATR * a),
              ...(flow ? readings(e) : { tflow: null, doi: null }),
              ...(li === 0 ? { ex: {
                at: c[e.i]!.openTime + ms, rate8: e.rate8, rvol: e.rvol, move: 100 * (c[e.i]!.close / c[e.i]!.open - 1),
                entry, stop, target: t.target, how: t.how, exitAt: c[t.end]!.openTime,
                ...(tf === BEST.tf && si === BEST.setup && xi === BEST.exit
                  ? { bars: c.slice(Math.max(0, e.i - 24), Math.min(c.length, t.end + 7)).map((b) => [b.openTime, b.open, b.high, b.low, b.close]) } : {}),
              } } : {}),
            });
            rows.set(key, list);
            if (li !== 0 || xi !== 0) continue;
            const mv = moves.get(`${tf}|${si}`) ?? { real: HORIZONS.map(() => []), rnd: HORIZONS.map(() => []) };
            HORIZONS.forEach((h, hi) => {
              const n = Math.round((h * DAY) / ms), m = moveAt(c, j, n, d);
              if (m == null) return;
              mv.real[hi]!.push(m);
              mv.rnd[hi]!.push(avg(moveTwins(c, sym, j, n, d, span)));
            });
            moves.set(`${tf}|${si}`, mv);
          }
        }));
      });
    }
  }
  const sorted = [...firsts].sort((a, b) => a - b), years: string[] = [];
  for (let y = new Date(from).getUTCFullYear() + 1; y <= new Date(to).getUTCFullYear(); y++) years.push(`${y} ${firsts.filter((t) => t <= Date.UTC(y, 0, 1)).length}`);
  const out = [
    `FUNDING + VOLUME EXTREMES (standalone model, rules fixed before the run): ${day(from)} to ${day(to)}, ${firsts.length} of ${symbols.length} coins have ${source} funding history. Older / newer = before / after ${day(cut)}.`,
    sorted.length ? `Funding history starts: earliest ${day(sorted[0]!)}, median ${day(sorted[Math.floor(sorted.length / 2)]!)}, latest ${day(sorted[sorted.length - 1]!)}; coins with funding by 1 January: ${years.join(', ')}.` : 'No funding history.',
    'Signal: a bar with volume >= 3x its 20-bar mean while the 24h funding (per 8h) is >= +0.05% (longs crowded) or <= -0.05% (shorts crowded). Squeeze bar = it moves against the crowd; blow-off bar = it moves with it.',
    'Entry at the next open, stop 2 ATR(14), no time limit, one trade per coin and line at a time, costs 0.22%. R is the price move; funding = funding received (+) or paid (-) while open, in R; with funding = both; bars = days held.',
    'Random = the same entry in a random direction; random time = the same side at a random bar in the next 60 days, same stop % and exit; timing edge = R minus its random-time twins (20 seeds each).',
  ];
  for (const { tf, label } of TFS) {
    const sh = share.get(tf), pct = (n: number) => (sh?.bars ? ((100 * n) / sh.bars).toFixed(1) : '-');
    out.push('', `${label} bars: 24h funding >= +0.05% on ${pct(sh?.p5 ?? 0)}% of bars, <= -0.05% on ${pct(sh?.n5 ?? 0)}% (>= +0.10% ${pct(sh?.p10 ?? 0)}%, <= -0.10% ${pct(sh?.n10 ?? 0)}%), of ${sh?.bars ?? 0} bars with funding.`);
    LEVELS.forEach((lv, li) => {
      const ec = evCount.get(`${tf}|${li}`) ?? { n: 0, longs: 0, squeeze: 0, tflow: 0, doi: 0 };
      out.push(`  signal bars at volume >= ${lv.vol}x and funding beyond ${(lv.rate * 100).toFixed(2)}%: ${ec.n} (longs crowded ${ec.longs}, shorts crowded ${ec.n - ec.longs}; squeeze bars ${ec.squeeze}, blow-off bars ${ec.n - ec.squeeze})${flow ? `; Binance taker flow for ${ec.tflow}, open interest for ${ec.doi}` : ''}`);
    });
    out.push(`  moves after the signal, % of price the trade's way, mean at ${HORIZONS.join(' / ')} days (the 2R line's trades), against the same side at random times:`);
    SETUPS.forEach((st, si) => {
      const mv = moves.get(`${tf}|${si}`);
      if (!mv) { out.push(`    ${st.label}: no trades`); return; }
      out.push(`    ${st.label.padEnd(56)} ${mv.real.map((x) => sg(avg(x))).join(' / ')}   random time ${mv.rnd.map((x) => sg(avg(x.filter(Number.isFinite)))).join(' / ')}   (${mv.real[0]!.length} trades)`);
    });
    out.push(STATS_HEAD);
    const line = (name: string, xs: ReadonlyArray<Row>) =>
      xs.length ? `${timingLine(name.padEnd(84), xs, cut)}; funding ${sg(avg(xs.map((x) => x.fund)))}, with funding ${sg(avg(xs.map((x) => x.r + x.fund)))}` : `  ${name}: no trades`;
    SETUPS.forEach((st, si) => EXITS.forEach((ex, xi) => {
      const xs = rows.get(`${tf}|0|${si}|${xi}`) ?? [];
      out.push(line(`${st.label}, ${ex.name}`, xs), line('  longs', xs.filter((x) => x.d > 0)), line('  shorts', xs.filter((x) => x.d < 0)));
    }));
    if (flow) {
      const split = (title: string, groups: ReadonlyArray<string>, of: (x: Row) => string | null) => {
        out.push(title);
        SETUPS.forEach((st, si) => EXITS.forEach((ex, xi) => {
          const xs = rows.get(`${tf}|0|${si}|${xi}`) ?? [];
          out.push(`    ${st.label}, ${ex.name}`);
          for (const g of groups) out.push(line(`    ${g}`, xs.filter((x) => of(x) === g)));
          out.push(`      no Binance reading: ${xs.filter((x) => of(x) == null).length} trades`);
        }));
      };
      split(`  by taker flow (CVD) on the signal bar (Binance; with the bar >= +${FLOW_SPLIT * 100}% of its volume, against <= -${FLOW_SPLIT * 100}%):`, FLOW_GROUPS, (x) => flowGroup(x.tflow));
      split(`  by open interest over the 24 hours to the signal (Binance, base units; rising >= +${OI_SPLIT}%, falling <= -${OI_SPLIT}%):`, OI_GROUPS, (x) => oiGroup(x.doi));
    }
    if (tf === BEST.tf) {
      const best = [...(rows.get(`${tf}|0|${BEST.setup}|${BEST.exit}`) ?? [])].sort((a, b) => b.t - a.t);
      const p = (x: number) => x.toPrecision(5), time = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
      out.push(`  examples: the latest ${BEST.shown} trades of "${SETUPS[BEST.setup]!.label}, ${EXITS[BEST.exit]!.name}" (signal = the squeeze bar's close, UTC):`);
      for (const x of best.slice(0, BEST.shown)) {
        const e = x.ex!, crowd = e.rate8 > 0 ? 'longs crowded' : 'shorts crowded';
        out.push(`    ${x.sym.padEnd(16)} ${time(e.at)}  ${crowd} ${sg(e.rate8 * 100, 3)}%/8h, bar ${sg(e.move, 1)}% on ${e.rvol.toFixed(1)}x volume -> ${x.d > 0 ? 'LONG ' : 'SHORT'} at ${p(e.entry)}, stop ${p(e.stop)} (${x.stopPct.toFixed(1)}%), target ${e.target != null ? p(e.target) : '-'}: ${e.how === 'open' ? 'still open' : e.how} ${sg(x.r)}R after ${x.bars.toFixed(1)} days, funding ${sg(x.fund)}R`);
      }
      for (const x of best.slice(0, BEST.charts)) out.push(`  CHART ${JSON.stringify({ sym: x.sym, side: x.d, at: x.ex!.at, entryAt: x.t, exitAt: x.ex!.exitAt, entry: x.ex!.entry, stop: x.ex!.stop, target: x.ex!.target, how: x.ex!.how, r: x.r, rate8: x.ex!.rate8, rvol: x.ex!.rvol, bars: x.ex!.bars })}`);
    }
    out.push(`  dose check (both sides):`);
    LEVELS.forEach((lv, li) => {
      if (li === 0) return;
      SETUPS.forEach((st, si) => EXITS.forEach((ex, xi) => out.push(line(`funding ${(lv.rate * 100).toFixed(2)}%, volume ${lv.vol}x: ${st.label.replace(/ \(.*\)$/, '')}, ${ex.name}`, rows.get(`${tf}|${li}|${si}|${xi}`) ?? []))));
    });
  }
  return out;
}

const LTF = [{ tf: '4h', label: '4H', ms: 4 * H }, { tf: '1h', label: '1H', ms: H }, { tf: '15m', label: '15m', ms: 15 * 60_000 }] as const;
const CLUSTER_BARS = 12;
const VARIANTS = ['all signals', 'skip the first entry', 'after a stop'] as const;

/**
 * The confluence line of one coin: each 4H squeeze signal (the best line) entered at the next open after the first `l`
 * bar (1H or 15m, `ms` long) in the next 4 hours that closes the crowd's way; stop 2 ATR(4H) from that entry, 2R target,
 * one trade at a time. `i` = the 4H signal bar, `j` = the entry bar on `l`, `risk` = the stop distance. Trades entered
 * before `from` are not returned (they still block the next one). `req` = other squeeze requirements (the fourth
 * round's grid): funding rate and volume multiple (default 0.05% and 3x), and a floor on the squeeze candle's body in
 * ATR(14) of the 4H (default none).
 */
export function fvConfluenceTrades(c4: ReadonlyArray<Candle>, l: ReadonlyArray<Candle>, fs: ReadonlyArray<FundingPoint>, ms: number, from: number, req: { rate?: number; vol?: number; minBody?: number } = {}) {
  const ex = EXITS[BEST.exit]!, atr4 = atrWilder(c4, 14), latr = atrWilder(l, 14), n = Math.round((4 * H) / ms), minBody = req.minBody ?? 0;
  const sq4 = fvEvents(c4, fs, 4 * H, req.rate ?? LEVELS[0].rate, req.vol ?? LEVELS[0].vol)
    .filter((e) => e.bar === -e.crowd && e.i + 1 < c4.length && (minBody <= 0 || Math.abs(c4[e.i]!.close - c4[e.i]!.open) >= minBody * (atr4[e.i] ?? Infinity)));
  const trades: { i: number; j: number; d: 1 | -1; stop: number; risk: number; t: NonNullable<ReturnType<typeof specTrade>> }[] = [];
  let busy = -Infinity, k0 = 0;
  for (const e of sq4) {
    const a = atr4[e.i], close = c4[e.i]!.openTime + 4 * H, d = (-e.bar) as 1 | -1;
    if (a == null || !(a > 0) || close < busy) continue;
    while (k0 < l.length && l[k0]!.openTime < close) k0++;
    let k = -1;
    for (let q = k0; q < Math.min(l.length - 1, k0 + n); q++) if (d * (l[q]!.close - l[q]!.open) > 0) { k = q; break; }
    if (k < 0) continue;
    const j = k + 1, entry = l[j]!.open, stop = entry - d * STOP_ATR * a, t = specTrade(l, latr, {}, j, stop, d, ex);
    if (!t) continue;
    busy = t.open ? Infinity : l[t.end]!.openTime + ms;
    if (l[j]!.openTime >= from) trades.push({ i: e.i, j, d, stop, risk: STOP_ATR * a, t });
  }
  return { trades, latr };
}

/**
 * The live signal (owner 2026-10-10: "let's just use the most productive model"): the confluence line above, 4H signal
 * and 1H confirmation, longs and shorts. Display only: shown on the dashboard and posted to Telegram, never traded.
 */
export const FV_LIVE = {
  model: 'fv-squeeze', label: '4H funding squeeze', rate: LEVELS[0].rate, vol: LEVELS[0].vol, stopAtr: STOP_ATR, exit: EXITS[BEST.exit]!,
  /** 1H candles after the squeeze candle that may confirm it (the 4 hours of the next 4H candle). */
  confirmBars: 4,
  /** A 4H candle is judged only once funding was read this long after its close (its last settlement published). */
  settleMs: 10 * 60_000,
} as const;

export interface FvSignalRow {
  symbol: string;
  side: 'long' | 'short';
  /** The squeeze candle's close (when the signal was known). */
  signalAt: number;
  /** waiting = squeeze seen, no 1H confirmation yet; enter = confirmed, enter at the next 1H open; open / closed = the trade. */
  status: 'waiting' | 'enter' | 'open' | 'closed';
  /** waiting: the close of the last 1H candle that can still confirm. */
  until: number | null;
  /** The close of the 1H candle that confirmed. */
  confirmedAt: number | null;
  /** Entry price ('enter': the confirming candle's close, an estimate of the next open). */
  entry: number | null;
  enteredAt: number | null;
  stop: number | null;
  target: number | null;
  lastPrice: number;
  /** The trade's R at the last close (open) or its result (closed), costs in, funding apart. */
  r: number | null;
  exit: 'stop' | 'target' | null;
  closedAt: number | null;
  stopPct: number | null;
  /** The crowded side, its funding over the 24h to the signal (per 8h, a fraction; + = longs pay), the squeeze candle's move (a fraction) and volume multiple. */
  crowd: 'long' | 'short';
  rate8: number;
  move: number;
  rvol: number;
  /** Funding received (+) or paid (-) in the trade so far, in R (from the settlements known). */
  fundingR: number | null;
}

/**
 * Live rows of one coin from closed 4H / 1H candles and its funding settlements (oldest first), read up to `fundingTo`;
 * `now` = the last close. The same trades as fvConfluenceTrades: a 4H squeeze candle, the first of the next 4 1H candles
 * closing the crowd's way, entry at the next 1H open, stop 2 ATR(4H), 2R target, one trade at a time. Rows: waiting,
 * enter, open, and trades closed in the last `keepDays` days. Pure.
 */
export function fvLiveSignals(symbol: string, c4: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, fs: ReadonlyArray<FundingPoint>, now: number, keepDays = 14, fundingTo = Infinity): FvSignalRow[] {
  const ex = FV_LIVE.exit, atr4 = atrWilder(c4, 14), latr = atrWilder(h1, 14), n = FV_LIVE.confirmBars, last = h1[h1.length - 1];
  const sq = fvEvents(c4, fs, 4 * H, FV_LIVE.rate, FV_LIVE.vol).filter((e) => e.bar === -e.crowd && c4[e.i]!.openTime + 4 * H <= fundingTo - FV_LIVE.settleMs);
  const rows: FvSignalRow[] = [];
  let busy = -Infinity, k0 = 0;
  for (const e of sq) {
    const b = c4[e.i]!, a = atr4[e.i], close = b.openTime + 4 * H, d = (-e.bar) as 1 | -1;
    if (a == null || !(a > 0) || close < busy) continue;
    while (k0 < h1.length && h1[k0]!.openTime < close) k0++;
    let k = -1;
    for (let q = k0; q < Math.min(h1.length, k0 + n); q++) if (d * (h1[q]!.close - h1[q]!.open) > 0) { k = q; break; }
    const risk = FV_LIVE.stopAtr * a;
    const base = {
      symbol, side: (d > 0 ? 'long' : 'short') as 'long' | 'short', signalAt: close, lastPrice: last?.close ?? b.close,
      crowd: (e.crowd > 0 ? 'long' : 'short') as 'long' | 'short', rate8: e.rate8, move: (b.close - b.open) / b.open, rvol: e.rvol,
    };
    const none = { until: null, confirmedAt: null, entry: null, enteredAt: null, stop: null, target: null, r: null, exit: null, closedAt: null, stopPct: null, fundingR: null };
    if (k < 0) { // no confirmation yet: waiting while some of the 4 candles are still to close, else no trade
      if (k0 + n > h1.length && close + n * H > now) { rows.push({ ...base, ...none, status: 'waiting', until: close + n * H }); busy = Infinity; }
      continue;
    }
    const j = k + 1, confirmedAt = h1[k]!.openTime + H;
    if (j >= h1.length) { // confirmed by the last closed candle: enter at the next 1H open
      const entry = h1[k]!.close;
      rows.push({ ...base, ...none, status: 'enter', confirmedAt, entry, stop: entry - d * risk, target: entry + d * ex.target! * risk, stopPct: Number(((100 * risk) / entry).toFixed(1)) });
      busy = Infinity;
      continue;
    }
    const entry = h1[j]!.open, t = specTrade(h1, latr, {}, j, entry - d * risk, d, ex);
    if (!t) continue;
    const closedAt = t.open ? null : h1[t.end]!.openTime + H;
    busy = closedAt ?? Infinity;
    if (closedAt != null && closedAt < now - keepDays * DAY) continue;
    rows.push({
      ...base, status: t.open ? 'open' : 'closed', until: null, confirmedAt, entry, enteredAt: h1[j]!.openTime, stop: t.stop, target: t.target,
      r: Number(t.r.toFixed(2)), exit: t.open ? null : t.how === 'target' ? 'target' : 'stop', closedAt, stopPct: Number(t.stopPct.toFixed(1)),
      fundingR: Number(fundingR(fs, d, h1[j]!.openTime, t.open ? now : h1[t.end]!.openTime, entry, risk).toFixed(2)),
    });
  }
  return rows;
}

/**
 * Third round: the best line on 4H, 1H and 15m with the skip-first and after-a-stop variants, its opposite as a control,
 * and the 4H signal entered on a 1H or 15m bar closing the crowd's way (header). `symbols` without reference coins.
 */
export function fundVolLtfReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, dump = false): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const ex = EXITS[0]!, best = SETUPS[1]!, control = SETUPS[0]!;
  const rows = new Map<string, Row[]>(); // frame|line
  const push = (key: string, r: Row) => { const l = rows.get(key) ?? []; l.push(r); rows.set(key, l); };
  const signals = new Map<string, number>();
  let coins = 0;
  for (const sym of symbols) {
    const fs = data[sym]?.funding ?? [];
    if (fs.length < 10) continue;
    coins++;
    for (const { tf, ms } of LTF) {
      const c = data[sym]?.candles[tf] ?? [];
      if (c.length < 100) continue;
      const atr = atrWilder(c, 14), span = Math.round((SPAN_DAYS * DAY) / ms);
      const evs = fvEvents(c, fs, ms, LEVELS[0].rate, LEVELS[0].vol).filter((e) => e.i + 1 < c.length);
      signals.set(tf, (signals.get(tf) ?? 0) + evs.filter((e) => c[e.i + 1]!.openTime >= from).length);
      /** One trade of a setup at event e, or null (no ATR); the row is recorded only inside the window. */
      const trade = (e: FvEvent, withBar: boolean) => {
        const j = e.i + 1, a = atr[e.i];
        if (a == null || !(a > 0)) return null;
        const d = (withBar ? e.bar : -e.bar) as 1 | -1, entry = c[j]!.open, stop = entry - d * STOP_ATR * a;
        const t = specTrade(c, atr, {}, j, stop, d, ex);
        if (!t) return null;
        const row: Row = {
          sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: (c[t.end]!.openTime - c[j]!.openTime) / DAY, d, tflow: null, doi: null,
          rand: randomDirectionTwins(c, atr, sym, j, stop, d, ex, SEEDS), rtime: randomTimeTwins(c, atr, sym, j, stop, d, ex, span, SEEDS),
          fund: fundingR(fs, d, c[j]!.openTime, c[t.end]!.openTime, entry, STOP_ATR * a),
        };
        return { row, t, j };
      };
      const squeezes = evs.filter((e) => e.bar === -e.crowd);
      // The base line first: its stops decide 'after a stop'.
      const stoppedAt: number[] = [];
      for (const variant of VARIANTS) {
        let busy = -1;
        for (const e of squeezes) {
          if (e.i < busy) continue;
          if (variant === 'skip the first entry' && !squeezes.some((x) => x.crowd === e.crowd && x.i < e.i && x.i >= e.i - CLUSTER_BARS)) continue;
          if (variant === 'after a stop' && !stoppedAt.some((k) => k < e.i && k >= e.i - CLUSTER_BARS)) continue;
          const x = trade(e, best.withBar);
          if (!x) continue;
          busy = x.t.open ? Infinity : x.t.end;
          if (variant === 'all signals' && x.t.how === 'stop') stoppedAt.push(x.t.end);
          if (x.row.t >= from) push(`${tf}|${variant}`, x.row);
        }
      }
      let busy = -1;
      for (const e of squeezes) {
        if (e.i < busy) continue;
        const x = trade(e, control.withBar);
        if (!x) continue;
        busy = x.t.open ? Infinity : x.t.end;
        if (x.row.t >= from) push(`${tf}|control`, x.row);
      }
    }
    // Confluence: the 4H signal entered on the first 1H / 15m bar in the next 4 hours that closes the crowd's way.
    const c4 = data[sym]?.candles['4h'] ?? [];
    if (c4.length < 100) continue;
    for (const { tf, ms } of LTF.slice(1)) {
      const l = data[sym]?.candles[tf] ?? [];
      if (l.length < 100) continue;
      const span = Math.round((SPAN_DAYS * DAY) / ms), { trades, latr } = fvConfluenceTrades(c4, l, fs, ms, from);
      for (const { j, d, stop, risk, t } of trades) push(`confluence|${tf}`, {
        sym, t: l[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: (l[t.end]!.openTime - l[j]!.openTime) / DAY, d, tflow: null, doi: null,
        rand: randomDirectionTwins(l, latr, sym, j, stop, d, ex, SEEDS), rtime: randomTimeTwins(l, latr, sym, j, stop, d, ex, span, SEEDS),
        fund: fundingR(fs, d, l[j]!.openTime, l[t.end]!.openTime, l[j]!.open, risk),
      });
    }
  }
  const line = (name: string, xs: ReadonlyArray<Row>) =>
    xs.length ? `${timingLine(name.padEnd(84), xs, cut)}; funding ${sg(avg(xs.map((x) => x.fund)))}, with funding ${sg(avg(xs.map((x) => x.r + x.fund)))}` : `  ${name}: no trades`;
  const sides = (name: string, xs: ReadonlyArray<Row>) => [line(name, xs), line('  longs', xs.filter((x) => x.d > 0)), line('  shorts', xs.filter((x) => x.d < 0))];
  const out = [
    `FUNDING SQUEEZE, THIRD ROUND (rules fixed before the run): ${day(from)} to ${day(to)}, ${coins} of ${symbols.length} coins with funding. Older / newer = before / after ${day(cut)}.`,
    `Best line: a bar on >= 3x its 20-bar volume moving against a crowd (24h funding beyond +/-0.05% per 8h), traded back the crowd's way at the next open; stop 2 ATR, ${ex.name}, no time limit, costs 0.22%; one trade per coin and line at a time.`,
    `Skip the first entry = only signals with a same-side signal in the ${CLUSTER_BARS} bars before; after a stop = only when the line's previous trade on the coin hit its stop in the ${CLUSTER_BARS} bars before.`,
  ];
  for (const { tf, label } of LTF) {
    out.push('', `${label} bars: ${signals.get(tf) ?? 0} signal bars (both setups) in the window.`, STATS_HEAD);
    for (const v of VARIANTS) out.push(...sides(`${best.label}, ${v}`, rows.get(`${tf}|${v}`) ?? []));
    out.push(line(`control: ${control.label}, all signals`, rows.get(`${tf}|control`) ?? []));
  }
  out.push('', 'Confluence: the 4H signal, entered at the next open after the first lower-frame bar in the next 4 hours that closes the crowd\'s way (stop 2 ATR(4H) from that entry).', STATS_HEAD);
  for (const { tf, label } of LTF.slice(1)) out.push(...sides(`4H signal, ${label} confirmation`, rows.get(`confluence|${tf}`) ?? []));
  // dump: per line and side, the sums that slices of a coin set (--slice) need to be merged exactly (all but drawdown).
  if (dump) for (const [k, xs] of rows) for (const [g, ys] of [['all', xs], ['long', xs.filter((x) => x.d > 0)], ['short', xs.filter((x) => x.d < 0)]] as const) {
    const diffs = ys.filter((x) => x.rtime.length).map((x) => x.r - avg(x.rtime)), old = ys.filter((x) => x.t < cut), neu = ys.filter((x) => x.t >= cut);
    const sum = (a: ReadonlyArray<number>) => +a.reduce((p, q) => p + q, 0).toFixed(4);
    out.push(`SUM ${JSON.stringify({ k, g, n: ys.length, w: ys.filter((x) => x.r > 0).length, r: sum(ys.map((x) => x.r)), rf: sum(ys.map((x) => x.r + x.fund)), rd: sum(ys.map((x) => avg(x.rand))),
      m: diffs.length, d1: sum(diffs), d2: sum(diffs.map((x) => x * x)), no: old.length, ro: sum(old.map((x) => x.r)), nn: neu.length, rn: sum(neu.map((x) => x.r)), p: sum(ys.map((x) => x.stopPct)), b: sum(ys.map((x) => x.bars)) })}`);
  }
  return out;
}

/** The fourth round's grid (header): volume multiples x funding rates, and body floors at 3x / 0.05%. */
export const FV_GRID = { vols: [2, 3, 4, 5, 7], rates: [0.0003, 0.0005, 0.00075, 0.001, 0.0015], bodies: [0, 0.5, 1, 2] } as const;

/**
 * Fourth round (header): the live line under other squeeze requirements. Prints a table per measure and one
 * `CELL {json}` line per cell (for reading the research and fresh runs side by side). `symbols` without reference coins.
 */
export function fvGridReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number, dump = false): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const ex = EXITS[BEST.exit]!, span = Math.round((SPAN_DAYS * DAY) / H);
  type GridRow = TimedRow & { fund: number; d: 1 | -1 };
  const cells: { vol: number; rate: number; body: number }[] = [
    ...FV_GRID.vols.flatMap((vol) => FV_GRID.rates.map((rate) => ({ vol, rate, body: 0 }))),
    ...FV_GRID.bodies.slice(1).map((body) => ({ vol: 3, rate: 0.0005, body })),
  ];
  const key = (c: { vol: number; rate: number; body: number }) => `${c.vol}|${c.rate}|${c.body}`;
  const rows = new Map<string, GridRow[]>();
  let coins = 0, start = Infinity;
  for (const sym of symbols) {
    const fs = data[sym]?.funding ?? [], c4 = data[sym]?.candles['4h'] ?? [], h1 = data[sym]?.candles['1h'] ?? [];
    if (fs.length < 10 || c4.length < 100 || h1.length < 100) continue;
    coins++;
    start = Math.min(start, fs[0]!.time);
    const twins = new Map<string, { rand: number[]; rtime: number[] }>(); // the same entry in several cells: the same twins
    for (const cell of cells) {
      const { trades, latr } = fvConfluenceTrades(c4, h1, fs, H, from, { rate: cell.rate, vol: cell.vol, minBody: cell.body });
      const out = rows.get(key(cell)) ?? [];
      for (const { j, d, stop, risk, t } of trades) {
        const tk = `${j}|${d}|${stop}`;
        let tw = twins.get(tk);
        if (!tw) { tw = { rand: randomDirectionTwins(h1, latr, sym, j, stop, d, ex, SEEDS), rtime: randomTimeTwins(h1, latr, sym, j, stop, d, ex, span, SEEDS) }; twins.set(tk, tw); }
        out.push({ sym, t: h1[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: (h1[t.end]!.openTime - h1[j]!.openTime) / DAY, d, ...tw, fund: fundingR(fs, d, h1[j]!.openTime, h1[t.end]!.openTime, h1[j]!.open, risk) });
      }
      rows.set(key(cell), out);
    }
  }
  const months = (to - Math.max(from, start)) / (30.44 * DAY);
  const stat = (xs: ReadonlyArray<GridRow>) => {
    const rf = xs.map((x) => x.r + x.fund), te = timingEdge(xs);
    let eq = 0, peak = 0, dd = 0;
    for (const x of [...xs].sort((a, b) => a.t - b.t)) { eq += x.r + x.fund; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const side = (d: 1 | -1) => { const ys = xs.filter((x) => x.d === d); return { n: ys.length, rf: +avg(ys.map((x) => x.r + x.fund)).toFixed(3) }; };
    return {
      n: xs.length, perMonth: +(xs.length / months).toFixed(1), win: +((100 * xs.filter((x) => x.r > 0).length) / Math.max(1, xs.length)).toFixed(0),
      r: +avg(xs.map((x) => x.r)).toFixed(3), rf: +avg(rf).toFixed(3), edge: +(avg(xs.map((x) => x.r)) - avg(xs.flatMap((x) => x.rand))).toFixed(3),
      te: +te.mean.toFixed(3), t: +te.t.toFixed(2), dd: +dd.toFixed(1), total: +rf.reduce((p, q) => p + q, 0).toFixed(1),
      long: side(1), short: side(-1), older: +avg(xs.filter((x) => x.t < cut).map((x) => x.r)).toFixed(3), newer: +avg(xs.filter((x) => x.t >= cut).map((x) => x.r)).toFixed(3),
    };
  };
  const st = new Map(cells.map((c) => [key(c), stat(rows.get(key(c)) ?? [])]));
  const pctRate = (r: number) => `${(100 * r).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
  const table = (title: string, f: (x: ReturnType<typeof stat>) => string) => [
    '', title, `  ${'volume \\ funding'.padEnd(18)}${FV_GRID.rates.map((r) => pctRate(r).padStart(16)).join('')}`,
    ...FV_GRID.vols.map((v) => `  ${`${v}x`.padEnd(18)}${FV_GRID.rates.map((r) => f(st.get(key({ vol: v, rate: r, body: 0 }))!).padStart(16)).join('')}`),
  ];
  const out = [
    `FUNDING SQUEEZE, FOURTH ROUND: SQUEEZE REQUIREMENTS (rules fixed before the run): ${day(Math.max(from, start))} to ${day(to)} (${months.toFixed(1)} months of Bitunix funding), ${coins} of ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    `Live line: 4H squeeze candle (volume >= Nx its 20-candle mean, 24h funding beyond +/-X per 8h, moving against the crowd), the first 1H candle in the next 4 hours closing the crowd's way, entry at the next 1H open; stop 2 ATR(4H), ${ex.name}, no time limit, costs 0.22%; one trade per coin at a time. Now: 3x and 0.05%.`,
    ...table('Avg R with funding (trades):', (x) => (x.n ? `${sg(x.rf)} (${x.n})` : '-')),
    ...table('Avg R before funding; timing edge t:', (x) => (x.n ? `${sg(x.r)}; t ${x.t.toFixed(1)}` : '-')),
    ...table('Random-direction edge; max drawdown R (with funding):', (x) => (x.n ? `${sg(x.edge)}; ${x.dd.toFixed(0)}` : '-')),
    ...table('Trades a month; win %:', (x) => (x.n ? `${x.perMonth.toFixed(1)}; ${x.win}%` : '-')),
    '', 'Candle size at 3x / 0.05% (the squeeze candle\'s body at least N ATR(14) of the 4H):',
    ...FV_GRID.bodies.map((b) => { const x = st.get(key({ vol: 3, rate: 0.0005, body: b }))!; return `  ${(b ? `body >= ${b} ATR` : 'no floor (now)').padEnd(18)} ${x.n ? `${sg(x.rf)} with funding (${x.n} trades, ${x.perMonth.toFixed(1)} a month), ${sg(x.r)} before; edge ${sg(x.edge)}; timing ${sg(x.te)} (t ${x.t.toFixed(1)}); DD ${x.dd.toFixed(0)}R; longs ${sg(x.long.rf)} (${x.long.n}), shorts ${sg(x.short.rf)} (${x.short.n})` : 'no trades'}`; }),
    '',
  ];
  for (const c of cells) out.push(`CELL ${JSON.stringify({ ...c, ...st.get(key(c))! })}`);
  // dump: the live line's trades (3x / 0.05%, no floor), for merging sliced runs of a coin set trade by trade.
  const r4 = (x: number) => +x.toFixed(4);
  if (dump) for (const x of rows.get(key({ vol: 3, rate: 0.0005, body: 0 })) ?? []) {
    out.push(`TRADE ${JSON.stringify({ s: x.sym, t: x.t, d: x.d, r: r4(x.r), f: r4(x.fund), ra: r4(avg(x.rand)), rt: x.rtime.length ? r4(avg(x.rtime)) : null, p: r4(x.stopPct) })}`);
  }
  return out;
}

/** Fifth round (header): the owner's Fibonacci plan on the squeeze signals. */
export const FV_FIB = {
  lookback: 12, arm: 0.382, entry: 0.382, expiryDays: 7,
  readings: ['first drop', 'whole leg'] as const,
  targets: ['1.272 extension', '1.618 extension', 'golden pocket', '0.786', 'FVG'] as const,
};
export type FvFibReading = (typeof FV_FIB.readings)[number];
export type FvFibTarget = (typeof FV_FIB.targets)[number];
export interface FvFibTrade { i: number; d: 1 | -1; entryAt: number; entry: number; risk: number; target: number; exitAt: number; exit: number; how: 'target' | 'stop' | 'open'; r: number; fund: number }

/**
 * The Fibonacci plan of one coin for one zone reading and take profit (header, fifth round). `setups` = squeeze
 * signals that started a setup in the window; `trades` = those entered (entered before `from`: left out, still busy).
 */
export function fvFibTrades(c4: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, fs: ReadonlyArray<FundingPoint>, from: number, reading: FvFibReading, target: FvFibTarget): { trades: FvFibTrade[]; setups: number } {
  const sq = fvEvents(c4, fs, 4 * H, LEVELS[0].rate, LEVELS[0].vol).filter((e) => e.bar === -e.crowd && e.i >= FV_FIB.lookback && e.i + 1 < c4.length);
  const trades: FvFibTrade[] = [];
  let busy = -Infinity, k0 = 0, setups = 0;
  for (const e of sq) {
    const close4 = c4[e.i]!.openTime + 4 * H;
    if (close4 < busy) continue;
    if (close4 >= from) setups++;
    // u = the squeeze's way (+1: up, the trade is a short); levels below work for both: x - f * (x - y).
    const u = e.bar, d = (-u) as 1 | -1;
    const far = (b: Candle) => (u > 0 ? b.high : b.low), near = (b: Candle) => (u > 0 ? b.low : b.high);
    let L = near(c4[e.i]!);
    for (let q = e.i - FV_FIB.lookback; q < e.i; q++) L = u > 0 ? Math.min(L, c4[q]!.low) : Math.max(L, c4[q]!.high);
    const prev = c4[e.i - 1]!, next = c4[e.i + 1]!;
    const fvg = u > 0 ? (next.low > prev.high ? prev.high : null) : (next.high < prev.low ? prev.low : null), fvgAt = next.openTime + 4 * H;
    while (k0 < h1.length && h1[k0]!.openTime < close4) k0++;
    const expiry = close4 + FV_FIB.expiryDays * DAY, is4h = (b: Candle) => (b.openTime + H) % (4 * H) === 0;
    let top = far(c4[e.i]!), low: number | null = null, armed = false, end = expiry, k = k0;
    let fill: { k: number; entry: number; low: number } | null = null;
    for (; k < h1.length && h1[k]!.openTime < expiry; k++) {
      const b = h1[k]!;
      if (armed && low != null) {
        const level = reading === 'first drop' ? top - FV_FIB.entry * (top - low) : top - FV_FIB.entry * (top - L);
        if (u * (far(b) - level) >= 0) { fill = { k, entry: u * (b.open - level) > 0 ? b.open : level, low }; break; }
        low = u > 0 ? Math.min(low, b.low) : Math.max(low, b.high);
        if (is4h(b) && u * (b.close - top) > 0) { end = b.openTime + H; break; } // invalidated before the entry
        continue;
      }
      if (u * (far(b) - top) > 0) { top = far(b); low = b.close; } // a new extreme: the drop starts again from it
      else low = low == null ? near(b) : u > 0 ? Math.min(low, near(b)) : Math.max(low, near(b));
      if (u * (top - FV_FIB.arm * (top - L) - low) >= 0) armed = true;
    }
    if (!fill) { busy = Math.min(end, k < h1.length ? h1[k]!.openTime + H : end); continue; }
    const { entry } = fill, risk = u * (top - entry), fl = fill.low;
    const tgt = target === '1.272 extension' ? fl - 0.272 * (top - fl) : target === '1.618 extension' ? fl - 0.618 * (top - fl)
      : target === 'golden pocket' ? top - 0.618 * (top - L) : target === '0.786' ? top - 0.786 * (top - L) : h1[fill.k]!.openTime >= fvgAt ? fvg : null;
    if (!(risk > 0) || tgt == null || !(u * (entry - tgt) > 0)) { busy = h1[fill.k]!.openTime + H; continue; }
    let exit = h1[h1.length - 1]!.close, exitK = h1.length - 1, how: FvFibTrade['how'] = 'open';
    // The entry candle can still close above 0 (a 4H close); targets count from the next candle.
    if (is4h(h1[fill.k]!) && u * (h1[fill.k]!.close - top) > 0) { exit = h1[fill.k]!.close; exitK = fill.k; how = 'stop'; }
    else for (let q = fill.k + 1; q < h1.length; q++) {
      const b = h1[q]!;
      if (u * (near(b) - tgt) <= 0) { exit = u * (b.open - tgt) < 0 ? b.open : tgt; exitK = q; how = 'target'; break; }
      if (is4h(b) && u * (b.close - top) > 0) { exit = b.close; exitK = q; how = 'stop'; break; }
    }
    const entryAt = h1[fill.k]!.openTime, exitAt = h1[exitK]!.openTime;
    busy = how === 'open' ? Infinity : exitAt + H;
    if (entryAt < from) continue;
    trades.push({ i: e.i, d, entryAt, entry, risk, target: tgt, exitAt, exit, how, r: (d * (exit - entry)) / risk - (0.0022 * entry) / risk, fund: fundingR(fs, d, entryAt, exitAt, entry, risk) });
  }
  return { trades, setups };
}

/** Fifth round (header): the two zone readings x five take profits against the current line. Prints `FIB {json}` lines. */
export function fvFibReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  type Tr = { t: number; r: number; fund: number; d: 1 | -1; risk: number; days: number };
  const lines = new Map<string, Tr[]>(), setups = new Map<string, number>();
  const add = (k: string, xs: Tr[], n: number) => { lines.set(k, [...(lines.get(k) ?? []), ...xs]); setups.set(k, (setups.get(k) ?? 0) + n); };
  let coins = 0, start = Infinity;
  for (const sym of symbols) {
    const fs = data[sym]?.funding ?? [], c4 = data[sym]?.candles['4h'] ?? [], h1 = data[sym]?.candles['1h'] ?? [];
    if (fs.length < 10 || c4.length < 100 || h1.length < 100) continue;
    coins++;
    start = Math.min(start, fs[0]!.time);
    const cur = fvConfluenceTrades(c4, h1, fs, H, from).trades;
    add('current', cur.map(({ j, d, risk, t }) => ({ t: h1[j]!.openTime, r: t.r, fund: fundingR(fs, d, h1[j]!.openTime, h1[t.end]!.openTime, h1[j]!.open, risk), d, risk: (100 * risk) / h1[j]!.open, days: (h1[t.end]!.openTime - h1[j]!.openTime) / DAY })), 0);
    for (const rd of FV_FIB.readings) for (const tg of FV_FIB.targets) {
      const { trades, setups: n } = fvFibTrades(c4, h1, fs, from, rd, tg);
      add(`${rd}|${tg}`, trades.map((x) => ({ t: x.entryAt, r: x.r, fund: x.fund, d: x.d, risk: (100 * x.risk) / x.entry, days: (x.exitAt - x.entryAt) / DAY })), n);
    }
  }
  const months = (to - Math.max(from, start)) / (30.44 * DAY);
  const stat = (xs: ReadonlyArray<Tr>) => {
    const rf = xs.map((x) => x.r + x.fund);
    let eq = 0, peak = 0, dd = 0;
    for (const x of [...xs].sort((a, b) => a.t - b.t)) { eq += x.r + x.fund; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const side = (d: 1 | -1) => { const ys = xs.filter((x) => x.d === d); return { n: ys.length, rf: +avg(ys.map((x) => x.r + x.fund)).toFixed(3) }; };
    return {
      n: xs.length, perMonth: +(xs.length / months).toFixed(1), win: Math.round((100 * xs.filter((x) => x.r > 0).length) / Math.max(1, xs.length)),
      r: +avg(xs.map((x) => x.r)).toFixed(3), rf: +avg(rf).toFixed(3), total: +rf.reduce((p, q) => p + q, 0).toFixed(1), dd: +dd.toFixed(1),
      risk: +avg(xs.map((x) => x.risk)).toFixed(1), days: +avg(xs.map((x) => x.days)).toFixed(1), long: side(1), short: side(-1),
      older: +avg(xs.filter((x) => x.t < cut).map((x) => x.r + x.fund)).toFixed(3), newer: +avg(xs.filter((x) => x.t >= cut).map((x) => x.r + x.fund)).toFixed(3),
    };
  };
  const out = [
    `FUNDING SQUEEZE, FIFTH ROUND: THE FIBONACCI PLAN (rules fixed before the run): ${day(Math.max(from, start))} to ${day(to)} (${months.toFixed(1)} months of Bitunix funding), ${coins} of ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Short after a squeeze up (longs mirrored): a sell limit at the 0.382 edge of the 0.236-0.382 zone, a 4H close beyond the squeeze extreme (0) invalidates; 1R = 0 - entry. Costs 0.22%; R with funding.',
    `  ${'line'.padEnd(40)} ${'setups'.padStart(6)} ${'trades'.padStart(6)} ${'/mo'.padStart(5)} ${'win'.padStart(4)} ${'avg R'.padStart(6)} ${'w/fund'.padStart(7)} ${'total'.padStart(7)} ${'DD'.padStart(6)} ${'risk%'.padStart(6)} ${'days'.padStart(5)}   longs / shorts (w/fund)`,
  ];
  for (const k of ['current', ...FV_FIB.readings.flatMap((rd) => FV_FIB.targets.map((tg) => `${rd}|${tg}`))]) {
    const x = stat(lines.get(k) ?? []), n = setups.get(k) ?? 0;
    out.push(`  ${(k === 'current' ? 'current: 1H confirmation, 2 ATR, 2R' : k.replace('|', ', ')).padEnd(40)} ${String(k === 'current' ? '-' : n).padStart(6)} ${String(x.n).padStart(6)} ${x.perMonth.toFixed(1).padStart(5)} ${`${x.win}%`.padStart(4)} ${sg(x.r).padStart(6)} ${sg(x.rf).padStart(7)} ${x.total.toFixed(1).padStart(7)} ${x.dd.toFixed(1).padStart(6)} ${x.risk.toFixed(1).padStart(6)} ${x.days.toFixed(1).padStart(5)}   ${sg(x.long.rf)} (${x.long.n}) / ${sg(x.short.rf)} (${x.short.n})`);
  }
  out.push('');
  for (const [k, xs] of lines) out.push(`FIB ${JSON.stringify({ k, setups: setups.get(k) ?? 0, ...stat(xs) })}`);
  return out;
}
