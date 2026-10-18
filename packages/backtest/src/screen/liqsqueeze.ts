// Liquidation squeeze study (owner 2026-10-18: "Could we build a liquidation squeeze detector now?"). Research only: it
// tests, before anything is built for the live bot, whether the days the detector would flag are followed by anything
// worth an alert. LiqWall's free plan keeps 7 days of hourly history, too little to test, so the test runs on daily data:
// CoinLobster's derivatives archive (/history/derivatives, from 2026-03-18: per UTC day the liquidations of longs and
// shorts on the venues that publish them, mean funding, end-of-day open interest, coverage flags) for BTC, ETH and 20
// liquid coins, with prices from Bitunix daily candles (the exchange the bot trades).
//
// Rules, fixed here before the first run (2026-10-18); nothing is tuned afterwards:
// - A day counts when its liquidation row exists and, where it carries a coverage flag, the flag is 'full'.
// - Normal = the median of the coin's total daily liquidations over its 30 previous counted days (15 at least).
// - Long squeeze day: long liquidations at least 3x normal and 2x the shorts, and the Bitunix day closed red.
//   Short squeeze day: short liquidations at least 3x normal and 2x the longs, and the day closed green.
// - Outcome, acting at the next day's open (a day's numbers are known only after it closes): the return over 1, 3 and 7
//   days in the squeeze's direction (continuation; below 0 = reversal), against the same return over all counted days of
//   the same coins (the base line). Split by the day's open-interest change (down 2%+ or not), information only.
// - Setups ("squeeze loaded"), at each day's close: crowded longs = the 3-day mean funding at or above the 80th
//   percentile of the coin's previous 60 days and open interest up 5%+ over 3 days; crowded shorts = at or under the 20th
//   percentile and open interest up 5%+. Outcome: a squeeze day of the matching side (a long squeeze after crowded
//   longs) within the next 3 days, against its base rate over all counted days.
// - Two periods: 2026-03-18 to 2026-06-30 and 2026-07-01 on, reported apart. Many cuts (2 sides x 3 horizons x 2 periods)
//   mean some will look good by chance; a result near the base line means no edge.

import type { Candle } from '@bot/marketdata';

export const LS = {
  normalDays: 30, minNormal: 15, spike: 3, oneSided: 2, oiDrop: -2,
  setup: { fundingDays: 3, window: 60, high: 0.8, low: 0.2, oiDays: 3, oiUp: 5, within: 3 },
  horizons: [1, 3, 7] as const,
  periods: [{ name: '2026-03-18 – 06-30', from: Date.UTC(2026, 2, 18), to: Date.UTC(2026, 6, 1) }, { name: '2026-07-01 on', from: Date.UTC(2026, 6, 1), to: Infinity }],
} as const;
const DAY = 86_400_000;

