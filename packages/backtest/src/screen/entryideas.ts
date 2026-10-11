// Entry ideas for the ETH card (owner 2026-10-11: "If any of the info that's formulated can lead to an entry levels, with
// a 'manage your own risk' label that could help"). Ideas only, never traded by the bot. Fixed before the preview run
// (plan "entryideas.ts"), per timeframe and side:
// - Candidates: a STRONG order block / POI within 3 ATR of the price (entry = its near edge, stop = its far edge -/+ 0.25
//   ATR); an active trend-ribbon position (its entry and stop); a Wyckoff entry label from the last 20 bars while the
//   campaign is in Phase C / D (entry at the label, stop past the Spring / UTAD or the range edge -/+ 0.25 ATR); an active
//   STRONG Trinity level (entry at the signal close, stop past the level -/+ 0.25 ATR).
// - An idea needs 2+ different sources whose entries are within 1 ATR of each other; the zone spans their entries and
//   the stop is the farthest one. Entry reference = the zone edge price reaches first (or the price if already inside).
// - Targets: the next key levels the trade's way (at least 0.25R away), each with its R; T1 must be >= 1.5R.
// - The owner's chop rule: long ideas are "paused" while the 4H Choppiness Index reads chop.
// - At most one idea per side and timeframe: the most sources, then the best R to T1.
// - History of the rule: each new (unpaused) idea filled at its entry reference within 30 bars (at the next open if the
//   price is already past it), then T1 before the stop (the stop first when one bar reaches both), costs 0.22%.
// Pure.

export const IDEA_RULE = { zoneAtr: 3, stopPadAtr: 0.25, clusterAtr: 1, minSources: 2, minT1R: 1.5, minTargetR: 0.25, wyckoffBars: 20, maxTargets: 3, fillBars: 30, cost: 0.0022 } as const;
export type IdeaSource = 'order block' | 'ribbon' | 'wyckoff' | 'trinity';
export interface IdeaCandidate { src: IdeaSource; id: string; entry: number; stop: number; label: string }
export interface IdeaTarget { price: number; label: string; r: number }
export interface Idea {
  side: 1 | -1;
  zoneLo: number;
  zoneHi: number;
  /** The entry reference (the zone edge reached first) and the stop. */
  entry: number;
  stop: number;
  targets: IdeaTarget[];
  sources: IdeaCandidate[];
  /** Identity: the sources' ids (a new set of sources = a new idea). */
  key: string;
  paused: boolean;
}

/** The best idea of one side from its candidates, or null (fewer than 2 sources, no room to T1, ...). */
export function buildIdea(side: 1 | -1, price: number, atr: number, cands: ReadonlyArray<IdeaCandidate>, levels: ReadonlyArray<{ price: number; label: string }>, paused: boolean): Idea | null {
  const R = IDEA_RULE;
  if (!(atr > 0)) return null;
  let best: Idea | null = null;
  for (const a of cands) {
    // One candidate per source, the nearest to the anchor's entry, within 1 ATR.
    const bySrc = new Map<IdeaSource, IdeaCandidate>();
    for (const c of cands) {
      if (Math.abs(c.entry - a.entry) > R.clusterAtr * atr) continue;
      const cur = bySrc.get(c.src);
      if (!cur || Math.abs(c.entry - a.entry) < Math.abs(cur.entry - a.entry)) bySrc.set(c.src, c);
    }
    const sources = [...bySrc.values()];
    if (sources.length < R.minSources) continue;
    const zoneLo = Math.min(...sources.map((x) => x.entry)), zoneHi = Math.max(...sources.map((x) => x.entry));
    const stop = side > 0 ? Math.min(...sources.map((x) => x.stop)) : Math.max(...sources.map((x) => x.stop));
    const entry = side > 0 ? Math.min(price, zoneHi) : Math.max(price, zoneLo), risk = side * (entry - stop);
    if (!(risk > 0)) continue;
    const merged: IdeaTarget[] = [];
    for (const l of [...levels].filter((x) => Number.isFinite(x.price) && side * (x.price - entry) >= R.minTargetR * risk).sort((p, q) => side * (p.price - q.price))) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(l.price - last.price) <= 0.1 * risk) { if (!last.label.split(' / ').includes(l.label)) last.label += ` / ${l.label}`; continue; }
      merged.push({ price: l.price, label: l.label, r: (side * (l.price - entry)) / risk });
    }
    const targets = merged.slice(0, R.maxTargets);
    if (!targets.length || targets[0]!.r < R.minT1R) continue;
    const idea: Idea = { side, zoneLo, zoneHi, entry, stop, targets, sources, key: sources.map((x) => x.id).sort().join('+'), paused };
    if (!best || sources.length > best.sources.length || (sources.length === best.sources.length && targets[0]!.r > best.targets[0]!.r)) best = idea;
  }
  return best;
}

export interface IdeaOutcome { key: string; side: 1 | -1; at: number; filled: boolean; r: number | null; how: 'target' | 'stop' | 'open' | 'no fill' }

/**
 * Replays new ideas over bars (`ideas[i]` = the idea of one side known at bar i's close, or null): each new key is
 * filled at its entry within 30 bars (next open if price is already past it), then T1 or the stop decides it.
 */
export function replayIdeas(c: ReadonlyArray<{ open: number; high: number; low: number; close: number }>, ideas: ReadonlyArray<Idea | null>, from = 0): IdeaOutcome[] {
  const R = IDEA_RULE, out: IdeaOutcome[] = [], seen = new Set<string>();
  for (let i = from; i < c.length - 1; i++) {
    const idea = ideas[i];
    if (!idea || idea.paused || seen.has(idea.key)) continue;
    seen.add(idea.key);
    const d = idea.side, t1 = idea.targets[0]!.price;
    let fillAt = -1, px = NaN;
    for (let k = i + 1; k < Math.min(c.length, i + 1 + R.fillBars); k++) {
      const b = c[k]!;
      if (k === i + 1 && d * (b.open - idea.entry) <= 0) { fillAt = k; px = b.open; break; }
      if (d > 0 ? b.low <= idea.entry : b.high >= idea.entry) { fillAt = k; px = idea.entry; break; }
      if (d > 0 ? b.close < idea.stop : b.close > idea.stop) break; // invalidated before a fill
    }
    if (fillAt < 0) { out.push({ key: idea.key, side: d, at: i, filled: false, r: null, how: 'no fill' }); continue; }
    const risk = d * (px - idea.stop), cost = (R.cost * px) / risk;
    if (!(risk > 0)) { out.push({ key: idea.key, side: d, at: i, filled: false, r: null, how: 'no fill' }); continue; }
    let res: IdeaOutcome | null = null;
    for (let k = fillAt; k < c.length; k++) {
      const b = c[k]!;
      if (d > 0 ? b.low <= idea.stop : b.high >= idea.stop) { res = { key: idea.key, side: d, at: i, filled: true, r: -1 - cost, how: 'stop' }; break; }
      if (d > 0 ? b.high >= t1 : b.low <= t1) { res = { key: idea.key, side: d, at: i, filled: true, r: (d * (t1 - px)) / risk - cost, how: 'target' }; break; }
    }
    out.push(res ?? { key: idea.key, side: d, at: i, filled: true, r: (d * (c[c.length - 1]!.close - px)) / risk - cost, how: 'open' });
  }
  return out;
}
