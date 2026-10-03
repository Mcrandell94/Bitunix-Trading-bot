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

// ---------------------------------------------------------------------------------------------------------------
// Entering inside the zone (owner 2026-10-03: "test if we took entry 10%-50% into order blocks or supply/demand
// zones after tapping the box; see if deeper zones hit instead; see if S/R channels give confluence"). Rules fixed
// before the run:
//  - after a model's own entry trigger, instead of entering at the next open, wait (20 daily bars; 30 4H bars for
//    the 4H model) for price to reach the nearest zone on the trade's side (long: demand zone whose bottom is under
//    the would-be entry; short: supply zone whose top is over it) and enter with a limit p% into it (0% = the edge;
//    long: top - p x height; a gap through the level fills at the open). Unfilled = no trade.
//  - the model's stop and exits stay (the 3R target and time cap count from the fill); a level beyond the stop = skip.
//    The fill bar counts for the stop (a low under the stop on the fill bar = stopped), not for the target.
//  - deeper zone: the next zone of the same side past the first one (long: top under the first one's bottom).
//  - S/R confluence: the zone overlaps a daily S/R channel (srchannels.ts, the owner's port, defaults) at the trigger.

import { srChannels, type SrChannel } from './srchannels';

function fillTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, k: number, px: number, stop0: number, d: 1 | -1, cap: number, exit: 'hold' | '3R' | 'trail', cost = 0.0022): { r: number; stopPct: number; bars: number; end: number } | null {
  const risk = d * (px - stop0);
  if (!(risk > 0)) return null;
  const last = k + cap - 1;
  if (last >= c.length) return null;
  const target = px + d * 3 * risk;
  let stop = stop0, best = px, armed = false, out = c[last]!.close, end = last;
  for (let i = k; i <= last; i++) {
    const b = c[i]!;
    if (i > k && d * (b.open - stop) <= 0) { out = b.open; end = i; break; }
    if (d > 0 ? b.low <= stop : b.high >= stop) { out = stop; end = i; break; }
    if (i > k && exit === '3R' && (d > 0 ? b.high >= target : b.low <= target)) { out = target; end = i; break; }
    if (exit === 'trail') {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - px) >= risk) armed = true;
      const a = atr[i];
      if (armed && a != null) { const tr = best - d * 3 * a; if (d * (tr - stop) > 0) stop = tr; }
    }
  }
  return { r: (d * (out - px)) / risk - (cost * px) / risk, stopPct: (100 * risk) / px, bars: end - k + 1, end };
}

