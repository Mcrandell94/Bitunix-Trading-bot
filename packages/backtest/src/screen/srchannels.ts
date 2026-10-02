// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of "Support Resistance Channels" (SRchannel) by LonesomeTheBlue,
// TradingView Pine Script v6, MPL-2.0. Ported for the owner's S/R channel bot (2026-10-02).
// Behaviour follows the Pine source bar for bar, including its quirks (noted below), so the
// levels match the chart; only drawing and colours are left out.

import type { Candle } from '@bot/marketdata';

export interface SrSettings {
  /** Pivot period: bars checked left and right. */
  prd: number;
  /** Pivot source: 'hl' = High/Low, 'co' = Close/Open. */
  source: 'hl' | 'co';
  /** Maximum channel width, % of the 300-bar high-low range. */
  channelWidthPct: number;
  /** Minimum strength (pivots); a channel needs strength >= 20 x this. */
  minStrength: number;
  /** Channels shown and tested (Pine "Maximum Number of S/R"). */
  maxChannels: number;
  /** Pivots older than this many bars are dropped. */
  loopback: number;
}

export const SR_DEFAULTS: SrSettings = { prd: 10, source: 'hl', channelWidthPct: 5, minStrength: 1, maxChannels: 6, loopback: 290 };

export interface SrChannel { hi: number; lo: number }

export interface SrSeries {
  /** Active channels at each bar's close (strongest first, as Pine orders them; at most maxChannels). */
  channels: ReadonlyArray<ReadonlyArray<SrChannel>>;
  /** Pine's "Resistance Broken": the index into channels[i] of the broken channel nearest the close, else -1. */
  resBroken: Int16Array;
  /** Pine's "Support Broken": the index into channels[i] of the broken channel nearest the close, else -1. */
  supBroken: Int16Array;
}

/** ta.pivothigh / ta.pivotlow: the value at bar i - prd if it is the extreme of the 2*prd+1 window (ties: the left-most wins), confirmed at bar i. */
export function pivotAt(src: ArrayLike<number>, i: number, prd: number, high: boolean): number | null {
  const k = i - prd;
  if (k - prd < 0) return null;
  const v = src[k]!;
  for (let j = 1; j <= prd; j++) {
    const l = src[k - j]!, r = src[k + j]!;
    if (high ? (l > v || r >= v) : (l < v || r <= v)) return null;
  }
  return v;
}

