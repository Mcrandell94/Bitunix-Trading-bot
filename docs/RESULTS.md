# What has been tested, and what is retired

The owner's rule (2026-09-27): the method doesn't matter (score or not, low or
high timeframe). What matters is dropping what fails and finding what backtests
positive. **Nothing goes to paper trading at around a 50% win rate.**

A model can go to paper trading only when it passes the signal-screen gate
below and then a single run on the 6-month holdout. The bot trades nothing
(`BOT_MODEL = 'none'`) until then.

## Retired (failed on real data; not to be used again as-is)

| Model | Timeframe | Result | Why retired |
| --- | --- | --- | --- |
| SMC sweep → MSS → FVG setup, LTF | 15m | 2 years, 23 coins: 31–37% wins at 2R, −173R train / −46R test | No edge |
| SMC setup, MTF (daily bias) | 1H | 36-month walk-forward: 253 trades, 51% wins, −0.050R, 2/8 quarters positive | No edge; ~50% win rate |
| SMC setup, HTF (daily bias) | 4H | 84 trades, 51% wins, +0.27R, but +18R of +23R from one quarter; never met the trade minimum | Too thin and concentrated; ~50% win rate |
| EMA/Stochastic momentum (owner's Pine script and 9 variants) | 15m, 4H | No variant profitable over 2 years | No edge |
| EMA 9/21 + Supertrend + RSI + volume trend model, and Bollinger/RSI mean reversion (22 variants) | 15m | 3,000–4,000 trades, 31–47% wins, −650R to −900R | No edge; fires on noise |
| Confluence gate v0 (daily + 4H bias, 4H zone, 15m structure on the 1H setup) | 1H | −0.161R per trade | Worse than the setup alone |
| Confluence score v1 (weighted 1D/4H/1H/15m/market score, Stage A) | 1H | 252 OOS trades, +0.01R, 31% wins; worse than a shuffled score; higher scores did not do better | No signal in the score (docs/confluence/TASKS.md T5) |

The underlying indicators are not all retired yet. Some that failed as part
of these models may still work alone, on another timeframe or with other
exits. The signal screen decides that for each one.

## Signal screen (`npm run screen`; workflow *Signal screen*, one parallel job per signal)

Every signal in `packages/backtest/src/screen/signals.ts` (EMA crosses,
Supertrend, MACD, EMA-50 trend, Donchian breakouts, RSI(2), RSI(14),
Bollinger, Stochastic, big-bar fade, swing structure, SMC shift, volume
thrust, funding, BTC daily trend, RRG rotation), on 15m / 1H / 4H / daily,
with three exits (0.5R target inside a 2-ATR stop; 1R; 3R), as-is and faded.
It uses the real engine with market entries, fees, slippage, funding and the
0.667% cost veto.

**Pass gate:** on the discovery window (first 24 research months) *and* the
confirmation window (last 12):
- win rate ≥ 60% (owner: no ~50% models)
- net expectancy > 0 after costs
- beats the same entries with a random direction (99th percentile on
  discovery, since ~400 candidates are screened; 90th on confirmation)
- ≥ 100 / ≥ 30 trades, and ≥ 5 of 8 discovery quarters positive.

A high win rate alone proves nothing: a target closer than the stop wins most
trades whatever the entry. Beating random direction is what shows the signal
adds something.

**Owner's multi-timeframe RSI framework** (`rsi_mtf*` in signals.ts): daily
RSI sets the bias (stand aside in the neutral band), 4H RSI must be pulled
back against it, and the trigger frame's RSI crossing back out of
oversold/overbought times the entry (on 15m, 1H RSI must also be turning).
Screened as-proposed and with four tweaks: daily bias at 50, a daily 200-SMA
filter, crypto-widened thresholds (55/45, 35/65), and a 4H trigger.
Round 2 (owner's settings note: RSI 14 everywhere by default, change one
thing at a time): 15m trigger period 9; regime levels (trigger at 40 in a
daily uptrend, 60 in a downtrend); wider 15m extremes (20/80); daily period 21.
Round 3 (owner's EMA / structure note), one layer at a time: daily + 4H swing
structure agree; daily EMA 50/200 stack with close above 200; OBV rising;
4H MACD histogram turning; skip crowded funding. Then the recommended stack
(daily RSI > 50 + structure + EMA stack + 4H pullback + trigger), the stack
plus OBV, and the note's BTC example (4H RSI back above 30 with daily close
above the 200 SMA). Not testable: order-book absorption (no history).
Round 4 (owner's EMA settings note): 4H bar dipped to its EMA 20 (or EMA 50)
and closed back above; daily EMA ribbon 20 > 50 > 100 > 200; the "start
simple" stack (daily RSI > 50 + daily 200 SMA + 4H EMA 20 dip + RSI trigger);
and an EMA pullback with no RSI (daily 200 SMA, 4H EMA 20 > 50, dip to 20).

**Running it:** Actions → *Signal screen* → Run workflow. `signals` picks a
subset (empty = all); `extras` 20 (~23 coins) for quick rounds, 60 (~52
coins) for finalists. One job picks the coins and fills the data cache, one
job per signal screens it, and a last job merges the report.

**Per signal:** *keep* if any timeframe or exit beats random direction with
positive expectancy on both windows; otherwise *retire* and remove it from
the code.

## Screen results (2026-09-27)

Full screen, 57 coins (run 36314772171). Discovery 2023-03-29 → 2025-03-29,
confirmation → 2026-03-29.

**Passed the gate (3 of 420):**

| Signal | Frame / exit | Discovery | Confirmation |
| --- | --- | --- | --- |
| `ema50_trend`: daily close and EMA 50 slope turn the same way | 1D, 0.5R target | 693 tr, 71% win, +0.072R, PF 1.26 | 546 tr, 70%, +0.057R, PF 1.20 |
| `ema_9_21`: EMA 9 crosses EMA 21 | 4H, 0.5R target | 4,342 tr, 69%, +0.019R, PF 1.06 | 3,483 tr, 68%, +0.008R, PF 1.03 |
| `rsi2_extreme` faded: RSI(2) above 90 → long, below 10 → short | 4H, 0.5R target | 11,950 tr, 67%, +0.001R | 9,407 tr, 68%, +0.010R |

All three beat random direction at the 100th percentile on both windows.
Only `ema50_trend` 1D has an edge per trade large enough to survive worse
fills; the other two are near zero after costs.

**Near misses:** `ema_9_21` 1D 0.5R (70% / 71%, +0.058R / +0.063R; missed the
discovery null by a rounding hair), `big_bar_fade` faded 1D 0.5R, i.e. *with*
a >2.5 ATR daily bar (69% / 76%, +0.044R / +0.152R; 4/8 quarters).

**Pattern:** what works is daily trend continuation (go with the daily EMA
50 turn, the 9/21 cross, a big daily bar). Buying RSI pullbacks against it
does not.

**Retired by the screen:** Supertrend, MACD flip, Bollinger re-entry,
Stochastic re-entry, swing structure flip, funding contrarian, BTC daily
trend, RRG rotation (nothing beat random direction with positive expectancy
on both windows).

**Owner's RSI framework (rounds 1–4; 23–59 coins): retired.** No variant
passed, and no layer (structure, EMA 50/200 stack, daily 200 SMA, OBV, 4H
MACD, funding, 4H EMA 20/50 dip, ribbon, the recommended and lean stacks)
turned it positive on both windows. At a 0.5R target it wins 63–68% but loses
0.04–0.10R per trade. The note's BTC example (4H RSI back above 30 above the
daily 200 SMA) lost; its *faded* form made +0.049R on both windows at 54% win
(below the win-rate gate). Round 2's settings changes (15m RSI 9, regime
levels 40/60, 15m 20/80, daily RSI 21) passed nothing either.

