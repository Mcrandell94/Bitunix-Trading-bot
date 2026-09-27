// Where do the wins and losses come from? Win rate and R broken down by
// tier, side, coin, signal source, hour, month and stop distance, so filters
// are chosen on evidence rather than guessed.

import type { Trade } from './types';

export interface Bucket { key: string; trades: number; winRate: number; totalR: number; avgR: number }

function group(trades: ReadonlyArray<Trade>, by: (t: Trade) => string): Bucket[] {
  const m = new Map<string, Trade[]>();
  for (const t of trades) {
    const k = by(t);
    (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  }
  return [...m.entries()].map(([key, list]) => {
    const wins = list.filter((t) => t.netPnl > 0).length;
    const totalR = list.reduce((a, t) => a + t.r, 0);
    return { key, trades: list.length, winRate: (wins / list.length) * 100, totalR, avgR: totalR / list.length };
  }).sort((a, b) => b.trades - a.trades);
}

const stopBucket = (t: Trade) => {
  const pct = (Math.abs(t.entry - t.initialStop) / t.entry) * 100;
  return pct < 0.3 ? '< 0.3%' : pct < 0.6 ? '0.3-0.6%' : pct < 1 ? '0.6-1%' : pct < 2 ? '1-2%' : '>= 2%';
};
const hourBucket = (t: Trade) => {
  const h = new Date(t.openedAt).getUTCHours();
  return `${String(Math.floor(h / 4) * 4).padStart(2, '0')}-${String(Math.floor(h / 4) * 4 + 4).padStart(2, '0')} UTC`;
};

export function attribution(trades: ReadonlyArray<Trade>): Record<string, Bucket[]> {
  return {
    tier: group(trades, (t) => t.tier),
    side: group(trades, (t) => t.side),
    'signal source': group(trades, (t) => t.source),
    'stop distance': group(trades, stopBucket),
    'hour of entry': group(trades, hourBucket),
    month: group(trades, (t) => new Date(t.openedAt).toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    coin: group(trades, (t) => t.symbol),
  };
}

export function formatAttribution(a: Record<string, Bucket[]>): string {
  const lines: string[] = ['ATTRIBUTION (current strategy, whole window)'];
  for (const [name, buckets] of Object.entries(a)) {
    lines.push(`${name}:`);
    for (const b of buckets) {
      lines.push(`  ${b.key.padEnd(18)} ${String(b.trades).padStart(4)} tr  win ${b.winRate.toFixed(0).padStart(3)}%  total ${b.totalR.toFixed(1).padStart(6)}R  avg ${b.avgR.toFixed(2).padStart(5)}R`);
    }
  }
  return lines.join('\n');
}
