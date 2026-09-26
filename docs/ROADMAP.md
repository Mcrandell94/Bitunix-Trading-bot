# Roadmap

Stage 1 (RRG package, signal classifier, tests) is built. Everything below is
a plan and not built yet. Each stage ends with tests and a review before the
next starts. Live trading comes last and only after paper trading matches
the backtest.

## Stage 2: Bitunix data layer

Read-only market data, stored in Postgres.

**Verify every item against the official Bitunix API documentation before
writing code; don't rely on memory or third-party wrappers:**

- REST base URLs, the kline endpoint, its interval names (1m, 15m, 1h, 4h,
  1d), max candles per request, timestamp units, whether the open time or
  close time is returned, and how the still-open bar is marked.
- Funding: the current-rate and history endpoints, the rate's units
  (fraction vs percent), the settlement interval and times, and whether
  either varies by symbol. `annualizeFundingRate` needs both.
- Mark price and index price endpoints (TP/SL triggers are mark-price based).
- Contract specs per symbol: tick size, quantity step, minimum notional, max
  leverage, status, and the list of tradable USDT perps (the scanner universe).
- Rate limits (per IP, per key, per endpoint) and how 429s are signalled.
- WebSocket channels for klines and mark price, heartbeat rules, and
  reconnect behavior.

Design:

- Only closed bars go into the RRG. Align all symbols on bar open time and
  drop any symbol with a gap instead of forward-filling.
- Store candles, funding and contract specs in Postgres. Scans run on bar
  close for 1H, 4H and 1D, and write the watchlist to a table.
- No keys yet: market data is public. When keys arrive (stage 4), they live
  in the host's environment variables, never in the repo.
- Runtime: the packages are TypeScript sources today (run by vitest). The
  worker needs a build step (`tsc` emit) or a TS runner. Decide here.

## Stage 3: Strategy, risk engine and backtest

Entry model (SMC/ICT), per tier:

- HTF bias from FVGs, order blocks, premium/discount and SMT divergence
  (BTC vs ETH): Daily/4H for MTF, 4H/1H for LTF.
- Setup: liquidity sweep → market-structure shift with displacement →
  entry in the FVG or inverse FVG, inside killzones only. Session times are
  still to be agreed.
- RRG signals from stage 1 pick the extra symbols and the direction:
  `LAGGING_BREAKOUT` goes mainly to MTF, and MTF confirms on its own 4H and
  daily reads.

Risk (a separate module that every order must pass):

- Size from stop distance: LTF 0.25–0.5% per trade with the stop beyond the
  LTF sweep; MTF 0.5–1% per trade with at most 2–3x effective leverage.
- Every order carries TP and SL, triggered on mark price.
- BTC, ETH and XRP share one exposure cap across both tiers.
- LTF may only trade in the direction of an open MTF position.
- Separate daily loss limits per tier.
- No new entries within a set window before funding. The window length is
  still to be agreed.
- MTF exits: partials at 1R and 2R, then trail on 4H structure.

Backtest:

- Event-driven on closed bars, with the same code paths the live bot will
  use (no separate "backtest logic").
- Bitunix maker and taker fees from the published fee schedule, funding paid
  or received at the real settlement times, and slippage.
- Walk-forward tuning of RRG windows and signal thresholds per timeframe.
  The stage-1 defaults came from daily data and simulations.
- Report per tier and per signal: expectancy, win rate, average R, max
  drawdown, exposure, and how much of the result funding and fees account for.

## Stage 4: Paper trading

- Runs against live Bitunix data. Orders are simulated, or placed on a
  testnet if Bitunix offers one; check the docs.
- Verify order parameters against the docs here: order types, reduce-only,
  position mode (one-way vs hedge), margin mode, leverage setting, and
  attaching TP/SL with a mark-price trigger. Also verify the auth signing
  scheme and clock-skew tolerance.
- Keys: read-only or trade-only (never withdrawal), IP-allowlisted, stored as
  host environment variables.
- Reconcile paper fills against backtest assumptions before going live.

## Stage 5: Live

- Small size first, with a kill switch (flatten and halt), alerts on
  errors, rejected orders and loss-limit hits, and a daily reconciliation of
  positions against the exchange.

## Deployment

- **Bot:** a worker on a VPS or Railway, with its own Postgres.
- **The Crypto Rotation Dashboard is out of scope.** This project never
  changes it, deploys to it or connects to it. Showing bot state anywhere
  (on that dashboard or a view of the bot's own) is a separate decision
  for later.
- Sketch of the tables: `candles`, `funding`, `contract_specs`,
  `rrg_readings`, `watchlist`, `orders`, `fills`, `positions`, `equity`,
  `risk_events`.

## Open decisions

- The exact risk per trade within each tier's range, and the daily loss
  limit per tier.
- Killzone session times, and the pre-funding no-entry window.
- Scanner universe filters (minimum liquidity or volume, symbol age) and how
  many extra symbols each tier may hold at once.
