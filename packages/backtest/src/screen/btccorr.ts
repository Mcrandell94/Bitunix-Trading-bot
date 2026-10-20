// BTC Correlation, the owner's TradingView script (2026-10-20, Pine v6; no licence header, so TradingView's default for
// open scripts, MPL 2.0). Calculation only, run as a scan (owner: "look at separate of everything and tell me if any coins
// stand out ... negative .7 less"). Nothing in the bot, the cards or the worker uses it.
//
// The script: ta.correlation(asset return, BTC return, 50) on the chart's timeframe, with BTC's close from
// BINANCE:BTCUSDT at each chart bar (request.security, same timeframe). Its table colours: ≥ 0.7, ≥ 0.4, ≥ 0, ≥ −0.4,
// ≥ −0.7, and under −0.7 (dark red).
//
// Bar-for-bar notes:
// - return = (close − close[1]) / close[1] over consecutive chart bars, BTC's over the same bars. A BTC bar missing at a
//   chart bar's time takes the last BTC close before it, as request.security does with gaps off.
// - ta.correlation is Pearson's r over the last `period` bars. It is na while any return in the window is na; a flat
//   window (no variance on one side) is na here too.
// - Closed bars only. TradingView's table also counts the bar still forming, so it can differ a little until it closes.
// - Weekly bars are Monday 00:00 UTC weeks built from the daily bars (Bitunix has no weekly candles), closed weeks only.

import type { Candle } from '@bot/marketdata';
import { aggregate } from './wyckoffhtf';

const DAY = 86_400_000;

/**
 * Stock, ETF and pre-IPO tokens Bitunix lists as USDT perps that the bot's list (NON_CRYPTO_BASES in worker/src/scan.ts)
 * doesn't have, found in the 2026-10-20 scans (checked against CoinGecko where the ticker was unclear). This scan only
 * (owner: "just crypto"); the bot's list is left as it is ("No those are different").
 */
export const SCAN_NON_CRYPTO: ReadonlySet<string> = new Set([
  // US stocks.
  'PEP', 'KO', 'WMT', 'JPM', 'BRKB', 'GS', 'LLY', 'CATERPILLAR', 'GPRO', 'AMAT', 'HIMS', 'ASML', 'PYPL', 'ASTS', 'RKLB',
  'TTWO', 'APLD', 'NBIS', 'ADBE', 'HPE', 'CRDO', 'VST', 'QCOM', 'ALAB', 'NOK', 'CBRS', 'MARA', 'CRWV', 'MCD', 'CIEN', 'NKE',
  'GLW', 'ARM', 'COHR', 'SMCI', 'BE', 'APP', 'NOW', 'IBM', 'IONQ', 'USAR', 'SOFI', 'FWDI', 'BSP', 'PENGSTOCK',
  // Asian stocks.
  'HANMI', 'LGE', 'NAVER', 'SAMSUNGEM', 'HYUNDAI', 'POPMART', 'KUAISHOU', 'MINIMAX', 'TENCENT', 'XIAOMI', 'ZHIPU',
  'ZHONGJI', 'GIGADEV',
  // Pre-IPO.
  'ANTHROPIC', 'UNITREE', 'CXMT',
  // ETFs and leveraged ETFs.
  'UVXY', 'SKDD', 'SKUU', 'BWET', 'TMF', 'EWY', 'KSTR', 'TSLL', 'MVLL', 'MSTU', 'CSOPHLS2L', 'CSOPSX2L',
]);

/** Lines as GitHub Actions notice commands (readable through the check-run annotations API), in chunks under `max`. Pure. */
export function noticeLines(lines: ReadonlyArray<string>, title: string, max = 3500): string[] {
  const parts: string[][] = [];
  for (const l of lines) {
    const p = parts.at(-1);
    if (p && p.join('\n').length + 1 + l.length <= max) p.push(l);
    else parts.push([l]);
  }
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return parts.map((p, i) => `::notice title=${title} (${i + 1}/${parts.length})::${esc(p.join('\n'))}`);
}

/** Pearson's r of x and y over the `len` values ending at each index; null while one is missing or a side is flat. Pure. */
export function rollingCorrelation(x: ReadonlyArray<number | null>, y: ReadonlyArray<number | null>, len: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(x.length).fill(null);
  for (let i = len - 1; i < x.length; i++) {
    let sx = 0, sy = 0, ok = true;
    for (let k = i - len + 1; k <= i && ok; k++) {
      const a = x[k], b = y[k];
      if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) ok = false;
      else { sx += a; sy += b; }
    }
    if (!ok) continue;
    const mx = sx / len, my = sy / len;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = i - len + 1; k <= i; k++) { const dx = x[k]! - mx, dy = y[k]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    out[i] = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
  }
  return out;
}

