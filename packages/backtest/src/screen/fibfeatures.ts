// What separates the winning Fib trades from the losing ones (owner 2026-10-03): every trade the model took,
// described at its signal bar, then compared bucket by bucket. Diagnosis only; nothing here filters trades.
import { barAt } from '@bot/smc';
import { intervalMs, type Candle } from '@bot/marketdata';
import { atrWilder, ema } from '../indicators';
import { srChannels } from './srchannels';
import { htfSr, weeklyDailyRsi, type FibTrig, type SignalContext } from './signals';

export type FeatureValue = number | boolean | string | null;
export type Features = Record<string, FeatureValue>;

const srOf = (c: ReadonlyArray<Candle>) => { let sr = htfSr.get(c); if (!sr) { sr = srChannels(c); htfSr.set(c, sr); } return sr; };
const atrCache = new WeakMap<object, (number | null)[]>();
const atrOf = (c: ReadonlyArray<Candle>) => { let a = atrCache.get(c); if (!a) { a = atrWilder(c, 14); atrCache.set(c, a); } return a; };
const emaCache = new WeakMap<object, (number | null)[]>();
const ema50Of = (c: ReadonlyArray<Candle>) => { let e = emaCache.get(c); if (!e) { e = ema(c.map((b) => b.close), 50); emaCache.set(c, e); } return e; };
const round = (v: number | null | undefined, p = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** p) / 10 ** p);

/** The trade's features at trigger bar k (1H), from its trigger record; `btcDaily` = BTC's daily candles. */
export function fibTradeFeatures(x: SignalContext, k: number, t: FibTrig, btcDaily: ReadonlyArray<Candle> = []): Features {
  const c = x.candles, pc = x.data.candles[t.parent] ?? [], dk = x.data.candles['1d'] ?? [];
  const d = t.d, H = t.lv.cancelIfTouched, L = t.lv.cancelOnClose, leg = Math.abs(H - L);
  const close = c[k]!.close, a1 = atrOf(c)[k] ?? null, a4 = atrOf(pc)[t.j] ?? null;
  const signalEnd = c[k]!.openTime + intervalMs(x.tf);
  // Deepest retracement between the zone touch and the trigger.
  let deep = d > 0 ? Infinity : -Infinity;
  for (let i = Math.max(0, t.touched); i <= k; i++) deep = d > 0 ? Math.min(deep, c[i]!.low) : Math.max(deep, c[i]!.high);
  const depth = Math.abs(H - deep) / leg;
  // S/R.
  const zone = (ch: { lo: number; hi: number }) => ch.lo <= t.f.zHi && ch.hi >= t.f.zLo;
  const has4hP3 = srOf(pc).channels[t.j]!.some((ch) => ch.pivots >= 3 && zone(ch));
  const tol = 0.25 * (a1 ?? 0);
  const has1hAtSweep = Number.isFinite(t.ext) && srOf(c).channels[k]!.some((ch) => ch.pivots >= 3 && t.ext >= ch.lo - tol && t.ext <= ch.hi + tol);
  const jd = barAt(dk, intervalMs('1d'), signalEnd);
  const dch = jd >= 0 ? srOf(dk).channels[jd]! : [];
  const dailyPivots = dch.filter(zone).reduce((m, ch) => Math.max(m, ch.pivots), 0);
  const opp = dch.map((ch) => (d > 0 ? ch.lo : ch.hi)).filter((v) => (d > 0 ? v > close : v < close));
  const nearest = opp.length ? (d > 0 ? Math.min(...opp) : Math.max(...opp)) : null;
  const roomR = nearest == null ? 10 : Math.min(10, Math.abs(nearest - close) / t.stopDist);
  // Trend / momentum (last closed daily bar).
  const de = ema50Of(dk), da = atrOf(dk);
  const dDist = jd >= 0 && de[jd] != null && da[jd] ? (d * (dk[jd]!.close - de[jd]!)) / da[jd]! : null;
  const dSlope = jd >= 5 && de[jd] != null && de[jd - 5] != null && da[jd] ? (d * (de[jd]! - de[jd - 5]!)) / da[jd]! : null;
  const rsi = weeklyDailyRsi(dk, jd);
  const jb = barAt(btcDaily, intervalMs('1d'), signalEnd), be = ema50Of(btcDaily);
  const btcAgree = jb >= 5 && be[jb] != null && be[jb - 5] != null
    ? (d > 0 ? btcDaily[jb]!.close > be[jb]! && be[jb]! > be[jb - 5]! : btcDaily[jb]!.close < be[jb]! && be[jb]! < be[jb - 5]!) : null;
  // Volatility: 4H ATR % vs the coin's own 90-day median.
  const pct = (i: number) => { const a = atrOf(pc)[i]; return a != null ? a / pc[i]!.close : null; };
  const hist: number[] = [];
  for (let i = Math.max(0, t.j - 540); i <= t.j; i++) { const v = pct(i); if (v != null) hist.push(v); }
  hist.sort((p, q) => p - q);
  const volRatio = hist.length > 30 && pct(t.j) != null ? pct(t.j)! / hist[Math.floor(hist.length / 2)]! : null;
  const disp = k >= 1 && a1 ? Math.abs(c[k - 1]!.close - c[k - 1]!.open) / a1 : null;
  return {
    side: d > 0 ? 'long' : 'short',
    legAtr4h: round(a4 ? leg / a4 : null, 1),
    depth: round(depth, 3),
    barsToTrigger4h: round((c[k]!.openTime - (pc[t.j]!.openTime + intervalMs(t.parent))) / intervalMs(t.parent), 1),
    stopAtr1h: round(a1 ? t.stopDist / a1 : null),
    stopPct: round((100 * t.stopDist) / close),
    has4hChannel: has4hP3,
    has1hChannelAtSweep: has1hAtSweep,
    dailyChannelPivots: dailyPivots,
    roomR: round(roomR),
    dailyDistAtr: round(dDist),
    dailyEmaSlopeAtr: round(dSlope),
    rsiDaily: round(rsi.d, 1),
    rsiWeekly: round(rsi.w, 1),
    btcAgrees: btcAgree,
    volRatio: round(volRatio),
    displacementAtr: round(disp),
  };
}

