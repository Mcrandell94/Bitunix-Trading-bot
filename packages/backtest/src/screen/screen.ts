// Signal screen (owner, 2026-09-27: "remove the indicators that are failing
// us and find things that backtest positive; no ~50% win-rate models").
//
// Every signal in signals.ts, on 15m / 1H / 4H / daily, with three exit
// profiles, as-is and faded, through the real engine (market entry at the
// next 15m open, taker fees, slippage, funding, the 0.667% cost veto).
//
// A candidate passes only if, on the discovery window (first 24 of the 36
// research months) AND again on the confirmation window (last 12):
//   - net expectancy > 0 after costs,
//   - win rate >= --min-win (default 60%),
//   - it beats the same entries with a random direction (500 draws; 99th
//     percentile on discovery since ~400 candidates are screened, 90th on
//     confirmation),
//   - enough trades (100 discovery, 30 confirmation), and positive in at
//     least 5 of 8 discovery quarters.
// The random-direction test matters most here: a high win rate is easy to
// get from exits alone (a target closer than the stop), and only beating
// random direction shows the signal adds anything. The 6-month holdout is
// never loaded.
//
//   npm run -s screen -- --months 36 --extras 60 --min-volume 3000000 --min-win 0.6

import { writeFileSync } from 'node:fs';
import { intervalMs } from '@bot/marketdata';
import type { Side } from '@bot/risk';
import { researchWindow } from '../baseline';
import { runBacktest, type CandidateOverride } from '../engine';
import { atrWilder } from '../indicators';
import { appendRunLog, gitHash, profitFactor, type RunLogRow } from '../runlog';
import type { ScoreConfig } from '../score/config';
import { defaultConfig, type BacktestConfig, type SymbolData, type Tf } from '../types';
import { addMonths } from '../walkforward';
import { contextFor, SIGNALS, type FibLevels, type SignalDef } from './signals';

export interface ExitProfile {
  id: string; what: string; stopAtr: number; targetAtr: number; maxBars: number;
  /** ATR trailing stop (owner's ATR layer): once `activateAtr` ATR in profit, trail `mult` x ATR(14) behind the best price, on the signal's timeframe closes. */
  trail?: { activateAtr: number; mult: number };
  /** Hybrid exit: take `fraction` of the position at `atAtr` ATR, then move the stop to entry (the rest rides the trail or the cap). */
  partial?: { atAtr: number; fraction: number };
  /**
   * Exit in R (1R = the stop distance), for signals that set their own stop
   * (SignalDef.stop; else stopAtr x ATR): take `fraction` at `partialR`, stop
   * to entry at `beR`, trail `trailAtr` x ATR from `trailFromR`, cap at `capR`.
   */
  r?: { partialR: number; fraction: number; beR: number; trailFromR: number; trailAtr: number; capR: number;
    /** Optional second target (owner 2026-09-28): take `fraction` of the starting size at `atR`. */
    partial2?: { atR: number; fraction: number };
    /** Fee-aware breakeven: at +beR move the stop to entry + beToR R (not flat entry). */
    beToR?: number;
    /** Time stop only without follow-through: out after maxBars (profile) if the best excursion stayed under minMfeR; hard cap at capBars. */
    mfeGate?: { minMfeR: number; capBars: number } };
  /** Maker entry: a resting limit at the signal close for this many bars of the timeframe (else market at the next open). */
  makerBars?: number;
  /**
   * Entry price tests (owner, 2026-09-28): a resting limit `atr` ATRs better
   * than the signal close for `bars` bars (unfilled = no trade). keepStop: the
   * stop stays at the signal's price (tighter R, bigger size); else it moves
   * with the entry (same distance).
   */
  limit?: { atr: number; bars: number; keepStop: boolean };
  /** Stop distance x this (size shrinks to keep the same risk; R targets scale with it). */
  stopWiden?: number;
  /** Exit what is left when EMA(fast) closes on the wrong side of EMA(slow) on the signal timeframe (optionally only after +afterR). */
  emaExit?: { fast: number; slow: number; afterR?: number };
  /**
   * S/R channel bot (owner 2026-10-02), with signals that set a target (SignalDef.target):
   * 'full' = the whole position exits at the target (none: the R cap); 'half' = 50% there and the stop to
   * entry + 0.2R (none: at 1.6R), the rest rides the exit's trail.
   */
  channelTarget?: 'full' | 'half';
  /** Exit at market when a close goes back through the signal's invalidation level (SignalDef.invalidate). */
  channelExit?: boolean;
  /**
   * Fib pullback exits (owner 2026-10-03), with signals that set Fib levels (SignalDef.fib): `split[0]` of the
   * position at TP1 (0.382) and `split[1]` at TP2 (0.236), the stop to entry + 0.1R once TP1 fills, then the rest
   * trails ('atr' = the exit's r.trailAtr x ATR; 'swing' = under each new swing) until the 1.272 target.
   * The entry is a resting limit for 30 bars, cancelled if price trades past the swing (new high) or closes beyond the stop's swing.
   */
  fibExit?: {
    split: [number, number]; trail: 'atr' | 'swing'; late?: boolean;
    /** Round 4 (lower-timeframe trigger): market entry, no pending cancels. */
    market?: boolean;
    /** Trail (and time out) on the parent timeframe (15m -> 1h, 1h -> 4h), not the trigger timeframe. */
    trailParent?: boolean;
    /** Fixed-R variant: `fraction` off at `tp` R, stop to entry+0.1R, the rest trails (no Fib targets). */
    r?: { tp: number; fraction: number };
  };
}

export const EXITS: ExitProfile[] = [
  { id: 'hiwin', what: 'stop 2 ATR, target 1 ATR (0.5R), out after 24 bars', stopAtr: 2, targetAtr: 1, maxBars: 24 },
  { id: 'even', what: 'stop 1.5 ATR, target 1.5 ATR (1R), out after 24 bars', stopAtr: 1.5, targetAtr: 1.5, maxBars: 24 },
  { id: 'trend', what: 'stop 1.5 ATR, target 4.5 ATR (3R), out after 72 bars', stopAtr: 1.5, targetAtr: 4.5, maxBars: 72 },
];

