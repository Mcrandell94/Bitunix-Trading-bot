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

### Scaled entry 10/20/30% into zones (research, run 37159291828)
`--rsi-trades --ladder --months 84 --to-today --cut-months 24`, 56 pinned coins. After the trigger, three equal limit
orders 10/20/30% into the nearest zone on the trade's side (an order already through the price is placed at the price),
all three together sized to risk 1R to the model's stop; same wait, stops and exits as the single-entry test.
"or now" = a setup with no such zone at the trigger enters as now.

| whole framework | n | win % | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|---|
| enter as now | 439 | 60% | 1.05 | 463 | 13.7 | 1.28 / 0.94 |
| LuxAlgo range, own TF, scaled | 187 | 61% | 1.16 | 216 | 6.0 | 1.35 / 1.05 |
| BigBeluga, 4H/daily, scaled / or now | 177 / 287 | 46% / 52% | 0.99 / 1.04 | 175 / 299 | 9.4 / 12.9 | 1.34-1.53 / 0.78 |
| order blocks, 4H/daily, scaled / or now | 169 / 222 | 48% / 50% | 1.00 / 1.03 | 169 / 229 | 12.7 / 14.0 | 1.36-1.42 / 0.83-0.86 |

- Almost every scaled trade filled all three orders (e.g. 163 of 187, 165 of 169): a price that reaches 10% into a zone
  nearly always reaches 30%, so the scale-in behaves like one entry about 20% in. It is no better than the single 20%
  entry (LuxAlgo own TF +1.16 R vs +1.26 R) and every variant still makes less total R than entering as now, also
  with "or now" (the setups whose zone never fills are lost).
- By model: triple divergence with 4H order blocks again stands out: 40 trades, +2.28 R, DD 3.5 R, 3.11 / 1.97 (or now:
  54 trades, +1.73 R, 93 R total vs 93 trades +1.32 R, 123 R as now). Under-floor unchanged (+1.50 R). Weekly shorts
  and momentum worse.
- S/R confluence as before: helps BigBeluga 4H/daily (+1.35 vs +0.78) and order blocks 4H/daily (+1.23 vs +0.90), not the
  LuxAlgo range.
- Nothing changed in the framework or the bot.

### Per-model entry optimisation, walk-forward (research, run 37159866281)
`--rsi-trades --optimise --months 84 --to-today --cut-months 24`, 56 pinned coins. Each model picks one entry (enter as
now, or one full entry 0-50% into the nearest zone: 3 sources x own / alt TF, no zone = skip or enter now, any zone or
only zones on a daily S/R channel; 145 choices) on the trades before 2024-10-03 only, then is judged on the newer trades.

| model | pick (most older total R) | newer: pick vs as now | pick (older total R / DD) | newer: pick vs as now |
|---|---|---|---|---|
| daily bottom div | as now | same | as now | same |
| daily triple div | as now | same | order blocks 4H, 30% in, skip | **59.1 R / DD 3.5 (29 tr) vs 51.0 R / DD 4.1 (54 tr)** |
| daily momentum | BigBeluga 4H, 50% in, or now, S/R | 99.3 R vs 116.4 R (worse) | BigBeluga 4H, 50% in, skip, S/R | 0.0 R vs 116.4 R (overfit) |
| 4H under-floor | BigBeluga 4H, 0% in, or now, S/R | 23.5 R vs 23.5 R | same | same |
| weekly bearish div | BigBeluga 4H, 40% in, or now, S/R | 15.0 R vs 13.6 R (12 trades) | same | same |
| weekly top div | as now | same | as now | same |
| weekly 70/63 div | as now | same | as now | same |

- Whole framework, newer trades only: as now 286 trades 267.7 R, DD 13.7; picks by total R 247 trades 251.9 R, DD 11.3;
  picks by R/DD 115 trades 141.9 R, DD 7.3. Optimising every model does not beat entering as now on unseen data.
- The one pick that held on the newer trades: triple divergence entering 30% into a 4H order block (older 3.20 R/trade,
  newer 2.04 R/trade, more R with half the trades and a lower DD). Momentum's picks failed out of sample; under-floor and
  the weekly bearish pick are no real change.
- Nothing changed in the framework or the bot.

### Decision (owner, 2026-10-03): zone entries only 0-30% deep. Optimisation re-run (runs 37159942380, 37160011286)
`--rsi-trades --optimise --depths 10,20,30`, then `--depths 0,10,20,30` (owner: 0% allowed if best; 40% and 50% removed),
same walk-forward (picked before 2024-10-03). Both runs give the same picks and totals except under-floor and weekly
bearish div pick 0% instead of 10% (same R).
- Whole framework, newer trades: as now 286 trades 267.7 R, DD 13.7; picks by total R 247 trades 245.2 R, DD 12.4;
  picks by R/DD 115 trades 135.2 R, DD 9.4. Still no gain from optimising every model.
- Triple divergence, 30% into a 4H order block, is unchanged and still the only pick that holds on the newer trades:
  29 trades 59.1 R, DD 3.5 vs 54 trades 51.0 R, DD 4.1 (whole data 40 trades +2.36 R, older / newer 3.20 / 2.04).
- Momentum picks fail out of sample (96.9 R vs 116.4 R; the R/DD pick -2.3 R). Under-floor: same R either way.
  Weekly bearish pick (order blocks 10%, or now): worse on newer (10.7 R vs 13.6 R). Bottom div and weekly top / 70-63:
  enter as now is the pick.

### 15m / 1h RSI scalp study (research, run 37162205500)
`--scalp --months 24 --to-today --cut-months 8`, 56 pinned coins, 2024-10 to 2026-10 (older / newer split 2026-02-03).
Owner's LINK 15m / 1h screenshots: rising RSI lows from the oversold band (longs), falling RSI highs from 80 to 70
(shorts); as RSI trend lines alone ('hl') or with a price divergence ('div'); loose (30/40, 70/60) and tight (25/35,
75/65) grids; stop past the swing +/- 0.2 ATR; exits 1.5R / 2R / RSI back to 70 / 30; cap 24h (15m) / 48h (1h).
Best line per combination (avg R per trade; every one of 120 lines is negative):

| combination | long, 0.22% cost | short, 0.22% | long, 0.10% cost | short, 0.10% |
|---|---|---|---|---|
| 15m alone | -0.31 (12,651 trades) | -0.36 | -0.13 | -0.14 |
| 1h alone | -0.15 (4,026) | -0.17 | -0.06 | -0.08 |
| 15m with a 1h signal within 12h | -0.25 (1,272) | -0.38 | -0.11 | -0.20 |
| 15m with 1h RSI <= 45 / >= 55 | -0.31 | -0.36 | -0.13 | -0.14 |
| 1h signal then 15m trigger | -0.22 (542) | -0.35 | -0.05 | -0.18 |

- Taken mechanically, every pivot pair fires: LINK 15m gave about 50 long signals in the last 30 days where the owner
  marked 4-5; stops are 1.2-2.8% so costs are 0.1-0.2 R a trade, and even at 0.10% nothing is positive (win rates
  22-39% at 1.5-2R targets). The 1h list for LINK lines up with the owner's green marks (Sep 10-11, 16, 20, 24).
- No bot or framework change. Next: a selective version (one signal per oversold low, higher-timeframe direction).

### Framework trades split by the 1h / 15m RSI at entry (research, run 37162930031)
`--rsi-trades --ltf-split --months 84 --to-today --cut-months 12`. Owner: "Does it help the higher time frames if they
align with these 1hr and 15m RSI being at extreme highs or lows while entering?" 293 of 429 framework trades fall inside
the 1h / 15m history (Oct 2024 on); shorts mirrored. Older / newer split 2025-10-03.

| at entry (whole framework) | n | win % | avg R | older / newer |
|---|---|---|---|---|
| all classified | 293 | 58% | 0.93 | 1.02 / 0.83 |
| 1h RSI <= 30 your way | 18 | 67% | 1.44 | 0.72 / 1.90 |
| 1h RSI 45-70 | 171 | 56% | 1.00 | |
| 1h RSI >= 70 against | 86 | 59% | 0.75 | 1.00 / 0.46 |
| 15m RSI <= 30 your way | 8 | 63% | 2.79 | 0.21 / 4.34 |
| 15m RSI 45-70 | 200 | 61% | 1.06 | |
| 15m RSI >= 70 against | 38 | 50% | 0.33 | 0.52 / -0.14 |
| 1h <= 30 your way in the 24h before | 34 | 71% | 1.19 | 0.57 / 1.63 |

- Entering with the 1h / 15m at an extreme the trade's way is rare (6% of trades) and 16 of the 18 are the 4H
  under-floor long, which enters after a 4H oversold by design; samples too small and the periods disagree.
- The clearer effect is the opposite: entering while the 15m RSI is >= 70 against the trade (a long into a stretched
  15m) averages +0.33 R vs about +1.06 R otherwise, weak in both periods; the 1h >= 70 is milder (+0.75 R). Triple
  divergence entered into a stretched 1h / 15m: +0.32 R (15) vs +1.25 R (41). Momentum is barely affected.
- No change made. Next test: delay the entry until a stretched 15m RSI cools (back under 70 / over 30), not skip it.

### Entry timing with the 1h / 15m RSI, cool-off and zones (research, run 37164896955)
`--rsi-trades --ltf-entry --months 84 --to-today --cut-months 12`. Owner 2026-10-04: extremes = oversold for longs,
overbought for shorts; "if any other entry style works then fine, i.e. RSI cool off then enter; we also have the order
blocks, S/R channels and supply and demand". 405 framework setups inside the 15m history (Oct 2024 on); same signals,
stops and exits, only the entry moves (wait up to 5 days, 2 for the 4H model); older / newer split 2025-10-04.

