// MACD gap filter (owner 2026-10-04: "daily shorts and longs look good when MACD is separated 10-15%"; the gap
// between the MACD line and its signal line; direction "not sure, test both"). Research only.
// Rules fixed before the run:
//  - standard MACD 12/26/9 on the daily close, read on the last daily bar closed before the entry;
//  - gap = (MACD - signal) / |MACD|, so 10% = the histogram is a tenth of the MACD line's size;
//  - "with" = the gap points the trade's way (MACD above its signal for longs, below for shorts), "against" = the
//    other way (stretched against the trade);
//  - buckets: with >= 10%, with >= 15%, with 10-15%, against >= 10%, against >= 15%, against 10-15%, under 10% either way;
//  - trades: the live code (rsiFrameworkSignals), option 1, exit A, as the bot trades them.

import type { Candle } from '@bot/marketdata';
import { macdLines } from '../indicators';
import { macdGap, RSI_MODELS, rsiFrameworkSignals, type RsiSignalRow } from './rsisignals';

export { macdLines } from '../indicators';
export { macdGap } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;

export function macdGapReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [];
  const trades: (SignalTrade & { row: RsiSignalRow; gap: number | null })[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY;
    const { line, sig } = macdLines(d1.map((b) => b.close));
    for (const r of rsiFrameworkSignals(sym, d1, h4.filter((b) => b.openTime + 4 * 3_600_000 <= now), now, 100_000, btc)) {
      if (r.enteredAt == null || r.enteredAt < from || r.r == null || r.variant !== 0 || !r.plans.includes('option 1')) continue;
      let k = -1;
      for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= r.enteredAt) { k = m; lo = m + 1; } else hi = m - 1; }
      const gap = k < 0 ? null : macdGap(line[k] ?? null, sig[k] ?? null, r.side === 'long' ? 1 : -1);
      trades.push({ sym, t: r.enteredAt, r: r.r, stopPct: r.stopPct ?? NaN, bars: Math.round(((r.closedAt ?? r.enteredAt) - r.enteredAt) / DAY), row: r, gap });
    }
  }
  const HEAD = '  group / filter                                                                         n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`MACD GAP (12/26/9 daily, (MACD - signal) / |MACD|, the trade's way), live models, option 1, exit A: ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`, HEAD];
  const buckets: [string, (g: number) => boolean][] = [
    ['with the trade >= 10%', (g) => g >= 0.1], ['with the trade >= 15%', (g) => g >= 0.15], ['with the trade 10-15%', (g) => g >= 0.1 && g <= 0.15],
    ['against the trade >= 10%', (g) => g <= -0.1], ['against the trade >= 15%', (g) => g <= -0.15], ['against the trade 10-15%', (g) => g <= -0.1 && g >= -0.15],
    ['under 10% either way', (g) => Math.abs(g) < 0.1],
    // Owner 2026-10-04: re-attempt at 5-10%.
    ['with the trade 5-10%', (g) => g >= 0.05 && g < 0.1], ['against the trade 5-10%', (g) => g <= -0.05 && g > -0.1],
    ['under 5% either way', (g) => Math.abs(g) < 0.05],
  ];
  const block = (name: string, ts: typeof trades) => {
    if (!ts.length) return;
    out.push('', statsLine(`  ${name}: all`.padEnd(84), ts, cut));
    for (const [label, ok] of buckets) out.push(statsLine(`    ${label}`.padEnd(84), ts.filter((x) => x.gap != null && ok(x.gap)), cut));
    const xs = ts.filter((x) => x.gap != null).sort((a, b) => a.gap! - b.gap!);
    if (xs.length >= 12) {
      const parts = [0, 1, 2, 3].map((q) => xs.slice(Math.floor((q * xs.length) / 4), Math.floor(((q + 1) * xs.length) / 4)));
      const avg = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
      out.push('    by gap quartile: ' + parts.map((p, q) => `Q${q + 1} ${(100 * p[0]!.gap!).toFixed(0)}% to ${(100 * p[p.length - 1]!.gap!).toFixed(0)}%: ${p.length}, avg R ${avg(p.map((x) => x.r)).toFixed(2)}, ${((100 * p.filter((x) => x.r > 0).length) / p.length).toFixed(0)}% wins`).join(' | '));
    }
  };
  block('ALL LIVE MODELS', trades);
  block('LONGS', trades.filter((x) => x.row.side === 'long'));
  block('SHORTS', trades.filter((x) => x.row.side === 'short'));
  block('DAILY MODELS', trades.filter((x) => RSI_MODELS[x.row.model].tf === 'daily'));
  for (const m of [...new Set(trades.map((x) => x.row.model))]) block(RSI_MODELS[m].label, trades.filter((x) => x.row.model === m));
  return out;
}
