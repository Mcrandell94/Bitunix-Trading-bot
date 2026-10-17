// A probe of CryptoDataAPI (cryptodataapi.com; owner 2026-10-17: "I've added CRYPTODATAAPI_API_KEY, explore what it
// offers"). Research only: it lists the endpoints from the API's own spec and calls a few of them (funding,
// liquidations, the quant regimes, OI divergence, exchange flows) to show what comes back. The key is read from the
// environment and sent as the X-API-Key header; it is never printed (any echo of it is masked). The bot's worker does
// not use this. The container's proxy blocks the host, so it runs on GitHub Actions (--cda-probe).

export const CDA = {
  base: 'https://cryptodataapi.com',
  header: 'X-API-Key',
  specs: ['/openapi.json', '/api/v1/openapi.json', '/api/openapi.json', '/docs/openapi.json'],
  probes: [
    '/api/v1/derivatives/funding-rates?symbol=BTC',
    '/api/v1/market-intelligence/liquidations?symbol=BTC',
    '/api/v1/market-intelligence/liquidations?symbol=ETH',
    '/api/v1/quant/market',
    '/api/v1/quant/coins/BTC?horizon=24h',
    '/api/v1/quant/coins/ETH?horizon=24h',
    '/api/v1/liquidity/oi-divergence',
    '/api/v1/on-chain/exchange-flows/spike-alerts',
  ],
} as const;

type Res = { ok: boolean; status: number; text(): Promise<string> };
type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<Res>;

/** A short description of a JSON value: keys, array lengths and the first element's keys, two levels deep. */
export function shape(v: unknown, depth = 0): string {
  if (Array.isArray(v)) return `[${v.length}${v.length && depth < 2 ? ` × ${shape(v[0], depth + 1)}` : ''}]`;
  if (v && typeof v === 'object') {
    const ks = Object.keys(v as object);
    return `{${ks.slice(0, 14).map((k) => (depth < 2 && (v as Record<string, unknown>)[k] && typeof (v as Record<string, unknown>)[k] === 'object' ? `${k}: ${shape((v as Record<string, unknown>)[k], depth + 1)}` : k)).join(', ')}${ks.length > 14 ? `, … ${ks.length - 14} more` : ''}}`;
  }
  return typeof v;
}

/** The spec's paths grouped by their section (/api/v1/<section>/...). */
export function groupPaths(paths: ReadonlyArray<string>): string[] {
  const g = new Map<string, string[]>();
  for (const p of paths) {
    const m = /^\/api\/v\d+\/([^/]+)(.*)$/.exec(p), sec = m ? m[1]! : '(other)', rest = m ? m[2] || '/' : p;
    g.set(sec, [...(g.get(sec) ?? []), rest]);
  }
  return [...g].sort((a, b) => a[0].localeCompare(b[0])).map(([s, xs]) => ` ${s} (${xs.length}): ${xs.join(', ')}`);
}

export async function cdaProbe(key: string | undefined, fetchFn: FetchFn = fetch as unknown as FetchFn): Promise<string[]> {
  const mask = (s: string) => (key ? s.split(key).join('***') : s), headers: Record<string, string> = key ? { [CDA.header]: key } : {};
  const out = [`===== CRYPTODATAAPI PROBE (${key ? 'with the CRYPTODATAAPI_API_KEY secret' : 'no CRYPTODATAAPI_API_KEY secret for this workflow: calls without a key'}) =====`];
  const get = async (path: string) => {
    try {
      const r = await fetchFn(`${CDA.base}${path}`, { headers }), t = await r.text();
      let j: unknown = null;
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      return { status: r.status, text: t, json: j };
    } catch (e) { return { status: 0, text: (e as Error).message, json: null }; }
  };
  let listed = false;
  for (const s of CDA.specs) {
    const r = await get(s), paths = r.json && typeof r.json === 'object' ? Object.keys(((r.json as { paths?: object }).paths ?? {})) : [];
    if (paths.length) { out.push(`Spec ${s}: ${paths.length} paths`, ...groupPaths(paths).map(mask)); listed = true; break; }
    out.push(`Spec ${s}: HTTP ${r.status}${r.status === 0 ? ` (${mask(r.text).slice(0, 120)})` : ''}`);
  }
  if (!listed) out.push(' (no OpenAPI spec found at those paths)');
  out.push('', 'Calls:');
  for (const p of CDA.probes) {
    const r = await get(p);
    out.push(` ${p} → HTTP ${r.status}${r.json != null ? ` · ${mask(shape(r.json))}` : ''}`, `   ${mask(r.text.replace(/\s+/g, ' ')).slice(0, 400)}`);
  }
  return out;
}
