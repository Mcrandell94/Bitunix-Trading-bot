# Confluence model tasks

Work in order. Report after each done-condition.

- **T0 Harness check.** Confirm which parts of the backtest harness already exist (run log, fill realism, walk-forward, random-entry null, random-filter benchmark, Monte Carlo) and reuse them. Build only what's missing.
  *Done when:* list of reused vs. new harness parts reported.
- **T1 Glossary mapping.** Report the existing function for each SPEC §1.3 term.
  *Done when:* I confirm the mapping.
- **T2 Feature pipeline + lookahead test.** Build a per-coin table of all components and S at every 1H close. Lookahead test: for 1,000 random (coin, t), recompute every component using data truncated at t; values must equal the full-history pipeline exactly.
  *Done when:* lookahead test passes with zero mismatches; test added to CI.
- **T3 Component diagnostics.** For each component and group: frequency of +1/0/−1, pairwise correlation matrix, and forward 1H-bar-close returns over 4, 12 and 24 hours conditional on the value (train folds only).
  *Done when:* diagnostics report produced; pairs with |ρ| > 0.7 flagged for my decision.
- **T4 Score distribution.** Histogram of S per coin and overall; share of decision times with |S| ≥ 40, 50, 60, 70; expected trade counts per train window for Mode X at each t_entry.
  *Done when:* report shows which t_entry values meet ≥ 100 trades per train window.
- **T5 Stage A backtest.** Run Mode X with weight sets A1 and A2 across the t_entry grid, walk-forward.
  *Done when:* per-fold results logged, including monotonicity test and benchmarks (a)–(c).
  *Result (2026-09-27, run 36302829309, 52 coins, 2023-03-29 → 2026-03-29):* **fails.**
  Walk-forward out of sample 252 trades, +0.012R/trade, +2.9R total (fold 8 alone +17.3R;
  without it −14.4R). No config reached 100 train trades in any fold. Higher scores did
  not do better (Spearman > 0 in 2/8 folds A1, 3/8 A2). Random direction p95 24.5R vs
  real 2.9R. Real score below the shuffled-score median for every config with trades
  (18–45th pct). Monte Carlo DD p95 36.7%. Beat MTF (−0.058R) only because MTF lost.
- **T6 Ablation.** Group-level, then component-level, on the better Stage A set.
  *Done when:* removal recommendations reported with fold counts.
- **T7 Mode Y.** Run the score-cross variant with the post-ablation configuration.
  *Done when:* Mode X vs. Mode Y comparison logged.
- **T8 Score exit variant.** Evaluate `score_exit.enabled: true` against the default exits.
  *Done when:* comparison logged.
- **T9 Stage B.** Fit logistic weights per SPEC §6, walk-forward, with sign-stability check.
  *Done when:* Stage B vs. best Stage A per-fold comparison and coefficient table reported.
- **T10 Score-scaled sizing.** Only if the chosen configuration passed SPEC §7. Evaluate per SPEC §8.
- **T11 Holdout.** Run the single final configuration once on the holdout and report.

---