export interface FeatureRow { r: number; old: boolean; f: Features; label: string }

/** Buckets: booleans and strings by value; numbers by terciles. */
function buckets(rows: ReadonlyArray<FeatureRow>, key: string): { name: string; rows: FeatureRow[] }[] {
  const have = rows.filter((x) => x.f[key] != null);
  const v0 = have[0]?.f[key];
  if (typeof v0 !== 'number') {
    const m = new Map<string, FeatureRow[]>();
    for (const x of have) { const n = String(x.f[key]); m.set(n, [...(m.get(n) ?? []), x]); }
    return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([name, rs]) => ({ name, rows: rs }));
  }
  const vals = have.map((x) => x.f[key] as number).sort((a, b) => a - b);
  const q1 = vals[Math.floor(vals.length / 3)]!, q2 = vals[Math.floor((2 * vals.length) / 3)]!;
  const lo = have.filter((x) => (x.f[key] as number) < q1), mid = have.filter((x) => (x.f[key] as number) >= q1 && (x.f[key] as number) < q2), hi = have.filter((x) => (x.f[key] as number) >= q2);
  return [{ name: `< ${q1}`, rows: lo }, { name: `${q1} - ${q2}`, rows: mid }, { name: `>= ${q2}`, rows: hi }].filter((b) => b.rows.length);
}
const avg = (rs: ReadonlyArray<FeatureRow>) => (rs.length ? rs.reduce((s, x) => s + x.r, 0) / rs.length : NaN);

/** Per feature: bucket / trades / win % / avg R / total R / avg R older / avg R newest; a ranked summary with CONSISTENT flags. */
export function bucketReport(rows: ReadonlyArray<FeatureRow>, minN = 30): string[] {
  const keys = Object.keys(rows[0]?.f ?? {});
  const out: string[] = [`FEATURES (${rows.length} trades): bucket / trades / win % / avg R / total R / avg R older two years / avg R newest year`];
  const summary: { key: string; gap: number; consistent: boolean; best: string }[] = [];
  for (const key of keys) {
    const bs = buckets(rows, key);
    if (bs.length < 2) continue;
    out.push(`  ${key}`);
    for (const b of bs) {
      const o = b.rows.filter((x) => x.old), nw = b.rows.filter((x) => !x.old);
      out.push(`    ${b.name.padEnd(14)} ${String(b.rows.length).padStart(4)} / ${((100 * b.rows.filter((x) => x.r > 0).length) / b.rows.length).toFixed(0)}% / ${avg(b.rows).toFixed(3)}R / ${b.rows.reduce((s, x) => s + x.r, 0).toFixed(1)}R / ${o.length ? avg(o).toFixed(3) : '-'}R / ${nw.length ? avg(nw).toFixed(3) : '-'}R`);
    }
    const byAll = [...bs].sort((p, q) => avg(q.rows) - avg(p.rows));
    const bestOld = [...bs].sort((p, q) => avg(q.rows.filter((x) => x.old)) - avg(p.rows.filter((x) => x.old)))[0]!;
    const bestNew = [...bs].sort((p, q) => avg(q.rows.filter((x) => !x.old)) - avg(p.rows.filter((x) => !x.old)))[0]!;
    const consistent = bestOld === bestNew && bs.every((b) => b.rows.length >= minN);
    summary.push({ key, gap: avg(byAll[0]!.rows) - avg(byAll.at(-1)!.rows), consistent, best: byAll[0]!.name });
  }
  out.push('FEATURE SUMMARY: gap in avg R between best and worst bucket (CONSISTENT = same best bucket in both periods, every bucket >= ' + minN + ' trades)');
  for (const s of summary.sort((p, q) => q.gap - p.gap)) out.push(`  ${s.key.padEnd(20)} gap ${s.gap.toFixed(3)}R  best ${s.best}${s.consistent ? '  CONSISTENT' : ''}`);
  return out;
}

/** The best and worst trades with their features. */
export function tradeDump(rows: ReadonlyArray<FeatureRow>, n = 20): string[] {
  const fmt = (x: FeatureRow) => `  ${x.label} ${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R  ${Object.entries(x.f).map(([k, v]) => `${k}=${v}`).join(' ')}`;
  const sorted = [...rows].sort((a, b) => b.r - a.r);
  return [`BEST ${n} TRADES`, ...sorted.slice(0, n).map(fmt), `WORST ${n} TRADES`, ...sorted.slice(-n).reverse().map(fmt)];
}
