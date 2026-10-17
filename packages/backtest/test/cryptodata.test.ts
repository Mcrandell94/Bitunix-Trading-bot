import { describe, expect, test } from 'vitest';
import { cdaProbe, CDA, groupPaths, shape } from '../src/screen/cryptodata';

describe('CryptoDataAPI probe', () => {
  test('shape and path grouping', () => {
    expect(shape({ data: [{ a: 1, b: 2 }], ok: true })).toBe('{data: [1 × {a, b}], ok}');
    expect(groupPaths(['/api/v1/derivatives/funding-rates', '/api/v1/derivatives/open-interest', '/api/v1/quant/market', '/health'])).toEqual([
      ' (other) (1): /health', ' derivatives (2): /funding-rates, /open-interest', ' quant (1): /market',
    ]);
  });

  test('lists the spec, calls each probe with the key header, never prints the key', async () => {
    const seen: { url: string; key?: string }[] = [];
    const key = 'cdk_live_SECRET123';
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, key: init?.headers?.['X-API-Key'] });
      const body = url.endsWith('/openapi.json') && url.includes('/api/v1/') ? JSON.stringify({ paths: { '/api/v1/quant/market': {}, '/api/v1/derivatives/funding-rates': {} } })
        : url.endsWith('/openapi.json') ? 'not found' : JSON.stringify({ data: [{ symbol: 'BTC', rate: 0.0001 }], echo: key });
      return { ok: true, status: url.endsWith('/openapi.json') && !url.includes('/api/v1/') ? 404 : 200, text: async () => body };
    };
    const out = (await cdaProbe(key, fake)).join('\n');
    expect(out).toContain('Spec /api/v1/openapi.json: 2 paths');
    expect(out).toContain(' derivatives (1): /funding-rates');
    for (const p of CDA.probes) expect(out).toContain(`${p.includes('{coin}') ? p.split('?')[0]!.replace('{coin}', 'BTC') : p} → HTTP 200`); // a {coin} path takes the query's coin
    expect(out).not.toContain('SECRET123');
    expect(seen.every((x) => x.key === key)).toBe(true);
    const keyless = (await cdaProbe(undefined, fake)).join('\n');
    expect(keyless).toContain('no CRYPTODATAAPI_API_KEY secret');
  });
});
