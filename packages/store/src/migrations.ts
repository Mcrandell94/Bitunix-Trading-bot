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
  {
    version: 3,
    name: 'dashboard controls',
    sql: `
      -- Kill switches set from the dashboard. They can only make the bot
      -- safer: turning live trading on stays in the environment variables.
      create table bot_controls (
        id          integer primary key default 1 check (id = 1),
        halt_live   boolean not null default false,
        updated_at  timestamptz not null default now()
      );
      insert into bot_controls default values;

      -- Entry pauses as time windows, so a paper replay honours them exactly
      -- when they were in force. resumed_at null = still paused.
      create table entry_pauses (
        id          bigserial primary key,
        scope       text not null check (scope in ('ALL', 'LTF', 'MTF')),
        paused_at   timestamptz not null,
        resumed_at  timestamptz
      );

      -- Every change made from the dashboard.
      create table control_events (
        id      bigserial primary key,
        time    timestamptz not null default now(),
        action  text not null,
        detail  jsonb not null default '{}',
        source  text
      );

      -- Latest computed views (e.g. the radar), replaced each step.
      create table bot_snapshots (
        key         text primary key,
        value       jsonb not null,
        updated_at  timestamptz not null default now()
      );
    `,
  },
  {
    version: 4,
    name: 'bot-owned positions',
    sql: `
      -- Positions the bot opened on the live account. Anything not listed
      -- here is the owner's, and the order code refuses to touch it.
      create table bot_positions (
        position_id  text primary key,
        symbol       text not null,
        side         text not null check (side in ('long', 'short')),
        client_id    text not null,
        opened_at    timestamptz not null default now(),
        closed_at    timestamptz
      );
    `,
  },
  {
    version: 5,
    name: 'live order ledger',
    sql: `
      -- Every live entry the executor decided on, written BEFORE anything is
      -- sent, keyed by its clientId, so a restart can never send it twice.
      -- status: planning, dry-run, sent, unknown (unclear reply; checked by
      -- clientId next step), filled, expired, gone, skipped, refused, failed.
      create table live_orders (
        client_id    text primary key,
        session_id   bigint,
        symbol       text not null,
        tier         text not null,
        side         text not null,
        entry        double precision not null,
        stop         double precision not null,
        take_profit  double precision not null,
        qty          double precision,
        risk_usd     double precision,
        status       text not null,
        reason       text,
        order_id     text,
        position_id  text,
        request      jsonb,
        placed_at    timestamptz not null,
        expires_at   timestamptz not null,
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now()
      );
      create index live_orders_open on live_orders (status) where status in ('planning', 'dry-run', 'sent', 'unknown');
    `,
  },
  {
    version: 6,
    name: 'live trade management',
    sql: `
      -- What the bot needs to manage its own live positions like the backtest:
      -- the plan it entered with and where the stop is now.
      alter table bot_positions
        add column tier text,
        add column entry double precision,
        add column initial_stop double precision,
        add column take_profit double precision,
        add column qty_initial double precision,
        add column stop double precision,
        add column partials_placed boolean not null default false;
    `,
  },
  {
    version: 7,
    name: 'HTF tier',
    sql: `
      alter table entry_pauses drop constraint entry_pauses_scope_check;
      alter table entry_pauses add constraint entry_pauses_scope_check check (scope in ('ALL', 'LTF', 'MTF', 'HTF'));
    `,
  },
  {
    version: 8,
    name: 'RRG at entry',
    sql: `
      -- Forward testing (owner): each paper entry's daily RRG strength vs BTC, the trade's way.
      alter table paper_trades add column rrg double precision;
      alter table paper_positions add column rrg double precision;
      alter table paper_orders add column rrg double precision;
    `,
  },
  {
    version: 9,
    name: 'live order leverage',
    sql: `
      -- The leverage a live entry gets and the coin's size class behind it (large / mid / small).
      alter table live_orders add column leverage integer, add column cap_class text;
    `,
  },
];
