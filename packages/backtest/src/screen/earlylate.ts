// Early or late (owner 2026-10-10: "were any of the original models just early and got stopped out or even late but
// the move played out?"). The 2026-10-04 loss post-mortem asked the same on the old exits (version A, time limits,
// research coins); this is the live rules since: rule set option 1, each model on its one exit, no time limit, and
// 15M-RSI10 on its live rules. Rules fixed before the runs (research and fresh $0.5M+ coins):
// - Early: a trade stopped at a loss (at its stop with R < -0.5, so not a breakeven exit) is early if price still
//   reaches the trade's own target (under-floor, a trail with no target: +3R) after the stop, within 30 days for the
//   15m and 4H models and 90 days for the daily and weekly models. Also shown: +2R from the entry within the same
//   window, the stop width that would have held (the worst point between the entry and the target, in R) and the days
//   from the stop to the target. Stops whose window runs past the last bar are left out.
// - Baseline: the same side entered at random bars in the 60 days after each trade, with the same stop % and exit
//   (10 seeds), and the same early test on those that stop at a loss. A model is often early if its early rate beats
//   its baseline by >= 10 points on both coin sets, with >= 20 losing stops on each.
// - Late: the trades by how far price had run from the 10-bar extreme before the entry (<= 1, 1-2, 2-3, > 3 ATR), and
//   the setups the skip-late rule drops (> 3 ATR; every model but the daily failure short and 15M-RSI10), taken as if
//   entered (same stop, exit and breakeven; shorts only where the BTC filter allows; not while the model had a trade
//   open or waiting on the coin, and one dropped setup at a time). The rule costs a model R if those setups average at
//   least its taken trades' R on both coin sets, with >= 10 on each.
// Nothing changes in the bot from this report.

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import {
  BE_R, BTC_SMA, LATE_ATR, RSI_MODELS, SIGNAL_EXITS, btcBearishAt, frameworkSetups, planSkipsLate, planUsesBe, rowsFromSetups,
  rsiFrameworkSignals, runBeforeEntry, type RsiModelId, type RsiSignalRow, type Setup,
} from './rsisignals';
import { rsi10LiveSetups } from './rsi10live';
import { pick } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const H = 3_600_000, DAY = 24 * H, SEEDS = 10, SPAN_DAYS = 60, NO_TARGET_R = 3;
type Trade = NonNullable<ReturnType<typeof specTrade>>;

/**
 * The first bar in (k, k + w] whose range reaches `level` the trade's way (d), or -1; -2 if the window runs past the
 * data (whatever happened in it, so a stop near the end is left out either way and the rate is not tilted to early).
 */
export function reachAfter(c: ReadonlyArray<Candle>, k: number, d: 1 | -1, level: number, w: number): number {
  if (k + w >= c.length) return -2;
  for (let q = k + 1; q <= k + w; q++) if (d > 0 ? c[q]!.high >= level : c[q]!.low <= level) return q;
  return -1;
}

/** The worst point between bars j and k (inclusive) against the trade, in R from the entry. */
export function worstR(c: ReadonlyArray<Candle>, j: number, k: number, d: 1 | -1, entry: number, risk: number): number {
  let w = 0;
  for (let q = j; q <= k; q++) w = Math.max(w, (d > 0 ? entry - c[q]!.low : c[q]!.high - entry) / risk);
  return w;
}

/** A trade's early test: null if it did not stop at a loss or its window is cut off by the data. */
export function earlyTest(c: ReadonlyArray<Candle>, j: number, d: 1 | -1, risk: number, t: Trade, w: number): { early: boolean; plus2: boolean; mae: number | null; days: number | null } | null {
  if (t.how !== 'stop' || !(t.r < -0.5)) return null;
  const entry = t.entry, target = t.target ?? entry + d * NO_TARGET_R * risk;
  const kt = reachAfter(c, t.end, d, target, w), k2 = reachAfter(c, t.end, d, entry + d * 2 * risk, w);
  if (kt === -2 || k2 === -2) return null;
  return {
    early: kt >= 0, plus2: k2 >= 0,
    mae: kt >= 0 ? worstR(c, j, kt, d, entry, risk) : null,
    days: kt >= 0 ? (c[kt]!.openTime - c[t.end]!.openTime) / DAY : null,
  };
}

interface Row { model: RsiModelId; sym: string; t: number; r: number; late: number; test: ReturnType<typeof earlyTest>; twinStops: number; twinEarly: number }
interface Skip { model: RsiModelId; sym: string; t: number; r: number; target: boolean }

