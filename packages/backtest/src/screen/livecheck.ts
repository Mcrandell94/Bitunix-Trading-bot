// Owner 2026-10-09 ("Yes run the live model check"): how much of each live model's edge is entry timing, with the
// stricter baseline from the SMC top-down test (timing.ts). The live code itself over history, as liveRulesReport in
// fixes.ts: rsiFrameworkSignals (rsi10LiveSetups + rowsFromSetups for 15M-RSI10), rule set 'option 1', each model on its
// live exit (LIVE_VARIANT). Per trade, 20 seeds each: the same entry in a random direction (the old check), and the same
// side entered at a random bar in the 60 days after the entry, with the same stop % and exit (breakeven where option 1
// uses it). Timing edge = R minus the mean of its own random-time twins.
// Read, fixed before the run (per model, on research and fresh coins; $0.35-0.5M alongside): timing edge > 0 with
// t >= 2 = the entry timing adds R; > 0 with t < 2 = positive, not proven; <= 0 = the model's R comes from the market it
// trades, not its timing (flagged for the owner; nothing changes on its own).

import type { Candle } from '@bot/marketdata';
import { specTrade } from './exits';
import { BE_R, frameworkSetups, LIVE_EXITS, LIVE_VARIANT, planUsesBe, RSI_MODELS, rowsFromSetups, rsiFrameworkSignals, SIGNAL_EXITS, type RsiModelId, type RsiSignalRow, type Setup } from './rsisignals';
import { rsi10LiveSetups } from './rsi10live';
import { statsLine, type SignalTrade } from './rsitrades';
import { STATS_HEAD } from './smcreport';
import { randomDirectionTwins, randomTimeTwins, timingLine, type TimedRow } from './timing';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, SEEDS = 20, SPAN_DAYS = 60;
/** The models the live bot starts on coins under $0.5M (VOLUME_TIERS[0] in packages/worker/src/rsiSignals.ts). */
const THIN_MODELS: ReadonlySet<RsiModelId> = new Set(['bottom-div', 'triple-div', 'w-dbl-bottom', 'w-bear-div', '4h-fail-short', '15m-rsi10']);
type Row = TimedRow & { model: RsiModelId };
interface Tally { rows: number; same: number }
/** Every option-1 trade on either exit version (for the per-band model choice, as the thin-coin decision of 2026-10-07). */
type Both = SignalTrade & { model: RsiModelId; variant: 0 | 1 };
const bothOf = (sym: string, rows: ReadonlyArray<RsiSignalRow>, from: number): Both[] => rows
  .filter((r) => r.plans.includes('option 1') && r.enteredAt != null && r.enteredAt >= from && r.r != null)
  .map((r) => ({ model: r.model, variant: r.variant, sym, t: r.enteredAt!, r: r.r!, stopPct: r.stopPct ?? NaN, bars: Math.round(((r.closedAt ?? r.enteredAt!) - r.enteredAt!) / DAY) }));

/**
 * The live rows of one coin (option 1, each model's live exit; `single`: its one exit without a time limit, SIGNAL_EXITS),
 * with both baselines; `tally` counts re-simulation matches.
 */
function timedRows(sym: string, rows: ReadonlyArray<RsiSignalRow>, setups: ReadonlyArray<Setup>, from: number, tally: Tally, single = false): Row[] {
  const byKey = new Map(setups.map((s) => [`${s.model}|${s.known}`, s]));
  const out: Row[] = [];
  for (const r of rows) {
    if (!r.plans.includes('option 1') || r.variant !== (LIVE_VARIANT[r.model] ?? 0) || r.enteredAt == null || r.enteredAt < from || r.r == null) continue;
    const s = byKey.get(`${r.model}|${r.signalAt}`);
    if (!s || s.j == null || s.stop == null || s.j >= s.c.length) continue;
    const lx = single ? SIGNAL_EXITS[r.model]!.exit : LIVE_EXITS[r.model][r.variant], spec = planUsesBe('option 1', r.model) ? { ...lx.spec, be: BE_R } : lx.spec;
    const c = s.c, j = s.j, entry = c[j]!.open, stop = entry - lx.stopMult * (entry - s.stop);
    // The same trade as the live row (planRows in rsisignals.ts), so the twins use exactly its stop and exit.
    const own = specTrade(c, s.atr, {}, j, stop, s.d, spec);
    tally.rows++;
    if (own && Number(own.r.toFixed(2)) === r.r) tally.same++;
    out.push({
      model: r.model, sym, t: r.enteredAt, r: r.r, stopPct: r.stopPct ?? NaN, bars: Math.round(((r.closedAt ?? r.enteredAt) - r.enteredAt) / DAY),
      rand: randomDirectionTwins(c, s.atr, sym, j, stop, s.d, spec, SEEDS),
      rtime: randomTimeTwins(c, s.atr, sym, j, stop, s.d, spec, Math.round((SPAN_DAYS * DAY) / s.bar), SEEDS),
    });
  }
  return out;
}