/** The owner's 1H payoff spec (2026-09-27): first cash-out beyond the stop. */
export const R_SPEC_EXITS: ExitProfile[] = [
  // Owner's round 2 (2026-09-27): first scale nearer, fee-aware breakeven, shorter time stop.
  { id: 'r3_1h', what: 'structure stop (1.0-1.6 ATR); 50% off at 1.4R, stop to entry+0.25R at +1R, rest trails 1.8 ATR from +1.4R; cap 6R; out after 15 bars', stopAtr: 1.6, targetAtr: 0, maxBars: 15, r: { partialR: 1.4, fraction: 0.5, beR: 1, beToR: 0.25, trailFromR: 1.4, trailAtr: 1.8, capR: 6 } },
  { id: 'r4h', what: 'structure stop (1.0-2.0 ATR); 50% off at 1.6R, stop to entry+0.2R at +1R, rest trails 2.0 ATR from +1.6R; cap 6R; out after 14 bars', stopAtr: 2, targetAtr: 0, maxBars: 14, r: { partialR: 1.6, fraction: 0.5, beR: 1, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6 } },
  // Owner's round 3: stop moves only once the first target has filled (no overlap band), time stop only without follow-through, maker entry.
  { id: 'r5_1h', what: 'maker entry at the close (1 bar); 50% off at 1.4R, then stop to entry+0.25R; trail 1.8 ATR from 1.4R; out at 15 bars only if it never reached +0.5R (hard cap 45); cap 6R', stopAtr: 1.6, targetAtr: 0, maxBars: 15, makerBars: 1, r: { partialR: 1.4, fraction: 0.5, beR: 1.4, beToR: 0.25, trailFromR: 1.4, trailAtr: 1.8, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 45 } } },
  { id: 'r5_4h', what: 'maker entry at the close (1 bar); 50% off at 1.6R, then stop to entry+0.2R; trail 2.0 ATR from 1.6R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  // Owner 2026-09-28, entry price / stop width tests on the r5_4h plan.
  ...[
    ['lim03', 'limit 0.3 ATR better, 2 bars, stop kept', { limit: { atr: 0.3, bars: 2, keepStop: true } }],
    ['lim05', 'limit 0.5 ATR better, 2 bars, stop kept', { limit: { atr: 0.5, bars: 2, keepStop: true } }],
    ['lim05m', 'limit 0.5 ATR better, 2 bars, stop moved with it', { limit: { atr: 0.5, bars: 2, keepStop: false } }],
    ['w125', 'stop 1.25x wider, same risk', { stopWiden: 1.25 }],
    ['w15', 'stop 1.5x wider, same risk', { stopWiden: 1.5 }],
  ].map(([k, what, o]) => ({ id: `r5_4h_${k}`, what: `r5_4h + ${what}`, stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } }, ...(o as object) }) as ExitProfile),
  // Owner 2026-09-29, EMA-crossover bot: exits on the fast EMA crossing back through EMA 11-13 (owner's plan), or a hybrid.
  // xe_*: no fixed target (cap 20R), stop from the signal; out when EMA fast closes beyond EMA slow against the trade, or after 500 bars.
  ...([
    ['xe_5_12', 'exit when EMA 5 closes back through EMA 12 (owner plan)', { fast: 5, slow: 12 }, null],
    ['xe_5_20', 'exit when EMA 5 closes back through EMA 20 (the reverse cross)', { fast: 5, slow: 20 }, null],
    ['xe_c11', 'exit when a candle closes back through EMA 11 (EMA 11 as a trailing line)', { fast: 1, slow: 11 }, null],
    ['xe_c12', 'exit when a candle closes back through EMA 12 (EMA 12 as a trailing line)', { fast: 1, slow: 12 }, null],
    ['xe_c13', 'exit when a candle closes back through EMA 13 (EMA 13 as a trailing line)', { fast: 1, slow: 13 }, null],
    ['xe_h5_12', '50% off at 1.6R, stop to entry+0.2R, rest exits when EMA 5 closes back through EMA 12', { fast: 5, slow: 12 }, 1.6],
  ] as const).map(([k, what, e, part]) => ({
    id: k, what, stopAtr: 2, targetAtr: 0, maxBars: 500, makerBars: 1, emaExit: e,
    r: { partialR: part ?? 100, fraction: part ? 0.5 : 0, beR: part ?? 100, ...(part ? { beToR: 0.2 } : {}), trailFromR: 100, trailAtr: 100, capR: 20 },
  }) as ExitProfile),
  // Owner 2026-09-29, crossover with an ATR trail instead of the EMA exit, on the crossover's own limits (cap 20R, 500 bars, no early time stop):
  // 50% off at 1.6R, stop to entry+0.2R, the rest trails N ATR from 1.6R. xt_<N>; xt_35e also keeps the EMA 5/12 exit (whichever comes first).
  ...[2, 2.5, 3, 3.5, 4].map((t) => ({ id: `xt_${String(t).replace('.', '')}`, what: `50% at 1.6R, stop to +0.2R, trail ${t} ATR; cap 20R`, stopAtr: 2, targetAtr: 0, maxBars: 500, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: t, capR: 20 } }) as ExitProfile),
  { id: 'xt_35e', what: '50% at 1.6R, stop to +0.2R, trail 3.5 ATR or the EMA 5/12 exit, whichever first; cap 20R', stopAtr: 2, targetAtr: 0, maxBars: 500, makerBars: 1, emaExit: { fast: 5, slow: 12 }, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 3.5, capR: 20 } },
  // Owner 2026-10-02, S/R channel bot exit scenarios (the signal's channel stop; maker entry at the close).
  { id: 'sr_tp', what: 'all out at the next S/R channel (none ahead: 6R); out after 60 bars', stopAtr: 2, targetAtr: 0, maxBars: 60, makerBars: 1, channelTarget: 'full', r: { partialR: 100, fraction: 0, beR: 100, trailFromR: 100, trailAtr: 100, capR: 6 } },
  { id: 'sr_tp_be', what: 'all out at the next S/R channel (none ahead: 6R); stop to entry+0.2R at +1R; out after 60 bars', stopAtr: 2, targetAtr: 0, maxBars: 60, makerBars: 1, channelTarget: 'full', r: { partialR: 100, fraction: 0, beR: 1, beToR: 0.2, trailFromR: 100, trailAtr: 100, capR: 6 } },
  { id: 'sr_half', what: '50% at the next S/R channel (none ahead: 1.6R), then stop to entry+0.2R; the rest trails 2.5 ATR from +1R; cap 10R', stopAtr: 2, targetAtr: 0, maxBars: 500, makerBars: 1, channelTarget: 'half', r: { partialR: 100, fraction: 0, beR: 100, trailFromR: 1, trailAtr: 2.5, capR: 10 } },
  { id: 'sr_fail', what: '50% at 1.6R, stop to +0.2R, trail 3 ATR; cap 20R; out at market on a close back through the channel', stopAtr: 2, targetAtr: 0, maxBars: 500, makerBars: 1, channelExit: true, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 3, capR: 20 } },
  // Owner 2026-10-03, Fib pullback exits: TP1 0.382, TP2 0.236, then trail (ATR 2.5 or swing) to the 1.272 target.
  ...([['fx_33_atr', [1 / 3, 1 / 3], 'atr'], ['fx_33_swing', [1 / 3, 1 / 3], 'swing'], ['fx_50_atr', [0.5, 0.25], 'atr'], ['fx_50_swing', [0.5, 0.25], 'swing']] as const).map(([id, split, trail]) => ({
    id, what: `${split[0] === 0.5 ? '50/25/25' : '1/3 each'} at the 0.382 / 0.236 retracements, stop to entry+0.1R after TP1, then ${trail === 'atr' ? 'a 2.5 ATR' : 'a swing'} trail to the 1.272 extension; limit entry rests 30 bars`,
    stopAtr: 2, targetAtr: 0, maxBars: 500, fibExit: { split: [split[0], split[1]] as [number, number], trail },
    r: { partialR: 100, fraction: 0, beR: 100, trailFromR: trail === 'atr' ? 0 : 100, trailAtr: 2.5, capR: 100 },
  }) as ExitProfile),
  ...([['fx_33_atr_late', 'atr'], ['fx_33_swing_late', 'swing']] as const).map(([id, trail]) => ({
    id, what: `1/3 each at the 0.236 retracement and the swing extreme, stop to entry+0.1R after TP1, then ${trail === 'atr' ? 'a 2.5 ATR' : 'a swing'} trail to the 1.272 extension; limit entry rests 30 bars`,
    stopAtr: 2, targetAtr: 0, maxBars: 500, fibExit: { split: [1 / 3, 1 / 3] as [number, number], trail, late: true },
    r: { partialR: 100, fraction: 0, beR: 100, trailFromR: trail === 'atr' ? 0 : 100, trailAtr: 2.5, capR: 100 },
  }) as ExitProfile),
  // Owner 2026-10-03, round 4 (lower-timeframe trigger, market entry; trail and time out on the parent timeframe):
  // the Fib exits vs TP1 at 0.236 vs a fixed 1.6R / 1.8R first target with an ATR trail.
  ...([
    ['fx_33_swing_mkt', '1/3 each at 0.382 / 0.236, stop to entry+0.1R after TP1, then a parent-timeframe swing trail to the 1.272 extension', { split: [1 / 3, 1 / 3], trail: 'swing' }],
    ['fx_33_atr_mkt', '1/3 each at 0.382 / 0.236, stop to entry+0.1R after TP1, then a 2.5 ATR (parent) trail to the 1.272 extension', { split: [1 / 3, 1 / 3], trail: 'atr' }],
    ['fx_late_mkt', '1/3 each at 0.236 and the swing extreme, stop to entry+0.1R after TP1, then a 2.5 ATR (parent) trail to the 1.272 extension', { split: [1 / 3, 1 / 3], trail: 'atr', late: true }],
    ['r16_atr_mkt', '50% at 1.6R, stop to entry+0.1R, the rest trails 2.5 ATR (parent); no fixed target', { split: [0.5, 0], trail: 'atr', r: { tp: 1.6, fraction: 0.5 } }],
    ['r18_atr_mkt', '50% at 1.8R, stop to entry+0.1R, the rest trails 2.5 ATR (parent); no fixed target', { split: [0.5, 0], trail: 'atr', r: { tp: 1.8, fraction: 0.5 } }],
  ] as const).map(([id, what, f]) => ({
    id, what: `${what}; market entry`, stopAtr: 2, targetAtr: 0, maxBars: 500,
    fibExit: { ...f, split: [f.split[0], f.split[1]] as [number, number], market: true, trailParent: true },
    r: { partialR: 100, fraction: 0, beR: 100, trailFromR: f.trail === 'atr' ? 0 : 100, trailAtr: 2.5, capR: 100 },
  }) as ExitProfile),
  // Owner 2026-09-29 (LINK stopped by the trail): the ATR trail after TP1 at 2.5 / 3 / 3.5 ATR instead of 2.
  ...[2.5, 3, 3.5].map((t) => ({ id: `r5_4h_tr${String(t).replace('.', '')}`, what: `r5_4h with the trail at ${t} ATR`, stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: t, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } }) as ExitProfile),
  { id: 'r5_4h_t25', what: 'owner 2026-09-28, middle target test: maker entry at the close (1 bar); 50% off at 1.6R, 25% more at 2.5R, then stop to entry+0.2R; trail 2.0 ATR from 1.6R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, partial2: { atR: 2.5, fraction: 0.25 }, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r5_4h_t3', what: 'owner 2026-09-28, middle target test: maker entry at the close (1 bar); 50% off at 1.6R, 25% more at 3R, then stop to entry+0.2R; trail 2.0 ATR from 1.6R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, partial2: { atR: 3, fraction: 0.25 }, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r5_4h_t4', what: 'owner 2026-09-28, middle target test: maker entry at the close (1 bar); 50% off at 1.6R, 25% more at 4R, then stop to entry+0.2R; trail 2.0 ATR from 1.6R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.6, fraction: 0.5, partial2: { atR: 4, fraction: 0.25 }, beR: 1.6, beToR: 0.2, trailFromR: 1.6, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r5_4h_p15', what: 'owner 2026-09-28, TP1 test: maker entry at the close (1 bar); 50% off at 1.5R, then stop to entry+0.2R; trail 2.0 ATR from 1.5R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.5, fraction: 0.5, beR: 1.5, beToR: 0.2, trailFromR: 1.5, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r5_4h_p14', what: 'owner 2026-09-28, TP1 test: maker entry at the close (1 bar); 50% off at 1.4R, then stop to entry+0.2R; trail 2.0 ATR from 1.4R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.4, fraction: 0.5, beR: 1.4, beToR: 0.2, trailFromR: 1.4, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r5_4h_p13', what: 'owner 2026-09-28, TP1 test: maker entry at the close (1 bar); 50% off at 1.3R, then stop to entry+0.2R; trail 2.0 ATR from 1.3R; out at 14 bars only if it never reached +0.5R (hard cap 42); cap 6R', stopAtr: 2, targetAtr: 0, maxBars: 14, makerBars: 1, r: { partialR: 1.3, fraction: 0.5, beR: 1.3, beToR: 0.2, trailFromR: 1.3, trailAtr: 2, capR: 6, mfeGate: { minMfeR: 0.5, capBars: 42 } } },
  { id: 'r2', what: 'structure stop (1.0-1.8 ATR; else 2 ATR); 60% off at 2R, stop to entry at +1R, rest trails 2.2 ATR from +2R; cap 6R; out after 36 bars', stopAtr: 2, targetAtr: 0, maxBars: 36, r: { partialR: 2, fraction: 0.6, beR: 1, trailFromR: 2, trailAtr: 2.2, capR: 6 } },
];

