# 15m and 1h strategies tried: rules, test setup, results

A self-contained summary of every 15-minute and 1-hour strategy backtested for this bot (Bitunix USDT perpetuals) up
to 2026-10-04, written to share with another analyst or model. Full tables and run numbers are in `docs/RESULTS.md`.

**Short version:** nothing on 15m or 1h has survived costs. The best lines reach break-even or a small,
period-dependent edge that does not hold on a second coin set. The models that trade live are 4H, daily and weekly
RSI-framework models. The same ideas lose when moved down to 1h or 15m.

---

## 1. How everything was tested

**Market and data**
- Bitunix USDT-margined perpetuals. Real candles, closed bars only, so there is no lookahead.
- Entry at the next bar's open after the signal is known.
  - Pivots need 5 bars on the left and 2 on the right, so a pivot is known 2 bars after it forms.

**Coins**
- **Research set:** about 56 liquid pinned coins (BTC, ETH, SOL, XRP, LINK, …).
- **Fresh set:** about 38 coins in neither the research list nor the holdout. Volume ≥ $500k a day. Used once, with the rules unchanged, as an out-of-sample check.

**History**
- 15m / 1h: about 24 months (2024-10 to 2026-10). The older / newer split is about 8 months from the end.
- Earlier studies (SMC, EMA, S/R, Fib) used 24–36 months.

**Costs**
- 0.22% per round trip: taker fees plus slippage. This is the default.
- Some studies also show 0.10%, which assumes maker fills.
- Funding is included where the full engine was used.

**Risk unit**
- Results are in R, where 1R is the distance from entry to stop.
- Avg R is the average result per trade after costs.

**Controls**
- **Random direction:** every candidate is compared with the same entries and stops in a random direction, averaged over 20 seeds. A signal has to beat this to count.
- **Rules fixed before each run.** Where many lines were screened, a lone positive line is judged against chance.

**Pass gate**
- The original gate needed a 60%+ win rate.
- The current gate is:
  - positive expectancy in both periods, on research coins and fresh coins;
  - beats random direction;
  - no minimum win rate.

**Why 15m / 1h is hard here**
- Stops are 1–3% of price on these timeframes. A 0.22% cost is then 0.1–0.2R taken off every trade before any edge.
- Signals fire very often: thousands to tens of thousands of trades, most of them noise.

---

## 2. Strategies tried on 15m / 1h

### 2.1 SMC: liquidity sweep → market-structure shift → FVG entry (15m, and 1H with a daily bias)

**Rules**
- A sweep of a recent swing high or low.
- A market-structure shift (break of the internal swing) the other way.
- Entry on the retrace into the fair-value gap the shift left.
- Stop beyond the sweep. 2R target.
- 1H version: only trades in the direction of the daily bias.

**Results**
- **15m:** 2 years, 23 coins, 31–37% wins at 2R. −173R in training, −46R in the test period.
- **1H with daily bias:** 36-month walk-forward, 253 trades, 51% wins, −0.05R a trade. Only 2 of 8 quarters positive.
- **Verdict:** no edge. Retired.

### 2.2 EMA / Stochastic momentum (owner's Pine script plus 9 variants), 15m

**Rules:** an EMA trend direction, with a Stochastic cross out of oversold / overbought as the trigger. The variants changed the lengths, levels and exits.

**Results:** no variant was profitable over 2 years.

**Verdict:** retired.

### 2.3 EMA 9/21 + Supertrend + RSI + volume trend model, and Bollinger / RSI mean reversion (22 variants), 15m

**Rules**
- **Trend:** EMA 9 crosses EMA 21, with Supertrend agreeing, RSI on the right side of 50 and rising volume.
- **Mean reversion:** a close outside the Bollinger Band with an RSI extreme, then back inside.

**Results**
- 3,000–4,000 trades per variant, 31–47% wins.
- −650R to −900R.
- They fire on noise.

**Verdict:** retired.

### 2.4 Confluence gate / confluence score, 1H

**v0 gate**
- A 1H SMC setup taken only when all of these agree:
  - daily and 4H bias;
  - a 4H zone;
  - 15m structure.
