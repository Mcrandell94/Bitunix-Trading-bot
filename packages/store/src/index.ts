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

/** 'last' = last-price candles (table candles), 'mark' = mark-price candles (table mark_candles). */
export type PriceKind = 'last' | 'mark';
const candleTable = (kind: PriceKind) => (kind === 'mark' ? 'mark_candles' : 'candles');

export async function upsertCandles(db: Db, symbol: string, interval: IntervalName, candles: ReadonlyArray<Candle>, kind: PriceKind = 'last'): Promise<number> {
  if (candles.length === 0) return 0;
  const res = await db.query(
    `insert into ${candleTable(kind)} (symbol, interval, open_time, open, high, low, close, volume)
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
export async function latestOpenTimes(db: Db, interval: IntervalName, symbols: ReadonlyArray<string>, kind: PriceKind = 'last'): Promise<Map<string, number>> {
  const { rows } = await db.query<{ symbol: string; t: string }>(
    `select symbol, (extract(epoch from max(open_time)) * 1000)::bigint as t
     from ${candleTable(kind)} where interval = $1 and symbol = any($2) group by symbol`,
    [interval, symbols],
  );
  return new Map(rows.map((r) => [r.symbol, Number(r.t)]));
}

/** Candles with openTime >= from, per symbol, oldest first. */
export async function loadCandles(db: Db, interval: IntervalName, symbols: ReadonlyArray<string>, from: number, kind: PriceKind = 'last'): Promise<Record<string, Candle[]>> {
  const { rows } = await db.query<{ symbol: string; t: string; open: number; high: number; low: number; close: number; volume: number | null }>(
    `select symbol, (extract(epoch from open_time) * 1000)::bigint as t, open, high, low, close, volume
     from ${candleTable(kind)} where interval = $1 and symbol = any($2) and open_time >= to_timestamp($3 / 1000.0)
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

// ---- Funding history ------------------------------------------------------

export async function upsertFundingHistory(db: Db, symbol: string, points: ReadonlyArray<{ time: number; rate: number }>): Promise<void> {
  if (points.length === 0) return;
  await db.query(
    `insert into funding_history (symbol, time, rate)
     select $1, to_timestamp(t / 1000.0), r from unnest($2::bigint[], $3::float8[]) as x(t, r)
     on conflict (symbol, time) do update set rate = excluded.rate`,
    [symbol, points.map((p) => p.time), points.map((p) => p.rate)],
  );
}

export async function loadFundingHistory(db: Db, symbols: ReadonlyArray<string>, from: number): Promise<Record<string, { time: number; rate: number }[]>> {
  const { rows } = await db.query<{ symbol: string; t: string; rate: number }>(
    `select symbol, (extract(epoch from time) * 1000)::bigint as t, rate from funding_history
     where symbol = any($1) and time >= to_timestamp($2 / 1000.0) order by symbol, time`,
    [symbols, from],
  );
  const out: Record<string, { time: number; rate: number }[]> = Object.fromEntries(symbols.map((s) => [s, []]));
  for (const r of rows) out[r.symbol]!.push({ time: Number(r.t), rate: r.rate });
  return out;
}

export async function loadContractSpecs(db: Db, symbols: ReadonlyArray<string>): Promise<Map<string, SpecRow & { updatedAt: number }>> {
  const { rows } = await db.query<{
    symbol: string; base: string | null; quote: string | null; min_trade_volume: number | null; base_precision: number | null;
    quote_precision: number | null; min_leverage: number | null; max_leverage: number | null; raw: Record<string, unknown>; u: string;
  }>(
    `select *, (extract(epoch from updated_at) * 1000)::bigint as u from contract_specs where symbol = any($1)`,
    [symbols],
  );
  return new Map(rows.map((r) => [r.symbol, {
    symbol: r.symbol, base: r.base, quote: r.quote, minTradeVolume: r.min_trade_volume, basePrecision: r.base_precision,
    quotePrecision: r.quote_precision, minLeverage: r.min_leverage, maxLeverage: r.max_leverage, raw: r.raw, updatedAt: Number(r.u),
  }]));
}

// ---- Paper trading ----------------------------------------------------------

export interface PaperSession {
  id: number;
  startedAt: number;
  startEquity: number;
  symbols: string[];
  config: Record<string, unknown>;
  codeSha: string | null;
}

export async function activePaperSession(db: Db): Promise<PaperSession | null> {
  const { rows } = await db.query<{ id: string; s: string; start_equity: number; symbols: string[]; config: Record<string, unknown>; code_sha: string | null }>(
    `select id, (extract(epoch from started_at) * 1000)::bigint as s, start_equity, symbols, config, code_sha
     from paper_sessions where active order by id desc limit 1`,
  );
  const r = rows[0];
  return r ? { id: Number(r.id), startedAt: Number(r.s), startEquity: r.start_equity, symbols: r.symbols, config: r.config, codeSha: r.code_sha } : null;
}

export async function createPaperSession(db: Db, s: Omit<PaperSession, 'id'>): Promise<PaperSession> {
  const { rows } = await db.query<{ id: string }>(
    `insert into paper_sessions (started_at, start_equity, symbols, config, code_sha)
     values (to_timestamp($1 / 1000.0), $2, $3, $4, $5) returning id`,
    [s.startedAt, s.startEquity, s.symbols, JSON.stringify(s.config), s.codeSha],
  );
  return { ...s, id: Number(rows[0]!.id) };
}

export interface PaperTradeRow {
  symbol: string; tier: string; side: string; source: string;
  openedAt: number; closedAt: number; entry: number; initialStop: number; qty: number;
  riskAmount: number; grossPnl: number; fees: number; funding: number; netPnl: number; r: number; fills: unknown;
}

/** Appends newly closed trades; trades already recorded are left exactly as they were. Returns how many were new. */
export async function recordPaperTrades(db: Db, sessionId: number, trades: ReadonlyArray<PaperTradeRow>, codeSha: string | null): Promise<number> {
  let added = 0;
  for (const t of trades) {
    const res = await db.query(
      `insert into paper_trades (session_id, symbol, tier, side, source, opened_at, closed_at, entry, initial_stop, qty,
         risk_usd, gross_usd, fees_usd, funding_usd, net_usd, r, fills, code_sha)
       values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       on conflict do nothing`,
      [sessionId, t.symbol, t.tier, t.side, t.source, t.openedAt, t.closedAt, t.entry, t.initialStop, t.qty,
        t.riskAmount, t.grossPnl, t.fees, t.funding, t.netPnl, t.r, JSON.stringify(t.fills), codeSha],
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

export interface PaperSnapshot {
  time: number;
  realizedEquity: number;
  totalEquity: number;
  positions: ReadonlyArray<{
    symbol: string; tier: string; side: string; source: string; openedAt: number; entry: number; stop: number; takeProfit: number;
    qty: number; qtyInitial: number; riskAmount: number; realizedNet: number; unrealizedPnl: number; lastPrice: number;
  }>;
  pending: ReadonlyArray<{ symbol: string; tier: string; side: string; source: string; entry: number; stop: number; takeProfit: number; qty: number; expiresAt: number }>;
}

/** Replaces the session's open positions and pending orders, and appends an equity point. */
export async function savePaperSnapshot(db: Db, sessionId: number, s: PaperSnapshot): Promise<void> {
  await inTransaction(db, async (c) => {
    await c.query('delete from paper_positions where session_id = $1', [sessionId]);
    await c.query('delete from paper_orders where session_id = $1', [sessionId]);
    for (const p of s.positions) {
      await c.query(
        `insert into paper_positions (session_id, symbol, tier, side, source, opened_at, entry, stop, take_profit, qty, qty_initial,
           risk_usd, realized_usd, unrealized_usd, last_price)
         values ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [sessionId, p.symbol, p.tier, p.side, p.source, p.openedAt, p.entry, p.stop, p.takeProfit, p.qty, p.qtyInitial,
          p.riskAmount, p.realizedNet, p.unrealizedPnl, p.lastPrice],
      );
    }
    for (const o of s.pending) {
      await c.query(
        `insert into paper_orders (session_id, symbol, tier, side, source, entry, stop, take_profit, qty, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))`,
        [sessionId, o.symbol, o.tier, o.side, o.source, o.entry, o.stop, o.takeProfit, o.qty, o.expiresAt],
      );
    }
    await c.query(
      `insert into paper_equity (session_id, time, realized_equity, total_equity, open_positions, pending_orders)
       values ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6)
       on conflict (session_id, time) do update set realized_equity = excluded.realized_equity, total_equity = excluded.total_equity,
         open_positions = excluded.open_positions, pending_orders = excluded.pending_orders`,
      [sessionId, s.time, s.realizedEquity, s.totalEquity, s.positions.length, s.pending.length],
    );
  });
}

export async function paperSummary(db: Db, sessionId: number): Promise<{ trades: number; netUsd: number; totalR: number; wins: number }> {
  const { rows } = await db.query<{ n: string; net: number | null; r: number | null; wins: string }>(
    `select count(*) as n, sum(net_usd) as net, sum(r) as r, count(*) filter (where net_usd > 0) as wins
     from paper_trades where session_id = $1`,
    [sessionId],
  );
  const r = rows[0]!;
  return { trades: Number(r.n), netUsd: r.net ?? 0, totalR: r.r ?? 0, wins: Number(r.wins) };
}

// ---- Dashboard ----------------------------------------------------------------

export interface DashboardData {
  session: PaperSession | null;
  lastStepAt: number | null;
  summary: { trades: number; wins: number; netUsd: number; totalR: number; feesUsd: number; fundingUsd: number };
  equity: { time: number; realized: number; total: number }[];
  positions: {
    symbol: string; tier: string; side: string; source: string; openedAt: number; entry: number; stop: number; takeProfit: number;
    qty: number; qtyInitial: number; riskUsd: number; realizedUsd: number; unrealizedUsd: number; lastPrice: number;
  }[];
  orders: { symbol: string; tier: string; side: string; source: string; entry: number; stop: number; takeProfit: number; qty: number; expiresAt: number }[];
  /** Most recent first. */
  trades: {
    symbol: string; tier: string; side: string; source: string; openedAt: number; closedAt: number; entry: number; initialStop: number;
    qty: number; riskUsd: number; feesUsd: number; fundingUsd: number; netUsd: number; r: number;
  }[];
  scans: StoredScan[];
}

const ms = (col: string, as = col) => `(extract(epoch from ${col}) * 1000)::float8 as ${as}`;

/** Everything the read-only dashboard shows, for the active paper session. */
export async function loadDashboard(db: Db, opts: { tradeLimit?: number; timeframes?: ReadonlyArray<string> } = {}): Promise<DashboardData> {
  const scans: StoredScan[] = [];
  for (const tf of opts.timeframes ?? ['1h', '4h', '1d']) {
    const s = await latestScan(db, tf);
    if (s) scans.push(s);
  }
  const session = await activePaperSession(db);
  const empty = { trades: 0, wins: 0, netUsd: 0, totalR: 0, feesUsd: 0, fundingUsd: 0 };
  if (!session) return { session, lastStepAt: null, summary: empty, equity: [], positions: [], orders: [], trades: [], scans };
  const id = session.id;

  const sum = (await db.query<{ n: string; wins: string; net: number | null; r: number | null; fees: number | null; funding: number | null }>(
    `select count(*) as n, count(*) filter (where net_usd > 0) as wins, sum(net_usd) as net, sum(r) as r,
       sum(fees_usd) as fees, sum(funding_usd) as funding
     from paper_trades where session_id = $1`, [id])).rows[0]!;
  const equity = (await db.query<{ time: number; realized: number; total: number }>(
    `select ${ms('time')}, realized_equity as realized, total_equity as total from paper_equity where session_id = $1 order by time`, [id])).rows;
  const positions = (await db.query<DashboardData['positions'][number]>(
    `select symbol, tier, side, source, ${ms('opened_at', '"openedAt"')}, entry, stop, take_profit as "takeProfit", qty, qty_initial as "qtyInitial",
       risk_usd as "riskUsd", realized_usd as "realizedUsd", unrealized_usd as "unrealizedUsd", last_price as "lastPrice"
     from paper_positions where session_id = $1 order by opened_at`, [id])).rows;
  const orders = (await db.query<DashboardData['orders'][number]>(
    `select symbol, tier, side, source, entry, stop, take_profit as "takeProfit", qty, ${ms('expires_at', '"expiresAt"')}
     from paper_orders where session_id = $1 order by expires_at`, [id])).rows;
  const trades = (await db.query<DashboardData['trades'][number]>(
    `select symbol, tier, side, source, ${ms('opened_at', '"openedAt"')}, ${ms('closed_at', '"closedAt"')}, entry, initial_stop as "initialStop",
       qty, risk_usd as "riskUsd", fees_usd as "feesUsd", funding_usd as "fundingUsd", net_usd as "netUsd", r
     from paper_trades where session_id = $1 order by closed_at desc, symbol limit $2`, [id, opts.tradeLimit ?? 200])).rows;

  return {
    session,
    lastStepAt: equity.at(-1)?.time ?? null,
    summary: {
      trades: Number(sum.n), wins: Number(sum.wins), netUsd: sum.net ?? 0, totalR: sum.r ?? 0,
      feesUsd: sum.fees ?? 0, fundingUsd: sum.funding ?? 0,
    },
    equity, positions, orders, trades, scans,
  };
}
