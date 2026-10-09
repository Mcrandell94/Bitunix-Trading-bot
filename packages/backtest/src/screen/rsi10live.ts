// 15M-RSI10 as a live model (owner 2026-10-06: "add it with the rest for live and signals"). The setup is the research
// pick from docs/RESULTS.md "15M-RSI10" round 8: the core rules with the 4H turn-up (rsi10.ts windowOk 'core'), a window
// of up to 12 days, and the entry range (lowest low of the last 24 h up to the entry) touching a bullish 4H or daily order
// block. Stop: the window's lowest low - 1 x 4H ATR. Exits (LIVE_EXITS): A = 10R target, B = 5R target, no time stop.
// Rows come from the same builder as the other RSI models (rowsFromSetups), so the dashboard, the live executor and the
// Telegram alerts treat it like them; each row lists the zones that supported it ("bullish order block 4H").
// A signal on the last closed 15m bar is reported as 'enter' (enter at the next 15m open).

import type { Candle } from '@bot/marketdata';
import { atrWilder } from '../indicators';
import { lowIn, makeCoin, rsi10Signals, zoneHits } from './rsi10';
import { rowsFromSetups, type RowOpts, type RsiSignalRow, type Setup } from './rsisignals';

const M15 = 15 * 60_000, DAY = 86_400_000;
export const RSI10_LIVE = { days: 12, zones: ['order block 4H', 'order block 1D'] as const, lookbackDays: 120 };

/** Setups for one coin from closed 15m, 1h, 4H and daily candles (oldest first). */
export function rsi10LiveSetups(m15: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, d1: ReadonlyArray<Candle>, from: number): Setup[] {
  if (m15.length < 1500 || h1.length < 200 || h4.length < 300 || d1.length < 100) return [];
  const c = makeCoin('live', m15, h1, h4, d1), support = new Map<number, string[]>();
  const sigs = rsi10Signals(c, 'core', from, (_t0, t, entry) => {
    const hits = zoneHits(c, t, lowIn(c.m15, t - DAY, t).px, entry, RSI10_LIVE.zones);
    if (hits.length) support.set(t, hits);
    return hits.length > 0;
  }, { days: RSI10_LIVE.days, pending: true });
  if (!sigs.length) return [];
  const atr = atrWilder(m15, 14);
  return sigs.map((s) => ({
    model: '15m-rsi10', d: 1, known: s.t, c: m15, atr, j: s.j, stop: s.low - s.atr4h, cap: 0, exit: 'hold', waitUntil: null, bar: M15,
    support: (support.get(s.t) ?? []).map((x) => `bullish ${x}`),
  }));
}

/** Live rows for one coin (both rule sets; signals in the last `lookbackDays`), as rsiFrameworkSignals does for the rest. */
export function rsi10LiveSignals(symbol: string, d1: ReadonlyArray<Candle>, h4: ReadonlyArray<Candle>, h1: ReadonlyArray<Candle>, m15: ReadonlyArray<Candle>, now: number, keepDays = 14, btcD1: ReadonlyArray<Candle> = [], opts: RowOpts = {}): RsiSignalRow[] {
  return rowsFromSetups(symbol, rsi10LiveSetups(m15, h1, h4, d1, now - RSI10_LIVE.lookbackDays * DAY), d1, now, keepDays, btcD1, opts);
}
