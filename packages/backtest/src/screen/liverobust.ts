// Robustness of the live RSI models (owner 2026-10-05, after the 1h divergence failed its out-of-time check: apply the
// same scrutiny to the live book). Research only. The live models were tuned on the whole history, so there is no unseen
// period; instead, fixed before the run:
//  - by year: avg R, total R and trades per calendar year; how many years are positive; the best year's share of total R;
//  - BTC trend at entry: BTC's last closed daily close above vs below its 200-day SMA;
//  - coin concentration: top-5 coins' share of total R, and the model without its 3 best coins.
// Trades: rsiFrameworkSignals, rule set option 1, each model's live exit (B for the daily bottom and triple divergences,
// A for the rest; packages/worker/src/rsiLive.ts OPTIMAL_RSI_LIVE).

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { RSI_MODELS, rsiFrameworkSignals, type RsiModelId } from './rsisignals';
import { lastClosed } from './scalp2';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
/** The live exit versions when this report and fng.ts ran (2026-10-04/05: bottom divergence B); today's are LIVE_VARIANT in rsisignals.ts. */
export const LIVE_VARIANT_OCT4: Partial<Record<RsiModelId, 0 | 1>> = { 'bottom-div': 1, 'triple-div': 1 };

interface T { sym: string; t: number; r: number; model: RsiModelId; btcUp: boolean | null }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const f = (x: number, n = 2) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(n) : '-');

/** One block of robustness lines for a set of trades. */
export function robustLines(name: string, ts: T[]): string[] {
  if (!ts.length) return [`  ${name}: no trades`];
  const total = sum(ts.map((t) => t.r));
  const years = [...new Set(ts.map((t) => new Date(t.t).getUTCFullYear()))].sort();
  const byYear = years.map((y) => { const ys = ts.filter((t) => new Date(t.t).getUTCFullYear() === y).map((t) => t.r); return { y, n: ys.length, a: avg(ys), s: sum(ys) }; });
  const best = byYear.reduce((a, b) => (b.s > a.s ? b : a));
  const bySym = new Map<string, number>();
  for (const t of ts) bySym.set(t.sym, (bySym.get(t.sym) ?? 0) + t.r);
  const ranked = [...bySym.entries()].sort((a, b) => b[1] - a[1]), top3 = new Set(ranked.slice(0, 3).map((x) => x[0]));
  const rest = ts.filter((t) => !top3.has(t.sym)).map((t) => t.r);
  const up = ts.filter((t) => t.btcUp === true).map((t) => t.r), down = ts.filter((t) => t.btcUp === false).map((t) => t.r);
  return [
    `  ${name}: ${ts.length} trades, avg ${f(avg(ts.map((t) => t.r)))} R, total ${f(total, 1)} R; positive years ${byYear.filter((x) => x.s > 0).length} of ${byYear.length}; best year ${best.y} = ${Math.round((100 * best.s) / Math.max(1e-9, total))}% of total`,
    `    by year: ${byYear.map((x) => `${x.y} ${f(x.a)} (${x.n}, ${f(x.s, 1)})`).join(' | ')}`,
    `    BTC above its 200-day: ${f(avg(up))} (${up.length}) | below: ${f(avg(down))} (${down.length})`,
    `    coins ${bySym.size}, positive ${ranked.filter((x) => x[1] > 0).length}; top 5 = ${Math.round((100 * sum(ranked.slice(0, 5).map((x) => x[1]))) / Math.max(1e-9, total))}% of total (${ranked.slice(0, 3).map((x) => x[0]).join(', ')} best); without the 3 best coins: ${f(avg(rest))} (${rest.length}), total ${f(sum(rest), 1)}`,
  ];
}

export function liveRobustReport(data: Data, symbols: ReadonlyArray<string>, from: number): string[] {
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], b200 = sma(btc.map((b) => b.close), 200);
  const btcUp = (t: number) => { const k = lastClosed(btc, DAY, t); return k < 0 || b200[k] == null ? null : btc[k]!.close > b200[k]!; };
  const ts: T[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4f = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = h4f.filter((b) => b.openTime + 4 * 3_600_000 <= now);
    for (const r of rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc)) {
      if (r.enteredAt == null || r.enteredAt < from || r.r == null || !r.plans.includes('option 1') || r.variant !== (LIVE_VARIANT_OCT4[r.model] ?? 0)) continue;
      ts.push({ sym, t: r.enteredAt, r: r.r, model: r.model, btcUp: btcUp(r.enteredAt) });
    }
  }
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [`LIVE MODELS, ROBUSTNESS (option 1, live exits): ${day(from)} to now, ${symbols.length} coins. Each line: avg R (trades, total R).`, ''];
  out.push(...robustLines('ALL LIVE MODELS', ts), '');
  out.push(...robustLines('LONG MODELS', ts.filter((t) => RSI_MODELS[t.model].side === 'long')), '');
  out.push(...robustLines('SHORT MODELS', ts.filter((t) => RSI_MODELS[t.model].side === 'short')), '');
  for (const m of [...new Set(ts.map((t) => t.model))].sort()) out.push(...robustLines(RSI_MODELS[m].label, ts.filter((t) => t.model === m)), '');
  return out;
}
