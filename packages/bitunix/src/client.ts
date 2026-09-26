// REST clients. The public client reads market data with no keys; the
// private client signs requests with the account's keys (see sign.ts).
// Both throttle every request and share the same error handling.
//
// Retries: reads are retried on rate limits, server errors and network
// errors. Writes (POST) are retried ONLY when the exchange refused them for
// rate limiting (10005/10006, HTTP 429): after a network error, timeout or
// 5xx the order may or may not have been placed, so a blind retry could
// place it twice. Those errors are marked `ambiguous` and the caller must
// check the account (e.g. by clientId) before trying again.

import { BASE_URL, CODE_TOO_FREQUENT, CODE_TOO_MANY_REQUESTS, DEFAULT_MIN_REQUEST_GAP_MS, type Envelope } from './api';
import { cleanParams, signedHeaders, type Credentials, type QueryParams } from './sign';

export class BitunixError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    /** True when the request may have taken effect anyway (no clear answer from the exchange). */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'BitunixError';
  }
}

export type Params = Record<string, string | number | undefined>;

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Minimum gap between request starts. */
  minRequestGapMs?: number;
  /** Retries after the first attempt, for retryable failures only. */
  maxRetries?: number;
  /** First backoff; doubles each retry. */
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface BitunixClient {
  get<T = unknown>(path: string, params?: Params): Promise<T>;
}

export interface PrivateClientOptions extends ClientOptions {
  credentials: Credentials;
  /** For tests: fixed nonce instead of a random one. */
  nonce?: () => string;
}

export interface PrivateClient {
  /** Signed GET (account, positions, orders). Retried like public reads. */
  get<T = unknown>(path: string, params?: QueryParams): Promise<T>;
  /** Signed POST with a JSON body. Retried only when refused for rate limiting. */
  post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildUrl(baseUrl: string, path: string, params: Params = {}): string {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Refused for rate limiting: the exchange did not act on it, so it is safe to send again. */
export const isRateLimited = (err: unknown): boolean => err instanceof BitunixError
  && (err.code === CODE_TOO_FREQUENT || err.code === CODE_TOO_MANY_REQUESTS || err.httpStatus === 429);

function core(opts: ClientOptions) {
  const baseUrl = opts.baseUrl ?? BASE_URL;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const gap = opts.minRequestGapMs ?? DEFAULT_MIN_REQUEST_GAP_MS;
  const maxRetries = opts.maxRetries ?? 4;
  const backoffMs = opts.backoffMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  // Serialize request starts so concurrent callers share one throttle.
  let nextSlot = 0;
  let chain: Promise<void> = Promise.resolve();
  const throttle = () => {
    const turn = chain.then(async () => {
      const wait = nextSlot - now();
      if (wait > 0) await sleep(wait);
      nextSlot = now() + gap;
    });
    chain = turn.catch(() => {});
    return turn;
  };

  /** One attempt. `init` is built after the throttle wait so signatures carry a fresh timestamp. */
  async function attempt<T>(url: string, init: () => RequestInit): Promise<T> {
    await throttle();
    let res: Response;
    try {
      res = await doFetch(url, { ...init(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new BitunixError(`network error: ${(err as Error).message}`, null, null, true, true);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new BitunixError(`HTTP ${res.status}`, null, res.status, retryable, res.status >= 500);
    }
    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new BitunixError('response is not JSON', null, res.status, false, true);
    }
    if (typeof body?.code !== 'number') throw new BitunixError('response has no numeric code', null, res.status, false, true);
    if (body.code !== 0) {
      const limited = body.code === CODE_TOO_FREQUENT || body.code === CODE_TOO_MANY_REQUESTS;
      throw new BitunixError(`Bitunix error ${body.code}: ${body.msg}`, body.code, res.status, limited);
    }
    return body.data;
  }

  async function withRetries<T>(run: () => Promise<T>, shouldRetry: (err: unknown) => boolean): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await run();
      } catch (err) {
        if (!shouldRetry(err) || i >= maxRetries) throw err;
        await sleep(backoffMs * 2 ** i);
      }
    }
  }

  const retryableRead = (err: unknown) => err instanceof BitunixError && err.retryable;
  return { baseUrl, now, attempt, withRetries, retryableRead };
}

export function createClient(opts: ClientOptions = {}): BitunixClient {
  const c = core(opts);
  const headers = { Accept: 'application/json', language: 'en-US' };
  return {
    get<T>(path: string, params?: Params): Promise<T> {
      const url = buildUrl(c.baseUrl, path, params);
      return c.withRetries(() => c.attempt<T>(url, () => ({ method: 'GET', headers })), c.retryableRead);
    },
  };
}

export function createPrivateClient(opts: PrivateClientOptions): PrivateClient {
  const { apiKey, secretKey } = opts.credentials;
  if (!apiKey || !secretKey) throw new Error('Bitunix API key and secret are both required');
  const c = core(opts);
  const base = { Accept: 'application/json', language: 'en-US' };
  const sign = (req: { params?: Record<string, string>; body?: string }) =>
    signedHeaders(opts.credentials, req, { nonce: opts.nonce?.(), timestamp: c.now() });
  return {
    get<T>(path: string, params?: QueryParams): Promise<T> {
      const clean = cleanParams(params);
      const url = buildUrl(c.baseUrl, path, clean);
      return c.withRetries(
        () => c.attempt<T>(url, () => ({ method: 'GET', headers: { ...base, ...sign({ params: clean }) } })),
        c.retryableRead,
      );
    },
    post<T>(path: string, body: Record<string, unknown>): Promise<T> {
      // Sign exactly the bytes that are sent.
      const json = JSON.stringify(body);
      const url = buildUrl(c.baseUrl, path);
      return c.withRetries(
        () => c.attempt<T>(url, () => ({
          method: 'POST', body: json, headers: { ...base, 'Content-Type': 'application/json', ...sign({ body: json }) },
        })),
        isRateLimited,
      );
    },
  };
}
