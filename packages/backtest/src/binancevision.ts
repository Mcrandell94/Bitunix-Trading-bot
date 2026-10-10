// Binance USDT-M futures history from the public archive (data.binance.vision), for research only. Owner 2026-10-10:
// "feel free to access CVD and O/I if data there can give an edge to this separate strategy". Bitunix has no open
// interest or taker-side history, and its funding history starts in March 2024. Binance's archive has funding from
// 2019-2020 (monthly files), taker buy volume in every kline (for CVD) and 5-minute open interest from about late 2021
// (daily "metrics" files). Files are fetched on demand and cached as parsed JSON under <cacheDir>/bv.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FundingPoint } from './types';

const DATA = 'https://data.binance.vision';
const LIST = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const DAY = 86_400_000, UM = 'data/futures/um';

/** The first file in a zip archive (stored or deflated), found through the central directory. Pure. */
export function unzipFirst(buf: Uint8Array): Buffer {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (b.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const cd = b.readUInt32LE(end + 16);
  if (b.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip central directory');
  const method = b.readUInt16LE(cd + 10), size = b.readUInt32LE(cd + 20), local = b.readUInt32LE(cd + 42);
  if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip local header');
  const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28), data = b.subarray(start, start + size);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip method ${method} not supported`);
}

/** CSV rows, header lines (not starting with a digit) dropped. */
const rowsOf = (text: string) => text.split(/\r?\n/).filter((l) => /^\d/.test(l)).map((l) => l.split(','));
/** Archive times are ms; newer files may use microseconds. */
const ms = (x: number) => (x > 1e14 ? Math.floor(x / 1000) : x);

/** Funding settlements from a fundingRate CSV (calc_time, funding_interval_hours, last_funding_rate). Pure. */
export function parseFundingCsv(text: string): FundingPoint[] {
  return rowsOf(text).map((r) => ({ time: ms(Number(r[0])), rate: Number(r[r.length - 1]) })).filter((f) => Number.isFinite(f.time) && Number.isFinite(f.rate));
}

/** Quote volume and taker buy quote volume per kline open time. */
export interface TakerBar { t: number; vol: number; buy: number }
/** From a klines CSV (open_time, ..., quote_volume [7], count, taker_buy_volume, taker_buy_quote_volume [10], ignore). Pure. */
export function parseKlineCsv(text: string): TakerBar[] {
  return rowsOf(text).map((r) => ({ t: ms(Number(r[0])), vol: Number(r[7]), buy: Number(r[10]) })).filter((b) => Number.isFinite(b.t) && b.vol > 0 && Number.isFinite(b.buy));
}

/** Open interest in base units at a 5-minute snapshot. */
export interface OiPoint { t: number; oi: number }
/** From a metrics CSV (create_time 'YYYY-MM-DD HH:MM:SS', symbol, sum_open_interest, ...). Pure. */
export function parseMetricsCsv(text: string): OiPoint[] {
  return rowsOf(text).map((r) => ({ t: Date.parse(`${r[0]!.trim().replace(' ', 'T')}Z`), oi: Number(r[2]) })).filter((p) => Number.isFinite(p.t) && p.oi > 0);
}

const readJson = <T>(path: string): T | undefined => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; } };
const writeJson = (path: string, v: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v)); };

/** The archive response for `url`; null on 404. Retries other failures, then throws. */
async function get(url: string): Promise<Response | null> {
  for (let k = 0; ; k++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (k >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** k));
    }
  }
}

/** Run `jobs` with at most `n` at a time. */
async function pool<T>(jobs: ReadonlyArray<() => Promise<T>>, n: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (next < jobs.length) { const k = next++; out[k] = await jobs[k]!(); } }));
  return out;
}

export interface Archive {
  cacheDir: string;
  log: (m: string) => void;
  /** Download failures (not 404s), for the report. */
  errors: string[];
}

/** The keys under an archive prefix (S3 listing pages of 1000), cached for a day. */
async function listKeys(a: Archive, prefix: string): Promise<string[]> {
  const path = join(a.cacheDir, 'bv', 'list', `${prefix.replace(/\//g, '_')}.json`), hit = readJson<{ at: number; keys: string[] }>(path);
  if (hit && Date.now() - hit.at < DAY) return hit.keys;
  const keys: string[] = [];
  let marker = '';
  try {
    for (let page = 0; page < 100; page++) {
      const res = await get(`${LIST}?prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ''}`);
      if (!res) break;
      const xml = await res.text(), got = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
      keys.push(...got);
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !got.length) break;
      marker = got[got.length - 1]!;
    }
  } catch (err) {
    a.errors.push(`list ${prefix}: ${(err as Error).message}`);
    return [];
  }
  writeJson(path, { at: Date.now(), keys });
  return keys;
}

/** One archive file, parsed and cached; null when there is no such file (a miss is cached once the file would be final). */
async function file<T>(a: Archive, key: string, parse: (text: string) => T[], finalAt: number): Promise<T[] | null> {
  const path = join(a.cacheDir, 'bv', `${key.replace(/^data\//, '').replace(/\.zip$/, '')}.json`), hit = readJson<{ rows: T[] | null }>(path);
  if (hit) return hit.rows;
  let rows: T[] | null = null;
  try {
    const res = await get(`${DATA}/${key}`);
    rows = res ? parse(unzipFirst(new Uint8Array(await res.arrayBuffer())).toString('utf8')) : null;
  } catch (err) {
    a.errors.push(`${key}: ${(err as Error).message}`);
    return null;
  }
  if (rows || Date.now() > finalAt) writeJson(path, { rows });
  return rows;
}

const ym = (t: number) => new Date(t).toISOString().slice(0, 7);
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthEnd = (m: string) => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1);

/** The Binance USDT-M symbol for a Bitunix one: the same name, else with a 1000 multiplier; null when neither is listed. */
export async function binanceSymbol(a: Archive, sym: string): Promise<string | null> {
  for (const s of [sym, `1000${sym}`]) if ((await listKeys(a, `${UM}/monthly/fundingRate/${s}/`)).some((k) => k.endsWith('.zip'))) return s;
  return null;
}

/** Binance funding settlements over [from, to) from the monthly files (the last month or so is not published yet). */
export async function binanceFunding(a: Archive, symbol: string, from: number, to: number): Promise<FundingPoint[]> {
  const keys = (await listKeys(a, `${UM}/monthly/fundingRate/${symbol}/`)).filter((k) => k.endsWith('.zip'));
  const want = keys.filter((k) => { const m = /(\d{4}-\d{2})\.zip$/.exec(k)?.[1]; return m != null && monthEnd(m) > from && Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1) < to; });
  const parts = await pool(want.map((k) => () => file(a, k, parseFundingCsv, 0)), 8);
  const byTime = new Map<number, FundingPoint>();
  for (const p of parts) for (const f of p ?? []) if (f.time >= from && f.time < to) byTime.set(f.time, f);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}