## Layers on the daily EMA 50 trend (2026-09-27, 58 coins)

**Context filters (runs 36320918164):** BTC's daily trend and daily swing
structure as filters did **not** improve the winner. On the daily EMA 50
trend with the 0.5R exit, both filters dropped it below the gate (the BTC
filter removed most of its discovery-window edge; structure retired). On EMA
9/21 daily, the BTC filter lifted the confirmation window (73% win, +0.090R)
but weakened discovery (+0.018R, 86th percentile vs random): not consistent.
As entry triggers they had already failed.

**ATR layer (run 36321260887):**

| Version (daily, 0.5R target inside a 2-ATR stop) | Discovery | Confirmation |
| --- | --- | --- |
| EMA 50 trend | 697 tr, 71% win, +0.072R, PF 1.26 | 563 tr, 71%, +0.064R, PF 1.22 |
| **EMA 50 trend + ATR volatility filter** (skip top/bottom 10% ATR%) | **499 tr, 74% win, +0.109R, PF 1.43**, 6/8 quarters | **365 tr, 70%, +0.066R, PF 1.24** |

Both beat random direction at the 100th percentile on both windows; the
volatility filter passed the gate and lifted the discovery window the most.

ATR trailing exits raised profit per trade (e.g. EMA 50 trend + vol filter,
daily, trail: +0.074R / +0.313R) but won only 50–56% of trades, so they fail
the owner's 60% gate.

