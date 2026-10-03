// Supply / demand and order blocks with the RSI framework (owner 2026-10-03: "test all variants and let's see what
// it says before doing anything"; zones from the weekly, daily and 4H). Research only. Rules fixed before the run:
//
// Zone sources: BigBeluga supply/demand zones, LuxAlgo visible-range supply/demand (150-bar window ending at the bar
// asked about), LuxAlgo order blocks (the newest 3 unmitigated per side, bearish OB = supply, bullish OB = demand).
// Zone timeframes: the model's own (weekly for the weekly shorts, daily for the daily longs, 4H for the 4H long) and
// the 4H (the daily for the 4H model). Zones are read at the entry bar's open: only zones already known then.
// Uses, each on its own against the framework as it is (same entries, stops, exits, costs):
//  - filter: take a short only if price touched a supply zone from the signal bar to the entry (the high-low range
//    of those bars overlaps the zone), a long only if it touched a demand zone;
//  - stop: a short's stop goes just over the nearest supply zone above the entry (its top + 0.5 ATR), a long's
//    under the nearest demand zone below (its bottom - 0.5 ATR); no such zone = the usual stop;
//  - target: exit at the nearest opposite zone (a short at the top of the nearest demand zone below the entry, a
//    long at the bottom of the nearest supply zone above), replacing the 3R target; no zone = the usual exits.

import type { Candle } from '@bot/marketdata';
import { weeklyFromDaily } from './rsimap';
import { frameworkSetups, RSI_MODELS, type RsiModelId, type Setup } from './rsisignals';
import { runTrade, statsLine, type SignalTrade } from './rsitrades';
import { orderBlocks, sdVisibleRange, sdZones, type SdZone } from './sdzones';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
type Src = 'bb' | 'lux' | 'ob';
type ZTf = 'w' | 'd' | 'h4';
type Use = 'filter' | 'stop' | 'target';
interface Zone { kind: 'supply' | 'demand'; top: number; bottom: number }

const DAY = 86_400_000, BAR: Record<ZTf, number> = { w: 7 * DAY, d: DAY, h4: 4 * 3_600_000 };
const SRC_NAME: Record<Src, string> = { bb: 'BigBeluga S/D', lux: 'LuxAlgo visible range', ob: 'LuxAlgo order blocks' };
const TF_NAME: Record<ZTf, string> = { w: 'weekly', d: 'daily', h4: '4H' };

/** Zones of one source and timeframe for one coin, readable at any time (only zones known by then). */
function zoneReader(src: Src, c: ReadonlyArray<Candle>, bar: number): (t: number) => Zone[] {
  const lastClosed = (t: number) => { let lo = 0, hi = c.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m]!.openTime + bar <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  if (src === 'lux') {
    return (t) => {
      const i = lastClosed(t);
      if (i < 20) return [];
      const z = sdVisibleRange(c, i, 150);
      return [...(z.supply ? [{ kind: 'supply' as const, ...z.supply }] : []), ...(z.demand ? [{ kind: 'demand' as const, ...z.demand }] : [])];
    };
  }
  const zs: SdZone[] = src === 'bb' ? sdZones(c) : orderBlocks(c);
  return (t) => {
    const i = lastClosed(t);
    if (i < 0) return [];
    const alive = zs.filter((z) => z.created <= i && z.removed > i);
    if (src === 'bb') return alive;
    alive.sort((a, b) => b.created - a.created);
    return [...alive.filter((z) => z.kind === 'supply').slice(0, 3), ...alive.filter((z) => z.kind === 'demand').slice(0, 3)];
  };
}

const ownTf = (m: RsiModelId): ZTf => (m.startsWith('w-') ? 'w' : m === 'under-floor' ? 'h4' : 'd');
const altTf = (m: RsiModelId): ZTf => (m === 'under-floor' ? 'd' : 'h4');

interface Variant { src: Src | null; tf: 'own' | 'alt'; use: Use | null }

