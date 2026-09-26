// Worker settings, from environment variables. No secrets are needed in
// stage 2 (market data is public); DATABASE_URL is the only required one.

import type { Timeframe } from '@bot/signals';

export interface WorkerConfig {
  databaseUrl: string;
  bitunixBaseUrl: string | undefined;
  timeframes: Timeframe[];
  /** Closed bars kept per symbol and handed to the scanner. */
  historyBars: number;
  /** 'core' scans BTC/ETH/XRP only; 'all' adds every liquid USDT perp. */
  universe: 'core' | 'all';
  /** 24h USDT volume a non-core symbol needs to be scanned. */
  minQuoteVolume24h: number;
  /** Cap on non-core symbols, most liquid first. */
  maxExtraSymbols: number;
  /** Wait after a bar closes before fetching it, so the exchange has finalized it. */
  closeDelayMs: number;
  /** Funding older than this is ignored by the scan. */
  maxFundingAgeMs: number;
  /**
   * Master switch for placing orders. Off unless TRADING_ENABLED is exactly
   * "true". Stage 2 has no order code, so for now it gates nothing; every
   * order path added later must check it.
   */
  tradingEnabled: boolean;
}

const TIMEFRAMES: readonly Timeframe[] = ['1h', '4h', '1d'];

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min}, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const timeframes = (env.TIMEFRAMES ?? TIMEFRAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const bad = timeframes.filter((t) => !TIMEFRAMES.includes(t as Timeframe));
  if (bad.length || timeframes.length === 0) throw new Error(`TIMEFRAMES must be a list of ${TIMEFRAMES.join('/')}, got "${env.TIMEFRAMES}"`);
  const universe = env.UNIVERSE ?? 'all';
  if (universe !== 'core' && universe !== 'all') throw new Error(`UNIVERSE must be core or all, got "${universe}"`);
  const trading = env.TRADING_ENABLED ?? 'false';
  if (trading !== 'true' && trading !== 'false') {
    throw new Error(`TRADING_ENABLED must be "true" or "false", got "${trading}"`);
  }
  return {
    databaseUrl,
    bitunixBaseUrl: env.BITUNIX_BASE_URL || undefined,
    timeframes: timeframes as Timeframe[],
    historyBars: int(env, 'HISTORY_BARS', 120, 60),
    universe,
    minQuoteVolume24h: int(env, 'MIN_QUOTE_VOLUME_24H', 10_000_000),
    maxExtraSymbols: int(env, 'MAX_EXTRA_SYMBOLS', 100),
    closeDelayMs: int(env, 'CLOSE_DELAY_MS', 20_000),
    maxFundingAgeMs: int(env, 'MAX_FUNDING_AGE_MS', 2 * 3_600_000),
    tradingEnabled: trading === 'true',
  };
}
