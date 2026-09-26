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
  {
    version: 2,
    name: 'paper trading',
    sql: `
      -- Mark-price candles (stops and targets trigger on mark price).
      create table mark_candles (like candles including all);

      -- Funding settlements; rate is a fraction per settlement.
      create table funding_history (
        symbol  text not null,
        time    timestamptz not null,
        rate    double precision not null,
        primary key (symbol, time)
      );

      -- One paper session at a time is active: a fixed universe and config
      -- replayed from started_at by the backtest engine.
      create table paper_sessions (
        id            bigserial primary key,
        started_at    timestamptz not null,
        start_equity  double precision not null,
        symbols       text[] not null,
        config        jsonb not null,
        code_sha      text,
        active        boolean not null default true,
        created_at    timestamptz not null default now()
      );

      -- Closed paper trades. Append-only: a trade is written once, when it
      -- closes, with the code version that closed it, and never rewritten.
      create table paper_trades (
        session_id    bigint not null references paper_sessions(id) on delete cascade,
        symbol        text not null,
        tier          text not null,
        side          text not null,
        source        text not null,
        opened_at     timestamptz not null,
        closed_at     timestamptz not null,
        entry         double precision not null,
        initial_stop  double precision not null,
        qty           double precision not null,
        risk_usd      double precision not null,
        gross_usd     double precision not null,
        fees_usd      double precision not null,
        funding_usd   double precision not null,
        net_usd       double precision not null,
        r             double precision not null,
        fills         jsonb not null,
        code_sha      text,
        recorded_at   timestamptz not null default now(),
        primary key (session_id, symbol, tier, side, opened_at)
      );

      -- Current state, replaced every step.
      create table paper_positions (
        session_id    bigint not null references paper_sessions(id) on delete cascade,
        symbol        text not null,
        tier          text not null,
        side          text not null,
        source        text not null,
        opened_at     timestamptz not null,
        entry         double precision not null,
        stop          double precision not null,
        take_profit   double precision not null,
        qty           double precision not null,
        qty_initial   double precision not null,
        risk_usd      double precision not null,
        realized_usd  double precision not null,
        unrealized_usd double precision not null,
        last_price    double precision not null,
        updated_at    timestamptz not null default now()
      );
      create table paper_orders (
        session_id    bigint not null references paper_sessions(id) on delete cascade,
        symbol        text not null,
        tier          text not null,
        side          text not null,
        source        text not null,
        entry         double precision not null,
        stop          double precision not null,
        take_profit   double precision not null,
        qty           double precision not null,
        expires_at    timestamptz not null
      );

      -- Equity after each step: realized, and including open positions.
      create table paper_equity (
        session_id      bigint not null references paper_sessions(id) on delete cascade,
        time            timestamptz not null,
        realized_equity double precision not null,
        total_equity    double precision not null,
        open_positions  integer not null,
        pending_orders  integer not null,
        primary key (session_id, time)
      );
    `,
  },
];
