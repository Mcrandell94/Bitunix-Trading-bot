# Owner's strategy guidelines (2026-09-27)

These are the owner's rules for how the bot's entries are built. Follow them
first; anything outside them is a test to justify, not a default. Code:
`packages/backtest/src/screen/signals.ts` (`rsi_mtf*`, `ema_pullback_4h`).

## Goal

- Drop tools and indicators that fail; keep what backtests positive.
- Method doesn't matter (score or not, low or high timeframe); results do.
- **No model goes to paper trading at around a 50% win rate.** The screen's
  gate is 60%, with positive expectancy after costs and beating random
  direction on two separate windows, then one holdout run.

## The hierarchy (higher timeframe wins)

| Frame | Role | RSI (14) | Moving averages |
| --- | --- | --- | --- |
| Daily | Bias / regime | > 50–60 longs, < 40–50 shorts; 40–60 = stand aside | 200 SMA (close above = longs only, below = shorts only); 50 EMA as confirmation |
| 4H | Setup: pullback inside the bias | Pullback to 30–45 (longs) / rally to 55–70 (shorts) | 20/21 EMA (dynamic support), 50 EMA (deeper pullback) |
| 1H | Confirmation | Turning the trade's way | 9–21 EMA for timing only |
| 15m | Entry trigger only, never alone | Crosses back above 30 (below 70) | 9–21 EMA for timing only |

- Full alignment is the highest conviction; daily + 4H alone is tradeable at
  reduced size; lower frames against the daily are skipped.
- Structure is the final arbiter: daily and 4H higher highs and lows for
  longs, lower for shorts; enter at a level (swing, support, FVG), not in the
  middle of nowhere.

## Settings rules

- RSI 14 on every frame by default, so readings are comparable. Adjust the
  levels (regime) before the period; shorten the period only on 15m (9–11).
- Crypto trends hold RSI extreme: in a strong uptrend treat 40 as support
  (60 as resistance in a downtrend); widen extremes on 15m (20/80).
- Two or three MAs total, not a ribbon on every chart. EMAs on lower frames,
  SMA 200 on the daily.
- **Change one thing at a time** when testing, so the cause is known.
- Don't stack oscillators (RSI + Stochastic + CCI); MACD and OBV/volume are
  optional confirmations only if they measurably help.
- Crypto context: funding (crowded long = caution on longs), BTC regime for
  alts.

## Exits and risk

- Stop beyond the lower-timeframe swing or structure.
- Targets at higher-timeframe levels or RSI back to neutral; trail or take
  partials in strong trends rather than a rigid RSI exit.
- Full size only on full alignment.

## Not yet testable

- Order-book absorption (no history).
- Price-action triggers (engulfing, pin bar, minor structure break) are the
  next layer once an RSI/EMA version shows an edge.