/** The script's value at each of the coin's bars (null until `period` returns exist). Both lists oldest first. Pure. */
export function btcCorrelation(coin: ReadonlyArray<Candle>, btc: ReadonlyArray<Candle>, period = 50): (number | null)[] {
  let j = -1;
  const b = coin.map((c) => { while (j + 1 < btc.length && btc[j + 1]!.openTime <= c.openTime) j++; return j >= 0 ? btc[j]!.close : null; });
  const ret = (now: number | null, prev: number | null) => (now != null && prev != null && prev !== 0 ? (now - prev) / prev : null);
  return rollingCorrelation(coin.map((c, i) => (i ? ret(c.close, coin[i - 1]!.close) : null)), b.map((v, i) => (i ? ret(v, b[i - 1]!) : null)), period);
}

/** Closed Monday 00:00 UTC weeks from daily bars: a week counts once its Sunday bar is in. Pure. */
export function closedWeeks(d1: ReadonlyArray<Candle>): Candle[] {
  const { c, ends } = aggregate(d1, 'W'), last = (d1.at(-1)?.openTime ?? -Infinity) + DAY;
  return c.filter((_, i) => ends[i]! <= last);
}

/** The change over the last `period` bars (close vs the close `period` bars before), or null. Pure. */
export const windowChange = (c: ReadonlyArray<Candle>, period: number): number | null => {
  const a = c.at(-1 - period), b = c.at(-1);
  return a && b && a.close > 0 ? b.close / a.close - 1 : null;
};

/** Binance spot klines (data-api.binance.vision, Binance's public market-data host) as candles, quote volume. Pure. */
export function parseBinanceKlines(data: unknown): Candle[] {
  if (!Array.isArray(data)) throw new Error('Binance klines: not an array');
  return data.filter((r): r is unknown[] => Array.isArray(r)).map((r) => ({
    openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: r[7] == null ? null : Number(r[7]),
  })).filter((c) => Number.isFinite(c.openTime) && Number.isFinite(c.close) && c.close > 0);
}

export async function binanceSpotCandles(symbol: string, interval: '1h' | '4h' | '1d', limit: number, fetchFn: typeof fetch = fetch): Promise<Candle[]> {
  const r = await fetchFn(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseBinanceKlines(await r.json());
}

export interface CorrRow {
  symbol: string;
  vol24h: number | null;
  /** The reading at the coin's last closed bar, that bar's open time, and the coin's change over the window. */
  now: number | null;
  at: number;
  chg: number | null;
  /** The lowest reading over the last `days` of closed bars, and its bar. */
  low: number | null;
  lowAt: number | null;
}

/** One coin on one timeframe, or null when it has too few bars for one reading. Pure. */
export function corrRow(symbol: string, vol24h: number | null, coin: ReadonlyArray<Candle>, btc: ReadonlyArray<Candle>, barMs: number, period: number, days: number): CorrRow | null {
  if (coin.length < period + 1) return null;
  const r = btcCorrelation(coin, btc, period), i = coin.length - 1, n = Math.max(1, Math.round((days * DAY) / barMs));
  let low: number | null = null, lowAt: number | null = null;
  for (let k = Math.max(0, i - n + 1); k <= i; k++) { const v = r[k]; if (v != null && (low == null || v < low)) { low = v; lowAt = coin[k]!.openTime; } }
  return { symbol, vol24h, now: r[i] ?? null, at: coin[i]!.openTime, chg: windowChange(coin, period), low, lowAt };
}

export interface CorrTf {
  tf: string;
  barMs: number;
  rows: CorrRow[];
  /** BTC's change over the window. */
  btcChg: number | null;
  /** Coins with too few bars for one reading, and coins whose last bar is old (no recent trading). */
  tooNew: number;
  stale: number;
}

const f2 = (v: number) => { const s = v.toFixed(2); return s === '-0.00' ? '0.00' : s.replace('-', '−'); };
const pct = (v: number | null) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v == null ? '$?' : `$${(v / 1e6).toFixed(1)}M`);
const name = (s: string) => s.replace(/USDT$/, '');
const when = (t: number, barMs: number) => new Date(t).toISOString().slice(5, barMs < DAY ? 16 : 10).replace('T', ' ');
/** The script's colour bands, top first. */
export const BANDS = [
  { label: '≥ 0.7', min: 0.7 }, { label: '0.4–0.7', min: 0.4 }, { label: '0–0.4', min: 0 },
  { label: '−0.4–0', min: -0.4 }, { label: '−0.7–−0.4', min: -0.7 }, { label: 'under −0.7', min: -Infinity },
] as const;
/** The script's band index (0 = ≥ 0.7 … 5 = under −0.7). */
export const bandOf = (v: number) => BANDS.findIndex((b) => v >= b.min);

