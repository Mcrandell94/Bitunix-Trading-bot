import { DEFAULT_TIERS, botConfig } from '@bot/backtest';
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

  describe('EMA 50 strategies: ATR trail and time stop (same as the engine)', () => {
    const ema = botConfig(0, 0, 'ema50').tiers;
    // Stop 2 ATR below entry (ATR 2): 1R = 4.
    const pos: ManagedPosition = { side: 'long', entry: 100, initialStop: 96, qtyInitial: 10, stop: 96, partialsPlaced: true };

    test('target 1 ATR (default): out at market after 24 daily bars, not before', () => {
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.MTF, barsHeld: 23 })).toEqual([]);
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.MTF, barsHeld: 24 })).toEqual([{ kind: 'close', why: 'time' }]);
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.MTF, barsHeld: null })).toEqual([]); // no daily close this step
    });

    test('4H EMA crossover (HTF slot): half at 1.6R, then out at market when EMA 5 closes back through EMA 12', () => {
      expect(planManagement({ ...base, pos: { ...pos, partialsPlaced: false }, qtyNow: 10, plan: ema.HTF })).toEqual([
        { kind: 'place-partials', targets: [{ index: 0, price: 106.4, qty: 5 }] },
      ]);
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.HTF, emaCross: false })).toEqual([]);
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.HTF, emaCross: null })).toEqual([]); // no 4H close this step
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.HTF, emaCross: true })).toEqual([{ kind: 'close', why: 'ema' }]);
      // Plans without an EMA exit ignore the input.
      expect(planManagement({ ...base, pos, qtyNow: 10, plan: ema.MTF, emaCross: true })).toEqual([]);
      // After TP1 the stop steps to entry + 0.2R (a best price of 1.6R reached).
      expect(planManagement({ ...base, pos, qtyNow: 5, plan: ema.HTF, best: { extreme: 107, close: 106 } })).toEqual([{ kind: 'move-stop', stop: 100.8, why: 'breakeven' }]);
    });

  });

  test('pullback slots: the stop moves to entry + 0.2R (4H) / + 0.25R (1H) only once the first target is reached; only tighter, only below price', () => {
    const tiers = botConfig(0, 0, 'ema50').tiers;
    const pos: ManagedPosition = { side: 'long', entry: 100, initialStop: 96, qtyInitial: 10, stop: 96, partialsPlaced: true };
    const at = (plan: typeof tiers.P4H, extreme: number, close: number, stop = 96) => planManagement({ pos: { ...pos, stop }, qtyNow: 10, plan, trailSwing: null, lastClose: close, best: { extreme, close } });
    expect(at(tiers.P4H, 106, 105)).toEqual([]); // +1.5R: first target (1.6R) not reached, no overlap band
    expect(at(tiers.P4H, 106.4, 105)).toEqual([{ kind: 'move-stop', stop: 100.8, why: 'breakeven' }]);
    expect(at(tiers.P4H, 106.4, 105, 101)).toEqual([]); // already tighter
    expect(at(tiers.P4H, 106.4, 100.5)).toEqual([]); // would sit above price
    expect(at(tiers.P1H, 105.7, 104)).toEqual([{ kind: 'move-stop', stop: 101, why: 'breakeven' }]); // 1.4R -> entry + 0.25R
  });

  test('pullback slots: the time stop only fires without follow-through (best < +0.5R), with a hard cap at 3x', () => {
    const p1h = botConfig(0, 0, 'ema50').tiers.P1H;
    const pos: ManagedPosition = { side: 'long', entry: 100, initialStop: 96, qtyInitial: 10, stop: 96, partialsPlaced: true };
    const run = (extreme: number, bars: number) => planManagement({ pos, qtyNow: 10, plan: p1h, trailSwing: null, lastClose: 100, atrTrail: { extreme, atr: 1 }, barsHeld: bars });
    expect(run(101, 15)).toEqual([{ kind: 'close', why: 'time' }]); // +0.25R after 15 bars: out
    expect(run(103, 15).some((a) => a.kind === 'close')).toBe(false); // +0.75R: let it run
    expect(run(103, 45)).toEqual([{ kind: 'close', why: 'time' }]); // hard cap
  });
});