| entry style (whole framework) | trades | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|
| now (current) | 306 | 0.94 | 289 | 13.7 | 1.00 / 0.90 |
| 1h extreme | 180 | 0.83 | 149 | 14.1 | 0.86 / 0.80 |
| 15m extreme | 289 | 0.67 | 195 | 13.5 | 0.65 / 0.69 |
| cool-off 15m (stretched against -> wait for RSI 50) | 296 | 0.92 | 272 | 13.7 | 1.00 / 0.84 |
| cool-off 1h | 296 | 0.88 | 259 | 13.9 | 0.95 / 0.80 |
| BigBeluga 4H/daily zone + 15m extreme | 76 | 1.19 | 90 | 6.1 | 1.47 / 0.98 |
| LuxAlgo range own TF + 1h extreme | 86 | 1.16 | 99 | 5.7 | 0.77 / 1.34 |
| order blocks 4H/daily + 1h extreme | 57 | 0.83 | 47 | 10.0 | |
| daily S/R channel + 15m extreme | 122 | 0.64 | 78 | 17.3 | |

- No entry style beats entering now on total R. Waiting for a 1h / 15m extreme alone is worse; cooling off gives the
  same trades a little worse. Momentum longs are hurt by every delayed entry (they buy strength).
- Zone + extreme entries raise R per trade and cut the drawdown for the divergence longs, but take a quarter of the
  trades: bottom divergence with a BigBeluga 4H/daily zone + 1h / 15m extreme 12-15 trades, 87-92% wins, +1.8 R (now 40
  trades +1.11 R); triple divergence with a daily S/R channel + 1h extreme 14 trades +1.72 R (2.73 / 1.16) vs 66 trades
  +1.05 R. Small samples, nearly all bottom-div trades in the newer period.
- Weekly shorts: samples of 3-12, nothing to conclude. 4H under-floor: unchanged (it already enters oversold).
- No change made.

### Decision (owner, 2026-10-04): no 1h / 15m RSI extreme or cool-off entries for the higher-timeframe models
"Let's forget the RSI extreme for the higher time frames if it's just worse, cool off also. Unless we can see positive
effects from them we will consider it." Dropped: plain 1h / 15m extreme entries and the cool-off (both worse than
entering now). Still a candidate because it showed a positive effect per trade: zone + 1h / 15m extreme for the daily
bottom / triple divergence longs (forward test next to the current entry, or a hybrid test with a fall-back entry).

### New models to fill the gaps (research, runs 37165586528 pinned coins, 37165642705 fresh coins)
`--rsi-trades --new-models --months 84 --to-today --cut-months 24` (owner 2026-10-04: "Please begin number 2"). Mirrors
of the existing models, every RSI threshold also -3 / +3, costs 0.22%:

| model (best line) | research coins | fresh coins (13) | verdict |
|---|---|---|---|
| 4H RSI ceiling short (mirror of under-floor), 10 days | 588-661 trades, -0.37 to -0.51 R; with LuxAlgo daily supply -0.27 R | -0.30 to -0.64 R (over-ceiling 14 trades +0.48) | dropped |
| D top div >=79 / >=75 short, next open, 10-day swing stop, 3R, 60 days | 82 trades, 45% wins, +0.35 R, PF 1.63, DD 12.7, 0.36 / 0.34 | 17 trades, +0.27 R | candidate |
| D top div grid (76-82 / 72-78), next open, 3R | every cell +0.25 to +0.43 R, both periods | every cell +0.13 to +0.42 R | robust |
| D top div, breakdown entry or hold exit | about +0.0 to +0.26 R | mostly negative | 3R next open only |
| D high div 70/60 and any-level bearish div short | +0.0 to +0.15 R | -0.13 to +0.25 R | dropped |
| D momentum breakdown short (RSI < 25, weekly > 38), 30 days | -0.10 to -0.23 R in every cell | -0.16 to -0.46 R | dropped |
| W bottom divergence long, daily entry, 91 days | 3-33 trades, mostly negative | 2-6 trades, all losing | dropped (too rare) |

- Shorting stretched RSI on the 4H or breakdowns on the daily loses in crypto; the daily top divergence short is the
  only new model that holds on the research coins, across its grid, and on fresh coins. It is weaker per trade than the
  weekly shorts (+0.64 to +1.03 R) but adds a daily short, about 12 trades a year on 56 coins.
- A weekly bottom divergence (RSI <= 30 weekly with a lower price low) is too rare to trade.
- No change made; adopting the daily top divergence short needs the owner's OK.

### What went wrong with the 3 failed models, RSI triple top, take-profit / stop / time grid (research, runs 37166701447, 37166716286, 37166729692)
Owner 2026-10-04: "see what went wrong with the 3 others, try different RSI combos, maybe the one that took 600+ trades
needs a filter"; "triple top: first RSI 76-80+, the next 76-72, the third hardly makes it past 69.5-71"; "explore
different take profit models ... higher targets and wait out for longer, also different stop widths". 56 pinned coins,
7 years, older / newer split 2024-10-04.

**4H ceiling short** (RSI at its own 4H maximum): after the signal price keeps rising (+1.0% after 1 day, +3.9% after 5
days, +5.3% after 10 days on average). An RSI at its highest is momentum, not exhaustion. No filter fixes it: daily RSI
>= 70 -0.39 to -0.51 R, weekly >= 70 -0.37 to -0.89 R, under the daily EMA 50 -0.15 to -0.55 R, BTC daily RSI < 50
-0.11 to -0.50 R (best), waiting for a 4H divergence after the ceiling -0.23 R, waiting for RSI to fade under 60 -0.22 R.
Dropped.

**Daily momentum breakdown short**: after a daily RSI close under 25-30 price bounces (+3 to +6% within 5-10 days):
shorting a fresh oversold reading fights the mean reversion. Every RSI level (20-35) x weekly filter (> 38 / < 50 / any)
x stop (3 / 10 days) x exit is between -0.29 and +0.05 R. Dropped.

**Weekly long, other combos** (the strict weekly bottom divergence was too rare):
| variant (20-day low stop, 91 days) | trades | avg R | PF | max DD R | older / newer |
|---|---|---|---|---|---|
| weekly double bottom RSI <= 35 then <= 45, price within 5%, 3R | 87 | +0.79 | 2.77 | 9.5 | 0.13 / 1.09 |
| same, 3 ATR trail | 81 | +1.19 | 3.93 | 10.3 | 2.94 / 0.31 |
| weekly reclaim RSI <= 40 then over 45, trail | 179 | +0.38 | 1.83 | 32.4 | 0.23 / 0.49 |
| weekly reclaim RSI <= 35 then over 40, 3R | 118 | +0.32 | 1.65 | 25.0 | 0.26 / 0.37 |
Positive, but the double bottom swings between periods and the reclaim has a large drawdown (stops ~30% wide).
Candidates for a fresh-coin check, not adopted.

**RSI triple top short** (owner's 76+ / 72-76 / 69.5-71.5, shifted -3 / +3, loose third 68-72, with or without a price
triple top): weekly 0-1 signals in 7 years, daily 3-9, 4H 14-85. 4H owner levels: 36 trades, +0.01 R at 2R, -0.07 R at
3R; shift +3 14 trades +0.15 R; loose third 84 trades +0.04 R. Too rare on the slow charts and no edge on the 4H as a
mechanical rule. Not adopted.

