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

### Prism Adaptive RSI confluence (owner, 2026-10-03) — diagnosis first

Owner's RSI script "Prism Adaptive RSI [NeBlok]" (MPL-2.0) ported (`screen/prismrsi.ts`, Efficiency Ratio engine,
defaults). Owner's zones for longs (shorts mirrored, 100 - RSI): 0-38 optimal, 38-55 safe, 55-75 risky, 75-100
caution; values are a starting point to fine-tune. Step 1 (this run): every trade of the current model described by
its Prism RSI (fast, middle, slow lines) on weekly, daily, 4H and 1H, the zone of the middle line, the twist (fast
above slow, the trade's way), and a confluence score (optimal +2, safe +1, risky -1, caution -2, summed over the
timeframes, with and without 1H). Read as before: a line / timeframe / level counts only if its pattern holds in both
periods with >= 30 trades per bucket. Step 2, after the owner sees it: one confluence rule, tested once (beat
+0.151R without a higher DD, beat >= 4 of 5 random filters); final word on the coin holdout.

Results (run 286, 207 trades; values aligned to the trade, shorts as 100 - RSI; avg R overall (older / newest)):
- The owner's zones barely split the trades: at entry the Prism RSI sits between 38 and 75 almost always (weekly:
  147 safe / 58 risky / 2 optimal; daily 110 / 97; 4H 187 safe; 1H 167 / 40). Zone differences are small (daily safe
  +0.180R vs risky +0.118R) — the zones as set do not rank these trades.
