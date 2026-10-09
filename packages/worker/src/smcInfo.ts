// SMC zones as information on the RSI signals (owner 2026-10-09: "we won't use it as a model for now but maybe let the
// info from them be sent ... when the rsi model fires, it will send a message like 'in or on top of 4hr order block' but
// not use it for entry at all unless we can add it to a trading strategy that showed positive results across the
// board"). The LuxAlgo Smart Money Concepts port (@bot/backtest smclux.ts, the script's defaults, zones as drawn) on the
// coin's closed 4H and daily candles. For a long: the bullish order blocks and FVGs price is in, or sitting on top of
// (above the zone by at most 1 ATR(14) of that timeframe); a short mirrors (bearish zones price is in or just under).
// Information only: no entry, stop or exit uses it (backtests 2026-10-09 in docs/RESULTS.md: no edge as a signal,
// a score or a top-down model). The LuxAlgo script is CC BY-NC-SA 4.0: fine for a free group, not for a paid one.

import { atrWilder, smcLux, smcZonesBefore, type RsiSignalRow } from '@bot/backtest';
import type { Candle } from '@bot/marketdata';
import { candles } from './candleMemory';

export interface SmcNote { tf: '4H' | '1D'; kind: 'order block' | 'FVG'; where: 'in' | 'on top of' | 'just under'; bottom: number; top: number }

/** The zones of the trade's side that `price` is in or resting on, from one timeframe's closed candles. Pure. */
export function smcNotes(c: ReadonlyArray<Candle>, tf: SmcNote['tf'], side: 1 | -1, price: number): SmcNote[] {
  if (c.length < 30 || !Number.isFinite(price)) return [];
  const atr = atrWilder(c, 14)[c.length - 1] ?? NaN, out: SmcNote[] = [];
  for (const z of smcZonesBefore(smcLux(c), c.length)) {
    if (z.bias !== side) continue;
    const where: SmcNote['where'] | null = price >= z.bottom && price <= z.top ? 'in'
      : side === 1 && price > z.top && price - z.top <= atr ? 'on top of'
      : side === -1 && price < z.bottom && z.bottom - price <= atr ? 'just under' : null;
    if (where) out.push({ tf, kind: z.kind === 'fvg' ? 'FVG' : 'order block', where, bottom: z.bottom, top: z.top });
  }
  return out;
}

const num = (x: number) => Number(x.toPrecision(5)).toString();

/** The line for a signal, e.g. "in a 4H order block 2367.7–2429.7 · on top of a 1D FVG 2107.2–2222.3": inside first, 4H first, at most 3. */
export function smcLine(notes: ReadonlyArray<SmcNote>): string {
  if (!notes.length) return 'no 4H / 1D order block or FVG at the price';
  const key = (n: SmcNote) => [n.where === 'in' ? 0 : 1, n.tf === '4H' ? 0 : 1, n.kind === 'order block' ? 0 : 1];
  const sorted = [...notes].sort((a, b) => { const x = key(a), y = key(b); return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; });
  const parts: string[] = [];
  for (const n of sorted) {
    const text = `${n.where} a ${n.tf} ${n.kind} ${num(n.bottom)}–${num(n.top)}`;
    if (!parts.includes(text)) parts.push(text); // an internal and a swing order block on the same candle read the same
    if (parts.length === 3) break;
  }
  return parts.join(' · ');
}

const DAY = 86_400_000;
/** The SMC line for a signal from the candles in memory; null for a closed trade or a coin without candles. */
export function smcInfo(r: RsiSignalRow, now: number): string | null {
  if (r.status === 'closed') return null;
  const side = r.side === 'long' ? 1 : -1;
  const h4 = candles(r.symbol, '4h', now - 1100 * DAY, now), d1 = candles(r.symbol, '1d', now - 1100 * DAY, now);
  if (h4.length < 30 && d1.length < 30) return null;
  return smcLine([...smcNotes(h4, '4H', side, r.lastPrice), ...smcNotes(d1, '1D', side, r.lastPrice)]);
}