- Result: −0.161R a trade, worse than the setup alone.

**v1 score**
- A weighted 1D / 4H / 1H / 15m / market score.
- 252 out-of-sample trades, +0.01R, 31% wins.
- It did worse than a shuffled score, and higher scores did not do better.

**Verdict:** the score carries no signal. Retired.

### 2.5 Generic signal screen (about 420 cells across 15m / 1H / 4H / 1D)

**Signals**
- EMA crosses, Supertrend flip, MACD flip.
- EMA 50 trend, Donchian breakouts.
- RSI(2) and RSI(14) extremes.
- Bollinger and Stochastic re-entry, big-bar fade.
- Swing-structure flip, SMC shift.
- Volume thrust, funding contrarian, BTC trend, RRG rotation.

**Test setup**
- Three exits each: a 0.5R target inside a 2-ATR stop, 1R, and 3R.
- Each signal tested as-is and faded (direction reversed).

**Results**
- No 15m or 1H cell passed.
- Only 3 cells passed at all: daily EMA 50 trend, 4H EMA 9/21 and faded 4H RSI(2). Only the daily one had a meaningful edge per trade (+0.06–0.07R).

### 2.6 Owner's multi-timeframe RSI framework with a 15m / 1H trigger (screen rounds 1–4)

**Rules**
- Daily RSI sets the bias; nothing is traded in the neutral band.
- 4H RSI must be pulled back against that bias.
- **Trigger:** the 15m or 1H RSI crosses back out of oversold / overbought. On 15m, the 1H RSI must also be turning.

**Variants tried**
- Daily bias at 50; a daily 200-SMA filter; widened thresholds (55/45, 35/65).
- 15m RSI 9; regime levels 40/60; 15m 20/80; daily RSI 21.
- Swing-structure agreement; an EMA 50/200 stack; OBV rising; the 4H MACD histogram turning; skipping crowded funding.
- A 4H EMA 20/50 dip; an EMA ribbon; "lean" stacks.

**Results**
- Wins 63–68% at a 0.5R target, but loses 0.04–0.10R a trade.
- No layer turned it positive in both windows.

**Verdict:** retired at the lower timeframes. The same RSI ideas on 4H, daily and weekly became the live models (section 4).

### 2.7 EMA crossover (fast / slow), 1H

**Rules**
- Entry when the fast EMA closes across the slow EMA.
- Stop beyond the slow EMA or the 3-bar swing.
- Exit on the EMA 5/12 cross back, or a hybrid exit (50% at 1.6R, then the EMA exit).

**Filters**
- **Raw:** every cross.
- **Trend:** daily EMA 50 bias.
- **Chop:** trend, plus the slow EMA sloping the trade's way, plus an ATR regime.

**Results (1H, 62 coins, 3 years)**

| variant | return | max drawdown |
|---|---|---|
| 5/20 raw | −95% | |
| 5/20 trend | −0.4% | 57% |
| 5/20 chop | −74% | |
| 5/11 chop | −85.5% | |

- The same system on 4H made +110% to +130% with about 20% drawdown.
- **Verdict:** 1H has too many crosses, and fees eat the small moves.

### 2.8 S/R Channels (LonesomeTheBlue-style pivot channels), 1H

**Rules**
- **Entries:** break, retest or bounce of a pivot-based support / resistance channel; with or without a "room to next channel ≥ 1.5R" filter.
- **Exits:** next channel, next channel with breakeven, half-out, 5R, 3 ATR trail, channel failure.

**Results**
- Every 1H cell lost 97–100% of the account (−0.05 to −0.13R a trade, 5,000–9,000 trades).
- **Verdict:** retired.

### 2.9 Fib pullback into deep S/R, 1H (rounds 1, 3 and 4)

**Rules**
- A Fib retracement of the last impulse leg.
- A limit entry at 0.65 (or 0.786), where the zone overlaps strong S/R channels (2 strongest, 3+ pivots, or next-timeframe channels).
- Stop beyond the swing. TP1 at 0.382, TP2 at 0.236, then a trail to 1.272.
- Trend filter: daily close above a rising EMA 50.

