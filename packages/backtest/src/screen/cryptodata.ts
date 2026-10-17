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
    '/api/v1/auth/keys/me',
    '/api/v1/derivatives/funding-rates?coin=BTC',
    '/api/v1/derivatives/open-interest?coin=BTC',
    '/api/v1/derivatives/binance/long-short-ratio?symbol=BTCUSDT',
    '/api/v1/market-intelligence/liquidations?symbol=BTC',
    '/api/v1/market-intelligence/liquidations?symbol=ETH',
    '/api/v1/market-intelligence/liquidations/by-exchange?symbol=BTC',
    '/api/v1/backtesting/liquidation-density?coin=BTC&start={dayAgo}&interval=1h&limit=3',
    '/api/v1/liquidity/depth/{coin}?coin=BTC',
    '/api/v1/market-intelligence/options?symbol=BTC',
    '/api/v1/quant/gex?coin=BTC',
    '/api/v1/quant/gex?coin=ETH',
    '/api/v1/market-intelligence/options?symbol=ETH',
    '/api/v1/quant/positioning/ladder?symbol=BTC',
    '/api/v1/quant/positioning/ladder?symbol=ETH',
    '/api/v1/quant/positioning',
    '/api/v1/quant/market',
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
  // The key, any key prefix and any email address are masked (the repo's Actions logs are public).
  const mask = (s: string) => (key ? s.split(key).join('***') : s).replace(/cdk_live_[A-Za-z0-9]+/g, 'cdk_live_***').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***'), headers: Record<string, string> = key ? { [CDA.header]: key } : {};
  const out = [`===== CRYPTODATAAPI PROBE (${key ? 'with the CRYPTODATAAPI_API_KEY secret' : 'no CRYPTODATAAPI_API_KEY secret for this workflow: calls without a key'}) =====`];
  const get = async (path: string) => {
    try {
      const r = await fetchFn(`${CDA.base}${path}`, { headers }), t = await r.text();
      let j: unknown = null;
      try { j = JSON.parse(t); } catch { /* not JSON */ }
      return { status: r.status, text: t, json: j };
    } catch (e) { return { status: 0, text: (e as Error).message, json: null }; }
  };
  let listed = false, spec: Record<string, { get?: { summary?: string; description?: string; parameters?: { name: string; in: string; required?: boolean; schema?: Record<string, unknown>; description?: string }[] } }> = {};
  for (const s of CDA.specs) {
    const r = await get(s), paths = r.json && typeof r.json === 'object' ? Object.keys(((r.json as { paths?: object }).paths ?? {})) : [];
    if (paths.length) { spec = (r.json as { paths: typeof spec }).paths; out.push(`Spec ${s}: ${paths.length} paths`, ...groupPaths(paths).map(mask)); listed = true; break; }
    out.push(`Spec ${s}: HTTP ${r.status}${r.status === 0 ? ` (${mask(r.text).slice(0, 120)})` : ''}`);
  }
  if (!listed) out.push(' (no OpenAPI spec found at those paths)');
  out.push('', 'Calls:');
  for (const p0 of CDA.probes) {
    const [path, q] = p0.split('?') as [string, string | undefined], doc = spec[path]?.get;
    // A {coin} path parameter takes the query's coin.
    const coin = /(?:^|&)coin=([^&]+)/.exec(q ?? '')?.[1], p1 = path.includes('{coin}') && coin ? path.replace('{coin}', coin) : p0;
    const p = p1.replace('{dayAgo}', new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + 'Z'); // a start time a day back
    const r = await get(p);
    const param = (x: { name: string; required?: boolean; schema?: Record<string, unknown> }) => {
      const sc = x.schema ?? {}, ty = (sc.type ?? (Array.isArray(sc.anyOf) ? (sc.anyOf as { type?: string }[]).map((a) => a.type).filter(Boolean).join('|') : '')) as string;
      return `${x.name}${x.required ? '*' : ''}${ty ? `:${ty}` : ''}${sc.format ? `(${sc.format})` : ''}${sc.default != null ? `=${JSON.stringify(sc.default)}` : ''}${Array.isArray(sc.enum) ? ` [${(sc.enum as unknown[]).join('|')}]` : ''}`;
    };
    const about = doc ? `   spec: ${(doc.summary ?? '').replace(/\s+/g, ' ')}${doc.description ? ` — ${doc.description.replace(/\s+/g, ' ').slice(0, 220)}` : ''}${doc.parameters?.length ? ` · params ${doc.parameters.map(param).join(', ')}` : ''}` : '   spec: (path not in the spec)';
    out.push(` ${p} → HTTP ${r.status}${r.json != null ? ` · ${mask(shape(r.json))}` : ''}`, about);
    const j = r.json as Record<string, unknown> | null;
    if (r.status === 402 && j) {
      // Pay-per-call (x402) or plan: the price and the alternatives it names.
      const alt = j.alternatives as Record<string, unknown> | undefined;
      out.push(`   payment: ${mask(String(j.message ?? ''))} · price ${j.price_usd ?? '?'} USD a call · tier ${JSON.stringify(j.grants_tier ?? null)}`);
      if (alt) for (const [k, v] of Object.entries(alt)) out.push(`   ${k}: ${mask(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 300)}`);
    } else if (path.endsWith('/quant/gex') && j && coin && (j.coins as Record<string, Record<string, unknown>> | undefined)?.[coin]) {
      // The coin's dealer positioning in full but the profile (its shape only): mark, gamma flip, levels, net delta.
      const c = (j.coins as Record<string, Record<string, unknown>>)[coin]!, { gamma_profile: gp, ...rest } = c;
      out.push(`   ${coin}: ${mask(JSON.stringify(rest)).slice(0, 3000)}`, `   ${coin} gamma_profile: ${mask(shape(gp))} · ${mask(JSON.stringify(gp)).slice(0, 1500)}`);
    } else out.push(`   ${mask(r.text.replace(/\s+/g, ' ')).slice(0, 1200)}`);
  }
  return out;
}
