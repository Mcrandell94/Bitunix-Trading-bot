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
