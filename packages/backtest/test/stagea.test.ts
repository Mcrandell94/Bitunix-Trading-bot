// docs/confluence/TASKS.md T5: Stage A (Mode X) pieces.
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultConfig, runBacktest, type Trade } from '../src/index';
import { loadScoreConfig } from '../src/score/config';
import { scoreTable } from '../src/score/pipeline';
import {
  layerKeys, marketOutcomes, modeXConfig, monotonicity, monteCarloDrawdown, randomEntryNull, scoreGate, scoreLookup,
  scoreTrades, shuffledScore, spearman, walkForwardSelect, type Scored,
} from '../src/score/stagea';
import { makeFolds } from '../src/walkforward';
import { START } from './market';
import { syntheticMarket } from './synthetic';

const DAY = 86_400_000;
const H = 3_600_000;
const REPO = join(__dirname, '..', '..', '..');
const { config } = loadScoreConfig(join(REPO, 'config/confluence.yaml'));

describe('Mode X config (SPEC §4, §5)', () => {
  const c = modeXConfig(defaultConfig(0, 1), config);
  test('the MTF slot alone, bias off, the §5 exits, the §4 vetoes, flat 1% risk', () => {
    expect([c.tiers.LTF.enabled, c.tiers.MTF.enabled, c.tiers.HTF.enabled]).toEqual([false, true, false]);
    expect(c.tiers.MTF).toMatchObject({
      entryTf: '1h', bias: 'off', expiryBars: 8, rewardR: 8, breakevenAtR: null, trailTf: null, cancelOn1RTouch: true, cancelOnZoneClose: true,
      stopSteps: [{ atR: 1, toR: -0.5 }, { atR: 2, toPct: 0.1 }],
      chandelier: { activateR: 2, atrTf: '4h', atrLen: 22, mult: 3 },
      timeStop: { barTf: '1h', checkBars: 48, minMfeR: 1, maxBars: 240 },
    });
    expect(c.minStopPct).toBeCloseTo(0.6667, 3);
    expect(c).toMatchObject({ fillRealism: true, fundingFillBlackoutMinutes: 15, portfolio: { maxOpenRiskPct: 6, maxSameDirAlts: 2 } });
    expect(c.risk.tiers.MTF).toMatchObject({ riskPct: 1, dailyLossPct: 8 });
  });
});

describe('score gate on the real strategy (synthetic market)', () => {
  const data = syntheticMarket(160, 4);
  const from = START + 40 * DAY;
  const to = START + 160 * DAY;
  const mx = modeXConfig(defaultConfig(from, to), config);
  const tables = Object.fromEntries(Object.keys(data).map((s) => [s, scoreTable(data, s, from - 7 * DAY, to, config)]));
  const lookup = scoreLookup(tables, 'A1');
  const all = runBacktest(data, mx, undefined, { closeAtEnd: true, gate: scoreGate(null, 0) });
  const gated = runBacktest(data, mx, undefined, { closeAtEnd: true, gate: scoreGate(lookup, 30) });

  test('a string rejects every setup; accepting tags each trade with its MSS close (a 1H close)', () => {
    expect(runBacktest(data, mx, undefined, { closeAtEnd: true, gate: () => 'no' }).trades).toHaveLength(0);
    expect(all.trades.length).toBeGreaterThan(0);
    for (const t of all.trades) {
      expect(t.tag! % H).toBe(0);
      expect(t.tag!).toBeLessThanOrEqual(t.openedAt);
    }
  }, 30_000);

  test('the gate only admits trades whose score at the MSS close passes the threshold', () => {
    const s = scoreTrades(gated.trades, lookup);
    expect(s).toHaveLength(gated.trades.length);
    expect(s.every((x) => x.score >= 30)).toBe(true);
    expect(gated.trades.length).toBeLessThan(all.trades.length);
  });

  test('market outcomes: both directions for each key, same stop distance', () => {
    const keys = all.trades.slice(0, 5).map((t) => ({ symbol: t.symbol, hour: Math.floor(t.openedAt / H) * H, stopPct: Math.abs(t.entry - t.initialStop) / t.entry }));
    const out = marketOutcomes(data, mx, keys);
    for (const k of keys) {
      const o = out.get(`${k.symbol}|${k.hour}`);
      expect(o?.long).toBeDefined();
      expect(o?.short).toBeDefined();
    }
  }, 30_000);
});

