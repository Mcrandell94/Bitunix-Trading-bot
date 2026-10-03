# What has been tested, and what is retired

The owner's rule (2026-09-27): the method doesn't matter (score or not, low or
high timeframe). What matters is dropping what fails and finding what backtests
positive. **Nothing goes to paper trading at around a 50% win rate.**

The plan was that a model goes to paper trading only after it passes the
signal-screen gate below and then a single run on the 6-month holdout. The
daily EMA 50 lead passed the gate but failed the holdout (see "The 6-month
check" below). The owner put it on paper and live anyway (Hybrid live), and
later added the 1H and 4H pullbacks as forward tests, although neither
passed the gate.

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

**Former lead (retired: failed the 6-month check, below):** daily EMA 50 trend + ATR volatility filter, 2-ATR stop,
1-ATR target, 24-bar time exit, sized by risk ÷ stop distance, with the
portfolio layer on (results above). The 6-month holdout stays locked until
the owner says so.

**RRG as a magnifying glass (owner; run 36326119724, same 59 coins and
36 months).** RRG never adds or drops a signal; when several coins signal at
the same daily close, B tries the ones strongest against BTC the trade's
way (daily RS-Ratio + RS-Momentum) first, so they win the capped slots.

| Daily EMA 50 trend + vol, hiwin | Trades | Win | Avg R | Total | Return | Max DD | Quarters + |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A: first come, first served | 437 | 73.0% | +0.099R | +43.2R | **+53.2%** | **4.1%** | 10/12 |
| B: strongest vs BTC first | 447 | 71.8% | +0.081R | +36.3R | +42.6% | 7.0% | 9/12 |

360 trades were the same in both. The 87 trades B chose instead lost money
(65.5% win, −0.017R); the 77 it gave up made money (71.4% win, +0.070R).
RRG strength picked the *worse* coins: strongest-vs-BTC coins at a daily
trend start tend to be extended. Not adopted; the frozen setup stays first
come, first served. (A differs slightly from the earlier +56.2% run because
the 59-coin universe is picked by live 24h volume on the day it runs.)
RRG stays on the dashboard as a reference watchlist, and is forward-tested:
every EMA 50 entry records its daily RRG strength vs BTC (paper trades,
positions, orders), and the dashboard's "RRG forward test" table splits
closed paper trades into agreed vs against. The owner's RRG ranking switches
(dashboard, applied from the moment flipped) both start OFF (owner), so paper
trades first come, first served, like the backtest. Switched ON, paper
results stop being directly comparable to it.

**Entry timing: Asia-window dip vs market (owner; runs 36332599792 / 36332601627,
59 coins, 36 months).** After the daily signal, B rests a limit 0.25 daily ATR
better than the close for 90 minutes (≈ 00:00-01:30 UTC, the Asia open);
unfilled = no trade. A enters at market at the next 15m open (≈ 00:15 UTC).

| Exit, entry | Trades | Win | Avg R | Return | Max DD | Quarters + |
| --- | --- | --- | --- | --- | --- | --- |
| hybrid, A market | 284 | 73.2% | +0.107R | **+34.6%** | 5.4% | 10/12 |
| hybrid, B dip | 84 | 79.8% | +0.178R | +15.8% | 2.9% | 9/12 |
| hiwin, A market | 435 | 72.9% | +0.097R | **+51.5%** | 4.6% | 10/12 |
| hiwin, B dip | 89 | 78.7% | +0.202R | +19.4% | 4.5% | 9/12 |

The dip fills about a third of the signals: better trades, far fewer, total
return roughly halved, and its last quarters were negative. Not adopted; the
market entry (already inside the Asia window) stays. (The swapped-in / out
lines in these reports don't apply: entry times differ, so trades never match.)

**EMA 12-23-50 stack on 1H (owner's intraday model; run 36334068721, 58 coins,
36 months).** Long: close and EMA 23 above EMA 50, then an EMA 12/23 cross or a
pullback-and-reclaim of EMA 12 (short: mirror). Pure, and with the coin's daily
EMA 50 trend + ATR regime filter; exits hiwin, s2t15, s2t2, hybrid.

| Signal | Best exit | Discovery | Confirmation |
| --- | --- | --- | --- |
| ema_12_23_50_htf_vol | hybrid | 7854 tr, 65%, −0.049R, 0/8 quarters + | 2732 tr, 63%, −0.075R |
| ema_12_23_50_htf_vol | hiwin | 8312 tr, 65%, −0.058R | 2581 tr, 64%, −0.080R |
| ema_12_23_50 | hybrid | 9589 tr, 63%, −0.062R | 2607 tr, 64%, −0.045R |

Passed 0/16: every exit loses 0.05-0.08R per trade on both windows across
~8-10k trades (PF 0.8-0.9), and fading it loses too. Win rate holds at 63-65%
but costs (taker fees and slippage on ~0.7% 1H stops) eat the edge: the same
problem that retired every intraday setup before. Retired; 30m not run (twice
the cost per move).

**Dual higher-timeframe bias on the 1H 12-23-50 model (owner; run 36335595122,
58 coins).** Owner's testing order, start values fixed (EMA 50, lookback 4,
min slope 0.0004, 4H x0.7), ATR regime filter kept, same four exits.

| Signal | Best exit | Discovery | Confirmation |
| --- | --- | --- | --- |
| dual (daily + 4H above/below EMA 50) | hybrid | 8864 tr, 65%, −0.048R, 0/8 q+ | 2360 tr, 63%, −0.075R |
| + slope strength | hybrid | 7696 tr, 65%, −0.056R, 0/8 q+ | 2550 tr, 63%, −0.071R |
| + 5-bar pivot structure | hybrid | 5070 tr, 66%, −0.052R, 1/8 q+ | 4006 tr, 65%, −0.036R |

Passed 0/24 (faded versions lose too). The stricter bias changes almost
nothing: every version still loses 0.04-0.08R per trade at a 63-66% win rate.
The entry, not the bias, is where the 1H model loses to costs. The 1H
12-23-50 family is retired.

**Owner's optimized 1H spec: 9/21/50 pullback + structure stop + exit in R
(run 36338689487, 57 coins; min win 58%).** Exit r2: structure stop 1.0-1.8
ATR, 60% off at 2R, stop to entry at +1R, trail 2.2 ATR from +2R, cap 6R, 36
bars. W/L = average win / average loss.

| Entry, exit | Discovery | Confirmation |
| --- | --- | --- |
| 12-23-50 (reference), r2 | 7005 tr, 26%, −0.084R, W/L 2.41 | 2404 tr, 29%, −0.005R |
| pb_9_21_50, r2 | 4383 tr, 26%, −0.061R, W/L 2.52 | 3101 tr, 26%, −0.037R |
| pb_9_21_50_sep, r2 | 4107 tr, 26%, −0.074R, W/L 2.53 | 2926 tr, 27%, −0.021R |
| pb_9_21_50, hybrid | 4658 tr, 65%, −0.053R, W/L 0.46 | 3640 tr, 66%, −0.033R |
| pb_9_21_50_sep, hybrid | 4361 tr, 64%, −0.065R, W/L 0.46 | 3367 tr, 66%, −0.028R |

Passed 0/12. The r2 exit fixes W/L (2.5) but the win rate falls to 26%: the
+1R breakeven turns most trades into small fee losses. Expectancy stays
negative on both windows. The pullback entry is the first 1H entry with a
real direction signal (faded versions lose 0.08-0.13R, as-is 0.02-0.07R;
confirmation beats random at 97-100%), but the edge before costs (~0.05R) is
smaller than the costs. Trade count 4-5k, not the spec's 800-2,200. Retired.

**Owner's round 2 (runs 36339915947 / 36339917701, 57 coins).** 1H: same
9/21/50 pullback + daily range location + one pullback per swing, exit r3_1h
(stop 1.0-1.6 ATR, 50% at 1.4R, entry+0.25R at +1R, trail 1.8 ATR, 15 bars).
4H: 13/34/50 pullback, daily EMA 50 slope bias, exit r4h (stop 1.0-2.0 ATR,
50% at 1.6R, entry+0.2R at +1R, trail 2.0 ATR, 14 bars); ± daily EMA 200 veto.

| Entry | Discovery (2023-03 → 2025-03) | Confirmation (2025-03 → 2026-03) |
| --- | --- | --- |
| 1H pb_9_21_50_v3 | 4035 tr, 48%, −0.078R, W/L 0.94, 1/8 q+ | 2974 tr, 51%, −0.045R |
| 4H pb_13_34_50_4h | 1339 tr, 48%, −0.068R, W/L 0.94, 2/8 q+ | 948 tr, 49%, **+0.022R** |
| 4H + daily EMA 200 veto | 931 tr, 47%, −0.076R, 0/8 q+ | 734 tr, 52%, **+0.071R** |
| 4H faded (reverse) | 1334 tr, 51%, +0.001R | 943 tr, 49%, +0.005R |

1H: still red after costs on both windows. 4H: the
trade count is in the owner's healthy band (~1,000-1,300 per two years), win
rate 47-52%, and the newer year is green, but the older two years lose and the
reverse is flat, so no reliable direction yet. Fails the pass bar (avg R > 0 on
both windows). The owner put the 4H pullback (no D200) on paper anyway as a
forward test in its own slot (P4H); live off until approved.

**Round 3: other models' notes (runs 36341883452 / 36341885255, 56 coins).**
Cost gate (no trade when the stop is under 2.0% of price on 1H, 2.8% on 4H),
maker entry at the signal close, first target before any breakeven (1H: 50%
at 1.4R then stop to entry+0.25R; 4H: 1.6R / +0.2R), trail 1.8 / 2.0 ATR,
time stop at 15 / 14 bars only if the trade never reached +0.5R (caps 45 /
42). 1H v4 swaps the daily range filter for daily RRG vs BTC agreeing.
L / S = average R of longs / shorts.

| Entry, exit | Discovery (2023-03 → 2025-03) | Confirmation (2025-03 → 2026-03) |
| --- | --- | --- |
| 1H pb_9_21_50, r5_1h | 4334 tr, 42%, −0.031R (L −0.116, S +0.034), 3/8 q+ | 3531 tr, 45%, **+0.030R** (L +0.027, S +0.032) |
| 1H pb_9_21_50_v4 (RRG, cost gate), r5_1h | 1119 tr, 41%, −0.049R (L −0.039, S −0.059) | 837 tr, 44%, −0.018R (L −0.106, S +0.028) |
| 4H pb_13_34_50_4h, r5_4h | 1198 tr, 38%, −0.055R (L −0.020, S −0.081) | 867 tr, 41%, **+0.084R** (L −0.217, S +0.205) |
| 4H pb_13_34_50_4h_v2 (cost gate), r5_4h | 926 tr, 36%, −0.087R (L −0.059, S −0.108), 2/8 q+ | 709 tr, 42%, **+0.124R** (L −0.193, S +0.242) |
| 4H v2 faded (reverse) | 938 tr, 44%, +0.090R, 6/8 q+ | 726 tr, 39%, −0.024R |

Passed 0/8. The new exit rules help: the plain 1H pullback's confirmation
year went from −0.045R to +0.030R and the 4H from +0.022R to +0.084R, with the
cost gate lifting 4H to +0.124R. The pattern is the same as before, though:
the older two years lose, the newer year wins, and the reverse trade wins the
older years. The 4H confirmation profit is all shorts (+0.24R) while longs lose
(−0.19R), which matches 2025-26 being a falling market rather than showing an
edge. RRG selection made the 1H worse, not better. The cost gate removes 71%
of 1H signals and 29% of 4H; the 1-ATR floor sets the stop on only 9% / 5%, so
floor-sized stops aren't the problem.

The owner put both on paper as a forward test: P1H (1H 9/21/50 pullback, one
per swing, 2% cost gate, r5_1h, RRG selection by default) and P4H (v2, r5_4h,
no selection by default). The coin-selection filter (none / daily range / RRG)
can be switched per slot from the dashboard. The live switches start off.

**4H selection A/B (run 36342892859, 23 coins: the default universe, smaller
than the 56 above, so compare rows within this table only).** All three use the
2.8% cost gate and r5_4h.

| 4H pullback + | Discovery | Confirmation |
| --- | --- | --- |
| no selection (v2) | 483 tr, 35%, −0.114R | 319 tr, 43%, +0.159R (L −0.161, S +0.316) |
| daily range | 482 tr, 35%, −0.120R | 308 tr, 42%, +0.133R (L −0.176, S +0.290) |
| daily RRG vs BTC | 379 tr, 35%, −0.110R | 253 tr, 41%, +0.118R (L −0.193, S +0.276) |

Neither filter helps. The daily range filter removes almost nothing on 4H,
because the daily EMA 50 slope bias already keeps entries on the right side
of the range. RRG removes ~22% of trades and lowers the newer-year result. The
shape is unchanged: the older years lose, the newer year wins on shorts only.
The P4H default stays at no selection.

**RRG geometry filters (runs 36344548712 / 36344550708, 56 coins).** From a
second model's notes: read which way the daily RRG tail vs BTC is turning,
not which quadrant it is in. *heading*: 3-day tail leaning up-right (dx + dy >
0) with RS-Momentum rising on the day (short: mirror). *fast/slow*: the 3-day
lean agrees on the Balanced and Fast presets. *BTC regime*: BTC's own daily
RRG vs USD leaning the trade's way (all coins). Null = percentile against
random direction.

| Base + filter | Discovery | Confirmation |
| --- | --- | --- |
| 1H pb_9_21_50_sw | 1382 tr, 39%, −0.074R, null 2% | 1039 tr, 44%, +0.012R, null 96% |
| 1H + heading | 530 tr, 43%, **+0.033R**, null 52% | 458 tr, 47%, **+0.007R**, null 99% |
| 1H + fast/slow | 656 tr, 42%, **+0.009R**, null 48% | 532 tr, 46%, **+0.010R**, null 97% |
| 1H + BTC regime | 796 tr, 41%, −0.035R | 563 tr, 46%, +0.020R |
| 4H pb_13_34_50_4h_v2 | 926 tr, 36%, −0.087R | 709 tr, 42%, +0.124R (L −0.193, S +0.242) |
| 4H + heading | 138 tr, 31%, −0.192R | 132 tr, 38%, −0.050R |
| 4H + fast/slow | 272 tr, 32%, −0.212R | 210 tr, 39%, −0.024R |
| 4H + BTC regime | 458 tr, 35%, −0.115R | 278 tr, 44%, +0.127R (L +0.031, S +0.158) |

Passed 0/8. On the 1H, the direction filters are the first thing that
turned both windows positive (heading lifts discovery by ~0.1R). But the edge
is tiny (+0.01 to +0.03R, about the size of the fee estimate's error), and in
discovery it doesn't beat random direction (null ~50%). It looks like the
filter picks better conditions to trade in, not a better direction. On the
4H, heading and fast/slow make it worse: the 4H pullback trades against the
short-term RRG turn (the dip is the pullback). The BTC regime leaves the 4H's
newer year unchanged and makes its longs positive there, but the older years
are worse.

The owner added all three as coin-selection buttons on the 1H and 4H
pullback cards (RRG heading, RRG fast + slow, BTC regime), for paper
forward tests. Queued by the owner for later: the same heading and fast +
slow tests on the daily EMA 50 strategies.

**RRG direction filters on the daily EMA 50 lead (run 36347397618, 56 coins).**
ema50_trend_vol, daily, avg R discovery / confirmation (trades in brackets):

| Filter | hiwin (target 1 ATR) | hybrid | hybrid15 |
| --- | --- | --- | --- |
| none | +0.118 / +0.076 (484 / 341) | +0.101 / +0.141 | +0.135 / +0.242 |
| RRG heading | +0.115 / +0.049 (248 / 174) | +0.090 / +0.131 | +0.111 / +0.208 |
| RRG fast + slow | +0.095 / +0.092 (274 / 183) | +0.067 / +0.182 | +0.095 / +0.253 |
| BTC regime | +0.080 / +0.088 (323 / 219) | +0.057 / +0.185 | +0.066 / +0.307 (disc. null 76%) |

All stay positive on both windows, but every filter lowers the older two
years and cuts trades by 35–50%. Fast + slow and BTC regime lift the newer
year on the hybrid exits; heading lowers it. No filter beats the unfiltered
EMA 50 trend on both windows, so the EMA 50 slots stay unfiltered.

**RRG ranking by turning (owner; runs 36349907741 / 36349909742 /
36349911210, 55 coins, 36 months, 1% risk, caps and breaker on).** Which
signal gets a capped slot when several compete: A first come, first served;
B the old position ranking (strongest vs BTC); C heading (daily RRG tail
turning hardest the trade's way, 3-day lean); D fast + slow (the weaker of
the Balanced and Fast presets' leans).

| Exit | A: first come | B: RRG position | C: RRG heading | D: RRG fast + slow |
| --- | --- | --- | --- | --- |
| Target 1 ATR (hiwin) | +44.4%, DD 4.9%, 10/12 q+ | +44.1%, DD 7.6%, 8/12 | +46.9%, DD 7.4%, 9/12 | **+49.1%**, DD 7.4%, 9/12 |
| Hybrid (live) | +23.6%, DD 6.6%, 10/12 | +24.5%, DD 7.6%, 9/12 | +24.2%, DD 7.3%, 10/12 | +24.4%, DD 7.3%, 10/12 |
| Hybrid 1.5 | +17.7%, DD 7.9%, 9/12 | **+22.6%**, DD 8.4%, 9/12 | +18.6%, DD 9.0%, 7/12 | +18.6%, DD 9.0%, 7/12 |

The rankings swap only 30–90 trades out of 220–440, and the totals differ by
1–4R over three years. The turning rankings made a little more on Target 1
ATR (fast + slow +4.7 points), and position ranking made more on Hybrid 1.5
(+4.9). On the live Hybrid, all four are within one point. But every ranking
has a **higher maximum drawdown** than first come, first served on all three
exits (7.3–9.0% vs 4.9–7.9%), and the same or fewer positive quarters. The
old position ranking, which lost by 10 points in the earlier run, now ties
first come, first served on Target 1 ATR with a different day's 55-coin
universe. So effects this size are within the noise of which coins are in
the list. No ranking is adopted; first come, first served stays the default,
and the RRG ranking switches stay off.
The owner added the choice to the dashboard anyway: the RRG ranking card
has Off / Position / Heading / Fast + slow for paper and for live separately
(dated flips, so a replay ranks each close the way the switch stood then).
Both start off.

**Every dashboard combination on the 1H and 4H pullbacks (owner; runs
36351378606-36351383090 and 36351606951-36351619813, 55 coins, 36 months
2023-03-29 → 2026-03-29, full account at 1% risk, open risk ≤ 6%, ≤ 2
same-direction alts, 15% breaker).** Rows: the card's coin selection. Columns:
the RRG ranking card. Each cell: return / max drawdown / profitable quarters.

1H pullback (pb_9_21_50_sw, r5_1h):

| Coin selection | First come (Off) | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| None | −52.7% / 66.8% / 3 | −35.4% / 55.9% / 4 | −23.5% / 48.1% / 4 | −31.2% / 53.2% / 4 |
| Daily range | −59.8% / 70.0% / 3 | −50.6% / 63.5% / 4 | −39.4% / 54.9% / 4 | −34.9% / 51.5% / 4 |
| RRG (position) | −24.0% / 53.2% / 6 | −29.2% / 57.9% / 6 | −32.3% / 52.8% / 6 | −30.6% / 49.8% / 5 |
| RRG heading | **+7.3% / 39.8% / 6** | −3.6% / 44.4% / 6 | −2.2% / 42.4% / 6 | −1.1% / 42.4% / 6 |
| RRG fast + slow | −6.7% / 39.3% / 5 | −14.6% / 43.3% / 4 | −8.0% / 39.8% / 6 | −12.3% / 43.1% / 5 |
| BTC regime | −20.3% / 36.8% / 5 | −19.6% / 37.5% / 5 | −21.2% / 40.4% / 5 | −11.3% / 32.9% / 5 |

4H pullback (pb_13_34_50_4h_v2, r5_4h):

| Coin selection | First come (Off) | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| None | +20.1% / 23.1% / 7 | +23.4% / 21.6% / 7 | +8.5% / 27.4% / 7 | +17.5% / 26.6% / 7 |
| Daily range | +20.9% / 23.1% / 7 | **+25.5% / 19.4% / 7** | +3.9% / 31.4% / 7 | +10.6% / 30.7% / 7 |
| RRG (position) | +2.7% / 26.6% / 6 | +5.5% / 25.3% / 6 | −5.9% / 28.5% / 6 | +0.8% / 27.6% / 6 |
| RRG heading | −28.6% / 40.8% / 2 | −16.5% / 30.8% / 2 | −16.9% / 31.1% / 2 | −17.9% / 32.0% / 2 |
| RRG fast + slow | −26.7% / 43.4% / 4 | −29.2% / 39.3% / 3 | −21.1% / 35.8% / 3 | −17.5% / 35.9% / 3 |
| BTC regime | +1.7% / 17.1% / 6 | −2.8% / 18.3% / 5 | −2.1% / 20.4% / 7 | +0.9% / 20.2% / 7 |

1H: 23 of 24 combinations lose money at the account level; the plain pullback
loses half the account (breaker tripped 11 times). The only positive one, RRG
heading selection with first come, made +7.3% in three years with a 39.8%
drawdown. 4H: None or Daily range selection is best (+20% to +25%, drawdowns
19-23%, 7/12 quarters), and Position ranking adds a few points there; the
direction filters (heading, fast + slow) lose money on the 4H, as in the
screen. BTC regime cuts the 4H's drawdown to 17% but also its return to about
zero. These are 1% risk; the live account risks 3% per trade, so live
drawdowns would be roughly three times larger (the 15% breaker would stop it
first). The RRG ranking card applies to every strategy at once.
Since then (owner, 2026-09-27) each strategy card has its own RRG ranking
switch (off by default), and the card's ranking applies only to the
strategies switched on, so the 4H can use Position ranking alone.

**Every dashboard combination on the daily EMA 50 strategies (owner; runs
36353466960-36353494577, 56 coins, same 36 months and account rules).** Rows:
the card's coin selection. Columns: the RRG ranking card. Each cell: return /
max drawdown / profitable quarters (of 12).

EMA 50 Target 1 ATR (ema50_trend_vol, hiwin):

| Coin selection | First come (Off) | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| None | **+47.3% / 4.9% / 10** | +44.0% / 7.6% / 8 | +44.7% / 7.4% / 9 | +46.1% / 7.4% / 9 |
| Daily range | +37.9% / 8.0% / 9 | +27.9% / 10.3% / 10 | +30.6% / 10.2% / 9 | +35.1% / 10.2% / 9 |
| RRG (position) | +9.6% / 9.1% / 7 | +7.0% / 9.7% / 7 | +7.4% / 9.7% / 7 | +10.0% / 9.7% / 7 |
| RRG heading | +31.5% / 5.1% / 9 | +29.9% / 6.6% / 9 | +32.1% / 6.5% / 9 | +32.1% / 6.5% / 9 |
| RRG fast + slow | +30.9% / 5.1% / 9 | +33.1% / 5.5% / 9 | +33.6% / 5.1% / 9 | +33.6% / 5.1% / 9 |
| BTC regime | +22.9% / 11.9% / 9 | +27.3% / 11.5% / 9 | +29.3% / 11.9% / 10 | +31.3% / 10.5% / 10 |

EMA 50 Hybrid (hybrid, the live exit):

| Coin selection | First come (Off) | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| None | +22.6% / 7.0% / 10 | **+25.1% / 7.6% / 9** | +24.7% / 7.3% / 10 | +24.9% / 7.3% / 10 |
| Daily range | +19.1% / 6.0% / 8 | +15.1% / 7.9% / 8 | +18.4% / 6.7% / 8 | +18.4% / 6.7% / 8 |
| RRG (position) | +6.9% / 9.8% / 6 | +10.9% / 8.8% / 8 | +14.2% / 8.8% / 8 | +14.4% / 8.8% / 8 |
| RRG heading | +21.5% / 4.6% / 9 | +22.4% / 4.3% / 9 | +20.0% / 4.3% / 9 | +20.0% / 4.3% / 9 |
| RRG fast + slow | +18.3% / 4.9% / 8 | +19.8% / 4.9% / 9 | +18.1% / 4.9% / 8 | +18.1% / 4.9% / 8 |
| BTC regime | +16.5% / 11.4% / 7 | +16.2% / 12.7% / 8 | +14.1% / 12.1% / 9 | +14.5% / 11.7% / 9 |

EMA 50 Hybrid 1.5 (hybrid15):

| Coin selection | First come (Off) | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| None | +15.2% / 7.9% / 9 | +21.1% / 7.2% / 7 | +18.3% / 9.0% / 7 | +18.3% / 9.0% / 7 |
| Daily range | +16.8% / 8.5% / 8 | +20.9% / 8.2% / 8 | +20.8% / 8.3% / 8 | +20.8% / 8.3% / 8 |
| RRG (position) | +7.0% / 11.4% / 4 | +9.2% / 11.4% / 5 | +8.7% / 11.4% / 4 | +8.7% / 11.4% / 4 |
| RRG heading | +27.3% / 4.6% / 9 | +26.7% / 4.9% / 9 | +22.4% / 4.6% / 9 | +22.4% / 4.6% / 9 |
| RRG fast + slow | **+29.2% / 5.7% / 9** | +27.4% / 5.7% / 9 | +22.8% / 5.7% / 8 | +22.8% / 5.7% / 8 |
| BTC regime | +17.6% / 8.4% / 8 | +8.4% / 9.4% / 7 | +10.1% / 8.4% / 8 | +10.1% / 8.5% / 8 |

Target 1 ATR: the plain setup (None, first come) is best on every measure:
the most return, the smallest drawdown and the most positive quarters. Every
selection lowers it. Hybrid: None makes the most over three years (+22.6% to
+25.1%), but nearly all of it in the older two years (18.6R older, 2.6R in the
newer year, first come). RRG heading selection makes about the same (+21.5%,
11.2R / 8.9R) with a third less drawdown (4.3-4.6%); fast + slow makes a few
points less (+18.3%, 7.4R / 10.0R). Hybrid 1.5: the direction selections
roughly double it: fast + slow +29.2% (9.1R older, 17.4R newer) and heading
+27.3% (8.7R, 16.1R), against +15.2% plain (8.6R, 6.3R), with smaller
drawdowns; ranking on top of them costs points. BTC regime on Hybrid 1.5 had
the best newer year (19.1R) but lost in the older two (−2.1R). RRG (position)
selection is the worst on all three exits. The ranking moves results by a few
points either way. The None / Target 1 ATR / first come cell measured +44.4%
in the earlier run (55 coins) and +47.3% here, so gaps under about 5 points
are noise, and picking the best of 24 cells flatters the winner a little.

Best combination per strategy (all at 1% risk; the live account risks 3%):

| Strategy | Best combination | Return / max DD / q+ | Plain (None, first come) |
| --- | --- | --- | --- |
| EMA 50 Target 1 ATR | None, first come | +47.3% / 4.9% / 10 | same |
| EMA 50 Hybrid | None, Position (within noise of None, first come) | +25.1% / 7.6% / 9 | +22.6% / 7.0% / 10 |
| EMA 50 Hybrid 1.5 | RRG fast + slow, first come | +29.2% / 5.7% / 9 | +15.2% / 7.9% / 9 |
| 4H pullback | Daily range, Position | +25.5% / 19.4% / 7 | +20.1% / 23.1% / 7 |
| 1H pullback | RRG heading, first come (the only positive one) | +7.3% / 39.8% / 6 | −52.7% / 66.8% / 3 |

**4H pullback, 2026-09-28 (owner): exits, coin list, RSI filter.** All on
the live setup (pb_13_34_50_4h + daily range, r5_4h), 36 months, full account
at 1% risk, the four ranking cards side by side.

- Lower first target: 1.6R (live) +6.5%, 1.5R +2.8%, 1.4R −4.2% (Position).
  A middle target (25% at 2.5R / 3R / 4R) never beat the plain exit. Kept as is.
- Coin list: Bitunix's new stock / ETF / oil / silver perps crowded the
  most-liquid list; they are now left out of every universe (gold stays).
  The 4H result swings hard with the list: +25.5% on 27 Sep (55 coins),
  +2.4%, then −16% (Position) on 28 Sep as coins came and went. The daily
  EMA 50 strategies moved a few points at most between runs.
- Overbought filter on longs (owner, after NEAR stalled overbought into
  resistance), same coin list for every row, return / max drawdown:

| No long when… | First come | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| no filter | −19.6% / 34.0% | −16.0% / 36.5% | −14.8% / 34.0% | −12.1% / 34.1% |
| weekly ≥ 70 or daily ≥ 76 | −1.0% / 31.4% | −8.1% / 29.7% | −4.8% / 31.2% | −8.9% / 30.2% |
| weekly ≥ 70 and daily ≥ 76 | −14.8% / 34.2% | −15.7% / 36.2% | −22.3% / 39.8% | −19.6% / 39.7% |
| 4H RSI ≥ 78.5 (alone or added) | no change: never fires at a pullback entry | | | |
| weekly ≥ 70 only | −6.8% / 34.6% | −11.5% / 32.9% | −5.1% / 31.8% | −6.1% / 29.9% |
| daily ≥ 76 only | −20.2% / 34.7% | −10.9% / 31.4% | −16.2% / 35.1% | −16.2% / 37.1% |
| weekly ≥ 75 or daily ≥ 80 | −7.9% / 32.3% | −10.3% / 32.2% | −3.8% / 31.1% | −8.0% / 29.2% |
| weekly ≥ 65 or daily ≥ 72 | −5.1% / 26.0% | −2.0% / 26.3% | +11.0% / 25.7% | +5.2% / 26.4% |
| **weekly ≥ 62 or daily ≥ 70** | +9.4% / 28.3% | +18.6% / 24.2% | **+28.7% / 22.9%**, 7/12 q+ | +16.7% / 24.2% |
| weekly ≥ 60 or daily ≥ 68 | +9.4% / 30.4% | +24.9% / 28.2%, 8/12 | +28.2% / 26.5%, 8/12 | +16.2% / 27.6% |

The weekly RSI does most of the work; tighter helps down to about 62 / 70,
then levels off (60 / 68 about the same), which is a plateau rather than a
single lucky cell. The gain is mostly in the older two years (the newer year
is +5.6R at 62 / 70 with Heading, about flat at 60 / 68), and 11 variants were
tried on the same data, so treat the size of the gain with caution. Added to
the dashboard as an RSI filter per strategy (off by default, levels
adjustable, shorts never filtered).

RSI 62 / 70 on every coin selection (a later run, so the coin list differs
slightly): none +8.0 / +20.1 / +30.2 / +25.7%; range as above; RRG +10.6 /
+17.7 / +8.1 / +16.4%; heading −18.9 to −11.6%; fast + slow −3.4 to +1.9%;
BTC regime +2.9 to +15.7% (first come / position / heading / fast + slow).

**Room to TP1 (owner, 2026-09-28).** Skip an entry when a daily swing high
(swing low for shorts; bar k is the extreme of k−3..k+3, confirmed by j, last
120 days) sits between the entry and TP1 (1.6R). "Zones" counts only levels
with 2+ swings within 0.5 daily ATR. Range selection, return / max drawdown /
profitable quarters of 12:

| Filter | First come | Position | Heading | Fast + slow |
| --- | --- | --- | --- | --- |
| any swing | −0.2% / 29.2% / 5 | −2.5% / 30.3% / 5 | −7.6% / 35.5% / 5 | +4.7% / 26.9% / 5 |
| zones | +15.0% / 22.2% / 6 | −8.7% / 34.6% / 4 | +0.3% / 30.7% / 6 | −3.7% / 34.5% / 5 |
| RSI 62/70 + any swing | +17.0% / 17.8% / 6 | +26.9% / 17.8% / 7 | +29.3% / 17.8% / 7 | +30.9% / 17.0% / 8 |
| **RSI 62/70 + zones** | +24.9% / 21.2% / 7 | +5.6% / 24.2% / 7 | **+31.6% / 18.2% / 8** | +32.2% / 15.7% / 6 |

Alone it is mixed (the older two years get worse). With the RSI filter it
keeps the return and cuts the drawdown from about 23% to 16–18%, with the
older and newer years more even. Many variants have now been tried on the
same data. Added to the dashboard as a room-to-TP1 switch per strategy (off,
zones, any swing); the owner put the 4H on RSI 62/70 + zones + range + RRG
heading ranking (live and paper).

**Short-side RSI on the live 4H setup (owner, 2026-09-28).** Range + RSI
62/70 + room zones + RRG heading ranking, same coin list; return / max
drawdown / profitable quarters: baseline +34.5% / 14.9% / 8. No short when
weekly <= 40 or daily <= 30: +8.3% / 13.4% / 6; 35 / 25: +10.4% / 16.0% / 6;
45 / 35: −4.7% / 17.4% / 5; daily <= 30 only: +28.8% / 14.9% / 7. No short
when weekly >= 55: +38.6% / 14.9% / 8; weekly >= 50: +40.3% / 19.2% / 8.
Oversold filters hurt: the winning shorts are mostly into already-weak coins.
Blocking shorts while the weekly RSI is still >= 55 helps a little (within the
run-to-run noise of the coin list).
Follow-up, same coin list: weekly >= 53: +33.4% / 16.0% / 8; >= 57: +30.2% /
14.9% / 8 (baseline +34.5% / 14.9%, >= 55 +38.6% / 14.9%). No plateau: only 55
helps, its neighbours don't, so it is treated as noise and not added.
(Owner kept 55 anyway: dashboard short filter, on for the 4H at 55.)

**Entry timing on the live 4H setup (owner, 2026-09-28).** Range + RSI 62/70 +
room zones + short filter 55 + heading ranking, same coin list: the pullback
trigger +38.6% / 14.9% / 8. The same signals moved to a random 4H close within
±6 bars (same coin and side, same stop rules): seed 1 +88.3% / 14.8% / 9,
seed 2 +41.5% / 20.9% / 8, seed 3 +8.6% / 29.5% / 6. One-bar confirmation
(enter a close later if still beyond EMA 13): +25.3% / 15.5% / 8. The trigger
does no better than random timing inside the same trend window: the edge is in
the bias, filters and exit, and timing luck alone moves the result by tens of
percent, so small differences between variants above are within that noise.

20 random-timing seeds (same setup and coin list), return %: −4.0, −2.8, 8.0,
8.6, 10.0, 14.7, 14.9, 32.8, 37.5, 40.9, 41.5, 45.6, 62.1, 62.6, 63.8, 71.1,
77.2, 81.1, 88.3, 105.5 (median +41%, mean +43%; drawdown 11.9–29.7%). The live
trigger's +38.6% / 14.9% sits at the 45th percentile: no timing edge, but 18
of 20 random timings are profitable, so the bias + filters + exit edge is
robust to entry timing. Entry price / stop width, live setup: limit 0.3 ATR
better (stop kept) +1.7% / 23.9%; limit 0.5 ATR (stop kept) −8.4% / 28.8%;
limit 0.5 ATR (stop moved) −8.7% / 28.5%; stop 1.25x +1.2% / 18.7%;
stop 1.5x +13.5% / 10.3%. Limits fill mostly on the trades that keep going
against you and miss the ones that run; wider stops cut the stop-outs but
push TP1 further away. Neither beats the current entry and stop.

**Correction: fixed entry shifts (same setup and coin list).** Every signal
moved by exactly k 4H bars, return / max DD / profitable quarters:
k = −6 +0.7% / 20.4% / 7; −5 +17.7% / 20.5%; −4 +13.3% / 20.4%; −3 +87.7% /
14.6% / 9; −2 +215% / 12.3% / 11; −1 +431% / 7.4% / 11 (57.6% win);
0 (live) +38.6% / 14.9% / 8; +1 +28.6% / 25.3% / 6; +2 −7.1% / 29.6%; +3
+17.7% / 26.2%; +4 +3.7% / 35.4%; +5 +9.7% / 28.0%; +6 −19.6% / 35.6%.
Negative shifts enter before the signal fired (look-ahead: the bar before the
reclaim is the pullback low), so they are not tradeable; they are what made
the best random seeds (e.g. seed 18, +105%) look good. The fair comparison is
with waiting: every later entry is worse than the trigger. So the random-seed
conclusion above was wrong: the trigger's timing matters, and entering at the
reclaim close is the best tradeable timing tested. The large gain one bar
earlier suggests an anticipatory entry (a resting limit into the pullback
before the reclaim) is the direction worth researching next.

Anticipatory limit (same filters, same coin list; live trigger +38.6% / 14.9%
/ 8): resting limit at EMA 13 while the setup is armed, 529 trades, 40.3% win,
+9.9% / 23.1% / 7; limit at the EMA 13/34 midpoint, 276 trades, 38.8% win,
−7.8% / 34.4% / 5. Buying the dip before the reclaim fills on the dips that
keep falling as well as the ones that turn; the reclaim close is what sorts
them. The one-bar-early result above is look-ahead only. The live entry stays.

EMA set (owner, 2026-09-28; same filters, exits and coin list): 4H 12/21/50
(stop and pullback limit on EMA 21) 362 trades, 36.5% win, −14.4% / 38.3% /
7, breaker tripped 3x; the live 13/34/50 403 trades, 43.7% win, +38.6% /
14.9% / 8. EMA 21 is too tight a floor on 4H: normal pullbacks break it and
the stop sits inside the noise. 13/34/50 stays.

The 4H model on 1H candles (owner, 2026-09-28; same coin list, first come):
live 1H (9/21/50 + heading + RSI 62/70, exit r5_1h) +23.7% / 23.8% / 7; the
4H chain (13/34/50 + range + RSI + room zones + short 55, 2.8% gate) −15.1% /
29.9% / 4; with the 1H 2.0% gate −42.2% / 52.8% / 3; with the 2.0% gate and
the 4H exit −38.2% / 45.9% / 3. The 4H settings don't carry over to 1H: the
room filter and range selection already hurt the 1H, and on 1H candles 13/34
reacts to intraday noise. The live 1H setup stays.

**RSI and room filters on the 1H pullback (owner, 2026-09-28).** RRG heading
selection, first come first served (live): baseline +16.1% / 34.9% / 5 (older
two years +34.4R, newer year −11.5R); + RSI 62/70: +16.9% / 28.5% / 7 (+23.4R /
−1.9R); + room zones: −18.2% / 43.9%; + both: −14.9% / 31.7%; + RSI + any
swing: −15.5% / 33.3%; no selection + both: −44.5% / 45.3%. The RSI filter
helps the 1H (lower drawdown, newer year near flat); the room check hurts it.
The 1H baseline swings a lot with the coin list (−9.4% one run earlier).

## The 6-month check: FAILED (run 2026-09-27, run 36327450163)

Held-out months 2026-03-29 → 2026-09-27, 60 coins, the frozen configuration
below, graded by the rule declared before it ran:

| Check | Result | Needs | |
| --- | --- | --- | --- |
| Trades | 96 | ≥ 30 | ok |
| Average R | **−0.048R** | > 0 | **FAIL** |
| Win rate | 62.5% | ≥ 60% | ok |
| Max drawdown | 8.2% | < 25% | ok |
| Average R vs research | −0.048R | ≥ +0.052R | **FAIL** |

Return −4.7% (PF 0.86, −4.6R). By quarter: Apr–Jun 47 trades, 68% win,
+0.3R; Jul–Sep 49 trades, 57% win, −4.9R. The win rate held, but the 1-ATR
target is only half the 2-ATR stop, so at ~62% wins it loses money; the
research window's ~73% did not carry over. Per the declared rule the lead is
retired: BOT_MODEL and LIVE_MODEL stay 'none', and the holdout is spent (its
result is in research/holdout-ema50.json; the runner refuses to run again).

## The 6-month check (declared 2026-09-27, before it ran)

Frozen configuration (`HOLDOUT_FROZEN` in `packages/backtest/src/screen/portfolio.ts`):
daily EMA 50 trend + ATR volatility filter, hiwin exit (stop 2 ATR, target
1 ATR, out after 24 daily bars), 1% risk, open risk ≤ 6%, ≤ 2 same-direction
alts, 8% daily loss, 15% drawdown breaker → 7 days off, fill realism on; the
same universe rule as research (BTC/ETH/XRP + 60 extras, ≥ $3M 24h volume).
Window: the held-out months, from the end of the research window to the run
date. The hybrid strategies are not graded; they paper-trade alongside.

Pass rule (`HOLDOUT_RULE`), every line must hold:

| Check | Needs |
| --- | --- |
| Trades | ≥ 30 |
| Average R | > 0 |
| Win rate | ≥ 60% |
| Max drawdown | < 25% |
| Average R vs research (+0.103R) | ≥ +0.052R (half) |

It runs once: workflow *6-month check (one time, owner only)*, only when the
owner types `OWNER SAYS GO`. The result is saved to
`research/holdout-ema50.json` (commit it; the runner refuses to run again
while that file exists). On a pass: paper trading with the three strategies
tagged (BOT_MODEL = ema50). Live stays off until the owner approves
(LIVE_MODEL = ema50), and then only the target-1-ATR strategy is live unless
the owner switches the others on from the dashboard. On a fail: the lead is
retired, and research goes on without touching the holdout again.

**4H trail width (owner, 2026-09-29, after the LINK long was trailed out at
14.80).** Live 4H setup, window 2023-03-31 → 2026-03-31 and today's coin list
(both shifted a day, so the baseline differs from earlier runs); return / max
DD / profitable quarters: trail 2 ATR +13.8% / 20.6% / 7; 2.5 ATR +25.6% /
17.0% / 7; 3 ATR +22.5% / 17.0% / 7; 3.5 ATR +29.2% / 17.4% / 7. Every wider
trail beats 2 ATR on return and drawdown (a plateau, not one lucky value); the
live trail moved to 3 ATR, then (owner) to 3.5 ATR, the best-scoring.

## EMA crossover model (owner, 2026-09-29) — research for a separate bot

Entry: EMA fast closes across EMA slow (long up, short down). Stop beyond the
lower of EMA slow and the 3-bar swing (1.0-2.5 ATR; at least 2.8% of price on
4H, 2.0% on 1H). No fixed target (cap 20R). Filters: raw (every cross);
trend (daily EMA 50 bias + close on the trade's side of EMA 50); chop (trend
+ EMA slow sloping the trade's way over 3 bars + ATR regime). Exits: xe_5_12
= EMA 5 closes back through EMA 12; xe_c12 = a candle closes back through EMA
12; xe_5_20 = the reverse 5/20 cross; xe_h5_12 = 50% off at 1.6R, stop to
entry+0.2R, rest on the 5/12 exit. 62 coins, 2023-03-31 → 2026-03-31, 1% risk,
first come; return / max DD / profitable quarters:

| Setup | 4H | 1H |
| --- | --- | --- |
| 5/20 raw, exit 5/12 | +13.3% / 43.7% / 7 (1662 tr, 28.6% win) | −95.2% / 95.8% / 3 |
| 5/20 trend, exit 5/12 | **+125.6% / 22.1% / 9** (1103 tr, 30.2%) | −0.4% / 56.9% / 4 |
| 5/20 chop, exit 5/12 | +109.7% / 20.5% / 6 | −74.0% / 82.0% / 4 |
| 5/20 chop, exit close through EMA 12 | +124.2% / 19.7% / 7 | −66.5% / 74.5% / 4 |
| 5/20 chop, hybrid exit | **+119.4% / 15.2% / 9** (34.7% win) | −53.9% / 65.3% / 4 |
| 5/20 chop, exit 5/20 | +73.1% / 24.9% / 7 | |
| 5/11 chop, exit close through EMA 12 | +51.6% / 33.2% / 7 | −85.5% / 89.6% / 1 (EMA 13: −87.6%) |
| 4/19 chop, exit 5/12 | +59.7% / 22.9% / 6 | |
| 6/21 chop, exit 5/12 | +130.8% / 24.9% / 7 | |

On 4H every filtered variant is clearly positive (4/19, 5/20 and 6/21 all
work: not one lucky pair), and the trend filter turns a +13% / 44% raw system
into +126% / 22%. Low win rate (28-35%), paid by the trends the EMA exit lets
run. The 1H loses everywhere: too many crosses, and fees on the small moves.
Next before building: the trend filter with the hybrid exit, older vs newer
years, a random-direction check, and the RRG rankings.

Crossover robustness (same 62 coins; return / max DD / profitable quarters /
R older two years / R newer year / trades; first come unless noted):

| Setup (4H) | First come | Best RRG ranking |
| --- | --- | --- |
| 5/20 trend, exit 5/12 | +125.6% / 22.1% / 9 / 85.6R / 15.0R / 1103 | fast+slow +86.7% / 27.3% |
| 5/20 trend, hybrid exit | +94.3% / 16.1% / 9 / 47.0R / 29.6R / 1113 | heading +87.6% / 19.0% |
| **5/20 chop, hybrid exit** | **+119.4% / 15.2% / 9 / 64.3R / 24.2R / 729** | heading +116.5% / 17.1% |
| 6/21 trend, hybrid exit | +134.1% / 16.3% / 7 / 72.7R / 22.1R / 1030 | position +143.1% / 15.0% |
| 4/19 trend, hybrid exit | +78.1% / 22.0% / 8 / 45.5R / 23.7R / 1227 | fast+slow +83.2% / 19.2% |

Every variant is positive in both the older two years and the newer year; the
RRG rankings mostly don't help (first come is best or close). Random direction
on the 5/20 trend entries (exit 5/12), 5 seeds: −31.8%, +169.3%, +17.3%,
−53.0%, −9.0% (vs +125.6%). Not a clean test with this exit: a trade taken
against the cross is closed by the 5/12 exit at the next close, so a coin-flip
run keeps the real-direction half and cuts the other half fast. To be redone
with a fixed exit before going live.

**Built (owner, 2026-09-29):** the 4H EMA crossover runs in the HTF slot
(Hybrid retired): xover_5_20_chop_4h, maker entry at the close, structure
stop, 50% off at 1.6R, stop to entry+0.2R, the rest out when EMA 5 closes back
through EMA 12 on the 4H (engine and live management), cap 20R. Paper on;
live off until the owner switches it on.

Random direction with a direction-neutral exit (r5_4h: 50% at 1.6R, stop to
+0.2R, 2 ATR trail), same 62 coins: the real 5/20 trend entries +98.7% / 21.0%
/ 8 (915 trades, +0.086R avg); the chop version +74.5% / 17.9% / 8; the same
entry bars with a coin-flip direction, 5 seeds: +8.5%, +100.0%, +39.5%, +8.7%,
−13.1% (avg +0.013 to +0.066R; median +8.7%). The real direction beats 4 of 5
and roughly triples the average R of the median seed, but one seed matched
it: part of the result comes from trading these moments with a trailing exit,
not only from the direction. Evidence for the crossover's direction is real
but moderate; the forward test on paper decides before live.

### Crossover exit: ATR trails vs the EMA 5/12 exit (2026-09-30, runs 183-189)

Owner asked whether a wider ATR trail (as on the 4H pullback) beats the EMA
exit on the crossover. Same signal (`xover_5_20_chop_4h`), same 58 coins, same
batch; all exits keep 50% off at 1.6R and the stop to +0.2R, then the rest
exits as listed.

| Exit on the rest | Trades | Win | Avg R | Total R | Return | Max DD | Breaker | Q+ | Older 8 Q | Newer 4 Q |
|---|---|---|---|---|---|---|---|---|---|---|
| **EMA 5 closes through EMA 12 (built)** | 725 | 34.9% | 0.121 | 87.7 | **+118.7%** | **14.7%** | 0 | 7/12 | 66.3R | 21.3R |
| Trail 2 ATR | 604 | 41.7% | 0.110 | 66.3 | +77.7% | 26.0% | 2 | 8/12 | 20.4R | 45.9R |
| Trail 2.5 ATR | 584 | 40.8% | 0.092 | 53.6 | +56.0% | 27.3% | 3 | 8/12 | 18.7R | 34.9R |
| Trail 3 ATR | 566 | 40.8% | 0.103 | 58.1 | +62.2% | 22.0% | 2 | 7/12 | 20.3R | 37.7R |
| Trail 3.5 ATR | 543 | 40.1% | 0.103 | 56.0 | +57.8% | 25.1% | 4 | 7/12 | 22.1R | 34.0R |
| Trail 4 ATR | 531 | 40.7% | 0.129 | 68.3 | +78.3% | 18.0% | 2 | 8/12 | 26.8R | 41.4R |
| Trail 3.5 ATR or EMA 5/12, first | 735 | 34.8% | 0.109 | 80.3 | +104.0% | 14.7% | 0 | 6/12 | 55.4R | 25.0R |

Kept the EMA 5/12 exit. The trails win more often (~41% vs 35%) but return
about half as much with 18-27% drawdowns and the breaker tripping, mostly in
2024 Q1-Q2 where they gave back -14 to -18R in a quarter. Unlike the pullback,
a wider trail does not help here: the crossover's own signal (EMA 5 back
through 12) is the better "trend is over" read. One thing to watch: in the
newest 4 quarters every trail made more R (34-46R) than the EMA exit (21R),
so the EMA exit's lead comes from 2023-2024 (it lost far less in the 2024 Q1-Q2
chop and rode the 2024 Q3-Q4 trends further). The newest year would mean the
EMA exit is now getting out too early (shaken out of trends that carried on),
not late; at ~250 trades that gap is about one standard error, so not proven.
Trail 4 ATR (best of the trails on return and drawdown) is the one to retest
if paper trading shows the same; checked trade by trade with --compare-exit.

## S/R Channels bot (owner, 2026-10-02) — research for a separate bot

Entry and exit model: LonesomeTheBlue's "Support Resistance Channels" (TradingView, MPL-2.0),
ported bar for bar in `packages/backtest/src/screen/srchannels.ts` (defaults: pivot 10,
High/Low, width 5% of the 300-bar range, 6 channels, loopback 290; no look-ahead, tested).

**Matrix** (declared before any run): 3 entry styles x room filter (off / `_room15`) x 1H, 4H,
daily = 18 portfolio jobs, each under 6 exits (`--exits`), same 58 coins, 36-month research
window (holdout excluded), 1% risk, all controls on. Daily preloads 12 months for the
300-bar warm-up.

- Entries: `src_brk_*` the indicator's own alerts (resistance broken -> long, support
  broken -> short); `src_rt_*` break then retest within 6 bars; `src_bnc_*` bounce off a
  channel. Stop beyond the channel's far edge + 0.2 ATR (1-3 ATR); target = next channel.
- Exits: `sr_tp` all out at the next channel; `sr_tp_be` + stop to +0.2R at +1R; `sr_half`
  50% at the next channel, rest trails 2.5 ATR; `r5_1h`/`r5_4h` house plan; `xt_3` runner;
  `sr_fail` runner + out on a close back through the channel.

**Selection rule** (fixed now, before results):
1. Qualify: >= 150 trades (daily: >= 80; daily counts only if it qualifies), avg R >= +0.08,
   both the older two years and the newest year positive, max drawdown <= 25%.
2. Rank qualifiers by return / max drawdown; ties: more profitable quarters.
3. Top 2: random-direction check (same entry bars, coin-flip direction, seeds 1-5, `r5`
   exit); keep only if the real direction beats at least 4 of 5 seeds.
4. If nothing qualifies, report that and the nearest cells; no tuning hunt on this data.

### S/R Channels results, 1H and 4H (runs 192-203, 2026-10-03)

Every one of the 72 cells loses (3 entries x room filter x 6 exits x 2 timeframes); none
qualifies under the rule above. Signals fire very often (2,000-9,000 trades in 36 months), and
the average trade is -0.01R to -0.13R.

| 4H (return / max DD / avg R) | sr_tp | sr_tp_be | sr_half | r5_4h | xt_3 | sr_fail |
|---|---|---|---|---|---|---|
| break | -71% / 78% / -0.029 | -88% / 88% / -0.044 | -81% / 84% / -0.048 | -79% / 81% / -0.052 | -44% / 62% / -0.016 | -44% / 64% / -0.011 |
| break, room 1.5 | -55% / 66% / -0.025 | -70% / 71% / -0.033 | -43% / 47% / -0.015 | -63% / 68% / -0.034 | -40% / 50% / -0.014 | -61% / 64% / -0.024 |
| retest | -62% / 67% / -0.027 | -64% / 67% / -0.024 | -73% / 77% / -0.045 | -53% / 56% / -0.024 | -35% / 47% / -0.013 | -64% / 65% / -0.031 |
| retest, room 1.5 | -10% / 48% / +0.010 | **+19% / 44% / +0.018** | -44% / 54% / -0.019 | -47% / 60% / -0.022 | -39% / 49% / -0.019 | -52% / 59% / -0.024 |
| bounce | -91% / 92% / -0.068 | -92% / 94% / -0.061 | -93% / 94% / -0.082 | -88% / 89% / -0.070 | -73% / 75% / -0.055 | -78% / 81% / -0.047 |
| bounce, room 1.5 | -59% / 67% / -0.034 | -76% / 77% / -0.042 | -64% / 72% / -0.037 | -66% / 72% / -0.036 | -48% / 59% / -0.024 | -68% / 75% / -0.035 |

1H: every cell -97% to -100% (avg -0.05R to -0.13R); costs on 5,000-9,000 trades sink it.
The one positive cell (4H retest + room, all out at the next channel, stop to +0.2R at +1R)
fails the rule: avg R +0.018 (< 0.08), drawdown 44%, newest year -24R. Daily runs pending.

Read: the indicator's raw events have no edge on their own here; any confluence (e.g. Fibonacci)
has to turn a negative average trade positive, so it must be judged against a random filter that
removes the same number of trades.

## Fib pullback into deep S/R (owner, 2026-10-03) — research, no bot

Owner's spec: S/R channels only as deep support/resistance; enter a Fibonacci pullback in the
0.618-0.65 to 0.786 zone; exits at the 0.382 and 0.236 retracements, then a trailing stop and a
final target at the 1.272 extension; with a trend filter (EMA length adjustable); both trail styles.

**Model** (`fib_<deep>_<entry>_t<N>_<tf>` in screen/signals.ts; long, short mirrors): leg = last
confirmed swing low L -> swing high H (pivot period 10, known 10 bars late), >= 3 ATR; armed on
the bar H is confirmed while price is above the 0.618 level. Limit at 0.65 (`e65`) or 0.786
(`e786`), resting 30 bars, cancelled if price trades above H or closes below L; stop L - 0.2 ATR.
Exits (`fx_*`): TP1 0.382, TP2 0.236 (splits 1/3-1/3-1/3 or 50-25-25), stop to entry+0.1R after
TP1, trail after TP2 (2.5 ATR or swing), final 1.272. Deep S/R: `top2` (the 2 strongest channels
overlap the zone), `p3` (a channel of >= 3 pivots overlaps), `htf` (next timeframe up's
channels), `none` (Fib alone, the control). Trend `t50` = daily close above a rising EMA 50
(`t0` = off). Daily warm-up 6 months.

**Matrix:** 44 signals (1H and 4H: 4 deep x 2 entries x 2 trend; daily: no htf) x 4 exits; same
58 coins, 36 months, holdout excluded, 1% risk, all controls.

**Selection rule** (fixed before the runs):
1. Qualify: avg R >= +0.08; older two years and newest year both positive; max DD <= 25%;
   trades >= 100 (1H/4H) or >= 60 (daily).
2. Rank by return / max DD.
3. Deep S/R must beat `none` (same entry, trend, exit) on avg R, else S/R adds nothing.
4. Winner: beats >= 4 of 5 random filters (same count of `none` setups kept at random) and the
   random-direction check; trade list shown to the owner. No tuning on this data.

### Fib pullback results (runs 210-253, 2026-10-03)

No cell qualifies. Best exit per signal (return / max DD / avg R / trades):

| 4H, entry 0.65 | trend t50 | no trend |
|---|---|---|
| htf (daily channels) | **+9.3% / 16.9% / +0.044R / 225** (fx_33_swing; older +5.2R, newest +4.6R) | -5.9% / 24.7% / -0.012R / 372 |
| p3 (>= 3 pivots) | +1.9% / 16.3% / +0.011R / 260 | -27.2% / 29.2% / -0.081R / 372 |
| top2 | -5.7% / 13.9% / -0.019R / 257 | -34.3% / 35.2% / -0.112R / 362 |
| none (Fib alone) | +2.5% / 16.1% / +0.010R / 481 | -12.4% / 30.8% / -0.016R / 655 |

- Entry 0.786: worse everywhere (win ~35%) except htf+t50 (+4.2% / 21.8% / +0.036R / 166).
- 1H: every cell -39% to -94%. Daily: 22-123 trades, all negative (best none_e65_t0 -0.4%).
- Exits (1/3 vs 50/25/25, ATR vs swing trail) change little.
- Read: the trend filter matters most; deep S/R adds value only as higher-timeframe channels
  (htf 4x the Fib-alone avg R); the near-miss fails only on avg R (+0.044 vs +0.08): TP1 at
  0.382 is ~+0.8R against a -1R stop, so the edge per trade is thin.

### Fib round 2, R:R variants (owner, 2026-10-03) — rule fixed before the runs

4H, deep S/R = daily channels, entry 0.65. Variants: stop beyond the swing low (base) or the
0.886 level - 0.1 ATR (`_s886`); TP1 0.382 / TP2 0.236 (base) or TP1 0.236 / TP2 the swing high
(`_late` exits); trend EMA 30 / 50 / 100. 6 signals x 4 exits (swing or 2.5 ATR trail).
Rule: same qualify bar (avg R >= +0.08, both periods positive, max DD <= 25%, >= 100 trades),
rank by return / max DD; the winner must beat >= 4 of 5 random filters (the same number of
Fib-alone setups kept at random per coin, same stop and exit), then one out-of-sample run on
the 6 held-back months must show avg R > 0 and drawdown <= 25%. No further tuning on this data.

### Fib round 2 results (runs 254-259, 2026-10-03)

No cell qualifies, so no random-filter or out-of-sample run. Return / max DD / older 2y / newest
year / trades / avg R:

| 4H htf, entry 0.65 | fx_33_swing | fx_33_atr | fx_33_swing_late | fx_33_atr_late |
|---|---|---|---|---|
| t30 | +4.3% / 15.6% / -1.0R / +6.1R / 232 / +0.022R | +0.7% / 16.4% / +0.007R | -5.5% / 23.3% / -0.021R | -6.1% / 23.0% / -0.025R |
| **t50** | **+8.0% / 17.6% / +6.3R / +2.3R / 225 / +0.038R** | +3.0% / 19.1% / +0.017R | +0.9% / 21.5% / +0.011R | -0.7% / 22.0% / +0.003R |
| t100 | -4.5% / 25.1% / -0.017R | -3.7% / 24.4% / -0.012R | -7.2% / 27.7% / -0.029R | -9.3% / 27.7% / -0.040R |
| t30 s886 | -16.0% / 23.8% / -0.068R | -17.0% / 25.4% / -0.073R | -19.9% / 25.7% / -0.097R | -20.2% / 26.6% / -0.099R |
| t50 s886 | -12.1% / 25.3% / -0.051R | -14.6% / 26.1% / -0.063R | -20.4% / 23.7% / -0.097R | -24.5% / 27.6% / -0.122R |
| t100 s886 | -18.2% / 28.3% / -0.080R | -15.3% / 27.0% / -0.066R | -20.7% / 25.2% / -0.098R | -21.8% / 25.5% / -0.105R |

- The 0.886 stop is worse everywhere (win rate drops from ~60% to ~45%: pullbacks often wick
  past 0.886 before turning). Later take-profits are worse (win rate ~48%). EMA 50 stays best.
- The t50 base cell reads slightly lower than round 1 (+8.0% vs +9.3%) because the window end
  moved forward one day. Conclusion unchanged: the 4H Fib model is a thin edge (~+0.04R).

### Fib round 3: 1H needs 4H approval (owner, 2026-10-03) — rule fixed before the runs

Owner: a 1H setup needs the 4H's approval, as a 4H setup needs the daily's. 4H approval = the
last closed 4H close above (long) / below (short) its 4H EMA n, the EMA rising (falling) over 5
bars — the same rule as the daily gate. 1H, entry 0.65, stop beyond the swing, 4 signals:
`fib_htf_e65_d50_a50_1h` (4H channels + daily EMA 50 + 4H EMA 50; the full cascade),
`fib_htf_e65_d0_a50_1h` (4H approval only), `fib_htf_e65_d50_a20_1h` (faster 4H EMA),
`fib_none_e65_d50_a50_1h` (cascade without S/R). Exits fx_33_swing, fx_33_atr, fx_50_swing,
fx_50_atr. Same rule as round 2 (avg R >= +0.08, both periods positive, DD <= 25%, >= 100
trades; rank by return / DD; beat >= 4 of 5 random filters `fib_rnd<seed>_e65_d50_a50_1h`;
then one out-of-sample run). This is a new owner hypothesis, not a tune of round 2; it is the
last test of the Fib model on this data either way. Random controls now set their keep rate
from the setups so far (causal), not the whole window.

### Fib round 3 results (runs 260-263, 2026-10-03)

No cell qualifies, so no random-filter or out-of-sample run. Best exit per signal:

| 1H, entry 0.65 | best exit | return / max DD / avg R / trades |
|---|---|---|
| htf + daily 50 + 4H 50 (full cascade) | fx_50_atr | -42.3% / 43.8% / -0.065R / 793 |
| htf + 4H 50 only | fx_33_atr | -54.2% / 54.8% / -0.067R / 1087 |
| htf + daily 50 + 4H 20 | fx_33_swing | -36.0% / 38.1% / -0.056R / 740 |
| none + daily 50 + 4H 50 | fx_50_atr | -47.3% / 48.3% / -0.039R / 1444 |

- 4H approval cuts trades and losses compared with round 1's 1H cells (-39% to -94%), but
  every cell loses in both periods. Win rate is ~57%, yet the average trade is negative: on 1H,
  fees and full stops outweigh the small TP1.
- Conclusion: the Fib model shows a (thin) edge only on 4H with daily approval (+8% / 17.6% DD
  / +0.038R), below the +0.08R bar. The Fib model is closed on this data; nothing goes to the bot.

### Fib round 4: lower-timeframe entry trigger (owner, 2026-10-03) — rule fixed before the runs

Owner: confirm entries on the lower timeframe (1H for the 4H model, 15m for the 1H model). The parent setup is
unchanged (Fib leg, next-timeframe-up channel in the zone, daily / 4H+daily approval). Instead of a resting limit at
0.65, the trade is entered at market once price has traded past the 0.618 level and the trigger timeframe sweeps a low
and shifts structure (`detectShift`); stop at the sweep extreme - 0.1 ATR. One trade per setup; the setup ends on a new
swing extreme, a parent close beyond the leg's start, or 30 parent bars. Trail, ATR and time stop on the parent
timeframe. Signals `fibx_4h_d50` (run on 1h) and `fibx_1h_d50_a50` (run on 15m).

Exits, same entries (owner: is TP1 at 0.236, or a 1.6-1.8R first target with an ATR trail, better?):
`fx_33_swing_mkt` / `fx_33_atr_mkt` (1/3 at 0.382, 1/3 at 0.236, trail, 1.272 target), `fx_late_mkt` (1/3 at 0.236,
1/3 at the swing extreme, ATR trail, 1.272), `r16_atr_mkt` / `r18_atr_mkt` (50% at 1.6R / 1.8R, then a 2.5 ATR trail,
no fixed target). All move the stop to +0.1R after the first target.

Rule: qualify as before (avg R >= +0.08, both periods positive, max DD <= 25%, >= 100 trades) and beat the limit-entry
baseline (4H +0.038R, 1H -0.056R); rank by return / max DD; the winner must beat >= 4 of 5 random-trigger controls
(`fibx_rnd<seed>_*`: a random in-zone bar instead of the shift, same rate, stop at the low since the zone touch), then
one out-of-sample run. No further tuning; if nothing qualifies, the Fib model is shelved.

Per-coin check (owner: a model may suit one or two coins): each job lists, per exit, the coins with >= 30 trades,
avg R >= +0.15 in the older two years (where they are picked) and still positive in the newest year. Such a coin
gets one single-coin out-of-sample run before anything else; with 58 coins, a few will look good by chance.

### Fib round 4 results (runs 264-271, 2026-10-03)

Research window (36 months), return / max DD / older 2y / newest year / trades / win / avg R:

| 4H setup, 1H trigger (`fibx_4h_d50`) | result |
|---|---|
| fx_33_swing_mkt | -17.9% / 19.7% / -0.2R / -17.8R / 209 / 53.6% / -0.086R |
| fx_33_atr_mkt | -17.4% / 19.5% / +0.9R / -18.3R / 211 / 53.6% / -0.083R |
| fx_late_mkt (TP1 0.236) | -18.8% / 27.6% / +11.8R / -30.0R / 203 / 45.8% / -0.090R |
| r16_atr_mkt | +26.3% / 12.9% / +27.0R / -0.6R / 207 / 44.0% / +0.128R (newest year negative: fails) |
| **r18_atr_mkt** | **+32.2% / 11.8% / +28.3R / +3.0R / 207 / 42.5% / +0.151R — qualifies** |

1H setup, 15m trigger (`fibx_1h_d50_a50`): every exit loses (-49% to -73%, -0.10R to -0.22R).

- Exit answer (owner's question): with the stop under the 1H sweep, the Fib targets are too close in R and cut the
  winners; TP1 at 0.236 is worst; a fixed 1.8R first target (half) with a 2.5 ATR 4H trail is best.
- Random-trigger controls with r18 (runs 266-270): +0.124R, +0.114R, -0.078R, +0.027R, +0.100R. The model
  (+0.151R) beats 5 of 5. Note: random in-zone entries already average ~+0.06R with this exit, so most of the edge is
  the setup (4H leg, daily trend, daily channel) plus the 1.8R/trail exit; the 1H shift adds ~+0.05R and lowers DD.
- Out-of-sample (run 271, 2026-04-04 to 2026-10-03, untouched until now): **+9.6% / 14.7% DD / 79 trades / 41.8% win
  / +0.127R / PF 1.21** (quarters -8.8R, +18.8R). Passes (avg R > 0, DD <= 25%).
- Per-coin check: no coin reached 30 trades, so no specialist candidates.
- Caveats: the newest research year was only +3.0R; out-of-sample is 79 trades (one bad quarter, one good one);
  this is the 4th round on the Fib idea, so the result should be confirmed on paper before any money.
- Verdict: `fibx_4h_d50` + `r18_atr_mkt` passed every pre-set check. Nothing was added to the bot; the owner decides
  whether it goes to paper trading.

### Fib round 4 + the bot's RSI limiters (owner, 2026-10-03) — rule fixed before the runs

The winner (`fibx_4h_d50` + `r18_atr_mkt`) with the live bot's RSI limiters at their dashboard levels, chosen on the
4H pullback and not tuned here: `_obv` no long at weekly RSI >= 62 or daily >= 70; `_ssw55` no short while weekly
RSI >= 55; `_rsi` both. A limiter helps only if, on the research window, it raises avg R without raising max DD
versus +0.151R / 11.8% and keeps both periods positive. The 6 held-back months were already used once: their results
are information only. No change to the bot either way.

Results (runs 272-277), `r18_atr_mkt`; return / max DD / older 2y / newest year / trades / win / avg R:

| variant | research (36 months) | held-back 6 months (info only) |
|---|---|---|
| no limiter (round 4 winner) | +32.2% / 11.8% / +28.3R / +3.0R / 207 / 42.5% / +0.151R | +9.6% / 14.7% / 79 trades / +0.127R |
| `_obv` longs blocked at weekly 62 / daily 70 | +11.5% / 16.3% / +16.6R / -2.6R / 200 / 40.5% / +0.070R | +8.5% / 14.8% / 76 / +0.119R |
| `_ssw55` shorts blocked at weekly >= 55 | +32.3% / 11.8% / +26.0R / +5.1R / 201 / 42.8% / +0.155R | identical to no limiter (no short blocked) |
| `_rsi` both | +19.1% / 12.4% / +15.4R / +5.1R / 192 / 41.7% / +0.107R | +8.5% / 14.8% / 76 / +0.119R |

- The overbought long filter hurts this model: it removes only 7 trades directly, but they are among the best
  (a Fib pullback in a strong uptrend often comes with a high weekly RSI), and the knock-on through the portfolio caps
  and a breaker pause costs more (newest year turns negative, DD 11.8% -> 16.3%). Fails the rule.
- The short filter technically meets the rule (+0.155R vs +0.151R, same DD), but the gain is tiny and within noise
  (6 shorts removed); it changes nothing in the held-back months. Neutral: harmless to keep on, not a reason to.
- For a paper slot: overbought long filter OFF for this model; the short filter at 55 may stay as the owner prefers.

### Coin holdout and the "how far past 1.8R" sweep (owner, 2026-10-03) — rules fixed before the runs

Owner: the 6 held-back months should have been kept until the model was finished. They have been seen (round-4
out-of-sample check and the RSI runs) and are research data from now on. New unseen data, locked until the owner calls
the model final: (1) a coin holdout, `research/holdout-coins.json`, frozen today from the coins ranked past the top 60
by 24h volume that no Fib run has seen (research runs drop them; `--coins holdout` refuses to run without `--final`);
(2) forward paper trading from the day the model is frozen. Every tuning step uses only the research coins.

Sweep: `fibx_4h_d50` (1h) with half off at 1.8 / 2.0 / 2.2 / 2.5 / 3.0R, then the same 2.5 ATR 4H trail, plus the
MFE curve (how far each r18 trade went in its favour before the initial stop: % reaching 1.5-5R, older vs newest
year, gross value of an all-out target). Answer = the largest target whose gross value stays within 0.02R of the best
and whose portfolio run keeps both periods positive. A target above 1.8R is recommended only if its neighbours are
about as good (a plateau); otherwise 1.8R stays. Any change is confirmed on paper, not in another backtest.

Results (run 279, research coins only, `fibx_4h_d50` on 1h):

MFE before the initial stop (210 trades): % reaching the target overall / older 2y / newest year / gross R of an
all-out target: 1.5R 44.3 / 47.4 / 40.6 / +0.107; **1.8R 41.0 / 43.9 / 37.5 / +0.147 (best)**; 2.0R 37.6 / 42.1 /
32.3 / +0.129; 2.2R 35.2 / 39.5 / 30.2 / +0.128; 2.5R 31.0 / 36.8 / 24.0 / +0.083; 3.0R 25.2 / 32.5 / 16.7 / +0.010;
3.5R 22.9 / 30.7 / 13.5 / +0.029; 4.0R 19.0 / 26.3 / 10.4 / -0.048; 5.0R 15.2 / 21.9 / 7.3 / -0.086.

Portfolio, half at the target + 2.5 ATR 4H trail: return / max DD / older 2y / newest year / trades / win / avg R:
r18 +22.5% / 16.3% / +27.3R / -3.7R / 210 / 41.4% / +0.112R; r20 +17.7% / 18.9% / +25.2R / -5.6R / 207 / +0.095R;
r22 +13.2% / 18.2% / +23.0R / -7.1R / +0.077R; r25 +15.5% / 21.9% / +33.1R / -14.4R / +0.093R; r30 -4.4% / 33.5% /
+30.3R / -30.6R / -0.002R.

- Answer: 1.8R is the sweet spot. About 41% of trades reach 1.8R before the stop; each step higher loses ~3-4% of
  trades. 2.0-2.2R are nearly as good in the curve (within 0.02R) but worse in the portfolio; from 2.5R on, the hit
  rate falls faster than the payoff grows, and the newest year collapses (only 24% reach 2.5R, 17% reach 3R).
  1.8R stays.
- Warning: the same r18 model now reads +22.5% / 16.3% DD with the newest year at -3.7R (it was +32.2% / 11.8% /
  +3.0R this morning). The only change is the coin list: the top-60 ranking by live volume drifted (PUMP in; US, ENS,
  APT, PAXG, ALGO out) and two breaker pauses landed differently. The model's result is sensitive to which coins it
  trades, and the newest year is weak. This is a reason for caution, and for pinning the research coin list as a
  file so runs stay comparable.

Pinned-list rerun (run 280, `research/research-coins.json`): r18 reproduces exactly (+32.2% / 11.8% / 207 trades /
+0.151R). Targets on the pinned list: r20 +25.8% / 14.1% / newest year 0.0R; r22 +21.1% / 13.3% / -1.3R; r25 +21.9% /
18.4% / -10.1R; r30 +10.3% / 24.3% / -16.1R. MFE: 42% reach 1.8R before the stop (gross +0.177R, the best), 38.6%
2.0R (+0.159), 36.2% 2.2R (+0.159), 31.9% 2.5R, 26.1% 3R. Answer unchanged: 1.8R.

### Stacked S/R (owner, 2026-10-03) — rule fixed before the runs

Owner: the 1H level should sit in a deep 4H channel, itself inside a deep daily channel. Deep = built from >= 3
pivots (owner's pick). Step A `fibx_4h_d50_s4`: the Fib zone holds the daily channel (as now) and a 4H channel of >= 3
pivots. Step B `fibx_4h_d50_s41`: also the 1H sweep extreme sits in a 1H channel of >= 3 pivots (+-0.25 1H ATR).
Exit fixed at r18 (no exit tuning). A step helps only if it qualifies (avg R >= +0.08, both periods positive, DD <=
25%, >= 100 trades) and beats the current model (+0.151R) without a higher DD (11.8%); then it must beat >= 4 of 5
random-trigger controls on the same stacked setups. The 6 held-back months are spent; the final word is the coin
holdout, once the owner calls the model final.

Results (runs 281-282, pinned list, r18): return / max DD / older 2y / newest year / trades / win / avg R:
- current model (daily channel only): +32.2% / 11.8% / +28.3R / +3.0R / 207 / 42.5% / +0.151R
- `_s4` daily + 4H channel (>= 3 pivots): +1.2% / 12.6% / +10.4R / -8.4R / 59 / 40.7% / +0.034R
- `_s41` + 1H channel at the sweep: -0.9% / 6.3% / +2.9R / -3.4R / 25 / 36.0% / -0.020R

Neither qualifies (too few trades, avg R down, newest year negative), so no controls were run. Stacking deeper
channels does not pick better trades here: requiring a 4H channel removes 70% of the setups, and the ones removed
were on average the better ones. The daily channel alone stays the S/R filter.

### What separates winners from losers (owner, 2026-10-03) — reading rule fixed before the run

Every trade of the current model (`fibx_4h_d50` + r18, pinned list) described at its signal bar: side, leg size (4H
ATR), pullback depth before the trigger, 4H bars from arming to trigger, stop in 1H ATR and %, 4H channel (>= 3
pivots) in the zone, 1H channel at the sweep, daily channel pivots, room to the next opposing daily channel (R),
daily distance above EMA 50 and its slope (daily ATR), daily / weekly RSI, BTC's trend agreeing, 4H volatility vs
the coin's 90-day median, the displacement candle (1H ATR). Each split into buckets (terciles or yes/no), with
avg R in each period. With ~17 features on ~207 trades some will look strong by chance, so a feature becomes a
candidate filter only if it is CONSISTENT (same best bucket in the older two years and the newest year, every bucket
>= 30 trades), its best-to-worst gap is >= 0.15R, and it makes trading sense. At most 2 candidates are then tested
once as filters (beat +0.151R without a higher DD, beat >= 4 of 5 random filters). Final judge: the coin holdout.

Results (run 284, 207 trades, all matched). Avg R per bucket (older two years / newest year):
- **Stop size in % of price** (the standout): < 2.26%: 69 trades, 32% win, **-0.262R (-0.254 / -0.271)**;
  2.26-3.6%: +0.286R (+0.341 / +0.200); >= 3.6%: +0.428R (+0.666 / +0.184). The tight-stop third loses in both
  periods; the other two thirds earn ~+0.36R. 18 of the 20 worst trades had stops of 0.7-1.4%, closing at -1.11 to
  -1.20R (fees and slippage are a big share of a tight stop, and 1H noise reaches it). Stop in 1H ATR shows the same.
- Pullback depth before the trigger: < 0.685: +0.262R; 0.685-0.806: +0.186R; >= 0.806 (past 0.786): +0.009R (+0.187 /
  -0.333).
- 4H volatility vs the coin's norm: quiet third +0.023R, hot third +0.320R (mostly the same trades as wide stops).
- 4H channel in the zone: with 51 trades +0.127R, without 156 trades +0.159R: no difference (older +0.545 with it,
  newest -0.215 with it). 1H channel at the sweep: no difference either. That is why stacking hurt.
- No difference: long vs short, BTC agreeing, displacement size, daily distance from the EMA (the only one flagged
  CONSISTENT, gap 0.09R).
- By the rule fixed beforehand (same best bucket in both periods, gap >= 0.15R, buckets >= 30), no feature qualifies:
  stop size has the same WORST bucket in both periods, not the same best. It is the clear finding, with a mechanical
  reason (costs and noise on tight stops), but it was found after looking, so any filter on it can only be confirmed
  on the coin holdout or on paper.

### Fib from the 0.5 level (owner, 2026-10-03) — rule fixed before the run

Same model, allowed from the 0.5 retracement: armed while price is still beyond 0.5, the zone (and the daily-channel
check) is 0.5-0.786, then the 1H sweep + shift, market entry, stop under the sweep, r18 exit, pinned list
(`fibx_4h_d50_e50`). It replaces the 0.618 entry only if it qualifies (avg R >= +0.08, both periods positive, DD <=
25%, >= 100 trades), beats +0.151R without a higher DD than 11.8%, and beats >= 4 of 5 random-trigger controls.
Final word: the coin holdout.

Results (run 285, pinned list, r18): `fibx_4h_d50_e50` -2.5% / 26.2% DD / +10.8R / -8.5R / 291 trades / 36.8% win /
+0.008R. Fails (avg R, newest year, DD); no controls run. The 84 extra trades are the problem: trades that triggered
on a pullback of only 0.5-0.58 lose (-0.087R, -0.215R in the newest year), and 42% of trades reach 1.8R before the
stop at 0.618 vs 37% here. The "shallower is better" finding was about pullbacks that reached 0.618 and turned
quickly, not about entering earlier. Tight stops (< 2.24%) lose here too (-0.233R). The 0.618 entry stays.
