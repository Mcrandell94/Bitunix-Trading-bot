# Confluence score model (confluence_v1)

Source: the owner's brief of 2026-09-27 (written with Claude chat). A
separate model: one score from 15m, 1H, 4H, daily and market-level signals
gates long and short entries. The tiered strategy and its locked baselines
stay runnable and unchanged. Parameters: `config/confluence.yaml`. Order of
work: `TASKS.md`. Runs go to the same run log as the backtest research
(`research/runs.jsonl`); the harness in `docs/backtest/` is reused.

## 0. Where this repo differs (read with §1.3)

- **The confluence *gate* (v0) is not this model.** `confluenceConfig`
  (packages/backtest/src/types.ts), built earlier the same day, requires
  daily + 4H bias agreement, a 4H zone and 15m structure as hard gates on
  the 1H setup. It stays as a reference variant; confluence_v1 replaces
  the gates with this weighted score. `BOT_MODEL = 'none'`: neither trades.
- **Swings are 2 bars each side in the code, not 3** (see the mapping).
- **The setup code's ATR is a simple 14-bar mean;** this model's
  components use Wilder ATR as §1.1 says.
- **Validation minimums here are 100 train / 50 per test block,** lower
  than the backtest spec's 150 / 75.

## 0.1 Glossary mapping (T1, confirmed by the owner 2026-09-27)

| Term | Code |
| --- | --- |
| Confirmed swing | `buildContext` (packages/smc/src/context.ts): **2 bars each side** (owner: keep the shared definition; 3-bar is an ablation) |
| Sweep, MSS, displacement | `findLong` / `isDisplacement` (packages/smc/src/setup.ts); displacement 1.2 ATR and 60% body for this model |
| C4 SMC event | `detectShift`: the same code with the entry zone switched off (owner-approved switch, off for the tiered setups) |
| FVG / unmitigated | `pickZone`, `unmitigatedZones` (no close beyond the far edge) |
| RRG quadrant (M2) | `readRrg` on the last 120 4H closes vs BTC (packages/signals) |
| Funding (M3) | settlement history, settlements at or before t |
| Funding veto | **no fills from 15 minutes before to 15 minutes after a settlement** (owner) |

Code: packages/backtest/src/score/ (config, components, pipeline, cli).

## 0.2 Owner decisions after T3/T4 (2026-09-27)

- **D.C3_location removed** from group D (correlation −0.75 with H4.C1_trend;
  24h forward-return edge −46 bps on the first train window). H4.C3 stays.
- **t_entry grid 30–70** (30 added): at 40–70 only A1@40 reached 100 setups
  per 12-month train window.
- **Research universe: $3M daily quote volume floor** (was $10M, which caps
  the universe at 24 coins). The live universe keeps $10M.

## 0.3 How T5 (Stage A) is run here

Code: packages/backtest/src/score/stagea.ts, stagearun.ts; `npm run -s score -- stage-a`
(workflow Baseline check, mode `score-stage-a`).

- **Mode X** is the MTF slot with the bias check off and a score gate on the
  1H setup (`modeXConfig`); S is read at the MSS candle's close. §4 vetoes
  and §5 exits are engine options, all off for the tiered baseline.
- **Cost veto** is the minimum stop distance 0.10 / 0.15 = 0.667%.
- **Walk-forward selection:** per fold, the (weight set, T_entry) with the
  best train expectancy among those with ≥ 100 train trades trades the test block.
- **(a) random-entry null:** each out-of-sample trade re-entered at market at
  the same coin and hour with the same stop distance, long and short, with
  the same exits; 500 random-direction draws of total R. Also reported with
  the direction taken from the daily group's sign.
- **(b)** the old MTF tier alone, fill realism on, same windows.
- **(c) shuffled score and monotonicity** use every setup the score could
  take, each alone (portfolio caps and the daily limit off): S shuffled
  across each coin's decision times, 500 times; statistic is expectancy.
- **Monte Carlo:** bootstrap of the out-of-sample trade sequence,
  compounding 1% per R, 10,000 resamples.

### 1. Conventions

#### 1.1 General
- Score is evaluated at every **1H bar close** (the decision clock).
- ATR = Wilder ATR(14) on the component's own timeframe unless stated.
- Daily bars close 00:00 UTC.
- Stop distance `d` = |entry − stop| / entry, in percent. R = planned entry-to-stop distance.
- Sign convention: every component returns +1 (bullish), −1 (bearish) or 0 (neutral).

