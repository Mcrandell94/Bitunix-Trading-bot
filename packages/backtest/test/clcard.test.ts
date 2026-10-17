import { describe, expect, test } from 'vitest';
import { CL_CARD, clCoin, parseContext, parseFlow4h } from '../src/screen/clcard';

const H = 3_600_000, T = Date.UTC(2026, 9, 17, 16); // a 4H close
// Trimmed from the live responses (2026-10-17, Pro key).
const CTX = { success: true, data: { as_of_ms: 1792254963830, valid_days: 92, breadth: { elevated: 18, total: 47 }, coin: 'ETH', stats: {
  usd_24h: 64914153, net_24h: -5067981, avg_day_usd: 164919350, multiple_vs_avg: 0.39, highest_in_days: 0, record: false, days_logged: 92, buy_share_24h: 0.461, buy_share_7d: 0.357, buy_share_30d: 0.47 } } };
const FLOW = { success: true, data: { coin: 'ETH', hours: 8, rows: [
  { t: T - 5 * H, buyUsd: 9e6, sellUsd: 1e6 }, // before the bar
  { t: T - 4 * H, buyUsd: 4990316, sellUsd: 8625114.9 }, { t: T - 3 * H, buyUsd: 3198196, sellUsd: 0 }, { t: T - H, buyUsd: 2e6, sellUsd: 5e5 },
  { t: T, buyUsd: 7e6, sellUsd: 0 }, // the next bar, still forming
] } };

describe('CoinLobster for the cards', () => {
  test('parsers: whale context vs its own history and breadth; the net flow of the 4H bar only', () => {
    expect(parseContext(CTX)).toEqual({
      whales: { usd24h: 64914153, net24h: -5067981, multiple: 0.39, buyShare24h: 0.461, buyShare7d: 0.357, highestInDays: 0, record: false },
      breadth: { elevated: 18, total: 47 },
    });
    // A coin excluded by design (stats null) or a failed call: nothing.
    expect(parseContext({ data: { stats: null, excluded: true } })).toEqual({ whales: null, breadth: null });
    expect(parseFlow4h(FLOW, T)).toBeCloseTo(4990316 - 8625114.9 + 3198196 + 2e6 - 5e5, 4);
    expect(parseFlow4h(FLOW, T - 8 * H)).toBeNull();
  });

  test('one coin: the Bearer key on both calls, failures recorded without the key; null without a key', async () => {
    const key = 'cl_SECRET', seen: string[] = [];
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.Authorization).toBe(`Bearer ${key}`);
      seen.push(url);
      return { ok: true, status: 200, json: async () => (url.includes('/whales/context') ? CTX : FLOW) };
    };
    const eth = await clCoin('ETHUSDT', key, T, fake, 123);
    expect(seen).toEqual([`${CL_CARD.base}/whales/context?coin=ETH`, `${CL_CARD.base}/whales/flow/ETH?hours=${CL_CARD.flowHours}`]);
    expect(eth).toMatchObject({ at: 123, whales: { net24h: -5067981 }, breadth: { elevated: 18 }, errors: [] });
    expect(eth!.net4h).toBeCloseTo(parseFlow4h(FLOW, T)!, 6);
    const failing = async (url: string) => { if (url.includes('/whales/flow')) throw new Error(`boom ${key}`); return { ok: false, status: 404, json: async () => null }; };
    const btc = await clCoin('BTCUSDT', key, T, failing);
    expect(btc).toMatchObject({ whales: null, breadth: null, net4h: null });
    expect(btc!.errors).toContain('/whales/context: HTTP 404');
    expect(btc!.errors.join(' ')).not.toContain('SECRET');
    expect(await clCoin('BTCUSDT', null, T, fake)).toBeNull();
  });
});