**Results**

| round | setup | result |
|---|---|---|
| 1 | 1H | every cell −39% to −94% |
| 3 | 1H setup needing 4H approval (4H close above a rising 4H EMA) | −36% to −54%. About 57% wins, but −0.04 to −0.07R a trade |
| 4 | 1H setup with a 15m trigger: market entry after a 15m sweep and structure shift inside the zone; stop at the sweep extreme | −49% to −73% (−0.10 to −0.22R) |

- For comparison, the 4H setup with a 1H trigger made +0.151R. That is a 4H model, not a 1H one.
- **Verdict:** 1H / 15m versions closed.

### 2.10 RSI-line scalp, first version (15m and 1h), from the owner's LINK charts

**Rules**
- **Longs:** rising RSI(14) lows coming out of the oversold band. **Shorts:** falling RSI highs from 80 toward 70.
- Two families:
  - **'hl':** an RSI trend line only;
  - **'div':** also a regular price divergence.
- Loose grid (30/40, 70/60) and tight grid (25/35, 75/65).
- Stop past the swing ± 0.2 ATR.
- Exits: 1.5R, 2R, or RSI back to 70 / 30.
- Time cap: 24h on 15m, 48h on 1h.

**Combinations tested**
- 15m alone; 1h alone.
- 15m with a 1h signal in the last 12h.
- 15m with the 1h RSI ≤ 45 / ≥ 55.
- A 1h signal followed by a 15m trigger.

**Results (all 120 lines negative)**

| combination | best long, 0.22% cost | best short, 0.22% cost | long, 0.10% cost | short, 0.10% cost |
|---|---|---|---|---|
| 1h alone | −0.15R | −0.17R | −0.06R | −0.08R |
| 15m alone | −0.31R | −0.36R | −0.13R | −0.14R |

- Win rates were 22–39%.
- Every pivot pair fired: LINK 15m gave about 50 long signals in 30 days, where the owner had marked 4–5.

### 2.11 Selective RSI-line scalp (15m and 1h), from the owner's ETH charts

**Anchor**
- A deep RSI extreme: a pivot low with RSI ≤ 30 (or ≤ 25) that is also the lowest RSI of the last 100 bars. Shorts mirror this: ≥ 70 / ≥ 75, the highest of 100 bars.
- The anchor dies when RSI makes a lower low, or after 500 bars.

**Entry**
- A later pivot low with a higher RSI, ≤ 45 (shorts: a lower high, ≥ 55).
- 10–500 bars after the anchor.

**Selectivity**
- Only the first entry per anchor, or every entry.

**Families**
- RSI higher low only, or also a price regular divergence.

**Direction filter**
- None; daily close vs the 200-day SMA; or 4H RSI on the trade's side of 50.

**Stop and exits**
- Stop past the lowest low of 5 bars before the entry, ± 0.2 ATR.
- Exits: 2R, 3R, RSI to 70 / 30, the next opposite signal, or a 3 ATR trail armed at +1R.
- Time cap: 120 bars on 1h, 192 bars on 15m.

**Combinations**
- 1h alone; 15m alone; 15m with a same-side 1h signal in the last 24h.

**Lines:** 720 in total, each with the random-direction baseline.

**Results**
- Only 1 of 720 lines was positive in both periods with n ≥ 100: a 1h short, first per anchor, 4H RSI ≤ 50, anchor ≥ 75, 3R.
  - +0.10R, 34% wins, 282 trades; newer period +0.03.
  - About what chance gives.
- Best long: −0.08R over 15,304 trades.
- 15m: −0.16 to −0.28R.
- At 0.10% cost a few lines reach +0.1 to +0.2R. Best win rate 34%.
- Still 6.7 signals per coin per month on 1h and 26 on 15m.
- On ETH, the 1h list did fire on the owner's marked entries, but also at many unmarked points.

### 2.12 WaveTrend [LazyBear] 10/21, 15m and 1h

