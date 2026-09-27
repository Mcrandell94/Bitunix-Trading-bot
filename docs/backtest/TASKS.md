# Backtest tasks

Work in order. Report after each done-condition.

- **T0 Test log.** Add an append-only run log (CSV or JSONL): timestamp, git hash, rules.yaml hash, rule/variant, tier, params, window, n, expectancy R, profit factor, total R, win rate, null pctile, random-filter pctile, verdict.
  *Done when:* running the baseline writes one log row.
- **T1 Glossary mapping.** Report which existing functions implement each SPEC §1.2 term.
  *Done when:* I confirm the mapping.
- **T2 Baseline lock.** Run current MTF and HTF baselines on the existing 2-year window; save results as reference fixtures; add a regression test that fails if baseline output changes.
  *Done when:* regression test passes and fixtures are committed.
- **T3 Fill-realism audit.** (a) Limit fills require trade-through by ≥ 1 tick. (b) Stops fill at worse of stop or bar open, plus slippage. (c) Intrabar stop-vs-target resolved with 15m data. (d) List every trade with loss > 3R, showing entry, stop, fill price, bar OHLC, and whether the fill came from open, stop, or close.
  *Done when:* audit report produced; realism changes behind a flag; new baseline recorded separately from old.
- **T4 Data extension.** Extend backtests to all 36 months; implement walk-forward and holdout split per SPEC §6.
  *Done when:* baseline walk-forward report produced; holdout untouched.
- **T5 Random-entry null.** Implement per SPEC §6.
  *Done when:* baseline percentile vs null is reported for MTF and HTF.
- **T6 Random-filter benchmark + Monte Carlo drawdown.** Implement both.
  *Done when:* the 5 already-adopted filters (min stop distance, FVG-only, displacement ≥ 1.2 ATR, both bias TFs agree, 3-bar swings) are re-scored and reported.
- **T7 Portfolio caps.** Implement caps per SPEC §6 behind `portfolio_caps_enabled`.
  *Done when:* report shows baseline with and without caps.
- **T8 Filters F1 → F8.** Implement and evaluate one at a time, in order, each alone against baseline, then F1+F2 combined.
  *Done when:* each has a logged verdict with plateau check.
- **T9 HTF exit grid.** First produce MFE/MAE report: per trade MFE, MAE (R), bar reached, and whether 1R/1.5R/2R/3R/5R hit before −1R. Then evaluate E1–E8.
  *Done when:* MFE/MAE report plus logged verdict per exit variant.
- **T10 Regime data check.** Report how far back OKX OI and L/S history can be paged per coin. Implement F&G loader with previous-day alignment.
  *Done when:* coverage table produced; R3–R5 marked `paper_only` where coverage < train window.
- **T11 Regime filters R1 → R5.** Evaluate those with sufficient coverage.
- **T12 NP-15.** Implement as a separate model only after T8–T9 are complete.
- **T13 Holdout.** Run the final chosen configuration once on the holdout.

---
