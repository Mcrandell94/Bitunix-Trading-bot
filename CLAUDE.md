# CLAUDE.md

Bitunix USDT-perpetuals trading bot. Monorepo of `@bot/*` packages (npm
workspaces, TypeScript strict, vitest). `README.md` is the reference;
`docs/ROADMAP.md` the stage plan.

## Working rules
- No API keys in the repo; keys live in Railway variables only.
- The bot never touches positions or orders it did not open (ownership guard).
- Tests: `TEST_DATABASE_URL=postgres://bot:bot@localhost/bot_test npx vitest run`
  (local Postgres may need `service postgresql start`); `npm run typecheck`.

## Backtesting rules
- Spec: docs/backtest/SPEC.md. Params: config/rules.yaml. Plan: docs/backtest/TASKS.md.
- Never change baseline logic. Every new rule is a flag, default disabled.
- The baseline regression test must pass before any commit.
- Log every backtest run to the run log, including failed variants.
- Never evaluate or tune on the holdout window except in task T13.
- Acceptance metric is net expectancy in R, never win rate alone.
- Reuse existing implementations of swing, sweep, MSS, FVG, bias and RRG; do not reimplement.
