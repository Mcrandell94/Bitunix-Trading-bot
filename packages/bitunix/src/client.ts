// Public (unauthenticated) REST client. No keys: stage 2 only reads market
// data. Throttles every request and retries rate limits and server errors.

import { BASE_URL, CODE_TOO_FREQUENT, DEFAULT_MIN_REQUEST_GAP_MS, type Envelope } from './api';

export class BitunixError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly httpStatus: number | null,
    readonly retryable: boolean,
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

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function buildUrl(baseUrl: string, path: string, params: Params = {}): string {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

export function createClient(opts: ClientOptions = {}): BitunixClient {
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

  async function attempt<T>(url: string): Promise<T> {
    await throttle();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', language: 'en-US' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BitunixError(`network error: ${(err as Error).message}`, null, null, true);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new BitunixError(`HTTP ${res.status}`, null, res.status, retryable);
    }
    let body: Envelope<T>;
    try {
      body = (await res.json()) as Envelope<T>;
    } catch {
      throw new BitunixError('response is not JSON', null, res.status, false);
    }
    if (typeof body?.code !== 'number') throw new BitunixError('response has no numeric code', null, res.status, false);
    if (body.code !== 0) {
      throw new BitunixError(`Bitunix error ${body.code}: ${body.msg}`, body.code, res.status, body.code === CODE_TOO_FREQUENT);
    }
    return body.data;
  }

  return {
    async get<T>(path: string, params?: Params): Promise<T> {
      const url = buildUrl(baseUrl, path, params);
      for (let i = 0; ; i++) {
        try {
          return await attempt<T>(url);
        } catch (err) {
          if (!(err instanceof BitunixError) || !err.retryable || i >= maxRetries) throw err;
          await sleep(backoffMs * 2 ** i);
        }
      }
    },
  };
}