- What does separate (CONSISTENT: same best bucket in both periods, >= 30 trades per bucket, gap >= 0.15R):
  - 1H middle line already strong the trade's way (>= 53.4): +0.349R (+0.375 / +0.318) vs < 49.4: -0.007R. Momentum on
    the trigger timeframe helps; it does not negate the trade.
  - Weekly twist the trade's way (fast above slow): 154 trades +0.245R (+0.313 / +0.162) vs 53 trades -0.124R (+0.057 /
    -0.342).
  - Daily twist against the trade (the daily is still pulling back): 67 trades +0.316R (+0.404 / +0.178) vs 140 trades
    +0.072R (+0.160 / -0.025).
  - Confluence score (owner's zones, all four timeframes) < 2 best: +0.346R (+0.493 / +0.170); 2-4 worst -0.088R. Lower
    score = more timeframes in the 55-75 "risky" band the trade's way = momentum aligned; the scoring as written runs
    the wrong way for this pullback model.
- ~40 RSI features were looked at, so some of these will be chance. Next step (owner's call): test at most two once as
  filters (beat +0.151R without a higher DD, beat >= 4 of 5 random filters), final word on the coin holdout.

### RSI framework map (owner, 2026-10-03) — model-free, per timeframe

Owner: build the RSI framework on its own first, with ideal long and short RSI per timeframe (weekly, daily, 4H, 1H),
before applying it to any model. Every closed bar of every pinned research coin over the 36-month research window: its
Prism RSI (middle and fast lines), the move h bars later in ATRs (weekly 4, daily 10, 4H 12, 1H 24), and whether
price touched +1 ATR or -1 ATR first. Per RSI bin: the long edge = (up-first % - down-first %) minus the timeframe's
base rate, so market drift is taken out; a negative long edge is a short edge. A bin reads LONG / SHORT when its edge
is 3+ points with the same sign in the older two years and the newest year. Neighbouring bars share their future, so
counts overstate the real sample.

Results (run 287; long edge vs the timeframe's base rate, percentage points, older / newest; negative = short edge):
- Weekly (middle line, 4 weeks ahead): 25-32 +11.9 (+8.2 / +24.8); 32-38 +8.6; 38-45 +4.6; 45-50 +3.0 — LONG.
  50-55 -1.5; 55-62 -5.5 (-4.6 / -8.7); 62-68 -21.5 (-21.9 / -23.2) — SHORT. 68+ too few weeks to read. The weekly is
  mean-reverting: low weekly RSI favours longs, 55-68 favours shorts. Fast line the same (< 45 long, 62-82 short).
- Daily (10 days ahead): 0-38 LONG (25-32 +15.5, both periods); 38-55 flat to slightly short (50-55 -3.1); 68-100
  LONG (68-75 +8.8 / +9.2 / +9.8; 75-82 +11.1). High daily RSI keeps going up: momentum, not a short.
- 4H (2 days ahead): < 25 +29.5 (both periods) and 25-32 +9.5 LONG; 38-45 -3.4 SHORT; 55-82 LONG (68-75 +10.6).
- 1H (1 day ahead): < 25 +8.7 LONG; 38-62 flat; 62-100 LONG (82-100 +15.7). Momentum.
- Fast vs slow line (twist): small on every timeframe (daily twist up +3.5 / down -2.5).
- Read: the owner's zones fit the weekly (low = long, 55-68 = short). On daily, 4H and 1H a high RSI is strength that
  carries on, not a reason to short; a very low RSI is a bounce. Pooled over all 56 coins and all bars, trend not
  separated; the weekly has only ~5,200 coin-weeks, so its edges are the least certain.

### Weekly x daily RSI map (run 288, 41,061 coin-days; long edge vs the daily base rate, pts [older / newest] (samples))

| weekly \ daily | 0-32 | 32-38 | 38-55 | 55-68 | 68-75 | 75-100 |
|---|---|---|---|---|---|---|
| 0-38 | +9.1 [+14/-1] (296) | **L +12.0 [+13/+10] (812)** | +1.1 (2,046) | (86) | (0) | (0) |
| 38-50 | **L +25.3 [+26/+24] (170)** | +4.4 [+16/-4] (2,075) | -0.4 (17,029) | +1.3 [+8/-9] (1,561) | (48) | (7) |
| 50-55 | (2) | (91) | -4.1 [-7/+2] (5,604) | **L +11.4 [+16/+5] (1,461)** | (122) | (17) |
| 55-62 | (0) | (14) | **S -4.5 [-5/-1] (2,982)** | +1.1 (1,830) | **L +17.8 [+24/+2] (252)** | (85) |
| 62-68 | (0) | (5) | -3.1 [-9/+28] (804) | **S -8.0 [-7/-9] (933)** | +5.3 [+8/-17] (185) | (83) |
| 68-100 | (0) | (22) | **S -5.7 [-3/-21] (287)** | -6.5 [-12/+17] (1,450) | +3.4 (371) | **L +12.0 [+7/+31] (331)** |

- Longs: a daily dip (RSI < 38) while the weekly is not stretched (< 50) is the best long (weekly 38-50 & daily 0-32:
  +25.3, both periods). A hot daily works as a long only with the weekly also rising (weekly 55-62 & daily 68-75;
  weekly 68+ & daily 75+): momentum still running.
- Shorts: a stretched weekly (55+) while the daily has cooled to 38-68 (weekly 62-68 & daily 55-68: -8.0, both
  periods). A high weekly with a high daily is not a short; a high weekly with a fading daily is.
- Short edges are smaller than long edges (-4 to -8 vs +11 to +25). Pooled over all coins and both trends.

### Weekly signals from the owner's charts (run 289) — Prism flips, exhaustion flips, RSI 14 divergences

Bitunix daily history starts around mid-2022 for most coins, so the "7 years" are in practice ~3.5 years (the older
half holds almost no signals; the per-period split is not usable). Move = % change after the signal week in the
signal's direction; (vs an average week); right = share that moved the right way. Weekly base: +1.9% / +4.7% / +8.3%.

| signal | n | 4 weeks | 8 weeks | 13 weeks |
|---|---|---|---|---|
| Prism flip, buy | 148 | +13.1% (+11.3), 53% | +18.3% (+13.6), 53% | +15.5% (+7.2), 47% |
| Prism flip, sell | 112 | +1.7% (+3.6), 60% | -7.5% (-2.7), 65% | -11.8% (-3.6), 71% |
| Exhaustion (diamond), sell | 35 | +5.2% (+7.1), 62% | +3.3% (+8.0), 65% | +17.3% (+25.6), 75% |
| Exhaustion, buy | 6 | too few | | |
| RSI 14 divergence, buy | 46 | -1.2% (-3.1), 47% | -0.7% (-5.4), 35% | -9.2% (-17.5), 33% |
| RSI 14 divergence, sell | 24 | +9.1% (+11.0), 79% | +11.7% (+16.5), 74% | +5.6% (+13.8), 67% |
| Flip + divergence, buy | 12 | +4.6%, 58% | +3.6%, 58% | -23.2%, 17% |
| Flip + divergence, sell | 11 | +1.4%, 60% | -4.7%, 60% | -5.8%, 67% |

- Buy flips: right only about half the time but the winners are large (avg +18% after 8 weeks vs +5% for any week).
- Sell flips: right 60-71% of the time but the average is negative: a few big pumps outweigh the many small wins,
  so a weekly sell flip needs a stop, or the diamond / divergence version.
- Best sells: exhaustion flips (diamonds; right 75% at 13 weeks, +26 pts over an average week) and bearish RSI 14
  divergences (right 74-79%).
- Bullish RSI 14 divergences alone did worse than an average week (catching a falling coin).
- Weekly RSI 14 levels: < 32 favours longs (0-25 +11.1 pts, 25-32 +5.9); 50+ favours shorts, 82+ strongly (-29.0, 58
  weeks).
- ETH / LINK: the generated signals line up with most of the owner's marked lines (ETH buys Sep-Oct 2023 and May 2025,
  sells Apr 2024, Jan 2025, Oct 2025; LINK sells Mar 2024, Jan 2025, Oct 2025).

### Daily signals from the owner's charts (run 37142406616) — same signals as the weekly study, on the daily
Daily bars, 56 pinned coins, data to 2026-04-04 (in practice mid-2022 onward). Horizons 5 / 10 / 20 days. New
"div-anchor": RSI 14 divergence against any earlier extreme (>= 65 / <= 35) within 120 bars, for the owner's long
diagonals. Daily base: +0.1% / +0.2% / +0.8%.

| signal | n | 5 days | 10 days | 20 days |
|---|---|---|---|---|
| Prism flip, buy | 1466 | -0.3% (-0.4), 45% | +0.4% (+0.2), 47% | +1.6% (+0.9), 45% |
| Prism flip, sell | 742 | +0.6% (+0.6), 58% | +1.4% (+1.5), 58% | +2.2% (+3.0), 64% |
| Exhaustion, buy | 39 | -5.0% (-5.1), 16% | -10.2% (-10.4), 11% | -12.2% (-13.0), 13% |
| Exhaustion, sell | 117 | -2.5% (-2.5), 48% | -2.2% (-2.0), 53% | -6.2% (-5.4), 43% |
| RSI 14 divergence, buy | 427 | -0.6%, 44% | -1.6%, 39% | +0.9%, 42% |
| RSI 14 divergence, sell | 276 | +0.3%, 61% | -0.9%, 58% | -0.0%, 64% |
| Anchored divergence, buy | 1787 | -0.6%, 45% | -1.6%, 43% | -0.4%, 41% |
| Anchored divergence, sell | 1082 | +1.6%, 60% | +0.3%, 60% | +0.9%, 62% |
| Flip + divergence, buy | 681 | -0.1%, 48% | +0.1%, 49% | +1.7%, 44% |
| Flip + divergence, sell | 328 | +0.2%, 56% | -0.7%, 51% | -0.4%, 62% |

- On their own, daily signals carry almost no edge: they fire far too often (a flip every ~2 weeks per coin) and
  average within ~1-3% of a normal day. Sell-side signals are right 58-64% of the time, but the averages are small.
- Daily exhaustion flips are traps both ways (buys right 11-16%; sells lose too): on the daily, extremes keep running.
- Daily RSI 14 levels (5 bars, +-1 ATR first touch): 0-25 +17.0 pts LONG in both periods, 25-32 +7.7 LONG; 75+ is
  momentum (LONG +7), not a short. Same picture as the Prism daily map.
- Reading: the daily is a timing layer, not a signal on its own; the weekly decides the side (next step: daily
  signals filtered by the weekly context).

### RSI floor and stretch-top (owner's ETH daily chart; run 37144433734, daily, 56 coins, data to 2026-10-03)
Rules fixed before the run. Floor = lowest daily RSI 14 on all earlier bars (250-bar warm-up, no look-ahead).
'floor' = first close back within floor..floor+5; 'under-floor' = first close under the floor. Stretch = RSI pivot
high >= 70, >= 5 pts over the previous RSI pivot high (<= 60 bars back) with price <= +3%; 'stretch-top' = the next
bearish divergence within 120 bars. Older / newer split at 2024-10-03.

| signal | n | 5 days | 10 days | 20 days | 10d older / newer |
|---|---|---|---|---|---|
| floor, buy | 188 | +1.6% (+1.1), 61% | +2.4% (+1.3), 64% | +4.2% (+1.8), 52% | +4.0% / +1.7% |
| under-floor, buy | 9 | +3.6%, 78% | +5.3%, 78% | +8.5%, 56% | too few |
| stretch-top, sell | 3 | too few | | | |

- Floor buys are the best daily buy signal so far: right 61-64% at 5-10 days and positive in both periods, the only
  daily buy that beats an average day consistently. Edge is modest (+1-2 pts over an average day).
- ETH's floor comes out at 19.4 (owner's line 18.94). ETH floor touches: Aug 2023 -3%, Aug 2024 +14% (20d),
  Feb 2026 -13%, Jun 2026 -7%. LINK (floor 20.0): Jun 2023 +27%, Apr 2024 +6%, Aug 2024 +28%, Jan 2026 -10%.
  The two misses were the 2026 bear leg, where RSI went under the floor (a new floor was set).
- Stretch-top as defined fired 3 times: too strict to judge. The owner's ETH example (RSI ~86 in May 2025 with price
  far under its prior highs; the Aug 2025 bearish divergence marked the top) is not a "previous pivot" stretch; the
  definition needs the owner's input (compare against the cycle's price high, not the last pivot).
- Daily RSI 14 levels with data to today: 0-25 +12.7 pts and 25-32 +6.8 LONG (both periods); 38-45 -4.3 SHORT.

### Top divergence (owner: "85 RSI divergence to 79-80"; run 37145132565, daily, 56 coins, to 2026-10-03)
Rule fixed before the run: bearish divergence, earlier daily RSI 14 pivot >= 82, new pivot >= 75 and lower, at a
higher price high, 5-120 bars apart ('top-div'). Looser band 70 / 60 ('high-div', not already a top-div) to see what
the strict levels block. Daily horizons now include 40 days (base +5.8%).

