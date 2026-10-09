// Owner 2026-10-09, before the time limits are removed: "How many of these trades would hit at 10 or 15R but we
// consider them a trailing stop because it didn't reach 20R?" The three models with a 20R target (daily bottom
// divergence, daily triple divergence, weekly double bottom): live entries and filters (rule set option 1, breakeven at
// +2R), no time limit, one trade per model and coin at a time, as live (screen/manualexits.ts). Per trade, the peak R it
// reached on the 20R-target version, how the trades that reached +10R / +15R but not +20R ended, and the same entries
// with a profit lock on the 20R target, a 15R or 10R target, or none (stop and breakeven only).

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { BE_R, BTC_SMA, LATE_ATR, LIVE_EXITS, RSI_MODELS, btcBearishAt, frameworkSetups, planSkipsLate, planUsesBe, runBeforeEntry, type RsiModelId } from './rsisignals';
import { flip } from './scalp2';
import { statsLine, type SignalTrade } from './rsitrades';
import { STATS_HEAD } from './smcreport';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, PLAN = 'option 1' as const, SEEDS = 20;
export const PEAK_MODELS: readonly RsiModelId[] = ['bottom-div', 'triple-div', 'w-dbl-bottom'];
const EXITS: ReadonlyArray<{ label: string; target?: number; lock?: ExitSpec['lock'] }> = [
  { label: '20R target', target: 20 },
  // The owner's "trailing stop" idea: a trade that got to +10R / +15R keeps part of it instead of falling back to 0R.
  { label: '20R target, stop to +5R at +10R and to +10R at +15R', target: 20, lock: [[10, 5], [15, 10]] },
  { label: '15R target', target: 15 }, { label: '10R target', target: 10 }, { label: 'no target (stop and breakeven only)' },
];
const BUCKETS = [2, 5, 10, 15, 20];

/**
 * The best R a trade reached before its exit: the best high (low for a short) from the entry bar on. The bar it was
 * stopped on is left out, since the order of its high and low is unknown. Pure.
 */
export function peakR(c: ReadonlyArray<Candle>, j: number, end: number, entry: number, risk: number, d: 1 | -1, how: string): number {
  let best = 0;
  for (let k = j; k <= (how === 'stop' ? end - 1 : end); k++) best = Math.max(best, (d * ((d > 0 ? c[k]!.high : c[k]!.low) - entry)) / risk);
  return best;
}

export type Ending = 'target' | 'breakeven' | 'stop' | 'open';
/** How a trade ended: its target, its stop after the breakeven move (about 0R), its first stop, or still open. */
export const endingOf = (t: { how: string; open: boolean; stop: number; entry: number }, d: 1 | -1): Ending =>
  t.open ? 'open' : t.how === 'target' ? 'target' : d * (t.stop - t.entry) >= 0 ? 'breakeven' : 'stop';

type Trade = SignalTrade & { peak: number; ending: Ending; rand: number[] };

/** Trades that reached `lo` R but not 20R on the 20R-target version, and how they ended. */
function reachedLine(xs: ReadonlyArray<Trade>, lo: number): string {
  const g = xs.filter((x) => x.peak >= lo && x.ending !== 'target');
  if (!g.length) return `  reached +${lo}R, not +20R: none`;
  const n = (e: Ending) => g.filter((x) => x.ending === e).length;
  const avg = (f: (x: Trade) => number) => g.reduce((a, x) => a + f(x), 0) / g.length;
  return `  reached +${lo}R, not +20R: ${g.length} trades (${n('breakeven')} breakeven, ${n('stop')} stop, ${n('open')} still open); `
    + `avg peak ${avg((x) => x.peak).toFixed(1)}R, avg final ${avg((x) => x.r).toFixed(2)}R, given back ${avg((x) => x.peak - x.r).toFixed(1)}R a trade`;
}

