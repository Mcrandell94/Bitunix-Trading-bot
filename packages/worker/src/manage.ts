// Live trade management: the bot's own positions follow the same plan as
// the backtest and paper replay (TierPlan):
// - partial targets rest on the book right after the fill, as POST_ONLY
//   limits (always maker): MTF 1/3 at 1R and 1/3 at 2R;
// - once the first partial has filled, the stop moves to breakeven;
// - after that, at each close of the trail timeframe (MTF 4H), the stop
//   trails to the latest confirmed swing, only ever tightening;
// - the rest exits at the target attached to the entry, or the stop.
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
  | { kind: 'move-stop'; stop: number; why: 'breakeven' | 'trail' };

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

  // The first partial has filled once the position shrank (it rests at the first R level).
  const scaledOut = plan.partials.length > 0 && i.qtyNow < pos.qtyInitial * (1 - 1e-6);
  let stop = pos.stop;
  let why: 'breakeven' | 'trail' | null = null;
  if (plan.breakevenAtR != null && scaledOut && better(pos.side, pos.entry, stop)) {
    stop = pos.entry;
    why = 'breakeven';
  }
  if (plan.trailTf && scaledOut && i.trailSwing != null && better(pos.side, i.trailSwing, stop)
    && (i.lastClose == null || better(pos.side, i.lastClose, i.trailSwing))) {
    stop = i.trailSwing;
    why = 'trail';
  }
  if (why) out.push({ kind: 'move-stop', stop, why });
  return out;
}
