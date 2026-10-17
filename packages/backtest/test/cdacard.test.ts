import { describe, expect, test } from 'vitest';
import { cdaCoin, parseGex, parseLiq, parseLs, parseOptions, parseRegime, usdShort } from '../src/screen/cdacard';

// Trimmed from the live responses (2026-10-17, Pro key).
const GEX = { coins: { BTC: { mark: 81448.5, mm_net_delta: -160895789.99, gamma_flip: 101950.09825, levels: [
  { price: 82059.36375, dist_pct: 0.75, total_usd: 6981060.77, side: 'short', n_accounts: 1 },
  { price: 80837.63625, dist_pct: -0.75, total_usd: 21181.89, side: 'long', n_accounts: 1 },
  { price: 80430.39375, dist_pct: -1.25, total_usd: 110477824.59, side: 'long', n_accounts: 3 },
] } } };
const LIQ = { data: [{ symbol: 'BTC', long_liquidation_usd_24h: 21191600.96, short_liquidation_usd_24h: 1272781.36 }] };
const LS = { symbol: 'BTCUSDT', long_short_ratio: 1.7255, top_trader_long_short_ratio: 1.8678 };
const REG = { regime: { label: 'range_low_vol', name: 'Range / Low Volatility', confidence: 0.975, in_regime_since: '2026-10-17T05:00:00Z' } };
const OPT = { symbol: 'BTC', data: [{ exchange_name: 'Deribit', max_pain: 79000, put_call_ratio: 0.5992 }, { exchange_name: 'All', max_pain: 79000, put_call_ratio: 0.5992 }] };

describe('CryptoDataAPI for the cards', () => {
  test('parsers: market-maker levels of $1M+ (sorted), liquidations, long / short, regime, max pain', () => {
    expect(parseGex(GEX, 'BTC')).toEqual({ mark: 81448.5, gammaFlip: 101950.09825, mmNetUsd: -160895789.99, mmLevels: [
      { price: 80430.39375, usd: 110477824.59, side: 'long', accounts: 3 }, { price: 82059.36375, usd: 6981060.77, side: 'short', accounts: 1 },
    ] });
    expect(parseGex({}, 'BTC').mmLevels).toEqual([]);
    expect(parseLiq(LIQ)).toEqual({ long: 21191600.96, short: 1272781.36 });
    expect(parseLiq({ data: [] })).toBeNull();
    expect(parseLs(LS)).toEqual({ lsRatio: 1.7255, topLsRatio: 1.8678 });
    expect(parseRegime(REG)).toEqual({ name: 'Range / Low Volatility', confidence: 0.975, since: '2026-10-17T05:00:00Z' });
    expect(parseOptions(OPT)).toEqual({ maxPain: 79000, putCall: 0.5992 });
    expect([usdShort(110477824.59), usdShort(-160895789.99), usdShort(1.2e9), usdShort(950_000)]).toEqual(['$110.5M', '−$160.9M', '$1.2B', '$950k']);
  });

  test('one coin: the key header on every call, options for BTC only, failed calls recorded without the key; null without a key', async () => {
    const key = 'cdk_live_SECRET', seen: string[] = [];
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.['X-API-Key']).toBe(key);
      seen.push(url);
      const body = url.includes('/quant/gex') ? GEX : url.includes('/liquidations') ? LIQ : url.includes('long-short') ? LS : url.includes('/quant/coins/') ? REG : url.includes('/options') ? OPT : null;
      return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 500, json: async () => null };
    };
    const btc = await cdaCoin('BTCUSDT', key, fake, 123);
    expect(btc).toMatchObject({ at: 123, mark: 81448.5, maxPain: 79000, lsRatio: 1.7255, liq24h: { long: 21191600.96 }, errors: [] });
    expect(seen.some((u) => u.includes('/options'))).toBe(true);
    seen.length = 0;
    const failing = async (url: string) => { seen.push(url); if (url.includes('/quant/gex')) throw new Error(`boom ${key}`); return { ok: false, status: 403, json: async () => null }; };
    const eth = await cdaCoin('ETHUSDT', key, failing);
    expect(seen.some((u) => u.includes('/options'))).toBe(false);
    expect(eth!.mmLevels).toEqual([]);
    expect(eth!.errors.join(' ')).not.toContain('SECRET');
    expect(eth!.errors).toContain('/api/v1/market-intelligence/liquidations: HTTP 403');
    expect(await cdaCoin('BTCUSDT', null, fake)).toBeNull();
  });
});