#### 1.2 Timeframe alignment (no lookahead)
At decision time t (a 1H close):
- 15m components use the 15m bar closing at t.
- 1H components use the 1H bar closing at t.
- 4H components use the most recent 4H bar with close time ≤ t.
- Daily components use the most recent daily bar with close time ≤ t (i.e. the previous UTC day until 00:00).
- External daily data (Fear & Greed) uses the previous completed UTC day.
- Funding uses only settlements with timestamp ≤ t.
- Swings count as confirmed only once their confirmation bars have closed by t.

#### 1.3 Glossary (map each to existing code before building)
- **Confirmed swing:** current 3-bar swing definition.
- **Sweep:** wick beyond a confirmed swing that closes back on the original side.
- **MSS:** market structure shift.
- **Displacement candle:** body ≥ 1.2 × ATR and ≥ 60% of range.
- **FVG / unmitigated FVG:** fair value gap; unmitigated = no close beyond its far edge.
- **RRG quadrant:** existing relative-rotation classification (leading / weakening / lagging / improving).

#### 1.4 Cost model
Same as the existing bot: maker 0.02%, taker 0.06%, 2 bps stop slippage, funding at each settlement.
Loss in R = 1 + 0.10/d. Win at target T in R = T − 0.04/d.

### 2. Components

Each is evaluated on its own timeframe per §1.2.

- **C1 Trend.** +1 if close > EMA(50) and EMA(50) > EMA(50) from 10 bars ago. −1 if close < EMA(50) and EMA(50) < EMA(50) from 10 bars ago. Else 0.
- **C2 Structure.** +1 if the last two confirmed swing highs are rising and the last two confirmed swing lows are rising. −1 if both are falling. Else 0.
- **C3 Location.** Dealing range = most recent confirmed swing high and swing low. pos = (close − low) / (high − low). +1 if pos ≤ 0.40 (discount). −1 if pos ≥ 0.60 (premium). Else 0.
- **C4 SMC event.** +1 if, within the last 6 bars, a sweep of a confirmed swing low was followed by a bullish MSS with a displacement candle. −1 for the bearish mirror. 0 otherwise. If both occurred, use the more recent.

Market-level components (evaluated at t):

- **M1 BTC regime.** BTC daily C1. For BTC itself, this component is excluded.
- **M2 Rotation.** +1 if the coin's RRG quadrant on the 4H is leading or improving; −1 if lagging or weakening. For BTC, 0.
- **M3 Funding (contrarian).** Mean of last 3 settled funding rates: −1 if > +0.03% per 8h; +1 if < −0.01% per 8h; else 0.

### 3. Groups and score

Active components per group:

| Group | Timeframe | Components |
| --- | --- | --- |
| D | 1D | C1, C2, C3 |
| H4 | 4H | C1, C2, C3, C4 |
| H1 | 1H | C2, C4 |
| M15 | 15m | C4 |
| MKT | market | M1, M2, M3 |

Group score g = mean of its active components (range −1 to +1).

**Score:** S = 100 × Σ (W_group × g_group), with Σ W = 1. S ranges from −100 to +100.

Pre-declared weight sets (Stage A, no fitting):
- **A1 equal:** D 0.20, H4 0.20, H1 0.20, M15 0.20, MKT 0.20.
- **A2 higher-timeframe tilt:** D 0.30, H4 0.30, H1 0.20, M15 0.05, MKT 0.15.

### 4. Entry

Evaluated at each 1H close. Longs need S ≥ +T_entry; shorts need S ≤ −T_entry.

- **Mode X (default): score gate + existing 1H SMC setup.** Take the existing MTF entry model (sweep → MSS with displacement → limit at FVG midpoint, stop 0.1 ATR beyond the sweep wick) only when S passes the threshold on the MSS candle's close. The limit order follows F1 expiry from the backtest spec: cancel after 8 bars, on 1R touch before fill, or on a close through the FVG.
- **Mode Y (variant): score cross.** When S crosses the threshold (previous 1H S below T_entry, current at or above), place a limit at the current 1H close − 0.25 × ATR(14, 1H) for longs (mirror for shorts), expiring after 4 bars. Stop = the farther of (entry − 1.5 × ATR(14, 1H)) and (last confirmed 1H swing low − 0.1 × ATR). No re-entry in the same direction on that coin until S has fallen below T_reset and crossed back.

