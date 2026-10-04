// Loss post-mortem of the live models (owner 2026-10-04: "look back at trades taken and figure out when it went wrong
// on the chart, maybe it was noise, maybe the moves are already playing out by the time we enter, or is it going the
// wrong way entirely after"). Research only. Every trade of the live models (version A exits, as the dashboard shows
// them), research coins. For each losing trade (R <= 0) the path is split three ways:
//  - before entry: how far price had already moved the trade's way from the setup's swing extreme (the lowest low of
//    the 10 bars before entry for longs, highest high for shorts), in ATR and as a share of the stop distance;
//  - during the trade: the best (MFE) and worst (MAE) excursion in R;
//  - after the exit: over the same number of bars as the model's cap, whether price came back through the entry and
//    whether it reached +2R from the entry the trade's way.
// Loser types (first that applies):
//  - 'gave it back': MFE >= 1R before the loss (the move came, the exit did not keep it);
//  - 'noise stop': stopped with MFE < 1R, then price reached +2R the trade's way after the stop (direction right,
//    stop too tight or entry too early);
//  - 'wrong way': stopped with MFE < 0.5R and price never got back to the entry afterwards (the idea was wrong);
//  - 'time / chop': closed by the time limit, or none of the above.
// Then: avg R by how far the move had run before entry (quartiles), by stop width (quartiles), and by the BTC daily
// trend at entry (close vs 50-day SMA, with / against the trade). Plus the worst trades per type with dates, to look
// at on the chart.

import type { Candle } from '@bot/marketdata';
import { sma } from '../indicators';
import { specTrade } from './exits';
import { frameworkSetups, LIVE_EXITS, RSI_MODELS, type RsiModelId } from './rsisignals';

type Data = Readonly<Record<string, { candles: Partial<Record<string, ReadonlyArray<Candle>>> }>>;
const DAY = 86_400_000;
type Kind = 'winner' | 'gave it back' | 'noise stop' | 'wrong way' | 'time / chop' | 'open';
interface PT { sym: string; model: RsiModelId; t: number; r: number; kind: Kind; mfe: number; mae: number; runAtr: number; runStop: number; stopPct: number; btcWith: boolean | null; how: string; entry: number; stop: number; exitT: number }

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f = (x: number, n = 2) => (Number.isFinite(x) ? x.toFixed(n) : '-');

/** Classify one losing trade from its path. Exported for the unit test. */
export function classifyLoss(o: { r: number; how: string; open: boolean; mfe: number; after2R: boolean; backToEntry: boolean }): Kind {
  if (o.open) return 'open';
  if (o.r > 0) return 'winner';
  if (o.mfe >= 1) return 'gave it back';
  if (o.how === 'stop' && o.after2R) return 'noise stop';
  if (o.how === 'stop' && o.mfe < 0.5 && !o.backToEntry) return 'wrong way';
  return 'time / chop';
}

