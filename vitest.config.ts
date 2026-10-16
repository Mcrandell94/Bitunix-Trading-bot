import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The full-backtest tests take about 5 s each; with the suite running in parallel (CI included) they went over
    // vitest's default 5 s limit and failed on time, not on their checks.
    testTimeout: 30_000,
  },
});
