// Owner 2026-10-10: "Allows break even at 2r has to be killing runners right?" The 2026-10-08 test (manual-management
// exits) found that dropping it helped two models on the old exits; this is the exits live since 2026-10-09. Rules fixed
// before the runs (research and fresh $0.5M+ coins, BTC left out of the fresh set; `--rsi-trades --be-check`):
// - Models: the live models with the breakeven move (rule set option 1: all but 4H under-floor and 15M-RSI10), each on
//   its one exit (SIGNAL_EXITS), no time limit, live entries and filters (BTC filter on shorts, skip late but for the
//   daily failure short), one trade per model and coin at a time.
// - Variants: as live (the stop goes to the entry once a close is +2R the trade's way); no breakeven; and for the 15R /
//   20R-target models, breakeven at +3R and at +5R (with a 3R target they never come before it). Each variant is its own
//   run: its trades decide which later setups are taken.
// - Per variant: trades, win %, avg R, total R, max drawdown (R), edge over a random side (20 seeds), older / newer.
// - Trade by trade: the live entries that closed at breakeven, and the same entries without it: reached the target (a
//   runner cut), hit the stop (a loss saved), or still open (marked at the last close); the net R.
// - Read: a variant beats breakeven at +2R for a model if its avg R is higher on both coin sets, with >= 20 trades on
//   each. Drawdown is shown alongside; the owner decides. Nothing changes in the bot from this report.

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { endingOf, type Ending } from './peakr';
import { BE_R, BTC_SMA, LATE_ATR, RSI_MODELS, SIGNAL_EXITS, btcBearishAt, frameworkSetups, planSkipsLate, planUsesBe, rsiFrameworkSignals, runBeforeEntry, type RsiModelId } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';
import { flip } from './scalp2';
import { STATS_HEAD } from './smcreport';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, PLAN = 'option 1' as const, SEEDS = 20;

/** The live models with the breakeven move under rule set option 1. */
export const BE_MODELS: readonly RsiModelId[] = (Object.keys(SIGNAL_EXITS) as RsiModelId[]).filter((m) => planUsesBe(PLAN, m) && !RSI_MODELS[m].dropped);

/** The variants for a model (header): as live first, then none, then +3R / +5R where the target is beyond them. */
export function beVariants(m: RsiModelId): { label: string; be?: number }[] {
  const target = SIGNAL_EXITS[m]?.exit.spec.target ?? Infinity;
  return [
    { label: `as live (breakeven at +${BE_R}R)`, be: BE_R }, { label: 'no breakeven' },
    ...(target > 5 ? [{ label: 'breakeven at +3R', be: 3 }, { label: 'breakeven at +5R', be: 5 }] : []),
  ];
}

type Trade = SignalTrade & { ending: Ending; rand: number[] };

