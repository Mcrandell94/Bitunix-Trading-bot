// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// TypeScript port of "Dynamic Volume Adaptive Moving Average (MZ DVAMA)" (Pine v5, © MightyZinger) for the owner's
// ETH / BTC cards (owner 2026-10-16, cards v3). Calculations only (no plots or fills), default inputs: Heikin Ashi
// candles on, source (close + high + low) / 3 of the HA close with SWMA, length 365, fast 6, slow 7..14, adapting 3.141%,
// TFS volume oscillator (volume length 30, RVSI 14, break 50), slope 34 / 25 / flat 17, envelope 2.5 x ATR(40).
//
// Bar-for-bar notes:
// - HA: close = ohlc4, open = (previous HA open + previous HA close) / 2 (the first one (open + close) / 2); high and
//   low stay the bar's own. Source = SWMA of (HA close + high + low) / 3.
// - TFS volume oscillator: the 30-bar sum of +volume on HA-up bars and -volume on HA-down bars, / 30; its SMA 14; the
//   RSI 14 of that (Wilder, 100 with no losses, 0 with no gains); RVSI = HMA 14 of the RSI. Volume breaks up while the
//   RVSI is over 50.
// - Slow length: starts at 10.5; each bar x (1 - 3.141%) down to 7 while the volume breaks up, else x (1 + 3.141%) up
//   to 14; the AMA takes its integer part.
// - AMA: alpha = mult x (2/7 - 2/(slow + 1)) + 2/(slow + 1), mult = |2 x src - lowest - highest| / (highest - lowest)
//   over the last 366 bars' highs and lows (0 while that is na: a comparison with na is false), and the line moves by
//   alpha^2 of the gap to the source (nz: from 0).
// - Slope: dt = (line 2 bars back - line) / source x 25 / (34-bar high - low) x low; the angle round(acos(1 / sqrt(1 +
//   dt^2)) in degrees), negative when dt > 0. Colour: over 17 green when the volume breaks up (else lime), from -17 to 17
//   yellow, -17 or under red when the volume breaks down (else gray); green while the slope is na.
// - Signals: a buy dot when it turns green, a sell dot when it turns red; Long / Short when the swing flips.
// - Envelope: line ± 2.5 / 4.25 / 5 x ATR(40), and ± 1.25 x ATR(40) (the stop band).
// - The card takes the line, the ±2.5 ATR lines and the outer zones (4.25..5 ATR) as levels.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, nz, taAtr, taHighest, taHma, taLowest, taRma, taSma, taSum, taSwma } from './pine';

export const DVAMA = { length: 365, fast: 6, slowMin: 7, slowMax: 14, adapt: 0.03141, volLen: 30, rvsiLen: 14, vBrk: 50, slopePeriod: 34, slopeRange: 25, flat: 17, mult: 2.5, envAtr: 40 } as const;
export type DvamaColor = 'green' | 'lime' | 'red' | 'gray' | 'yellow';

export interface DvamaSeries {
  src: number[]; rvsi: number[]; slow: number[]; line: number[]; slope: number[]; color: DvamaColor[];
  buy: boolean[]; sell: boolean[]; long: boolean[]; short: boolean[]; atr: number[];
}

/** RSI as ta.rsi: RMA of the gains / losses; 100 with no losses, 0 with no gains. */
function pineRsi(src: number[], len: number): number[] {
  const ch = src.map((x, i) => (i > 0 ? x - src[i - 1]! : NaN));
  const up = taRma(ch.map((d) => (Number.isNaN(d) ? NaN : Math.max(d, 0))), len), dn = taRma(ch.map((d) => (Number.isNaN(d) ? NaN : Math.max(-d, 0))), len);
  return up.map((u, i) => { const d = dn[i]!; return Number.isNaN(u) || Number.isNaN(d) ? NaN : d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); });
}