export function postmortemReport(data: Data, symbols: ReadonlyArray<string>, from: number, _to: number, cut: number): string[] {
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const models = (Object.keys(RSI_MODELS) as RsiModelId[]).filter((m) => !RSI_MODELS[m].dropped);
  const btc = data['BTCUSDT']?.candles['1d'] ?? [], btcSma = sma(btc.map((b) => b.close), 50);
  const btcAt = (t: number): number => { let lo = 0, hi = btc.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (btc[m]!.openTime + DAY <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  const all: PT[] = [];
  for (const sym of symbols) {
    const d1 = data[sym]?.candles['1d'] ?? [], h4 = data[sym]?.candles['4h'] ?? [];
    if (d1.length < 300) continue;
    const busy = new Map<string, number>();
    for (const s of frameworkSetups(d1, h4)) {
      if (!models.includes(s.model) || s.j == null || s.stop == null || s.j >= s.c.length || s.c[s.j]!.openTime < from) continue;
      if (s.known <= (busy.get(s.model) ?? -Infinity)) continue;
      const lx = LIVE_EXITS[s.model][0], c = s.c, j = s.j, entry = c[j]!.open, stop0 = entry - lx.stopMult * (entry - s.stop);
      const t = specTrade(c, s.atr, {}, j, stop0, s.d, lx.spec);
      if (!t) continue;
      busy.set(s.model, t.open ? Infinity : c[t.end]!.openTime + s.bar);
      const risk = s.d * (entry - stop0);
      let mfe = -Infinity, mae = Infinity;
      for (let k = j; k <= t.end; k++) {
        const fav = s.d > 0 ? c[k]!.high : c[k]!.low, adv = s.d > 0 ? c[k]!.low : c[k]!.high;
        mfe = Math.max(mfe, (s.d * (fav - entry)) / risk); mae = Math.min(mae, (s.d * (adv - entry)) / risk);
      }
      // After the exit, over the model's cap length.
      const win = lx.spec.cap ?? s.cap;
      let after2R = false, backToEntry = false;
      for (let k = t.end + 1; k < Math.min(c.length, t.end + 1 + win); k++) {
        const fav = s.d > 0 ? c[k]!.high : c[k]!.low;
        if (s.d * (fav - entry) >= 0) backToEntry = true;
        if (s.d * (fav - entry) >= 2 * risk) { after2R = true; break; }
      }
      // Before entry: run from the 10-bar extreme the trade's way.
      let ext = s.d > 0 ? Infinity : -Infinity;
      for (let k = Math.max(0, j - 10); k < j; k++) ext = s.d > 0 ? Math.min(ext, c[k]!.low) : Math.max(ext, c[k]!.high);
      const a = s.atr[j - 1] ?? s.atr[j] ?? null, run = s.d * (entry - ext);
      const kb = btcAt(c[j]!.openTime), bs = kb >= 0 ? btcSma[kb] : null;
      const btcWith = bs == null ? null : s.d * (btc[kb]!.close - bs) > 0;
      all.push({ sym, model: s.model, t: c[j]!.openTime, r: t.r, kind: classifyLoss({ r: t.r, how: t.how, open: t.open, mfe, after2R, backToEntry }), mfe, mae, runAtr: a ? run / a : NaN, runStop: run / risk, stopPct: t.stopPct, btcWith, how: t.how, entry, stop: stop0, exitT: c[t.end]!.openTime });
    }
  }
  const KINDS: Kind[] = ['winner', 'gave it back', 'noise stop', 'wrong way', 'time / chop', 'open'];
  const out = [`LOSS POST-MORTEM, LIVE MODELS (version A exits): ${day(from)} to now, ${symbols.length} coins, ${all.length} trades. Older / newer = before / after ${day(cut)}.`,
    'gave it back = MFE >= 1R then lost; noise stop = stopped with MFE < 1R, then +2R the trade\'s way within the cap; wrong way = stopped with MFE < 0.5R, never back to the entry; time / chop = the rest.', ''];
  const block = (name: string, ts: PT[]) => {
    const closed = ts.filter((x) => x.kind !== 'open'), losers = closed.filter((x) => x.kind !== 'winner');
    out.push(`${name}: ${ts.length} trades, ${closed.length - losers.length} winners, ${losers.length} losers, avg R ${f(avg(closed.map((x) => x.r)))}`);
    for (const k of KINDS.slice(1, 5)) {
      const g = losers.filter((x) => x.kind === k);
      out.push(`  ${k.padEnd(14)} ${String(g.length).padStart(4)} (${f((100 * g.length) / Math.max(1, losers.length), 0)}% of losers)  avg R ${f(avg(g.map((x) => x.r)))}  MFE ${f(avg(g.map((x) => x.mfe)))}  MAE ${f(avg(g.map((x) => x.mae)))}  run before entry ${f(avg(g.map((x) => x.runAtr)), 1)} ATR`);
    }
    const w = closed.filter((x) => x.kind === 'winner');
    out.push(`  winners        ${String(w.length).padStart(4)}  avg R ${f(avg(w.map((x) => x.r)))}  MFE ${f(avg(w.map((x) => x.mfe)))}  MAE ${f(avg(w.map((x) => x.mae)))}  run before entry ${f(avg(w.map((x) => x.runAtr)), 1)} ATR`);
    // Quartiles: run before entry, stop width.
    const quart = (key: (x: PT) => number, label: string) => {
      const xs = closed.filter((x) => Number.isFinite(key(x))).sort((a, b) => key(a) - key(b));
      if (xs.length < 12) return;
      const parts = [0, 1, 2, 3].map((q) => xs.slice(Math.floor((q * xs.length) / 4), Math.floor(((q + 1) * xs.length) / 4)));
      out.push(`  by ${label}: ` + parts.map((p, q) => `Q${q + 1} ${f(key(p[0]!), 1)}-${f(key(p[p.length - 1]!), 1)}: ${p.length} trades, avg R ${f(avg(p.map((x) => x.r)))}, ${f((100 * p.filter((x) => x.r > 0).length) / p.length, 0)}% wins`).join(' | '));
    };
    quart((x) => x.runAtr, 'run before entry (ATR)');
    quart((x) => x.stopPct, 'stop distance (%)');
    const bw = closed.filter((x) => x.btcWith === true), ba = closed.filter((x) => x.btcWith === false);
    out.push(`  BTC daily vs its 50-day SMA, with the trade: ${bw.length} trades avg R ${f(avg(bw.map((x) => x.r)))} (${f((100 * bw.filter((x) => x.r > 0).length) / Math.max(1, bw.length), 0)}% wins) | against: ${ba.length} trades avg R ${f(avg(ba.map((x) => x.r)))} (${f((100 * ba.filter((x) => x.r > 0).length) / Math.max(1, ba.length), 0)}% wins)`);
    out.push('');
  };
  for (const m of models) block(RSI_MODELS[m].label, all.filter((x) => x.model === m));
  block('ALL LIVE MODELS', all);
  out.push('EXAMPLES TO LOOK AT ON THE CHART (5 most recent per type, all models): coin, model, entry time UTC, entry, stop, exit time, R, MFE');
  for (const k of ['gave it back', 'noise stop', 'wrong way', 'time / chop'] as Kind[]) {
    out.push(`  ${k}:`);
    for (const x of all.filter((y) => y.kind === k).sort((a, b) => b.t - a.t).slice(0, 5))
      out.push(`    ${x.sym} ${RSI_MODELS[x.model].label}: entry ${new Date(x.t).toISOString().slice(0, 16)} at ${x.entry.toPrecision(5)}, stop ${x.stop.toPrecision(5)}, out ${new Date(x.exitT).toISOString().slice(0, 16)}, ${f(x.r)} R, MFE ${f(x.mfe)} R`);
  }
  return out;
}
