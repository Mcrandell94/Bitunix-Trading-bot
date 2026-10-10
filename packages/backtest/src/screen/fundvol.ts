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

import type { Candle } from '@bot/marketdata';
import type { OiPoint, TakerBar } from '../binancevision';
import { atrWilder } from '../indicators';
import type { FundingPoint } from '../types';
import { specTrade, type ExitSpec } from './exits';
import { STATS_HEAD } from './smcreport';
import { pick, randomDirectionTwins, randomTimeTwins, timingLine, type TimedRow } from './timing';

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