/** One coin's trades for one model under one variant (one trade at a time per model). */
function tradesFor(sym: string, setups: Setup[], model: RsiModelId, v: Variant, readers: Record<Src, Record<ZTf, (t: number) => Zone[]>>, to: number, from: number, hit: { n: number }): SignalTrade[] {
  const out: SignalTrade[] = [];
  let busy = -Infinity;
  for (const s of setups) {
    if (s.model !== model || s.j == null || s.j >= s.c.length || s.stop == null || s.known <= busy) continue;
    const c = s.c, j = s.j, T = c[j]!.openTime, d = s.d;
    if (T < from) continue;
    let stop = s.stop, target: number | undefined;
    if (v.src && v.use) {
      const tf = v.tf === 'own' ? ownTf(model) : altTf(model);
      const zones = readers[v.src][tf](T), entry = c[j]!.open, a = s.atr[j - 1] ?? s.atr[j] ?? 0;
      const want = d < 0 ? 'supply' : 'demand', other = d < 0 ? 'demand' : 'supply';
      if (v.use === 'filter') {
        const sigBar = model.startsWith('w-') ? BAR.w : s.bar;
        let hi = -Infinity, lo = Infinity;
        for (let k = j - 1; k >= 0 && c[k]!.openTime >= s.known - sigBar; k--) { hi = Math.max(hi, c[k]!.high); lo = Math.min(lo, c[k]!.low); }
        if (!zones.some((z) => z.kind === want && z.bottom <= hi && z.top >= lo)) continue;
        hit.n++;
      } else if (v.use === 'stop') {
        const cands = zones.filter((z) => z.kind === want && (d < 0 ? z.top > entry : z.bottom < entry));
        if (cands.length) {
          const z = d < 0 ? cands.reduce((m, x) => (x.top < m.top ? x : m)) : cands.reduce((m, x) => (x.bottom > m.bottom ? x : m));
          stop = d < 0 ? z.top + 0.5 * a : z.bottom - 0.5 * a;
          hit.n++;
        }
      } else {
        const cands = zones.filter((z) => z.kind === other && (d < 0 ? z.top < entry : z.bottom > entry));
        if (cands.length) {
          target = d < 0 ? Math.max(...cands.map((z) => z.top)) : Math.min(...cands.map((z) => z.bottom));
          hit.n++;
        }
      }
    }
    const t = runTrade(c, s.atr, j, stop, d, s.cap, s.exit, 0.0022, target);
    if (!t || t.status === 'open') continue;
    const closedAt = c[t.end]!.openTime + s.bar;
    if (closedAt > to) continue;
    busy = closedAt;
    out.push({ sym, t: T, r: t.r, stopPct: t.stopPct, bars: t.bars });
  }
  return out;
}

export function sdTestReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const coins = symbols.map((sym) => {
    const d1 = [...(data[sym]?.candles['1d'] ?? [])], h4 = [...(data[sym]?.candles['4h'] ?? [])], w = weeklyFromDaily(d1);
    const per = (src: Src) => ({ w: zoneReader(src, w, BAR.w), d: zoneReader(src, d1, BAR.d), h4: zoneReader(src, h4, BAR.h4) });
    return { sym, setups: frameworkSetups(d1, h4), readers: { bb: per('bb'), lux: per('lux'), ob: per('ob') } };
  });
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const variants: Variant[] = [{ src: null, tf: 'own', use: null }];
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tf of ['own', 'alt'] as const) for (const use of ['filter', 'stop', 'target'] as Use[]) variants.push({ src, tf, use });
  const label = (m: RsiModelId | null, v: Variant) => !v.src ? 'framework as it is' : `${SRC_NAME[v.src]}, ${v.tf === 'own' ? (m ? TF_NAME[ownTf(m)] : 'own TF') : (m ? TF_NAME[altTf(m)] : '4H (daily for the 4H model)')} zones, ${v.use}`;

  const results = new Map<string, { trades: SignalTrade[]; hit: number }>();
  for (const v of variants) for (const m of models) {
    const hit = { n: 0 }, trades: SignalTrade[] = [];
    for (const k of coins) trades.push(...tradesFor(k.sym, k.setups, m, v, k.readers, to, from, hit));
    results.set(`${m}|${v.src}|${v.tf}|${v.use}`, { trades, hit: hit.n });
  }
  const out = [
    `SUPPLY / DEMAND + ORDER BLOCKS WITH THE RSI FRAMEWORK (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'filter = only trades whose signal-to-entry range touched a zone of their side; stop = behind the nearest zone of their side;',
    'target = at the nearest opposite zone. "zone k" = trades the zone applied to (filter: kept; stop/target: changed).',
    '  model / variant                                                              n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
    '', 'WHOLE FRAMEWORK (all seven models together)',
  ];
  for (const v of variants) {
    const all = models.flatMap((m) => results.get(`${m}|${v.src}|${v.tf}|${v.use}`)!.trades);
    const hits = models.reduce((a, m) => a + results.get(`${m}|${v.src}|${v.tf}|${v.use}`)!.hit, 0);
    out.push(statsLine(`${label(null, v)}${v.src ? ` (zone ${hits})` : ''}`.padEnd(75), all, cut));
  }
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side})`);
    for (const v of variants) {
      const r = results.get(`${m}|${v.src}|${v.tf}|${v.use}`)!;
      out.push(statsLine(`${label(m, v)}${v.src ? ` (zone ${r.hit})` : ''}`.padEnd(75), r.trades, cut));
    }
  }
  return out;
}
