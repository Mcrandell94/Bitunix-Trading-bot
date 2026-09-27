// config/rules.yaml: every research rule is a flag, default disabled
// (docs/backtest/SPEC.md). The baseline is everything off. A rule that is
// switched on but not implemented yet is an error, never a silent no-op.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { confluenceConfig, type BacktestConfig } from './types';

export interface RuleFlag { enabled?: boolean; tiers?: string[]; [k: string]: unknown }

export interface Rules {
  risk: Record<string, unknown>;
  costs: Record<string, unknown>;
  execution?: { fill_realism?: boolean };
  filters: Record<string, RuleFlag>;
  exits_htf: Record<string, unknown> & { active: string };
  regime: Record<string, RuleFlag>;
  models: Record<string, RuleFlag>;
  validation: Record<string, unknown>;
}

/** Rules the engine can apply today. Anything else must stay disabled. */
export const IMPLEMENTED: ReadonlySet<string> = new Set<string>(['CONFLUENCE']);

export const DEFAULT_RULES_PATH = 'config/rules.yaml';

export function loadRules(path = DEFAULT_RULES_PATH): { rules: Rules; hash: string; path: string } {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`rules file not found: ${full}`);
  const text = readFileSync(full, 'utf8');
  const rules = parse(text) as Rules;
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  for (const group of ['filters', 'regime', 'models'] as const) {
    for (const [name, r] of Object.entries(rules[group] ?? {})) {
      if (r?.enabled && !IMPLEMENTED.has(name)) throw new Error(`${group}.${name} is enabled in ${path} but not implemented yet`);
    }
  }
  const active = rules.exits_htf?.active ?? 'E0';
  if (active !== 'E0' && !IMPLEMENTED.has(active)) throw new Error(`exits_htf.active = ${active} is not implemented yet`);
  return { rules, hash, path: full };
}

/** Names of the rules currently switched on (empty = the baseline). */
export function enabledRules(rules: Rules): string[] {
  const out: string[] = [];
  for (const group of ['filters', 'regime', 'models'] as const) {
    for (const [name, r] of Object.entries(rules[group] ?? {})) if (r?.enabled) out.push(name);
  }
  if (rules.exits_htf?.active && rules.exits_htf.active !== 'E0') out.push(rules.exits_htf.active);
  if (rules.risk?.portfolio_caps_enabled) out.push('portfolio_caps');
  if (rules.execution?.fill_realism) out.push('fill_realism');
  return out;
}

/** The backtest config with the implemented, enabled rules applied. */
export function applyRules(cfg: BacktestConfig, rules: Rules): BacktestConfig {
  const out = { ...cfg, fillRealism: rules.execution?.fill_realism === true };
  return rules.models?.CONFLUENCE?.enabled ? confluenceConfig(out) : out;
}