**As a signal**
- Long: wt1 crosses over wt2 at or below 0, −53 or −60. Shorts mirror this.
- Stop past the 5-bar extreme ± 0.2 ATR.
- Exits: 2R, 3R, the opposite cross, or a 3 ATR trail.
- Direction filter: none, or the daily 200 SMA.
- **Result:** every 15m and 1h line negative (−0.07 to −0.35R; 6,000–157,000 trades).

**As a filter on the RSI scalp**
- Rule: a WaveTrend cross the trade's way in the last 6 bars.
- It cuts the losses:
  - 1h long divergence with a trail: −0.16 → −0.05R;
  - 15m: about −0.40 → −0.30R.
- Every line stays negative except one: 1h long RSI-trend with wt1 ≤ −53 and a trail, +0.02R (741 trades).

### 2.13 RSI pattern catalogue (owner's write-up), 1h

**Patterns (RSI 14, both sides)**
- Oversold reclaim of 30.
- Wilder failure swing.
- RSI double bottom.
- Regular divergence confirmed by RSI crossing back over 50.
- Hidden divergence.
- Midline reclaim after a pullback.

**Regimes (from the daily RSI)**
- None, with trend, range shift, range.

**Exits**
- 2R, 3R, 3 ATR trail.

**Multi-timeframe "stacks"**
- Daily bias, 4H setup, 1H trigger.

**Results**
- Every 1h pattern pooled was negative. The stacks: longs −0.10 to −0.27R; shorts −0.01 to −0.12R.
- **The one 1h line that looked good:** short regular divergence with the daily RSI < 50, 3R.

| | trades | avg R | win % | older / newer | random direction |
|---|---|---|---|---|---|
| research coins | 1,050 | +0.26R | 41% | | −0.08 |
| fresh coins | 682 | +0.12R | 37% | 0.19 / **0.00** | |

- It halved on fresh coins, and its newer period was flat.

**Wider stops on that line** (size scaled down so the loss stays 1R)

| stop | research: win %, avg R | fresh: win %, avg R | fresh newer period |
|---|---|---|---|
| 1x | 41%, +0.26R | 37%, +0.12R | |
| 1.5x | 46%, +0.20R | 44%, +0.12R | |
| 2x | 51%, +0.17R | 49%, +0.10R | |
| 3x | 56%, +0.09R | 54%, +0.05R | about 0 |

- Wider stops raise the win rate and cut the drawdown, but lower R and do not fix the flat recent period.
- Not traded.

### 2.14 RSI Pro+ Suite (RWCS_LTD), 1h

**Signals** (indicator defaults: signal line = SMA 14 of RSI; regime 50 bars, 40/60; score 0–5)
- Signal-line flips, aligned and counter.
- Pullback end.
- Score reaching 5/5.
- Regime flip.
- Oversold / overbought exit.
- Regular and hidden divergence.

**Results**
- Best 1h lines: +0.05R (long flip aligned, older period −0.08) and +0.04 (score 5).
- None of the 1h lines met the keep rule.

### 2.15 MACD divergence added to the RSI scalp (15m / 1h)

**Rules**
- MACD 12/26/9 on the signal's own timeframe.
- Regular divergence between the last two price pivots and the MACD line.
- Applied to the selective scalp lines: first per anchor, no filter, level 30, 3R / trail exits.

**Results**

| line | all | with a MACD divergence | without |
|---|---|---|---|
| 1h long hl, trail | −0.13R | **+0.05R** (903 trades; older −0.22 / newer +0.41) | −0.18R |
| 1h short div, trail | −0.11R | **+0.05R** (827 trades; older +0.15 / newer −0.17) | −0.17R |
| 15m lines | | no better or worse: −0.32 to −0.51R | |

- On 1h it lifts R to about break-even, but not consistently across periods.
- Boosting size on a losing strategy loses more.

### 2.16 MACD gap at entry added to the RSI scalp (15m / 1h)

**Rules**
- Gap = (MACD − signal) / |MACD| on the signal timeframe, measured the trade's way.
- Buckets: ≥ 5%, ≥ 10%, ≥ 15%, 5–10%, 10–15%, under 5%, against.

