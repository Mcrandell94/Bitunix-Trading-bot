// TypeScript port of "Volume Flow Indicator [LazyBear]" (shorttitle VFI_LB, Pine v1, by LazyBear) for the owner's
// script library (owner 2026-10-16). The copy given has no licence header (the author asks for a note when it is
// used); TradingView's default for open scripts is MPL 2.0. Calculations only (no plots), default inputs: length 130,
// coef 0.2, volume cutoff 2.5, signal EMA 5, not smoothed.
//
// Bar-for-bar notes:
// - inter = log(hlc3) - log(hlc3[1]); cutoff = 0.2 x stdev(inter, 30) (population) x close.
// - vave = the SMA 130 of the volume on the bar before; each bar's volume is capped at 2.5 x vave.
// - The bar's capped volume counts up when hlc3 rose by more than the cutoff, down when it fell by more, else 0 (also
//   while the cutoff is na).
// - VFI = the sum of those over 130 bars / vave (SMA 3 of it with "smoothVFI", off by default); the signal is its EMA 5
//   (Pine's SMA-seeded EMA); the histogram is VFI - signal.
// It gives no price levels, so it is not one of the card's POI scripts; the preview's chart check shows its reading.
// Volume is in coin units (pine.ts coinVolume), as the other ports. Pure.

import type { Candle } from '@bot/marketdata';
import { coinVolume, taEma, taSma, taStdev, taSum } from './pine';

export const VFI = { length: 130, coef: 0.2, vcoef: 2.5, signalLength: 5, smooth: false } as const;

export interface VfiSeries { vfi: number[]; signal: number[]; hist: number[] }

export function vfi(c: ReadonlyArray<Candle>, smooth: boolean = VFI.smooth): VfiSeries {
  const { length, coef, vcoef, signalLength } = VFI, vol = coinVolume(c);
  const typ = c.map((b) => (b.high + b.low + b.close) / 3);
  const inter = typ.map((x, i) => (i > 0 ? Math.log(x) - Math.log(typ[i - 1]!) : NaN)), vinter = taStdev(inter, 30);
  const sma = taSma(vol, length), vave = sma.map((_, i) => (i > 0 ? sma[i - 1]! : NaN));
  const vcp = c.map((b, i) => {
    const cutoff = coef * vinter[i]! * b.close, vmax = vave[i]! * vcoef, vc = vol[i]! < vmax ? vol[i]! : vmax, mf = i > 0 ? typ[i]! - typ[i - 1]! : NaN;
    return mf > cutoff ? vc : mf < -cutoff ? -vc : 0;
  });
  const raw = taSum(vcp, length).map((s, i) => s / vave[i]!), v = smooth ? taSma(raw, 3) : raw, signal = taEma(v, signalLength);
  return { vfi: v, signal, hist: v.map((x, i) => x - signal[i]!) };
}