export function zoneEntryReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const PCTS = [0, 10, 20, 30, 40, 50];
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  type Key = string;
  const trades = new Map<Key, SignalTrade[]>(), counts = new Map<Key, { zone: number; filled: number; skipped: number }>();
  const add = (k: Key, t: SignalTrade) => { const a = trades.get(k) ?? []; a.push(t); trades.set(k, a); };
  const cnt = (k: Key) => { let x = counts.get(k); if (!x) { x = { zone: 0, filled: 0, skipped: 0 }; counts.set(k, x); } return x; };
  const deeper = new Map<string, { tapped: number; broke: number; hit2: number; has2: number }>();

  for (const sym of symbols) {
    const d1 = [...(data[sym]?.candles['1d'] ?? [])], h4 = [...(data[sym]?.candles['4h'] ?? [])], w = weeklyFromDaily(d1);
    const per = (src: Src) => ({ w: zoneReader(src, w, BAR.w), d: zoneReader(src, d1, BAR.d), h4: zoneReader(src, h4, BAR.h4) });
    const readers = { bb: per('bb'), lux: per('lux'), ob: per('ob') };
    const sr = srChannels(d1).channels;
    const srAt = (t: number): ReadonlyArray<SrChannel> => { let i = -1; for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i >= 0 ? sr[i] ?? [] : []; };
    const setups = frameworkSetups(d1, h4);
    // Each variant keeps its own one-trade-at-a-time chain per model.
    const busy = new Map<Key, number>();
    for (const s of setups) {
      if (s.j == null || s.j >= s.c.length || s.stop == null) continue;
      const c = s.c, j = s.j, T = c[j]!.openTime, d = s.d, m = s.model;
      if (T < from) continue;
      const base: Key = `${m}|base`;
      if (s.known > (busy.get(base) ?? -Infinity)) {
        const t = runTrade(c, s.atr, j, s.stop, d, s.cap, s.exit);
        if (t && t.status !== 'open' && c[t.end]!.openTime + s.bar <= to) { add(base, { sym, t: T, r: t.r, stopPct: t.stopPct, bars: t.bars }); busy.set(base, c[t.end]!.openTime + s.bar); }
      }
      const ref = c[j]!.open, wait = s.bar === BAR.h4 ? 30 : 20;
      for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) {
        const tf = tfk === 'own' ? ownTf(m) : altTf(m);
        const side = d > 0 ? 'demand' : 'supply';
        const zs = readers[src][tf](T).filter((z) => z.kind === side && (d > 0 ? z.bottom < ref : z.top > ref))
          .sort((a, b) => (d > 0 ? b.top - a.top : a.bottom - b.bottom));
        const z1 = zs[0];
        if (!z1) continue;
        const z2 = zs.find((z) => (d > 0 ? z.top < z1.bottom : z.bottom > z1.top));
        const srs = srAt(T), conf = srs.some((ch) => ch.lo <= z1.top && ch.hi >= z1.bottom) ? 'S/R yes' : 'S/R no';
        // Deeper-zone stats (within the wait).
        const dk = `${m}|${src}|${tfk}`, ds = deeper.get(dk) ?? { tapped: 0, broke: 0, hit2: 0, has2: 0 };
        let tapped = false, broke = false, hit2 = false;
        for (let k = j; k < Math.min(c.length, j + wait); k++) {
          const b = c[k]!;
          if (d > 0 ? b.low <= z1.top : b.high >= z1.bottom) tapped = true;
          if (tapped && (d > 0 ? b.low < z1.bottom : b.high > z1.top)) broke = true;
          if (z2 && broke && (d > 0 ? b.low <= z2.top : b.high >= z2.bottom)) hit2 = true;
        }
        if (tapped) ds.tapped++; if (broke) ds.broke++; if (z2) ds.has2++; if (hit2) ds.hit2++;
        deeper.set(dk, ds);
        for (const [zn, z] of [[1, z1], [2, z2]] as const) {
          if (!z) continue;
          for (const p of PCTS) {
            const k0: Key = `${m}|${src}|${tfk}|${zn}|${p}`;
            if (s.known <= (busy.get(k0) ?? -Infinity)) continue;
            cnt(k0).zone++;
            const h = z.top - z.bottom, L = d > 0 ? z.top - (p / 100) * h : z.bottom + (p / 100) * h;
            if (d * (L - s.stop) <= 0) { cnt(k0).skipped++; continue; }
            let fill = -1, px = L;
            for (let k = j; k < Math.min(c.length, j + wait); k++) {
              const b = c[k]!;
              if (d > 0 ? b.low <= L : b.high >= L) { fill = k; px = d > 0 ? Math.min(b.open, L) : Math.max(b.open, L); break; }
            }
            if (fill < 0) continue;
            const t = fillTrade(c, s.atr, fill, px, s.stop, d, s.cap, s.exit);
            if (!t || c[t.end]!.openTime + s.bar > to) continue;
            cnt(k0).filled++;
            const tr = { sym, t: c[fill]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars };
            add(k0, tr);
            if (zn === 1) add(`${k0}|${conf}`, tr);
            busy.set(k0, c[t.end]!.openTime + s.bar);
          }
        }
      }
    }
  }

  const out = [
    `ENTRY INSIDE ZONES (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'After the model\'s trigger: wait for price to reach the nearest zone on the trade\'s side, enter p% into it (limit). Model stops / exits kept.',
    'filled = trades taken / setups with such a zone (skipped = entry level beyond the stop). Zone 2 = the next deeper zone.',
    '  model / variant                                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const lineFor = (label: string, k: Key) => {
    const ct = counts.get(k.replace(/\|S\/R (yes|no)$/, ''));
    return statsLine(`${label}${ct && !k.endsWith('yes') && !k.endsWith('no') ? ` (filled ${ct.filled}/${ct.zone}${ct.skipped ? `, skip ${ct.skipped}` : ''})` : ''}`.padEnd(76), trades.get(k) ?? [], cut);
  };
  const sumKeys = (suffix: string) => models.flatMap((m) => trades.get(`${m}|${suffix}`) ?? []);
  out.push('', 'WHOLE FRAMEWORK', statsLine('enter as now (all setups)'.padEnd(76), sumKeys('base'), cut));
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const zn of [1, 2]) for (const p of PCTS) {
    const all = sumKeys(`${src}|${tfk}|${zn}|${p}`);
    const z = models.reduce((a, m) => a + (counts.get(`${m}|${src}|${tfk}|${zn}|${p}`)?.zone ?? 0), 0), f = models.reduce((a, m) => a + (counts.get(`${m}|${src}|${tfk}|${zn}|${p}`)?.filled ?? 0), 0);
    out.push(statsLine(`${SRC_NAME[src]}, ${tfk === 'own' ? 'own TF' : '4H/daily'}, zone ${zn}, ${p}% in (filled ${f}/${z})`.padEnd(76), all, cut));
  }
  out.push('', 'S/R CONFLUENCE (zone 1 entries, whole framework): zone overlapping a daily S/R channel or not');
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const p of [0, 20, 50]) for (const conf of ['S/R yes', 'S/R no']) {
    out.push(statsLine(`${SRC_NAME[src]}, ${tfk === 'own' ? 'own TF' : '4H/daily'}, ${p}% in, ${conf}`.padEnd(76), sumKeys(`${src}|${tfk}|1|${p}|${conf}`), cut));
  }
  out.push('', 'DEEPER ZONES (within the wait, per setup with a zone 1): tapped zone 1 / broke through zone 1 / had a zone 2 / hit zone 2 after breaking zone 1');
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) {
    const t = models.reduce((a, m) => { const x = deeper.get(`${m}|${src}|${tfk}`); return x ? { tapped: a.tapped + x.tapped, broke: a.broke + x.broke, has2: a.has2 + x.has2, hit2: a.hit2 + x.hit2 } : a; }, { tapped: 0, broke: 0, has2: 0, hit2: 0 });
    out.push(`  ${`${SRC_NAME[src]}, ${tfk === 'own' ? 'own TF' : '4H/daily'}`.padEnd(40)} tapped ${t.tapped}, broke ${t.broke}, had zone 2 ${t.has2}, hit zone 2 ${t.hit2}`);
  }
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side})`, statsLine('enter as now'.padEnd(76), trades.get(`${m}|base`) ?? [], cut));
    for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const zn of [1, 2]) for (const p of PCTS) {
      const k: Key = `${m}|${src}|${tfk}|${zn}|${p}`;
      if (!(counts.get(k)?.zone)) continue;
      out.push(lineFor(`${SRC_NAME[src]}, ${tfk === 'own' ? TF_NAME[ownTf(m)] : TF_NAME[altTf(m)]}, zone ${zn}, ${p}% in`, k));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Scaled entry (owner 2026-10-03: "Let's try fills at 10-20-30%"). After the trigger, three equal limit orders sit
// 10%, 20% and 30% into the nearest zone on the trade's side (as in zoneEntryReport). Sized so the three together risk
// 1R to the model's stop: a trade where only some fill risks less. Orders work for the same wait (20 daily / 30 4H
// bars from the entry bar) and stop once the trade is out. The model's stop and exits act on the whole position; the
// 3R target and the trail's 1R arming count from the planned average entry, the time cap from the first fill. A level
// beyond the stop is dropped; a level past the price at the trigger is set at that price (it fills at once). Variant "or now": a setup with no such zone at the trigger enters as now instead.

const LADDER = [10, 20, 30];

export function ladderTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, j: number, wait: number, levels: number[], stop0: number, d: 1 | -1, cap: number, exit: 'hold' | '3R' | 'trail', cost = 0.0022): { r: number; fills: number; start: number; end: number; stopPct: number } | null {
  const risk = levels.reduce((a, L) => a + d * (L - stop0), 0);
  if (!(risk > 0)) return null;
  const u = 1 / risk, avg = levels.reduce((a, b) => a + b, 0) / levels.length, unit = d * (avg - stop0);
  const target = avg + d * 3 * unit;
  const px: (number | null)[] = levels.map(() => null);
  const hits = (b: Candle, L: number) => (d > 0 ? b.low <= L : b.high >= L);
  let k0 = -1;
  for (let k = j; k < Math.min(c.length, j + wait); k++) if (levels.some((L) => hits(c[k]!, L))) { k0 = k; break; }
  if (k0 < 0) return null;
  const last = k0 + cap - 1;
  if (last >= c.length) return null;
  let stop = stop0, best = avg, armed = false, out = c[last]!.close, end = last;
  for (let i = k0; i <= last; i++) {
    const b = c[i]!;
    if (i > k0 && d * (b.open - stop) <= 0) { out = b.open; end = i; break; }
    if (i < j + wait) levels.forEach((L, n) => { if (px[n] == null && hits(b, L)) px[n] = d > 0 ? Math.min(b.open, L) : Math.max(b.open, L); });
    if (d > 0 ? b.low <= stop : b.high >= stop) { out = stop; end = i; break; }
    if (i > k0 && exit === '3R' && (d > 0 ? b.high >= target : b.low <= target)) { out = target; end = i; break; }
    if (exit === 'trail') {
      if (d * (b.close - best) > 0) best = b.close;
      if (d * (best - avg) >= unit) armed = true;
      const a = atr[i];
      if (armed && a != null) { const tr = best - d * 3 * a; if (d * (tr - stop) > 0) stop = tr; }
    }
  }
  let r = 0, fills = 0;
  for (const p of px) if (p != null) { fills++; r += u * (d * (out - p) - cost * p); }
  return { r, fills, start: k0, end, stopPct: (100 * unit) / avg };
}

