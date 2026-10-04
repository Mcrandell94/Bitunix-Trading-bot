// MACD pre-crossover and the owner's RSI levels (owner 2026-10-04, XRP daily charts: "I think the MACD pre cross
// over is the optimal entry, not that all have a large gap before the move but always some kind of gap"; "I've marked
// some horizontal lines on RSI also to watch for patterns forming around these levels"). Research only.
// Rules fixed before the run (daily MACD 12/26/9 and daily RSI 14, read on the last daily bar closed before the
// entry; h = MACD minus its signal line; "the trade's way" = above for longs, below for shorts):
//  - pre-cross, gap closing n bars (n = 1, 2, 3): h still points against the trade and |h| has shrunk on each of the
//    last n bars (the lines converging, not crossed yet);
//  - just crossed: h points the trade's way now and pointed against it on one of the 3 bars before;
//  - with the trade, older: h has pointed the trade's way for 4+ bars;
//  - against and widening: h against the trade and |h| not shrinking;
//  - pre-cross (2 bars) split by the gap's size, |h| / |MACD| under or over 10%;
//  - RSI zone at entry by the owner's XRP levels: 18.25, 27.08, 32, 39.48, 45.68, 70.60, 77.36 (chart levels for
//    reading, not tuned values; applied to every coin as a description only).
// Trades: the live code (rsiFrameworkSignals), option 1, exit A, as the bot trades them.

import type { Candle } from '@bot/marketdata';
import { macdLines, rsi } from '../indicators';
import { macdDivergence, macdState } from './macdstate';
import { RSI_MODELS, rsiFrameworkSignals, type RsiSignalRow } from './rsisignals';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
export const OWNER_RSI_LEVELS = [18.25, 27.08, 32, 39.48, 45.68, 70.6, 77.36] as const;

export { macdState } from './macdstate';

export function macdPreCrossReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [];
  type T = SignalTrade & { row: RsiSignalRow; st: ReturnType<typeof macdState>; gap: number | null; rsiNow: number | null; div: boolean };
  const trades: T[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY;
    const closes = d1.map((b) => b.close), { line, sig } = macdLines(closes), r14 = rsi(closes, 14);
    const h = line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i]!));
    for (const r of rsiFrameworkSignals(sym, d1, h4.filter((b) => b.openTime + 4 * 3_600_000 <= now), now, 100_000, btc)) {
      if (r.enteredAt == null || r.enteredAt < from || r.r == null || r.variant !== 0 || !r.plans.includes('option 1')) continue;
      let k = -1;
      for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= r.enteredAt) { k = m; lo = m + 1; } else hi = m - 1; }
      if (k < 0) continue;
      const d = r.side === 'long' ? 1 : -1;
      const gap = line[k] && h[k] != null ? Math.abs(h[k]!) / Math.abs(line[k]!) : null;
      trades.push({ sym, t: r.enteredAt, r: r.r, stopPct: r.stopPct ?? NaN, bars: Math.round(((r.closedAt ?? r.enteredAt) - r.enteredAt) / DAY), row: r, st: macdState(h, k, d), gap, rsiNow: r14[k] ?? null, div: macdDivergence(d1, line, k, d) });
    }
  }
  const HEAD = '  group / filter                                                                         n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`MACD PRE-CROSS AND RSI ZONES (daily MACD 12/26/9, daily RSI 14 at entry), live models, option 1, exit A: ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`, HEAD];
  const L = OWNER_RSI_LEVELS;
  const zones: [string, (x: number) => boolean][] = [
    [`RSI under ${L[1]}`, (x) => x < L[1]], [`RSI ${L[1]}-${L[2]}`, (x) => x >= L[1] && x < L[2]], [`RSI ${L[2]}-${L[3]}`, (x) => x >= L[2] && x < L[3]],
    [`RSI ${L[3]}-${L[4]}`, (x) => x >= L[3] && x < L[4]], [`RSI ${L[4]}-${L[5]}`, (x) => x >= L[4] && x < L[5]],
    [`RSI ${L[5]}-${L[6]}`, (x) => x >= L[5] && x < L[6]], [`RSI ${L[6]} and over`, (x) => x >= L[6]],
  ];
  const block = (name: string, ts: T[]) => {
    if (!ts.length) return;
    out.push('', statsLine(`  ${name}: all`.padEnd(84), ts, cut));
    const f = (label: string, ok: (x: T) => boolean) => out.push(statsLine(`    ${label}`.padEnd(84), ts.filter(ok), cut));
    for (const n of [1, 2, 3]) f(`MACD pre-cross, gap closing ${n}+ bar${n > 1 ? 's' : ''}`, (x) => x.st?.state === 'pre-cross' && x.st.shrinking >= n);
    f('MACD pre-cross 2+ bars, gap under 10%', (x) => x.st?.state === 'pre-cross' && x.st.shrinking >= 2 && x.gap != null && x.gap < 0.1);
    f('MACD pre-cross 2+ bars, gap 10% or more', (x) => x.st?.state === 'pre-cross' && x.st.shrinking >= 2 && x.gap != null && x.gap >= 0.1);
    f('MACD just crossed (last 3 bars)', (x) => x.st?.state === 'just crossed');
    f('MACD with the trade, older cross', (x) => x.st?.state === 'with, older');
    f('MACD against and widening', (x) => x.st?.state === 'against, widening');
    // Owner 2026-10-04: a gap at entry (before the cross, not at or after it), and MACD divergences.
    f('MACD gap still open at entry (pre-cross or widening)', (x) => x.st?.state === 'pre-cross' || x.st?.state === 'against, widening');
    f('MACD at or after the cross', (x) => x.st?.state === 'just crossed' || x.st?.state === 'with, older');
    f('MACD divergence (price vs MACD line, last 2 pivots)', (x) => x.div);
    f('no MACD divergence', (x) => !x.div);
    f('MACD divergence and pre-cross', (x) => x.div && x.st?.state === 'pre-cross');
    f('MACD divergence and gap still open', (x) => x.div && (x.st?.state === 'pre-cross' || x.st?.state === 'against, widening'));
    for (const [label, ok] of zones) f(label, (x) => x.rsiNow != null && ok(x.rsiNow));
  };
  block('ALL LIVE MODELS', trades);
  block('LONGS', trades.filter((x) => x.row.side === 'long'));
  block('SHORTS', trades.filter((x) => x.row.side === 'short'));
  block('DAILY MODELS', trades.filter((x) => RSI_MODELS[x.row.model].tf === 'daily'));
  for (const m of [...new Set(trades.map((x) => x.row.model))]) block(RSI_MODELS[m].label, trades.filter((x) => x.row.model === m));
  return out;
}
