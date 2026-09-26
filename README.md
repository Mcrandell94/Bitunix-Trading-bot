# Bitunix trading bot

A USDT-perpetuals bot for Bitunix, built in stages. **It does not trade.**
Stage 1 is the RRG scanner (pure functions). Stage 2 adds a read-only
Bitunix market-data layer, Postgres storage and a worker that scans on every
bar close. It uses public endpoints only: no API keys, and no order code.
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
```

Running the worker (copy `.env.example` to `.env` or set the variables on
the host):

```
npm run migrate      # create/upgrade the schema
npm run scan -- 4h   # one scan of the last closed 4H bar, then exit
npm start            # migrate, then scan every bar close until stopped
```

On Railway or a VPS: a Postgres database, the variables from `.env.example`,
and `npm start` as the start command. Logs are JSON lines on stdout.

## Layout

| Package | What it is |
| --- | --- |
| `packages/rrg` (`@bot/rrg`) | The dashboard's RRG math, vendored unchanged, plus the confirmation filters ported to TypeScript. |
| `packages/signals` (`@bot/signals`) | Per-symbol, per-benchmark signal classifier, scoring, and the ranked watchlist. |
| `packages/marketdata` (`@bot/marketdata`) | Candle type, bar clock, closed-bar filter, gap-free alignment across symbols. Pure. |
| `packages/bitunix` (`@bot/bitunix`) | Public REST client (throttle, retries), response parsers, paged kline fetch, the live probe. |
| `packages/store` (`@bot/store`) | Postgres schema and migrations; candles, funding, contract specs, scans and watchlist entries. |
| `packages/worker` (`@bot/worker`) | Config, universe selection, the scan pipeline, the bar-close schedule, the CLI. |

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
- **`fundingRate` is a percent** (`0.01` = 0.01% per interval). The median
  across 895 symbols was 0.005. The parser converts it to a fraction.
- **Still unknown:** rate limits. The client sends at most one request per
  200 ms.

Re-run `npm run probe` from anywhere that can reach Bitunix to re-check all
of this; it exits non-zero on any mismatch. Kline paging doesn't depend on which 200 bars Bitunix
returns for a long range, or on whether `endTime` is inclusive: every request
asks for a window of at most 200 bars.

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
