// Owner 2026-10-08: "Since I can manage trades the DAILY BOTTOM DIVERGENCE can have exit A ... Test results for other
// models also". The live framework models (option 1, the live entry rules and filters) with each exit, A and B, as live
// and without the parts a person managing the trade would do by hand: the time limit and the breakeven move at +2R.
// One trade per model and coin at a time, as live (a longer trade blocks the model's next setup on that coin).

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { specTrade, type ExitSpec } from './exits';
import { BE_R, BTC_SMA, LATE_ATR, LIVE_EXITS, RSI_MODELS, btcBearishAt, frameworkSetups, planSkipsLate, planUsesBe, runBeforeEntry, type RsiModelId } from './rsisignals';
import { flip } from './scalp2';
import { statsLine, type SignalTrade } from './rsitrades';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
const PLAN = 'option 1' as const;

interface Variant { label: string; v: 0 | 1; noCap: boolean; noBe: boolean }
const VARIANTS: Variant[] = [0, 1].flatMap((v) => [
  { label: 'as live', noCap: false, noBe: false },
  { label: 'no time limit', noCap: true, noBe: false },
  { label: 'no breakeven', noCap: false, noBe: true },
  { label: 'no time limit, no breakeven', noCap: true, noBe: true },
].map((x) => ({ ...x, v: v as 0 | 1 })));

export function manualExitReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), BTC_SMA);
  const SEEDS = 20;
  const models = (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped && m !== '15m-rsi10');
  type Row = SignalTrade & { open: boolean; rand: number[] };
  const res = new Map<string, Row[]>(); // model|variant index -> trades
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4f = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const now = d1[d1.length - 1]!.openTime + DAY, h4 = h4f.filter((b) => b.openTime + 4 * 3_600_000 <= now);
    const setups = frameworkSetups(d1, h4);
    VARIANTS.forEach((vr, vi) => {
      const busy = new Map<RsiModelId, number>();
      for (const s of setups) {
        if (!models.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length) continue;
        if (s.known <= (busy.get(s.model) ?? -Infinity)) continue;
        const c = s.c, j = s.j, entry = c[j]!.open;
        if (s.d < 0 && !btcBearishAt(btc, btcSma, c[j]!.openTime)) continue;
        if (planSkipsLate(PLAN, s.model) && runBeforeEntry(c, s.atr, j, s.d, entry) > LATE_ATR) continue;
        const lx = LIVE_EXITS[s.model][vr.v];
        const spec: ExitSpec = { ...lx.spec, ...(planUsesBe(PLAN, s.model) && !vr.noBe ? { be: BE_R } : {}) };
        if (vr.noCap) delete spec.cap;
        const dist = lx.stopMult * s.d * (entry - s.stop);
        const t = specTrade(c, s.atr, {}, j, entry - s.d * dist, s.d, spec);
        if (!t) continue;
        busy.set(s.model, t.open ? Infinity : c[t.end]!.openTime + s.bar);
        if (c[j]!.openTime < from) continue;
        const rand: number[] = [];
        for (let k = 1; k <= SEEDS; k++) {
          const d = (flip(k, sym, j) ? -s.d : s.d) as 1 | -1, x = specTrade(c, s.atr, {}, j, entry - d * dist, d, spec);
          if (x) rand.push(x.r);
        }
        const key = `${s.model}|${vi}`;
        res.set(key, [...(res.get(key) ?? []), { sym, t: c[j]!.openTime, r: t.r, stopPct: t.stopPct, bars: Math.round(((c[t.end]!.openTime - c[j]!.openTime) / DAY)), open: t.open, rand }]);
      }
    });
  }
  const HEAD = '  exit                                                                                  n   win%   avg R  median R    PF   total R  max DD R   stop %  bars   avg R older / newer';
  const out = [`MANUAL-MANAGEMENT EXITS (live entries, ${PLAN}): ${day(from)} to now, ${symbols.length} coins. Older / newer = before / after ${day(cut)}. "open" = still open at the end (marked at the last close). bars = days held.`];
  for (const m of models) {
    out.push('', `${RSI_MODELS[m].label}  (A = ${LIVE_EXITS[m][0].spec.name}; B = ${LIVE_EXITS[m][1].spec.name})`, HEAD);
    VARIANTS.forEach((vr, vi) => {
      const xs = res.get(`${m}|${vi}`) ?? [];
      const a = xs.flatMap((x) => x.rand), rnd = a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN;
      const real = xs.reduce((p, x) => p + x.r, 0) / Math.max(1, xs.length);
      const label = `    ${vr.v === 0 ? 'A' : 'B'}, ${vr.label}`;
      out.push(statsLine(label.padEnd(84), xs, cut) + `   random ${rnd.toFixed(2)}, edge ${(real - rnd).toFixed(2)}  open ${xs.filter((x) => x.open).length}`);
    });
  }
  return out;
}
