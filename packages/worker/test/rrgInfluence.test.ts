import { migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { applyControl, parseControl, silentLogger } from '../src/index';
import { DEFAULT_RRG_INFLUENCE, loadRankSlots, loadRrgInfluence, rankSlotOnAt, rrgOnAt, rrgRankAt, rrgRankNow, sameHistory } from '../src/rrgInfluence';

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

test('each strategy uses the ranking card only while its own switch is on (off until first switched on)', () => {
  expect(rankSlotOnAt([], 5)).toBe(false);
  const h = [{ at: 100, on: true }, { at: 200, on: false }];
  expect([50, 150, 250].map((t) => rankSlotOnAt(h, t))).toEqual([false, true, false]);
  expect(parseControl({ action: 'rank-slot-on', scope: 'P4H' })).toEqual({ action: 'rank-slot-on', scope: 'P4H' });
  expect(() => parseControl({ action: 'rank-slot-on', scope: 'live' })).toThrow(/LTF, MTF, HTF, P4H or P1H/);
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

  test('per-strategy ranking switches: dated flips, repeats are no-ops, other strategies untouched', async () => {
    let t = 50_000;
    const deps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => t };
    expect(Object.values(await loadRankSlots(pool)).every((h) => h.length === 0)).toBe(true);
    expect((await applyControl(deps, parseControl({ action: 'rank-slot-on', scope: 'P4H' }), 'test')).message).toMatch(/now uses the RRG ranking card/);
    expect((await applyControl(deps, parseControl({ action: 'rank-slot-on', scope: 'P4H' }), 'test')).message).toMatch(/already uses/);
    t = 60_000;
    await applyControl(deps, parseControl({ action: 'rank-slot-off', scope: 'P4H' }), 'test');
    const s = await loadRankSlots(pool);
    expect(s.P4H).toEqual([{ at: 50_000, on: true }, { at: 60_000, on: false }]);
    expect(s.MTF).toEqual([]);
    expect([55_000, 65_000].map((x) => rankSlotOnAt(s.P4H, x))).toEqual([true, false]);
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
