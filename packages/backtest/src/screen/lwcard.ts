// LiqWall (liqwall.com, its MCP server; owner 2026-10-17: "I added LIQWALL_API_KEY. See what you can do with it") for
// the ETH / BTC cards: per coin, its `levels` tool (the order-book walls of 14 exchanges below and above the price, with
// size, venues and how long they have stood; the liquidation clusters; the day corridor) and its `liquidation_map` tool
// (the largest liquidation levels within 10% across Binance, OKX, Bybit, Hyperliquid and Gate). Live data as of the
// call, display only. The walls and the liquidation levels join the card's liquidity family (two scripts: walls,
// liquidations); a line in the positioning block shows the nearest strong ones and the day corridor.
// The key is sent as `Authorization: Bearer` and `X-API-Key` (what --lw-probe used) and never logged. Every request has
// a timeout; a failed tool leaves its part out.

import { rpcBody } from './liqwall';

export const LW_CARD = { mcp: 'https://liqwall.com/mcp', timeoutMs: 20_000, protocol: '2025-06-18' } as const;

export interface LwWall { price: number; usd: number; side: 'bid' | 'ask'; venues: string[]; standingMin: number; strong: boolean }
/** A liquidation level: a cluster (`levels`, one price) or a map level (`liquidation_map`, a price step). */
export interface LwLiq { lo: number; hi: number; usd: number; side: 'long' | 'short'; strong: boolean; from: 'cluster' | 'map' }
export interface LwCoin {
  /** When it was fetched (ms). */
  at: number;
  price: number | null;
  walls: LwWall[];
  liq: LwLiq[];
  /** LiqWall's expected range for the day. */
  corridor: { lower: number; upper: number } | null;
  /** What LiqWall said it could not give (its `missing` field). */
  missing: string[];
  /** Which calls failed (no key or response text). */
  errors: string[];
}

type J = Record<string, unknown>;
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** A LiqWall table ({columns, rows}) as objects. */
const table = (t: unknown): J[] => {
  const cols = (t as { columns?: unknown })?.columns, rows = (t as { rows?: unknown })?.rows;
  return Array.isArray(cols) && Array.isArray(rows) ? rows.filter(Array.isArray).map((r) => Object.fromEntries(cols.map((c, i) => [String(c), (r as unknown[])[i]]))) : [];
};

/** The `levels` answer: walls, liquidation clusters, the day corridor and what is missing. */
export function parseLevels(j: unknown): Pick<LwCoin, 'price' | 'walls' | 'liq' | 'corridor' | 'missing'> {
  const d = (j ?? {}) as J;
  const wall = (side: 'bid' | 'ask') => (r: J): LwWall | null => {
    const price = num(r.price), usd = num(r.usd);
    return price == null || usd == null ? null : { price, usd, side, venues: Array.isArray(r.exchanges) ? r.exchanges.map(String) : [], standingMin: num(r.standing_min) ?? 0, strong: r.nearest_strong === true };
  };
  const cluster = (side: 'long' | 'short') => (r: J): LwLiq | null => {
    const price = num(r.price), usd = num(r.usd);
    return price == null || usd == null ? null : { lo: price, hi: price, usd, side, strong: r.nearest_strong === true, from: 'cluster' };
  };
  const c = d.day_corridor as J | undefined, lower = num(c?.lower), upper = num(c?.upper);
  return {
    price: num(d.price),
    walls: [...table(d.bid_walls_below).map(wall('bid')), ...table(d.ask_walls_above).map(wall('ask'))].filter((x): x is LwWall => x != null),
    liq: [...table(d.long_liq_clusters_below).map(cluster('long')), ...table(d.short_liq_clusters_above).map(cluster('short'))].filter((x): x is LwLiq => x != null),
    corridor: lower == null || upper == null ? null : { lower, upper },
    missing: Array.isArray(d.missing) ? d.missing.map(String) : [],
  };
}

/** The `liquidation_map` answer: its largest levels across exchanges (each a price step from its lower edge). */
export function parseLiqMap(j: unknown): LwLiq[] {
  const b = (j as J)?.by_exchange as J | undefined, step = num(b?.level_step) ?? 0;
  return table(b?.largest_levels).flatMap((r) => {
    const price = num(r.price), usd = num(r.usd), side = String(r.side ?? '');
    return price == null || usd == null || !/liquidations/.test(side) ? [] : [{ lo: price, hi: price + step, usd, side: side.startsWith('short') ? 'short' as const : 'long' as const, strong: false, from: 'map' as const }];
  });
}

type Res = { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string> };
type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Res>;

/** One coin's data (BTCUSDT / ETHUSDT) from LiqWall's MCP server; null without a key. */
export async function lwCoin(symbol: string, key: string | null | undefined, fetchFn: FetchFn = fetch as unknown as FetchFn, now = Date.now()): Promise<LwCoin | null> {
  if (!key) return null;
  const coin = symbol.replace(/USDT$/, ''), errors: string[] = [];
  let session: string | null = null, id = 0;
  const post = async (what: string, body: J): Promise<J | null> => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), LW_CARD.timeoutMs);
    try {
      const r = await fetchFn(LW_CARD.mcp, {
        method: 'POST', signal: ac.signal, body: JSON.stringify({ jsonrpc: '2.0', ...body }),
        headers: { Authorization: `Bearer ${key}`, 'X-API-Key': key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      });
      session ??= r.headers?.get('mcp-session-id') ?? null;
      const t = await r.text();
      if (!r.ok) { errors.push(`${what}: HTTP ${r.status}`); return null; }
      return 'id' in body ? rpcBody(t) : {};
    } catch (e) { errors.push(`${what}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message.split(key).join('***')}`); return null; }
    finally { clearTimeout(timer); }
  };
  const tool = async (name: string): Promise<unknown> => {
    const j = await post(name, { id: ++id, method: 'tools/call', params: { name, arguments: { coin } } });
    const res = j?.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined, text = res?.content?.find((x) => x.type === 'text')?.text;
    if (j && !res) { errors.push(`${name}: ${JSON.stringify(j.error ?? 'no result').split(key).join('***').slice(0, 120)}`); return null; }
    if (res?.isError) { errors.push(`${name}: ${(text ?? 'error').split(key).join('***').slice(0, 120)}`); return null; }
    try { return text ? JSON.parse(text) : null; } catch { errors.push(`${name}: not JSON`); return null; }
  };
  const init = await post('initialize', { id: ++id, method: 'initialize', params: { protocolVersion: LW_CARD.protocol, capabilities: {}, clientInfo: { name: 'bitunix-bot-cards', version: '1' } } });
  if (!init?.result) {
    if (init) errors.push('initialize: no result');
    return { at: now, price: null, walls: [], liq: [], corridor: null, missing: [], errors };
  }
  await post('initialized', { method: 'notifications/initialized' });
  const lv = await tool('levels'), map = await tool('liquidation_map');
  const levels = parseLevels(lv);
  return { at: now, ...levels, liq: [...levels.liq, ...parseLiqMap(map)], errors };
}