/** The ATR trailing exits (owner's ATR layer), screened on request (--exits). */
export const TRAIL_EXITS: ExitProfile[] = [
  { id: 'hiwin_trail', what: 'stop 2 ATR; from +1 ATR trail 1.5 ATR behind the best price; cap 6 ATR; out after 72 bars', stopAtr: 2, targetAtr: 6, maxBars: 72, trail: { activateAtr: 1, mult: 1.5 } },
  { id: 'trail', what: 'stop 1.5 ATR; from +1.5 ATR (1R) trail 1.5 ATR behind the best price; cap 6 ATR; out after 72 bars', stopAtr: 1.5, targetAtr: 6, maxBars: 72, trail: { activateAtr: 1.5, mult: 1.5 } },
];

/**
 * Owner's R-raising tests (2026-09-27), one change at a time against `hiwin`
 * (2 ATR stop, 1 ATR target, 24 bars): wider targets, a hybrid exit, shorter
 * time stops.
 */
export const R_EXITS: ExitProfile[] = [
  { id: 's2t15', what: 'stop 2 ATR, target 1.5 ATR (0.75R), out after 24 bars', stopAtr: 2, targetAtr: 1.5, maxBars: 24 },
  { id: 's2t2', what: 'stop 2 ATR, target 2 ATR (1R), out after 24 bars', stopAtr: 2, targetAtr: 2, maxBars: 24 },
  { id: 's15t2', what: 'stop 1.5 ATR, target 2 ATR (1.33R), out after 24 bars', stopAtr: 1.5, targetAtr: 2, maxBars: 24 },
  { id: 'hybrid', what: 'stop 2 ATR; 60% off at 1 ATR, stop to entry, rest trails 2.5 ATR behind the best price; cap 8 ATR; out after 72 bars', stopAtr: 2, targetAtr: 8, maxBars: 72, partial: { atAtr: 1, fraction: 0.6 }, trail: { activateAtr: 1, mult: 2.5 } },
  { id: 'hybrid15', what: 'stop 2 ATR; 50% off at 1.5 ATR, stop to entry, rest trails 3 ATR behind the best price; cap 8 ATR; out after 72 bars', stopAtr: 2, targetAtr: 8, maxBars: 72, partial: { atAtr: 1.5, fraction: 0.5 }, trail: { activateAtr: 1.5, mult: 3 } },
  { id: 'hiwin_t12', what: 'stop 2 ATR, target 1 ATR, out after 12 bars', stopAtr: 2, targetAtr: 1, maxBars: 12 },
  { id: 'hiwin_t16', what: 'stop 2 ATR, target 1 ATR, out after 16 bars', stopAtr: 2, targetAtr: 1, maxBars: 16 },
];

