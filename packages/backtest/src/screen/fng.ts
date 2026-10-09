// Crypto Fear & Greed index as a factor on the live RSI models (owner 2026-10-05: "test fear and greed as a factor for
// the trade models just to get an idea of how it affects them"). Research only, descriptive: no line is picked.
// Index: alternative.me daily values (0 = extreme fear, 100 = extreme greed) since Feb 2018. At an entry the value used is
// the last one whose day had fully ended (timestamp + 1 day <= entry), so nothing from the entry day leaks in.
// Trades: rsiFrameworkSignals, rule set option 1, each model's live exit (as liverobust.ts).
// Buckets fixed before the run: extreme fear < 25, fear 25-44, neutral 45-55, greed 56-75, extreme greed > 75; and the
// 7-day change at entry (rising = higher than 7 days before, falling = lower).

import type { Candle } from '@bot/marketdata';
import { LIVE_VARIANT_OCT4 } from './liverobust';
import { RSI_MODELS, rsiFrameworkSignals, type RsiModelId } from './rsisignals';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
export interface FngPoint { t: number; v: number }

/** alternative.me `/fng/?limit=0` JSON to points, oldest first. */
export function parseFng(json: unknown): FngPoint[] {
  const rows = (json as { data?: { value: string; timestamp: string }[] })?.data ?? [];
  return rows.map((r) => ({ t: Number(r.timestamp) * 1000, v: Number(r.value) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
}

/** Index of the last value whose day had ended by t, or -1. */
export function fngIndexAt(fng: ReadonlyArray<FngPoint>, t: number): number {
  let k = -1;
  for (let lo = 0, hi = fng.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (fng[m]!.t + DAY <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

export const BUCKETS: readonly { name: string; ok: (v: number) => boolean }[] = [
  { name: 'extreme fear (<25)', ok: (v) => v < 25 },
  { name: 'fear (25-44)', ok: (v) => v >= 25 && v <= 44 },
  { name: 'neutral (45-55)', ok: (v) => v >= 45 && v <= 55 },
  { name: 'greed (56-75)', ok: (v) => v >= 56 && v <= 75 },
  { name: 'extreme greed (>75)', ok: (v) => v > 75 },
];

interface T { sym: string; t: number; r: number; model: RsiModelId; v: number; chg: number | null }
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number) => (Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(2) : '   -');

function cell(ts: T[], cut: number): string {
  if (!ts.length) return '-';
  const o = ts.filter((t) => t.t < cut).map((t) => t.r), n = ts.filter((t) => t.t >= cut).map((t) => t.r);
  return `${f(avg(ts.map((t) => t.r)))} (${ts.length}, ${Math.round((100 * ts.filter((t) => t.r > 0).length) / ts.length)}% win; ${f(avg(o))} / ${f(avg(n))})`;
}

export function fngLines(name: string, ts: T[], cut: number): string[] {
  if (!ts.length) return [`  ${name}: no trades`];
  const out = [`  ${name}: all ${cell(ts, cut)}`];
  for (const b of BUCKETS) out.push(`    ${b.name.padEnd(22)} ${cell(ts.filter((t) => b.ok(t.v)), cut)}`);
  out.push(`    ${'index rising (7d)'.padEnd(22)} ${cell(ts.filter((t) => t.chg != null && t.chg > 0), cut)}`);
  out.push(`    ${'index falling (7d)'.padEnd(22)} ${cell(ts.filter((t) => t.chg != null && t.chg < 0), cut)}`);
  return out;
}

export function fngReport(data: Data, symbols: ReadonlyArray<string>, from: number, cut: number, fng: ReadonlyArray<FngPoint>): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [];
  const ts: T[] = [];
  let noIndex = 0;
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4f = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = h4f.filter((b) => b.openTime + 4 * 3_600_000 <= now);
    for (const r of rsiFrameworkSignals(sym, d1, h4, now, 100_000, btc)) {
      if (r.enteredAt == null || r.enteredAt < from || r.r == null || !r.plans.includes('option 1') || r.variant !== (LIVE_VARIANT_OCT4[r.model] ?? 0)) continue;
      const k = fngIndexAt(fng, r.enteredAt);
      if (k < 0) { noIndex++; continue; }
      ts.push({ sym, t: r.enteredAt, r: r.r, model: r.model, v: fng[k]!.v, chg: k >= 7 ? fng[k]!.v - fng[k - 7]!.v : null });
    }
  }
  const out = [
    `FEAR & GREED AT ENTRY, LIVE MODELS (option 1, live exits): ${day(from)} to now, ${symbols.length} coins, index ${fng.length ? `${day(fng[0]!.t)} to ${day(fng[fng.length - 1]!.t)}` : 'MISSING'}; ${noIndex} trades before the index starts left out.`,
    `Each cell: avg R (trades, win %; older / newer = before / after ${day(cut)}). Descriptive only: nothing is picked or changed.`,
    '',
  ];
  out.push('  Trades by bucket: ' + BUCKETS.map((b) => `${b.name} ${ts.filter((t) => b.ok(t.v)).length}`).join(' | '), '');
  out.push(...fngLines('ALL LIVE MODELS', ts, cut), '');
  out.push(...fngLines('LONG MODELS', ts.filter((t) => RSI_MODELS[t.model].side === 'long'), cut), '');
  out.push(...fngLines('SHORT MODELS', ts.filter((t) => RSI_MODELS[t.model].side === 'short'), cut), '');
  for (const m of [...new Set(ts.map((t) => t.model))].sort()) out.push(...fngLines(RSI_MODELS[m].label, ts.filter((t) => t.model === m), cut), '');
  return out;
}