/** The report (header). Needs 1d and 4h; 15m and 1h for 15M-RSI10. `skip` = reference coins (BTC on fresh sets). */
export function earlyLateReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), BTC_SMA);
  const rows: Row[] = [], skipped: Skip[] = [];
  let used = 0, resim = 0, same = 0;
  const windowBars = (s: Setup) => Math.round(((s.bar >= DAY ? 90 : 30) * DAY) / s.bar);
  const specOf = (m: RsiModelId): { stopMult: number; spec: ExitSpec } | null => {
    const lx = SIGNAL_EXITS[m]?.exit;
    return lx ? { stopMult: lx.stopMult, spec: planUsesBe('option 1', m) ? { ...lx.spec, be: BE_R } : lx.spec } : null;
  };
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 100 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = (data[sym]?.candles['4h'] ?? []).filter((b) => b.openTime + 4 * H <= now);
    const fw = frameworkSetups(d1, h4);
    const m15 = (data[sym]?.candles['15m'] ?? []).filter((b) => b.openTime + 15 * 60_000 <= now), h1 = (data[sym]?.candles['1h'] ?? []).filter((b) => b.openTime + H <= now);
    const r10 = m15.length >= 2000 ? rsi10LiveSetups(m15, h1, h4, d1, Math.max(from, m15[0]!.openTime + 30 * DAY)) : [];
    const live: RsiSignalRow[] = [...rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc, { live: true }), ...(r10.length ? rowsFromSetups(sym, r10, d1, now, 100_000, btc, { live: true }) : [])];
    const byKey = new Map([...fw, ...r10].map((s) => [`${s.model}|${s.known}`, s]));
    // Each live row blocks its model from its signal to its close (Infinity while open, waiting or about to enter), as in planRows.
    const busy = new Map<RsiModelId, [number, number][]>();
    for (const r of live) busy.set(r.model, [...(busy.get(r.model) ?? []), [r.signalAt, r.closedAt ?? Infinity]]);
    for (const r of live) {
      if (!r.plans.includes('option 1') || r.enteredAt == null || r.r == null || r.enteredAt < from) continue;
      const s = byKey.get(`${r.model}|${r.signalAt}`), x = specOf(r.model);
      if (!s || !x || s.j == null || s.stop == null || s.j >= s.c.length) continue;
      const c = s.c, j = s.j, entry = c[j]!.open, risk = x.stopMult * s.d * (entry - s.stop);
      if (!(risk > 0)) continue;
      const t = specTrade(c, s.atr, {}, j, entry - s.d * risk, s.d, x.spec);
      if (!t) continue;
      resim++;
      if (Number(t.r.toFixed(2)) === r.r) same++;
      const w = windowBars(s), span = Math.round((SPAN_DAYS * DAY) / s.bar);
      // Random-time twins: the same side at random bars in (j, j + span], the same stop % and exit, the same early test.
      let twinStops = 0, twinEarly = 0;
      const lo = j + 1, hi = Math.min(c.length - 2, j + span);
      for (let k = 1; k <= SEEDS && hi >= lo; k++) {
        const j2 = lo + pick(k, sym, j, hi - lo + 1), e2 = c[j2]!.open, r2 = e2 * (risk / entry);
        const t2 = specTrade(c, s.atr, {}, j2, e2 - s.d * r2, s.d, x.spec);
        const e = t2 ? earlyTest(c, j2, s.d, r2, t2, w) : null;
        if (e) { twinStops++; if (e.early) twinEarly++; }
      }
      rows.push({ model: r.model, sym, t: r.enteredAt, r: r.r, late: runBeforeEntry(c, s.atr, j, s.d, entry), test: earlyTest(c, j, s.d, risk, t, w), twinStops, twinEarly });
    }
    // The setups the skip-late rule drops, taken as if entered (one at a time per model).
    const skipBusy = new Map<RsiModelId, number>();
    for (const s of fw) {
      if (RSI_MODELS[s.model].dropped || !planSkipsLate('option 1', s.model) || s.j == null || s.stop == null || s.j >= s.c.length) continue;
      const x = specOf(s.model);
      if (!x) continue;
      const c = s.c, j = s.j, entry = c[j]!.open, at = c[j]!.openTime;
      if (at < from || !(runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR)) continue; // NaN = not late, as planRows
      if (s.d < 0 && !btcBearishAt(btc, btcSma, at)) continue;
      if ((busy.get(s.model) ?? []).some(([a, b]) => s.known >= a && s.known <= b) || s.known <= (skipBusy.get(s.model) ?? -Infinity)) continue;
      const risk = x.stopMult * s.d * (entry - s.stop);
      if (!(risk > 0)) continue;
      const t = specTrade(c, s.atr, {}, j, entry - s.d * risk, s.d, x.spec);
      if (!t) continue;
      skipBusy.set(s.model, t.open ? Infinity : c[t.end]!.openTime + s.bar);
      const target = t.target ?? entry + s.d * NO_TARGET_R * risk;
      let hit = false;
      for (let q = j; q <= t.end && !hit; q++) hit = s.d > 0 ? c[q]!.high >= target : c[q]!.low <= target;
      skipped.push({ model: s.model, sym, t: at, r: t.r, target: hit });
    }
  }

  const avg = (xs: ReadonlyArray<number>) => (xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : NaN);
  const f2 = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}` : '-');
  const pc = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
  const models = [...new Set([...rows.map((x) => x.model), ...skipped.map((x) => x.model)])].sort((a, b) => Object.keys(RSI_MODELS).indexOf(a) - Object.keys(RSI_MODELS).indexOf(b));
  const out = [
    `EARLY OR LATE (live rules: option 1, each model on its one exit, no time limit; 15M-RSI10 live): ${day(from)} to now, ${used} coins. Older / newer = before / after ${day(cut)}. Re-simulated trades matching the live rows: ${same} of ${resim}.`,
    `Early = stopped at a loss (R < -0.5), then price reached the trade's target (under-floor: +${NO_TARGET_R}R) within 30 days (15m, 4H models) or 90 days (daily, weekly). Baseline = the same test on the same side entered at random bars in the next ${SPAN_DAYS} days (${SEEDS} seeds).`,
    '',
    'EARLY: model, trades, avg R, losing stops (share of trades), then of those: +2R after the stop, the target after the stop (early), the baseline\'s early rate; for the early ones: the stop that would have held (median worst point, R) and the median days from the stop to the target.',
  ];
  for (const m of models) {
    const xs = rows.filter((x) => x.model === m);
    if (!xs.length) continue;
    const st = xs.filter((x) => x.test), early = st.filter((x) => x.test!.early), p2 = st.filter((x) => x.test!.plus2);
    const tw = xs.reduce((p, x) => p + x.twinStops, 0), twe = xs.reduce((p, x) => p + x.twinEarly, 0);
    out.push(`  ${RSI_MODELS[m].label.padEnd(30)} trades ${String(xs.length).padStart(4)}  avg ${f2(avg(xs.map((x) => x.r))).padStart(6)}  losing stops ${String(st.length).padStart(4)} (${pc(st.length, xs.length).padStart(4)})  +2R after ${pc(p2.length, st.length).padStart(4)}  early ${String(early.length).padStart(3)} = ${pc(early.length, st.length).padStart(4)}  baseline ${pc(twe, tw).padStart(4)} (${tw})  held with ${early.length ? `${f2(med(early.map((x) => x.test!.mae!)))}R` : '-'}  ${early.length ? `${med(early.map((x) => x.test!.days!)).toFixed(0)} days` : '-'}`);
  }
  out.push('', 'LATE: the trades taken by how far price had run from the 10-bar extreme before the entry (n, win %, avg R).');
  const buckets: [string, (x: number) => boolean][] = [['<= 1 ATR', (x) => x <= 1], ['1-2 ATR', (x) => x > 1 && x <= 2], ['2-3 ATR', (x) => x > 2 && x <= 3], ['> 3 ATR', (x) => x > 3]];
  for (const m of models) {
    const xs = rows.filter((x) => x.model === m);
    if (!xs.length) continue;
    out.push(`  ${RSI_MODELS[m].label.padEnd(30)} ${buckets.map(([l, ok]) => { const g = xs.filter((x) => ok(x.late)); return `${l} ${g.length} ${pc(g.filter((x) => x.r > 0).length, g.length)} ${f2(avg(g.map((x) => x.r)))}`; }).join('  |  ')}`);
  }
  out.push('', 'SKIPPED AS LATE (> 3 ATR run before the entry), taken as if entered: n, avg R, reached the target, against the trades taken.');
  for (const m of models) {
    const ys = skipped.filter((x) => x.model === m), xs = rows.filter((x) => x.model === m);
    if (!ys.length) continue;
    out.push(`  ${RSI_MODELS[m].label.padEnd(30)} skipped ${String(ys.length).padStart(4)}  avg ${f2(avg(ys.map((x) => x.r))).padStart(6)}  target ${pc(ys.filter((x) => x.target).length, ys.length).padStart(4)}  (older ${f2(avg(ys.filter((x) => x.t < cut).map((x) => x.r)))} / newer ${f2(avg(ys.filter((x) => x.t >= cut).map((x) => x.r)))})   taken ${String(xs.length).padStart(4)}  avg ${f2(avg(xs.map((x) => x.r)))}`);
  }
  // Per-trade lines for merging and for the write-up.
  for (const x of rows) out.push(`ELT ${JSON.stringify({ m: x.model, s: x.sym, t: x.t, r: x.r, l: Number(x.late.toFixed(2)), st: x.test ? 1 : 0, e: x.test?.early ? 1 : 0, p2: x.test?.plus2 ? 1 : 0, mae: x.test?.mae != null ? Number(x.test.mae.toFixed(2)) : null, dy: x.test?.days != null ? Number(x.test.days.toFixed(1)) : null, ts: x.twinStops, te: x.twinEarly })}`);
  for (const x of skipped) out.push(`ELS ${JSON.stringify({ m: x.model, s: x.sym, t: x.t, r: Number(x.r.toFixed(3)), h: x.target ? 1 : 0 })}`);
  return out;
}