Defaults: T_entry = 50, T_reset = 25.

**Hard vetoes (outside the score; never averaged away):**
- Cost ratio: skip if 0.10 / d > 0.15 (d in %).
- No fills within 15 minutes of funding.
- Daily loss limit 8%; one position per coin; portfolio caps: total open risk ≤ 6%, ≤ 2 same-direction alts beyond BTC/ETH.
- Universe: BTC, ETH, XRP + the non-core coins the existing RRG admission allows (M2 still scores them).

### 5. Exits

- 1/3 at 1R (maker limit). At +1R, stop → −0.5R. At +2R, stop → entry + 0.1%.
- 1/3 at 2R (maker limit).
- Runner: chandelier from +2R, highest high since entry − 3.0 × ATR(22, 4H), updated on 4H close, only tightens.
- Cap: 8R.
- Time stop: exit at market if MFE < +1R after 48 1H bars; hard exit at 240 1H bars.
- **Score exit (variant, flag):** exit the runner at the 1H close when S ≤ 0 for longs (≥ 0 for shorts).
- Stop and target in the same bar: resolve with 15m data.

### 6. Stage B: fitted weights (only after Stage A is evaluated)

- **Candidate set:** every Mode X setup where |S_A2| ≥ 20. This larger pool is used only to fit weights.
- **Label:** y = 1 if the trade reaches +1R before −1R, else 0.
- **Features:** the individual components (not group means), each signed toward the trade direction: feature = component × (+1 for long, −1 for short).
- **Model:** L2-regularized logistic regression. Regularization strength chosen by 5-fold time-ordered cross-validation **inside** the train fold only.
- **Walk-forward:** refit per fold (SPEC §7); predict on the following test fold.
- **Entry rule:** enter if predicted p ≥ p_min, where p_min = L / (W + L), L = 1 + 0.10/d, W = 1 + 0.04/d (breakeven for a 1R-first outcome, per trade using that trade's d), plus a margin of 0.03.
- **Adopt Stage B only if** it beats the better Stage A weight set on out-of-sample net expectancy in ≥ 6 of 8 folds.

### 7. Validation and acceptance

- **Data split:** all 36 months. Walk-forward: train 12m, test 3m, step 3m (8 folds). Holdout: last 6 months, evaluated once.
- **Minimum trades:** ≥ 100 per train window and ≥ 50 per out-of-sample block.
- **Monotonicity (core test for a confluence score):** bucket out-of-sample trades by |S| into [20,40), [40,60), [60,80), [80,100]. Net expectancy must increase with bucket; Spearman ρ between bucket rank and expectancy > 0 in ≥ 6 of 8 folds.
- **Ablation:** drop one group at a time, then one component at a time, weights renormalized. If dropping it improves out-of-sample net expectancy in ≥ 5 of 8 folds, remove it.
- **Redundancy:** compute pairwise correlation of components across all decision times. For pairs with |ρ| > 0.7, keep one.
- **Weight stability (Stage B):** a coefficient whose sign flips in ≥ 3 of 8 folds is treated as noise; drop that feature and refit.
- **Benchmarks:** must beat (a) the random-entry null's 95th percentile, (b) the existing MTF strategy on the same windows, and (c) the same model with S replaced by a random score with the same distribution (shuffle S across decision times within each coin; 500 runs; exceed the 95th percentile).
- **Primary metrics:** net expectancy (R/trade), profit factor, total R. Win rate is reported but never the acceptance metric.
- **Monte Carlo drawdown:** 10,000 resamples; accept if 95th-percentile max drawdown ≤ 25% at configured risk.
- **Fill realism:** limit fills need a trade-through of ≥ 1 tick; stops fill at the worse of stop price or bar open, plus slippage.

### 8. Optional: score-scaled sizing (only after flat sizing passes §7)

risk% = r_min + (r_max − r_min) × (|S| − T_entry) / (100 − T_entry), with r_min = 0.5%, r_max = 1.5%. Accept only if the risk-adjusted return (total R ÷ 95th-percentile Monte Carlo drawdown) beats flat 1% sizing in ≥ 6 of 8 folds.

---
