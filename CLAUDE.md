# CLAUDE.md

Bitunix USDT-perpetuals trading bot. Monorepo of `@bot/*` packages (npm
workspaces, TypeScript strict, vitest). `README.md` is the reference;
`docs/ROADMAP.md` the stage plan.

## Working rules
- No API keys in the repo; keys live in Railway variables only.
- The bot never touches positions or orders it did not open (ownership guard).
- Tests: `TEST_DATABASE_URL=postgres://bot:bot@localhost/bot_test npx vitest run`
  (local Postgres may need `service postgresql start`); `npm run typecheck`.

## Owner's strategy guidelines (read first)
- docs/GUIDELINES.md: daily bias, 4H pullback, 1H/15m trigger; RSI 14 everywhere;
  daily 200 SMA regime, 4H 20/50 EMA pullback zones; structure is the arbiter.
  New entry models start from these. Change one thing at a time. Standard
  indicator values only (the ones the crowd watches); never tune periods to odd numbers.
- Paper-trading gate (owner, 2026-10-04: "allow profitable models through with lower
  win rates"): positive expectancy on the research AND fresh coins, in both the older
  and newer period, AND beats random direction. No minimum win rate; a model winning
  under ~50% must make it up with R per winner (show win rate, avg R and drawdown).
- Confluence model (below) is retired; its rules apply only if it is revived.

## Backtesting rules
- Spec: docs/backtest/SPEC.md. Params: config/rules.yaml. Plan: docs/backtest/TASKS.md.
- Never change baseline logic. Every new rule is a flag, default disabled.
- The baseline regression test must pass before any commit.
- Log every backtest run to the run log, including failed variants.
- Never evaluate or tune on the holdout window except in task T13.
- **Holdout lock (owner, 2026-09-27): do not run anything on the 6-month holdout
  until the owner explicitly says so.** Recommending a candidate for it is fine;
  building or running the check is not.
- **The holdout is spent (2026-09-27):** the EMA 50 lead ran on 2026-03-29 →
  2026-09-27 and failed (docs/RESULTS.md). Those months have now been seen;
  they cannot serve as an unseen test again. A new candidate needs fresh,
  unseen data: forward paper trading from now on.
- Acceptance: net expectancy in R and beating random direction; win rate is reported, not gated.
- Reuse existing implementations of swing, sweep, MSS, FVG, bias and RRG; do not reimplement.

## Confluence model rules
- Spec: docs/confluence/SPEC.md. Params: config/confluence.yaml. Plan: docs/confluence/TASKS.md.
- Separate model: never change the existing tiered strategy or its regression test.
- Higher-timeframe values are usable only after their bar closes; the lookahead test must pass before any commit.
- Weights are pre-declared (Stage A) or fitted on train folds only (Stage B). Never tune on test folds or the holdout.
- Hard vetoes sit outside the score and are never averaged away.
- Acceptance metric is out-of-sample net expectancy in R plus the score monotonicity test, never win rate alone.
- Log every run, including failures.
