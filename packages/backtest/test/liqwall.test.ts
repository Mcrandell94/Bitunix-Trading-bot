import { describe, expect, test } from 'vitest';
import { LW, lwProbe, rpcBody } from '../src/screen/liqwall';

describe('LiqWall probe', () => {
  test('JSON-RPC answers from plain JSON or server-sent events', () => {
    expect(rpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(rpcBody('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n')).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    expect(rpcBody('not json')).toBeNull();
  });

  test('pages, then MCP tools/list with the session id; the key only to LiqWall hosts, never printed', async () => {
    const key = 'lw_SECRET123', seen: { url: string; headers: Record<string, string> }[] = [];
    const res = (status: number, text: string, h: Record<string, string> = {}) => ({ ok: status < 400, status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => text });
    const fake = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      seen.push({ url, headers: init?.headers ?? {} });
      if (url === 'https://liqwall.com/') return res(200, '<html><title>LiqWall</title><a href="/docs/api">API</a><a href="/about">x</a> owner@example.com</html>', { 'content-type': 'text/html' });
      if (url === 'https://liqwall.com/llms.txt') return res(200, `LiqWall API: GET /api/v1/walls?symbol=BTCUSDT (key ${key})`, { 'content-type': 'text/plain' });
      if (url === 'https://liqwall.com/mcp' && init?.body?.includes('"initialize"')) return res(200, 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"liqwall"},"instructions":"Walls and liquidations."}}\n\n', { 'mcp-session-id': 'S1', 'content-type': 'text/event-stream' });
      if (url === 'https://liqwall.com/mcp' && init?.body?.includes('tools/list')) {
        expect(init.headers?.['Mcp-Session-Id']).toBe('S1');
        return res(200, JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'orderbook_walls', description: 'Walls of 14 exchanges', inputSchema: { properties: { symbol: { type: 'string' }, side: { type: 'string', enum: ['bid', 'ask'] } }, required: ['symbol'] } }] } }));
      }
      return res(404, 'not found');
    };
    const out = (await lwProbe(key, fake)).join('\n');
    expect(out).toContain(' https://liqwall.com/ → HTTP 200 · "LiqWall"');
    expect(out).toContain('   links: /docs/api');
    expect(out).toContain('LiqWall API: GET /api/v1/walls?symbol=BTCUSDT (key ***)');
    expect(out).toContain(' https://liqwall.com/mcp initialize → HTTP 200 · {"name":"liqwall"}');
    expect(out).toContain('   - orderbook_walls(symbol*:string, side:string [bid|ask]): Walls of 14 exchanges');
    expect(seen.filter((x) => x.url.startsWith('https://mcp.liqwall.com'))).toHaveLength(0); // stops at the first MCP server
    expect(seen.every((x) => /^https:\/\/(api\.|mcp\.)?liqwall\.com/.test(x.url))).toBe(true);
    expect(seen.every((x) => x.headers.Authorization === `Bearer ${key}` && x.headers['X-API-Key'] === key)).toBe(true);
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('owner@example.com');
    expect(LW.hosts.length).toBeGreaterThan(0);
    expect((await lwProbe(undefined, fake)).join('\n')).toContain('no LIQWALL_API_KEY secret');
  });
});
