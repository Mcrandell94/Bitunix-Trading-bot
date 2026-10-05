// Worker settings, from environment variables. DATABASE_URL is the only
// required one. Bitunix API keys are optional and only ever come from the
// environment (Railway variables), never from the repository.

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
   * "true". Every order path goes through the write gate (writeMode), which
   * also needs LIVE_DRY_RUN=false before anything is sent.
   */
  tradingEnabled: boolean;
  /** The linked Bitunix account. Without keys, nothing account-related runs. */
  live: {
    credentials: { apiKey: string; secretKey: string } | null;
    /** Report orders instead of sending them. On unless LIVE_DRY_RUN is exactly "false". */
    dryRun: boolean;
    /** Upper bound on the leverage set per coin (the coin's size class decides: 10x / 5x / 3x). */
    leverage: number;
    marginMode: 'ISOLATION' | 'CROSS';
  };
  /** Paper trading: simulated fills on live data every 15 minutes. Never touches an account. */
  paper: {
    enabled: boolean;
    startEquity: number;
    /** Extra symbols (most liquid first) besides BTC/ETH/XRP in a new session's frozen universe. */
    extras: number;
  };
  /** Read-only web dashboard. Off without DASHBOARD_PASSWORD. */
  dashboard: {
    password: string | null;
    /** Required login name (DASHBOARD_USER); null = any username. */
    user: string | null;
    /** Railway sets PORT for services with a public domain. */
    port: number;
  };
  /** Live signal alerts (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; TELEGRAM_THREAD_ID = a forum topic); null = not set up. */
  telegram: { token: string; chatId: string; threadId?: number } | null;
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
  const bool = (key: string, fallback = 'false') => {
    const v = env[key] || fallback;
    if (v !== 'true' && v !== 'false') throw new Error(`${key} must be "true" or "false", got "${v}"`);
    return v === 'true';
  };
  const tradingEnabled = bool('TRADING_ENABLED');
  const apiKey = env.BITUNIX_API_KEY?.trim() || null;
  // BITUNIX_SECRET_KEY is accepted too (Bitunix calls it the "secret key").
  const secretKey = env.BITUNIX_API_SECRET?.trim() || env.BITUNIX_SECRET_KEY?.trim() || null;
  if (!!apiKey !== !!secretKey) throw new Error('set both BITUNIX_API_KEY and BITUNIX_API_SECRET (or BITUNIX_SECRET_KEY), or neither');
  if (tradingEnabled && !apiKey) throw new Error('TRADING_ENABLED=true needs BITUNIX_API_KEY and BITUNIX_API_SECRET');
  const leverage = int(env, 'LIVE_LEVERAGE', 10, 1);
  if (!Number.isInteger(leverage) || leverage > 20) throw new Error(`LIVE_LEVERAGE must be a whole number from 1 to 20, got "${env.LIVE_LEVERAGE}"`);
  const marginMode = env.LIVE_MARGIN_MODE || 'ISOLATION';
  if (marginMode !== 'ISOLATION' && marginMode !== 'CROSS') throw new Error(`LIVE_MARGIN_MODE must be ISOLATION or CROSS, got "${marginMode}"`);
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
    tradingEnabled,
    live: {
      credentials: apiKey && secretKey ? { apiKey, secretKey } : null,
      dryRun: bool('LIVE_DRY_RUN', 'true'),
      leverage,
      marginMode,
    },
    paper: {
      enabled: bool('PAPER_TRADING'),
      startEquity: int(env, 'PAPER_EQUITY', 10_000, 1),
      // ~60 extras: the universe every EMA 50 backtest used (PAPER_EXTRAS in Railway overrides).
      extras: int(env, 'PAPER_EXTRAS', 60),
    },
    dashboard: {
      password: env.DASHBOARD_PASSWORD || null,
      user: env.DASHBOARD_USER?.trim() || null,
      port: int(env, 'PORT', 8080, 1),
    },
    telegram: env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_CHAT_ID?.trim()
      ? { token: env.TELEGRAM_BOT_TOKEN.trim(), chatId: env.TELEGRAM_CHAT_ID.trim(), ...(env.TELEGRAM_THREAD_ID?.trim() ? { threadId: int(env, 'TELEGRAM_THREAD_ID', 0, 1) } : {}) }
      : null,
  };
}
