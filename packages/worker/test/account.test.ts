// The linked account: read-only snapshot, friendly errors, and the config
// rules that keep live trading behind two switches.
import { BitunixError, PRIVATE_PATHS, TradingDisabledError, createTradeApi, type PrivateClient } from '@bot/bitunix';
import { describe, expect, test } from 'vitest';
import { accountApi, accountSnapshot, explain, loadConfig, silentLogger } from '../src/index';

function fakeClient(fail?: BitunixError): PrivateClient & { posts: number } {
  const c = {
    posts: 0,
    async get<T>(path: string): Promise<T> {
      if (fail) throw fail;
      if (path === PRIVATE_PATHS.account) return { marginCoin: 'USDT', available: '812.4', margin: '40', positionMode: 'HEDGE' } as T;
      if (path === PRIVATE_PATHS.pendingPositions) return [{ positionId: '1', symbol: 'BTCUSDT', side: 'LONG', qty: '0.01', avgOpenPrice: '110000' }] as T;
      return { orderList: [{ orderId: '7', symbol: 'BTCUSDT', side: 'SELL', qty: '0.01' }] } as T;
    },
    async post<T>(): Promise<T> { c.posts++; return {} as T; },
  };
  return c;
}

describe('account snapshot', () => {
  test('balance, positions and open orders', async () => {
    const snap = await accountSnapshot(createTradeApi(fakeClient(), { mode: 'disabled' }), 5);
    expect(snap).toMatchObject({ at: 5, ok: true, account: { available: 812.4, positionMode: 'HEDGE' }, openOrders: 1 });
    if (snap.ok) expect(snap.positions[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'long', qty: 0.01 });
  });

  test('setup mistakes come back in plain words, never as a crash', async () => {
    const cases: [BitunixError, RegExp][] = [
      [new BitunixError('Bitunix error 10007: Sign signature error', 10007, 200, false), /BITUNIX_API_SECRET/],
      [new BitunixError('Bitunix error 10004: ip', 10004, 200, false), /whitelist/],
      [new BitunixError('Bitunix error 10003: key', 10003, 200, false), /BITUNIX_API_KEY/],
    ];
    for (const [err, msg] of cases) {
      const snap = await accountSnapshot(createTradeApi(fakeClient(err), { mode: 'disabled' }), 1);
      expect(snap.ok).toBe(false);
      if (!snap.ok) expect(snap.error).toMatch(msg);
    }
    expect(explain(new Error('boom'))).toBe('boom');
  });
});

describe('live config', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  const keys = { BITUNIX_API_KEY: 'key', BITUNIX_API_SECRET: 'secret' };

  test('defaults: no keys, dry run on, leverage up to 10x isolated', () => {
    expect(loadConfig(base).live).toEqual({ credentials: null, dryRun: true, leverage: 10, marginMode: 'ISOLATION' });
    expect(loadConfig({ ...base, ...keys }).live.credentials).toEqual({ apiKey: 'key', secretKey: 'secret' });
    expect(loadConfig({ ...base, BITUNIX_API_KEY: 'key', BITUNIX_SECRET_KEY: 'secret' }).live.credentials).toEqual({ apiKey: 'key', secretKey: 'secret' });
  });

  test('refuses half-set keys, trading without keys, and odd values', () => {
    expect(() => loadConfig({ ...base, BITUNIX_API_KEY: 'key' })).toThrow(/both/);
    expect(() => loadConfig({ ...base, TRADING_ENABLED: 'true' })).toThrow(/needs BITUNIX_API_KEY/);
    expect(() => loadConfig({ ...base, LIVE_DRY_RUN: 'no' })).toThrow(/LIVE_DRY_RUN/);
    expect(() => loadConfig({ ...base, LIVE_LEVERAGE: '2.5' })).toThrow(/LIVE_LEVERAGE/);
    expect(() => loadConfig({ ...base, LIVE_LEVERAGE: '50' })).toThrow(/LIVE_LEVERAGE/);
    expect(() => loadConfig({ ...base, LIVE_MARGIN_MODE: 'isolated' })).toThrow(/LIVE_MARGIN_MODE/);
  });

  test('the account API sends nothing unless both switches say so', async () => {
    const order = { symbol: 'BTCUSDT', side: 'BUY', tradeSide: 'OPEN', orderType: 'LIMIT', qty: '0.001', price: '1', clientId: 'bot-1' } as const;
    expect(accountApi(loadConfig(base), silentLogger)).toBeNull();
    const modes = [
      [{}, 'dry-run'],
      [{ TRADING_ENABLED: 'true' }, 'dry-run'],
      [{ LIVE_DRY_RUN: 'false' }, 'disabled'],
      [{ TRADING_ENABLED: 'true', LIVE_DRY_RUN: 'false' }, 'live'],
    ] as const;
    for (const [env, mode] of modes) expect(accountApi(loadConfig({ ...base, ...keys, ...env }), silentLogger)!.mode).toBe(mode);
    const off = accountApi(loadConfig({ ...base, ...keys, LIVE_DRY_RUN: 'false' }), silentLogger)!;
    await expect(off.placeOrder(order)).rejects.toBeInstanceOf(TradingDisabledError);
  });
});
