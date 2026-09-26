import { describe, expect, test } from 'vitest';
import { cleanParams, signature, signedHeaders, sortedQueryString } from '../src/index';

// Expected signatures were computed with Bitunix's own SDK code
// (Demo/Python/open_api_http_sign.py generate_signature, and the same
// values from Demo/Node/openApiHttpSign.js), not with our implementation.
const creds = { apiKey: 'test-api-key', secretKey: 'test-secret-key' };
const nonce = '0123456789abcdef0123456789abcdef';
const timestamp = '1790000000000';

describe('signing', () => {
  test('GET: query sorted by key, key+value joined with nothing', () => {
    const q = sortedQueryString({ symbol: 'BTCUSDT', marginCoin: 'USDT' });
    expect(q).toBe('marginCoinUSDTsymbolBTCUSDT');
    expect(signature(creds, nonce, timestamp, q, '')).toBe('361713cbdf23d97adf5aa95db7316aa785623d6f6eae910992ab3fc349cb05c4');
  });

  test('POST: the exact JSON body text', () => {
    const body = JSON.stringify({
      symbol: 'BTCUSDT', side: 'BUY', orderType: 'LIMIT', qty: '0.001', price: '25000', tradeSide: 'OPEN', effect: 'GTC', reduceOnly: false,
    });
    expect(body).toBe('{"symbol":"BTCUSDT","side":"BUY","orderType":"LIMIT","qty":"0.001","price":"25000","tradeSide":"OPEN","effect":"GTC","reduceOnly":false}');
    expect(signature(creds, nonce, timestamp, '', body)).toBe('c140f5df1d7558be1736e01b3366307acae02f1da6191c7e84979331cfd038a7');
  });

  test('headers carry the key, nonce, timestamp and signature; the secret never appears', () => {
    const h = signedHeaders(creds, { params: { symbol: 'BTCUSDT', marginCoin: 'USDT' } }, { nonce, timestamp: Number(timestamp) });
    expect(h).toEqual({ 'api-key': 'test-api-key', nonce, timestamp, sign: '361713cbdf23d97adf5aa95db7316aa785623d6f6eae910992ab3fc349cb05c4' });
    expect(JSON.stringify(h)).not.toContain('test-secret-key');
    const fresh = signedHeaders(creds, {});
    expect(fresh.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.nonce).not.toBe(signedHeaders(creds, {}).nonce);
  });

  test('empty and undefined parameters are neither sent nor signed', () => {
    expect(cleanParams({ symbol: 'BTCUSDT', positionId: undefined, clientId: '', limit: 10, flag: false }))
      .toEqual({ symbol: 'BTCUSDT', limit: '10', flag: 'false' });
  });
});