| signal | n | 5 days | 10 days | 20 days | 40 days |
|---|---|---|---|---|---|
| top-div (82 / 75), sell | 82 | +3.2% (+3.7), 66% | -2.6% (-1.5), 51% | -6.7% (-4.4), 51% | -9.4% (-3.6), 59% |
| high-div (70 / 60), sell | 547 | -0.3% (+0.3), 58% | -2.2% (-1.1), 58% | -4.4% (-2.0), 61% | -0.7% (+5.1), 62% |
| RSI 14 divergence, sell | 348 | +0.3%, 62% | -2.5%, 56% | -5.3%, 62% | -14.5% (-8.7), 63% |
| floor, buy | 188 | +1.6%, 61% | +2.4%, 64% | +4.2%, 52% | +5.8% (0.0), 49% |

- Top-div is a short-term pullback signal, not a top: right 66% over 5 days (+3.7 pts), then price usually runs on;
  the losers are big pumps (avg -9% at 40 days). Same in both periods.
- The looser band (70 / 60) is the better sell at 40 days (+5.1 pts vs an average 40 days, 62% right): strict
  levels did block the better trades, as the owner suspected.
- ETH: top-div fired Feb 18 / 23 2024 (wrong; ETH ran to the March 2024 high) and Aug 16 2025 (+4% at 5 days, +12%
  at 40 days: the real top). LINK: Sep 9 2026 (-22% at 20 days, against the trade).
- Floor buys pay over 5-20 days only; at 40 days they match an average period (a bounce, not a bottom call).