function report(title: string, rows: ReadonlyArray<Row>, tally: Tally, cut: number, both: ReadonlyArray<Both> = [], single = false): string[] {
  const label = (m: RsiModelId) => single ? `${RSI_MODELS[m].label} (${SIGNAL_EXITS[m]!.exit.spec.name}, no time limit)`
    : `${RSI_MODELS[m].label} (exit ${(LIVE_VARIANT[m] ?? 0) === 0 ? 'A' : 'B'}: ${LIVE_EXITS[m][LIVE_VARIANT[m] ?? 0].spec.name})`;
  const out = [
    title,
    'Baselines (20 seeds each): "random" = the same entry in a random direction (the old check); "random time" = the same side entered at a random bar in the 60 days after the entry, same stop % and exit; timing edge = R minus its own random-time twins (t value; before / after the cut).',
    `Re-simulated trades matching the live rows: ${tally.same} of ${tally.rows}.`,
    '', STATS_HEAD,
  ];
  if (!rows.length) return [...out, '  no trades'];
  out.push(timingLine('  ALL live models'.padEnd(84), rows, cut));
  const models = [...new Set(rows.map((x) => x.model))].sort((a, b) => Object.keys(RSI_MODELS).indexOf(a) - Object.keys(RSI_MODELS).indexOf(b));
  for (const m of models) out.push(timingLine(`    ${label(m)}`.slice(0, 84).padEnd(84), rows.filter((x) => x.model === m), cut));
  const thin = rows.filter((x) => THIN_MODELS.has(x.model));
  if (thin.length && thin.length < rows.length) out.push(timingLine('  ALL, models live on coins under $0.5M'.padEnd(84), thin, cut));
  if (both.length) {
    out.push('', 'BOTH EXIT VERSIONS PER MODEL (rule set option 1, no baselines; the rule for a volume band: avg R > 0 on both exits)', STATS_HEAD);
    const ms = [...new Set(both.map((x) => x.model))].sort((a, b) => Object.keys(RSI_MODELS).indexOf(a) - Object.keys(RSI_MODELS).indexOf(b));
    for (const m of ms) for (const v of [0, 1] as const) {
      const g = both.filter((x) => x.model === m && x.variant === v);
      if (g.length) out.push(statsLine(`    ${RSI_MODELS[m].label}, exit ${v === 0 ? 'A' : 'B'}: ${LIVE_EXITS[m][v].spec.name}`.slice(0, 84).padEnd(84), g, cut));
    }
  }
  return out;
}

/**
 * The framework models (daily / weekly / 4H) on their live exits, with the timing check. Needs 1d + 4h. `skip` = coins
 * loaded only as a reference (BTC on fresh coin sets, for the shorts' BTC filter): their trades do not count. `single`
 * (2026-10-09, --signal-exits) = the bot's signals since then: option 1 and each model's one exit, no time limit.
 */
export function liveCheckReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set(), single = false): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], rows: Row[] = [], both: Both[] = [], tally: Tally = { rows: 0, same: 0 };
  let used = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [];
    if (d1.length < 300 || skip.has(sym)) continue;
    used++;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = (data[sym]?.candles['4h'] ?? []).filter((b) => b.openTime + 4 * 3_600_000 <= now);
    const live = rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc, { live: single });
    rows.push(...timedRows(sym, live, frameworkSetups(d1, h4), from, tally, single));
    if (!single) both.push(...bothOf(sym, live, from));
  }
  const what = single ? 'each model on its one exit, no time limit' : 'each model on its live exit';
  return report(`LIVE MODELS, TIMING CHECK (live code; rule set option 1; ${what}): ${day(from)} to now, ${used} coins. Older / newer = before / after ${day(cut)}.`, rows, tally, cut, both, single);
}

/** 15M-RSI10 on its live rules and exit A, with the timing check. Needs 15m, 1h, 4h and 1d. `skip` as liveCheckReport. */
export function rsi10LiveCheckReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number, skip: ReadonlySet<string> = new Set()): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], rows: Row[] = [], tally: Tally = { rows: 0, same: 0 };
  let used = 0;
  for (const sym of symbols) {
    const g = (tf: string) => data[sym]?.candles[tf] ?? [], d1 = g('1d');
    if (d1.length < 100 || skip.has(sym)) continue;
    const now = d1[d1.length - 1]!.openTime + DAY, closed = (tf: string, len: number) => g(tf).filter((b) => b.openTime + len <= now);
    const m15 = closed('15m', 15 * 60_000), h1 = closed('1h', 3_600_000), h4 = closed('4h', 4 * 3_600_000);
    if (m15.length < 2000) continue;
    used++;
    const setups = rsi10LiveSetups(m15, h1, h4, d1, Math.max(from, m15[0]!.openTime + 30 * DAY));
    rows.push(...timedRows(sym, rowsFromSetups(sym, setups, d1, now, 100_000, btc), setups, from, tally));
  }
  return report(`15M-RSI10, TIMING CHECK (live code; exit A): ${day(from)} to now (the 15m history), ${used} coins. Older / newer = before / after ${day(cut)}.`, rows, tally, cut);
}