export const ALL_EXITS: ExitProfile[] = [...EXITS, ...TRAIL_EXITS, ...R_EXITS, ...R_SPEC_EXITS];

export const SCREEN_TFS: Tf[] = ['15m', '1h', '4h', '1d'];

/** One slot (MTF) on the signal's timeframe, market entries, fixed bracket, time exit; nothing else in the way. */
export function screenConfig(base: BacktestConfig, tf: Tf, exit: ExitProfile): BacktestConfig {
  // Round-4 Fib exits manage the trade on the parent timeframe (the trigger runs one timeframe lower).
  const mgTf: Tf = exit.fibExit?.trailParent ? (({ '15m': '1h', '1h': '4h' } as Partial<Record<Tf, Tf>>)[tf] ?? tf) : tf;
  return {
    ...base,
    minStopPct: 0.10 / 0.15, // the cost veto
    portfolio: null,
    risk: {
      ...base.risk, fundingGapMinutes: 0, coreExposureCap: 1e9, maxPositionsPerSymbolTier: 1,
      tiers: { ...base.risk.tiers, MTF: { ...base.risk.tiers.MTF, riskPct: 1, dailyLossPct: 1e9, maxEffectiveLeverage: 1e9, killzones: null } },
    },
    tiers: {
      LTF: { ...base.tiers.LTF, enabled: false },
      HTF: { ...base.tiers.HTF, enabled: false },
      P4H: { ...base.tiers.P4H, enabled: false },
      P1H: { ...base.tiers.P1H, enabled: false },
      MTF: {
        ...base.tiers.MTF, enabled: true, entryTf: tf, rrgTfs: [], expiryBars: 2, rewardR: 100,
        partials: exit.r ? [{ atR: exit.r.partialR, fraction: exit.r.fraction }, ...(exit.r.partial2 ? [exit.r.partial2] : [])].filter((q) => q.fraction > 0) : exit.partial ? [{ atR: exit.partial.atAtr / exit.stopAtr, fraction: exit.partial.fraction }] : [],
        breakevenAtR: exit.r ? (exit.r.beToR != null ? null : exit.r.beR) : exit.partial ? exit.partial.atAtr / exit.stopAtr : null,
        ...(exit.r?.beToR != null ? { stopSteps: [{ atR: exit.r.beR, toR: exit.r.beToR }] } : {}),
        trailTf: exit.fibExit?.trail === 'swing' ? mgTf : null,
        timeStop: exit.r?.mfeGate
          ? { barTf: tf, checkBars: exit.maxBars, minMfeR: exit.r.mfeGate.minMfeR, maxBars: exit.r.mfeGate.capBars }
          : { barTf: mgTf, checkBars: exit.maxBars, minMfeR: -1e9, maxBars: exit.maxBars },
        ...(exit.makerBars ? { expiryBars: exit.makerBars } : {}),
        ...(exit.emaExit ? { emaExit: { tf, ...exit.emaExit } } : {}),
        ...(exit.r ? { chandelier: { activateR: exit.r.trailFromR, atrTf: mgTf, atrLen: 14, mult: exit.r.trailAtr } }
          : exit.trail ? { chandelier: { activateR: exit.trail.activateAtr / exit.stopAtr, atrTf: tf, atrLen: 14, mult: exit.trail.mult } } : {}),
      },
    },
  };
}

