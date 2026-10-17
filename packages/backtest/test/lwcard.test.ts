import { describe, expect, test } from 'vitest';
import { LW_CARD, lwCoin, parseLevels, parseLiqMap } from '../src/screen/lwcard';

// Trimmed from the live answers (2026-10-17 20:21 UTC, --lw-probe).
const LEVELS = {
  coin: 'ETH', price: 2417.44,
  bid_walls_below: { columns: ['price', 'usd', 'distance_pct', 'exchanges', 'standing_min', 'nearest_strong'], rows: [[2406.62, 4730000, -0.45, ['hyperliquid', 'coinbase'], 39, false], [2395.9, 9315000, -0.89, ['hyperliquid'], 121, true]] },
  short_liq_clusters_above: { columns: ['price', 'usd', 'distance_pct', 'source', 'nearest_strong'], rows: [[2448.78, 18880000, 1.3, null, true]] },
  ask_walls_above: { columns: ['price', 'usd', 'distance_pct', 'exchanges', 'standing_min', 'nearest_strong'], rows: [[2428.41, 13570000, 0.45, ['binance', 'coinbase'], 17, true]] },
  long_liq_clusters_below: { columns: ['price', 'usd', 'distance_pct', 'source', 'nearest_strong'], rows: [[2391.19, 25330000, -1.09, null, true], [2341.17, 22940000, -3.15, null, false]] },
  day_corridor: { day_open: 2422.49, lower: 2328.266, upper: 2516.714 },
  missing: ['options levels: not available on your plan or through the API'],
};
const MAP = { coin: 'ETH', by_exchange: { level_step: 5, largest_levels: { columns: ['side', 'price', 'usd', 'distance_pct', 'largest_exchange'], rows: [['short liquidations above', 2475, 31300000, 2.4, 'Hyperliquid'], ['long liquidations below', 2300, 97200000, -4.8, 'Hyperliquid']] } } };

describe('LiqWall for the cards', () => {
  test('parsers: walls both sides, liquidation clusters, the day corridor, the map levels as price steps', () => {
    const l = parseLevels(LEVELS);
    expect(l.price).toBe(2417.44);
    expect(l.walls).toEqual([
      { price: 2406.62, usd: 4730000, side: 'bid', venues: ['hyperliquid', 'coinbase'], standingMin: 39, strong: false },
      { price: 2395.9, usd: 9315000, side: 'bid', venues: ['hyperliquid'], standingMin: 121, strong: true },
      { price: 2428.41, usd: 13570000, side: 'ask', venues: ['binance', 'coinbase'], standingMin: 17, strong: true },
    ]);
    expect(l.liq.map((x) => [x.side, x.lo, x.strong])).toEqual([['long', 2391.19, true], ['long', 2341.17, false], ['short', 2448.78, true]]);
    expect(l.corridor).toEqual({ lower: 2328.266, upper: 2516.714 });
    expect(l.missing).toHaveLength(1);
    expect(parseLiqMap(MAP)).toEqual([
      { lo: 2475, hi: 2480, usd: 31300000, side: 'short', strong: false, from: 'map' },
      { lo: 2300, hi: 2305, usd: 97200000, side: 'long', strong: false, from: 'map' },
    ]);
    expect(parseLevels(null)).toEqual({ price: null, walls: [], liq: [], corridor: null, missing: [] });
    expect(parseLiqMap({})).toEqual([]);
  });

  test('one coin over MCP: initialize, the session id on the tool calls, both tools; errors without the key; null without a key', async () => {
    const key = 'lw_SECRET', bodies: { method: string; session?: string; tool?: string }[] = [];
    const res = (status: number, text: string, h: Record<string, string> = {}) => ({ ok: status < 400, status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => text });
    const fake = (fail = false) => async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(url).toBe(LW_CARD.mcp);
      expect(init?.headers?.Authorization).toBe(`Bearer ${key}`);
      const b = JSON.parse(init!.body!) as { id?: number; method: string; params?: { name?: string } };
      bodies.push({ method: b.method, session: init?.headers?.['Mcp-Session-Id'], tool: b.params?.name });
      if (b.method === 'initialize') return res(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { serverInfo: { name: 'liqwall' } } })}\n\n`, { 'mcp-session-id': 'S9' });
      if (b.method === 'notifications/initialized') return res(202, '');
      if (fail && b.params?.name === 'levels') return res(200, JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { isError: true, content: [{ type: 'text', text: `bad key ${key}` }] } }));
      return res(200, JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: JSON.stringify(b.params?.name === 'levels' ? LEVELS : MAP) }] } }));
    };
    const eth = await lwCoin('ETHUSDT', key, fake(), 7);
    expect(bodies.map((b) => [b.method, b.tool ?? null, b.session ?? null])).toEqual([['initialize', null, null], ['notifications/initialized', null, 'S9'], ['tools/call', 'levels', 'S9'], ['tools/call', 'liquidation_map', 'S9']]);
    expect(eth).toMatchObject({ at: 7, price: 2417.44, corridor: { lower: 2328.266 }, errors: [] });
    expect(eth!.walls).toHaveLength(3);
    expect(eth!.liq.filter((x) => x.from === 'map')).toHaveLength(2);
    const bad = await lwCoin('ETHUSDT', key, fake(true));
    expect(bad!.walls).toEqual([]);
    expect(bad!.errors).toEqual(['levels: bad key ***']);
    const down = await lwCoin('BTCUSDT', key, async () => res(401, 'no'));
    expect(down).toMatchObject({ walls: [], liq: [], errors: ['initialize: HTTP 401'] });
    expect(await lwCoin('BTCUSDT', null, fake())).toBeNull();
  });
});
