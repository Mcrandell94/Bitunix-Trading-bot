// Price-level alerts for the ETH card (owner 2026-10-11: the Fib arcs are "saved for when that price triggers"; "I will
// also add other factors with price alerts for these eth so we know when they're swept"). One rule for every level, so
// later factors plug in here: a bar that trades through a level from the side of the previous close either SWEPT it
// (wick through, close back on the starting side) or BROKE it (close through). A close exactly on the level counts as
// back. Pure.

export type CrossKind = 'swept' | 'broken';
export interface PriceCross { kind: CrossKind; /** true = from below (the high reached it). */ up: boolean }

export function priceCross(prevClose: number, bar: { high: number; low: number; close: number }, level: number): PriceCross | null {
  if (!Number.isFinite(level) || !Number.isFinite(prevClose) || prevClose === level) return null;
  if (prevClose < level) return bar.high >= level ? { kind: bar.close > level ? 'broken' : 'swept', up: true } : null;
  return bar.low <= level ? { kind: bar.close < level ? 'broken' : 'swept', up: false } : null;
}
