// config/confluence.yaml (docs/confluence/SPEC.md): the confluence score model's parameters.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export type GroupName = 'D' | 'H4' | 'H1' | 'M15' | 'MKT';
export type ComponentName = 'C1_trend' | 'C2_structure' | 'C3_location' | 'C4_smc_event' | 'M1_btc_regime' | 'M2_rotation' | 'M3_funding';

export interface ScoreConfig {
  model: string;
  enabled: boolean;
  components: {
    C1_trend: { ema_len: number; slope_lookback_bars: number };
    C2_structure: { swings_compared: number };
    C3_location: { discount_max: number; premium_min: number };
    C4_smc_event: { lookback_bars: number; displacement_atr: number; body_ratio: number };
    M1_btc_regime: { uses: string; timeframe: string };
    M2_rotation: { timeframe: string; bullish: string[]; bearish: string[] };
    M3_funding: { mean_of_last: number; long_crowded_pct: number; short_crowded_pct: number };
  };
  groups: Record<GroupName, { timeframe: string; components: ComponentName[] }>;
  weights: { active: string } & Record<string, Record<GroupName, number> | string>;
  entry: { mode: 'X' | 'Y'; t_entry: number; t_reset: number; grid: { t_entry: number[] } } & Record<string, unknown>;
  [k: string]: unknown;
}

export const CONFLUENCE_CONFIG_PATH = 'config/confluence.yaml';

export function loadScoreConfig(path = CONFLUENCE_CONFIG_PATH): { config: ScoreConfig; hash: string } {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`confluence config not found: ${full}`);
  const text = readFileSync(full, 'utf8');
  const config = parse(text) as ScoreConfig;
  for (const [name, w] of Object.entries(weightSets(config))) {
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new Error(`weights.${name} sum to ${sum}, not 1`);
  }
  return { config, hash: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

/** The weight sets (A1, A2, ...) in the config. */
export function weightSets(config: ScoreConfig): Record<string, Record<GroupName, number>> {
  return Object.fromEntries(Object.entries(config.weights).filter(([k, v]) => k !== 'active' && typeof v === 'object')) as Record<string, Record<GroupName, number>>;
}