/** The scan as text: the colour bands per timeframe, coins at `threshold` or lower now, the lowest, and the last `days`. */
export function btcCorrReport(o: {
  now: number; period: number; days: number; minVol: number; btcSource: string; scanned: number; thin: number; failed: string[]; tfs: CorrTf[];
  /** Bases left out by hand (--exclude): stock / ETF tokens the bot's list doesn't have yet. */
  excluded?: string[];
}, threshold = -0.7, lowest = 8): string[] {
  const out = [
    `BTC CORRELATION SCAN (the owner's script: correlation of bar returns with BTC over ${o.period} bars), ${new Date(o.now).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    `BTC: ${o.btcSource}. Coins: ${o.scanned} Bitunix USDT perps with ${usd(o.minVol)}+ 24h volume (crypto only: stock / ETF tokens out, gold in; ${o.thin} thinner coins left out). Closed bars only.`,
    ...(o.excluded?.length ? [`Also left out by hand (stock / ETF tokens not on the bot's list yet): ${o.excluded.join(', ')}.`] : []),
    '',
    `Coins per colour band now${' '.repeat(10)}${BANDS.map((b) => b.label.padStart(11)).join('')}`,
  ];
  for (const t of o.tfs) {
    const n = BANDS.map(() => 0);
    for (const r of t.rows) if (r.now != null) n[bandOf(r.now)]!++;
    out.push(`  ${`${t.tf} (BTC ${pct(t.btcChg)} over the window)`.padEnd(33)}${n.map((x) => String(x).padStart(11)).join('')}`);
  }
  const notes = o.tfs.map((t) => `${t.tf} ${t.tooNew} too new, ${t.stale} not trading`).join(' · ');
  out.push(`  (left out per timeframe: ${notes}${o.failed.length ? `; failed to load: ${o.failed.join(', ')}` : ''})`, '');
  out.push(`At ${f2(threshold)} or lower now (the last closed bar; coin's change over the window, 24h volume):`);
  for (const t of o.tfs) {
    const hit = t.rows.filter((r) => r.now != null && r.now <= threshold).sort((a, b) => a.now! - b.now!);
    out.push(`  ${t.tf}  ${hit.length ? hit.map((r) => `${name(r.symbol)} ${f2(r.now!)} (${pct(r.chg)}, ${usd(r.vol24h)})`).join(' · ') : 'none'}`);
  }
  out.push('', `Lowest now:`);
  for (const t of o.tfs) {
    const lo = t.rows.filter((r) => r.now != null).sort((a, b) => a.now! - b.now!).slice(0, lowest);
    out.push(`  ${t.tf}  ${lo.map((r) => `${name(r.symbol)} ${f2(r.now!)}`).join(' · ') || 'no readings'}`);
  }
  out.push('', `Reached ${f2(threshold)} or lower in the last ${o.days} days (closed bars) but not there now:`);
  for (const t of o.tfs) {
    const past = t.rows.filter((r) => r.low != null && r.low <= threshold && !(r.now != null && r.now <= threshold)).sort((a, b) => a.low! - b.low!);
    out.push(`  ${t.tf}  ${past.length ? past.map((r) => `${name(r.symbol)} low ${f2(r.low!)} (bar of ${when(r.lowAt!, t.barMs)}), now ${r.now == null ? '–' : f2(r.now)}, ${usd(r.vol24h)}`).join(' · ') : 'none'}`);
  }
  return out;
}

/** Every coin's reading per timeframe, the lowest on `by` first ('–' where there is none), for the log. Pure. */
export function btcCorrTable(tfs: ReadonlyArray<CorrTf>, by = '4H'): string[] {
  const all = new Map<string, Record<string, number | null>>();
  for (const t of tfs) for (const r of t.rows) { const v = all.get(r.symbol) ?? {}; v[t.tf] = r.now; all.set(r.symbol, v); }
  const key = (v: Record<string, number | null>) => v[by] ?? Infinity;
  const rows = [...all.entries()].sort((a, b) => key(a[1]) - key(b[1]) || a[0].localeCompare(b[0]));
  return [
    `All coins, the lowest ${by} first (${tfs.map((t) => t.tf).join(' / ')}):`,
    ...rows.map(([s, v]) => `  ${name(s).padEnd(14)}${tfs.map((t) => { const x = v[t.tf]; return (x == null ? '–' : f2(x)).padStart(7); }).join('')}`),
  ];
}
