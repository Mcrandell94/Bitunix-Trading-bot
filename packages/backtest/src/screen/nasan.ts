// TypeScript port of "Dynamic Volume-Volatility Adjusted Momentum" (shorttitle "Nasan Momentum Oscillator", Pine v5;
// the copy given has no author or licence header, TradingView's default for open scripts is MPL 2.0) for the owner's
// ETH / BTC cards (owner 2026-10-17, cards v3). Calculations only (no plots or fills), default inputs: lengths 5 / 8 /
// 13, price hlc3, dynamic lengths on, coefficient of variation off, z-score over 500 bars, zones at +-1.5.
//
// Bar-for-bar notes:
// - For each length L: PC = (hlc3 - SMA_L(hlc3)) / SMA_L(|hlc3 - median_L(hlc3)|); VC = volume / SMA_L(volume);
//   VR = IDV / SMA_L(IDV) with IDV = (high - low) / close; the term is PC x VC / VR. Their mean over the three lengths.
//   x / 0 is read as na (a bar with high = low, or a flat stretch).
// - Dynamic length: rv = SMA10(ATR5) / ATR5 (0 when the SMA is 0), DL = int(14 / rv) held to 5..30 (na while the ATR
//   warms up). The mean term's SMA over DL bars (the window length changes bar to bar).
// - z = (that SMA - its 500-bar SMA) / its 500-bar standard deviation (population), so it needs 500 bars of it: none on
//   the weekly bars here (about 157). Smoothed line = HMA 5 of z. Green over 0, red under, blue at 0.
// - The script draws no marks; the chart check reports the last crosses of 0 and into the +-1.5 zones from z.
// - No price levels: not a POI script; the preview's chart check shows it.
// Volume is in coin units (pine.ts coinVolume), as the other ports (VC is a ratio of the bar's volume to its average).
// Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taAtr, taHma, taMedian, taSma, taStdev } from './pine';

export const NASAN = { lens: [5, 8, 13], base: 14, minLen: 5, maxLen: 30, zLen: 500, ob: 1.5, os: -1.5, atrLen: 5, atrMa: 10, hma: 5 } as const;

export interface NasanSeries {
  /** The z-score, its HMA 5, the dynamic length and the averaged momentum it is taken from. */
  z: number[]; smooth: number[]; dl: number[]; ma: number[];
  /** z crossing 0 up / down, into the overbought zone (over 1.5) and the oversold zone (under -1.5). */
  up0: boolean[]; down0: boolean[]; intoOb: boolean[]; intoOs: boolean[];
}

const div = (a: number, b: number) => (b === 0 ? NaN : a / b);

export function nasan(c: ReadonlyArray<Candle>): NasanSeries {
  const N = NASAN, tp = c.map((b) => (b.high + b.low + b.close) / 3), vol = coinVolume(c), idv = c.map((b) => div(b.high - b.low, b.close));
  const terms = N.lens.map((L) => {
    const sTp = taSma(tp, L), med = taMedian(tp, L), mad = taSma(tp.map((x, i) => Math.abs(x - med[i]!)), L), sV = taSma(vol, L), sI = taSma(idv, L);
    return tp.map((x, i) => div(div(x - sTp[i]!, mad[i]!) * div(vol[i]!, sV[i]!), div(idv[i]!, sI[i]!)));
  });
  const ave = tp.map((_, i) => (terms[0]![i]! + terms[1]![i]! + terms[2]![i]!) / 3);
  const atr = taAtr(c, N.atrLen), am = taSma(atr, N.atrMa);
  const dl = am.map((m, i) => { const rv = m !== 0 ? m / atr[i]! : 0; return Math.trunc(Math.min(Math.max(Math.trunc(div(N.base, rv)), N.minLen), N.maxLen)); });
  const ma = dl.map((L, i) => {
    if (Number.isNaN(L) || i - L + 1 < 0) return NaN;
    let s = 0;
    for (let k = i - L + 1; k <= i; k++) s += ave[k]!;
    return s / L;
  });
  const mean = taSma(ma, N.zLen), sd = taStdev(ma, N.zLen), z = ma.map((m, i) => div(m - mean[i]!, sd[i]!));
  const cross = (lvl: number, up: boolean) => z.map((v, i) => i > 0 && (up ? v > lvl && z[i - 1]! <= lvl : v < lvl && z[i - 1]! >= lvl));
  return { z, smooth: taHma(z, N.hma), dl, ma, up0: cross(0, true), down0: cross(0, false), intoOb: cross(N.ob, true), intoOs: cross(N.os, false) };
}
