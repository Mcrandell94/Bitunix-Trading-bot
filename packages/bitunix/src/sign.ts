// Request signing for Bitunix private endpoints.
//
// VERIFIED against the official SDK (github.com/BitunixOfficial/open-api):
// Demo/Node/openApiHttpSign.js, Demo/Python/open_api_http_sign.py and
// Demo/Java/.../utils/SignUtils.java all compute
//   digest = sha256_hex(nonce + timestamp + apiKey + queryString + body)
//   sign   = sha256_hex(digest + secretKey)
// where queryString is the query parameters sorted by key and concatenated
// as key + value with no separators, and body is the exact JSON text sent
// (no spaces). Headers: api-key, sign, nonce, timestamp (ms).
// The Java SDK skips empty values; the Node SDK doesn't send them either, so
// we never send or sign empty parameters.

import { createHash, randomBytes } from 'node:crypto';

export interface Credentials {
  apiKey: string;
  secretKey: string;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Defined, non-empty parameters as strings. What gets sent is exactly what gets signed. */
export function cleanParams(params: QueryParams = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') out[k] = String(v);
  return out;
}

/** Keys sorted (byte order, like Java's TreeMap), then key+value pairs joined with nothing. */
export function sortedQueryString(params: Record<string, string>): string {
  return Object.keys(params).sort().map((k) => k + params[k]).join('');
}

export function signature(c: Credentials, nonce: string, timestamp: string, queryString: string, body: string): string {
  return sha256(sha256(nonce + timestamp + c.apiKey + queryString + body) + c.secretKey);
}

export interface SignedHeaders {
  'api-key': string;
  sign: string;
  nonce: string;
  timestamp: string;
}

/** 32 hex characters, like the Node SDK's crypto.randomBytes(16). */
export const newNonce = () => randomBytes(16).toString('hex');

export function signedHeaders(
  c: Credentials,
  req: { params?: Record<string, string>; body?: string },
  opts: { nonce?: string; timestamp?: number } = {},
): SignedHeaders {
  const nonce = opts.nonce ?? newNonce();
  const timestamp = String(opts.timestamp ?? Date.now());
  return {
    'api-key': c.apiKey,
    sign: signature(c, nonce, timestamp, sortedQueryString(req.params ?? {}), req.body ?? ''),
    nonce,
    timestamp,
  };
}
