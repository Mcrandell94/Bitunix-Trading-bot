import { describe, expect, test } from 'vitest';
import { silentLogger } from '../src/index';
import { COMMUNITY_TRADERS, GROK, grokClient, jsonIn, replyText, traderLabel, traderLine } from '../src/grok';

const T = Date.UTC(2026, 9, 13, 4, 0), H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

/** A fake xAI Responses API: answers with `json` (as text in a message) and `cites` url_citation annotations. */
function fakeXai(json: unknown, cites = 2, status = 200) {
  const calls: { url: string; auth: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
    if (status !== 200) return new Response('bad request for key xai-secret', { status });
    return new Response(JSON.stringify({
      id: 'resp_1', object: 'response',
      output: [
        { type: 'x_search_call', status: 'completed' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '```json\n' + JSON.stringify(json) + '\n```', annotations: Array.from({ length: cites }, (_, k) => ({ type: 'url_citation', url: `https://x.com/a/status/${k}` })) }] },
      ],
      usage: { input_tokens: 900, output_tokens: 200 }, server_side_tool_usage: { x_search_calls: 1, web_search_calls: 1 },
    }));
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const ETH = [{ coin: 'ETHUSDT', price: 2450 }];
const levels = { coins: [{ coin: 'ETH', bias: 'short', levels: [{ price: 2550, kind: 'resistance' }], posted: iso(T - 5 * H) }] };

describe('Grok (xAI): the community traders only', () => {
  test('off without a key; one job only (trader); a 2-minute time limit; traders #1 and #2', () => {
    expect(grokClient(null, silentLogger)).toBeNull();
    expect(grokClient('', silentLogger)).toBeNull();
    expect(Object.keys(grokClient('k', silentLogger)!)).toEqual(['trader']);
    expect(GROK.timeoutMs).toBe(120_000);
    expect(COMMUNITY_TRADERS).toEqual(['mrcrypt0krabs', 'CryptoNavi399']);
    expect([traderLabel(0), traderLabel(1)]).toEqual(['Community trader #1', 'Community trader #2']);
  });

  test('followed trader: X search on his posts only (3 days), his stated levels checked; labelled, never named', async () => {
    const x = fakeXai({ coins: [
      { coin: 'ETH', bias: 'short', levels: [{ price: 2550, kind: 'resistance' }, { price: 2400, kind: 'support' }, { price: 2550, kind: 'resistance' }, { price: 9000, kind: 'target' }, { price: 'n/a', kind: 'stop' }, { price: 2300, kind: 'weird' }], posted: iso(T - 5 * H) },
      { coin: 'BTC', bias: 'long', levels: [{ price: 80000, kind: 'support' }], posted: iso(T - 5 * 24 * H) },
      { coin: 'SOL', bias: 'long', levels: [{ price: 150, kind: 'support' }], posted: iso(T - H) },
    ] });
    const g = grokClient('xai-secret', silentLogger, { fetchFn: x.fetchFn })!;
    const r = (await g.trader('@mrcrypt0krabs', [{ coin: 'ETHUSDT', price: 2450 }, { coin: 'BTCUSDT', price: 81800 }], T))!;
    const c = x.calls[0]!;
    expect(c.url).toBe('https://api.x.ai/v1/responses');
    expect(c.auth).toBe('Bearer xai-secret');
    expect(c.body.model).toBe(GROK.model);
    expect(c.body.tools).toEqual([{ type: 'x_search', allowed_x_handles: ['mrcrypt0krabs'], from_date: '2026-10-10', to_date: '2026-10-14' }]);
    expect(JSON.stringify(c.body.input)).toContain('Search only the X posts of @mrcrypt0krabs');
    // ETH: duplicates, a price far off (9,000) and a non-number dropped, an unknown kind kept as a level; BTC: post too
    // old; SOL: not asked for.
    expect(r).toEqual([{ coin: 'ETHUSDT', bias: 'short', levels: [{ price: 2550, kind: 'resistance' }, { price: 2400, kind: 'support' }, { price: 2300, kind: 'level' }], posted: T - 5 * H }]);
    const line = traderLine(traderLabel(0), r[0]!);
    expect(line).toBe('Community trader #1: bias short · R 2,550.0 · L 2,300.0 · S 2,400.0 (posted 10-12 23:00 UTC)');
    expect(line).not.toMatch(/krabs/i);
    expect(await g.trader('a', [], T)).toBeNull(); // no coins: no call
    expect(x.calls).toHaveLength(1);
  });

  test('nothing without sources, on bad JSON or a failed call (the key never reaches the logs); the daily cap', async () => {
    expect(await grokClient('k', silentLogger, { fetchFn: fakeXai(levels, 0).fetchFn })!.trader('a', ETH, T)).toBeNull();
    expect(await grokClient('k', silentLogger, { fetchFn: fakeXai('not json').fetchFn })!.trader('a', ETH, T)).toBeNull();
    const warned: unknown[] = [];
    const bad = fakeXai(levels, 2, 400);
    expect(await grokClient('xai-secret', { ...silentLogger, warn: (_m, f) => warned.push(f) }, { fetchFn: bad.fetchFn })!.trader('a', ETH, T)).toBeNull();
    expect(JSON.stringify(warned)).not.toContain('xai-secret');
    const capped = fakeXai(levels), g = grokClient('k', silentLogger, { fetchFn: capped.fetchFn, dailyCap: 1 })!;
    expect(await g.trader('a', ETH, T)).not.toBeNull();
    expect(await g.trader('b', ETH, T)).toBeNull();
    expect(capped.calls).toHaveLength(1);
  });

  test('helpers: reply text and sources, JSON in a fence', () => {
    expect(replyText({ output_text: 'hi', citations: ['a', 'b', 'c'] })).toEqual({ text: 'hi', sources: 3 });
    expect(replyText(null)).toEqual({ text: '', sources: 0 });
    expect(jsonIn('Sure: {"a": 1} done')).toEqual({ a: 1 });
    expect(jsonIn('[1, 2]')).toBeNull();
  });
});