/** Per coin: signal events and ATR on the timeframe, indexed by bar close time. */
export interface Events { at: Map<number, number>; sig: Int8Array; close: number[]; atr: (number | null)[]; stop?: (number | null)[]; entry?: (number | null)[]; target?: (number | null)[]; invalidate?: (number | null)[]; fib?: (FibLevels | null)[]; tf?: Tf }

export function eventsFor(all: Readonly<Record<string, SymbolData>>, symbols: string[], tf: Tf, def: SignalDef, score: ScoreConfig): Map<string, Events> {
  const out = new Map<string, Events>();
  const iv = intervalMs(tf);
  for (const s of symbols) {
    const ctx = contextFor(all, s, tf, score);
    if (!ctx) continue;
    const sig = def.build(ctx);
    out.set(s, {
      at: new Map(ctx.candles.map((c, i) => [c.openTime + iv, i])), sig, close: ctx.candles.map((c) => c.close), atr: atrWilder(ctx.candles, 14),
      ...(def.stop ? { stop: def.stop(ctx, sig) } : {}),
      ...(def.entry ? { entry: def.entry(ctx, sig) } : {}),
      ...(def.target ? { target: def.target(ctx, sig) } : {}),
      ...(def.invalidate ? { invalidate: def.invalidate(ctx, sig) } : {}),
      ...(def.fib ? { fib: def.fib(ctx, sig) } : {}),
      tf,
    });
  }
  return out;
}

/** Market entries on the events; `fade` trades the other way. Tag = the signal bar's close. */
/**
 * Entry timing (owner's Asia-session idea): instead of a market entry at the
 * next open, rest a limit `atr` daily ATRs better than the signal close for
 * `minutes`; unfilled = no trade. Stop and target keep their ATR distances
 * from the limit price.
 */
export interface EntryDip { atr: number; minutes: number }

/** The bar length of an events series (from its first two close times). */
function barMs(e: Events): number {
  const it = e.at.keys();
  const a = it.next().value as number, b = it.next().value as number;
  return b - a;
}

export function eventOverride(events: Map<string, Events>, exit: ExitProfile, fade: boolean, dip: EntryDip | null = null): CandidateOverride {
  return ({ tier, symbol, time }) => {
    if (tier !== 'MTF') return null;
    const e = events.get(symbol);
    const i = e?.at.get(time);
    if (e == null || i == null) return null;
    const raw = e.sig[i]!;
    const a = e.atr[i];
    if (!raw || a == null || !(a > 0)) return null;
    const side: Side = (raw > 0) !== fade ? 'long' : 'short';
    const d = side === 'long' ? 1 : -1;
    const lim = exit.limit ?? null;
    if (e.entry && e.entry[i] == null) return null;
    const px = e.entry ? e.entry[i]! : dip ? e.close[i]! - d * dip.atr * a : lim ? e.close[i]! - d * lim.atr * a : e.close[i]!;
    const maker = !dip && exit.makerBars != null;
    // R exits: the signal's own stop distance when it sets one (null = no trade), else stopAtr x ATR.
    const base = exit.r ? (e.stop ? e.stop[i] ?? null : exit.stopAtr * a) : exit.stopAtr * a;
    if (base == null || !(base > 0)) return null;
    let dist = base * (exit.stopWiden ?? 1);
    if (lim?.keepStop) dist = base - lim.atr * a; // stop stays at the signal's price
    if (!(dist > 0.3 * a)) return null;
    const fl = exit.fibExit ? e.fib?.[i] ?? null : null;
    if (exit.fibExit) {
      if (!fl) return null;
      const rOf = (p: number) => Math.abs(p - px) / dist;
      const fx = exit.fibExit;
      if (fx.market) {
        return {
          side, entry: px, stop: px - d * dist, source: 'core', tag: time, market: true,
          ...(fx.r
            ? { takeProfit: px + d * 100 * dist, trailAfter: 1, partials: [{ atR: fx.r.tp, fraction: fx.r.fraction }], stopSteps: [{ atR: fx.r.tp, toR: 0.1 }] }
            : {
              takeProfit: fl.final, trailAfter: 2,
              partials: fx.late
                ? [{ atR: rOf(fl.tp2), fraction: fx.split[0] }, { atR: rOf(fl.cancelIfTouched), fraction: fx.split[1] }]
                : [{ atR: rOf(fl.tp1), fraction: fx.split[0] }, { atR: rOf(fl.tp2), fraction: fx.split[1] }],
              stopSteps: [{ atR: rOf(fx.late ? fl.tp2 : fl.tp1), toR: 0.1 }],
            }),
        };
      }
      return {
        side, entry: px, stop: px - d * dist, source: 'core', tag: time, market: false, expiresInMs: 30 * barMs(e),
        takeProfit: fl.final, trailAfter: 2, cancelIfTouched: fl.cancelIfTouched, cancelOnClose: fl.cancelOnClose,
        // Late (owner R:R round 2): TP1 at the 0.236 level, TP2 at the swing extreme.
        partials: exit.fibExit.late
          ? [{ atR: rOf(fl.tp2), fraction: exit.fibExit.split[0] }, { atR: rOf(fl.cancelIfTouched), fraction: exit.fibExit.split[1] }]
          : [{ atR: rOf(fl.tp1), fraction: exit.fibExit.split[0] }, { atR: rOf(fl.tp2), fraction: exit.fibExit.split[1] }],
        stopSteps: [{ atR: rOf(exit.fibExit.late ? fl.tp2 : fl.tp1), toR: 0.1 }],
      };
    }
    const tgt = exit.channelTarget ? e.target?.[i] ?? null : null;
    const tgtR = tgt != null ? Math.abs(tgt - px) / dist : null;
    const chan = exit.channelTarget === 'half'
      ? { partials: [{ atR: tgtR ?? 1.6, fraction: 0.5 }], stopSteps: [{ atR: tgtR ?? 1.6, toR: 0.2 }] } : {};
    const inv = exit.channelExit && e.invalidate?.[i] != null && e.tf ? { invalidateClose: { level: e.invalidate[i]!, tf: e.tf } } : {};
    return {
      side, entry: px, stop: px - d * dist, source: 'core', tag: time, ...chan, ...inv,
      takeProfit: exit.channelTarget === 'full' && tgt != null ? tgt : px + d * (exit.r ? exit.r.capR * dist : exit.targetAtr * a),
      ...(dip ? { market: false, expiresInMs: dip.minutes * 60_000 } : lim ? { market: false, expiresInMs: lim.bars * barMs(e) } : maker ? { market: false } : { market: true }),
    };
  };
}

