// Live trade management: the bot's own positions follow the same plan as
// the backtest and paper replay (TierPlan):
// - partial targets rest on the book right after the fill, as POST_ONLY
//   limits (always maker): MTF 1/3 at 1R and 1/3 at 2R;
// - once the first partial has filled, the stop moves to breakeven;
// - after that, at each close of the trail timeframe (MTF 4H), the stop
//   trails to the latest confirmed swing, only ever tightening;
// - the rest exits at the target attached to the entry, or the stop;
// - plans with an ATR trail (plan.chandelier) move the stop to the best price
//   since entry minus mult x ATR once activateR is reached, at each close of
//   the ATR timeframe; plans with a time stop close at market after maxBars.
// The decisions are pure (planManagement); executor.ts applies them.

import type { TierPlan } from '@bot/backtest';

export interface ManagedPosition {
  side: 'long' | 'short';
  entry: number;
  initialStop: number;
  qtyInitial: number;
  /** Where the stop is now. */
  stop: number;
  partialsPlaced: boolean;
}

export type ManageAction =
  | { kind: 'place-partials'; targets: { index: number; price: number; qty: number }[] }
  | { kind: 'move-stop'; stop: number; why: 'breakeven' | 'trail' | 'atr-trail' }
  /** Close at market (the plan's time stop). */
  | { kind: 'close'; why: 'time' };

export interface ManageInput {
  pos: ManagedPosition;
  /** Size still open on the exchange. */
  qtyNow: number;
  plan: TierPlan;
  /**
   * The latest confirmed swing on the trail timeframe (low for a long, high
   * for a short), only when that timeframe's bar closed at this step.
   */
  trailSwing: number | null;
  /** Last close, to keep a trailed stop on the right side of price. */
  lastClose: number | null;
  /**
   * ATR trail (plan.chandelier), only when its timeframe's bar closed at this
   * step: the best price since entry and ATR on that bar. Unset = no trail step.
   */
  atrTrail?: { extreme: number; atr: number } | null;
  /** Bars of the time stop's timeframe since entry, only when one closed at this step. */
  barsHeld?: number | null;
  /** For plans with stop steps (fee-aware breakeven): the best price since entry and the last 15m close, every step. */
  best?: { extreme: number; close: number } | null;
}

const better = (side: 'long' | 'short', a: number, b: number) => (side === 'long' ? a > b : a < b);

export function planManagement(i: ManageInput): ManageAction[] {
  const { pos, plan } = i;
  const long = pos.side === 'long';
  const r1 = Math.abs(pos.entry - pos.initialStop);
  const out: ManageAction[] = [];
  if (!(r1 > 0)) return out;

  if (!pos.partialsPlaced && plan.partials.length) {
    out.push({
      kind: 'place-partials',
      targets: plan.partials.map((p, index) => ({
        index, price: long ? pos.entry + p.atR * r1 : pos.entry - p.atR * r1, qty: pos.qtyInitial * p.fraction,
      })),
    });
  }

  // Time stop (same rule as the engine): out at market once maxBars have passed, or checkBars without minMfeR.
  const best = i.atrTrail ? (long ? i.atrTrail.extreme - pos.entry : pos.entry - i.atrTrail.extreme) / r1 : null;
  if (plan.timeStop && i.barsHeld != null) {
    const t = plan.timeStop;
    if (i.barsHeld >= t.maxBars || (i.barsHeld >= t.checkBars && best != null && best < t.minMfeR)) {
      return [{ kind: 'close', why: 'time' }];
    }
  }

  // The first partial has filled once the position shrank (it rests at the first R level).
  const scaledOut = plan.partials.length > 0 && i.qtyNow < pos.qtyInitial * (1 - 1e-6);
  let stop = pos.stop;
  let why: 'breakeven' | 'trail' | 'atr-trail' | null = null;
  if (plan.breakevenAtR != null && scaledOut && better(pos.side, pos.entry, stop)) {
    stop = pos.entry;
    why = 'breakeven';
  }
  if (plan.trailTf && scaledOut && i.trailSwing != null && better(pos.side, i.trailSwing, stop)
    && (i.lastClose == null || better(pos.side, i.lastClose, i.trailSwing))) {
    stop = i.trailSwing;
    why = 'trail';
  }
  // Stop steps (the engine's stopSteps, e.g. the 4H pullback's entry + 0.2R at +1R): from the best price since entry; only tightens.
  if (plan.stopSteps && i.best) {
    const bestR = (long ? i.best.extreme - pos.entry : pos.entry - i.best.extreme) / r1;
    for (const st of plan.stopSteps) {
      if (bestR < st.atR) continue;
      const to = st.toR != null ? (long ? pos.entry + st.toR * r1 : pos.entry - st.toR * r1)
        : (long ? pos.entry * (1 + (st.toPct ?? 0) / 100) : pos.entry * (1 - (st.toPct ?? 0) / 100));
      if (better(pos.side, to, stop) && better(pos.side, i.best.close, to)) { stop = to; why = 'breakeven'; }
    }
  }
  // ATR trail (the engine's chandelier): from activateR in profit, best price since entry minus mult x ATR; only tightens.
  const ch = plan.chandelier;
  if (ch && i.atrTrail && best != null && best >= ch.activateR) {
    const level = long ? i.atrTrail.extreme - ch.mult * i.atrTrail.atr : i.atrTrail.extreme + ch.mult * i.atrTrail.atr;
    if (better(pos.side, level, stop) && (i.lastClose == null || better(pos.side, i.lastClose, level))) {
      stop = level;
      why = 'atr-trail';
    }
  }
  if (why) out.push({ kind: 'move-stop', stop, why });
  return out;
}