export function dvama(c: ReadonlyArray<Candle>): DvamaSeries {
  const P = DVAMA, n = c.length, vol = coinVolume(c);
  const haC = c.map((b) => (b.open + b.high + b.low + b.close) / 4), haO: number[] = [];
  for (let i = 0; i < n; i++) haO.push(i === 0 ? (c[i]!.open + c[i]!.close) / 2 : (nz(haO[i - 1]!) + nz(haC[i - 1]!)) / 2);
  const src = taSwma(c.map((b, i) => (haC[i]! + b.high + b.low) / 3));

  const tfs = taSum(c.map((_, i) => (haC[i]! > haO[i]! ? vol[i]! : haC[i]! < haO[i]! ? -vol[i]! : 0)), P.volLen).map((x) => x / P.volLen);
  const rvsi = taHma(pineRsi(taSma(tfs, P.rvsiLen), P.rvsiLen), P.rvsiLen);

  const hh = taHighest(c.map((b) => b.high), P.length + 1), ll = taLowest(c.map((b) => b.low), P.length + 1);
  const slow: number[] = [], line: number[] = [];
  let len = (P.slowMin + P.slowMax) / 2, ma = NaN;
  for (let i = 0; i < n; i++) {
    len = rvsi[i]! > P.vBrk ? Math.max(P.slowMin, len * (1 - P.adapt)) : Math.min(P.slowMax, len * (1 + P.adapt));
    slow.push(len);
    const minA = 2 / (P.fast + 1), majA = 2 / (Math.trunc(len) + 1), range = hh[i]! - ll[i]!;
    const mult = range !== 0 && !Number.isNaN(range) ? Math.abs(2 * src[i]! - ll[i]! - hh[i]!) / range : 0;
    const a = mult * (minA - majA) + majA, prev = nz(ma);
    ma = prev + a * a * (src[i]! - prev);
    line.push(ma);
  }

  const h34 = taHighest(c.map((b) => b.high), P.slopePeriod), l34 = taLowest(c.map((b) => b.low), P.slopePeriod);
  const slope = line.map((m, i) => {
    const dt = ((i >= 2 ? line[i - 2]! : NaN) - m) / src[i]! * (P.slopeRange / (h34[i]! - l34[i]!) * l34[i]!);
    const x = Math.round((180 * Math.acos(1 / Math.sqrt(1 + dt * dt))) / Math.PI);
    return dt > 0 ? -x : x;
  });
  const color = slope.map((s, i): DvamaColor => {
    const up = rvsi[i]! > P.vBrk, dn = rvsi[i]! < P.vBrk;
    let col: DvamaColor = 'green';
    if (s > P.flat && up) col = 'green';
    if (s > P.flat && !up) col = 'lime';
    if (s <= P.flat && s > -P.flat) col = 'yellow';
    if (s <= -P.flat && dn) col = 'red';
    if (s <= -P.flat && !dn) col = 'gray';
    return col;
  });
  const buy = color.map((x, i) => x === 'green' && i > 0 && color[i - 1] !== 'green'), sell = color.map((x, i) => x === 'red' && i > 0 && color[i - 1] !== 'red');
  const long: boolean[] = [], short: boolean[] = [];
  let swing = 0;
  for (let i = 0; i < n; i++) {
    const was = swing;
    if (buy[i] && swing <= 0) swing = 1;
    if (sell[i] && swing >= 0) swing = -1;
    long.push(swing === 1 && i > 0 && was !== 1); short.push(swing === -1 && i > 0 && was !== -1);
  }
  return { src, rvsi, slow, line, slope, color, buy, sell, long, short, atr: taAtr(c, P.envAtr) };
}

/** The envelope at bar i: the line and its ATR(40) bands. */
export function dvamaBands(s: DvamaSeries, i: number) {
  const m = s.line[i]!, a = s.atr[i]!, k = DVAMA.mult;
  return { line: m, upper: m + k * a, lower: m - k * a, outerTop: [m + k * 1.7 * a, m + k * 2 * a] as const, outerBot: [m - k * 2 * a, m - k * 1.7 * a] as const, stop: [m - (k / 2) * a, m + (k / 2) * a] as const };
}
