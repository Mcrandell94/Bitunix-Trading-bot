// Owner 2026-10-09: a zone indicator from FVGs, S/R channels and order blocks, LuxAlgo Smart Money Concepts as the template
// (smclux.ts, zonescore.ts). Rules fixed before the run (docs: plan "Zone indicator"):
// A. Standalone: touch and reject on 4H and 1D. Long when the bar's low trades into a bullish zone alive before the bar,
//    the bar closes above the zone top and the low stays above the zone bottom; shorts mirror. Zone kinds: internal OB,
//    swing OB, FVG, deep S/R channel, any 2+ kinds. Context: none / discount (premium for shorts) / swing trend with /
//    both. Entry next open; stop beyond the zone (or the bar's extreme) + 0.25 ATR(14); exits 2R, 3R, 5R with a cap
//    (4H 30 days, 1D 90 days) and 5R with breakeven at +2R. One trade per coin per line. Random direction: 10 seeds.
// B. Confirmation: the live models' trades (option 1, the picked exits) split by the zone score at entry, by discount /
//    premium and by the swing trend.
// C. Chart check: the last structure events and the zones alive now for ETH and SOL, to compare with TradingView.

import type { Candle } from '@bot/marketdata';
import { atrWilder, sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { BE_R, BTC_SMA, LATE_ATR, LIVE_EXITS, RSI_MODELS, btcBearishAt, frameworkSetups, planSkipsLate, planUsesBe, runBeforeEntry, type RsiModelId } from './rsisignals';
import { flip } from './scalp2';
import { statsLine, type SignalTrade } from './rsitrades';
import { smcLux, smcZoneCursor, type Bias } from './smclux';
import { srChannels } from './srchannels';
import { rangePos, zoneHitsAt, zoneScore, type TfZones, type ZoneKind, type ZoneTf } from './zonescore';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000, H4 = 4 * 3_600_000;
const KINDS: (ZoneKind | '2+')[] = ['ob-internal', 'ob-swing', 'fvg', 'sr-deep', '2+'];
const CTX = ['none', 'discount', 'trend', 'both'] as const;
const KIND_LABEL: Record<ZoneKind | '2+', string> = { 'ob-internal': 'internal OB', 'ob-swing': 'swing OB', fvg: 'FVG', 'sr-deep': 'deep S/R', '2+': 'any 2+ kinds' };
const exitsFor = (tf: ZoneTf): ExitSpec[] => {
  const cap = tf === '4h' ? 180 : 90;
  return [{ name: '2R', target: 2, cap }, { name: '3R', target: 3, cap }, { name: '5R', target: 5, cap }, { name: '5R, breakeven +2R', target: 5, be: 2, cap }];
};
const LIVE_PICK: Partial<Record<RsiModelId, 0 | 1>> = { 'bottom-div': 0, 'triple-div': 1 }; // the rest: A (owner's settings 2026-10-08)
type Row = SignalTrade & { rand: number[] };
export type EdgeRow = Row;
export const STATS_HEAD = '  line                                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';

/** A stats line with the random-direction mean and the edge, and whether it passes the gate (n >= 30, avg R > 0 before
 * and after the cut, edge >= +0.10 R). */
export function edgeLine(label: string, xs: ReadonlyArray<Row>, cut: number): { line: string; pass: boolean } {
  const rr = xs.flatMap((x) => x.rand), rnd = rr.reduce((p, q) => p + q, 0) / Math.max(1, rr.length), real = xs.reduce((p, x) => p + x.r, 0) / Math.max(1, xs.length);
  const line = statsLine(label, [...xs], cut) + `   random ${rnd.toFixed(2)}, edge ${(real - rnd).toFixed(2)}`;
  const old = xs.filter((x) => x.t < cut), neu = xs.filter((x) => x.t >= cut), avg = (a: Row[]) => a.reduce((p, x) => p + x.r, 0) / Math.max(1, a.length);
  return { line, pass: xs.length >= 30 && old.length > 0 && neu.length > 0 && avg(old) > 0 && avg(neu) > 0 && real - rnd >= 0.1 };
}

function tfZones(tf: ZoneTf, c: ReadonlyArray<Candle>): TfZones {
  return { tf, c, smc: smcLux(c), sr: srChannels(c) };
}

export function smcReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out = [`SMC ZONE INDICATOR (LuxAlgo Smart Money Concepts port + deep S/R channels): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}.`];
  const A = new Map<string, Row[]>();
  const B: { model: RsiModelId; sym: string; t: number; r: number; stopPct: number; bars: number; score: number; pos: number; trendWith: boolean; labels: string[] }[] = [];
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), BTC_SMA);
  const chart: string[] = [];

  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4all = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = h4all.filter((b) => b.openTime + H4 <= now);
    const Z: Record<ZoneTf, TfZones> = { '4h': tfZones('4h', h4), '1d': tfZones('1d', d1) };

    // A. Standalone touch-and-reject signals.
    for (const tf of ['4h', '1d'] as ZoneTf[]) {
      const z = Z[tf], c = z.c, atr = atrWilder(c, 14), at = smcZoneCursor(z.smc), exits = exitsFor(tf), busy = new Map<string, number>();
      for (let t = 250; t < c.length - 1; t++) {
        const alive = at(t), b = c[t]!, a = atr[t];
        if (a == null || c[t + 1]!.openTime < from) continue;
        for (const side of [1, -1] as Bias[]) {
          // Rejections by kind, with the far edge of the zone for the stop.
          const rej = new Map<ZoneKind, number>();
          for (const h of zoneHitsAt(z, t, side, b.low, b.high, alive, false)) {
            const ok = side === 1 ? b.low <= h.top && b.close > h.top && b.low >= h.bottom : b.high >= h.bottom && b.close < h.bottom && b.high <= h.top;
            if (!ok) continue;
            const far = side === 1 ? h.bottom : h.top, prev = rej.get(h.kind);
            rej.set(h.kind, prev == null ? far : side === 1 ? Math.min(prev, far) : Math.max(prev, far));
          }
          if (!rej.size) continue;
          const pos = rangePos(z.smc, t, b.close), disc = side === 1 ? pos < 0.5 : pos > 0.5, trendWith = z.smc.swingTrend[t] === side;
          const j = t + 1, entry = c[j]!.open;
          for (const kind of KINDS) {
            let far: number | undefined;
            if (kind === '2+') { if (rej.size < 2) continue; far = side === 1 ? Math.min(...rej.values()) : Math.max(...rej.values()); }
            else far = rej.get(kind);
            if (far == null) continue;
            const stop = side === 1 ? Math.min(far, b.low) - 0.25 * a : Math.max(far, b.high) + 0.25 * a;
            if (!(side * (entry - stop) > 0)) continue;
            // The trade (and its random twins) is the same for every context: simulate once per exit, when first needed.
            const memo = new Map<string, { tr: NonNullable<ReturnType<typeof specTrade>>; rand: number[] } | null>();
            const sim = (ex: ExitSpec) => {
              if (!memo.has(ex.name)) {
                const tr = specTrade(c, atr, {}, j, stop, side, ex);
                const rand: number[] = [];
                if (tr) for (let k = 1; k <= 10; k++) {
                  const d = (flip(k, sym, j) ? -side : side) as 1 | -1, dist = Math.abs(entry - stop), x = specTrade(c, atr, {}, j, entry - d * dist, d, ex);
                  if (x) rand.push(x.r);
                }
                memo.set(ex.name, tr ? { tr, rand } : null);
              }
              return memo.get(ex.name)!;
            };
            for (const ctx of CTX) {
              if ((ctx === 'discount' || ctx === 'both') && !disc) continue;
              if ((ctx === 'trend' || ctx === 'both') && !trendWith) continue;
              for (const ex of exits) {
                const key = `${tf}|${side}|${kind}|${ctx}|${ex.name}`;
                if (t <= (busy.get(key) ?? -1)) continue;
                const m = sim(ex);
                if (!m) continue;
                const { tr, rand } = m;
                busy.set(key, tr.open ? Infinity : tr.end);
                const list = A.get(key) ?? [];
                list.push({ sym, t: c[j]!.openTime, r: tr.r, stopPct: tr.stopPct, bars: Math.round((c[tr.end]!.openTime - c[j]!.openTime) / DAY), rand });
                A.set(key, list);
              }
            }
          }
        }
      }
    }

    // B. The live models' trades, scored at entry (the signal bar = the bar before the entry).
    const busyB = new Map<RsiModelId, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (RSI_MODELS[s.model].dropped || s.j == null || s.stop == null || s.j >= s.c.length || s.known <= (busyB.get(s.model) ?? -Infinity)) continue;
      const c = s.c, j = s.j, entry = c[j]!.open;
      if (s.d < 0 && !btcBearishAt(btc, btcSma, c[j]!.openTime)) continue;
      if (planSkipsLate('option 1', s.model) && runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR) continue;
      const lx = LIVE_EXITS[s.model][LIVE_PICK[s.model] ?? 0];
      const spec: ExitSpec = { ...lx.spec, ...(planUsesBe('option 1', s.model) ? { be: BE_R } : {}) };
      const dist = lx.stopMult * s.d * (entry - s.stop), tr = specTrade(c, s.atr, {}, j, entry - s.d * dist, s.d, spec);
      if (!tr) continue;
      busyB.set(s.model, tr.open ? Infinity : c[tr.end]!.openTime + s.bar);
      if (c[j]!.openTime < from || j < 1) continue;
      const tf: ZoneTf = s.bar === H4 ? '4h' : '1d', z = Z[tf], sig = c[j - 1]!, side = s.d as Bias;
      const hits = zoneHitsAt(z, j - 1, side, sig.low, sig.high);
      if (tf === '4h') {
        // The daily zones as of the last daily close before the 4H signal bar closed.
        const closeT = sig.openTime + H4;
        let k = -1;
        for (let lo = 0, hi = d1.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (d1[m]!.openTime + DAY <= closeT) { k = m; lo = m + 1; } else hi = m - 1; }
        if (k >= 1) hits.push(...zoneHitsAt(Z['1d'], k + 1, side, sig.low, sig.high));
      }
      const pos = rangePos(z.smc, j - 1, sig.close), trendWith = z.smc.swingTrend[j - 1] === side;
      const sc = zoneScore({ hits, discount: side === 1 ? pos < 0.5 : pos > 0.5, trendWith });
      B.push({ model: s.model, sym, t: c[j]!.openTime, r: tr.r, stopPct: tr.stopPct, bars: Math.round((c[tr.end]!.openTime - c[j]!.openTime) / DAY), score: sc.score, pos, trendWith, labels: sc.labels });
    }

    // C. Chart check.
    if (sym === 'ETHUSDT' || sym === 'SOLUSDT') {
      for (const tf of ['4h', '1d'] as ZoneTf[]) {
        const z = Z[tf], c = z.c, last = c.length - 1, ts = (i: number) => new Date(c[i]!.openTime).toISOString().slice(0, 16).replace('T', ' ');
        chart.push('', `${sym} ${tf === '4h' ? '4H' : '1D'}: last structure events (bar open time, UTC)`);
        for (const e of z.smc.events.slice(-10)) chart.push(`  ${ts(e.t)}  ${e.scope.padEnd(8)} ${e.dir === 1 ? 'bullish' : 'bearish'} ${e.kind.padEnd(5)} level ${Number(e.level.toPrecision(6))}`);
        chart.push(`  swing trend now: ${z.smc.swingTrend[last] === 1 ? 'bullish' : z.smc.swingTrend[last] === -1 ? 'bearish' : '-'}; internal: ${z.smc.internalTrend[last] === 1 ? 'bullish' : z.smc.internalTrend[last] === -1 ? 'bearish' : '-'}; swing range ${Number(z.smc.trailBottom[last]!.toPrecision(6))} - ${Number(z.smc.trailTop[last]!.toPrecision(6))}`);
        chart.push('  zones shown now (kind, bias, bottom - top, candle):');
        for (const x of smcZoneCursor(z.smc)(last + 1)) chart.push(`    ${x.kind.padEnd(11)} ${x.bias === 1 ? 'bullish' : 'bearish'}  ${Number(x.bottom.toPrecision(6))} - ${Number(x.top.toPrecision(6))}  (${ts(x.from)})`);
        for (const ch of z.sr.channels[last] ?? []) chart.push(`    S/R channel ${Number(ch.lo.toPrecision(6))} - ${Number(ch.hi.toPrecision(6))} (${ch.pivots} pivots)`);
      }
    }
  }

  // A. Report: every line, then the ones that pass.
  const HEAD = STATS_HEAD;
  const pass: string[] = [];
  for (const tf of ['4h', '1d'] as ZoneTf[]) for (const side of [1, -1] as Bias[]) {
    out.push('', `A. TOUCH AND REJECT, ${tf === '4h' ? '4H' : '1D'} ${side === 1 ? 'LONGS (bullish zones)' : 'SHORTS (bearish zones)'}`, HEAD);
    for (const kind of KINDS) for (const ctx of CTX) for (const ex of exitsFor(tf)) {
      const xs = A.get(`${tf}|${side}|${kind}|${ctx}|${ex.name}`) ?? [];
      if (!xs.length) continue;
      const { line, pass: ok } = edgeLine(`    ${KIND_LABEL[kind]}, ${ctx}, ${ex.name}`.padEnd(84), xs, cut);
      out.push(line);
      if (ok) pass.push(`  ${tf === '4h' ? '4H' : '1D'} ${side === 1 ? 'long ' : 'short'} ${line.trim()}`);
    }
  }
  out.push('', `A. LINES THAT PASS ON THIS COIN SET (n >= 30, avg R > 0 in both periods, edge >= +0.10 vs random): ${pass.length}`, ...pass);

  // B. Report.
  const st = (xs: typeof B): SignalTrade[] => xs.map((x) => ({ sym: x.sym, t: x.t, r: x.r, stopPct: x.stopPct, bars: x.bars }));
  const bucket = (x: (typeof B)[number]) => (x.score <= 0 ? '0' : x.score < 4 ? '1-3' : x.score < 7 ? '4-6' : '7+');
  out.push('', 'B. LIVE MODELS (option 1, picked exits) BY ZONE SCORE AT ENTRY (signal bar; 4H trades also count daily zones)', HEAD);
  const groups: [string, typeof B][] = [['ALL MODELS', B], ...[...new Set(B.map((x) => x.model))].map((m) => [RSI_MODELS[m].label, B.filter((x) => x.model === m)] as [string, typeof B])];
  for (const [name, xs] of groups) {
    out.push(`  ${name}`);
    for (const b of ['0', '1-3', '4-6', '7+']) { const g = xs.filter((x) => bucket(x) === b); if (g.length) out.push(statsLine(`      zone score ${b}`.padEnd(84), st(g), cut)); }
    const disc = xs.filter((x) => Number.isFinite(x.pos)), withSide = (x: (typeof B)[number]) => ((RSI_MODELS[x.model].side === 'long') === (x.pos < 0.5));
    if (disc.length) { out.push(statsLine('      discount for longs / premium for shorts'.padEnd(84), st(disc.filter(withSide)), cut)); out.push(statsLine('      the other half of the range'.padEnd(84), st(disc.filter((x) => !withSide(x))), cut)); }
    out.push(statsLine('      swing trend with the trade'.padEnd(84), st(xs.filter((x) => x.trendWith)), cut));
    out.push(statsLine('      swing trend against'.padEnd(84), st(xs.filter((x) => !x.trendWith)), cut));
  }
  const top = [...B].sort((a, b) => b.t - a.t).slice(0, 8);
  out.push('', '  latest live-model trades with their zone labels (to sanity-check):');
  for (const x of top) out.push(`    ${day(x.t)} ${x.sym.padEnd(14)} ${RSI_MODELS[x.model].label.padEnd(28)} score ${x.score.toFixed(1).padStart(4)}  ${x.labels.join(' + ') || '-'}  R ${x.r.toFixed(2)}`);

  out.push('', 'C. CHART CHECK (compare with LuxAlgo Smart Money Concepts on TradingView, default settings, Bitunix perp)', ...chart);
  return out;
}