/** The report for one coin set. `skip` = coins loaded only as a reference (BTC on fresh coin sets): no trades counted. */
export function beCheckReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), BTC_SMA);
  const res = new Map<string, Trade[]>(); // model|variant index -> trades
  let used = 0, liveRows = 0, matched = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 100 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = (data[sym]?.candles['4h'] ?? []).filter((b) => b.openTime + 4 * 3_600_000 <= now);
    const setups = frameworkSetups(d1, h4);
    for (const m of BE_MODELS) {
      const x = SIGNAL_EXITS[m]!.exit;
      beVariants(m).forEach((v, vi) => {
        let busy = -Infinity;
        for (const s of setups) {
          if (s.model !== m || s.j == null || s.stop == null || s.j >= s.c.length || s.known <= busy) continue;
          const c = s.c, j = s.j, entry = c[j]!.open;
          if (s.d < 0 && !btcBearishAt(btc, btcSma, c[j]!.openTime)) continue;
          if (planSkipsLate(PLAN, m) && runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR) continue;
          const spec: ExitSpec = { ...x.spec, ...(v.be != null ? { be: v.be } : {}) };
          const dist = x.stopMult * s.d * (entry - s.stop);
          const t = specTrade(c, s.atr, {}, j, entry - s.d * dist, s.d, spec);
          if (!t) continue;
          busy = t.open ? Infinity : c[t.end]!.openTime + s.bar;
          if (c[j]!.openTime < from) continue;
          const rand: number[] = [];
          for (let k = 1; k <= SEEDS; k++) {
            const d = (flip(k, sym, j) ? -s.d : s.d) as 1 | -1, y = specTrade(c, s.atr, {}, j, entry - d * dist, d, spec);
            if (y) rand.push(y.r);
          }
          const key = `${m}|${vi}`;
          res.set(key, [...(res.get(key) ?? []), { sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: Math.round((c[t.end]!.openTime - c[j]!.openTime) / DAY), ending: endingOf(t, s.d), rand }]);
        }
      });
    }
    // Check: the as-live variant is the bot's own trades (its signal rows, one exit each).
    const mine = new Map(BE_MODELS.flatMap((m) => (res.get(`${m}|0`) ?? []).filter((t) => t.sym === sym).map((t) => [`${m}|${t.t}`, t.r] as const)));
    for (const r of rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc, { live: true })) {
      if (!BE_MODELS.includes(r.model) || r.enteredAt == null || r.r == null || r.enteredAt < from) continue;
      liveRows++;
      const t = mine.get(`${r.model}|${r.enteredAt}`);
      if (t != null && Number(t.toFixed(2)) === r.r) matched++;
    }
  }
  const sum = (xs: ReadonlyArray<number>) => xs.reduce((p, q) => p + q, 0);
  const out = [
    `BREAKEVEN CHECK (live entries, rule set ${PLAN}, each model on its one exit, no time limit): ${day(from)} to now, ${used} coins. Older / newer = before / after ${day(cut)}. As-live trades matching the bot's signal rows: ${matched} of ${liveRows}.`,
    `Breakeven = the stop moves to the entry once a close is the given R the trade's way (about 0R after fees if hit). Each variant is its own run.`,
  ];
  for (const m of BE_MODELS) {
    const x = SIGNAL_EXITS[m]!.exit;
    out.push('', `${RSI_MODELS[m].label} (${x.spec.name}, stop ${x.stopMult}x)`, STATS_HEAD);
    beVariants(m).forEach((v, vi) => {
      const xs = res.get(`${m}|${vi}`) ?? [];
      if (!xs.length) { out.push(`    ${v.label}: no trades`); return; }
      const real = sum(xs.map((t) => t.r)) / xs.length, rnd = sum(xs.flatMap((t) => t.rand)) / Math.max(1, xs.flatMap((t) => t.rand).length);
      out.push(`${statsLine(`    ${v.label}`.padEnd(84), xs, cut)}   random ${rnd.toFixed(2)}, edge ${(real - rnd).toFixed(2)}; open ${xs.filter((t) => t.ending === 'open').length}`);
      let eq = 0, peak = 0, dd = 0;
      for (const t of [...xs].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
      out.push(`BE ${JSON.stringify({ m, v: v.label, n: xs.length, r: +real.toFixed(3), total: +sum(xs.map((t) => t.r)).toFixed(1), dd: +dd.toFixed(1), edge: +(real - rnd).toFixed(3), be: xs.filter((t) => t.ending === 'breakeven').length })}`);
    });
    // The live entries closed at breakeven, and the same entries without it.
    const live = res.get(`${m}|0`) ?? [], none = new Map((res.get(`${m}|1`) ?? []).map((t) => [`${t.sym}|${t.t}`, t]));
    const at = live.filter((t) => t.ending === 'breakeven'), pairs = at.map((t) => ({ a: t, b: none.get(`${t.sym}|${t.t}`) })).filter((p) => p.b);
    const g = (e: Ending) => pairs.filter((p) => p.b!.ending === e);
    const part = (e: Ending, name: string) => { const ps = g(e); return `${ps.length} ${name} (${sg(sum(ps.map((p) => p.b!.r - p.a.r)))}R)`; };
    out.push(at.length
      ? `  closed at breakeven, as live: ${at.length} of ${live.length} trades. Without breakeven the same entries: ${part('target', 'reached the target')}, ${part('stop', 'hit the stop')}, ${part('open', 'still open')}; net ${sg(sum(pairs.map((p) => p.b!.r - p.a.r)))}R${pairs.length < at.length ? ` (${at.length - pairs.length} not taken without breakeven)` : ''}`
      : `  closed at breakeven, as live: none of ${live.length} trades`);
  }
  // All the models together.
  const pooled = (vi: number) => BE_MODELS.flatMap((m) => res.get(`${m}|${vi}`) ?? []);
  out.push('', 'All these models together (as live / no breakeven):', STATS_HEAD, statsLine('    as live'.padEnd(84), pooled(0), cut), statsLine('    no breakeven'.padEnd(84), pooled(1), cut));
  return out;
}

const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
