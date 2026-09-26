import type { BacktestResult, Trade } from './types';

export interface Stats {
  trades: number;
  wins: number;
  winRate: number;
  /** Mean R per trade (after fees and funding). */
  expectancyR: number;
  totalR: number;
  netPnl: number;
  fees: number;
  funding: number;
}

export function stats(trades: ReadonlyArray<Trade>): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnl > 0).length;
  const sum = (f: (t: Trade) => number) => trades.reduce((a, t) => a + f(t), 0);
  const totalR = sum((t) => t.r);
  return {
    trades: n, wins, winRate: n ? wins / n : 0, expectancyR: n ? totalR / n : 0, totalR,
    netPnl: sum((t) => t.netPnl), fees: sum((t) => t.fees), funding: sum((t) => t.funding),
  };
}

/** Largest peak-to-trough fall of realized equity, as a fraction of the peak. */
export function maxDrawdown(start: number, curve: ReadonlyArray<{ equity: number }>): number {
  let peak = start;
  let worst = 0;
  for (const { equity } of curve) {
    peak = Math.max(peak, equity);
    worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

export interface Summary {
  overall: Stats;
  byTier: Record<string, Stats>;
  bySource: Record<string, Stats>;
  maxDrawdown: number;
  returnPct: number;
  rejections: Record<string, number>;
}

function groupBy(trades: ReadonlyArray<Trade>, key: (t: Trade) => string): Record<string, Stats> {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stats(v)]));
}

export function summarize(r: BacktestResult): Summary {
  const rejections: Record<string, number> = {};
  for (const x of r.rejected) rejections[x.reason] = (rejections[x.reason] ?? 0) + 1;
  return {
    overall: stats(r.trades),
    byTier: groupBy(r.trades, (t) => t.tier),
    bySource: groupBy(r.trades, (t) => `${t.tier} ${t.source}`),
    maxDrawdown: maxDrawdown(r.config.startEquity, r.equityCurve),
    returnPct: (r.endEquity / r.config.startEquity - 1) * 100,
    rejections,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;

function row(name: string, s: Stats): string {
  return `${name.padEnd(28)} ${String(s.trades).padStart(6)} ${pct(s.winRate).padStart(7)} ${s.expectancyR.toFixed(2).padStart(7)}R ${s.totalR.toFixed(1).padStart(7)}R ${money(s.netPnl).padStart(12)} ${money(-s.fees).padStart(11)} ${money(s.funding).padStart(11)}`;
}

export function formatReport(r: BacktestResult): string {
  const s = summarize(r);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [
    `Backtest ${iso(r.config.from)} → ${iso(r.config.to)} UTC`,
    `Start ${money(r.config.startEquity)}  End ${money(r.endEquity)}  Return ${s.returnPct.toFixed(2)}%  Max drawdown ${pct(s.maxDrawdown)}`,
    `Setups seen ${r.setupsSeen}  Orders placed ${r.trades.length + r.expired}  Filled ${r.trades.length}  Expired unfilled ${r.expired}`,
    '',
    `${'group'.padEnd(28)} ${'trades'.padStart(6)} ${'win'.padStart(7)} ${'avg'.padStart(8)} ${'total'.padStart(8)} ${'net'.padStart(12)} ${'fees'.padStart(11)} ${'funding'.padStart(11)}`,
    row('ALL', s.overall),
    ...Object.entries(s.byTier).map(([k, v]) => row(k, v)),
    ...Object.entries(s.bySource).map(([k, v]) => row(`  ${k}`, v)),
    '',
    'Setups not taken:',
    ...(Object.keys(s.rejections).length
      ? Object.entries(s.rejections).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(26)} ${v}`)
      : ['  none']),
  ];
  if (r.warnings.length) lines.push('', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}