**R-raising round (run 36322246806, owner's note; one change at a time, daily):**

| EMA 50 trend + vol filter, exit | Discovery | Confirmation | Gate |
| --- | --- | --- | --- |
| hiwin: stop 2 ATR, target 1 ATR (baseline) | 499 tr, 74%, +0.109R | 365 tr, 70%, +0.066R | pass |
| target 1.5 ATR | 453 tr, 64%, +0.120R | 330 tr, 65%, +0.148R | pass |
| target 2 ATR | 439 tr, 56%, +0.115R | 313 tr, 60%, +0.174R | fail (win) |
| stop 1.5 ATR, target 2 ATR | 505 tr, 49%, +0.106R | 354 tr, 52%, +0.159R | fail (win) |
| **hybrid: 60% off at 1 ATR, stop to entry, rest trails 2.5 ATR** | 473 tr, **74%**, +0.093R | 345 tr, **71%**, **+0.124R** | pass |
| **hybrid15: 50% off at 1.5 ATR, stop to entry, rest trails 3 ATR** | 429 tr, 64%, **+0.121R** | 318 tr, 65%, **+0.218R** | pass |
| time stop 12 days | 520 tr, 71%, +0.103R | 376 tr, 68%, +0.062R | pass, no gain |
| time stop 16 days | 505 tr, 73%, +0.110R | 366 tr, 69%, +0.057R | pass, no gain |

Filters (hiwin exit): volume ≥ 1.5× its 20-day mean lifted R the most (80% /
74% win, +0.202R / +0.099R) but cut trades by 70% (148 / 72): too thin to
trust yet. EMA 50 slope ≥ 1% was strong on confirmation but failed the
discovery null (98th percentile) and quarters. Close beyond EMA 20 and EMA
100 lost its edge on confirmation. Shorter time stops did nothing.

**Full-portfolio backtests (runs 36322929638/30814/32192/33285; 59 coins,
2023-03-29 → 2026-03-29; 1% risk, open risk ≤ 6%, ≤ 2 same-direction alts,
8% daily loss, 15% drawdown breaker; fill realism on):**

| Daily EMA 50 trend + vol filter | Trades | Win | Avg R | Total | Return | Max DD | Quarters + | Blocked by alts cap / open-risk cap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hiwin (2 ATR stop, 1 ATR target) | 438 | 73.3% | +0.103R | +45.2R | **+56.2%** | **4.1%** | 10/12 | 611 / 110 |
| hybrid (60% at 1 ATR, trail 2.5) | 290 | 72.4% | +0.087R | +25.3R | +27.7% | 6.5% | 10/12 | 890 / 11 |
| hybrid15 (50% at 1.5 ATR, trail 3) | 231 | 62.3% | +0.095R | +22.0R | +23.6% | 6.1% | 10/12 | 903 / 64 |
| + volume filter, hybrid | 148 | 77.7% | +0.142R | +21.0R | +22.8% | 5.9% | 11/12 | 75 / 0 |

The circuit breaker never tripped. At the account level the plain hiwin exit
wins: its trades close faster, so the same-direction alts cap blocks fewer
new entries. The hybrids hold up to 72 days and lose ~150–200 trades to the
cap. The alts cap is the binding constraint in every run.

**Current lead:** daily EMA 50 trend + ATR volatility filter, 2-ATR stop,
1-ATR target, 24-bar time exit, sized by risk ÷ stop distance. Next: one
full-loop backtest with the portfolio layer on (open-risk cap, same-direction
alts cap, daily loss limit, drawdown circuit breaker). The 6-month holdout
stays locked until the owner says so.