export interface Lite { key: string; openedAt: number; side: Side; r: number }

export interface WindowStats {
  n: number; winRate: number | null; expectancyR: number | null; profitFactor: number | null; totalR: number;
  quartersPositive: number; quarters: number; longN: number; shortN: number;
  /** Where the real expectancy sits among random-direction draws of the same entries (0..1), and on how many paired entries. */
  nullPctile: number | null; paired: number;
  /** Average win / average loss (owner's W/L check). */
  payoff?: number | null;
  /** Average R of the longs and of the shorts (survivorship check: today's coin list flatters longs). */
  longExp?: number | null; shortExp?: number | null;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function windowStats(trades: Lite[], other: Map<string, number>, [a, b]: [number, number], runs: number, seed = 5): WindowStats {
  const w = trades.filter((t) => t.openedAt >= a && t.openedAt < b);
  const n = w.length;
  const totalR = w.reduce((s, t) => s + t.r, 0);
  const quarters: number[] = [];
  for (let q = a; q < b; q = addMonths(q, 3)) {
    const end = Math.min(addMonths(q, 3), b);
    quarters.push(w.filter((t) => t.openedAt >= q && t.openedAt < end).reduce((s, t) => s + t.r, 0));
  }
  const pairs = w.flatMap((t) => { const o = other.get(t.key); return o == null ? [] : [[t.r, o] as const]; });
  let nullPctile: number | null = null;
  if (pairs.length >= 10) {
    const real = pairs.reduce((s, p) => s + p[0], 0);
    const rand = rng(seed);
    let below = 0;
    for (let k = 0; k < runs; k++) {
      let x = 0;
      for (const p of pairs) x += rand() < 0.5 ? p[0] : p[1];
      if (x < real) below++;
    }
    nullPctile = below / runs;
  }
  return {
    n, winRate: n ? w.filter((t) => t.r > 0).length / n : null, expectancyR: n ? totalR / n : null, profitFactor: profitFactor(w), totalR,
    quartersPositive: quarters.filter((x) => x > 0).length, quarters: quarters.length,
    longN: w.filter((t) => t.side === 'long').length, shortN: w.filter((t) => t.side === 'short').length,
    nullPctile, paired: pairs.length,
    longExp: (() => { const l = w.filter((t) => t.side === 'long'); return l.length ? l.reduce((a, t) => a + t.r, 0) / l.length : null; })(),
    shortExp: (() => { const l = w.filter((t) => t.side === 'short'); return l.length ? l.reduce((a, t) => a + t.r, 0) / l.length : null; })(),
    payoff: (() => {
      const wins = w.filter((t) => t.r > 0), losses = w.filter((t) => t.r <= 0);
      if (!wins.length || !losses.length) return null;
      const aw = wins.reduce((s, t) => s + t.r, 0) / wins.length, al = -losses.reduce((s, t) => s + t.r, 0) / losses.length;
      return al > 0 ? aw / al : null;
    })(),
  };
}

export interface Gate { minWin: number; discovery: { minN: number; nullPctile: number; minQuarters: number }; confirmation: { minN: number; nullPctile: number } }

export const DEFAULT_GATE: Gate = { minWin: 0.6, discovery: { minN: 100, nullPctile: 0.99, minQuarters: 5 }, confirmation: { minN: 30, nullPctile: 0.9 } };

export function verdict(d: WindowStats, c: WindowStats, g: Gate): { pass: boolean; fails: string[] } {
  const fails: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (d.n < g.discovery.minN) fails.push(`discovery ${d.n} trades < ${g.discovery.minN}`);
  if (!((d.expectancyR ?? -1) > 0)) fails.push('discovery expectancy <= 0');
  if ((d.winRate ?? 0) < g.minWin) fails.push(`discovery win rate ${pct(d.winRate ?? 0)} < ${pct(g.minWin)}`);
  if ((d.nullPctile ?? 0) < g.discovery.nullPctile) fails.push(`discovery random-direction pctile ${pct(d.nullPctile ?? 0)} < ${pct(g.discovery.nullPctile)}`);
  if (d.quartersPositive < g.discovery.minQuarters) fails.push(`discovery ${d.quartersPositive}/${d.quarters} quarters positive`);
  if (c.n < g.confirmation.minN) fails.push(`confirmation ${c.n} trades < ${g.confirmation.minN}`);
  if (!((c.expectancyR ?? -1) > 0)) fails.push('confirmation expectancy <= 0');
  if ((c.winRate ?? 0) < g.minWin) fails.push(`confirmation win rate ${pct(c.winRate ?? 0)} < ${pct(g.minWin)}`);
  if ((c.nullPctile ?? 0) < g.confirmation.nullPctile) fails.push(`confirmation random-direction pctile ${pct(c.nullPctile ?? 0)} < ${pct(g.confirmation.nullPctile)}`);
  return { pass: fails.length === 0, fails };
}

export interface Candidate { signal: string; family: string; tf: Tf; exit: string; fade: boolean; discovery: WindowStats; confirmation: WindowStats; pass: boolean; fails: string[] }

const lite = (trades: ReturnType<typeof runBacktest>['trades']): Lite[] => trades.map((t) => ({ key: `${t.symbol}|${t.tag}`, openedAt: t.openedAt, side: t.side, r: t.r }));

/** Screen one signal on one timeframe with every exit, both directions. */
export function screenSignal(data: Readonly<Record<string, SymbolData>>, symbols: string[], def: SignalDef, tf: Tf, base: BacktestConfig, score: ScoreConfig, windows: { discovery: [number, number]; confirmation: [number, number] }, gate: Gate, runs: number, exits = EXITS): Candidate[] {
  const events = eventsFor(data, symbols, tf, def, score);
  if (def.stop) {
    // How often the 1-ATR floor overrides the structure stop (owner: know what the stop really is).
    let n = 0, floored = 0, gated = 0;
    for (const e of events.values()) e.sig.forEach((v, i) => {
      if (!v) return;
      n++;
      const st = e.stop?.[i], a = e.atr[i];
      if (st == null) gated++;
      else if (a != null && Math.abs(st - a) <= 1e-9 * a) floored++;
    });
    if (n) console.error(`${def.id} ${tf}: ${n} signals; stop at the 1-ATR floor on ${((floored / n) * 100).toFixed(0)}%, no trade (collar or cost gate) on ${((gated / n) * 100).toFixed(0)}%`);
  }
  const out: Candidate[] = [];
  for (const exit of exits) {
    const cfg = screenConfig(base, tf, exit);
    const asIs = lite(runBacktest(data, cfg, eventOverride(events, exit, false)).trades);
    const faded = lite(runBacktest(data, cfg, eventOverride(events, exit, true)).trades);
    const rOf = (xs: Lite[]) => new Map(xs.map((t) => [t.key, t.r]));
    for (const [fade, mine, other] of [[false, asIs, rOf(faded)], [true, faded, rOf(asIs)]] as const) {
      const d = windowStats(mine, other, windows.discovery, runs);
      const c = windowStats(mine, other, windows.confirmation, runs);
      const v = verdict(d, c, gate);
      out.push({ signal: def.id, family: def.family, tf, exit: exit.id, fade, discovery: d, confirmation: c, ...v });
    }
  }
  return out;
}

export function formatScreen(cands: Candidate[], gate: Gate, meta: { from: number; split: number; to: number; symbols: string[]; hash: string }): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const f = (x: number | null, d = 3) => (x == null ? '-' : x.toFixed(d));
  const p = (x: number | null) => (x == null ? '  -' : `${Math.round(x * 100)}%`.padStart(4));
  const name = (c: Candidate) => `${c.signal}${c.fade ? ' (faded)' : ''} ${c.tf} ${c.exit}`.padEnd(38);
  const w = (s: WindowStats) => `${String(s.n).padStart(5)} tr win ${p(s.winRate)} exp ${f(s.expectancyR).padStart(6)}R PF ${f(s.profitFactor, 2).padStart(4)} tot ${s.totalR.toFixed(0).padStart(5)}R W/L ${f(s.payoff ?? null, 2)} L ${f(s.longExp ?? null)} S ${f(s.shortExp ?? null)} null ${p(s.nullPctile)}`;
  const row = (c: Candidate) => `  ${name(c)} D: ${w(c.discovery)} q+ ${c.discovery.quartersPositive}/${c.discovery.quarters} | C: ${w(c.confirmation)}`;
  const pass = cands.filter((c) => c.pass);
  const hiWin = cands.filter((c) => (c.discovery.winRate ?? 0) >= gate.minWin && (c.discovery.expectancyR ?? -1) > 0).sort((a, b) => (b.discovery.expectancyR ?? 0) - (a.discovery.expectancyR ?? 0));
  const bestExp = [...cands].filter((c) => c.discovery.n >= gate.discovery.minN).sort((a, b) => (b.discovery.expectancyR ?? -9) - (a.discovery.expectancyR ?? -9)).slice(0, 20);
  const bestNull = [...cands].filter((c) => c.discovery.n >= gate.discovery.minN && (c.discovery.expectancyR ?? -1) > 0).sort((a, b) => (b.discovery.nullPctile ?? 0) - (a.discovery.nullPctile ?? 0)).slice(0, 20);
  // Per signal: does anything about it beat random direction with positive expectancy on BOTH windows?
  const present = SIGNALS.filter((s) => cands.some((c) => c.signal === s.id));
  const usedExits = ALL_EXITS.filter((e) => cands.some((c) => c.exit === e.id));
  const bySignal = present.map((s) => {
    const mine = cands.filter((c) => c.signal === s.id);
    const alive = mine.filter((c) => (c.discovery.expectancyR ?? -1) > 0 && (c.discovery.nullPctile ?? 0) >= 0.95 && (c.confirmation.expectancyR ?? -1) > 0 && (c.confirmation.nullPctile ?? 0) >= 0.8);
    return { s, n: mine.length, pass: mine.filter((c) => c.pass).length, alive };
  });
  return [
    `SIGNAL SCREEN  discovery ${iso(meta.from)} → ${iso(meta.split)}, confirmation ${iso(meta.split)} → ${iso(meta.to)} (holdout excluded), ${meta.symbols.length} coins`,
    `${present.length} signals x up to ${SCREEN_TFS.length} timeframes x ${usedExits.length} exits x as-is/faded = ${cands.length} candidates; config ${meta.hash}`,
    `Gate: win rate >= ${Math.round(gate.minWin * 100)}% and expectancy > 0 on both windows; beats random direction (discovery >= ${Math.round(gate.discovery.nullPctile * 100)}th pct, confirmation >= ${Math.round(gate.confirmation.nullPctile * 100)}th); >= ${gate.discovery.minN} / ${gate.confirmation.minN} trades; >= ${gate.discovery.minQuarters}/8 discovery quarters positive.`,
    `Exits: ${usedExits.map((e) => `${e.id} = ${e.what}`).join('; ')}. Market entry next 15m open, taker fees, 2 bps slippage, funding, cost veto (stop >= 0.667%).`,
    '',
    `PASSED (${pass.length})`,
    ...(pass.length ? pass.map(row) : ['  none']),
    '',
    `WIN RATE >= ${Math.round(gate.minWin * 100)}% WITH POSITIVE EXPECTANCY ON DISCOVERY (${hiWin.length}), best first`,
    ...hiWin.slice(0, 25).map((c) => `${row(c)}\n      fails: ${c.fails.join('; ') || '-'}`),
    '',
    'BEST DISCOVERY EXPECTANCY, ANY WIN RATE (top 20)',
    ...bestExp.map(row),
    '',
    'STRONGEST AGAINST RANDOM DIRECTION WITH POSITIVE EXPECTANCY (top 20)',
    ...bestNull.map(row),
    '',
    'PER SIGNAL (keep = some timeframe/exit beats random direction with positive expectancy on both windows; retire = nothing does)',
    ...bySignal.map((x) => `  ${x.alive.length ? 'KEEP  ' : 'RETIRE'} ${x.s.id.padEnd(20)} ${x.s.family.padEnd(15)} passed ${x.pass}/${x.n}${x.alive.length ? `; holds on: ${x.alive.map((c) => `${c.tf} ${c.exit}${c.fade ? ' faded' : ''}`).join(', ')}` : ''}  (${x.s.what})`),
    '',
    `Symbols: ${meta.symbols.join(', ')}`,
  ].join('\n');
}

