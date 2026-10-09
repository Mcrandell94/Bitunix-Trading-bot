// Exit methods with no time stop (owner 2026-10-04: "Let's eliminate time stops and let the stop losses do their thing";
// "experiment some more with various targets and trailing stop methods"). Shared by the research reports and the
// framework's live signals: a trade runs from the open of bar j until its stop (fixed, breakeven or trailing), its target,
// or an EMA close exit; there is no time cap. Still open at the end of the data = marked at the last close.

import type { Candle } from '@bot/marketdata';

/** `cap` = a time exit after this many of the model's bars (owner 2026-10-04: keep a timed exit where it is the best). */
export interface ExitSpec {
  name: string; target?: number; trail?: { kind: 'atr' | 'chand' | 'swing' | 'ema'; k: number; arm: number }; be?: number; partial?: number; cap?: number;
  /** Profit locks (owner 2026-10-09): once a close is `at` R the trade's way, the stop goes to `stop` R (it never moves back). */
  lock?: ReadonlyArray<readonly [at: number, stop: number]>;
}

export function exitSpecs(): ExitSpec[] {
  const out: ExitSpec[] = [];
  for (const t of [3, 5, 8, 10, 15, 20]) out.push({ name: `${t}R target`, target: t });
  for (const k of [2, 3, 4, 5, 6, 8]) for (const arm of [0, 1, 2]) out.push({ name: `${k} ATR trail, armed ${arm ? `+${arm}R` : 'at once'}`, trail: { kind: 'atr', k, arm } });
  for (const k of [3, 5]) out.push({ name: `chandelier ${k} ATR`, trail: { kind: 'chand', k, arm: 1 } });
  for (const k of [5, 10, 20]) out.push({ name: `swing trail ${k} bars`, trail: { kind: 'swing', k, arm: 1 } });
  for (const k of [20, 50]) out.push({ name: `close under EMA ${k}`, trail: { kind: 'ema', k, arm: 1 } });
  for (const be of [1, 2]) { out.push({ name: `breakeven at +${be}R, 10R target`, be, target: 10 }); out.push({ name: `breakeven at +${be}R, 5 ATR trail`, be, trail: { kind: 'atr', k: 5, arm: be } }); }
  for (const p of [2, 3]) out.push({ name: `half at ${p}R, rest 5 ATR trail`, partial: p, trail: { kind: 'atr', k: 5, arm: 1 } });
  return out;
}

/** The trade from the open of bar j; `stop` is the stop in force at the end (it moves with breakeven / trails). */
export function specTrade(c: ReadonlyArray<Candle>, atr: ReadonlyArray<number | null>, emas: Record<number, (number | null)[]>, j: number, stop0: number, d: 1 | -1, sp: ExitSpec, cost = 0.0022) {
  if (j >= c.length) return null;
  const entry = c[j]!.open, risk = d * (entry - stop0);
  if (!(risk > 0)) return null;
  const tgt = sp.target != null ? entry + d * sp.target * risk : null, half = sp.partial != null ? entry + d * sp.partial * risk : null;
  let stop = stop0, best = entry, bestX = entry, armed = false, halfDone = false;
  const fin = (px: number, k: number, open: boolean, how: 'stop' | 'target' | 'exit' | 'time' | 'open') => {
    const rest = (d * (px - entry)) / risk;
    const r = (halfDone ? 0.5 * sp.partial! + 0.5 * rest : rest) - (cost * entry) / risk;
    return { r, stopPct: (100 * risk) / entry, bars: k - j + 1, end: k, open, how, entry, stop, target: tgt };
  };
  for (let k = j; k < c.length; k++) {
    const b = c[k]!;
    if (d * (b.open - stop) <= 0) return fin(b.open, k, false, 'stop');
    if (d > 0 ? b.low <= stop : b.high >= stop) return fin(stop, k, false, 'stop');
    if (half != null && !halfDone && (d > 0 ? b.high >= half : b.low <= half)) halfDone = true;
    if (tgt != null && (d > 0 ? b.high >= tgt : b.low <= tgt)) return fin(tgt, k, false, 'target');
    if (d * (b.close - best) > 0) best = b.close;
    bestX = d > 0 ? Math.max(bestX, b.high) : Math.min(bestX, b.low);
    if (sp.be != null && d * (best - entry) >= sp.be * risk && d * (entry - stop) > 0) stop = entry;
    for (const [at, sr] of sp.lock ?? []) if (d * (best - entry) >= at * risk && d * (entry + d * sr * risk - stop) > 0) stop = entry + d * sr * risk;
    const tr = sp.trail;
    if (tr) {
      if (d * (best - entry) >= tr.arm * risk) armed = true;
      if (armed) {
        if (tr.kind === 'ema') { const e = emas[tr.k]?.[k]; if (e != null && d * (b.close - e) < 0) return fin(b.close, k, false, 'exit'); }
        else {
          let t: number | null = null;
          const a = atr[k];
          if (tr.kind === 'atr' && a != null) t = best - d * tr.k * a;
          if (tr.kind === 'chand' && a != null) t = bestX - d * tr.k * a;
          if (tr.kind === 'swing') { let x = d > 0 ? Infinity : -Infinity; for (let q = Math.max(0, k - tr.k + 1); q <= k; q++) x = d > 0 ? Math.min(x, c[q]!.low) : Math.max(x, c[q]!.high); t = x; }
          if (t != null && d * (t - stop) > 0) stop = t;
        }
      }
    }
    if (sp.cap != null && k - j + 1 >= sp.cap) return fin(b.close, k, false, 'time');
  }
  return fin(c[c.length - 1]!.close, c.length - 1, true, 'open');
}