/** 5-minute open interest for the days that hold the given times and the 24 hours before each. */
export async function binanceOi(a: Archive, symbol: string, times: ReadonlyArray<number>): Promise<OiPoint[]> {
  const days = new Set<string>();
  for (const t of times) for (const x of [t, t - 1, t - DAY, t - DAY - 1]) days.add(ymd(x));
  const parts = await pool([...days].map((d) => () => file(a, `${UM}/daily/metrics/${symbol}/${symbol}-metrics-${d}.zip`, parseMetricsCsv, Date.parse(`${d}T00:00:00Z`) + 3 * DAY)), 8);
  const byTime = new Map<number, OiPoint>();
  for (const p of parts) for (const o of p ?? []) byTime.set(o.t, o);
  return [...byTime.values()].sort((x, y) => x.t - y.t);
}

/** Taker volume of the bars opening at the given times (monthly kline files; daily ones for a month not yet published). */
export async function binanceTaker(a: Archive, symbol: string, tf: '4h' | '1d', times: ReadonlyArray<number>): Promise<Map<number, TakerBar>> {
  const months = [...new Set(times.map(ym))], out = new Map<number, TakerBar>();
  const parts = await pool(months.map((m) => async () => {
    const monthly = await file(a, `${UM}/monthly/klines/${symbol}/${tf}/${symbol}-${tf}-${m}.zip`, parseKlineCsv, monthEnd(m) + 7 * DAY);
    if (monthly) return monthly;
    const days = [...new Set(times.filter((t) => ym(t) === m).map(ymd))];
    const daily = await pool(days.map((d) => () => file(a, `${UM}/daily/klines/${symbol}/${tf}/${symbol}-${tf}-${d}.zip`, parseKlineCsv, Date.parse(`${d}T00:00:00Z`) + 3 * DAY)), 4);
    return daily.flatMap((x) => x ?? []);
  }), 8);
  const want = new Set(times);
  for (const p of parts) for (const b of p) if (want.has(b.t)) out.set(b.t, b);
  return out;
}
