// The linked Bitunix account, read-only: balance, open positions and open
// orders, refreshed each wake-up for the logs and the dashboard. Placing
// orders is not done here.

import {
  BitunixError, ERROR_CODES, createPrivateClient, createTradeApi, writeMode,
  type Account, type Position, type TradeApi, type WriteMode,
} from '@bot/bitunix';
import type { WorkerConfig } from './config';
import { effectiveMode, type LiveControls } from './controls';
import type { Logger } from './log';

export type AccountSnapshot =
  | { at: number; ok: true; account: Account; positions: Position[]; openOrders: number }
  | { at: number; ok: false; error: string };

/**
 * The account API for this config, or null without keys. Writes follow the
 * gate; with `live`, a dashboard halt also blocks them, checked at each write.
 */
export function accountApi(config: WorkerConfig, log: Logger, live?: LiveControls): TradeApi | null {
  if (!config.live.credentials) return null;
  const envMode: WriteMode = writeMode({ tradingEnabled: config.tradingEnabled, dryRun: config.live.dryRun });
  const client = createPrivateClient({ credentials: config.live.credentials, baseUrl: config.bitunixBaseUrl });
  return createTradeApi(client, {
    mode: live ? () => effectiveMode(envMode, live) : envMode,
    onWrite: ({ mode: m, request }) => log.info(m === 'live' ? 'order: sending' : m === 'dry-run' ? 'order: dry run' : 'order: refused (trading disabled)', {
      path: request.path, body: request.body,
    }),
  });
}

/** Plain-language hints for the setup mistakes a first connection usually hits. */
export function explain(err: unknown): string {
  if (err instanceof BitunixError) {
    if (err.code === ERROR_CODES.signatureError) return 'signature rejected: check BITUNIX_API_SECRET matches the key';
    if (err.code === ERROR_CODES.ipNotWhitelisted) return 'this server\'s IP is not on the API key\'s IP whitelist';
    if (err.code === 10003) return 'the API key was not accepted: check BITUNIX_API_KEY';
    return err.message;
  }
  return (err as Error).message ?? String(err);
}

export async function accountSnapshot(api: TradeApi, now: number): Promise<AccountSnapshot> {
  try {
    const account = await api.account();
    const positions = await api.positions();
    const openOrders = (await api.pendingOrders()).length;
    return { at: now, ok: true, account, positions, openOrders };
  } catch (err) {
    return { at: now, ok: false, error: explain(err) };
  }
}

export function logSnapshot(log: Logger, s: AccountSnapshot, mode: WriteMode): void {
  if (!s.ok) {
    log.error('account: check failed', { error: s.error, writeMode: mode });
    return;
  }
  log.info('account: connected', {
    writeMode: mode, available: s.account.available, margin: s.account.margin, positionMode: s.account.positionMode,
    positions: s.positions.map((p) => `${p.symbol} ${p.side} ${p.qty}`), openOrders: s.openOrders,
  });
}
