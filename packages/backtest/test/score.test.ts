// docs/confluence/TASKS.md T2: the confluence score's feature pipeline and
// its lookahead test (CI). 1,000 random (coin, t): recomputing every
// component from history truncated at t must match the full history exactly.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { coinFeatures, scoreAt } from '../src/score/components';
import { loadScoreConfig, weightSets } from '../src/score/config';
import { lookaheadCheck, scoreTable, truncateAt } from '../src/score/pipeline';
import type { SymbolData } from '../src/index';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;
const REPO = join(__dirname, '..', '..', '..');
const { config } = loadScoreConfig(join(REPO, 'config/confluence.yaml'));

/** The synthetic market plus 8-hourly funding that swings through both crowded thresholds. */
function market(): Record<string, SymbolData> {
  const m = syntheticMarket(160, 3);
  for (const [k, d] of Object.entries(m)) {
    const funding = [];
    for (let t = START + 8 * 3_600_000, i = 0; t < START + 160 * DAY; t += 8 * 3_600_000, i++) {
      funding.push({ time: t, rate: Math.sin(i / 7 + k.length) * 0.0006 });
    }
    m[k] = { ...d, funding };
  }
  return m;
}

describe('confluence score: config', () => {
  test('the committed config is the spec: model off, weights sum to 1, groups as in SPEC §3', () => {
    expect(config.enabled).toBe(false);
    expect(Object.keys(weightSets(config)).sort()).toEqual(['A1', 'A2']);
    expect(config.groups.H4.components).toEqual(['C1_trend', 'C2_structure', 'C3_location', 'C4_smc_event']);
    expect(config.groups.M15.components).toEqual(['C4_smc_event']);
  });
});

describe('confluence score: T2 pipeline and lookahead', () => {
  const data = market();
  const symbols = Object.keys(data);
  const from = START + 60 * DAY; // daily EMA50 + slope needs ~60 days
  const to = START + 160 * DAY;

  test('one row per 1H close; components are -1/0/+1; S within ±100; BTC has no BTC-regime component', () => {
    const rows = scoreTable(data, 'SOLUSDT', from, to, config);
    expect(rows.length).toBe(100 * 24);
    for (const r of rows) {
      for (const v of Object.values(r.c)) expect([-1, 0, 1]).toContain(v);
      for (const s of Object.values(r.S)) expect(Math.abs(s)).toBeLessThanOrEqual(100 + 1e-9);
    }
    expect(Object.keys(rows[0]!.c)).toContain('MKT.M1_btc_regime');
    expect(Object.keys(scoreTable(data, 'BTCUSDT', from, from + DAY, config)[0]!.c)).not.toContain('MKT.M1_btc_regime');
    // Every component takes more than one value somewhere (the pipeline isn't stuck at 0).
    const all = [...symbols].flatMap((s) => scoreTable(data, s, from, to, config));
    for (const key of Object.keys(rows[0]!.c)) expect(new Set(all.map((r) => r.c[key])).size, key).toBeGreaterThan(1);
  });

  test('lookahead: 1,000 random (coin, t) recomputed from truncated history match exactly', () => {
    const r = lookaheadCheck(data, symbols, from, to, config, 1000, 42);
    expect(r.checked).toBe(1000);
    expect(r.mismatches.slice(0, 5)).toEqual([]);
  }, 180_000);

  test('the check has teeth: reading one 1H bar past t is caught', () => {
    const w = weightSets(config);
    let caught = 0;
    for (let k = 0; k < 40; k++) {
      const t = from + (k * 37 + 5) * 3_600_000;
      const peek = scoreAt(coinFeatures(data, 'SOLUSDT', config), t + 3_600_000, config, w); // one bar in the future
      const known = scoreAt(coinFeatures(truncateAt(data, ['SOLUSDT', 'BTCUSDT'], t), 'SOLUSDT', config), t + 3_600_000, config, w);
      if (JSON.stringify(peek.c) !== JSON.stringify(known.c)) caught++;
    }
    expect(caught).toBeGreaterThan(0);
  }, 120_000);
});
