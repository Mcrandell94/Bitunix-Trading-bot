import { describe, expect, test } from 'vitest';
import { silentLogger } from '../src/index';
import { breakingKey, clean, contextNote, GROK, grokClient, jsonIn, replyText } from '../src/grok';

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

const ctx = {
  lean: 'bearish',
  chatter: 'ETF outflows <b>and</b> L2 fee debate dominate; see https://t.co/abc\nfor more',
  events: [{ when: '2026-10-15 12:30 UTC', what: 'US CPI' }, { when: '2026-10-16', what: 'Token unlock' }, { when: 'x', what: 'y' }, { when: 'z', what: 'too many' }],
  breaking: [
    { headline: 'Exchange X halts ETH withdrawals', published: iso(T - H), url: 'https://news.example.com/halt' },
    { headline: 'Old story', published: iso(T - 10 * H), url: 'https://news.example.com/old' },
  ],
};

describe('Grok (xAI)', () => {
  test('off without a key; the request: Responses API, X search for the day before to the day after, web search', async () => {
    expect(grokClient(null, silentLogger)).toBeNull();
    expect(grokClient('', silentLogger)).toBeNull();
    const x = fakeXai(ctx), g = grokClient('xai-secret', silentLogger, { fetchFn: x.fetchFn })!;
    await g.context('ETHUSDT', T);
    const c = x.calls[0]!;
    expect(c.url).toBe('https://api.x.ai/v1/responses');
    expect(c.auth).toBe('Bearer xai-secret');
    expect(c.body.model).toBe(GROK.model);
    expect(c.body.tools).toEqual([{ type: 'x_search', from_date: '2026-10-12', to_date: '2026-10-14' }, { type: 'web_search' }]);
    expect(JSON.stringify(c.body.input)).toContain('Ethereum (ETH)');
    expect(grokClient('k', silentLogger, { fetchFn: x.fetchFn, model: 'grok-other' })).not.toBeNull();
  });

  test('context: cleaned (no tags, links or line breaks), at most 3 events, only recent breaking news', async () => {
    const g = grokClient('xai-secret', silentLogger, { fetchFn: fakeXai(ctx).fetchFn })!;
    const c = (await g.context('ETHUSDT', T))!;
    expect(c.lean).toBe('bearish');
    expect(c.chatter).toBe('ETF outflows and L2 fee debate dominate; see for more');
    expect(c.events).toHaveLength(3);
    expect(c.breaking.map((b) => b.headline)).toEqual(['Exchange X halts ETH withdrawals']);
    expect(c.sources).toBe(2);
    expect(contextNote(c)).toEqual({ title: 'X / news (Grok · unverified · not advice)', lines: ['X lean bearish: ETF outflows and L2 fee debate dominate; see for more', 'Events: 2026-10-15 12:30 UTC US CPI · 2026-10-16 Token unlock · x y', 'Breaking: Exchange X halts ETH withdrawals'] });
  });

  test('nothing without sources, on bad JSON or a failed call (the key never reaches the logs); the daily cap', async () => {
    expect(await grokClient('k', silentLogger, { fetchFn: fakeXai(ctx, 0).fetchFn })!.context('ETHUSDT', T)).toBeNull();
    expect(await grokClient('k', silentLogger, { fetchFn: fakeXai('not json').fetchFn })!.context('ETHUSDT', T)).toBeNull();
    const warned: unknown[] = [];
    const bad = fakeXai(ctx, 2, 400);
    expect(await grokClient('xai-secret', { ...silentLogger, warn: (_m, f) => warned.push(f) }, { fetchFn: bad.fetchFn })!.context('ETHUSDT', T)).toBeNull();
    expect(JSON.stringify(warned)).not.toContain('xai-secret');
    const capped = fakeXai(ctx), g = grokClient('k', silentLogger, { fetchFn: capped.fetchFn, dailyCap: 1 })!;
    expect(await g.context('ETHUSDT', T)).not.toBeNull();
    expect(await g.context('BTCUSDT', T)).toBeNull();
    expect(capped.calls).toHaveLength(1);
  });

  test('why: one sentence, one call a coin per 4 hours, none without sources', async () => {
    const x = fakeXai({ note: 'X posts point to a <i>Binance</i> listing announcement.' }), g = grokClient('k', silentLogger, { fetchFn: x.fetchFn })!;
    expect(await g.why('BEAMXUSDT', 'long', T)).toBe('X posts point to a Binance listing announcement.');
    expect(await g.why('BEAMXUSDT', 'long', T + 3 * H)).toBe('X posts point to a Binance listing announcement.');
    expect(x.calls).toHaveLength(1);
    expect(JSON.stringify(x.calls[0]!.body.input)).toContain('BEAMX (perpetual BEAMXUSDT) just gave a long signal');
    await g.why('BEAMXUSDT', 'long', T + 5 * H);
    expect(x.calls).toHaveLength(2);
    expect(await grokClient('k', silentLogger, { fetchFn: fakeXai({ note: 'x' }, 0).fetchFn })!.why('AUSDT', 'short', T)).toBeNull();
  });

  test('helpers: reply text and sources, JSON in a fence, cleaning, one key per story', () => {
    expect(replyText({ output_text: 'hi', citations: ['a', 'b', 'c'] })).toEqual({ text: 'hi', sources: 3 });
    expect(replyText(null)).toEqual({ text: '', sources: 0 });
    expect(jsonIn('Sure: {"a": 1} done')).toEqual({ a: 1 });
    expect(jsonIn('[1, 2]')).toBeNull();
    expect(clean('a'.repeat(300), 10)).toBe('aaaaaaaaa…');
    expect(clean(42, 10)).toBe('');
    expect(breakingKey('ETHUSDT', { headline: 'X', url: 'https://n.example/a' })).toBe('ETHUSDT|grok|https://n.example/a');
    expect(breakingKey('ETHUSDT', { headline: 'Exchange X halts ETH withdrawals!', url: null })).toBe('ETHUSDT|grok|exchange x halts eth withdrawals');
  });
});