describe('statistics', () => {
  test('spearman', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2], [5, 5])).toBeNaN();
    expect(spearman([1], [1])).toBeNaN();
  });

  const folds = makeFolds(Date.UTC(2023, 0, 1), Date.UTC(2025, 0, 1));
  const at = (f: number) => folds[f]!.test[0] + DAY;

  test('monotonicity buckets aligned scores and counts folds with rho > 0', () => {
    const cands: Scored[] = folds.flatMap((f, i) => [25, 45, 65, 85, 100, 10].map((score) => ({
      symbol: 'SOLUSDT', openedAt: at(i), side: 'long' as const, mssTime: 0, score, r: i === 0 ? -score / 100 : score / 100,
    })));
    const m = monotonicity(cands, folds);
    expect(m.folds[0]!.buckets.map((b) => b.n)).toEqual([1, 1, 1, 2]);
    expect(m.folds[0]!.rho).toBeCloseTo(-1);
    expect(m.positive).toBe(folds.length - 1);
  });

  test('walk-forward selection takes the best train expectancy with enough trades', () => {
    const f = folds[0]!;
    const tr = (openedAt: number, r: number) => ({ openedAt, r } as Trade);
    const many = (n: number, r: number, t: number) => Array.from({ length: n }, () => tr(t, r));
    const runs = [
      { weightSet: 'A1', threshold: 30, trades: [...many(100, 0.1, f.train[0]), ...many(3, -1, f.test[0])] },
      { weightSet: 'A2', threshold: 50, trades: [...many(99, 1, f.train[0]), ...many(3, 2, f.test[0])] }, // too few train trades
    ];
    const w = walkForwardSelect(runs, [f], 100);
    expect(w.rows[0]!.chosen).toEqual({ weightSet: 'A1', threshold: 30 });
    expect(w.oos.totalR).toBe(-3);
  });

  test('layers keep keys on one coin apart', () => {
    const k = (symbol: string, hour: number) => ({ symbol, hour, stopPct: 0.01 });
    const layers = layerKeys([k('A', 0), k('A', 5 * H), k('B', H), k('A', 20 * H)], 10 * H);
    expect(layers.map((l) => l.map((x) => `${x.symbol}${x.hour / H}`))).toEqual([['A0', 'B1', 'A20'], ['A5']]);
  });

  test('random-entry null: draws sit between all-short and all-long, the real trades are ranked against them', () => {
    const trades = Array.from({ length: 50 }, (_, i) => ({ symbol: 'S', openedAt: i * 10 * H, r: 2 } as Trade));
    const outcomes = new Map(trades.map((t) => [`S|${t.openedAt}`, { long: 1, short: -1 }]));
    const n = randomEntryNull(trades, outcomes, 200, () => 1);
    expect(n.covered).toBe(50);
    expect(n.random.p95).toBeLessThan(50);
    expect(n.random.p95).toBeGreaterThan(0);
    expect(n.random.pctile).toBe(1);
    expect(n.biasDirected!.p95).toBe(50);
  });

  test('shuffled score: an informative score beats its shuffles, a useless one does not', () => {
    const times = Array.from({ length: 400 }, (_, i) => i * H);
    const s = times.map((_, i) => ((i * 37) % 200) - 100);
    const lookup = new Map([['S', new Map(times.map((t, i) => [t, s[i]!]))]]);
    const fold = [{ index: 1, train: [0, 0] as [number, number], test: [0, 1e15] as [number, number] }];
    const mk = (r: (score: number) => number): Scored[] => times.map((t, i) => ({ symbol: 'S', openedAt: t, side: 'long', mssTime: t, score: s[i]!, r: r(s[i]!) }));
    expect(shuffledScore(mk((x) => x / 50), lookup, 40, fold, 200).pctile).toBe(1);
    expect(shuffledScore(mk(() => 0.1), lookup, 40, fold, 200).pctile).toBeLessThan(0.95);
  });

  test('Monte Carlo drawdown: all losers compound down, all winners have none', () => {
    expect(monteCarloDrawdown([1, 1, 1], 1, 100).p95).toBe(0);
    expect(monteCarloDrawdown([-1, -1, -1, -1], 1, 100).p95).toBeCloseTo((1 - 0.99 ** 4) * 100, 6);
  });
});
