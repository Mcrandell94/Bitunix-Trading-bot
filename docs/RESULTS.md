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

## Signal screen (`npm run screen`; workflow *Baseline check*, mode `screen`)

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

**Per signal:** *keep* if any timeframe or exit beats random direction with
positive expectancy on both windows; otherwise *retire* and remove it from
the code.