**Take profit / stop / time grid** (stop 0.75-2x the model's, exits 2R-10R / trail / hold, cap 1x / 2x):
| model | current | best line | avg R current -> best | older / newer (best) | max DD R |
|---|---|---|---|---|---|
| D bottom div | 3R, 90d | 10R, 90d | 1.37 -> 2.55 (122 vs 69 R) | 3.50 / 2.27 | 4.0 -> 8.2 |
| D bottom div | | hold 90d | 1.37 -> 2.33 | 3.04 / 2.12 | 8.2 |
| D triple div | trail, 90d | hold 180d | 1.32 -> 2.85 (231 vs 123 R) | 2.76 / 2.93 | 5.4 -> 15.2 |
| D triple div | | stop 1.5x, hold 180d | 1.32 -> 2.42 | 2.38 / 2.46 | 9.1 |
| D momentum | hold 30d | stop 0.75x, hold | 0.87 -> 1.00 | 0.92 / 1.04 | 19.9 -> 22.8 |
| 4H under-floor | hold 10d | stop 0.75x, hold | 1.49 -> 1.76 | 1.70 / 1.82 | 6.3 -> 9.7 |
| W bearish div | 3R | stop 0.75x, 4R, 2x cap | 1.03 -> 1.23 (23 trades) | 1.57 / 0.97 | 3.1 |
| W top div | hold | stop 0.75x, 3R | 0.64 -> 1.08 (15 trades) | 1.88 / 0.68 | 1.5 |
| W 70/63 div | 3R | stop 0.75x, 6R, 2x cap | 0.66 -> 0.88 (28 trades) | 1.14 / 0.81 | 5.1 |
- The big gain is letting the daily divergence longs run: bottom divergence to 10R (or hold 90 days), triple divergence
  held 180 days; both better in both periods, with a larger drawdown. Small tweaks elsewhere; weekly shorts too few
  trades to trust a change. Caveats: tuned on the same data, long holds ride the bull years, 2x caps drop trades still
  open at the end.
- No change made.

### No time stops (research, run 37167270247)
Owner 2026-10-04: "Let's eliminate time stops and let the stop losses do their thing." Every framework model, its own
signals and stops, no time cap; exit only at the stop (fixed or trailing) or a target. Trades still open today are
marked at the last close. 56 pinned coins, 7 years, older / newer split 2024-10-04.

| model | now (with time cap) | current exit, no cap | best no-cap exit (sensible) | stop only (no target) |
|---|---|---|---|---|
| D bottom div | 3R: +1.37 R, DD 4.0 | 3R: +1.43 R | stop 1.5x, 10R: +3.50 R (6.98 / 2.13), 64% wins, DD 6.1, 14 still open | +22.3 R avg, open 15, held up to 1,568 days |
| D triple div | trail: +1.32 R, DD 5.4 | trail: +1.30 R | 5 ATR trail: +1.68 R (3.01 / 0.78), DD 5.4; 10R: +1.96 R, DD 9.1 | +4.80 R, DD 35, open 21 |
| D momentum | hold 30d: +0.87 R, DD 19.9 | = stop only: +2.06 R, DD 52, 25% wins, 43 open | stop 1.5x, 5 ATR trail: +1.08 R (0.88 / 1.18), DD 24.3 | same as current |
| 4H under-floor | hold 10d: +1.49 R, DD 6.3 | = stop only: +0.07 R, 6% wins | stop 0.75x, 5 ATR trail: +1.91 R (2.09 / 1.72), DD 8.2 | +0.07 R |
| W bearish div | 3R: +1.03 R | 3R: +0.88 R | stop 0.75x, 3R: +1.04 R (1.77 / 0.48) | -0.36 R |
| W top div | hold: +0.64 R | = stop only: +0.59 R, 8 open up to 905 days | stop 0.75x, 3R: +1.15 R (1.38 / 1.04) | +0.59 R |
| W 70/63 div | 3R: +0.66 R | 3R: +0.70 R | stop 0.75x, 5 ATR trail: +0.75 R | +0.14 R |

- Models with a target or a trail barely notice the cap (bottom div 3R, triple div trail, weekly 3R shorts).
- Models that relied on the time exit (momentum, under-floor, weekly top div) need a trail or a target once the cap goes:
  with the stop alone, under-floor drops to +0.07 R (price drifts back to the stop) and momentum / bottom div turn into
  multi-year buy-and-holds (huge averages from a few trades still open, drawdowns 35-52 R).
- With no caps, a 5 ATR trail (armed after +1R) or a 10R target replaces the time stop well for the longs.
- No change made yet.

### MACD crossover against the models again, no time stops (research, run 37167726670)
`--rsi-trades --macd-again`. MACD 12/26/9 histogram on each model's own bars, with the proposed no-time-stop exits
(bottom div 10R stop 1.5x; triple div / momentum / under-floor 5 ATR trail; weekly shorts 3R). 56 pinned coins, 7 years.

| whole framework | trades | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|
| enter now | 407 | +1.50 | 609 | 22.0 | 2.11 / 1.16 |
| MACD filter (histogram already the trade's way) | 343 | +1.38 | 473 | 25.5 | 2.05 / 1.02 |
| MACD cross trigger (wait up to 30 bars) | 179 | +0.74 | 133 | 37.3 | 0.74 / 0.74 |
| aligned or cross | 299 | +1.23 | 367 | 24.2 | 1.62 / 1.04 |
| enter now + exit on a MACD cross against | 481 | +0.41 | 198 | 13.0 | 0.63 / 0.30 |

- MACD adds nothing beyond its current use (the triple divergence entry). The filter and trigger cut trades without
  raising R per trade; waiting for the cross is worse for every model (under-floor +1.91 -> +0.37 R, momentum +1.08 ->
  +0.43 R, weekly bearish div +1.04 -> -1.08 R). Momentum entries are always MACD-aligned and under-floor entries almost
  never are, so the filter does nothing / removes the model.
- Exiting on a MACD cross against the trade cuts the winners short: every model drops (bottom div +3.50 -> +0.22 R).
- Only hint: weekly bearish div with the histogram already down, 15 trades +1.36 R vs 23 trades +1.04 R (newer period
  equal); too few to act on.
- No change made.

### Decision (owner, 2026-10-04): MACD only where it carries an improvement or keeps out bad trades
"Let's not use MACD unless it carried improvements or kept out bad trades." MACD stays only in the daily triple
divergence entry (the MACD cross-up trigger was adopted there because it improved that model in the earlier MACD
trigger test). No MACD filter, trigger or exit on any other model; the weekly bearish divergence hint (15 trades) is not
enough.

### Exit methods, no time stops (research, run 37168653286) and the framework with live exits (run 37168910705)
Owner 2026-10-04: "Yes to number 1 [no time stops with the proposed exits], experiment some more with various targets and
trailing stop methods"; "any model that could be positive, let's at least add it for testing". Exit study per model:
R targets 3-20, ATR trails 2-8 armed at once / +1R / +2R, chandelier, swing-low trail, EMA 20 / 50 close exit, breakeven
at +1R / +2R, half off at 2R / 3R; stop 1x and the proposed width. Chosen exits (now LIVE_EXITS in rsisignals.ts; the
dashboard signals use them, no time stops):

| model | exit | trades | avg R | older / newer | max DD R |
|---|---|---|---|---|---|
| D bottom div | stop 1.5x, 10R target | 39 | +3.50 | 6.98 / 2.13 | 6.1 |
| D triple div | breakeven at +1R, 10R target | 94 | +1.85 | 2.91 / 1.14 | 6.1 |
| D momentum | stop 1.5x, breakeven at +1R, 5 ATR trail | 175 | +1.10 | 0.87 / 1.20 | 21.9 |
| 4H under-floor | stop 0.75x, breakeven at +1R, 5 ATR trail | 34 | +1.94 | 2.09 / 1.78 | 7.2 |
| W bearish div | 6 ATR trail | 24 | +1.15 | 0.78 / 1.46 | 5.1 |
| W top div | stop 0.75x, 3R | 15 | +1.15 | 1.38 / 1.04 | 2.0 |
| W 70/63 div | 3R | 27 | +0.70 | 0.32 / 0.80 | 5.1 |
| test: D top div short | 3R | 94 | +0.25 | 0.37 / 0.14 | 13.4 |
| test: W double bottom long (RSI <= 35, higher low <= 45, price within 5%) | 6 ATR trail from +2R | 93 | +2.01 | 2.42 / 1.84 | 19.3 |
| test: W RSI reclaim long (<= 40 then over 45 within 12 weeks) | 5 ATR trail from +1R | 202 | +0.72 | 0.89 / 0.63 | 24.9 |

| together | trades | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|
| core 7, no time stops (new) | 408 | +1.55 | 632 | 20.7 | 2.01 / 1.30 |
| core 7 before (time caps) | 429 | +1.04 | 446 | 13.7 | 1.28 / 0.91 |
| test models | 389 | +0.92 | 356 | 37.5 | 1.00 / 0.87 |
| everything | 797 | +1.24 | 988 | 42.7 | 1.50 / 1.09 |

- By year (core): 2023 +216 R, 2024 +108 R, 2025 +23 R, 2026 +281 R; everything: 2025 -4 R (the test models gave back
  2025). Many trades are still open (momentum 41, weekly reclaim 42, weekly double bottom 35): results are partly marked,
  not closed. The exit shapes were chosen on the same data: the coin holdout and the forward test are the real check.
- Tuning findings: wide trails (5-6 ATR) and far targets (10R+) beat tight ones for every long; breakeven at +1R helps the
  trend models' drawdown; chandelier, swing-low and EMA exits cut winners short; half-off at 2R / 3R lowers drawdown but
  also the total; tight ATR trails (2-3) are the worst for the longs.
- On the research branch only (framework, signals, dashboard labels); not on main.

### Timed vs untimed exits, head to head; main + alternative exit per model (research, runs 37169042830, 37169279735)
Owner 2026-10-04: "If the timed exit was the best for any models it should stay for that model, or be final tested
alongside the same model that performs in second place or close to the model with no time limit." And: "all models are
test models but I don't want any labeled like so unless they are controversial in terms of profit." Same exit engine for
timed and untimed lines, open trades marked at the last close in both (the earlier 2x-cap grid left open trades out).

| model | main exit (avg R) | alternative exit (avg R) | why |
|---|---|---|---|
| D bottom div | hold 180 days, stop 1x (+5.60; DD 16.3; 6 / 12 open) | 10R, stop 1.5x, no time stop (+3.50; DD 6.1) | timed best |
| D triple div | hold 180 days, stop 1x (+2.90; 2.76 / 2.99) | breakeven +1R, 10R, no time stop (+1.85) | timed best |
| D momentum | stop 1.5x, breakeven +1R, 5 ATR trail, no time stop (+1.10) | stop 0.75x, hold 30 days (+1.03) | untimed best, timed close |
| 4H under-floor | stop 0.75x, breakeven +1R, 5 ATR trail, no time stop (+1.94) | stop 0.75x, hold 10 days (+1.76) | untimed best, timed close |
| W bearish div | stop 0.75x, 4R, 182 days (+1.23) | 6 ATR trail, no time stop (+1.15) | timed best |
| W top div | stop 0.75x, 3R, 182 days (+1.21) | stop 0.75x, 3R, no time stop (+1.15) | timed best |
| W 70/63 div | stop 0.75x, 6R, 182 days (+0.88) | 3R, no time stop (+0.70) | timed best |
| D top div short (test) | 3R, no time stop (+0.25) | 3R, 60 days (+0.22) | close; profit doubtful -> keeps the test label |
| W double bottom | 6 ATR trail from +2R, no time stop (+2.01) | same, 182 days (+1.87) | close |
| W RSI reclaim | 5 ATR trail from +1R, no time stop (+0.72) | same, 182 days (+0.68) | close |

| together | trades | avg R | total R | max DD R | older / newer |
|---|---|---|---|---|---|
| main exits, all but the test model | 713 | +1.69 | 1,206 | 36.0 | 1.84 / 1.62 |
| main exits, every model | 807 | +1.52 | 1,230 | 40.4 | 1.59 / 1.48 |
| alternative exits, all but the test model | 745 | +1.30 | 969 | 38.7 | 1.61 / 1.14 |
| alternative exits, every model | 843 | +1.17 | 990 | 40.0 | 1.40 / 1.05 |
By year (every model, main): 2022 -7 R, 2023 +359 R, 2024 +161 R, 2025 -6 R, 2026 +724 R; (alternative): 2022 -6 R,
2023 +296 R, 2024 +281 R, 2025 +7 R, 2026 +412 R.
- In code (research branch): LIVE_EXITS holds [main, alternative] per model; the dashboard signals list both (marked
  main / alt with the exit); only the daily top divergence short is labelled "(test)". Not on main yet.
- Caveats: a lot of the 2026 total is open trades marked at the last close; the long holds ride the bull years; all exits
  were chosen on these coins and years: the coin holdout is the next check.

## Final exit grid (research coins), the 2 versions per model going into the holdout

Owner 2026-10-04: "Can we test 10R-12r-14r targets? And another test of different stop loss and take profit variations
... I want to take the 2 best variations of each model into the hold out". Flag `--final-grid`, run 37193797668.
- **Grid:**
  - stops 0.75 / 1 / 1.25 / 1.5 / 2x;
  - targets 3, 4, 6, 8, 10, 12, 14, 20R;
  - breakeven at +1R, then 10 / 12 / 14R;
  - 5 / 6 ATR trail armed at +1R / +2R;
  - hold to the cap;
  - each exit with no time stop and with wider caps (daily longs up to 365 days, 4H up to 60 days, weekly up to 365 days, daily top div up to 120 days).
- **Rule, fixed before the run:**
  - avg R > 0 in both periods (cut 24 months);
  - open trades ≤ 25%;
  - n ≥ 60% of the model's reference count.
- **Picks:**
  - A = best avg R;
  - B = best line that differs from A in exit family (target / trail / hold) or in timed vs untimed.

| model | A (avg R) | B (avg R) |
|---|---|---|
| D bottom div | hold 180 days, stop 1x (+5.60; 8.41 / 4.77; 12 open) | 20R, no time stop (+4.22) |
| D triple div | hold 270 days, stop 1x (+4.64; 2.29 / 6.23; 17 open) | 20R, no time stop (+2.32) |
| D momentum | stop 0.75x, 5 ATR trail from +2R, 180 days (+1.32) | same, no time stop (+1.31) |
| 4H under-floor | stop 0.75x, 5 ATR trail from +1R, no time stop (+1.91) | same, 60 days (+1.89) |
| W bearish div | 6 ATR trail from +2R, 182 days (+1.32) | stop 0.75x, 20R, 182 days (+1.28) |
| W top div | stop 0.75x, 3R, 273 days (+1.21) | stop 0.75x, 3R, no time stop (+1.15) |
| W 70/63 div | stop 0.75x, 4R, no time stop (+0.93) | stop 0.75x, 6R, 182 days (+0.88) |
| D top div short (test) | stop 0.75x, 10R, 120 days (+0.41; 0.75 / 0.06) | stop 0.75x, hold 120 days (+0.39) |
| W double bottom | 20R, 91 days (+1.91) | 5 ATR trail from +1R, 91 days (+1.75) |
| W RSI reclaim | stop 0.75x, 20R, no time stop (+0.89; DD 64.9R) | stop 0.75x, 5 ATR trail from +2R, 273 days (+0.80) |

- **Wider time stops:** they helped only the triple divergence (270 days beat 180). Elsewhere the best cap stayed at or under 182 days, or there was none.
- **10 / 12 / 14R targets:** none won for any model. 20R or trails won where far targets help; 3 / 4R stayed best for the weekly top shorts.
- **In code (research branch):** `LIVE_EXITS` = [A, B]. Next: the 54-coin holdout, run once, no tuning after.

## Coin holdout: the 2 versions per model on the 54 locked coins (run once, 2026-10-04)

Runs 37194176572 (`--framework-v2`, A / B) and 37194177740 (`--framework`, the old exits as a reference). Both used
`--coins holdout --final` on the owner's go-ahead ("take the 2 best variations of each model into the hold out"), with
84 months and the cut at 24 months. 54 coins, none in research-coins.json. No tuning after this run.

| model | research A | holdout A (n, older / newer) | research B | holdout B (n, older / newer) | old exits on holdout |
|---|---|---|---|---|---|
| D bottom div | +5.60 | +1.85 (26; 7.08 / 1.64) | +4.22 | +2.29 (26; 19.97 / 1.58) | 3R +0.42, hold 90d +2.20 |
| D triple div | +4.64 | +0.44 (88; -0.15 / 0.59) | +2.32 | +1.21 (87; 1.32 / 1.19) | MACD trail +0.51 (77) |
| D momentum | +1.32 | -0.08 (150; DD 82) | +1.31 | -0.08 (same) | hold 30d -0.00 (136) |
| 4H under-floor | +1.91 | +0.47 (24; 2.27 / -0.27) | +1.89 | +0.58 (24; 2.27 / -0.12) | 10 days +0.72 (24) |
| W bearish div | +1.32 | +0.01 (9) | +1.28 | +0.02 (9) | 3R +1.07 (8) |
| W top div | +1.21 | +0.98 (4) | +1.15 | +0.98 (4) | hold +1.34 (4) |
| W 70/63 div | +0.93 | -0.94 (10, 0 wins) | +0.88 | -0.94 (10) | 3R -0.70 (9) |
| D top div (test) | +0.41 | +0.27 (48; 1.31 / -0.26) | +0.39 | +0.16 (48) | — |
| W double bottom | +1.91 | +1.08 (87; 0.34 / 1.12) | +1.75 | +0.62 (90) | — |
| W RSI reclaim | +0.89 | +0.00 (155; DD 81) | +0.80 | +0.06 (160; DD 57) | — |

**Totals:**
- A, all but the test model: 553 trades, +0.32 avg R, 176 R, DD 187.
- B: 560 trades, +0.41 avg R, 228 R, DD 111.
- Old framework (8 models): 282 trades, +0.26 avg R, 74 R, DD 34.

**By year:**
- A: 2025 -93 R, 2026 +284 R.
- B: 2025 -40 R, 2026 +237 R.

**Read:**
- **Generalised:** the far-target / hold longs (bottom div, triple div with 20R, weekly double bottom).
- **Failed to generalise:** daily momentum, weekly RSI reclaim, weekly 70/63 div.
- **Gave back most of their research edge:** weekly bearish div with the new exits, and under-floor in the newer period.
- **B beat A in most models:** the research picks overfit.
- **Old exits held up better for:** weekly bearish div (3R), under-floor (10 days) and weekly top div (hold).

## Pooled exit grid (research + holdout coins) and the fresh-coin check (2026-10-04)

**Why (owner, after the holdout):**
- Owner asked "why are we not adjusting based on hold out data?" and chose "Pool and re-check".
- The 1,000-line grid per model overfit the research coins.
- So: re-tune on research + holdout together (110 coins) with a small grid, then check once on fresh coins.
- The holdout is now spent as a check: only fresh coins and live trading are left.

**Pooled grid (run 37197592942):**
- **Grid:**
  - stops 0.75 / 1 / 1.5x;
  - targets 3 / 6 / 10 / 20R;
  - 5 ATR trail from +1R / +2R;
  - hold to cap;
  - the model's original exit;
  - a few caps per model.
- **Score:** the lower of the research-coin and holdout-coin avg R.
- **Kept:** positive on both coin sets and in both periods, open ≤ 25%, n ≥ 60%.

**Fresh-coin check, run once:**
- Runs 37197856181 (A / B) and 37197857781 (old exits).
- 38 coins in neither list, plus BTC as the RRG benchmark.
- 84 months, cut at 24.

| model | pooled A (res / hold) | pooled B | fresh A | fresh B | fresh old exits | verdict |
|---|---|---|---|---|---|---|
| D bottom div | 20R, no time stop: +3.54 (4.22 / 2.29) | 20R, 270 days +3.36 | +1.34 (27) | +1.35 | 3R +0.44 / hold +0.54 | keep |
| D triple div | stop 0.75x, hold 90 days: +1.76 (1.75 / 1.77) | 0.75x, 20R, 90 days +1.72 | +0.43 (51; newer -0.25) | +0.43 | +0.39 | keep, weak lately |
| D momentum | 0.75x, hold 270 days: +0.86 (1.15 / 0.47) | 20R, no time stop +0.79 | -0.25 (72) | +0.04 | +0.22 | fails fresh |
| 4H under-floor | 0.75x, 5 ATR from +2R, 10 days: +1.45 (1.73 / 1.04) | 0.75x, 10R, 10 days +1.17 | +2.75 (11) | +2.34 | +2.09 | keep |
| W bearish div | 0.75x, 3R, 182 days: +1.21 (1.20 / 1.24) | 0.75x, 3R, no time stop +1.08 | +2.38 (7) | +2.38 | +1.40 | keep |
| W top div | 0.75x, 3R, no time stop: +1.11 (19 trades) | 0.75x, 3R, 91 days +1.06 | +0.98 (2) | +0.98 | +0.59 | few trades |
| W 70/63 div | none kept (best -0.51) | — | +0.29 (7) | +0.58 | +0.37 | dropped |
| D top div (test) | 6R, 120 days: +0.32 (0.33 / 0.32) | hold 120 days +0.32 | -0.40 (20) | -0.40 | — | fails fresh |
| W double bottom | hold 91 days: +1.60 (2.02 / 1.14) | 20R, 91 days +1.51 | +1.27 (52) | +1.08 | — | keep |
| W RSI reclaim | original 3 ATR trail, 91 days: +0.35 (0.50 / 0.14) | 3R, 91 days +0.23 | +0.01 (86; DD 30) | +0.09 | — | fails fresh |

**Fresh totals:**
- A, all but the test model: 308 trades, +0.51 avg R, 156 R.
- B: 304 trades, +0.56 avg R, 169 R.
- Old framework: 165 trades, +0.48 avg R, 80 R.

**Fresh by year:**
- A: 2025 -45 R, 2026 +96 R.
- Old: 2025 -5 R.

**In code (research branch):**
- `LIVE_EXITS` = pooled A / B.
- The weekly 70/63 divergence is flagged `dropped`, so it has no live signals.
- Not on main yet.

### Owner decision (2026-10-04): 6 models live, 4 dropped

Owner: "Yes pull the non productive models, we will attempt re calculating or start from scratch for the dropped ones".

**Live, version A = main exit, B = alternative, from the pooled grid:**
- daily bottom divergence;
- daily triple divergence;
- 4H under-floor;
- weekly bearish divergence;
- weekly top divergence;
- weekly double bottom.

**Dropped:** flagged `dropped` in `RSI_MODELS`, so no live signals. They stay in the code to be re-calculated or rebuilt.
- daily momentum (fresh −0.25);
- weekly RSI reclaim (fresh +0.01);
- daily top divergence (fresh −0.40);
- weekly 70/63 divergence (no exit positive on both coin sets).

Merged to `main` on 2026-10-04. The dashboard RSI signals are display only; nothing trades from them.

### Selective 1h / 15m RSI scalp from the owner's ETH charts (research, run 37202942888)

`--scalp2 --months 24 --to-today --cut-months 8`, 56 research coins, 2024-10 to 2026-10.

**Rules:**
- Lines start from an anchor: an RSI low ≤ 30 (or ≤ 25) that is the lowest of 100 bars (shorts mirrored).
- Entry at a later higher RSI low ≤ 45 (shorts: lower high ≥ 55), 10–500 bars after the anchor.
- Tested first-per-anchor or every entry; with or without price divergence.
- Direction filter: none, daily 200-day SMA, or 4H RSI side.
- Exits: 2R, 3R, RSI to 70 / 30, the next opposite signal, a 3 ATR trail.
- 720 lines in all, each compared with the same trades taken in a random direction (20 seeds).

**Result:**
- Only 1 of 720 lines is positive in both periods with n ≥ 100: 1h short, first per anchor, 4H RSI ≤ 50, anchor ≥ 75, 3R target.
  - +0.10 R a trade at 0.22% cost (34% wins, 282 trades, newer period +0.03); random direction −0.09.
  - One line out of 720 at +0.10 R is about what chance gives.
- Best long line: 1h, −0.08 R a trade over 15,304 trades.
- 15m alone: −0.16 to −0.28 R a trade.
- At 0.10% cost (maker fills), a few lines reach +0.1 to +0.2 R. None comes near the 60% win-rate gate (best 34%).

**Signal frequency:** still 6.7 per coin per month on 1h and 26 on 15m, even first-per-anchor.

**ETH check:** the 1h list (since August) fires at the owner's main longs (Aug 10–11, Sep 2–3, Sep 10–11, Sep 15–16, Sep 23–24) and shorts (Aug 19–21, Sep 18–19). It also fires at others the owner did not mark.

**Verdict:** no bot change. The anchors alone do not make the 1h / 15m RSI lines tradeable after costs.

### WaveTrend [LazyBear] 10 / 21, by itself, with the RSI scalp, and across the live models (research)

Owner 2026-10-04: "test it by itself and across models and time frames". Research coins.

**Runs:**
- 37203887510: 15m / 1h, 24 months, cut 8.
- 37203889190: 4H / daily, 84 months, cut 24.
- 37203890869: the 6 live models, 84 months, cut 24.

**Signals:** a long is wt1 crossing over wt2 at or below 0 / −53 / −60, entering at the next open (shorts mirrored). Stop past the 5-bar extreme ± 0.2 ATR.

**Exits:** 2R, 3R, the opposite cross, or a 3 ATR trail. Direction filter: none, or the daily 200-day SMA. Cost 0.22%, with a random-side baseline.

**By itself:**
- **15m and 1h:** every line is negative (−0.07 to −0.35 R a trade, 6,000 to 157,000 trades).
- **4H:** about 0 at best (long, any level, trail: +0.05 R; older −0.08).
- **Daily long, any level below 0, 3 ATR trail:** +0.20 R over 1,666 trades (28% wins, max drawdown 255 R). Random side gives +0.07, so most of it is the bull-market drift.
- **Daily short at +60 above the 200-day SMA, trail:** +0.52 R, but only 35 trades.
- Nothing is near the 60% win-rate gate.

**As a filter on the 1h / 15m RSI scalp signals:**
- A WaveTrend cross the trade's way in the last 6 bars cuts losses. 1h long divergence with a trail improves from −0.16 to −0.05 R; 15m lines from about −0.40 to −0.30.
- Every line stays negative, except 1h long RSI-trend with wt1 ≤ −53 at the pivot and a trail: +0.02 R (741 trades).

**Across the 6 live models (version A exits, 314 trades, +2.07 R):**
- No WaveTrend condition at entry lifts the set.
  - wt1 above wt2 on the entry timeframe: +1.96 vs +2.28 without.
  - A recent cross: +1.88 vs +2.66 without.
  - As the entry trigger (wait up to 10 bars for a cross): +1.81, below entering as now.
- Trades entered **without** a WaveTrend cross the trade's way in the last 10 bars on the other timeframe did better: +2.88 (117 trades; 4.40 / 1.86) vs +1.58 (197).
  - Triple div: +3.70 vs +0.72.
  - Weekly bearish div: +2.00 vs +0.92.
  - Weekly double bottom goes the other way: +1.06 vs +2.50.
  - Mixed by model, and found after the fact, so it is not adopted.
- Under-floor with a daily wt1 ≤ −53 in the last 10 days: +2.75 R (12 trades) vs +0.01 (22). Small sample.

**Verdict:** WaveTrend does not make a 15m / 1h / 4H model by itself, and does not improve the live models' entries. No bot change.

### RSI pattern catalogue from the owner's write-up (research coins, then fresh coins)

**Runs:**
- Research coins: 37204533389 (1h, 24 months) and 37204535172 (4H / daily, 84 months).
- Fresh coins: 37204603276 (1h) and 37204604777 (4H / daily). 38 coins in neither the research list nor the holdout, rules unchanged.

**Patterns** (both sides, RSI 14):
- oversold reclaim of 30;
- Wilder failure swing;
- RSI double bottom;
- regular divergence, confirmed by RSI closing back over 50;
- hidden divergence;
- midline reclaim after a pullback.

**Regimes from the daily RSI:** none, with trend, range shift, range.

**Exits:** 2R, 3R, 3 ATR trail. Cost 0.22%, with a random-side baseline.

**Write-up stacks:** daily bias, 4H setup, 1H trigger. Best long / short, and exhaustion long / short.

| line | research coins | fresh coins |
|---|---|---|
| 1h short regular div, daily RSI < 50, 3R | +0.26 R (1,050; 0.23 / 0.30; random −0.08) | +0.12 R (682; 0.19 / 0.00; random −0.04) |
| 1h short regular div, daily RSI < 50, 2R | +0.21 (1,067) | +0.09 (692; 0.14 / 0.02) |
| 4H short failure swing, with trend, 3R | +0.26 (373; 0.26 / 0.26) | not in the top lines |
| 1d short failure swing, with trend, 3R | +0.42 (120) | +0.32 (109, no filter, trail; older −0.12) |
| 1d short hidden div, with trend, 3R | +0.10 (392) | +0.25 (185; 0.33 / 0.22) |
| 1d long regular div, trail | +0.41 (238; 0.83 / 0.19; random +0.16) | +0.01 (115, 2R) |
| daily shorts, all patterns, with trend, 3R | +0.09 (1,367) | +0.10 (576) |

**Stacks (1h trigger):**
- best long: −0.10 to −0.27 R on both coin sets;
- best short: −0.01 to −0.12;
- exhaustion lines: about 0 or negative.
- Only the midline-reclaim trigger inside "best long" is near 0 to +0.07 R.

**1h and 4H overall:** every pattern pooled is negative. Regime filters change little.

**Read:**
- The write-up's bearish side carries what edge there is. Regular divergence confirmed by RSI losing 50, failure swings and hidden divergence, with the daily RSI under 50.
- The 1h short divergence halved on fresh coins, and its newer period went to 0.
- The longs and the multi-timeframe stacks do not work after costs.
- Nothing is near the 60% win-rate gate (best about 41–52%).

#### Wider stops on the 1h short regular divergence

Owner: "i could expect stops to be wider on 15m-1h but position size or leverage smaller". Runs 37205502403 (research) and 37205504356 (fresh).

The stop is moved to 1.5x, 2x and 3x the distance; size is scaled down so the stop loss stays 1R. Daily RSI < 50, 3R exit.

| stop | research: n, win %, avg R, max DD R | fresh: n, win %, avg R, max DD R (newer period) |
|---|---|---|
| 1x (about 4–5%) | 1,050, 41%, +0.26, 88 | 682, 37%, +0.12, 54 (+0.00) |
| 1.5x | 972, 46%, +0.20, 74 | 620, 44%, +0.12, 49 (+0.04) |
| 2x | 935, 51%, +0.17, 67 | 587, 49%, +0.10, 34 (+0.01) |
| 3x (12–15%) | 902, 56%, +0.09, 65 | 562, 54%, +0.05, 26 (−0.01) |

**Read:**
- Wider stops lift the win rate (to 54–58% at 3x with a trail) and roughly halve the drawdown in R.
- They lower the R per trade, and do not fix the flat newer period on fresh coins.
- 1.5x–2x is the sensible middle if this line is ever used: about the same R on fresh coins, a smaller drawdown, and about half the leverage.

### RSI Pro+ Suite (RWCS_LTD), each signal by itself and across the live models (research coins)

**Runs:**
- 37205782148: 1h, 24 months.
- 37205783490: 4H / daily, 84 months.
- 37205785247: the 6 live models.

**Setup:** the indicator's defaults:
- signal line: SMA 14 of RSI;
- regime: 50 bars, floor 40 / ceiling 60;
- score: 0–5;
- divergence pivots: 5 / 5.

Each signal is tested by itself, with no filter or with the daily Pro+ regime on the trade's side. Exits: 2R, 3R, trail, or the opposite signal-line cross. Cost 0.22%, with a random-side baseline.

| signal (best line) | 1h | 4H | daily |
|---|---|---|---|
| long flip aligned (cross over signal line, RSI >= 50) | +0.05 (daily regime; older −0.08) | +0.07 | +0.30 (858; 0.02 / 0.49; random +0.19) |
| long flip counter (RSI < 50) | −0.06 | +0.05 | +0.29 (1,492; random +0.16) |
| long pullback end (cross in bull regime) | −0.08 | +0.12 (older −0.06) | +0.01 |
| long score reaches 5/5 | +0.04 | +0.21 (1,623; 0.00 / 0.37; random +0.06) | −0.01 |
| long regime flip to bull | −0.02 | −0.06 | +0.56 (older −0.52; random +0.54) |
| long OS exit (back over 30) | −0.18 | −0.01 | +0.28 (570; 0.34 / 0.22; random +0.03) |
| long regular / hidden div | −0.38 / −0.10 | +0.03 / −0.06 | +0.08 / small samples |
| short flip aligned | −0.03 | +0.03 | +0.10 (1,007; 0.06 / 0.14; random −0.05) |
| short regular div | −0.09 | +0.18 (daily regime; older −0.05) | +0.11 (272; 0.04 / 0.16; random −0.07) |
| short hidden div | −0.06 | −0.05 | +0.16 (older −0.11) |

**What held up:**
- Kept (both periods positive, n ≥ 60, at least 0.1 R over random): 6 of 248 4H / daily lines, and none of the 1h lines.
- **Daily long OS exit with a trail** is the clearest: +0.28 vs random +0.03, in both periods. It is the same as the write-up's daily oversold reclaim; that one was +0.12 on fresh coins with 2R.
- Many daily longs ride the bull drift: random gives +0.16 to +0.19 for the same trades.

**Across the 6 live models (314 trades, +2.07 R):**
- No Pro+ state at entry helps.
  - Score ≥ 4 the trade's way: +0.42 (39 trades).
  - RSI over its signal line: +1.65 vs +2.77 without.
  - Regime against: +1.73 vs +2.27 without.
- The models are reversal entries, so they do best while Pro+ still reads weak. Not adopted.

**Verdict:** no bot change. Daily long OS exit and 4H long score 5 go to a fresh-coin check.

**RSI Pro+ fresh-coin check** (run 37205851966, 4H / daily, 38 fresh coins, rules unchanged):
- **Daily long OS exit, trail:** +0.07 (288; 0.36 / −0.02). Fails.
- **4H long score 5, trail:** +0.11 (761; 0.45 / −0.01). Fails in the newer period.
- **What held:**
  - daily short hidden divergence: +0.14 (215, opposite-cross exit, 0.17 / 0.14, random 0.00); +0.24 with the daily regime (103).
  - 4H short flip aligned with the daily regime: +0.12 (760; 0.16 / 0.11).
- Together with the write-up catalogue, the one theme that repeats on fresh coins is **daily / 4H shorts while the daily trend is down** (hidden divergence, failure swing, regular divergence). Each is +0.1 to +0.3 R a trade with 35–47% wins.

### Downtrend short model (owner: "build the short model and test it")

Runs 37206505957 (research coins, 56) and 37206507545 (fresh coins, 38). 84 months, cut 24.

**Rules:**
- Shorts only, while the daily RSI is under 50.
- Trigger, on 4H or daily: a bearish failure swing, regular divergence (entry when RSI loses 50), or hidden divergence.
- Stop: 1x / 1.5x / 2x the pattern stop, with size scaled so the stop loss stays 1R.
- Exits: 2R, 3R, or a 3 ATR trail.

**Fixed selection rule** (research coins): n ≥ 60, both periods > 0, at least 0.1 R over a random side. 20 of 72 lines kept.

The pick is **daily failure swing, stop 1x, 3R target**:

| | n | win % | avg R | older / newer | max DD R | random |
|---|---|---|---|---|---|---|
| research coins | 131 | 50% | +0.42 | 0.16 / 0.54 | 13.7 | +0.05 |
| fresh coins (one check, no changes) | 59 | 49% | +0.23 | −0.17 (7) / 0.28 (52) | 9.2 | −0.03 |

**Research by year:** 2022 −4.9 R (7 trades), 2023 +11.3, 2024 +20.2, 2025 +10.4, 2026 +17.8 (70% wins).

**Other lines on fresh coins:**
- 4H failure swing, stop 1x, 3R: +0.16 (224; research +0.27, 400). Stop 2x, 2R: +0.15 with 55% wins (218).
- Daily hidden divergence, stop 1x, 3R: +0.22 (180; 2026 −9 R). This was the fresh run's own top line by the same rule.
- All three daily triggers together, stop 1x, 3R: +0.15 (259; 0.12 / 0.16).
- Regular divergence on 4H: negative on fresh coins.

**Read:**
- The failure swing is the core of the model. It holds on both coin sets on daily and 4H, beats random, and wins about 40–57% of trades.
- Samples are small: about 0.4 trades per coin per year on daily.
- Not at the 60% win-rate gate except with a 1.5x–2x stop on fresh coins (55–63%), where it earns less per trade.
- No bot change.

### Owner decision (2026-10-04): failure-swing shorts added to the live RSI signals

Owner: "Yea it can be added".

**New models** (display only, like the other models):
- **Daily failure swing short**: A = stop 1x, 3R; B = 3 ATR trail.
- **4H failure swing short**: A = stop 1x, 3R; B = stop 2x, 2R.
- Both trade only while the daily RSI is under 50.

**Live-engine check** (run 37207196958, research coins, 84 months):
- daily: +0.33 R (143 trades, 48% wins);
- 4H: +0.27 R (401 trades, 40%; B 52% wins).
- Matches the research runs.

**All 8 live models together:**
- 862 trades in 7 years on 56 coins (A exits), +0.97 R a trade.
- 2026 so far: 292 trades, about 1 a day across 56 coins.

**Merged to main on 2026-10-04.**

### Loss post-mortem of the live models (run 37213109618, research coins, 84 months, version A exits)

Owner: "look back at trades taken and figure out when it went wrong ... noise, moves already playing out by the time we enter, or going the wrong way entirely".

848 trades: 323 winners, 476 losers, 49 still open. Avg R +0.72.

| loser type | share of losers | avg MFE before the loss | run before entry |
|---|---|---|---|
| gave it back (reached >= 1R, then stopped) | 36% | +2.28 R | 2.1 ATR |
| time / chop (time limit, or neither below) | 33% | +0.45 R | 2.6 ATR |
| noise stop (stopped < 1R, then +2R the trade's way) | 19% | +0.37 R | 1.9 ATR |
| wrong way (stopped < 0.5R, never back to the entry) | 12% | +0.20 R | 2.6 ATR |

**Per model:**
- **Bottom divergence:** 21 of 29 losers gave back an average +4.6 R before stopping out (20R target). Winners average +20 R.
- **Triple divergence and weekly double bottom:** 44% gave it back.
- **Daily failure-swing short:** 25% wrong way. The 2026-09-16 cluster had 6+ coins shorted the same day into a rally.
- **4H failure-swing short:** 39% time / chop.

**Late entries cost** (all models, by how far price had already run from the 10-bar extreme at entry):

| run before entry | avg R |
|---|---|
| Q1 (0–1.6 ATR) | +1.30 |
| Q2 (1.6–2.2) | +0.97 |
| Q3 (2.2–3.0) | +0.43 |
| Q4 (3.0–8.7) | +0.19 |

- Weekly double bottom: Q3 / Q4 are negative.
- Daily failure swing: Q1 is the best (+0.71, 59% wins).
- Triple divergence goes the other way: Q1 −0.28. It enters on the MACD cross, so it needs some move first.

**Other effects:**
- **Stop width:** the widest quarter (stop > 17.8% from entry) is weakest, +0.22 vs +0.69 to +1.13.
- **BTC trend:** for the 4H failure-swing short, BTC under its 50-day SMA gives +0.35 R vs +0.09 against.

**Read:** most losses are not the idea being wrong (only 12%). They are trades that went the right way and gave it all back, plus late entries after the move had run.

**Candidates to test with fixed rules:**
- a breakeven stop after +2R / +3R;
- skip entries more than 3 ATR from the 10-bar extreme;
- shorts only when BTC is under its 50-day SMA;
- a cap on same-day same-direction entries.

### Post-mortem fixes, plus volume and ADX (runs 37214201044 research, 37214203090 fresh coins; live models, A exits)

Owner: "try some fixes ... wondering if volume and ADX would help or hurt us". Rules fixed before the runs.

All live models, avg R a trade (n, max drawdown R):

| variant | research coins (56) | fresh coins (44) |
|---|---|---|
| base (as live) | +0.95 (848, DD 52.6) | +0.47 (456, DD 42.9) |
| breakeven after +2R close | +0.86 (DD 38.6) | +0.46 (DD 28.9) |
| breakeven after +3R close | +0.92 (DD 47.6) | +0.46 (DD 39.0) |
| skip late (> 3 ATR run before entry) | **+1.16** (657) | **+0.60** (338) |
| BTC filter on shorts (BTC daily < 50-day SMA) | **+1.24** (601) | **+0.56** (324) |
| max 2 entries a day per side | +0.80 (619) | +0.39 (410) |
| signal-bar volume >= 1.5x avg | +0.73 (172) | +0.49 (86) |
| signal-bar volume < 0.8x avg | +1.35 (352) | +0.38 (214) |
| ADX >= 25 | +1.10 (456) | +0.38 (242) |
| ADX < 20 | +0.73 (225) | +0.50 (123) |
| +DI / -DI with the trade | +0.69 (396) | +0.29 (196) |
| +DI / -DI against the trade | +1.17 (452) | +0.61 (260) |
| **combo: BE +2R + skip late + BTC filter** | **+1.38 (479, DD 21.4)** | **+0.67 (250, DD 28.8)** |

**Read:**
- **Skip late and the BTC filter on shorts** help on both coin sets.
- **Breakeven at +2R** keeps the R about the same but cuts the drawdown by about a third.
- **The combo:**
  - lifts R a trade by about 45% on both coin sets;
  - halves the drawdown (research) or cuts it a third (fresh);
  - uses about 45% fewer trades, so total R is lower.
- **Volume and ADX do not help consistently:** low volume and high ADX look good on the research coins and reverse on the fresh coins.
- **+DI / -DI against the trade beats with the trade on both coin sets.** This is the same finding as "early entries win": the models are reversal entries.
- **The daily-cap rule hurts.**
- **Per model:**
  - the daily failure-swing short gets worse with skip late on fresh coins (−0.10);
  - under-floor gets worse with breakeven on fresh coins.
- No bot change yet.

### BTC trend line length for the short filter (2026-10-04, runs 37216559555 research / 37216561291 fresh)
Owner asked to try 25–75 days (step 5) instead of the 50-day SMA for the BTC bull / bear flip. Live models, version A exits.

Shorts only, avg R when BTC is under the line (kept) vs over it (dropped):

| length | research kept | research dropped | fresh kept | fresh dropped |
|---|---|---|---|---|
| 25 | 0.31 | 0.40 | 0.25 | 0.33 |
| 30 | 0.35 | 0.34 | 0.28 | 0.28 |
| 35 | 0.42 | 0.25 | 0.33 | 0.21 |
| 40 | 0.43 | 0.22 | **0.34** | **0.20** |
| 45 | **0.44** | **0.20** | 0.33 | 0.21 |
| 50 | 0.43 | 0.22 | 0.30 | 0.25 |
| 55 | 0.38 | 0.28 | 0.27 | 0.26 |
| 60 | 0.34 | 0.33 | 0.22 | 0.34 |
| 65 | 0.37 | 0.30 | 0.16 | 0.43 |
| 70 | 0.41 | 0.26 | 0.17 | 0.41 |
| 75 | 0.40 | 0.27 | 0.18 | 0.39 |

All live models with "shorts only under" (base +0.95 research / +0.47 fresh): 40-day 1.22 / 0.59, 45-day 1.23 / 0.58, 50-day 1.24 / 0.56, 60-day 1.21 / 0.51, 70-day 1.28 / 0.49.

Longs only while BTC is over the line hurts at every length (50-day: kept 1.91 vs dropped 2.46 research, 0.06 vs 1.77 fresh). The longs are reversal entries and do best when BTC is under its line.

**Read:**
- 35–45 days separates shorts best on both coin sets; 40 is best on fresh, 45 on research.
- 50 (the standard value) is close behind.
- 25–30 does not separate. On fresh coins, 60–75 flips the other way.
- Filter shorts only, never longs.

### The two options, exactly as proposed (2026-10-04, runs 37217556337 research / 37217557856 fresh)
- Option 1 = BTC filter on shorts (50-day) + breakeven at +2R (except under-floor) + skip late (except the daily failure-swing short).
- Option 2 = BTC filter on shorts + breakeven at +2R.

All live models, avg R (trades, max DD R, total R):

| variant | research coins | fresh coins |
|---|---|---|
| base (as live) | +0.95 (848, DD 52.6, 806) | +0.47 (456, DD 42.9, 216) |
| option 1 | **+1.33** (497, DD **22.4**, 664) | **+0.71** (264, DD **25.1**, 187) |
| option 2 | +1.13 (605, DD 32.3, 685) | +0.55 (324, DD 29.3, 177) |
| combo with no exceptions | +1.38 (479, DD 21.4) | +0.67 (250, DD 28.8) |

**Read:**
- Option 1 beats option 2 on both coin sets, on R per trade and on drawdown.
- Option 1 lifts R a trade by 40–50% over the base and halves the drawdown.
- Total R is 8–18% lower, on 40% fewer trades.
- The two exceptions were picked from the fresh-coin results, so their fresh gain (+0.71 vs +0.67) is not independent evidence. On research coins they cost a little (+1.33 vs +1.38).
- Win rate stays at 39–43%, still under the 60% gate. These remain display-only signals.

### Live code check, both rule sets (2026-10-04, runs 37218404258 research / 37218406473 fresh, `--rsi-trades --live-rules`)
`rsiFrameworkSignals` run over history with option 1 and option 1 without exceptions side by side, as the dashboard will show them. Avg R (trades, max DD R):

| rule set, exit version | research coins | fresh coins |
|---|---|---|
| option 1, A (main) | +1.32 (500, DD 23.4) | +0.73 (266, DD 25.1) |
| option 1, B (alt) | +1.27 (494, DD 20.6) | +0.61 (264, DD 23.3) |
| no exceptions, A | +1.37 (482, DD 22.4) | +0.69 (252, DD 28.8) |
| no exceptions, B | +1.32 (476, DD 19.6) | +0.57 (250, DD 29.1) |

- **Matches the fixes test** within 0.02 R: research +1.33 / +1.38, fresh +0.71 / +0.67.
- **Version B** had not been tested with the new rules before. It holds up on both coin sets.
- **The only real split** is the daily failure-swing short on fresh coins: +0.29 with option 1, −0.19 without exceptions (17 trades).

### Random direction, live code (2026-10-04, runs 37225523639 research / 37225525423 fresh)
Same entries, stop distances and exits as the live rules; side by a seeded coin flip, 20 seeds. Edge = real avg R − random avg R.

| rule set, exit | research: real / random / edge | fresh (48 coins): real / random / edge |
|---|---|---|
| option 1, A (main) | +1.32 / +0.41 / **+0.92** | +0.68 / +0.21 / **+0.47** |
| option 1, B (alt) | +1.27 / +0.43 / +0.84 | +0.57 / +0.13 / +0.44 |
| no exceptions, A | +1.37 / +0.42 / +0.95 | +0.64 / +0.20 / +0.44 |
| no exceptions, B | +1.32 / +0.44 / +0.88 | +0.53 / +0.12 / +0.42 |

**Read:**
- Every rule set beats random direction on both coin sets.
- Option 1, version A beats random for every model on both coin sets.
  - On the fresh coins the daily failure-swing short has the smallest edge (+0.09).
  - Weekly top divergence has one fresh-coin trade.
- Without exceptions, the daily failure-swing short loses to random on the fresh coins: −0.37 (A) and −0.21 (B), 18 trades.
- Random direction is positive by itself (+0.2 to +0.4 R) because of the long-dated targets and trails. The edge over it is what counts.
- Under the new gate (owner 2026-10-04: no minimum win rate), option 1 passes: positive on both coin sets, beats random.

### MACD gap filter (2026-10-04, runs 37227885904 research / 37227888089 fresh, `--rsi-trades --macd-gap`)
Owner: "daily shorts and longs look good when MACD is separated 10-15%" (the MACD line vs its signal line).
- Measure: standard 12/26/9 on the daily close, read on the last daily bar closed before the entry. Gap = (MACD − signal) / |MACD|, the trade's way.
- Trades: the live models, option 1, exit A.

Avg R (trades, win %, max DD R):

| group | research coins | fresh coins |
|---|---|---|
| all models, no filter | +1.32 (500, 43%, DD 23) | +0.68 (287, 39%, DD 28) |
| all, gap with the trade >= 10% | +1.25 (155, 50%) | +0.73 (90, 40%); newer period +0.10 |
| all, gap against >= 10% | +1.39 (186) | +0.28 (104) |
| all, gap 10-15% only | +1.29 (20) | +0.40 (9) |
| daily models, no filter | +1.83 (193, 41%, DD 16) | +0.68 (116, 37%, DD 19) |
| daily, gap with >= 15% | +1.54 (72, **54%**, DD **6**) | +1.01 (42, **48%**, DD **4**) |
| daily triple divergence, with >= 15% | +2.47 (17, 65%) vs +1.62 all | +1.46 (10) vs +0.75 all; newer −0.45 (6) |
| daily failure-swing short, with >= 10% | +0.51 (45 of 50) | +0.31 (30 of 33) |

**Read:**
- **Win rate and drawdown:** on the daily models, a MACD gap of 15% or more the trade's way raises the win rate by about 10 points and cuts the drawdown by two thirds on both coin sets. That matches what the owner sees on the chart.
- **R per trade:** mixed. Lower on research, higher on fresh. On the fresh coins the newer period collapses (+0.10 to +0.23).
- **The 10–15% band itself:** too few trades to say (13 research / 5 fresh on the daily models).
- **Daily shorts:** the failure-swing short almost always has the gap already (45 of 50 trades), so the filter changes little there.
- **Daily longs:** the clearest case is the triple divergence. Samples are small, and the fresh newer period is negative.
- **Verdict:** not consistent enough to add as a rule. No bot change.

### MACD gap 5-10% re-attempt (2026-10-04, runs 37228607171 research / 37228608792 fresh)
Owner: "re attempt at 5-10%". Same setup as above. Avg R (trades, win %; newer two years in brackets):

| group | research coins | fresh coins |
|---|---|---|
| all models, no filter | +1.32 (500, 43%) [+0.98] | +0.68 (286, 39%) [+0.43] |
| all, gap with the trade 5-10% | +1.47 (34, 32%) [**−0.13**] | +1.01 (22, 45%) [**−0.26**] |
| all, gap against 5-10% | +0.75 (24) | +0.60 (11) |
| all, gap under 5% either way | +1.40 (99) | +1.26 (56) |
| daily models, gap with 5-10% | +1.66 (28, 29%) [−0.05] | +0.42 (18, 33%) [−0.32] |

**Read:**
- The 5-10% band's averages come from older trades. It loses money in the last two years on both coin sets.
- Win rates are no better than with no filter.
- Not a filter. The gap is now shown with each signal (display only) so it can be watched live.

### MACD pre-crossover and the owner's RSI levels (2026-10-04, runs 37230228998 research / 37230230846 fresh, `--rsi-trades --macd-precross`)
Owner (XRP daily charts): "the MACD pre cross over is the optimal entry ... always some kind of gap". RSI levels drawn at 18.25, 27.08, 32, 39.48, 45.68, 70.60, 77.36.
- Pre-cross = the daily MACD histogram still points against the trade but has shrunk for n days in a row.
- Read at entry on the live models, option 1, exit A.

Avg R (trades, win %):

| group | research coins | fresh coins |
|---|---|---|
| all models, no filter | +1.32 (500, 43%) | +0.71 (280, 39%) |
| all, pre-cross 2+ days | +1.66 (65, 43%, DD 4.6) | +0.45 (40, 43%) |
| all, pre-cross 2+ days, gap >= 10% | +2.63 (33, 55%, DD 2.1) | +0.45 (28, 46%) |
| all, just crossed (3 days) | +1.55 (126) | +0.50 (75) |
| all, crossed earlier | +1.18 (135) | **+1.46** (77) |
| all, against and widening | +1.01 (143) | +0.36 (73) |
| longs, pre-cross 2+ days | +2.78 (31, 35%) | +0.08 (16, 19%) |
| longs, crossed earlier | +1.75 (71) | +1.79 (49) |
| **shorts, no filter** | +0.50 (252, 44%) | +0.44 (138, 47%) |
| **shorts, pre-cross 2+ days** | **+0.64 (34, 50%)**, older +0.98 / newer +0.47 | **+0.70 (24, 58%)**, older +1.64 / newer +0.52 |
| shorts, pre-cross 2+ days, gap >= 10% | +0.82 (18, 61%) | +0.53 (19, 58%) |
| shorts, against and widening | +0.48 (111, 40%) | +0.24 (62, 37%) |

**Read:**
- **Pre-cross overall:** strong on the research coins, weak on the fresh coins. Not a rule for all models.
- **Longs:** the pre-cross fails on fresh coins (+0.08, 16 trades). Longs do best after MACD has already crossed their way (about +1.8R on both sets).
- **Shorts:** the pre-cross holds on both coin sets and both periods.
  - Win rate 50-61% vs 44-47% with no filter, at R as good or better.
  - Samples are small (24-34 trades).
  - Shorts with the MACD gap still widening against them are the weakest group on both sets.
- **RSI zones at entry:** no zone stands out consistently on both coin sets. The owner's levels mark where setups form (the RSI pivots), not where entries happen. Entries sit mostly between 32 and 70.
- **Verdict:** candidate only — shorts on a MACD pre-cross. Watch live before any rule. No bot change.

### MACD gap at entry and MACD divergence (2026-10-04, runs 37231011809 research / 37231013725 fresh, `--rsi-trades --macd-precross`)
Owner: "pre cross is optimal ... having some gap during entry and not at cross over or post cross over", "also consider spotting divergences in the MACD".
- MACD divergence = over the last two daily price pivots before the entry (5 bars before, 2 after), price made a lower (or equal) low while the MACD line made a higher low. Shorts mirror with highs.
- Trades: the live models, option 1, exit A.

Avg R (trades, win %; older / newer two years):

| group | research coins | fresh coins |
|---|---|---|
| all, no filter | +1.32 (500, 43%) | +0.71 (280, 39%) |
| all, MACD gap still open at entry | +1.28 (237) | +0.37 (125) |
| all, at or after the cross | +1.36 (261) | +0.98 (152) |
| **all, MACD divergence** | **+2.38 (71, 41%)** +4.79 / +1.38 | **+2.77 (38, 42%)** +3.06 / +2.62 |
| all, no MACD divergence | +1.15 (429) +1.60 / +0.91 | +0.38 (242) +1.43 / +0.18 |
| longs, MACD divergence | +2.69 (57) | +3.05 (32) |
| longs, no divergence | +2.00 (191) | +0.36 (110), newer −0.07 |
| shorts, MACD divergence | +1.13 (14, 64%) | +1.31 (6, 67%) |
| shorts, no divergence | +0.46 (238) | +0.40 (132) |
| daily models, MACD divergence | +3.59 (43) | +2.15 (18) |
| daily models, no divergence | +1.32 (150) | +0.45 (95) |

**Read:**
- **The gap being open at entry:** no consistent difference on its own (research equal; fresh favours after the cross).
- **MACD divergence:** the strongest confluence found so far. It roughly doubles R per trade on the research coins and is 7x on the fresh coins, in both periods, for longs and shorts. It holds on the 4H models too, measured with the daily MACD.
- **Drawdown:** lower with divergence (research 10 vs 15, fresh 9 vs 24).
- **Trade count:** only 14% of trades have a divergence, so total R is lower as a filter (research 169 vs 661). It suits a boost (bigger size, or priority when max open is full) better than a filter.
- **Divergence and pre-cross together:** too few trades (8 / 2).
- **Verdict:** display it on every signal now. Next test: risk 1.5x-2x on signals with a MACD divergence, vs filtering. No rule change yet.

### MACD divergence boost vs filter (2026-10-04, runs 37232000562 research / 37232002439 fresh)
Each trade's R is scaled by its risk multiple. Totals and drawdown are in base-risk units (1R = 1% today). All live models, option 1, exit A:

| sizing | research: avg R / total R / max DD | fresh: avg R / total R / max DD |
|---|---|---|
| no boost (as live) | 1.32 / 661 / 23.4 | 0.71 / 198 / 27.8 |
| 1.5x risk with a MACD divergence | 1.49 / 746 / 27.8 | 0.89 / 250 / 29.9 |
| 2x risk with a MACD divergence | 1.66 / 831 / 32.2 | 1.08 / 303 / 33.5 |
| 3x risk with a MACD divergence | 2.00 / 1000 / 41.2 | 1.46 / 408 / 41.7 |
| divergence signals only (filter) | 2.38 / 169 / 10.0 | 2.77 / 105 / 9.2 |
| 0.5x risk without a divergence | 0.83 / 415 / 16.1 | 0.54 / 152 / 16.8 |

**Read:**
- **Total R:** the boost raises it on both coin sets (1.5x: +13% research, +27% fresh; 2x: +26% / +53%). Drawdown rises less than total R on fresh coins and a bit more on research.
- **Total R per unit of drawdown:**
  - research: 28 as live, 27 at 1.5x, 26 at 2x;
  - fresh: 7 as live, 8 at 1.5x, 9 at 2x.
- **By side:** longs gain most. Shorts change little (only 14 / 6 shorts have a divergence).
- **The filter:** best R per trade and lowest drawdown, but a quarter of the total R.
- **Candidate:** 1.5x-2x risk on signals with a MACD divergence. Owner's choice; not built into the bot yet.

### MACD divergence on the 15m / 1h RSI scalp (2026-10-04, run 37232788859, `--scalp2`)
Owner: "can we apply [MACD divergence] to 15m 1h rsi strategy and see if there's any improvement".
- MACD 12/26/9 on the signal's own timeframe, last two price pivots before the signal.
- Fixed lines: first per anchor, no direction filter, level 30, families hl / div, exits 3R / trail, 0.22% cost.
- Research coins, 24 months, cut at 8.

| line | all | with a MACD divergence | without |
|---|---|---|---|
| 1h long hl, trail | −0.13 (4484) | **+0.05** (903), older −0.22 / newer +0.41 | −0.18 |
| 1h long div, trail | −0.16 (3164) | −0.01 (1004) | −0.22 |
| 1h short div, trail | −0.11 (2917) | **+0.05** (827), older +0.15 / newer −0.17 | −0.17 |
| 1h short hl, 3R | −0.12 (4431) | −0.12 (715) | −0.12 |
| 15m long hl, 3R | −0.42 (17421) | −0.51 (2928) | −0.41 |
| 15m short hl, trail | −0.39 (17235) | −0.32 (2779) | −0.41 |
| 15m + 1h long div, trail | −0.37 (5139) | −0.46 (1426) | −0.34 |

**Read:**
- **1h:** MACD divergence lifts the trail lines by +0.1 to +0.2 R, to about break-even (+0.05). It is not consistent across periods (positive in one, negative in the other).
- **15m:** no improvement; mostly worse.
- **Boost:** 1.5x-2x on a strategy that loses money loses more.
- **Verdict:** the 15m / 1h scalp stays unprofitable with or without MACD divergence. It does not go live.

### MACD gap 5 / 10 / 15% in our favour on the 15m / 1h scalp (2026-10-04, run 37233270597, `--scalp2`)
Owner: "also try entering with a MACD gap 5-10-15% in our favour".
- Same-timeframe MACD 12/26/9 at the signal bar; gap = (MACD − signal) / |MACD|, the trade's way.
- Same fixed lines as the divergence test. Avg R at 0.22% cost.

| line | all | gap >= 5% for us | >= 10% | >= 15% | 5-10% | 10-15% | under 5% | >= 5% against |
|---|---|---|---|---|---|---|---|---|
| 1h long hl, trail | −0.13 | −0.14 | −0.15 | −0.11 | −0.10 | −0.29 | −0.01 | −0.17 |
| 1h long div, trail | −0.16 | −0.19 | −0.24 | −0.16 | −0.08 | −0.41 | **+0.20** (580) | −0.26 |
| 1h short hl, 3R | −0.12 | −0.10 | −0.08 | −0.04 | −0.23 | −0.28 | −0.21 | −0.10 |
| 1h short div, trail | −0.11 | −0.17 | −0.18 | −0.13 | −0.14 | −0.30 | −0.08 | −0.10 |
| 15m long hl, trail | −0.38 | −0.31 | −0.29 | −0.29 | −0.40 | −0.29 | −0.46 | −0.42 |
| 15m short hl, 3R | −0.39 | −0.32 | −0.30 | −0.27 | −0.42 | −0.42 | −0.38 | −0.45 |
| 15m + 1h short hl, 3R | −0.39 | −0.32 | −0.29 | −0.26 | −0.43 | −0.41 | −0.40 | −0.45 |

**Read:**
- **15m:** a gap of 15% or more in our favour trims the loss by about 0.1 R a trade. Every line still loses 0.26-0.36 R.
- **1h:** no pattern. The bands are mixed and mostly negative.
- **The one positive cell:** 1h long divergence with the trail, gap under 5% (+0.20, 580 trades; older +0.03, newer +0.47). That is entries near the cross, the opposite of the idea, and one cell out of about 200 tested. Likely noise unless it holds on fresh coins.
- **Verdict:** the MACD gap does not make the 15m / 1h scalp profitable. No change.
