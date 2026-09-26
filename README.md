# Bitunix trading bot

A USDT-perpetuals bot for Bitunix, built in stages. **It does not trade.**
Stage 1 is the RRG scanner (pure functions). Stage 2 adds a read-only
Bitunix market-data layer, Postgres storage and a worker that scans on every
bar close. Stage 3 adds the SMC/ICT entry model, the risk engine and a
backtester. It uses public endpoints only: no API keys, and no order code.
`TRADING_ENABLED` is a master switch that stays `false`.

This is a standalone project. The only thing it takes from the
[Crypto Rotation Dashboard](https://github.com/Mcrandell94/Crypto-rotation-dashboard)
is its RRG math, copied in unchanged (see below). The bot never imports from,
calls, deploys to or writes to the dashboard. The plan for later stages is in
[docs/ROADMAP.md](docs/ROADMAP.md).

```
npm ci
npm test            # vitest (DB tests skip without TEST_DATABASE_URL)
TEST_DATABASE_URL=postgres://… npm test   # also runs the Postgres tests
npm run typecheck   # tsc, strict
npm run probe       # checks the live Bitunix API against every assumption
npm run backtest    # downloads history, backtests, writes backtest-report.txt
```

Running the worker (copy `.env.example` to `.env` or set the variables on
the host):

```
npm run migrate      # create/upgrade the schema
npm run scan -- 4h   # one scan of the last closed 4H bar, then exit
npm start            # migrate, then scan every bar close until stopped
```

**Where it runs:**
- **GitHub:** the code. Every push runs the tests and typecheck, including
  Postgres, in `.github/workflows/ci.yml`.
- **GitHub Actions:** backtests and the API probe, on demand. Open **Actions →
  Backtest → Run workflow**; the report appears on the run's page.
- **Railway:** the live worker and its Postgres. `railway.json` sets the
  build (`npm ci`), the start command (`npm start`) and restarts on failure.
  - In Railway, deploy the repo, add a Postgres database, and set the
    variables from `.env.example`, with `DATABASE_URL` pointing to Railway's
    Postgres.
  - Turn on "Wait for CI" so a change only deploys after its tests pass.
  - Pick a region that can reach Bitunix: run `npm run probe` there first.

Logs are JSON lines on stdout.

## Layout

| Package | What it is |
| --- | --- |
| `packages/rrg` (`@bot/rrg`) | The dashboard's RRG math, vendored unchanged, plus the confirmation filters ported to TypeScript. |
| `packages/signals` (`@bot/signals`) | Per-symbol, per-benchmark signal classifier, scoring, and the ranked watchlist. |
| `packages/marketdata` (`@bot/marketdata`) | Candle type, bar clock, closed-bar filter, gap-free alignment across symbols. Pure. |
| `packages/bitunix` (`@bot/bitunix`) | Public REST client (throttle, retries), response parsers, paged kline fetch, the live probe. |
| `packages/store` (`@bot/store`) | Postgres schema and migrations; candles, funding, contract specs, scans and watchlist entries. |
| `packages/worker` (`@bot/worker`) | Config, universe selection, the scan pipeline, the bar-close schedule, the CLI. |
| `packages/smc` (`@bot/smc`) | Swings, FVGs, structure trend; sweep → MSS → FVG/iFVG setups; HTF bias (structure, premium/discount, FVG/OB taps, BTC/ETH SMT). Pure, no lookahead. |
| `packages/risk` (`@bot/risk`) | `checkEntry()`: sizing, leverage and core-exposure caps, tier rules, killzones, the funding gap. Every order passes through it. |
| `packages/backtest` (`@bot/backtest`) | Event-driven backtester using the same strategy and risk code, plus `npm run backtest`. |

## Stage 2: market data

**Every scan:** after each bar closes (plus `CLOSE_DELAY_MS`), the worker
does the following for every timeframe that closed. 1H closes hourly, 4H
every four hours and daily at 00:00 UTC.

1. Picks the universe: BTC/ETH/XRP always. With `UNIVERSE=all` it adds USDT
   perps with at least `MIN_QUOTE_VOLUME_24H` of 24h volume, most liquid
   first, up to `MAX_EXTRA_SYMBOLS`.
2. Snapshots funding for all of them, in one request.
3. Fetches only the closed bars missing from Postgres. The first run
   backfills `HISTORY_BARS`; after that it's one request per symbol.
4. Cuts every symbol to the same window of closed bars. Any symbol that is
   stale, newly listed, gappy or off-grid is dropped and recorded; gaps are
   never forward-filled.
5. Runs `buildWatchlist`, with funding annualized from the latest snapshot,
   and saves the ranked result. Re-running a bar replaces its scan.

A funding or ticker outage doesn't stop a scan. Missing BTC or ETH data
does. A failed timeframe doesn't stop the others.

**What's verified about Bitunix.** Each fact is tagged in
`packages/bitunix/src/api.ts` and `parse.ts`. Sources: Bitunix's official
SDK repo ([BitunixOfficial/open-api](https://github.com/BitunixOfficial/open-api)),
plus `npm run probe` against the live API on 2026-09-26.

- **Official SDK:**
  - base URL `https://fapi.bitunix.com`;
  - kline params (intervals `1m`…`1d`, `limit` max 200, `startTime`/`endTime`
    in ms, `LAST_PRICE`/`MARK_PRICE`);
  - the `{ code, msg, data }` envelope;
  - error 10006 "Request too frequently".
- **Live probe:**
  - candle fields;
  - `time` is the open time on UTC 1H/4H/1D boundaries;
  - rows come newest first and never include the still-open bar;
  - `quoteVol` is USDT volume;
  - a capped range returns its latest 200 bars;
  - the funding, ticker and trading-pairs fields;
  - funding intervals of 1, 2, 4 and 8 hours.
- **Batch `fundingRate` is a percent** (`0.01` = 0.01% per interval). The
  median across 895 symbols was 0.005. The parser converts it to a fraction.
- **Funding-history `fundingRate` is already a fraction** (BTC around
  0.00001). Rows are `{ fundingRate, fundingTime, markPrice }`.
- Symbols with `isApiSupported: false` are left out of the scanner and the
  backtest; Bitunix rejects them with error 20015.
- **Still unknown:** rate limits. The client sends at most one request per
  200 ms.

Re-run `npm run probe` from anywhere that can reach Bitunix to re-check all
of this; it exits non-zero on any mismatch. Kline paging doesn't depend on which 200 bars Bitunix
returns for a long range, or on whether `endTime` is inclusive: every request
asks for a window of at most 200 bars.

## Paper trading

Set `PAPER_TRADING=true` on the Railway worker. It then wakes every 15
minutes and does the following:
1. On the first run, it starts a **session**. The universe (BTC/ETH/XRP plus
   the `PAPER_EXTRAS` most liquid API-tradable coins), the full strategy
   config and the code version are frozen in `paper_sessions`.
2. It syncs the session's 15m, 1H, 4H and 1D candles, 15m mark-price candles,
   funding history and contract steps into Postgres.
3. It replays the backtest engine from the session start to the last closed
   15m bar, leaving open positions open. Paper results are therefore the
   same code, fills and costs as a backtest; a test checks they match exactly.
4. Newly closed trades go into `paper_trades`, **append-only** and stamped
   with the code version, so a later code change can't rewrite the record.
   Open positions, pending orders and equity are refreshed in
   `paper_positions`, `paper_orders` and `paper_equity`.

To see results, open the **dashboard** (below), the worker logs (`paper:
step` lines show equity, open positions, trades and total R) or the Railway
Postgres **Data** tab. To trade different settings, deactivate the session
(`update paper_sessions set active = false`) and a new one starts at the
next step.

## Dashboard

The worker serves a web page with paper equity, open positions, pending
orders, closed trades, the latest RRG watchlist per timeframe, the linked
Bitunix account and the session details, plus:

**Kill switches.** They can only make the bot safer; turning live trading
on is only possible in Railway (`TRADING_ENABLED`, `LIVE_DRY_RUN`).
- *Pause entries* (all, MTF or LTF): no new entries; open positions keep
  being managed. Stored as time windows (`entry_pauses`), so the paper
  replay applies each pause exactly when it was in force. Takes effect at
  the next 15-minute step.
- *Halt live orders*: the order gate refuses every write at once, and stays
  halted across restarts (`bot_controls`).
- *Flatten everything*: pauses all entries, halts live orders, then cancels
  the bot's open orders and market-closes the bot's positions. Your own
  trades are left alone. Typed confirmation. In dry-run it only reports.
- Every change is logged in `control_events` and shown under the switches.

**What the bot is watching** (the radar, rebuilt every paper step with the
engine's own bias, RRG gate and rules): for each symbol and tier, its
status (in position, order placed, setup forming, waiting, blocked), a
plain sentence of what it's waiting for (e.g. "swept sell-side liquidity at
X; needs a 15m close above Y (0.7% away) within 12 bars"), the bias per
timeframe, the rotation signal, the rules that would block an entry right
now, and setups skipped in the last 24 hours with the reason.

Controls are POSTs that need the password, JSON, a custom header and a
same-host Origin, so another site can't trigger them.

- Set `DASHBOARD_PASSWORD` (12+ characters) on the worker to turn it on, and
  give the service a public domain (Railway → service → Settings →
  Networking → Generate domain). The browser asks for a password; any
  username works.
- It listens on `PORT` (Railway sets it; 8080 otherwise). `/healthz` is the
  only page without a password.
- A bad dashboard setting is logged and skipped; it never stops the worker.

## Linking the Bitunix account

Add `BITUNIX_API_KEY` and `BITUNIX_API_SECRET` to the worker's Railway
variables (never to a file in this repo). Create the key on Bitunix with
**trading permission only, no withdrawal**. Railway's outbound IP isn't
fixed on the default plan, so an IP-whitelisted key may be refused; the
logs and dashboard say so in plain words if it is.

With keys set and trading off, the worker only **reads** the account at
start-up and every wake-up: balance, open positions and open orders appear
in the logs (`account: connected`) and on the dashboard. `npm run account`
does the same check once.

**Your own trades are never touched.** The bot only acts on what it
created: orders whose `clientId` starts with `bot-`, and positions it
registered in `bot_positions` when its own entry filled. The trade API
enforces this on every write, in dry-run too: closing, TP/SL changes and
market-closes need a bot-owned position; cancels need a bot order; an
opening order needs a `bot-` clientId and is refused while you hold a
position on the same symbol and side (hedge mode could merge them); and
leverage or margin-mode changes are refused on a symbol where you have a
position or order, since they would change yours too.

**Writes go through one gate** (`writeMode` in `@bot/bitunix`):

| `TRADING_ENABLED` | `LIVE_DRY_RUN` | What an order does |
| --- | --- | --- |
| false | true (default) | reported in the logs, not sent |
| true | true (default) | reported in the logs, not sent |
| false | false | refused before any network call |
| true | false | **sent to Bitunix** |

What's built so far (stage 5 foundations, `packages/bitunix/src`):
- `sign.ts`: request signing, checked against signatures computed by
  Bitunix's own Node and Python SDK code.
- `client.ts`: `createPrivateClient`. Writes are retried only when Bitunix
  refused them for rate limiting; after a timeout, network error or 5xx an
  order may exist, so the error is marked `ambiguous` and never blindly
  retried (orders carry a `clientId` to look them up instead).
- `trade.ts`: account, positions, orders and TP/SL reads; order, leverage,
  margin-mode, position-mode, TP/SL and close writes; and pure order
  planning. `planEntry` rounds prices to the pair's precision (stop away
  from entry), floors the size so the loss at the stop never exceeds the
  risk budget, refuses stops that liquidation could beat at the chosen
  leverage, and attaches the stop (MARK price, market) and target (MARK
  price trigger, limit) to the order. `planTarget` places partial targets
  as POST_ONLY hedge-mode closes (always maker); `planStopMove` moves the
  position's stop.

**The executor** (`packages/worker/src/executor.ts`) follows the paper
replay onto the real account after every 15-minute step:
- Each entry the strategy placed at this close becomes a live intent, sized
  from the real balance: the tier's risk (3% / 5%, never above 5%) of
  equity at the stop, capped so the position stays within the coin's
  leverage class, then rounded to the pair's precision and minimum. Too
  small or unsafe: skipped, with why.
- Leverage by coin size: 10x large caps (BTC, ETH, XRP, SOL, SUI, BNB,
  DOGE, ADA, TRX, LINK, AVAX, LTC, BCH, TON), 5x mid caps, 3x smaller coins.
  Bitunix doesn't publish market cap, so non-large caps are split by the
  max leverage Bitunix allows on the pair (50x or more = mid). The pair is
  set to that leverage (isolated margin) first, and the bot only trades at
  leverage it set itself: if you have a position or order on the pair (so
  changing it would change yours), it skips the trade. `LIVE_LEVERAGE` is
  an upper bound (default 10).
- Daily loss stop on the real account: no new entries once equity is down
  9% (LTF) / 15% (MTF) from the first step of the UTC day (your own trades
  count too).
- The stop and final target ride on the entry order (MARK-price triggers).
- Every intent is claimed in `live_orders` by a deterministic `bot-`
  clientId before anything is sent, so a restart never sends it twice; an
  unclear reply is looked up by clientId next step, never resent.
- Entries still resting past their window are cancelled; a fill is
  registered as the bot's position (only when exactly one new position of
  that symbol and side appeared).
- The dashboard's **Live orders** panel shows each decision and its reason.

**Live trade management** (`manage.ts`, applied by the executor every
step) follows the same plan as the backtest and paper replay:
- right after a fill, partial targets rest on the book as POST_ONLY
  limits (always maker): MTF 1/3 at 1R and 1/3 at 2R (clientIds
  `bot-t1-…`, `bot-t2-…`, never sent twice);
- once the first partial has filled, the stop moves to breakeven
  (position TP/SL modified, target kept);
- after that, at each 4H close, the stop trails to the latest confirmed
  4H swing, only ever tightening;
- the rest exits at the entry's attached target or the stop; when the
  position closes, leftover bot targets are cancelled and it's recorded
  closed. LTF keeps its single 2R target. Before real money,
check on a tiny position the facts marked DOCS-QUOTED or ASSUMED in
`trade.ts` (hedge-mode close side, position side values).

## Stage 3: strategy, risk and backtest

**Entry model** (`@bot/smc`), on the entry timeframe (LTF 15m, MTF 1H):
1. **Sweep:** a candle wicks below a known swing low and closes back above
   it (mirrored for shorts).
2. **MSS:** a later candle is the first to close above the last swing high
   before the sweep, and the leg contains a displacement candle: body at
   least 1.0 ATR (tuned from 1.2) and at least 60% of its range.
3. **Entry:** a limit order at the middle (CE) of the FVG the leg left. It
   prefers the displacement candle's own gap; if the leg left none, it uses
   an iFVG, a bearish gap the leg closed back above. The setup is confirmed
   one bar after the MSS, because a gap needs its third candle.
4. **Stop:** 0.1 ATR beyond the sweep wick.

A swing is only usable once it's confirmed. A test checks that every query
on the full series matches the same query on the series cut off at that bar.

**Bias:** direction comes from the higher timeframe (MTF daily, LTF 4H),
and the lower one (MTF 4H, LTF 1H) can only veto it.
- **Long:** up-structure plus at least one of: discount, a tap of an
  unmitigated bullish FVG or order block, or bullish BTC/ETH SMT.
- **Short:** the mirror image.
- A setup is only taken in the bias direction.

**RRG gate:** BTC, ETH and XRP trade on bias alone. Any other symbol needs
a current RRG signal for that tier in the same direction:
- **LTF:** 1H signals;
- **MTF:** 4H and daily signals, plus 1H `LAGGING_BREAKOUT`.

**Risk** (`checkEntry`, your settings from 2026-09-26):

| Rule | LTF | MTF |
| --- | --- | --- |
| Risk per trade (loss at the stop; never above 5%) | 3% | 5% |
| Daily loss limit (realized, UTC day) | 9% | 15% |
| Max effective leverage per position (backtest/paper; live: 10x / 5x / 3x by coin size) | 5x | 5x |
| Entry windows | any time (killzones dropped 2026-09-26) | any time |
| Needs a same-direction MTF position on the symbol | no (tiers independent; may run alongside MTF) | no |

- Both tiers: no new entries in the 15 minutes before funding, and one
  position per symbol per tier.
- BTC, ETH and XRP positions plus pending entries share one cap of 3x
  equity; an entry is shrunk to fit or rejected.
- Every order carries SL and TP with a mark-price trigger.
- 3x leverage and the 3x core cap are placeholders until you decide them.

**Exits:** targets and partials rest as reduce-only limit orders (maker fee);
the stop is always a mark-price trigger. That's the owner's decision from
2026-09-26, and it was better on both tuning and test windows.
- **LTF:** a fixed 2R target.
- **MTF:** a third off at 1R and a third at 2R, stop to breakeven at 1R,
  then the rest trails on confirmed 4H swings, capped by a 5R target.

**Backtest** (`npm run backtest -- --days 90 --extras 10`): downloads 15m,
1H, 4H and 1D candles, 15m mark-price candles, funding history and contract
steps for BTC/ETH/XRP plus the most liquid extras, caching them in
`.cache/backtest`. It then steps through 15m bars:
- limit entries fill as maker (0.02%) from the bar after the setup;
- stops and targets trigger on mark price and fill as taker (0.06%) with
  2 bps slippage;
- a bar that touches both the stop and the target counts as a stop;
- funding is paid or received at each real settlement.

It writes `backtest-report.txt` (per tier and per signal source: trades,
win rate, average R, net P&L, fees, funding, max drawdown, and why setups
were skipped) and `backtest-trades.csv`. Where a symbol has no funding
history, the backtest assumes 0.01% every 8h and says so in the report.

## `@bot/rrg`

- `src/rrgMath.js` is a byte-for-byte copy of the dashboard repo's
  `app/lib/rrgMath.js` at commit `3434af8` (sha256 `8018fb70…45db`).
  It provides `computeSeries`, `quadrantOf`, `quadrantStreak`, `heading` and
  `RRG_PRESETS`, with types in `rrgMath.d.ts`. Don't edit it. If the
  dashboard's copy changes, copy it again, then update the pinned hash and
  golden values in `test/rrgMath.parity.test.ts`.
- The parity test replays every assertion in the dashboard's own
  `rrgMath.test.js`. It also pins numbers produced by running the dashboard's
  file for each preset, and pins the file's hash.
- `src/overlays.ts` ports `relativeVolume`, `absoluteTrend` and
  `fundingFlag`/`FUNDING_HOT` from the dashboard's `rrgOverlays.js`, with the
  same behavior; its tests replay the dashboard's values. It adds
  `annualizeFundingRate(rate, intervalHours)` for per-interval exchange
  funding. The filters read volume, the asset's own price and funding. They
  never touch an RS coordinate and only feed the score.

**Windows are bars, not days.** The math only indexes arrays, so
`trendWindow: 10` means 10 bars on 1H, 4H or daily. The dashboard's comments
say "days" only because it feeds daily closes.

## `@bot/signals`

`buildWatchlist({ timeframe, series })` takes aligned closes (plus optional
volume and funding) for every symbol, including `BTCUSDT` and `ETHUSDT`,
which double as the benchmarks. It returns ranked entries plus the symbols
it skipped and why. Each symbol is read against BTC and against ETH (never
against itself). Each reading goes through one classifier, and at most one
signal fires per reading because each signal lives in a different quadrant:

| Signal | Direction | Rule |
| --- | --- | --- |
| `LEADING_ENTRY` | long | Improving→Leading within `freshBars` (3), heading rising (dy > 0 over 3 bars). |
| `LAGGING_BREAKOUT` | long, mainly MTF | Lagging→Improving within `freshBars` (that is RS-Momentum crossing 100), heading steep NE (45°–90°), tail velocity ≥ 0.9/bar. |
| `WEAKENING_HOOK` | long | RS-Ratio ≥ 100, RS-Momentum < 100, heading turned up: dy > 0 after falling into a momentum trough inside the tail. |
| `SHORT_ROLLOVER` | short | Entered Lagging within `freshBars`, via Leading→Weakening→Lagging or a failed Improving→Lagging. |

A one-bar diagonal jump (for example Lagging straight to Leading) counts as
passing through the quadrant the straight line between the two points
crosses. A V-reversal that jumps into Leading therefore still reads as
Improving→Leading.

**Routing.** 1H RRG feeds LTF; 4H and daily feed MTF. `LAGGING_BREAKOUT`
routes to `['MTF', 'LTF']` from 1H and to `['MTF']` from 4H or daily.

**Score (0–100)**: weighted mean of six components, each 0–1.

| Component | Weight | How |
| --- | --- | --- |
| Dual-benchmark agreement | 0.30 | Both fired the same signal 1 · other fired a same-direction signal 0.75 · other in a supportive quadrant 0.5 · no second read (symbol is a benchmark, or too little history) 0.4 · opposed 0 |
| Tail velocity | 0.20 | Mean RS step per bar ÷ 1.1, capped at 1 |
| Time in quadrant | 0.15 | 1 on the first bar, falling to 0 over `tailLength` bars |
| Relative volume | 0.15 | 0 at ≤ 0.8×, 1 at ≥ 1.5× (7 vs 30 bars) |
| Absolute trend | 0.10 | 1 if price is on the signal's side of its 20-bar SMA, else 0 |
| Funding | 0.10 | Crowded on your side 0 · neutral 0.7 · the other side paying 1 |

An unknown filter (no volume, no funding) scores a neutral 0.5.

### Defaults and what to re-tune

The RRG windows are the dashboard's Balanced preset (trend 10, momentum 10,
smoothing 3, tail 7), which was tuned on daily closes. The velocity gates come
from simulated regime-switching paths in z-score mode: median tail velocity
≈ 0.72, p75 ≈ 0.91, p90 ≈ 1.11. Z-scoring divides out each pair's
volatility, so these are roughly timeframe-independent. Every threshold and
weight is in `DEFAULT_CONFIG` and is a starting point for the backtest stage.

Behaviors the backtest should look at:

- **Steady trends park on a plateau.** With z-scored RS, a constant relative
  trend holds RS-Ratio near 101.5 (or 98.5) while RS-Momentum drifts around
  100. That produces low-velocity `WEAKENING_HOOK`s. They score low but
  still appear.
- **A capitulation reads as Improving before it reverses.** RS-Ratio relaxes
  off its floor while the asset is still underperforming. The velocity gate
  keeps that from counting as a breakout (tested).
- **About a third of simulated V-reversals cross Improving at 34°–44°,**
  under the 45° "steep" gate. They still fire `LEADING_ENTRY` a bar or two
  later.

## Tests

Synthetic price series build BTC, ETH and assets from relative-performance
regimes, for example "underperform 0.6%/bar for 40 bars, then outperform
1.2%/bar". Each signal type fires against both benchmarks at a known bar,
with negative controls a few bars earlier or later. Each shape is also
checked across 30 noise seeds. Other tests cover each rule on hand-built RRG
points, every score component, the ranking, and the guarantee that the
filters can't change RS readings (volume ×3 and 60%/yr funding produce
identical readings and signals). They also check that timeframe labels only
change routing, and that malformed input is skipped or rejected.