export function srChannels(candles: ReadonlyArray<Candle>, s: SrSettings = SR_DEFAULTS): SrSeries {
  const n = candles.length;
  const high = candles.map((c) => c.high), low = candles.map((c) => c.low), close = candles.map((c) => c.close);
  const src1 = s.source === 'hl' ? high : candles.map((c) => Math.max(c.close, c.open));
  const src2 = s.source === 'hl' ? low : candles.map((c) => Math.min(c.close, c.open));
  const shown = Math.min(9, s.maxChannels - 1);

  const pivotvals: number[] = []; // newest first (array.unshift)
  const pivotlocs: number[] = [];
  let sr = new Array<number>(20).fill(0); // [hi0, lo0, hi1, lo1, ...]
  let current: SrChannel[] = [];
  const channels: SrChannel[][] = new Array(n);
  const resBroken = new Int16Array(n).fill(-1), supBroken = new Int16Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const ph = pivotAt(src1, i, s.prd, true);
    const pl = pivotAt(src2, i, s.prd, false);
    // cwidth from ta.highest(300) / ta.lowest(300): na (no channel can form) before 300 bars.
    let cwidth = NaN;
    if (i >= 299) {
      let hh = -Infinity, ll = Infinity;
      for (let y = i - 299; y <= i; y++) { if (high[y]! > hh) hh = high[y]!; if (low[y]! < ll) ll = low[y]!; }
      cwidth = ((hh - ll) * s.channelWidthPct) / 100;
    }

    if (ph != null || pl != null) {
      pivotvals.unshift(ph != null ? ph : pl!); // both on one bar: Pine keeps the high
      pivotlocs.unshift(i);
      while (pivotvals.length && i - pivotlocs[pivotlocs.length - 1]! > s.loopback) { pivotvals.pop(); pivotlocs.pop(); }

      const np = pivotvals.length;
      const supres: number[] = []; // strength, hi, lo per pivot
      for (let x = 0; x < np; x++) {
        let lo = pivotvals[x]!, hi = lo, numpp = 0;
        for (let y = 0; y < np; y++) {
          const cpp = pivotvals[y]!;
          const wdth = cpp <= hi ? hi - cpp : cpp - lo;
          if (wdth <= cwidth) { // false while cwidth is NaN, as Pine's na
            if (cpp <= hi) lo = Math.min(lo, cpp); else hi = Math.max(hi, cpp);
            numpp += 20;
          }
        }
        supres.push(numpp, hi, lo);
      }
      for (let x = 0; x < np; x++) {
        const h = supres[x * 3 + 1]!, l = supres[x * 3 + 2]!;
        let cnt = 0;
        for (let y = 0; y <= s.loopback && i - y >= 0; y++) {
          const hy = high[i - y]!, ly = low[i - y]!;
          if ((hy <= h && hy >= l) || (ly <= h && ly >= l)) cnt++;
        }
        supres[x * 3] = supres[x * 3]! + cnt;
      }

      sr = new Array<number>(20).fill(0);
      const stren = new Array<number>(10).fill(0);
      let k = 0;
      for (let x = 0; x < np; x++) {
        let stv = -1, stl = -1;
        for (let y = 0; y < np; y++) {
          if (supres[y * 3]! > stv && supres[y * 3]! >= s.minStrength * 20) { stv = supres[y * 3]!; stl = y; }
        }
        if (stl >= 0) {
          const hh = supres[stl * 3 + 1]!, ll = supres[stl * 3 + 2]!;
          sr[k * 2] = hh; sr[k * 2 + 1] = ll; stren[k] = supres[stl * 3]!;
          for (let y = 0; y < np; y++) {
            const yh = supres[y * 3 + 1]!, yl = supres[y * 3 + 2]!;
            if ((yh <= hh && yh >= ll) || (yl <= hh && yl >= ll)) supres[y * 3] = -1;
          }
          k++;
          if (k >= 10) break;
        }
      }
      // Pine's sort: swaps the levels but never writes stren[x] back (kept as-is so levels match the chart).
      for (let x = 0; x <= 8; x++) {
        for (let y = x + 1; y <= 9; y++) {
          if (stren[y]! > stren[x]!) {
            stren[y] = stren[x]!;
            let t = sr[y * 2]!; sr[y * 2] = sr[x * 2]!; sr[x * 2] = t;
            t = sr[y * 2 + 1]!; sr[y * 2 + 1] = sr[x * 2 + 1]!; sr[x * 2 + 1] = t;
          }
        }
      }
      current = [];
      for (let x = 0; x <= shown; x++) if (sr[x * 2] !== 0) current.push({ hi: sr[x * 2]!, lo: sr[x * 2 + 1]! });
    }
    channels[i] = current;

    // Breaks: only when the close is outside every shown channel.
    if (i === 0) continue;
    const c = close[i]!, c1 = close[i - 1]!;
    let inside = false;
    for (let x = 0; x <= shown; x++) if (c <= sr[x * 2]! && c >= sr[x * 2 + 1]!) inside = true;
    if (inside) continue;
    let rb = -1, sb = -1;
    current.forEach((ch, x) => {
      if (c1 <= ch.hi && c > ch.hi && (rb < 0 || ch.hi > current[rb]!.hi)) rb = x;
      if (c1 >= ch.lo && c < ch.lo && (sb < 0 || ch.lo < current[sb]!.lo)) sb = x;
    });
    resBroken[i] = rb; supBroken[i] = sb;
  }
  return { channels, resBroken, supBroken };
}

/** The nearest channel wholly above `price` (its lower edge) and wholly below it (its upper edge), or null. */
export function nearestChannels(chs: ReadonlyArray<SrChannel>, price: number): { above: number | null; below: number | null } {
  let above: number | null = null, below: number | null = null;
  for (const ch of chs) {
    if (ch.lo > price && (above == null || ch.lo < above)) above = ch.lo;
    if (ch.hi < price && (below == null || ch.hi > below)) below = ch.hi;
  }
  return { above, below };
}
