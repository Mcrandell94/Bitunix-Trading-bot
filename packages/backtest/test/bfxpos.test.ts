import { describe, expect, test } from 'vitest';
import { bfxLines, bfxPosAt, bfxUrl } from '../src/screen/bfxpos';

describe('Bitfinex BTC longs / shorts', () => {
  test('one call per bar end (the last 1-minute value at or before it); bad answers read null with the error kept', async () => {
    const urls: string[] = [];
    const answers: Record<string, unknown> = {
      [bfxUrl('long', 1000)]: [[990, 61_234.5]],
      [bfxUrl('long', 2000)]: [],
      [bfxUrl('long', 3000)]: [[3500, 1]], // after the end: not this bar's
    };
    const fake = async (u: string) => { urls.push(u); return u.includes('4000') ? { ok: false, status: 429, json: async () => null } : { ok: true, status: 200, json: async () => answers[u] }; };
    const r = await bfxPosAt('long', [1000, 2000, 3000, 4000], fake, 0);
    expect(urls[0]).toBe('https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:tBTCUSD:long/hist?end=1000&limit=1&sort=-1');
    expect(r.values).toEqual([61_234.5, null, null, null]);
    expect(r.errors).toEqual(['long 4000: HTTP 429']);
  });

  test('the preview line: values, change over the bars, the ratio', () => {
    expect(bfxLines([{ tf: '4H', at: '10-17 00:00', longs: 60_000, longsAgo: 50_000, shorts: 1_500, shortsAgo: 2_000 }], 6)).toEqual([
      ' 4H (close 10-17 00:00): longs 60,000 BTC (6 bars: +20.0%) · shorts 1,500 BTC (6 bars: −25.0%) · longs / shorts 40.0',
    ]);
  });
});
