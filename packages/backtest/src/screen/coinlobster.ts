// A probe of CoinLobster's REST API (coinlobster.com; owner 2026-10-17: "i also added another api, see if it can be
// reached", COINLOBSTER_API_KEY). Research only: it lists the API's public spec (/openapi.json) and calls a few endpoints
// under the spec's server (status, the pair list, then the order book walls for ETH / BTC and the ETH liquidations;
// market paths take `pair`, its spelling tried in turn) to show what comes back. Metered: a successful data call spends credits from the plan's balance (shared
// with the website and the MCP connector); failed and no-data calls are free.
// The key is sent as `Authorization: Bearer <key>` (what the live API's 401 asks for) and never printed: it, any email
// and any key-like field are masked (the repo's Actions logs are public). The container's proxy blocks the host, so it
// runs on GitHub Actions (--cl-probe).

import { shape } from './cryptodata';

export const CL = {
  base: 'https://coinlobster.com',
  spec: '/openapi.json',
  /** The data paths relative to the spec's server (its `servers[0]`); /status and /credits/balance first (no data). */
  probes: ['/status', '/market/pairs', '/market/orderbook?pair={ETH}&depth=50', '/market/orderbook?pair={BTC}&depth=50', '/market/liquidations?pair={ETH}&limit=20'],
  /** Pair spellings tried in order for a {COIN} path until one is not "pair_not_found" (a failed call is free). */
  pairForms: ['{c}USDT', '{c}-USDT', '{c}', '{c}/USD', '{c}-PERP', '{c}USDT-PERP'],
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
  // The spec (public): its server prefix, then every path with its summary and parameters.
  const sp = await get(CL.spec), spec = (sp.json ?? {}) as { servers?: { url?: string }[]; paths?: Record<string, Record<string, { summary?: string; parameters?: { name: string; in: string; required?: boolean }[] }>> };
  const server = spec.servers?.[0]?.url ?? '', prefix = (/^https?:/.test(server) ? new URL(server).pathname : server).replace(/\/$/, '');
  const paths = Object.keys(spec.paths ?? {});
  out.push(`Spec ${CL.spec}: HTTP ${sp.status} · ${paths.length} paths · server ${JSON.stringify(server)}`);
  for (const path of paths) for (const [m, op] of Object.entries(spec.paths![path]!)) {
    if (!op || typeof op !== 'object' || !('summary' in op || 'parameters' in op)) continue;
    out.push(mask(` ${m.toUpperCase()} ${path}: ${(op.summary ?? '').replace(/\s+/g, ' ').slice(0, 140)}${op.parameters?.length ? ` · ${op.parameters.map((x) => `${x.name}${x.required ? '*' : ''}`).join(', ')}` : ''}`));
  }
  out.push('', `Calls (under ${JSON.stringify(prefix || '/')}):`);
  for (const p0 of CL.probes) {
    const coin = /\{([A-Z]+)\}/.exec(p0)?.[1];
    for (const form of coin ? CL.pairForms : ['']) {
      const p = coin ? p0.replace(`{${coin}}`, encodeURIComponent(form.replace('{c}', coin))) : p0, r = await get(`${prefix}${p}`);
      const meta = (r.json as { meta?: unknown } | null)?.meta;
      out.push(` ${prefix}${p} → HTTP ${r.status}${r.json != null ? ` · ${mask(shape(r.json))}` : ''}${meta ? ` · meta ${mask(JSON.stringify(meta))}` : ''}`, `   ${mask(r.text.replace(/\s+/g, ' ')).slice(0, 1500)}`);
      if (!(r.status === 404 && r.text.includes('pair_not_found'))) break;
    }
  }
  return out;
}