**Results**
- **15m:** a gap ≥ 15% in our favour trims the loss by about 0.1R. It is still −0.26 to −0.36R.
- **1h:** no pattern.
- One cell was positive: 1h long divergence, trail, gap under 5%, +0.20R (580 trades; older +0.03 / newer +0.47).
  - It is the opposite of the hypothesis and one cell of about 200 tested, so it is likely noise.
  - Not yet checked on fresh coins.

### 2.17 1h / 15m RSI as an entry-timing layer for the higher-timeframe models

The question: do the 4H / daily RSI-framework trades do better when entered at a 1h / 15m RSI extreme, or after the lower timeframe "cools off"?

**Results (306 trades; entering now: +0.94R a trade, 289R in total)**

| entry style | trades | avg R | total R |
|---|---|---|---|
| wait for a 1h extreme | 180 | +0.83R | 149R |
| wait for a 15m extreme | 289 | +0.67R | 195R |
| 15m cool-off | 296 | +0.92R | 272R |
| 1h cool-off | 296 | +0.88R | 259R |

- Every delayed entry is worse than entering now.
- Entering while the 15m RSI is ≥ 70 against the trade averaged +0.33R, against about +1.06R otherwise.
- Zone plus a 1h / 15m extreme raised R per trade (+1.16 to +1.19R) for a few divergence longs, on about a quarter of the trades. The samples are small.
- **Decision:** no lower-timeframe extreme or cool-off entries.

---

## 3. What the 15m / 1h results have in common

1. **Costs dominate.**
   - Stops are 1–3%, so 0.22% costs 0.1–0.2R a trade.
   - Many lines that lose 0.15–0.3R at taker costs are near zero at maker costs. None become clearly positive.
2. **Signal frequency is too high.**
   - Even "selective" rules fire 7 (1h) to 26 (15m) times per coin per month.
   - A discretionary trader marks far fewer. The extra signals are the losing ones, and nothing mechanical tested so far separates them.
3. **Win rates are low with R targets.** 22–41% at 2–3R targets.
   - High win rates come only with targets closer than the stop (e.g. 0.5R), and those lose on average.
4. **Higher-timeframe filters help, but not enough.**
   - Daily / 4H direction, 4H approval, WaveTrend, MACD divergence and MACD gap each trim 0.05–0.2R off the losses.
   - None lifts a line to a consistent positive result.
5. **The only repeating theme is shorts in a daily downtrend.**
   - The 1h short divergence with the daily RSI < 50 was +0.26R on research coins.
   - It held only partly on fresh coins (+0.12R, flat recently).
   - The same theme is stronger on 4H / daily.
6. **What works lives on 4H and above.** Ideas that fail on 15m / 1h (RSI divergence, failure swing, EMA cross, Fib pullback) work on 4H / daily, where moves are large compared with costs.

---

## 4. For context: what does trade live (4H / daily / weekly)

Eight RSI-framework models on RSI 14:
- daily bottom divergence, triple divergence and momentum;
- 4H under-floor long;
- weekly shorts;
- daily failure-swing short, and others.

**Common rules on every model:**
- BTC above its 50-day SMA blocks shorts;
- skip a signal if price has already run > 3 ATR;
- stop to breakeven at +2R.

**Results:**

| | avg R a trade | random direction does |
|---|---|---|
| research coins | +1.32R | 0.92R worse |
| fresh coins | +0.7R | 0.47R worse |

**Sizing:**
- 2% risk a trade;
- 1.5x risk when a daily MACD divergence is present (divergence trades averaged 2.4–2.8R, against 0.4–1.2R without).

---

## 5. Not yet tried on 15m / 1h (open ideas)

- **Maker-only (limit) entries and exits.** About 0.10% costs; the main fixable drag.
- **Much tighter session / volatility filters,** e.g. only trade high-volume hours, or only after a daily-range expansion.
- **Short-only 1h divergence in a daily downtrend** with a 1.5–2x stop, forward-tested rather than re-optimised.
- **A fresh-coin check of the lone 1h "gap under 5%" divergence cell** (expected to be noise).
- **Order-flow data** (order-book absorption, liquidations, open interest). There is no history for it in this backtester, so it is untested.
