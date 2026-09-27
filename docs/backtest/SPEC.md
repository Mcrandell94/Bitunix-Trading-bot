# Backtest rule spec (Bitunix SMC bot)

Source: the owner's brief of 2026-09-27 (written with Claude chat), adopted as
the working spec for all strategy research. Parameters live in
`config/rules.yaml`; the task order in `TASKS.md`; runs are logged to
`research/runs.jsonl`.

## 0. Adaptations to this repo (read with §1.2)

- **Swings are 2-bar by default, not 3.** `DEFAULT_STRUCTURE` is
  `swingLeft: 2, swingRight: 2`. "Swings 3 bars each side" held on both
  windows in the 2-year run but is NOT adopted; it stays a rules flag.
- **Adopted so far (in code defaults):** minimum stop distance 0.5%
  (`minStopPct`). FVG-only, displacement 1.2 ATR, both-bias-agree and
  3-bar swings held in research but are not defaults; T6 re-scores them.
- **Costs are modeled explicitly** (fees per fill, funding per settlement,
  slippage on taker fills), not by the closed-form `1 + 0.10/d`; that
  formula is the sanity check, not the implementation.
- **Stops today** fill at the stop price on a mark-price touch, or at the
  bar open when the bar gapped past the stop, plus 2 bps slippage. Limit
  entries fill on a touch (no trade-through requirement). T3 changes both
  behind a flag.
- **Windows so far:** the 2-year research used the last 8 months as the
  test window. From now on the last 6 months are the holdout (§6) and are
  not evaluated until T13; research windows end at the holdout start.
- **HTF bias veto** is the 4H (biasTfs `['1d', '4h']`), as in §1.2.
- **Tiers live in code**, not YAML: `DEFAULT_TIERS` (packages/backtest/src/types.ts).
  `rules.yaml` only switches rules on and sets their parameters.

### 1. Conventions

#### 1.1 Evaluation
- All conditions evaluate on the last **closed** bar of the stated timeframe.
- ATR = Wilder ATR(14) on the setup timeframe unless stated.
- Daily bars close 00:00 UTC.
- Daily external values (Fear & Greed, BTC dominance) use the **previous completed UTC day** — no same-day values.
- Stop distance `d` = |entry − stop| / entry, in percent.
- R = planned entry-to-stop distance.

#### 1.2 Glossary (map each to existing code before building)
- **Swing:** confirmed 3-bar swing (current bot definition).
- **Sweep:** wick beyond a confirmed swing.
- **MSS:** market structure shift.
- **Displacement candle:** body ≥ threshold × ATR and ≥ 60% of range (current: 1.0 ATR; adopted variant 1.2).
- **FVG / unmitigated FVG:** fair value gap; unmitigated = no close beyond its far edge.
- **Bias engine:** higher-timeframe structure + (discount | FVG/OB tap | BTC/ETH divergence).
- **RRG gate:** relative-rotation admission for non-core coins.
- **Tiers:** LTF (15m setups, 4H bias, 1H veto), MTF (1H setups, daily bias, 4H veto), HTF (4H setups, daily bias, 4H veto).

#### 1.3 Cost model
- Entry: maker 0.02%. Take-profit: maker 0.02%. Stop: taker 0.06% + 2 bps slippage.
- Funding applied at each settlement while a position is open.
- Loss in R = 1 + 0.10/d. Win at target T in R = T − 0.04/d.

### 2. Filters (MTF, HTF)

Each filter is independent and flag-controlled. Parameters and grids live in `rules.yaml`.

- **F1 Order expiry and runaway cancel.** Cancel the pending FVG-mid limit if first: (a) unfilled N bars after the MSS candle closes; (b) price touches the planned 1R level before fill; (c) a candle closes beyond the far edge of the FVG.
- **F2 Cost-to-risk ceiling.** Skip if 0.10 / d > C (d in %).
- **F3 Volatility-percentile floor.** Skip if ATR/close on setup timeframe < its P-th percentile over the coin's trailing 90 days. Optional ceiling: skip above percentile P_high.
- **F4 Sweep quality.** Require all: (a) sweep wick exceeds swing level by ≥ min_excess × ATR and the sweep candle closes back on the original side; (b) sweep depth ≤ max_depth × ATR; (c) MSS close within K bars of the sweep candle.
- **F5 Funding crowding.** Skip longs if mean of last 3 settled funding rates > +f_long; skip shorts if < −f_short. Percentile variant: skip longs if current funding ≥ coin's pct_high percentile over 90 days; skip shorts if ≤ pct_low.
- **F6 Displacement relative volume.** Displacement candle volume ≥ V × SMA(20) volume.
- **F7 Long-side daily regime.** Longs only if daily close > EMA(L) and EMA(L) today > EMA(L) `slope_lookback` days ago. Shorts unaffected.
- **F8 Session block.** No fills with fill time in [start, end) UTC; cancel pending orders at `start`.

### 3. Exits (HTF)

