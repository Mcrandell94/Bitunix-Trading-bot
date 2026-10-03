// Supply and Demand Zones, ported from "Supply and Demand Zones [BigBeluga]" (Pine v6), for research tests of the
// RSI framework (owner 2026-10-03). Original work © BigBeluga, licensed under Creative Commons
// Attribution-NonCommercial-ShareAlike 4.0 International (https://creativecommons.org/licenses/by-nc-sa/4.0/);
// this port is shared under the same license.
//
// Supply: three bearish candles in a row, the middle one on above-average volume (average of the last 1000 bars),
// and no supply zone made in the last 14 bars. The zone sits on the last bullish candle within the previous 5 bars:
// from its low up 2 x ATR(200). Demand is the mirror (three bullish candles; the last bearish candle's high down
// 2 x ATR(200)). A supply zone dies on a close above its top, a demand zone on a close under its bottom. A zone whose
// range holds another zone's top (supply) / bottom (demand) is removed, and only the newest 5 per side stay.
// The script's volume delta labels and styling are display only and not ported.

import type { Candle } from '@bot/marketdata';

export interface SdZone {
  kind: 'supply' | 'demand';
  top: number;
  bottom: number;
  /** Bar index whose close created the zone (known from then on). */
  created: number;
  /** First bar index where the zone is gone (Infinity while alive at the end of the data). */
  removed: number;
}

/** Pine's ta.atr: Wilder RMA of the true range, seeded with the SMA of the first `len` values. */
function pineAtr(c: ReadonlyArray<Candle>, len: number): (number | null)[] {
  const out: (number | null)[] = [];
  let rma: number | null = null, sum = 0;
  for (let i = 0; i < c.length; i++) {
    const b = c[i]!, pc = i > 0 ? c[i - 1]!.close : null;
    const tr = pc == null ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (i < len) { sum += tr; if (i === len - 1) rma = sum / len; }
    else rma = (rma! * (len - 1) + tr) / len;
    out.push(rma);
  }
  return out;
}

/** Every zone the script draws over the candles, with when it appeared and when it went away. */
export function sdZones(c: ReadonlyArray<Candle>): SdZone[] {
  const atr = pineAtr(c, 200);
  const vol = c.map((b) => b.volume ?? 0);
  const extra: boolean[] = [];
  let vsum = 0;
  const bear = (i: number) => i >= 0 && c[i]!.close < c[i]!.open, bull = (i: number) => i >= 0 && c[i]!.close > c[i]!.open;
  const all: SdZone[] = [];
  const live: Record<'supply' | 'demand', SdZone[]> = { supply: [], demand: [] };
  let countBear = 0, countBull = 0;
  const kill = (z: SdZone, t: number) => { if (z.removed === Infinity) z.removed = t; };
  for (let t = 0; t < c.length; t++) {
    vsum += vol[t]!;
    if (t >= 1000) vsum -= vol[t - 1000]!;
    extra.push(vol[t]! > vsum / Math.min(t + 1, 1000));
    const a = atr[t] == null ? null : atr[t]! * 2;
    if (a != null && countBear === 0 && bear(t) && bear(t - 1) && bear(t - 2) && extra[t - 1]) {
      for (let i = 0; i <= 5 && t - i >= 0; i++) {
        if (bull(t - i)) {
          countBear = 1;
          const z: SdZone = { kind: 'supply', top: c[t - i]!.low + a, bottom: c[t - i]!.low, created: t, removed: Infinity };
          all.push(z); live.supply.push(z);
          break;
        }
      }
    }
    if (countBear >= 1) countBear++;
    if (countBear >= 15) countBear = 0;
    if (a != null && countBull === 0 && bull(t) && bull(t - 1) && bull(t - 2) && extra[t - 1]) {
      for (let i = 0; i <= 5 && t - i >= 0; i++) {
        if (bear(t - i)) {
          countBull = 1;
          const z: SdZone = { kind: 'demand', top: c[t - i]!.high, bottom: c[t - i]!.high - a, created: t, removed: Infinity };
          all.push(z); live.demand.push(z);
          break;
        }
      }
    }
    if (countBull >= 1) countBull++;
    if (countBull >= 15) countBull = 0;

    // Broken zones: a close through the far side (removed from this bar on).
    const close = c[t]!.close;
    for (const z of live.supply) if (close > z.top) kill(z, t);
    for (const z of live.demand) if (close < z.bottom) kill(z, t);
    // Overlaps: a zone holding another zone's top (supply) / bottom (demand) inside its range goes.
    for (const kind of ['supply', 'demand'] as const) {
      let zs = live[kind].filter((z) => z.removed === Infinity);
      for (const z of [...zs]) {
        const edge = (o: SdZone) => (kind === 'supply' ? o.top : o.bottom);
        if (zs.some((o) => o !== z && edge(o) < z.top && edge(o) > z.bottom)) { kill(z, t); zs = zs.filter((o) => o !== z); }
      }
      while (zs.length > 5) kill(zs.shift()!, t);
      live[kind] = zs;
    }
  }
  return all;
}

/** Zones alive at the close of bar `t` (created at or before t, not yet removed). */
export function zonesAt(zones: ReadonlyArray<SdZone>, t: number, kind?: 'supply' | 'demand'): SdZone[] {
  return zones.filter((z) => z.created <= t && z.removed > t && (!kind || z.kind === kind));
}

// ---------------------------------------------------------------------------------------------------------------
// Supply and Demand Visible Range, ported from "Supply and Demand Visible Range [LuxAlgo]" (Pine v5). Original work
// © LuxAlgo, licensed under CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/); this port is
// shared under the same license.
//
// Over a window of bars (the chart's visible range; here a fixed lookback ending at the bar asked about), the
// high-low range is cut into `div` bands. Supply: walking down from the top band by band, the zone ends at the first
// band where the volume of the bars whose HIGH lies in the bands walked so far exceeds `per`% of the window's volume;
// the zone runs from that band's level up to the window high. Demand mirrors it with the bars' LOWS from the bottom.
// The intrabar timeframe defaults to the chart's own, so each bar counts once. Averages and lines are display only.

export interface VisibleRangeZones { supply: { top: number; bottom: number } | null; demand: { top: number; bottom: number } | null }

export function sdVisibleRange(c: ReadonlyArray<Candle>, end: number, lookback = 150, per = 10, div = 50): VisibleRangeZones {
  const from = Math.max(0, end - lookback + 1);
  let max = -Infinity, min = Infinity, csum = 0;
  for (let j = from; j <= end; j++) { max = Math.max(max, c[j]!.high); min = Math.min(min, c[j]!.low); csum += c[j]!.volume ?? 0; }
  if (!(max > min) || !(csum > 0)) return { supply: null, demand: null };
  const r = (max - min) / div;
  let sPrev = max, sLvl = max, sSum = 0, dPrev = min, dLvl = min, dSum = 0;
  let supply: VisibleRangeZones['supply'] = null, demand: VisibleRangeZones['demand'] = null;
  for (let i = 0; i < div && (!supply || !demand); i++) {
    sLvl -= r; dLvl += r;
    for (let j = from; j <= end; j++) {
      const b = c[j]!, v = b.volume ?? 0;
      if (!supply && b.high > sLvl && b.high < sPrev) sSum += v;
      if (!demand && b.low < dLvl && b.low > dPrev) dSum += v;
    }
    if (!supply && (sSum / csum) * 100 > per) supply = { top: max, bottom: sLvl };
    if (!demand && (dSum / csum) * 100 > per) demand = { top: dLvl, bottom: min };
    sPrev = sLvl; dPrev = dLvl;
  }
  return { supply, demand };
}