/** The report for one coin set. `skip` = coins loaded only as a reference (BTC on fresh coin sets): no trades counted. */
export function peakReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), BTC_SMA);
  const res = new Map<string, Trade[]>(); // model|exit index -> trades
  let used = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4f = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = h4f.filter((b) => b.openTime + 4 * 3_600_000 <= now);
    const setups = frameworkSetups(d1, h4);
    EXITS.forEach((ex, xi) => {
      const busy = new Map<RsiModelId, number>();
      for (const s of setups) {
        if (!PEAK_MODELS.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length) continue;
        if (s.known <= (busy.get(s.model) ?? -Infinity)) continue;
        const c = s.c, j = s.j, entry = c[j]!.open;
        if (s.d < 0 && !btcBearishAt(btc, btcSma, c[j]!.openTime)) continue;
        if (planSkipsLate(PLAN, s.model) && runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR) continue;
        const spec: ExitSpec = { name: ex.label, ...(ex.target != null ? { target: ex.target } : {}), ...(ex.lock ? { lock: ex.lock } : {}), ...(planUsesBe(PLAN, s.model) ? { be: BE_R } : {}) };
        const dist = LIVE_EXITS[s.model][0].stopMult * s.d * (entry - s.stop);
        const t = specTrade(c, s.atr, {}, j, entry - s.d * dist, s.d, spec);
        if (!t) continue;
        busy.set(s.model, t.open ? Infinity : c[t.end]!.openTime + s.bar);
        if (c[j]!.openTime < from) continue;
        const rand: number[] = [];
        for (let k = 1; k <= SEEDS; k++) {
          const d = (flip(k, sym, j) ? -s.d : s.d) as 1 | -1, x = specTrade(c, s.atr, {}, j, entry - d * dist, d, spec);
          if (x) rand.push(x.r);
        }
        const key = `${s.model}|${xi}`;
        res.set(key, [...(res.get(key) ?? []), {
          sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: Math.round((c[t.end]!.openTime - c[j]!.openTime) / DAY),
          peak: peakR(c, j, t.end, entry, dist, s.d, t.how), ending: endingOf(t, s.d), rand,
        }]);
      }
    });
  }
  const out = [
    `PEAK R ON THE 20R-TARGET MODELS (live entries, rule set ${PLAN}, breakeven at +${BE_R}R, no time limit): ${day(from)} to now, ${used} coins. Older / newer = before / after ${day(cut)}.`,
    'Peak R = the best high a trade reached before its exit, on the 20R-target version (the bar it was stopped on is left out). Breakeven = closed at the entry after the +2R move (about 0R after fees).',
  ];
  for (const m of PEAK_MODELS) {
    const t20 = res.get(`${m}|0`) ?? [];
    out.push('', `${RSI_MODELS[m].label} (stop ${LIVE_EXITS[m][0].stopMult}x the model's stop distance)`);
    if (!t20.length) { out.push('  no trades'); continue; }
    const cnt = (lo: number, hi: number) => t20.filter((x) => x.peak >= lo && x.peak < hi).length;
    const edges = [-Infinity, ...BUCKETS, Infinity];
    const parts = edges.slice(0, -1).map((lo, i) => {
      const hi = edges[i + 1]!, n = cnt(lo, hi), name = lo === -Infinity ? `under +${hi}R` : hi === Infinity ? `+${lo}R or more` : `+${lo}-${hi}R`;
      return `${name} ${n} (${((100 * n) / t20.length).toFixed(0)}%)`;
    });
    out.push(`  peak R of the ${t20.length} trades on the 20R target: ${parts.join(' | ')}`, reachedLine(t20, 10), reachedLine(t20, 15), STATS_HEAD);
    EXITS.forEach((ex, xi) => {
      const xs = res.get(`${m}|${xi}`) ?? [];
      const a = xs.flatMap((x) => x.rand), rnd = a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN;
      const real = xs.reduce((p, x) => p + x.r, 0) / Math.max(1, xs.length);
      out.push(statsLine(`    ${ex.label}`.padEnd(84), xs, cut) + `   random ${rnd.toFixed(2)}, edge ${(real - rnd).toFixed(2)}; open ${xs.filter((x) => x.ending === 'open').length}`);
    });
  }
  return out;
}
