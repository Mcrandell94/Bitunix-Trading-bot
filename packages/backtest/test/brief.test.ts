// docs/backtest/TASKS.md: T0 (run log), T2 (baseline lock on the synthetic
// market: a change to baseline logic changes the digest and fails here).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { baselineFixture, compareFixtures } from '../src/baseline';
import { defaultConfig } from '../src/index';
import { enabledRules, loadRules } from '../src/rules';
import { appendRunLog, profitFactor, rowFromTrades } from '../src/runlog';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;
const REPO = join(__dirname, '..', '..', '..');

describe('T0: run log', () => {
  test('one JSON line per run, with the required fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog-'));
    const path = join(dir, 'runs.jsonl');
    const row = rowFromTrades({ rulesHash: 'abc', rule: 'baseline', tier: 'MTF', window: { name: 'all', from: '2024-01-01', to: '2025-01-01' }, verdict: 'baseline' }, [{ r: 2 }, { r: -1 }, { r: -1 }]);
    appendRunLog(row, path);
    appendRunLog(row, path);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!);
    for (const k of ['timestamp', 'gitHash', 'rulesHash', 'rule', 'tier', 'params', 'window', 'n', 'expectancyR', 'profitFactor', 'totalR', 'winRate', 'nullPctile', 'randomFilterPctile', 'verdict']) expect(k in parsed || k === 'params').toBe(true);
    expect(parsed.n).toBe(3);
    expect(parsed.totalR).toBe(0);
    expect(parsed.profitFactor).toBe(1);
    expect(parsed.winRate).toBeCloseTo(1 / 3, 6);
  });

  test('profit factor: gross wins over gross losses; null without losers', () => {
    expect(profitFactor([{ r: 3 }, { r: -1 }, { r: -1 }])).toBe(1.5);
    expect(profitFactor([{ r: 3 }])).toBeNull();
    expect(profitFactor([])).toBeNull();
  });
});

describe('rules.yaml', () => {
  test('the committed rules file is the baseline: nothing enabled', () => {
    const { rules, hash } = loadRules(join(REPO, 'config/rules.yaml'));
    expect(enabledRules(rules)).toEqual([]);
    expect(hash).toHaveLength(12);
    expect(rules.exits_htf.active).toBe('E0');
  });

  test('an enabled but unimplemented rule is an error, not a silent no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const p = join(dir, 'rules.yaml');
    writeFileSync(p, 'filters:\n  F2_cost_ratio: {enabled: true}\nexits_htf: {active: E0}\n');
    expect(() => loadRules(p)).toThrow(/F2_cost_ratio/);
    writeFileSync(p, 'filters: {}\nexits_htf: {active: E3_chandelier}\n');
    expect(() => loadRules(p)).toThrow(/E3_chandelier/);
  });
});

describe('T2: baseline lock (synthetic market)', () => {
  const FIXTURE = join(__dirname, 'fixtures', 'baseline-synthetic.json');
  test('MTF and HTF baselines match the committed fixture', () => {
    const data = syntheticMarket(120, 2);
    const symbols = Object.keys(data);
    const actual = baselineFixture(data, defaultConfig(START + 10 * DAY, START + 120 * DAY), symbols);
    if (!existsSync(FIXTURE) || process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const diffs = compareFixtures(expected, actual);
    expect(diffs, `baseline changed:\n${diffs.join('\n')}\n(if intended: UPDATE_FIXTURES=1 npx vitest run brief)`).toEqual([]);
    expect(actual.tiers.MTF.trades).toBeGreaterThan(0);
  });
});

describe('T4: walk-forward folds', () => {
  test('train 12m / test 3m / step 3m; test blocks tile the window and never pass its end', async () => {
    const { makeFolds } = await import('../src/walkforward');
    const from = Date.UTC(2023, 2, 29);
    const to = Date.UTC(2026, 2, 29); // 36 months: 8 folds
    const folds = makeFolds(from, to);
    expect(folds).toHaveLength(8);
    expect(folds[0]!.train).toEqual([from, Date.UTC(2024, 2, 29)]);
    expect(folds[0]!.test).toEqual([Date.UTC(2024, 2, 29), Date.UTC(2024, 5, 29)]);
    for (let i = 1; i < folds.length; i++) expect(folds[i]!.test[0]).toBe(folds[i - 1]!.test[1]);
    expect(folds.at(-1)!.test[1]).toBeLessThanOrEqual(to);
    expect(makeFolds(Date.UTC(2023, 8, 29), to)).toHaveLength(6); // 30 months
  });

  test('the baseline report assigns each trade to the fold its entry falls in', async () => {
    const { makeFolds, walkForwardBaseline } = await import('../src/walkforward');
    const data = syntheticMarket(120, 2);
    const from = START + 10 * DAY;
    const to = START + 120 * DAY;
    // Short folds for the synthetic 110 days: train 2 months, test 1, step 1.
    const folds = makeFolds(from, to, 2, 1, 1);
    const w = walkForwardBaseline(data, defaultConfig(from, to), folds, { train: 1, oosBlock: 1 });
    const mtf = w.find((x) => x.tier === 'MTF')!;
    expect(mtf.folds.length).toBe(folds.length);
    expect(mtf.oos.n).toBe(mtf.folds.reduce((a, f) => a + f.test.n, 0)); // test blocks don't overlap
  });
});
