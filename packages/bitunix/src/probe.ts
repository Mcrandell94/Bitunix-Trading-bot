// Live contract check: runs every ASSUMED / DOCS-QUOTED item from api.ts
// and parse.ts against the real API. `npm run probe` prints the report and
// exits non-zero on any FAIL. Public endpoints only; no keys.

import { intervalMs, type IntervalName } from '@bot/marketdata';
import { PATHS } from './api';
import type { BitunixClient } from './client';
import { num } from './parse';

export type Status = 'PASS' | 'FAIL' | 'INFO';
export interface ProbeResult {
  check: string;
  status: Status;
  detail: string;
}

const rowsOf = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) : [];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

export async function runProbe(client: BitunixClient, now = Date.now()): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const add = (check: string, status: Status, detail: string) => out.push({ check, status, detail });
  const guard = async (check: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { add(check, 'FAIL', (err as Error).message); }
  };

  // Klines: fields, open-time alignment, ordering, open bar, volume fields.
  for (const interval of ['1h', '4h', '1d'] as IntervalName[]) {
    await guard(`kline ${interval}`, async () => {
      const ms = intervalMs(interval);
      const rows = rowsOf(await client.get(PATHS.kline, {
        symbol: 'BTCUSDT', interval, limit: 50, startTime: now - 50 * ms, endTime: now,
      }));
      if (rows.length === 0) { add(`kline ${interval}: rows`, 'FAIL', 'no rows returned'); return; }
      const keys = Object.keys(rows[0]!).sort().join(',');
      const needed = ['close', 'high', 'low', 'open', 'quoteVol', 'time'];
      const missing = needed.filter((k) => !(k in rows[0]!));
      add(`kline ${interval}: fields`, missing.length ? 'FAIL' : 'PASS', `keys: ${keys}${missing.length ? `; missing ${missing.join(',')}` : ''}`);
      const times = rows.map((r) => num(r.time)).filter((t): t is number => t != null);
      const offGrid = times.filter((t) => t % ms !== 0);
      add(`kline ${interval}: time is an open time on the UTC grid`, offGrid.length ? 'FAIL' : 'PASS',
        offGrid.length ? `${offGrid.length}/${times.length} off-grid, e.g. ${new Date(offGrid[0]!).toISOString()}` : `all ${times.length} on ${interval} boundaries`);
      const asc = times.every((t, i) => i === 0 || t > times[i - 1]!);
      const desc = times.every((t, i) => i === 0 || t < times[i - 1]!);
      add(`kline ${interval}: order`, 'INFO', asc ? 'ascending' : desc ? 'descending' : 'unordered (parser sorts anyway)');
      const newest = Math.max(...times);
      add(`kline ${interval}: includes the still-open bar`, 'INFO', newest + ms > now ? 'yes (closedOnly drops it)' : 'no');
      const r = rows[rows.length - 1]!;
      const q = num(r.quoteVol); const b = num(r.baseVol); const c = num(r.close);
      if (q != null && b != null && c != null && b > 0) {
        const ratio = q / b / c;
        add(`kline ${interval}: quoteVol is quote (USDT) volume`, 'INFO',
          `quoteVol/baseVol/close = ${ratio.toFixed(3)} (≈1 means yes; ≈1/close² means they're swapped)`);
      }
    });
  }

  await guard('kline: 200-bar window returns at most 200 rows', async () => {
    const ms = intervalMs('1h');
    const rows = rowsOf(await client.get(PATHS.kline, {
      symbol: 'BTCUSDT', interval: '1h', limit: 200, startTime: now - 300 * ms, endTime: now,
    }));
    const times = rows.map((r) => num(r.time)!).sort((a, b) => a - b);
    add('kline: limit cap', rows.length <= 200 ? 'PASS' : 'FAIL', `${rows.length} rows for a 300-bar range with limit 200`);
    if (times.length) {
      const which = times[0]! < now - 250 * ms ? 'earliest bars in the range' : 'latest bars in the range';
      add('kline: which bars a capped range returns', 'INFO', `${which} (fetchCandles never relies on this)`);
    }
  });

  await guard('kline: MARK_PRICE type', async () => {
    const rows = rowsOf(await client.get(PATHS.kline, { symbol: 'BTCUSDT', interval: '1h', limit: 5, type: 'MARK_PRICE' }));
    add('kline: MARK_PRICE type', rows.length ? 'PASS' : 'FAIL', `${rows.length} rows`);
  });

  await guard('funding batch', async () => {
    const rows = rowsOf(await client.get(PATHS.fundingRateBatch, {}));
    if (!rows.length) { add('funding: rows', 'FAIL', 'no rows'); return; }
    const keys = Object.keys(rows[0]!).sort().join(',');
    const missing = ['symbol', 'fundingRate'].filter((k) => !(k in rows[0]!));
    add('funding: fields', missing.length ? 'FAIL' : 'PASS', `keys: ${keys}`);
    const rates = rows.map((r) => num(r.fundingRate)).filter((x): x is number => x != null).map(Math.abs);
    const med = median(rates);
    // Typical perp funding is ~0.01 as a percent (0.0001 as a fraction).
    // parse.ts reads it as a percent; a median far below 0.0005 would mean
    // Bitunix switched to fractions.
    add('funding: fundingRate is a percent', med >= 0.0005 && med < 0.5 ? 'PASS' : 'FAIL',
      `median |rate| = ${med} over ${rates.length} symbols`);
    const intervals = [...new Set(rows.map((r) => num(r.fundingInterval)))];
    add('funding: fundingInterval values (assumed hours)', intervals.every((i) => i != null && [1, 2, 4, 8].includes(i)) ? 'PASS' : 'FAIL',
      `distinct values: ${intervals.join(', ')}`);
    const next = num(rows[0]!.nextFundingTime);
    add('funding: nextFundingTime is a future ms timestamp', next != null && next > now && next < now + 86_400_000 ? 'PASS' : 'FAIL',
      next != null ? new Date(next).toISOString() : String(rows[0]!.nextFundingTime));
  });

  await guard('tickers', async () => {
    const rows = rowsOf(await client.get(PATHS.tickers, {}));
    const keys = rows[0] ? Object.keys(rows[0]).sort().join(',') : '';
    const missing = ['symbol', 'quoteVol', 'lastPrice'].filter((k) => !rows[0] || !(k in rows[0]));
    add('tickers: fields', rows.length && !missing.length ? 'PASS' : 'FAIL', `${rows.length} symbols; keys: ${keys}`);
  });

  await guard('trading pairs', async () => {
    const rows = rowsOf(await client.get(PATHS.tradingPairs, {}));
    const keys = rows[0] ? Object.keys(rows[0]).sort().join(',') : '';
    const missing = ['symbol', 'base', 'quote', 'minTradeVolume', 'basePrecision', 'quotePrecision', 'maxLeverage'].filter((k) => !rows[0] || !(k in rows[0]));
    add('trading pairs: path and fields', rows.length && !missing.length ? 'PASS' : 'FAIL',
      `${rows.length} pairs; keys: ${keys}${missing.length ? `; missing ${missing.join(',')}` : ''}`);
  });

  return out;
}

export function formatReport(results: ReadonlyArray<ProbeResult>): string {
  return results.map((r) => `${r.status.padEnd(4)}  ${r.check}\n      ${r.detail}`).join('\n');
}
