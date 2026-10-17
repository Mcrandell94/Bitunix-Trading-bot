// A probe of CoinLobster's REST API (coinlobster.com; owner 2026-10-17: "i also added another api, see if it can be
// reached", COINLOBSTER_API_KEY). Research only: it looks for the API's spec and calls a few endpoints (the plan check,
// which is free, then the projected liquidation levels, the liquidation heat, ETH options and the ETH order book) to show
// what comes back. Metered: a successful data call spends credits from the plan's balance (shared with the website and
// the MCP connector); failed and no-data calls are free, so a wrong path costs nothing. Each endpoint lists alternative
// paths, tried in order until one is not a 404.
// The key is sent as `Authorization: Bearer <key>` (what the live API's 401 asks for) and never printed: it, any email
// and any key-like field are masked (the repo's Actions logs are public). The container's proxy blocks the host, so it
// runs on GitHub Actions (--cl-probe).

import { groupPaths, shape } from './cryptodata';

export const CL = {
  base: 'https://coinlobster.com',
  specs: ['/api/ai/v1/openapi.json', '/api/ai/openapi.json', '/openapi.json', '/api/openapi.json', '/api/ai/v1'],
  probes: [
    ['/api/ai/v1/my_access'],
    ['/api/ai/v1/liq_zones?coin=ETH', '/api/ai/v1/liquidations?coin=ETH&scope=projected'],
    ['/api/ai/v1/liq_zones?coin=BTC', '/api/ai/v1/liquidations?coin=BTC&scope=projected'],
    ['/api/ai/v1/liq_heat?coin=ETH', '/api/ai/v1/liquidations?coin=ETH&scope=heat'],
    ['/api/ai/v1/options?coin=ETH'],
    ['/api/ai/v1/orderbook?coin=ETH'],
  ],
} as const;

type Res = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<Res>;

export async function clProbe(key: string | undefined, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<string[]> {
  const mask = (s: string) => (key ? s.split(key).join('***') : s)
    .replace(/("(?:api_?key|key_?(?:prefix|hint|id)?|token|secret|email|user(?:name|_id)?|account(?:_id)?|owner)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/Bearer\s+\S+/g, 'Bearer ***').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  const headers: Record<string, string> = { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  const out = [`===== COINLOBSTER PROBE (${key ? 'with the COINLOBSTER_API_KEY secret' : 'no COINLOBSTER_API_KEY secret for this workflow: calls without a key'}) =====`];
  const get = async (path: string) => {
    try {
      const r = await fetchFn(`${CL.base}${path}`, { headers }), t = await r.text();
      let j: unknown = null;
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      return { status: r.status, text: t, json: j };
    } catch (e) { return { status: 0, text: (e as Error).message, json: null }; }
  };
  let listed = false;
  for (const s of CL.specs) {
    const r = await get(s), paths = r.json && typeof r.json === 'object' ? Object.keys(((r.json as { paths?: object }).paths ?? {})) : [];
    if (paths.length) { out.push(`Spec ${s}: ${paths.length} paths`, ...groupPaths(paths).map(mask)); listed = true; break; }
    out.push(`Spec ${s}: HTTP ${r.status}${r.json != null ? ` · ${mask(shape(r.json))}` : ''}${r.status === 0 || r.status === 200 ? ` (${mask(r.text.replace(/\s+/g, ' ')).slice(0, 300)})` : ''}`);
  }
  if (!listed) out.push(' (no OpenAPI spec found at those paths)');
  out.push('', 'Calls:');
  for (const alts of CL.probes) {
    for (const p of alts) {
      const r = await get(p);
      out.push(` ${p} → HTTP ${r.status}${r.json != null ? ` · ${mask(shape(r.json))}` : ''}`, `   ${mask(r.text.replace(/\s+/g, ' ')).slice(0, 2500)}`);
      if (r.status !== 404) break; // a wrong path is free; the first one that answers ends the list
    }
  }
  return out;
}
