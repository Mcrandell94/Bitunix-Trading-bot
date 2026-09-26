import { describe, expect, test } from 'vitest';
import { BitunixError, buildUrl, createClient } from '../src/index';

type Reply = { status?: number; body?: unknown; throws?: Error };

function fakeFetch(replies: Reply[]) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const r = replies.shift() ?? { body: { code: 0, msg: 'ok', data: 'default' } };
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Virtual clock: sleep advances time instantly and records each wait.
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits };
}

const ok = (data: unknown) => ({ body: { code: 0, msg: 'Success', data } });

describe('createClient', () => {
  test('builds the URL from base, path and params, and unwraps data', async () => {
    const f = fakeFetch([ok([1, 2])]);
    const c = clock();
    const client = createClient({ fetch: f.fn, ...c });
    expect(await client.get('/api/v1/futures/market/kline', { symbol: 'BTCUSDT', limit: 5, startTime: undefined })).toEqual([1, 2]);
    expect(f.calls).toEqual(['https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=BTCUSDT&limit=5']);
    expect(buildUrl('https://x.test', '/a', { b: 1 })).toBe('https://x.test/a?b=1');
  });

  test('a non-zero code is an error, retried only for "too frequently" (10006)', async () => {
    const c = clock();
    const f1 = fakeFetch([{ body: { code: 10002, msg: 'Parameter error', data: null } }]);
    const err = await createClient({ fetch: f1.fn, ...c }).get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(BitunixError);
    expect(err).toMatchObject({ code: 10002, retryable: false });
    expect(f1.calls).toHaveLength(1);

    const f2 = fakeFetch([{ body: { code: 10006, msg: 'Request too frequently', data: null } }, ok('fine')]);
    expect(await createClient({ fetch: f2.fn, ...c }).get('/x')).toBe('fine');
    expect(f2.calls).toHaveLength(2);
  });

  test('retries 429, 5xx and network errors with doubling backoff; not 4xx', async () => {
    const c = clock();
    const f = fakeFetch([{ status: 429 }, { status: 503 }, { throws: new Error('ECONNRESET') }, ok('done')]);
    const client = createClient({ fetch: f.fn, ...c, backoffMs: 100, minRequestGapMs: 0 });
    expect(await client.get('/x')).toBe('done');
    expect(c.waits).toEqual([100, 200, 400]);

    const bad = fakeFetch([{ status: 404 }]);
    await expect(createClient({ fetch: bad.fn, ...c }).get('/x')).rejects.toMatchObject({ httpStatus: 404, retryable: false });
    expect(bad.calls).toHaveLength(1);
  });

  test('gives up after maxRetries', async () => {
    const c = clock();
    const f = fakeFetch(Array(10).fill({ status: 500 }));
    await expect(createClient({ fetch: f.fn, ...c, maxRetries: 2 }).get('/x')).rejects.toMatchObject({ httpStatus: 500 });
    expect(f.calls).toHaveLength(3);
  });

  test('rejects bodies that are not the { code, msg, data } envelope', async () => {
    const c = clock();
    await expect(createClient({ fetch: fakeFetch([{ body: 'not json' }]).fn, ...c }).get('/x')).rejects.toThrow(/not JSON/);
    await expect(createClient({ fetch: fakeFetch([{ body: { data: [] } }]).fn, ...c }).get('/x')).rejects.toThrow(/no numeric code/);
  });

  test('spaces request starts by minRequestGapMs, even for concurrent callers', async () => {
    const c = clock();
    const starts: number[] = [];
    const fetchAt = (async () => { starts.push(c.now()); return new Response(JSON.stringify({ code: 0, msg: '', data: 1 })); }) as unknown as typeof fetch;
    const client = createClient({ fetch: fetchAt, ...c, minRequestGapMs: 250 });
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
    expect(starts.map((s) => s - starts[0]!)).toEqual([0, 250, 500]);
  });
});
