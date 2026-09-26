// Schema migrations, applied in order by migrate(). Never edit a shipped
// migration; add a new one.

export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'market data and scans',
    sql: `
      create table candles (
        symbol     text not null,
        interval   text not null,
        open_time  timestamptz not null,
        open       double precision not null,
        high       double precision not null,
        low        double precision not null,
        close      double precision not null,
        volume     double precision,
        primary key (symbol, interval, open_time)
      );

      -- One row per symbol per snapshot. rate is per funding interval, as a fraction.
      create table funding (
        symbol             text not null,
        observed_at        timestamptz not null,
        rate               double precision not null,
        interval_hours     double precision not null,
        next_funding_time  timestamptz,
        mark_price         double precision,
        primary key (symbol, observed_at)
      );

      create table contract_specs (
        symbol           text primary key,
        base             text,
        quote            text,
        min_trade_volume double precision,
        base_precision   integer,
        quote_precision  integer,
        min_leverage     double precision,
        max_leverage     double precision,
        raw              jsonb not null,
        updated_at       timestamptz not null default now()
      );

      -- One scan per timeframe per closed bar; a re-run replaces it.
      create table scans (
        id               bigserial primary key,
        timeframe        text not null,
        bar_time         timestamptz not null,
        created_at       timestamptz not null default now(),
        symbols_scanned  integer not null,
        dropped          jsonb not null,
        skipped          jsonb not null,
        unique (timeframe, bar_time)
      );

      create table watchlist_entries (
        scan_id     bigint not null references scans(id) on delete cascade,
        rank        integer not null,
        symbol      text not null,
        signal      text not null,
        direction   text not null,
        tiers       text[] not null,
        core        boolean not null,
        score       double precision not null,
        components  jsonb not null,
        fired_on    text[] not null,
        filters     jsonb not null,
        reasons     text[] not null,
        readings    jsonb not null,
        primary key (scan_id, rank)
      );
      create index watchlist_entries_symbol on watchlist_entries (symbol);
    `,
  },
];