- **E0 Baseline.** 1/3 at 1R, 1/3 at 2R, stop to breakeven at 1R, trail remainder on confirmed daily swings, cap 5R.
- **E1 Delayed breakeven.** At +1R stop → −0.5R. At +2R stop → entry + 0.1%.
- **E2 Runner-weighted partials.** Variant A: 25% at 1R, 25% at 2R, 50% runner. Variant B: 50% at 1.5R, 50% runner.
- **E3 Chandelier trail.** From +2R: stop = highest high since entry − M × ATR(22, 4H), updated on 4H close, only tightens. Mirror for shorts.
- **E4 4H structure trail.** From +2R: stop = latest confirmed 4H swing low − 0.1 ATR.
- **E5 Close-based ATR trail.** From +1.5R: stop = highest 4H close since entry − 2.5 × ATR(14, 4H), closes only.
- **E6 Time stop.** Exit at close of bar `first_check` if MFE < +1R. Hard exit at `max_bars`.
- **E7 Cap.** Profit cap ∈ {5R, 8R, none}.
- **E8 Opposing-setup exit.** Close runner if a valid opposite-direction 4H MSS with displacement ≥ 1.2 ATR forms.

Exit modeling: partials fill as maker limits. When stop and target fall inside one bar, resolve order using 15m data.

### 4. Regime filters (MTF, HTF)

- **R1 F&G level.** Skip longs if yesterday's F&G ≥ long_max; skip shorts if ≤ short_min.
- **R2 F&G rollover.** Skip longs if F&G ≥ level and 7-day change ≤ −change; mirror for shorts (≤ 100 − level and change ≥ +change).
- **R3 OI flush at sweep.** Longs require OI decline ≥ X% from close of the bar before the sweep candle to close of the bar after it. Mirror for shorts. OI resolution = setup timeframe.
- **R4 Leverage buildup.** Skip longs if 7-day OI change ≥ +oi_change and mean funding > +0.02%/8h; mirror for shorts with negative funding.
- **R5 Long/short extreme.** Skip longs if OKX L/S account ratio > its pct_high percentile over trailing 30 days; skip shorts if < pct_low.

Data precondition for R3–R5: history must cover the full train window. If not, mark the rule `paper_only` and do not include it in backtest verdicts.

### 5. NP-15 (15m nested pullback, separate model)

- **Universe:** BTC, ETH, XRP + top 15 of available perps by 30-day median daily quote volume.
- **Regime (closed 1H):** close > EMA(50, 1H); EMA(50) > its value 12 bars ago; 4H bias engine = long. Mirror for shorts.
- **Zone:** unmitigated bullish 1H FVG formed within last 48 1H bars, height ≥ 0.25 × ATR(14, 1H).
- **Trigger (closed 15m):** a 15m bar trades into the zone (low ≤ FVG top). Within next 16 bars, a 15m candle closes above the latest confirmed 15m swing high formed after zone entry, with body ≥ 1.2 × ATR(14, 15m), body ≥ 60% of range, volume ≥ 1.5 × SMA(20).
- **Entry:** limit at midpoint of the 15m FVG from the trigger leg; no FVG → no trade. Cancel after 6 bars, or if price reaches +1R before fill, or if a candle closes below the FVG.
- **Stop:** min(1H FVG low, lowest low since zone entry) − 0.2 × ATR(14, 15m). Skip if d < 0.8% or d > 3.0%.
- **Exits:** 50% at 2R (limit), then stop → entry + 0.15%. 50% at 4R (limit). Market exit 32 bars after fill if 2R not reached. Hard exit at 96 bars.
- **Blocks:** no fills in [20:00, 04:00) UTC or within 15 min of funding.
- **Survival bar:** ≥ 37% of fills reach 2R before stop.

### 6. Validation and acceptance criteria

- **Data split:** use all 36 months. Walk-forward: train 12m, test 3m, step 3m (8 OOS folds). Final holdout = last 6 months, evaluated once at the end.
- **Cross-sectional check:** run finished rules on available perps not in the core 23.
- **Minimum trades:** baseline ≥ 150 train and ≥ 75 per OOS block; a filtered variant ≥ 100 train and ≥ 50 per OOS block.
- **Random-entry null:** same coins, entry-time distribution, stop distances, exits; direction random (and separately bias-directed); 500 runs. System must exceed null's 95th percentile on net expectancy.
- **Random-filter benchmark:** for a filter keeping fraction f, 2,000 random subsets of equal size. Pass = ≥ 95th percentile in train and ≥ 80th in test.
- **Parameter plateau:** pass must hold at the chosen value and both grid neighbors.
- **Primary metrics:** net expectancy (R/trade), profit factor, total R. Report win rate but never use it as the acceptance metric.
- **Fill realism:** limit fills only if price trades through by ≥ 1 tick. Stops fill at worse of stop price or bar open, plus slippage.
- **Monte Carlo drawdown:** 10,000 resamples of trade R sequence at configured risk. Report 50th/95th/99th percentile max drawdown. Accept if 95th ≤ 25%.
- **Portfolio caps (in simulation):** total open risk ≤ 6%; ≤ 2 same-direction alt positions beyond BTC/ETH; one position per coin per direction across tiers.

---
