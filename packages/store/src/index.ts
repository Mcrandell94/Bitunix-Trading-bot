// Postgres persistence. Every function takes a pg Pool or Client, so tests
// and the worker share one code path.

import type { Candle, IntervalName } from '@bot/marketdata';
import type { Watchlist } from '@bot/signals';
import pg from 'pg';
import { MIGRATIONS } from './migrations';

export type Db = pg.Pool | pg.PoolClient | pg.Client;

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}

// Serializes concurrent migrate() calls (e.g. two workers starting at once).
const MIGRATION_LOCK = 482_193_017;

async function inTransaction<T>(db: Db, fn: (c: pg.PoolClient | pg.Client) => Promise<T>): Promise<T> {
  const client = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    if (db instanceof pg.Pool) (client as pg.PoolClient).release();
  }
}

/** Applies pending migrations. Returns the versions it applied. */
export async function migrate(db: Db): Promise<number[]> {
  return inTransaction(db, async (c) => {
    await c.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await c.query(`create table if not exists schema_migrations (
      version integer primary key, name text not null, applied_at timestamptz not null default now())`);
    const { rows } = await c.query<{ version: number }>('select version from schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await c.query(m.sql);
      await c.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
      applied.push(m.version);
    }
    return applied;
  });
}

export async function upsertCandles(db: Db, symbol: string, interval: IntervalName, candles: ReadonlyArray<Candle>): Promise<number> {
  if (candles.length === 0) return 0;
  const res = await db.query(
    `insert into candles (symbol, interval, open_time, open, high, low, close, volume)
     select $1, $2, to_timestamp(t / 1000.0), o, h, l, c, v
     from unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[]) as x(t, o, h, l, c, v)
     on conflict (symbol, interval, open_time) do update
       set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`,
    [
      symbol, interval,
      candles.map((c) => c.openTime), candles.map((c) => c.open), candles.map((c) => c.high),
      candles.map((c) => c.low), candles.map((c) => c.close), candles.map((c) => c.volume),
    ],
  );
  return res.rowCount ?? 0;
}

/** Latest stored open time (ms) per symbol for an interval. */
export async function latestOpenTimes(db: Db, interval: IntervalName, symbols: ReadonlyArray<string>): Promise<Map<string, number>> {
  const { rows } = await db.query<{ symbol: string; t: string }>(
    `select symbol, (extract(epoch from max(open_time)) * 1000)::bigint as t
     from candles where interval = $1 and symbol = any($2) group by symbol`,
    [interval, symbols],
  );
  return new Map(rows.map((r) => [r.symbol, Number(r.t)]));
}

