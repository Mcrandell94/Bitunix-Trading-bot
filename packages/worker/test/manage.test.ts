import { DEFAULT_TIERS } from '@bot/backtest';
import { describe, expect, test } from 'vitest';
import { planManagement, type ManagedPosition } from '../src/manage';

const MTF = DEFAULT_TIERS.MTF;
const LTF = DEFAULT_TIERS.LTF;
const long: ManagedPosition = { side: 'long', entry: 100, initialStop: 97, qtyInitial: 3, stop: 97, partialsPlaced: false };
const short: ManagedPosition = { side: 'short', entry: 100, initialStop: 103, qtyInitial: 3, stop: 103, partialsPlaced: false };
const base = { trailSwing: null, lastClose: null };

describe('live trade management plan (same as the backtest)', () => {
  test('MTF: right after the fill, rest 1/3 at 1R and 1/3 at 2R', () => {
    expect(planManagement({ ...base, pos: long, qtyNow: 3, plan: MTF })).toEqual([
      { kind: 'place-partials', targets: [{ index: 0, price: 103, qty: 1 }, { index: 1, price: 106, qty: 1 }] },
    ]);
    expect(planManagement({ ...base, pos: short, qtyNow: 3, plan: MTF })).toEqual([
      { kind: 'place-partials', targets: [{ index: 0, price: 97, qty: 1 }, { index: 1, price: 94, qty: 1 }] },
    ]);
  });

  test('breakeven once the first partial has filled, not before', () => {
    const placed = { ...long, partialsPlaced: true };
    expect(planManagement({ ...base, pos: placed, qtyNow: 3, plan: MTF })).toEqual([]);
    expect(planManagement({ ...base, pos: placed, qtyNow: 2, plan: MTF })).toEqual([{ kind: 'move-stop', stop: 100, why: 'breakeven' }]);
    expect(planManagement({ ...base, pos: { ...placed, stop: 100 }, qtyNow: 2, plan: MTF })).toEqual([]); // already there
    expect(planManagement({ ...base, pos: { ...short, partialsPlaced: true }, qtyNow: 2, plan: MTF })).toEqual([{ kind: 'move-stop', stop: 100, why: 'breakeven' }]);
  });

  test('trailing: only after scaling out, only tighter, only below price (above, for shorts)', () => {
    const be = { ...long, partialsPlaced: true, stop: 100 };
    expect(planManagement({ pos: be, qtyNow: 2, plan: MTF, trailSwing: 104, lastClose: 107 })).toEqual([{ kind: 'move-stop', stop: 104, why: 'trail' }]);
    expect(planManagement({ pos: be, qtyNow: 2, plan: MTF, trailSwing: 99, lastClose: 107 })).toEqual([]); // looser: ignored
    expect(planManagement({ pos: be, qtyNow: 2, plan: MTF, trailSwing: 108, lastClose: 107 })).toEqual([]); // above price
    expect(planManagement({ pos: { ...be, qtyInitial: 3 }, qtyNow: 3, plan: MTF, trailSwing: 104, lastClose: 107 })).toEqual([]); // not scaled out
    // Breakeven and a trail in the same step: one move, to the better level.
    expect(planManagement({ pos: { ...long, partialsPlaced: true }, qtyNow: 2, plan: MTF, trailSwing: 102, lastClose: 105 }))
      .toEqual([{ kind: 'move-stop', stop: 102, why: 'trail' }]);
    const sbe = { ...short, partialsPlaced: true, stop: 100 };
    expect(planManagement({ pos: sbe, qtyNow: 2, plan: MTF, trailSwing: 96, lastClose: 93 })).toEqual([{ kind: 'move-stop', stop: 96, why: 'trail' }]);
  });

  test('LTF: a single target, nothing to manage', () => {
    expect(planManagement({ pos: long, qtyNow: 3, plan: LTF, trailSwing: 104, lastClose: 107 })).toEqual([]);
  });
});