### 4H RSI 30-35 support (owner's ETH 4H chart, Jun-Aug 2026; runs 37146493716 + 37146586088, 56 coins, 36 months)
Rules fixed before each run. 4H horizons 6 / 12 / 30 / 60 bars (1 / 2 / 5 / 10 days); base +0.2 / +0.3 / +0.8 / +1.6%.
First run (from the owner's words): support-lost = close under 30 (short); held-div = RSI lower low under 30 while
price holds; reclaim-div = price lower low, RSI low back >= 30 after one under 30; reclaim = close over 35 within 20
bars of a close under 30; sequence = reclaim-div within 60 bars of a held-div. Second run (from the screenshot):
db-div = price low within 1.5% of an earlier pivot low (10-150 bars back, RSI under 30 there), RSI >= 3 pts higher;
support-hold = RSI pivot low 30-40, above the previous one, at a higher price low, after a close under 30 in the last
360 bars.

| signal | n | 1 day | 2 days | 5 days | 10 days |
|---|---|---|---|---|---|
| support-lost, sell | 3033 | 0.0% (+0.2), 46% | -0.5% (-0.2), 46% | -0.8% (0.0), 50% | -1.5% (+0.1), 50% |
| held-div, buy | 37 | +0.1%, 57% | -1.7%, 35% | -3.2%, 30% | -4.4% (-6.0), 27% |
| reclaim-div, buy | 454 | +0.3%, 50% | +0.2%, 48% | +0.6%, 47% | +0.2% (-1.4), 46% |
| reclaim, buy | 3251 | +0.1%, 51% | +0.6% (+0.3), 52% | +1.2% (+0.4), 49% | +1.4%, 49% |
| sequence, buy | 12 | too few | | | |
| db-div, buy | 3316 | -0.5%, 46% | -0.4%, 46% | -0.6%, 45% | -1.0% (-2.6), 45% |
| support-hold, buy | 1463 | 0.0%, 50% | +0.2%, 49% | +0.4%, 49% | +0.1% (-1.5), 47% |
| 4H floor, buy | 324 | +3.0% (+2.8), 65% | +4.0% (+3.7), 66% | +3.0% (+2.2), 60% | +7.1% (+5.5), 66% |
| 4H under-floor, buy | 40 | +4.4%, 63% | +7.0%, 63% | +7.0%, 68% | +15.0% (+13.4), 83% |

- None of the 30-35 support rules has an edge pooled across coins; they fire constantly (thousands of times) and
  average out to a normal 4H bar. 4H RSI 32-38 itself leans slightly down (-3.3 pts); high 4H RSI is momentum (75+
  +11 to +15 pts long).
- ETH Jun-Aug 2026: db-div / support-hold fired Jun 26 04:00 (+12% at 10 days), Jun 29 and Jul 1 (+11-13%); the
  Aug 2026 breakout had no RSI low in 30-40 near Aug 17 (last support-hold Aug 3, +1%). The owner's picture is right
  on ETH here, but the same shapes fail as often as they work elsewhere.
- The per-coin RSI floor is the strongest buy found on any timeframe: on the 4H, right 65-66% with +3 to +5.5 pts
  over an average bar, in both periods; under the floor (40 cases) +15% after 10 days, 83% right. ETH's own 4H floor
  is very low (6.1, set in 2024), so it rarely fires on ETH.

### Divergences over months (owner: "major divergence plays out over a few months"; runs 37146994670 daily, 37146996520 weekly; to 2026-10-03)
Same signals, longer horizons: daily 20 / 40 / 60 / 90 days (base +2.4 / +5.8 / +9.4 / +14.0%), weekly 4 / 8 / 13 / 26
weeks (base +3.2 / +7.6 / +12.5 / +16.9%). "Best for / against" = average biggest move with / against the signal
inside the longest horizon. Averages carry big pumps (base drift is large), so "right %" matters as much as the mean.

Weekly (sells; move in the short's direction, pts vs an average period):
| signal | n | 4 weeks | 8 weeks | 13 weeks | 26 weeks | best for / against (26w) |
|---|---|---|---|---|---|---|
| top-div (RSI >= 82 then >= 75) | 13 | +8.7%, 69% | +16.2% (+23.8), 92% | +26.3% (+38.8), 85% | +20.5% (+37.4), 77% | 43% / 19% |
| high-div (>= 70 then >= 60) | 44 | +4.2%, 73% | +6.0%, 68% | +13.3% (+25.7), 75% | +20.7% (+37.6), 72% | 50% / 35% |
| RSI 14 divergence | 24 | +9.1%, 79% | +11.5%, 75% | +5.8% (+18.3), 67% | +7.3% (+24.2), 63% | 42% / 34% |
| exhaustion (diamond) | 40 | +8.2%, 67% | +5.4%, 66% | +17.3% (+29.8), 75% | +12.8% (+29.7), 72% | 48% / 44% |
Weekly buys: bullish RSI divergence 26w 26% right (-38 pts); buy flips strong at 4-8 weeks (+6 / +5 pts) but fade by 26.

Daily (90 days): high-div sell right 65% (+12.8 pts) but avg -1.2% (squeezes average 51% against); top-div 55% (+6.1);
regular bearish divergence 63% (+11.1). Daily buys: reclaim-div (RSI low back >= 30 after one under 30, price lower
low) 103 cases, +23.9% at 90 days (+9.9 pts), 55-59% right, both periods; db-div +10.8 pts at 60-90 days but 42-53% right.
Floor buys fade after 20 days (a bounce).

- The owner's top divergence works on the WEEKLY over months: 13 cases, right 85-92% at 2-3 months, the average best
  drop 43% vs a 19% squeeze first. On the daily the same shape is a coin flip with large squeezes.
- ETH Aug 16 2025 daily top-div: +12% / +10% / +30% at 40 / 60 / 90 days (the real top paid over months). ETH Feb 2024:
  wrong at every horizon. LINK Nov 2024 daily high-divs: wrong (LINK doubled into Dec).

### Bottom divergence (owner: "divergences from 19 then 25-27 later"; runs 37147125570 weekly, 37147127162 daily, 37147129036 4H)
Rule fixed before the runs: earlier RSI 14 pivot low <= 20, new pivot low higher but <= 30, price low at or under the
earlier low (+1% tolerance), 5-120 bars apart ('bottom-div'); looser 30 / 40 band ('low-div', not already a bottom-div).

| timeframe | signal | n | horizons | move (pts vs avg), right | best for / against |
|---|---|---|---|---|---|
| daily | bottom-div | 43 | 20 / 40 / 60 / 90 d | +0.6% 49%, +7.0% 51%, +22.4% (+13.1) 70%, +36.7% (+22.7) 85% | 91% / 16% |
| daily | low-div (30/40) | 960 | same | +2.3%, +5.7%, +9.3%, +16.2% (+2.2) 48% | 68% / 27% |
| weekly | bottom-div | 4 | 4-26 w | too few | |
| weekly | low-div | 72 | 4 / 8 / 13 / 26 w | +4.2%, +14.3%, +2.4%, +23.7% (+6.8) 53% | 110% / 40% |
| 4H | bottom-div | 405 | 5 / 10 / 20 / 40 d | +0.5%, +1.9% 60%, -0.4%, +1.0% (-6.6) 39% | 36% / 23% |

- The daily bottom divergence is the strongest buy found so far, and it plays out over months as the owner said:
  flat for the first month, then right 70% at 60 days and 85% at 90 days, +23 pts over an average 90 days, with a
  16% average dip first vs a 91% average best gain. Both periods (+42.9% older, 8 cases / +35.2% newer, 33 cases).
- The extremes matter for bottoms: the looser 30 / 40 band has no edge (unlike tops, where 70 / 60 was fine). On the
  4H the same shape has no edge; on the weekly it is too rare.
- ETH: Sep 14 2023 (+26% at 60 days, +39% at 90 days). LINK: Jun 8 2026 (+65% at 90 days).

### Decision (owner, 2026-10-03): RSI 14 is the framework's RSI; Prism kept only where it earned it
Owner: drop Prism if standard RSI tests better. What Prism added, from the runs above:
- Weekly exhaustion flip (diamond), sell: right 75% at 13 weeks, +30 pts over an average period (40 cases) — no
  RSI 14 equivalent tested better except the rarer weekly top divergence. Kept.
- Weekly buy flip: +5 to +6 pts at 4-8 weeks (214 cases), fades by 26 weeks. Kept as a short-hold weekly signal.
- Everything else Prism (daily / 4H flips, diamonds, Prism zone maps, the Fib-model RSI filters): no edge, or no
  better than RSI 14 levels. Dropped.
Framework from here on: RSI 14 levels, divergences (top / bottom), and the per-coin RSI floor; Prism only for the
two weekly signals above. Research code keeps prismrsi.ts for those; the bot uses neither.

### RSI framework signals as trades (owner: "run them as trades and drop the buy flip"; run 37147470330)
Weekly buy flip dropped (owner, 2026-10-03: right 48-49%, older +50% / newer -37% at 26 weeks — not stable).
Rules fixed before the run: entry next bar open; stop beyond the 10-bar swing +/- 0.5 ATR (gap fills at the open);
exits hold (time cap 13 weeks / 60 days, with the stop), 3R target, or trail 3 ATR after +1R; 0.22% round-trip
costs; one open trade per coin per signal. 56 pinned coins, 2019-10 to 2026-10 (data mostly from mid-2022).

| signal | exit | n | win % | avg R | median R | PF | total R | max DD R | avg stop | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|---|
| W diamond, short | all three | 30 | 73% | 0.31 | 0.37 | 2.71 | 9.2 | 2.0 | 58.7% | 0.30 / 0.32 |
| W top divergence 82/75, short | all three | 13 | 77% | 0.50 | 0.85 | 3.93 | 6.4 | 1.1 | 34.2% | 0.27 / 0.64 |
| W high divergence 70/60, short | hold | 39 | 72% | 0.57 | 0.56 | 3.24 | 22.3 | 5.3 | 33.8% | 0.93 / 0.49 |
| W RSI 14 bearish divergence, short | 3R | 24 | 67% | 0.36 | 0.51 | 2.43 | 8.7 | 2.4 | 29.0% | 0.53 / 0.22 |
| D bottom divergence 20/30, long | hold | 38 | 55% | 1.37 | 0.48 | 4.82 | 52.0 | 6.7 | 14.5% | 2.52 / 1.06 |
| D bottom divergence 20/30, long | 3R | 38 | 63% | 1.17 | 1.41 | 5.22 | 44.6 | 4.1 | 14.5% | 2.29 / 0.87 |

- All five are profitable as trades, in both periods, after costs.
- The weekly shorts need very wide stops (29-59% of price): R is small (0.3-0.6) and 3R / trail almost never trigger,
  so the three exits are the same. At 1% risk a trade is only 2-3% of the account in size: they work as low-leverage
  position trades, not leveraged ones. The weekly 70/60 divergence carries the most total (22 R over 39 trades).
- The daily bottom divergence is the best trade: stop 14.5%, PF 4.8-5.2, +1.2 to +1.4 R per trade, max drawdown 4-7 R.
- Caveats: few trades (13-39 per signal); shorts cluster at market tops (many coins at once, correlated); the rules
  were set after looking at this same data, so the 54-coin holdout is the real test (locked until the owner calls
  the framework final).

### Decision (owner, 2026-10-03): the weekly diamond is dropped
Prism is no longer part of the RSI framework (buy flip and diamond both dropped). Framework signals: weekly top
divergence 82/75 and 70/60 (short), weekly RSI 14 bearish divergence (short), daily bottom divergence 20/30 (long),
per-coin RSI floor (short-term bounce), RSI 14 levels. prismrsi.ts stays in the research code only (not used by the
framework or the bot).

### Weekly shorts with a daily stop (owner: "test a tighter daily stop"; run 37147781104)
Rules fixed before the run (rsitrades.ts weeklyDailyStopReport): signal known at the weekly close. 'Daily swing' =
enter next daily open, stop over the 10-day high + 0.5 daily ATR. 'Daily breakdown' = within 20 days wait for a daily
close under the prior 5-day low, enter next open, stop over the high since the signal + 0.5 ATR. 91-day cap, exits
hold / 3R / trail (3 daily ATR after +1R), 0.22% costs. Compared with the weekly-swing-stop run (37147470330).

| signal | stop | best exit | n | win % | avg R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|---|
| top div 82/75 | weekly swing | hold | 13 | 77% | 0.50 | 3.93 | 6.4 | 1.1 | 34.2% | 0.27 / 0.64 |
| top div 82/75 | daily swing | 3R | 13 | 54% | 0.77 | 2.56 | 10.1 | 3.1 | 10.0% | 1.41 / 0.37 (hold / trail lose) |
| top div 82/75 | daily breakdown | hold / 3R | 11 | 64% | 0.61 | 2.66 | 6.8 | 2.0 | 22.8% | 0.60 / 0.62 |
| high div 70/60 | weekly swing | hold | 39 | 72% | 0.57 | 3.24 | 22.3 | 5.3 | 33.8% | 0.93 / 0.49 |
| high div 70/60 | daily swing | hold | 44 | 39% | 0.80 | 2.27 | 35.2 | 9.6 | 12.2% | 0.88 / 0.78 (median -1.0 R) |
| high div 70/60 | daily breakdown | 3R | 41 | 54% | 0.55 | 2.18 | 22.7 | 6.1 | 20.0% | 0.55 / 0.56 |
| RSI 14 bearish div | weekly swing | 3R | 24 | 67% | 0.36 | 2.43 | 8.7 | 2.4 | 29.0% | 0.53 / 0.22 |
| RSI 14 bearish div | daily swing | 3R | 24 | 63% | 1.03 | 3.62 | 24.7 | 3.1 | 10.9% | 1.01 / 1.05 |

- The tighter daily stop clearly helps the regular weekly bearish divergence: daily swing stop + 3R target almost
  triples R per trade (0.36 -> 1.03 R), PF 3.6, same in both periods, stop 11% instead of 29%.
- Top divergence: the daily breakdown entry keeps the result (0.61 R, both periods) with a 23% stop instead of 34%;
  the plain daily swing stop gets shaken out (hold / trail lose in the newer period).
- 70/60 divergence: the daily swing stop makes the most R (35 R) but wins only 39% with a 9.6 R drawdown; the daily
  breakdown + 3R is steadier (54% wins, both periods 0.55 R). The weekly stop remains the smoothest (72% wins).
- R is what sizing uses: at the same 1% risk a 10-12% stop allows about 3x the position of a 30-34% stop.

### Long side as trades (owner: "yes run those as trades"; run 37148682520)
Same trade rules as the shorts (entry next open, 10-bar swing stop -/+ 0.5 ATR, 0.22% costs, hold / 3R / trail).
Rules fixed before the run: 4H floor / under-floor (cap 10 days), daily floor (cap 20 days), daily reclaim divergence
(cap 90 days), daily momentum = first daily RSI 14 close over 75 while the last completed weekly RSI 14 < 62 (cap 30 days).

| signal | best exit | n | win % | avg R | median R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|---|
| D bottom divergence 20/30 (reference) | 3R | 38 | 63% | 1.17 | 1.41 | 5.22 | 44.6 | 4.1 | 14.5% | 2.29 / 0.87 |
| D momentum RSI > 75, weekly < 62 | hold | 191 | 56% | 0.62 | 0.20 | 3.46 | 118.4 | 17.4 | 32.1% | 0.53 / 0.66 |
| 4H under-floor | hold | 51 | 45% | 0.95 | -0.03 | 2.89 | 48.6 | 12.2 | 15.5% | 0.95 / 0.96 |
| D reclaim divergence | hold | 96 | 25% | 1.19 | -1.01 | 2.58 | 114.0 | 26.5 | 13.1% | 2.39 / 0.76 |
| 4H floor | hold | 380 | 28% | 0.12 | -1.04 | 1.15 | 43.9 | 55.4 | 8.6% | 0.11 / 0.12 |
| D floor | any | 192 | 31% | 0.00 | -1.02 | 1.00 | -0.6 | 54.6 | 13.9% | 0.39 / -0.18 |

- Tradable longs: the daily bottom divergence (best per trade), the momentum long (most trades and total R, both
  periods, but a wide 32% swing stop), the 4H under-floor (both periods ~0.95 R, few trades).
- The daily reclaim divergence pays but like a lottery: 25% wins, a 26 R drawdown, and much weaker in the newer
  period. The 4H and daily floor bounces are real in price but not as trades: the swing stop is hit first most of
  the time (28-31% wins, 55 R drawdowns). Dropped as trades.
- Momentum and floor signals cluster (many coins at once), so their drawdowns are correlated.

### Triple divergence (owner's SUI daily example, Jun-Sep 2026; runs 37149371192 study, 37149373068 trades)
SUI check first (existing detectors): Jun 8 strict bottom-div -10% (too early); Jul 30 double-bottom / 30-40
divergence +68% at 60 days; Aug 10 regular divergence +25% at 40 days; Aug 19 Prism buy flip +65% at 40 days;
Sep 18 double-bottom divergence +43% in 10 days (owner's Sep 15 line).
Rule fixed before the run ('triple-div'): three daily RSI 14 pivot lows within 120 bars, each higher than the one
before, the first <= 30; the 2nd and 3rd price lows within 3% of (or under) the first price low.

| | n | 10 d | 20 d | 40 d | 60 d | best for / against (60 d) |
|---|---|---|---|---|---|---|
| triple-div (study) | 437 | +1.5%, 50% | +4.2%, 50% | +10.1% (+4.3), 55% | +20.4% (+11.0), 57% | 58% / 21% |
| bottom-div (study) | 43 | +1.9%, 56% | +0.6%, 49% | +7.0%, 51% | +22.4% (+13.1), 70% | 54% / 14% |

As trades (10-bar swing stop, 60-day cap): hold 308 trades, 24% wins, +0.69 R, PF 1.92, total 212 R, max drawdown
86 R, older 1.34 / newer 0.31 R. 3R and trail exits ~flat.
- The triple divergence has a real 2-month edge (+11 pts, both periods) and caught SUI (Jul 30, +68%), but the
  10-bar swing stop is hit before it plays out three times in four: as traded here it is a lottery with an 86 R
  drawdown. Not adopted. A stop under the pattern's own low (the first price low) fits this setup better; untested.

### Pattern-low stop (owner: "test it with the stop under the pattern low"; run 37149804801)
Rule fixed before the run: stop under the lowest low from the pattern's first pivot to the signal bar, - 0.5 ATR;
entry next open; caps 60 and 90 days; same costs and exits.

| signal | exit | n | win % | avg R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|
| triple div, 10-bar swing stop (before) | hold 60d | 308 | 24% | 0.69 | 1.92 | 211.7 | 85.6 | 12.1% | 1.34 / 0.31 |
| triple div, pattern-low stop | hold 60d | 283 | 36% | 0.74 | 2.32 | 208.4 | 66.6 | 19.0% | 1.43 / 0.34 |
| triple div, pattern-low stop | hold 90d | 261 | 35% | 1.21 | 2.99 | 315.2 | 67.3 | 19.5% | 3.18 / -0.04 |
| bottom div, pattern-low stop | hold 90d | 38 | 63% | 2.22 | 7.14 | 84.3 | 8.4 | 14.5% | 2.51 / 2.14 |
| bottom div, pattern-low stop | 3R 90d | 38 | 76% | 1.38 | 6.68 | 52.4 | 4.0 | 14.5% | 2.27 / 1.14 |

- Triple divergence: the pattern-low stop lifts wins from 24% to 35-36% and cuts the drawdown (86 -> 67 R), but the
  edge is all in the older period: since Oct 2024 it is ~0 R per trade (90-day hold -0.04 R). Not adopted.
- Bottom divergence: its pattern low is the same as the 10-bar swing low (the second low is the lower one), so the
  stop does not change; the longer 90-day hold does: +2.22 R per trade, PF 7.1, both periods ~2.1-2.5 R; with a 3R
  target 76% wins and a 4 R max drawdown. Best trade in the framework.

### Momentum long with a tighter daily stop (owner; run 37150055054)
Rules fixed before the run: same signal (first daily RSI 14 close > 75 while the last completed weekly RSI 14 < 62),
30-day cap, 0.22% costs. Stops: 10-bar swing low - 0.5 ATR (before), entry - 2 daily ATR, or the 3-day low - 0.5 ATR.

| stop | exit | n | win % | avg R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|
| 10-bar swing (before) | hold | 191 | 56% | 0.62 | 3.46 | 118.4 | 17.4 | 32.1% | 0.53 / 0.66 |
| 3-day low | hold | 194 | 54% | 0.86 | 3.47 | 166.5 | 19.9 | 23.8% | 0.78 / 0.90 |
| 3-day low | trail | 196 | 55% | 0.69 | 3.12 | 136.1 | 17.1 | 23.7% | 0.45 / 0.81 |
| 2 ATR | hold | 208 | 35% | 1.15 | 2.77 | 239.9 | 27.4 | 12.1% | 0.81 / 1.32 |
| 2 ATR | trail | 209 | 36% | 0.99 | 2.68 | 207.7 | 25.0 | 12.1% | 0.40 / 1.29 |
| 2 ATR | 3R | 219 | 37% | 0.29 | 1.46 | 62.7 | 19.5 | 12.2% | 0.32 / 0.27 |

- Both tighter stops improve R per trade in both periods. The 3-day low keeps the win rate (54%) and profit factor
  (3.5) with R per trade up 0.62 -> 0.86 and the stop down 32% -> 24%. The 2 ATR stop (12%) roughly doubles R per
  trade (1.15) and allows ~2.7x the size, at 35% wins and a deeper 27 R drawdown.
- A 3R target hurts the momentum long (winners run): hold or trail it.

### Decision (owner, 2026-10-03): stops
- Momentum long: the 3-day low stop (3-day low - 0.5 ATR), hold or trail, 30-day cap.
- Divergence longs: stop under the pattern's wick low ("those areas aren't expected to be invalidated"). The daily
  bottom divergence already uses it (its pattern low is the swing low; stop = wick low - 0.5 ATR). The triple
  divergence with this stop stays out of the framework for now (no edge since Oct 2024).

### MACD trigger (owner: "yes run the macd trigger tests"; run 37150727799)
Rules fixed before the run (rsitrades.ts macdTriggerReport), MACD 12/26/9 on daily closes:
longs = after the divergence wait up to 30 days for the histogram to cross above 0 (cancelled by a daily close under
the pattern wick low first), enter next open, stop under the wick low - 0.5 ATR, 90-day cap; weekly shorts = after the
weekly close wait up to 20 days for the histogram to cross below 0, enter next open, stop over the high since the
signal week + 0.5 ATR, 91-day cap.

| signal / entry | exit | n | win % | avg R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|
| bottom div, next open (now) | hold | 38 | 63% | 2.22 | 7.14 | 84.3 | 8.4 | 14.5% | 2.51 / 2.14 |
| bottom div, MACD trigger | hold | 20 | 60% | 1.87 | 5.95 | 37.4 | 6.9 | 20.5% | 4.21 / 1.46 |
| triple div, next open | hold | 261 | 35% | 1.21 | 2.99 | 315.2 | 67.3 | 19.5% | 3.18 / -0.04 |
| triple div, MACD trigger | hold | 142 | 41% | 1.16 | 3.31 | 164.9 | 23.8 | 25.4% | 2.46 / 0.29 |
| triple div, MACD trigger | trail | 145 | 55% | 0.79 | 3.20 | 114.1 | 8.8 | 25.7% | 1.41 / 0.37 |
| triple div, MACD trigger | 3R | 143 | 46% | 0.67 | 2.48 | 95.2 | 8.8 | 25.5% | 1.09 / 0.37 |
| W top div, MACD cross-down | hold | 8 | 50% | 0.44 | 1.97 | 3.5 | 2.0 | 25.6% | 0.90 / 0.29 |
| W 70/60 div, MACD cross-down | hold | 31 | 52% | 0.59 | 2.21 | 18.4 | 5.8 | 20.3% | -0.48 / 0.75 |
| W bearish div, MACD cross-down | hold | 14 | 57% | 0.24 | 1.60 | 3.4 | 2.6 | 26.3% | -0.50 / 0.66 |

- MACD helps exactly where expected: the triple divergence. Waiting for the cross-up halves the trades, cuts the max
  drawdown from 67 R to 9-24 R, and turns the newer period from -0.04 R to +0.29-0.37 R per trade (positive in both
  periods now). Trail exit: 55% wins, +0.79 R, PF 3.2, 8.8 R max drawdown.
- The bottom divergence does better without it (it already enters near the low; waiting halves the trades and
  widens the stop). Keep next-open entry.
- Weekly shorts: the MACD cross-down entry is no better than the daily stops tested before (fewer trades, older
  period negative). Keep the daily swing / breakdown entries.

### RSI thresholds +/- 3 (owner: "test +/- 3 rsi on all of our models"; run 37152787125)
Every RSI threshold moved -3 / 0 / +3 (all combinations), each model with its chosen entry, stop and exit
(rsitrades.ts rsiGridReport). The chosen settings (*) reproduce the earlier runs exactly. avg R older / newer.

| model | grid result |
|---|---|
| D bottom div (20 / 30, 90-day hold or 3R) | all 18 cells positive in both periods. <=20 / <=33: 49 trades, 3R 1.34 R 76% wins, hold 2.33 R (same quality, +11 trades). <=17: 7-13 trades, 85-89% wins (too few). <=23: 54-115 trades, hold 3.3-4.7 R but median ~0 and the older period carries it (6.2 / 2.0); 3R ~0.9 R, 56% wins |
| D triple div (first <= 30, MACD entry, trail) | monotonic: <=27 1.29 R, 64% wins, PF 5.2, DD 5.4 R, 1.85 / 0.82 (84 trades); <=30 0.79 R, 0.37 newer; <=33 0.62 R, 0.18 newer |
| D momentum (RSI > 75, weekly < 62, 3-day stop) | all 9 cells positive in both periods (0.64-0.90 R, PF 2.7-4.1). Weekly < 59 slightly better in every row (75 / 59: 0.90 R, PF 3.8); 72 = more trades, a bit less R; 78 = fewer trades, smaller drawdown |
| W top div (82 / 75, breakdown, hold) | 79-82 first high all ~0.5-0.64 R, positive both periods (79 / 75: 15 trades, 0.64 R, PF 2.9, DD 2.0). First high >= 85: negative in every cell (6-8 trades). Second >= 78 weaker |
| W high div (70 / 60, breakdown, 3R) | all 9 cells positive; second >= 63 best (67 or 70 / 63: 32 trades, 0.67 R, PF 2.5, DD 4.1, 0.99 / 0.58); first >= 73 weak in the older period |

- The framework is robust to +/- 3: no model turns negative except the top divergence with a first high >= 85.
- Shifts backed by their neighbours (not single lucky cells): triple divergence first low <= 27; top divergence
  first high >= 79; bottom divergence second low <= 33 (more trades, same quality); 70 / 60 divergence second
  high >= 63. Picking the best cells adds some overfit; the coin holdout is the check.

### RSI framework, final settings, as trades (owner: "yes run those as trades"; run 37153301460)
Settings adopted after the +/- 3 grid (owner, 2026-10-03): triple div first <= 27, top div first >= 79, bottom div
second <= 33, 70/60 div second >= 63. 56 pinned coins, to 2026-10-03, 0.22% costs, 1 R per trade.

| model | n | win % | avg R | median R | PF | total R | max DD R | stop % | avg R older / newer |
|---|---|---|---|---|---|---|---|---|---|
| LONG D bottom div <=20 / <=33, 90d, 3R | 49 | 76% | 1.34 | 1.60 | 6.34 | 65.6 | 4.0 | 14.3% | 2.21 / 1.09 |
| (same, 90-day hold) | 48 | 65% | 2.33 | 0.48 | 7.67 | 111.9 | 8.2 | 14.4% | 3.04 / 2.12 |
| LONG D triple div <=27, MACD entry, trail | 84 | 64% | 1.29 | 0.50 | 5.19 | 108.7 | 5.4 | 23.6% | 1.85 / 0.82 |
| LONG D momentum > 75 / weekly < 62, 3-day stop | 194 | 54% | 0.86 | 0.09 | 3.47 | 166.5 | 19.9 | 23.8% | 0.78 / 0.90 |
| LONG 4H under-floor, 10 days | 51 | 45% | 0.95 | -0.03 | 2.89 | 48.6 | 12.2 | 15.5% | 0.95 / 0.96 |
| SHORT W RSI 14 bearish div, daily swing, 3R | 24 | 63% | 1.03 | 1.51 | 3.62 | 24.7 | 3.1 | 10.9% | 1.01 / 1.05 |
| SHORT W top div >= 79 / >= 75, breakdown | 15 | 67% | 0.64 | 0.42 | 2.90 | 9.7 | 2.0 | 24.0% | 0.79 / 0.57 |
| SHORT W high div >= 70 / >= 63, breakdown, 3R | 28 | 54% | 0.66 | 0.88 | 2.40 | 18.5 | 4.1 | 17.6% | 0.89 / 0.60 |
| all longs | 378 | 58% | 1.03 | 0.30 | 3.96 | 389.5 | 18.5 | | 1.21 / 0.92 |
| all shorts | 67 | 60% | 0.79 | 0.70 | 2.91 | 52.9 | 7.1 | | 0.93 / 0.72 |
| WHOLE FRAMEWORK (bottom div with 3R) | 445 | 58% | 0.99 | 0.33 | 3.78 | 442.4 | 13.7 | | 1.18 / 0.89 |

By year: 2022 (from mid-year) 17 trades +4.9 R; 2023 70 / +110.0 R; 2024 120 / +182.3 R; 2025 112 / +40.1 R;
2026 (to Oct) 126 / +105.1 R. Every model positive in both periods; every year positive.
Caveats: the settings were chosen on this data (the 54-coin holdout is the real test); the R drawdown treats
overlapping trades one after another, so an account with many positions open at once (correlated, e.g. momentum
longs in a rally) can draw down more; funding is not modelled.

### Decision (owner, 2026-10-03): dashboard shows the two best bot strategies and the RSI framework's signals
- Strategy cards and "Results by strategy" show only the strategies in profit right now (this paper session:
  closed trades + open positions), the best two. The others keep paper trading and reappear once in profit; a
  strategy switched ON for live always stays visible. A "Hidden strategies" card lists the rest with their P&L.
- New "RSI framework signals" section (display only, never traded): the seven models with their final settings
  (rsisignals.ts), refreshed in the worker after each 4H close for the paper session's coins (daily + 4H candles,
  ~3 years, kept in the candles table). Rows: waiting for trigger / enter next open / open / closed in the last 14 days,
  with entry, stop, target, last price and R.

### RRG x RSI framework (owner: "a test to see if RRG interacting with the RSI framework does anything, only as a test"; run 37155368836)
Each framework trade (final settings; BTC trades excluded, 421 of 445) tagged with its coin's daily RRG vs BTC at the
close before entry (120 daily bars, the bot's classifier): position agrees = stronger than BTC for a long (x + y > 200),
weaker for a short; heading agrees = the tail turning the trade's way.

| group (whole framework) | n | win % | avg R | PF | max DD R | avg R older / newer |
|---|---|---|---|---|---|---|
| all | 421 | 58% | 1.00 | 3.80 | 13.7 | 1.18 / 0.90 |
| position agrees | 297 | 57% | 0.81 | 3.28 | 13.7 | 1.09 / 0.69 |
| position against | 124 | 60% | 1.44 | 5.04 | 9.1 | 1.31 / 1.57 |
| heading agrees | 298 | 57% | 0.87 | 3.42 | 10.6 | 1.36 / 0.65 |
| heading against | 123 | 59% | 1.31 | 4.73 | 9.1 | 0.91 / 1.72 |
| both agree | 244 | 57% | 0.82 | 3.31 | 10.6 | 1.30 / 0.62 |
| both against | 70 | 61% | 1.71 | 6.03 | 9.1 | 1.18 / 2.50 |
| longs, coin lagging | 81 | 62% | 1.76 | 6.61 | 11.2 | 1.64 / 1.89 |
| longs, coin improving | 64 | 61% | 1.16 | 3.96 | 6.9 | 1.46 / 0.95 |
| longs, coin leading | 203 | 53% | 0.72 | 3.00 | 21.5 | 0.80 / 0.69 |
| shorts, coin lagging | 34 | 71% | 1.13 | 4.80 | 4.1 | 1.02 / 1.19 |

- RRG agreement does not help the RSI framework; if anything the opposite: RSI longs on coins weaker than BTC
  (lagging) did best (+1.76 R, both periods) and longs on leading coins worst (+0.72 R). Fits the framework: its
  best longs buy exhausted coins (bottom / triple divergence), which are usually lagging BTC.
- Per model the splits are small and mixed (e.g. momentum longs with RRG against: 22 trades +2.25 R, 9 of them newer).
  Not applied: as a filter, RRG agreement would remove the better trades. A "prefer laggards" rule is post hoc;
  test it on the coin holdout before using it.

### Inverse RRG check on fresh coins (owner: "test RRG in an inverse manner"; run 37155639136)
Rule fixed before the run: take a framework trade only when the coin's daily RRG position is AGAINST the trade
(long: weaker than BTC; short: stronger); stricter: position and heading both against. Checked on "fresh" coins:
liquid Bitunix coins in neither the research list nor the holdout (11 coins: AIN, PUMP, PONS, RESOLV, ICP, US, APT,
ALGO, AERO, AT, STX; mostly short histories). The holdout stays untouched.

| fresh coins | n | win % | avg R | PF | max DD R | avg R older / newer |
|---|---|---|---|---|---|---|
| whole framework | 52 | 46% | 0.61 | 2.43 | 13.8 | 2.72 / -0.02 |
| position agrees | 39 | 44% | 0.38 | 1.85 | 13.3 | 1.91 / -0.01 |
| position against (inverse rule) | 13 | 54% | 1.30 | 4.66 | 2.5 | 4.34 / -0.05 |
| both against (strict inverse) | 8 | 63% | 1.68 | 7.30 | 2.0 | 7.42 / -0.23 |
| (research coins, for reference) position against | 124 | 60% | 1.44 | 5.04 | 9.1 | 1.31 / 1.57 |

- Same direction as on the research coins: trades with RRG against do better than with RRG agreeing. But 13 and 8
  trades are far too few, and in the newer period every group is ~0 R (the gain is a few older winners).
- Bigger caution: on these fresh coins the framework itself is weak (+0.61 R, newer period -0.02 R over 40 trades),
  mostly the momentum long (26 trades, 27% wins, ~0 R). Fresh coins are mostly recent listings; the holdout run is
  still the real test of the framework.
- Verdict: the inverse RRG rule is not proven; not applied.

### Decision (owner, 2026-10-03): RRG stays out of the RSI framework
No RRG filter (agreeing or inverse) in the framework or its dashboard signals.

### Supply / demand and order blocks with the RSI framework (owner: "test all variants and let's see what it says"; run 37157181349, research branch)
Ported (CC BY-NC-SA 4.0, credited): BigBeluga Supply and Demand Zones, LuxAlgo Supply and Demand Visible Range
(150-bar window), LuxAlgo Order Block Detector (newest 3 per side). Zones on the model's own timeframe (weekly /
daily / 4H) and on the 4H (daily for the 4H model), read at the entry bar's open. Uses, each alone, rules fixed before
the run (sdtest.ts): filter (signal-to-entry range touched a zone of the trade's side), stop behind the nearest zone of
the trade's side (+/- 0.5 ATR), target at the nearest opposite zone. Framework as it is: 455 trades, 59% wins,
+1.01 R, PF 3.87, max DD 13.7 R, older / newer 1.18 / 0.91.

| whole framework | n | win % | avg R | PF | total R | max DD R | avg R older / newer |
|---|---|---|---|---|---|---|---|
| as it is | 455 | 59% | 1.01 | 3.87 | 459.6 | 13.7 | 1.18 / 0.91 |
| LuxAlgo range, own TF, filter | 221 | 63% | 1.24 | 4.52 | 273.1 | 10.6 | 1.50 / 1.06 |
| LuxAlgo range, 4H, filter | 167 | 62% | 1.31 | 4.73 | 219.0 | 10.2 | 1.77 / 1.06 |
| order blocks, own TF, filter | 43 | 70% | 1.14 | 5.32 | 48.9 | 3.0 | 1.08 / 1.17 |
| order blocks, 4H, filter | 176 | 60% | 1.10 | 3.94 | 193.3 | 6.3 | 1.26 / 0.99 |
| BigBeluga, own TF, filter | 35 | 60% | 1.26 | 4.50 | 44.1 | 6.1 | 1.86 / 0.54 |
| BigBeluga, 4H, filter | 194 | 61% | 1.04 | 4.08 | 201.3 | 7.3 | 1.26 / 0.92 |
| stops behind zones (all six) | 446-459 | 55-61% | 0.73-0.93 | 3.4-4.1 | 324-425 | 8.7-13.2 | |
| targets at opposite zones (all six) | 458-537 | 60-78% | 0.25-0.92 | 2.4-3.7 | 132-420 | 10.5-18.6 | |

- Stops behind zones and targets at zones make the framework worse on every source: zone stops are wider for no
  better result, and zone targets cut the winners short (higher win rate, much less R).
- Filters keep the better half: +1.1 to +1.3 R per trade instead of +1.01, in both periods for the LuxAlgo visible
  range (newer 1.06 vs 0.91), but they drop half the trades or more, so total R falls (273 vs 460).
- By model (small samples): 4H under-floor with LuxAlgo daily filter 35 trades +1.49 R (1.68 / 1.31) vs +0.95;
  triple divergence with order blocks 4H filter 57 trades +1.60 R vs +1.32; momentum longs rarely touch a zone (the
  filters leave 1-81 trades). Weekly shorts: weekly BigBeluga zones and weekly order blocks almost never apply
  (0-4 trades); the other cells have 5-24 trades, too few to judge.
- Bottom divergence with a zone target did better (+2.06 to +2.21 R) only because the zone sits further than its 3R
  target; holding 90 days does the same (+2.33 R, tested earlier).
- Nothing changed in the framework or the bot.

### Decision (owner, 2026-10-03): 4H under-floor adopts the LuxAlgo visible-range daily demand filter (run 37157716380)
The 4H under-floor long is taken only when its signal bar touches the LuxAlgo visible-range demand zone on the daily
(150 daily bars ending at the last close before the signal). Verified: 35 trades, 57% wins, +1.49 R, PF 5.00, max DD
6.3 R, older / newer 1.68 / 1.31 (was 51 trades, +0.95 R, DD 12.2 R). Whole framework now 429 trades, 59% wins,
+1.04 R, PF 4.04, max DD 13.7 R, older / newer 1.28 / 0.91. Found among 18 zone variants on the same data: confirm
on the coin holdout.

### Entry inside zones, deeper zones, S/R confluence (research, run 37158129795)
`--rsi-trades --zone-entry --months 84 --to-today --cut-months 24`, 56 pinned coins, older / newer split 2024-10-03.
After a model's trigger, wait (20 daily / 30 4H bars) for price to tap the nearest zone on the trade's side, then
enter with a limit order p% into it (0-50%). The model's own stop and exits are kept (cap and 3R count from the fill);
a level beyond the stop is skipped. Zone 2 = the next deeper zone. S/R = zone 1 overlaps a daily S/R channel.

| whole framework (zone 1) | n | win % | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|---|
| enter as now | 439 | 60% | 1.05 | 463 | 13.7 | 1.28 / 0.94 |
| LuxAlgo range, own TF, 0% / 20% / 50% in | 196 / 180 / 136 | 60-62% | 1.11 / 1.26 / 1.18 | 218 / 228 / 160 | 8.3 / 6.3 / 7.3 | 1.33-1.36 / 1.00-1.21 |
| LuxAlgo range, 4H/daily, 0% / 50% in | 126 / 87 | 53% / 46% | 0.83 / 1.09 | 104 / 95 | 10.0 / 7.8 | |
| order blocks, 4H/daily, 0% / 30% in | 175 / 165 | 48-49% | 0.98 / 1.11 | 172 / 184 | 16.8 / 11.2 | 1.33-1.52 / 0.84-0.95 |
| BigBeluga, 4H/daily, 0% / 50% in | 183 / 157 | 46-47% | 0.89 / 1.31 | 164 / 205 | 9.4 | 1.10-2.24 / 0.77 |

- Waiting for the zone takes far fewer trades (price often never comes back): total R falls on every variant.
  Deeper entries raise R per trade a little (the same stop is closer) but miss more trades. No depth is clearly best;
  LuxAlgo own-TF 20% in is the best line (+1.26 R, both periods) but it is a subset of setups, so part of it is filter.
- By model: triple divergence with a 4H order-block entry 41 trades +2.07 R (2.77 / 1.79) vs +1.32 as now (93
  trades); 4H under-floor 50% into its LuxAlgo 4H zone 30 of 35 filled, +1.74 R (same total R). Bottom divergence:
  no change (it is already in the zone). Momentum: zones sit under its stop (most skipped). Weekly shorts: worse on
  every source.
- Deeper zones: when price broke zone 1 within the wait it reached zone 2 about a third of the time (BigBeluga
  4H/daily 50 of 146, order blocks 4H/daily 72 of 183). Entries at zone 2 are worse (order blocks 4H/daily +0.35 R,
  29-36% wins); BigBeluga zone 2's high average rests on a few newer trades (older periods negative). LuxAlgo visible
  range has one zone per side, so no zone 2.
- S/R confluence helps 4H/daily order blocks (0% in: +1.37 R vs +0.79, both periods) and BigBeluga 4H/daily (+1.24 vs
  +0.70); it does not help the LuxAlgo visible range (with S/R +1.08 vs without +1.18).
- Tested on the same data as the framework: nothing changed in the framework or the bot.
