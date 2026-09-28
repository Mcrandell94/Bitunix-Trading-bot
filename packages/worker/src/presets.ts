// Settings the owner asked for in chat when the dashboard was out of reach:
// each preset is applied once, at startup, through the same control actions
// as the dashboard buttons (validated, logged as events), then remembered so
// a restart or a later dashboard change is never overwritten.

import { loadSnapshot, saveSnapshot } from '@bot/store';
import { applyControl, parseControl, type ControlDeps } from './controls';

export const PRESETS_KEY = 'owner-presets-applied';

export const OWNER_PRESETS: ReadonlyArray<{ id: string; actions: ReadonlyArray<Record<string, unknown>> }> = [
  // Owner, 2026-09-28: the 4H pullback on the best tested cell, RSI 62/70 + room to TP1 (zones) + daily range + RRG heading ranking (docs/RESULTS.md).
  {
    id: '2026-09-28-p4h-rsi-room-heading',
    actions: [
      { action: 'set-selection', scope: 'P4H', value: 'range' },
      { action: 'set-rsi-filter', scope: 'P4H', on: true, w: 62, d: 70 },
      { action: 'set-room-filter', scope: 'P4H', on: true, mode: 'zones' },
      { action: 'rank-slot-on', scope: 'P4H' },
      { action: 'rrg-on', scope: 'paper', by: 'heading' },
      { action: 'rrg-on', scope: 'live', by: 'heading' },
    ],
  },
  // Owner, 2026-09-28: RSI filter 62/70 on the 1H pullback's longs (drawdown 34.9% -> 28.5%, docs/RESULTS.md).
  {
    id: '2026-09-28-p1h-rsi',
    actions: [{ action: 'set-rsi-filter', scope: 'P1H', on: true, w: 62, d: 70 }],
  },
  // Owner, 2026-09-28: no 4H short while the weekly RSI is >= 55 (docs/RESULTS.md).
  {
    id: '2026-09-28-p4h-short55',
    actions: [{ action: 'set-short-filter', scope: 'P4H', on: true, w: 55 }],
  },
];

export async function applyOwnerPresets(deps: ControlDeps, presets = OWNER_PRESETS): Promise<string[]> {
  const done = (await loadSnapshot<string[]>(deps.db, PRESETS_KEY)) ?? [];
  const applied: string[] = [];
  for (const p of presets) {
    if (done.includes(p.id)) continue;
    for (const a of p.actions) {
      const r = await applyControl(deps, parseControl(a), `preset ${p.id}`);
      deps.log.info('preset: applied', { preset: p.id, action: a.action, message: r.message });
    }
    done.push(p.id);
    applied.push(p.id);
    await saveSnapshot(deps.db, PRESETS_KEY, done);
  }
  return applied;
}