export function screenRows(cands: Candidate[], hash: string, windows: { discovery: [number, number]; confirmation: [number, number] }): RunLogRow[] {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const stamp = new Date().toISOString();
  return cands.flatMap((c) => (['discovery', 'confirmation'] as const).map((name) => {
    const s = c[name];
    return {
      timestamp: stamp, gitHash: gitHash(), rulesHash: hash, rule: `screen ${c.signal}`, variant: `${c.tf} ${c.exit}${c.fade ? ' faded' : ''}`, tier: 'SCREEN',
      window: { name, from: iso(windows[name][0]), to: iso(windows[name][1]) },
      n: s.n, expectancyR: s.expectancyR, profitFactor: s.profitFactor, totalR: s.totalR, winRate: s.winRate,
      nullPctile: s.nullPctile, randomFilterPctile: null, verdict: c.pass ? 'holds' : 'fails',
    } satisfies RunLogRow;
  }));
}

export interface ScreenFile { windows: { discovery: [number, number]; confirmation: [number, number] }; gate: Gate; meta: { from: number; split: number; to: number; symbols: string[]; hash: string }; cands: Candidate[] }

/**
 * Modes (the Signal screen workflow runs one job per signal in parallel):
 *   --list [--signals a,b]        print the signal ids as JSON
 *   --prepare                     pick the universe, load (and cache) the data, write screen-symbols.txt
 *   [--symbols-file f] [--signals a,b] [--out f] [--shard]
 *                                 screen those signals; --shard writes only the JSON
 *   --merge <dir>                 merge every shard JSON in dir into one report
 */
