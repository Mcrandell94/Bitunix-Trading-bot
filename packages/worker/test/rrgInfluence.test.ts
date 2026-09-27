import { migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { applyControl, parseControl, silentLogger } from '../src/index';
import { DEFAULT_RRG_INFLUENCE, loadRrgInfluence, rrgOnAt, rrgRankAt, rrgRankNow, sameHistory } from '../src/rrgInfluence';

test('a switch applies from the moment it was flipped', () => {
  const h = [{ at: 0, on: true }, { at: 100, on: false }, { at: 200, on: true }];
  expect([50, 100, 150, 250].map((t) => rrgOnAt(h, t))).toEqual([true, false, false, true]);
  expect(sameHistory(DEFAULT_RRG_INFLUENCE.paper, DEFAULT_RRG_INFLUENCE.live)).toBe(true);
  expect(sameHistory([{ at: 0, on: false }], [{ at: 0, on: false }, { at: 9, on: true }])).toBe(false);
});

test('how the switch ranks: old flips without a method mean position; off = null', () => {
  const h = [{ at: 0, on: false }, { at: 100, on: true }, { at: 200, on: true, by: 'heading' as const }, { at: 300, on: false }];
  expect([50, 150, 250, 350].map((t) => rrgRankAt(h, t))).toEqual([null, 'position', 'heading', null]);
  expect(rrgRankNow(h.slice(0, 3))).toBe('heading');
  // Same flips but a different method: paper and live need their own replays.
  expect(sameHistory([{ at: 5, on: true, by: 'heading' }], [{ at: 5, on: true, by: 'fastslow' }])).toBe(false);
  expect(sameHistory([{ at: 5, on: true }], [{ at: 5, on: true, by: 'position' }])).toBe(true);
  expect(parseControl({ action: 'rrg-on', scope: 'paper', by: 'fastslow' })).toEqual({ action: 'rrg-on', scope: 'paper', by: 'fastslow' });
  expect(() => parseControl({ action: 'rrg-on', scope: 'paper', by: 'best' })).toThrow(/position, heading or fastslow/);
});

describe.skipIf(!TEST_DATABASE_URL)('RRG switches (Postgres)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => { ({ pool, drop } = await freshSchema()); await migrate(pool); });
  afterAll(async () => drop?.());

  test('defaults: off for paper and live; flips are kept as history', async () => {
    expect(await loadRrgInfluence(pool)).toEqual(DEFAULT_RRG_INFLUENCE);
    const deps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => 5_000 };
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'live' }), 'test')).message).toMatch(/ON for live, by position/);
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'live' }), 'test')).message).toMatch(/already ranks by position/);
    const r = await loadRrgInfluence(pool);
    expect(r.live).toEqual([{ at: 0, on: false }, { at: 5_000, on: true, by: 'position' }]);
    expect(r.paper).toEqual(DEFAULT_RRG_INFLUENCE.paper);
  });

  test('switching the ranking method is a new dated flip; repeating it is a no-op', async () => {
    let t = 10_000;
    const deps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => t };
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'paper', by: 'heading' }), 'test')).message).toMatch(/ON for paper, by heading/);
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'paper', by: 'heading' }), 'test')).message).toMatch(/already ranks by heading/);
    t = 20_000;
    await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'paper', by: 'fastslow' }), 'test');
    t = 30_000;
    await applyControl(deps, parseControl({ action: 'rrg-off', scope: 'paper' }), 'test');
    const h = (await loadRrgInfluence(pool)).paper;
    expect(h.slice(1)).toEqual([{ at: 10_000, on: true, by: 'heading' }, { at: 20_000, on: true, by: 'fastslow' }, { at: 30_000, on: false }]);
    expect([15_000, 25_000, 35_000].map((x) => rrgRankAt(h, x))).toEqual(['heading', 'fastslow', null]);
  });
});
