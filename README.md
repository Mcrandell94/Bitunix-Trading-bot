# Bitunix trading bot

A USDT-perpetuals bot for Bitunix, built in stages. **Stage 1 (this code)
is pure functions and tests only: no network calls, no exchange access,
no API keys.**

This is a standalone project. The only thing it takes from the
[Crypto Rotation Dashboard](https://github.com/Mcrandell94/Crypto-rotation-dashboard)
is its RRG math, copied in unchanged (see below). The bot never imports from,
calls, deploys to or writes to the dashboard. The plan for later stages is in
[docs/ROADMAP.md](docs/ROADMAP.md).

```
npm ci
npm test            # vitest
npm run typecheck   # tsc, strict
```

## Layout

| Package | What it is |
| --- | --- |
| `packages/rrg` (`@bot/rrg`) | The dashboard's RRG math, vendored unchanged, plus the confirmation filters ported to TypeScript. |
| `packages/signals` (`@bot/signals`) | Per-symbol, per-benchmark signal classifier, scoring, and the ranked watchlist. |

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