async function main() {
  const { readdirSync, readFileSync } = await import('node:fs');
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const flag = (n: string) => process.argv.includes(`--${n}`);
  const only = arg('signals')?.split(',').map((x) => x.trim()).filter(Boolean);
  const chosen = SIGNALS.filter((s) => !only?.length || only.includes(s.id));
  if (flag('list')) { console.log(JSON.stringify(chosen.map((s) => s.id))); return; }

  const merge = arg('merge');
  if (merge) {
    const files = readdirSync(merge, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
    const parts = files.map((f) => JSON.parse(readFileSync(`${merge}/${f}`, 'utf8')) as ScreenFile);
    if (!parts.length) throw new Error(`no shard results in ${merge}`);
    const syms = JSON.stringify(parts[0]!.meta.symbols);
    if (parts.some((p) => JSON.stringify(p.meta.symbols) !== syms)) throw new Error('shards ran on different coin lists');
    const cands = parts.flatMap((p) => p.cands);
    const { windows, gate, meta } = parts[0]!;
    const report = formatScreen(cands, gate, meta);
    writeFileSync('screen-report.txt', report);
    writeFileSync('screen-results.json', JSON.stringify({ windows, gate, meta, cands } satisfies ScreenFile, null, 2));
    appendRunLog(screenRows(cands, meta.hash, windows));
    console.log(report);
    return;
  }

  const { createClient, fetchTickers } = await import('@bot/bitunix');
  const { apiTradable, selectUniverse } = await import('@bot/worker');
  const { loadMarket } = await import('../load');
  const { loadScoreConfig } = await import('../score/config');
  const months = Number(arg('months') ?? 36);
  const extras = Number(arg('extras') ?? 60);
  const minVolume = Number(arg('min-volume') ?? 3_000_000);
  const runs = Number(arg('runs') ?? 500);
  const gate: Gate = { ...DEFAULT_GATE, minWin: Number(arg('min-win') ?? DEFAULT_GATE.minWin) };
  const tfs = (arg('tfs')?.split(',') ?? SCREEN_TFS) as Tf[];
  const exitIds = arg('exits')?.split(',').map((x) => x.trim()).filter(Boolean);
  const exits = exitIds?.length ? ALL_EXITS.filter((e) => exitIds.includes(e.id)) : EXITS;
  if (exitIds?.length && exits.length !== exitIds.length) throw new Error(`unknown exit in ${exitIds.join(',')} (known: ${ALL_EXITS.map((e) => e.id).join(', ')})`);
  const holdout = researchWindow(0).to;
  const from = addMonths(holdout, -months);
  const split = addMonths(from, 24);
  const windows = { discovery: [from, split] as [number, number], confirmation: [split, holdout] as [number, number] };
  const client = createClient({ baseUrl: process.env.BITUNIX_BASE_URL });
  const log = (m: string) => console.error(m);
  const file = arg('symbols-file');
  const symbols = file
    ? readFileSync(file, 'utf8').split(/[\s,]+/).filter(Boolean)
    : selectUniverse(await fetchTickers(client), { universe: 'all', minQuoteVolume24h: minVolume, maxExtraSymbols: extras }, await apiTradable(client));
  log(`symbols (${symbols.length}): ${symbols.join(', ')}`);
  const { data } = await loadMarket({ client, cacheDir: '.cache/backtest', symbols, from: addMonths(from, -3), to: holdout, log });
  if (flag('prepare')) { writeFileSync('screen-symbols.txt', symbols.join('\n')); return; }
  const { config: score, hash } = loadScoreConfig();
  const base = defaultConfig(from, holdout);
  const started = Date.now();
  const cands: Candidate[] = [];
  for (const def of chosen) {
    for (const tf of tfs.filter((t) => !def.tfs || def.tfs.includes(t))) {
      const got = screenSignal(data, symbols, def, tf, base, score, windows, gate, runs, exits);
      cands.push(...got);
      const best = [...got].sort((a, b) => (b.discovery.expectancyR ?? -9) - (a.discovery.expectancyR ?? -9))[0];
      log(`${((Date.now() - started) / 60_000).toFixed(1)}m ${def.id} ${tf}: best ${best ? `${best.exit}${best.fade ? ' faded' : ''} exp ${best.discovery.expectancyR?.toFixed(3)} win ${((best.discovery.winRate ?? 0) * 100).toFixed(0)}% n ${best.discovery.n}` : '-'}; passed ${got.filter((c) => c.pass).length}`);
    }
  }
  const meta = { from, split, to: holdout, symbols, hash };
  const out: ScreenFile = { windows, gate, meta, cands };
  writeFileSync(arg('out') ?? 'screen-results.json', JSON.stringify(out, null, 2));
  if (flag('shard')) return;
  const report = formatScreen(cands, gate, meta);
  writeFileSync('screen-report.txt', report);
  appendRunLog(screenRows(cands, hash, windows));
  console.log(report);
}

if (process.argv[1]?.endsWith('screen.ts')) main().catch((e) => { console.error(e); process.exit(1); });
