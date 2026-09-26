# Roadmap

Stages 1 (RRG scanner), 2 (read-only market data, Postgres, bar-close
worker) and 3 (SMC entry model, risk engine, backtester) are built. Stage 2
was checked against the live API on 2026-09-26. Stage 3 is waiting on a
backtest run from a machine that can reach Bitunix. Everything from stage 4
on is a plan and not built yet.

Note for hosting: Bitunix was unreachable from the US cloud this was built
in, but reachable from the owner's own machine. Check that the VPS or
Railway region can reach `fapi.bitunix.com` (run `npm run probe` there)
before deploying. Each stage ends with tests and a review before the
next starts. Live trading comes last and only after paper trading matches
the backtest.

## Stage 2: Bitunix data layer (built)

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

## Stage 3: Strategy, risk engine and backtest (built)

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

### Tuning results (2026-09-26)

- **Setup:** 13 coins. Train Sep 2025–May 2026, test Jun–Sep 2026; one
  setting at a time.
- **Before tuning, full year:** 62 trades, 59.7% win rate, +0.09R average,
  +2.3%, max drawdown 3.2%.
- **Adopted:** displacement 1.0 ATR (was 1.2). Train went +7.2R → +8.8R; the
  held-out test went −1.8R → −1.2R; full year +5.5R → +7.6R (+3.4%).
- **Rejected, because they made things worse:**
  - a looser bias rule (−7 to −9R, drawdowns of 10–13%);
  - entering nearer the gap edge;
  - longer order expiry;
  - a 3R LTF target;
  - skipping tight stops (no effect).
- **Spec changes, for the owner to decide:**
  - Limit-order targets and partials: about +2R/year from fees, and better
    on test too.
  - LTF without an MTF position: −20R. Keep the rule.
  - Stacking: no benefit.
- **Conclusion:** the edge is thin (around +0.1R per trade), and the last 4
  months were slightly negative. Not ready for real money; paper trading
  on live data is the next real test.

## Stage 4: Paper trading

- Runs against live Bitunix data. Orders are simulated, or placed on a
  testnet if Bitunix offers one; check the docs.
- Verify order parameters against the docs here: order types, reduce-only,
  position mode (one-way vs hedge), margin mode, leverage setting, and
  attaching TP/SL with a mark-price trigger. Also verify the auth signing
  scheme and clock-skew tolerance.
- The `TRADING_ENABLED` master switch (already in the worker config, off by
  default) must gate every order path. An order attempted while it is off is
  refused and logged. The authenticated client and linked API keys arrive
  here, with the switch off until paper results are reviewed.
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

- Decided 2026-09-26:
  - risk per trade: LTF 0.25%, MTF 0.5% (revised 2026-09-26 for the small
    live account: LTF 1%, MTF 2% at the stop, never above 3%);
  - daily loss limits: LTF 1.5%, MTF 3% (revised: LTF 4%, MTF 8%, about
    four full losses per tier);
  - LTF killzones: London, NY AM and Asia;
  - no entries in the 15 minutes before funding.
- Still open:
  - max effective leverage for LTF (3x placeholder);
  - the shared BTC/ETH/XRP exposure cap (3x equity placeholder);
  - how many extra symbols each tier may hold at once;
  - scanner liquidity filters beyond the $10M 24h volume default.
- Tune after the first real backtest:
  - displacement, entry-point and expiry settings;
  - the bias rule;
  - the MTF runner cap (5R).