export function ladderReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const trades = new Map<string, SignalTrade[]>(), fills = new Map<string, number[]>();
  const add = (k: string, t: SignalTrade) => { const a = trades.get(k) ?? []; a.push(t); trades.set(k, a); };
  const addFill = (k: string, n: number) => { const a = fills.get(k) ?? [0, 0, 0, 0]; a[n]!++; fills.set(k, a); };
  for (const sym of symbols) {
    const d1 = [...(data[sym]?.candles['1d'] ?? [])], h4 = [...(data[sym]?.candles['4h'] ?? [])], w = weeklyFromDaily(d1);
    const per = (src: Src) => ({ w: zoneReader(src, w, BAR.w), d: zoneReader(src, d1, BAR.d), h4: zoneReader(src, h4, BAR.h4) });
    const readers = { bb: per('bb'), lux: per('lux'), ob: per('ob') };
    const sr = srChannels(d1).channels;
    const srAt = (t: number): ReadonlyArray<SrChannel> => { let i = -1; for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i >= 0 ? sr[i] ?? [] : []; };
    const busy = new Map<string, number>();
    const free = (k: string, known: number) => known > (busy.get(k) ?? -Infinity);
    const base = (s: Setup) => { const t = runTrade(s.c, s.atr, s.j!, s.stop!, s.d, s.cap, s.exit); return t && t.status !== 'open' && s.c[t.end]!.openTime + s.bar <= to ? { tr: { sym, t: s.c[s.j!]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars }, end: s.c[t.end]!.openTime + s.bar } : null; };
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null) continue;
      const c = s.c, j = s.j, T = c[j]!.openTime, d = s.d, m = s.model;
      if (T < from) continue;
      if (free(`${m}|base`, s.known)) { const b = base(s); if (b) { add(`${m}|base`, b.tr); busy.set(`${m}|base`, b.end); } }
      const wait = s.bar === BAR.h4 ? 30 : 20;
      for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) {
        const tf = tfk === 'own' ? ownTf(m) : altTf(m);
        const z1 = readers[src][tf](T).filter((z) => z.kind === (d > 0 ? 'demand' : 'supply') && (d > 0 ? z.bottom < c[j]!.open : z.top > c[j]!.open))
          .sort((a, b) => (d > 0 ? b.top - a.top : a.bottom - b.bottom))[0];
        const conf = z1 && srAt(T).some((ch) => ch.lo <= z1.top && ch.hi >= z1.bottom) ? 'S/R yes' : 'S/R no';
        for (const mode of ['ladder', 'or now'] as const) {
          const k = `${m}|${src}|${tfk}|${mode}`;
          if (!free(k, s.known)) continue;
          if (!z1) {
            if (mode === 'or now') { const b = base(s); if (b) { add(k, b.tr); busy.set(k, b.end); addFill(k, 0); } }
            continue;
          }
          const h = z1.top - z1.bottom;
          // Price already inside the zone: an order above it (long) fills at once at the open, so size it there.
          const ref = c[j]!.open;
          const levels = LADDER.map((p) => (d > 0 ? z1.top - (p / 100) * h : z1.bottom + (p / 100) * h)).map((L) => (d > 0 ? Math.min(L, ref) : Math.max(L, ref))).filter((L) => d * (L - s.stop!) > 0);
          if (!levels.length) continue;
          const t = ladderTrade(c, s.atr, j, wait, levels, s.stop, d, s.cap, s.exit);
          if (!t || c[t.end]!.openTime + s.bar > to) continue;
          const tr = { sym, t: c[t.start]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.end - t.start + 1 };
          add(k, tr); addFill(k, t.fills); busy.set(k, c[t.end]!.openTime + s.bar);
          if (mode === 'ladder') add(`${k}|${conf}`, tr);
        }
      }
    }
  }
  const tfName = (tfk: 'own' | 'alt') => (tfk === 'own' ? 'own TF' : '4H/daily');
  const fillNote = (keys: string[]) => { const f = keys.reduce((a, k) => { const x = fills.get(k) ?? [0, 0, 0, 0]; return a.map((v, i) => v + x[i]!); }, [0, 0, 0, 0]); return `1/2/3 filled ${f[1]}/${f[2]}/${f[3]}${f[0] ? `, now ${f[0]}` : ''}`; };
  const all = (suffix: string) => models.flatMap((m) => trades.get(`${m}|${suffix}`) ?? []);
  const out = [
    `SCALED ENTRY 10/20/30% INTO ZONES (test): ${day(from)} to ${day(to)}, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`,
    'Three equal limit orders 10/20/30% into the nearest zone on the trade\'s side; all three together risk 1R (fewer fills = less risk).',
    '"or now" = a setup with no such zone at the trigger enters as now. R is per planned 1R.',
    '  model / variant                                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
    '', 'WHOLE FRAMEWORK', statsLine('enter as now'.padEnd(76), all('base'), cut),
  ];
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const mode of ['ladder', 'or now'] as const) {
    out.push(statsLine(`${SRC_NAME[src]}, ${tfName(tfk)}, ${mode} (${fillNote(models.map((m) => `${m}|${src}|${tfk}|${mode}`))})`.padEnd(76), all(`${src}|${tfk}|${mode}`), cut));
  }
  out.push('', 'S/R CONFLUENCE (ladder trades): zone overlapping a daily S/R channel or not');
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const conf of ['S/R yes', 'S/R no']) {
    out.push(statsLine(`${SRC_NAME[src]}, ${tfName(tfk)}, ${conf}`.padEnd(76), all(`${src}|${tfk}|ladder|${conf}`), cut));
  }
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side})`, statsLine('enter as now'.padEnd(76), trades.get(`${m}|base`) ?? [], cut));
    for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const mode of ['ladder', 'or now'] as const) {
      const k = `${m}|${src}|${tfk}|${mode}`;
      out.push(statsLine(`${SRC_NAME[src]}, ${TF_NAME[tfk === 'own' ? ownTf(m) : altTf(m)]}, ${mode} (${fillNote([k])})`.padEnd(76), trades.get(k) ?? [], cut));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-model entry optimisation (owner 2026-10-03: "Let's optimize all the models"). Each model picks one entry from:
// enter as now, or a single full entry p% (0-50) into the nearest zone (3 sources x own / alt timeframe), with no-zone
// handling "skip" (zone only) or "or now" (no zone at the trigger = enter as now), and zones "any" or "S/R" (only a
// zone overlapping a daily S/R channel counts as a zone). Walk-forward: the pick is made on the older trades only
// (before the cut), with two objectives (total R; total R / max DD, min 8 older trades), then shown on the newer
// trades it never saw. Stops and exits are each model's own.

/** Zone depths the optimiser may use: `--depths 10,20,30` (owner 2026-10-03: entries only 10-30% into a zone). */
function optDepths(): number[] {
  const i = process.argv.indexOf('--depths');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]!.split(',').map(Number) : [0, 10, 20, 30, 40, 50];
}

interface EntryVariant { src: Src; tfk: 'own' | 'alt'; p: number; mode: 'skip' | 'or now'; sr: 'any' | 'S/R' }
const vKey = (v: EntryVariant | null) => (v ? `${SRC_NAME[v.src]}, ${v.tfk === 'own' ? 'own TF' : 'alt TF'}, ${v.p}% in, ${v.mode}, ${v.sr === 'S/R' ? 'S/R zones' : 'any zone'}` : 'enter as now');

function entryVariantTrades(data: Data, symbols: ReadonlyArray<string>, from: number, to: number): Map<RsiModelId, Map<string, SignalTrade[]>> {
  const variants: (EntryVariant | null)[] = [null];
  for (const src of ['bb', 'lux', 'ob'] as Src[]) for (const tfk of ['own', 'alt'] as const) for (const p of optDepths()) for (const mode of ['skip', 'or now'] as const) for (const sr of ['any', 'S/R'] as const) variants.push({ src, tfk, p, mode, sr });
  const out = new Map<RsiModelId, Map<string, SignalTrade[]>>();
  const add = (m: RsiModelId, k: string, t: SignalTrade) => { let a = out.get(m); if (!a) { a = new Map(); out.set(m, a); } const l = a.get(k) ?? []; l.push(t); a.set(k, l); };
  for (const sym of symbols) {
    const d1 = [...(data[sym]?.candles['1d'] ?? [])], h4 = [...(data[sym]?.candles['4h'] ?? [])], w = weeklyFromDaily(d1);
    const per = (src: Src) => ({ w: zoneReader(src, w, BAR.w), d: zoneReader(src, d1, BAR.d), h4: zoneReader(src, h4, BAR.h4) });
    const readers = { bb: per('bb'), lux: per('lux'), ob: per('ob') };
    const sr = srChannels(d1).channels;
    const srAt = (t: number): ReadonlyArray<SrChannel> => { let i = -1; for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= t) { i = m; lo = m + 1; } else hi = m - 1; } return i >= 0 ? sr[i] ?? [] : []; };
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (s.j == null || s.j >= s.c.length || s.stop == null) continue;
      const c = s.c, j = s.j, T = c[j]!.openTime, d = s.d, m = s.model;
      if (T < from) continue;
      const wait = s.bar === BAR.h4 ? 30 : 20, ref = c[j]!.open;
      const z1Cache = new Map<string, Zone | undefined>();
      const nearest = (src: Src, tfk: 'own' | 'alt') => {
        const key = `${src}|${tfk}`;
        if (!z1Cache.has(key)) {
          const tf = tfk === 'own' ? ownTf(m) : altTf(m);
          z1Cache.set(key, readers[src][tf](T).filter((z) => z.kind === (d > 0 ? 'demand' : 'supply') && (d > 0 ? z.bottom < ref : z.top > ref)).sort((a, b) => (d > 0 ? b.top - a.top : a.bottom - b.bottom))[0]);
        }
        return z1Cache.get(key);
      };
      const srs = srAt(T);
      for (const v of variants) {
        const k = vKey(v);
        if (s.known <= (busy.get(`${m}|${k}`) ?? -Infinity)) continue;
        let z = v ? nearest(v.src, v.tfk) : undefined;
        if (z && v!.sr === 'S/R' && !srs.some((ch) => ch.lo <= z!.top && ch.hi >= z!.bottom)) z = undefined;
        if (!v || (!z && v.mode === 'or now')) {
          const t = runTrade(c, s.atr, j, s.stop, d, s.cap, s.exit);
          if (t && t.status !== 'open' && c[t.end]!.openTime + s.bar <= to) { add(m, k, { sym, t: T, r: t.r, stopPct: t.stopPct, bars: t.bars }); busy.set(`${m}|${k}`, c[t.end]!.openTime + s.bar); }
          continue;
        }
        if (!z) continue;
        const h = z.top - z.bottom, L = d > 0 ? z.top - (v.p / 100) * h : z.bottom + (v.p / 100) * h;
        if (d * (L - s.stop) <= 0) continue;
        let fill = -1, px = L;
        for (let k2 = j; k2 < Math.min(c.length, j + wait); k2++) { const b = c[k2]!; if (d > 0 ? b.low <= L : b.high >= L) { fill = k2; px = d > 0 ? Math.min(b.open, L) : Math.max(b.open, L); break; } }
        if (fill < 0) continue;
        const t = fillTrade(c, s.atr, fill, px, s.stop, d, s.cap, s.exit);
        if (!t || c[t.end]!.openTime + s.bar > to) continue;
        add(m, k, { sym, t: c[fill]!.openTime, r: t.r, stopPct: t.stopPct, bars: t.bars });
        busy.set(`${m}|${k}`, c[t.end]!.openTime + s.bar);
      }
    }
  }
  return out;
}

const totalR = (ts: ReadonlyArray<SignalTrade>) => ts.reduce((a, t) => a + t.r, 0);
function maxDd(ts: ReadonlyArray<SignalTrade>): number {
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...ts].sort((a, b) => a.t - b.t)) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return dd;
}

export function optimiseEntriesReport(data: Data, symbols: ReadonlyArray<string>, from: number, to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const all = entryVariantTrades(data, symbols, from, to);
  const models = Object.keys(RSI_MODELS) as RsiModelId[];
  const objectives: { name: string; score: (ts: SignalTrade[]) => number | null }[] = [
    { name: 'most total R (older)', score: (ts) => (ts.length >= 5 ? totalR(ts) : null) },
    { name: 'total R / max DD (older, min 8 trades)', score: (ts) => (ts.length >= 8 ? totalR(ts) / Math.max(maxDd(ts), 1) : null) },
  ];
  const out = [
    `PER-MODEL ENTRY OPTIMISATION (walk-forward): ${day(from)} to ${day(to)}, ${symbols.length} coins. Picked on trades before ${day(cut)}, shown after.`,
    `Choices per model: enter as now, or one full entry ${optDepths().join('/')}% into the nearest zone (BigBeluga / LuxAlgo range / order blocks, own or alt TF),`,
    '"skip" = no zone, no trade; "or now" = no zone, enter as now; "S/R zones" = only zones overlapping a daily S/R channel. Stops / exits unchanged.',
    '  model / variant                                                                n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer',
  ];
  const picks: Record<string, SignalTrade[]> = {};
  for (const o of objectives) picks[o.name] = [];
  for (const m of models) {
    const vs = all.get(m) ?? new Map<string, SignalTrade[]>();
    const base = vs.get('enter as now') ?? [];
    out.push('', `${RSI_MODELS[m].label} (${RSI_MODELS[m].side})`, statsLine('enter as now'.padEnd(76), base, cut));
    for (const o of objectives) {
      const ranked = [...vs.entries()].map(([k, ts]) => ({ k, ts, sc: o.score(ts.filter((t) => t.t < cut)) })).filter((x) => x.sc != null).sort((a, b) => b.sc! - a.sc!);
      const best = ranked[0];
      if (!best) continue;
      picks[o.name]!.push(...best.ts);
      const newer = (ts: SignalTrade[]) => ts.filter((t) => t.t >= cut);
      out.push(statsLine(`best by ${o.name}: ${best.k}`.slice(0, 120).padEnd(76), best.ts, cut));
      out.push(`      newer only: picked ${newer(best.ts).length} trades ${totalR(newer(best.ts)).toFixed(1)} R (DD ${maxDd(newer(best.ts)).toFixed(1)}) vs enter as now ${newer(base).length} trades ${totalR(newer(base)).toFixed(1)} R (DD ${maxDd(newer(base)).toFixed(1)}); runners-up: ${ranked.slice(1, 4).map((x) => x.k).join(' | ')}`);
    }
  }
  out.push('', 'WHOLE FRAMEWORK with each model\'s pick', statsLine('enter as now (all models)'.padEnd(76), models.flatMap((m) => all.get(m)?.get('enter as now') ?? []), cut));
  for (const o of objectives) {
    const ts = picks[o.name]!, nw = ts.filter((t) => t.t >= cut);
    out.push(statsLine(`picks by ${o.name}`.padEnd(76), ts, cut), `      newer only: ${nw.length} trades ${totalR(nw).toFixed(1)} R, DD ${maxDd(nw).toFixed(1)}`);
  }
  const nb = models.flatMap((m) => all.get(m)?.get('enter as now') ?? []).filter((t) => t.t >= cut);
  out.push(`      enter as now, newer only: ${nb.length} trades ${totalR(nb).toFixed(1)} R, DD ${maxDd(nb).toFixed(1)}`);
  return out;
}
