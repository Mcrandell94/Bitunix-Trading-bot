import { migrate } from '@bot/store';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TEST_DATABASE_URL, freshSchema } from '../../store/test/testDb';
import { applyControl, parseControl, silentLogger } from '../src/index';
import { DEFAULT_RRG_INFLUENCE, loadRrgInfluence, rrgOnAt, sameHistory } from '../src/rrgInfluence';

test('a switch applies from the moment it was flipped', () => {
  const h = [{ at: 0, on: true }, { at: 100, on: false }, { at: 200, on: true }];
  expect([50, 100, 150, 250].map((t) => rrgOnAt(h, t))).toEqual([true, false, false, true]);
  expect(sameHistory(DEFAULT_RRG_INFLUENCE.paper, DEFAULT_RRG_INFLUENCE.live)).toBe(false);
});

describe.skipIf(!TEST_DATABASE_URL)('RRG switches (Postgres)', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  beforeAll(async () => { ({ pool, drop } = await freshSchema()); await migrate(pool); });
  afterAll(async () => drop?.());

  test('defaults: on for paper, off for live; flips are kept as history', async () => {
    expect(await loadRrgInfluence(pool)).toEqual(DEFAULT_RRG_INFLUENCE);
    const deps = { db: pool, log: silentLogger, live: { haltLive: false }, flattenApi: null, now: () => 5_000 };
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'live' }), 'test')).message).toMatch(/ON for live/);
    expect((await applyControl(deps, parseControl({ action: 'rrg-on', scope: 'live' }), 'test')).message).toMatch(/already on/);
    const r = await loadRrgInfluence(pool);
    expect(r.live).toEqual([{ at: 0, on: false }, { at: 5_000, on: true }]);
    expect(r.paper).toEqual(DEFAULT_RRG_INFLUENCE.paper);
  });
});