/** Candles with openTime >= from, per symbol, oldest first. */
export async function loadCandles(db: Db, interval: IntervalName, symbols: ReadonlyArray<string>, from: number): Promise<Record<string, Candle[]>> {
  const { rows } = await db.query<{ symbol: string; t: string; open: number; high: number; low: number; close: number; volume: number | null }>(
    `select symbol, (extract(epoch from open_time) * 1000)::bigint as t, open, high, low, close, volume
     from candles where interval = $1 and symbol = any($2) and open_time >= to_timestamp($3 / 1000.0)
     order by symbol, open_time`,
    [interval, symbols, from],
  );
  const out: Record<string, Candle[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  for (const r of rows) {
    out[r.symbol]!.push({ openTime: Number(r.t), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
  }
  return out;
}

export interface FundingRow {
  symbol: string;
  rate: number;
  intervalHours: number;
  nextFundingTime: number | null;
  markPrice: number | null;
}

export async function insertFunding(db: Db, observedAt: number, items: ReadonlyArray<FundingRow>): Promise<void> {
  if (items.length === 0) return;
  await db.query(
    `insert into funding (symbol, observed_at, rate, interval_hours, next_funding_time, mark_price)
     select s, to_timestamp($1 / 1000.0), r, i, case when n is null then null else to_timestamp(n / 1000.0) end, m
     from unnest($2::text[], $3::float8[], $4::float8[], $5::bigint[], $6::float8[]) as x(s, r, i, n, m)
     on conflict (symbol, observed_at) do nothing`,
    [observedAt, items.map((f) => f.symbol), items.map((f) => f.rate), items.map((f) => f.intervalHours),
      items.map((f) => f.nextFundingTime), items.map((f) => f.markPrice)],
  );
}

/** Most recent funding snapshot per symbol, if any. */
export async function latestFunding(db: Db, symbols: ReadonlyArray<string>): Promise<Map<string, FundingRow & { observedAt: number }>> {
  const { rows } = await db.query<{ symbol: string; rate: number; interval_hours: number; n: string | null; mark_price: number | null; o: string }>(
    `select distinct on (symbol) symbol, rate, interval_hours, mark_price,
       (extract(epoch from next_funding_time) * 1000)::bigint as n,
       (extract(epoch from observed_at) * 1000)::bigint as o
     from funding where symbol = any($1) order by symbol, observed_at desc`,
    [symbols],
  );
  return new Map(rows.map((r) => [r.symbol, {
    symbol: r.symbol, rate: r.rate, intervalHours: r.interval_hours, markPrice: r.mark_price,
    nextFundingTime: r.n == null ? null : Number(r.n), observedAt: Number(r.o),
  }]));
}

export interface SpecRow {
  symbol: string;
  base: string | null;
  quote: string | null;
  minTradeVolume: number | null;
  basePrecision: number | null;
  quotePrecision: number | null;
  minLeverage: number | null;
  maxLeverage: number | null;
  raw: Record<string, unknown>;
}

export async function upsertContractSpecs(db: Db, specs: ReadonlyArray<SpecRow>): Promise<void> {
  await inTransaction(db, async (c) => {
    for (const s of specs) {
      await c.query(
        `insert into contract_specs (symbol, base, quote, min_trade_volume, base_precision, quote_precision, min_leverage, max_leverage, raw, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         on conflict (symbol) do update set base = excluded.base, quote = excluded.quote,
           min_trade_volume = excluded.min_trade_volume, base_precision = excluded.base_precision,
           quote_precision = excluded.quote_precision, min_leverage = excluded.min_leverage,
           max_leverage = excluded.max_leverage, raw = excluded.raw, updated_at = now()`,
        [s.symbol, s.base, s.quote, s.minTradeVolume, s.basePrecision, s.quotePrecision, s.minLeverage, s.maxLeverage, JSON.stringify(s.raw)],
      );
    }
  });
}

export interface ScanRecord {
  timeframe: string;
  /** Open time (ms) of the last closed bar the scan used. */
  barTime: number;
  symbolsScanned: number;
  dropped: ReadonlyArray<{ symbol: string; reason: string }>;
  watchlist: Watchlist;
}

/** Saves a scan and its ranked entries; replaces an earlier scan of the same bar. */
export async function saveScan(db: Db, scan: ScanRecord): Promise<number> {
  return inTransaction(db, async (c) => {
    await c.query('delete from scans where timeframe = $1 and bar_time = to_timestamp($2 / 1000.0)', [scan.timeframe, scan.barTime]);
    const { rows } = await c.query<{ id: string }>(
      `insert into scans (timeframe, bar_time, symbols_scanned, dropped, skipped)
       values ($1, to_timestamp($2 / 1000.0), $3, $4, $5) returning id`,
      [scan.timeframe, scan.barTime, scan.symbolsScanned, JSON.stringify(scan.dropped), JSON.stringify(scan.watchlist.skipped)],
    );
    const id = Number(rows[0]!.id);
    for (const [i, e] of scan.watchlist.entries.entries()) {
      await c.query(
        `insert into watchlist_entries (scan_id, rank, symbol, signal, direction, tiers, core, score, components, fired_on, filters, reasons, readings)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, i + 1, e.symbol, e.signal, e.direction, e.tiers, e.core, e.score, JSON.stringify(e.components),
          e.firedOn, JSON.stringify(e.filters), e.reasons, JSON.stringify(e.readings)],
      );
    }
    return id;
  });
}

export interface StoredScan {
  id: number;
  timeframe: string;
  barTime: number;
  symbolsScanned: number;
  dropped: { symbol: string; reason: string }[];
  entries: { rank: number; symbol: string; signal: string; direction: string; tiers: string[]; score: number; firedOn: string[] }[];
}

export async function latestScan(db: Db, timeframe: string): Promise<StoredScan | null> {
  const { rows } = await db.query<{ id: string; t: string; symbols_scanned: number; dropped: StoredScan['dropped'] }>(
    `select id, (extract(epoch from bar_time) * 1000)::bigint as t, symbols_scanned, dropped
     from scans where timeframe = $1 order by bar_time desc limit 1`,
    [timeframe],
  );
  const s = rows[0];
  if (!s) return null;
  const e = await db.query<{ rank: number; symbol: string; signal: string; direction: string; tiers: string[]; score: number; fired_on: string[] }>(
    'select rank, symbol, signal, direction, tiers, score, fired_on from watchlist_entries where scan_id = $1 order by rank',
    [s.id],
  );
  return {
    id: Number(s.id), timeframe, barTime: Number(s.t), symbolsScanned: s.symbols_scanned, dropped: s.dropped,
    entries: e.rows.map((r) => ({ rank: r.rank, symbol: r.symbol, signal: r.signal, direction: r.direction, tiers: r.tiers, score: r.score, firedOn: r.fired_on })),
  };
}
