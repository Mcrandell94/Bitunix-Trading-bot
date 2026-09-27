// Append-only log of every backtest run (docs/backtest/TASKS.md, T0): one
// JSON line per evaluated variant and window, failures included. Committed
// when run locally; uploaded as an artifact from GitHub Actions.

import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Trade } from './types';

export const RUN_LOG_PATH = 'research/runs.jsonl';

export interface RunLogRow {
  timestamp: string;
  gitHash: string | null;
  rulesHash: string | null;
  /** 'baseline', a research candidate label, or a rules.yaml rule id. */
  rule: string;
  variant?: string;
  tier: string;
  params?: Record<string, unknown>;
  window: { from: string; to: string; name: string };
  n: number;
  expectancyR: number | null;
  profitFactor: number | null;
  totalR: number;
  winRate: number | null;
  nullPctile: number | null;
  randomFilterPctile: number | null;
  verdict: 'holds' | 'fails' | 'info' | 'error' | 'baseline';
  error?: string;
}

export function gitHash(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try { return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

/** Gross profit / gross loss in R; null with no losers (or no trades). */
export function profitFactor(trades: ReadonlyArray<Pick<Trade, 'r'>>): number | null {
  let win = 0;
  let loss = 0;
  for (const t of trades) if (t.r >= 0) win += t.r; else loss -= t.r;
  return trades.length === 0 || loss === 0 ? null : win / loss;
}

export function rowFromTrades(
  base: Omit<RunLogRow, 'timestamp' | 'gitHash' | 'n' | 'expectancyR' | 'profitFactor' | 'totalR' | 'winRate' | 'nullPctile' | 'randomFilterPctile'>
    & Partial<Pick<RunLogRow, 'nullPctile' | 'randomFilterPctile'>>,
  trades: ReadonlyArray<Pick<Trade, 'r'>>,
): RunLogRow {
  const n = trades.length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;
  return {
    timestamp: new Date().toISOString(), gitHash: gitHash(),
    ...base,
    n, expectancyR: n ? totalR / n : null, profitFactor: profitFactor(trades), totalR, winRate: n ? wins / n : null,
    nullPctile: base.nullPctile ?? null, randomFilterPctile: base.randomFilterPctile ?? null,
  };
}

export function appendRunLog(rows: RunLogRow | RunLogRow[], path = process.env.RUN_LOG_PATH ?? RUN_LOG_PATH): void {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return;
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  appendFileSync(full, `${list.map((r) => JSON.stringify(r)).join('\n')}\n`);
}