export interface LsDay { t: number; long: number; short: number; funding: number | null; oi: number | null }
type J = Record<string, unknown>;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** CoinLobster's /history/derivatives answer as counted days (UTC midnight), oldest first. */
export function parseHistory(j: unknown): LsDay[] {
  const d = ((j as J)?.data ?? {}) as J, rows = (k: string) => (Array.isArray(d[k]) ? (d[k] as J[]) : []);
  const t = (r: J) => (typeof r.d === 'string' ? Date.parse(`${r.d}T00:00:00Z`) : NaN);
  const fund = new Map(rows('funding').map((r) => [t(r), num(r.avg)])), oi = new Map(rows('open_interest').map((r) => [t(r), num(r.usd)]));
  return rows('liquidations')
    .filter((r) => Number.isFinite(t(r)) && (r.cov == null || r.cov === 'full') && num(r.longUsd) != null && num(r.shortUsd) != null)
    .map((r) => ({ t: t(r), long: num(r.longUsd)!, short: num(r.shortUsd)!, funding: fund.get(t(r)) ?? null, oi: oi.get(t(r)) ?? null }))
    .sort((a, b) => a.t - b.t);
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface Squeeze { t: number; side: 'long' | 'short'; mult: number; oiChg: number | null }

/** The squeeze days of one coin: each day against the median of its 30 previous counted days (never itself or later). */
export function squeezeDays(days: ReadonlyArray<LsDay>, d1: ReadonlyArray<Candle>): Squeeze[] {
  const bar = new Map(d1.map((c) => [Math.floor(c.openTime / DAY) * DAY, c])), out: Squeeze[] = [];
  days.forEach((x, i) => {
    const prior = days.slice(Math.max(0, i - LS.normalDays), i);
    if (prior.length < LS.minNormal) return;
    const normal = median(prior.map((p) => p.long + p.short)), c = bar.get(x.t);
    if (!(normal > 0) || !c) return;
    const prev = days[i - 1], oiChg = prev && prev.t === x.t - DAY && x.oi != null && prev.oi ? (x.oi / prev.oi - 1) * 100 : null;
    if (x.long >= LS.spike * normal && x.long >= LS.oneSided * x.short && c.close < c.open) out.push({ t: x.t, side: 'long', mult: x.long / normal, oiChg });
    else if (x.short >= LS.spike * normal && x.short >= LS.oneSided * x.long && c.close > c.open) out.push({ t: x.t, side: 'short', mult: x.short / normal, oiChg });
  });
  return out;
}

/** The return (%) from the open of the day after `t` to the close of day `t + h`; null when a bar is missing. */
export function forward(d1: ReadonlyArray<Candle>, t: number, h: number): number | null {
  const bar = new Map(d1.map((c) => [Math.floor(c.openTime / DAY) * DAY, c])), a = bar.get(t + DAY), b = bar.get(t + h * DAY);
  return a && b && a.open > 0 ? (b.close / a.open - 1) * 100 : null;
}

export interface Setup { t: number; side: 'long' | 'short' }

/** Crowded longs / shorts at each day's close: funding against the coin's previous 60 days, open interest over 3 days. */
export function setups(days: ReadonlyArray<LsDay>): Setup[] {
  const S = LS.setup, out: Setup[] = [];
  days.forEach((x, i) => {
    const last = days.slice(i - S.fundingDays + 1, i + 1), past = days.slice(Math.max(0, i - S.fundingDays + 1 - S.window), i - S.fundingDays + 1);
    const back = days[i - S.oiDays];
    if (i < S.fundingDays - 1 || past.length < S.window / 2 || !back || back.t !== x.t - S.oiDays * DAY) return;
    if (last.some((p) => p.funding == null) || x.oi == null || !back.oi) return;
    const f = last.reduce((a, p) => a + p.funding!, 0) / last.length, hist = past.map((p) => p.funding).filter((v): v is number => v != null);
    if (hist.length < S.window / 2) return;
    const rank = hist.filter((v) => v < f).length / hist.length, oiUp = (x.oi / back.oi - 1) * 100;
    if (oiUp < S.oiUp) return;
    if (rank >= S.high) out.push({ t: x.t, side: 'long' });
    else if (rank <= S.low) out.push({ t: x.t, side: 'short' });
  });
  return out;
}

export interface LsCoin { coin: string; days: LsDay[]; d1: Candle[] }

const fmt = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const stat = (xs: number[]) => xs.length ? `n ${xs.length} · mean ${fmt(xs.reduce((a, b) => a + b, 0) / xs.length)}% · median ${fmt(median(xs))}% · ${Math.round((xs.filter((x) => x > 0).length / xs.length) * 100)}% above 0` : 'n 0';

/** The study's report: squeeze days and setups per period, against their base lines. */
export function lsReport(coins: ReadonlyArray<LsCoin>): string[] {
  const out: string[] = ['===== LIQUIDATION SQUEEZE STUDY (rules in screen/liqsqueeze.ts, fixed before the run) =====', ''];
  out.push(`Coins: ${coins.map((c) => `${c.coin} ${c.days.length}d`).join(', ')}`);
  const all = coins.map((c) => ({ ...c, sq: squeezeDays(c.days, c.d1), su: setups(c.days) }));
  for (const P of LS.periods) {
    const inP = (t: number) => t >= P.from && t < P.to;
    out.push('', `--- ${P.name} ---`);
    for (const side of ['long', 'short'] as const) {
      const dir = side === 'long' ? -1 : 1; // continuation: a long squeeze is a drop
      const ev = all.flatMap((c) => c.sq.filter((s) => s.side === side && inP(s.t)).map((s) => ({ ...s, c })));
      out.push(` ${side === 'long' ? 'Long squeeze days (longs forced out, red day)' : 'Short squeeze days (shorts forced out, green day)'}: ${ev.length} on ${new Set(ev.map((e) => e.c.coin)).size} coins`);
      for (const h of LS.horizons) {
        const r = ev.map((e) => forward(e.c.d1, e.t, h)).filter((x): x is number => x != null).map((x) => dir * x);
        const base = all.flatMap((c) => c.days.filter((d) => inP(d.t)).map((d) => forward(c.d1, d.t, h))).filter((x): x is number => x != null).map((x) => dir * x);
        const oiDown = ev.filter((e) => e.oiChg != null && e.oiChg <= LS.oiDrop).map((e) => forward(e.c.d1, e.t, h)).filter((x): x is number => x != null).map((x) => dir * x);
        out.push(`   ${h}d continuation: ${stat(r)} | base (all days) ${stat(base)} | with OI down ${-LS.oiDrop}%+: ${stat(oiDown)}`);
      }
    }
    for (const side of ['long', 'short'] as const) {
      const hit = (c: (typeof all)[number], t: number) => c.sq.some((s) => s.side === side && s.t > t && s.t <= t + LS.setup.within * DAY);
      const su = all.flatMap((c) => c.su.filter((s) => s.side === side && inP(s.t)).map((s) => hit(c, s.t)));
      const base = all.flatMap((c) => c.days.filter((d) => inP(d.t)).map((d) => hit(c, d.t)));
      const pc = (xs: boolean[]) => (xs.length ? `${Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 10}% of ${xs.length}` : '-');
      out.push(` Setup "crowded ${side === 'long' ? 'longs' : 'shorts'}" → a ${side} squeeze day within ${LS.setup.within} days: ${pc(su)} | base ${pc(base)}`);
    }
  }
  const recent = all.flatMap((c) => c.sq.map((s) => ({ ...s, coin: c.coin }))).sort((a, b) => b.t - a.t).slice(0, 15);
  out.push('', 'Latest squeeze days (for the chart check):', ...recent.map((s) => ` ${new Date(s.t).toISOString().slice(0, 10)} ${s.coin} ${s.side} squeeze · ${s.mult.toFixed(1)}x normal${s.oiChg != null ? ` · OI ${fmt(s.oiChg, 1)}%` : ''}`));
  return out;
}
